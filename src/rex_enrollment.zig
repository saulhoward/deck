//! Automatic worker transport slots. Rex authenticates remote access to these
//! loopback-only listeners; local callers have the existing trusted-local Deck
//! authority. No Tailscale assertions, task scheduler, transcript or effect retry.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const tcp = @import("remote_io.zig");
const trust = @import("remote_contracts.zig");
const storage = @import("private_store.zig");
const Link = @import("remote_link.zig").Link;
const handoff = @import("handoff_contracts.zig");
const registry_file = @import("rex_registry.zig");
const a = std.heap.page_allocator;
fn registryDirectory(native: Native, path: []const u8) !std.Io.Dir {
    // Registry publication fsyncs this handle. Zig's default Linux directory
    // handle is O_PATH, which can rename files but cannot be synced.
    return std.Io.Dir.cwd().openDir(native.io, path, .{ .iterate = true });
}
pub fn enrollmentPort(hub_port: u16) u16 {
    return if (hub_port == 65535) 65534 else hub_port + 1;
}
const Slot = struct {
    requests: [2]tcp.fd_t,
    results: [2]tcp.fd_t,
    controls: [2]tcp.fd_t,
    client_requests: [2]tcp.fd_t,
    client_replies: [2]tcp.fd_t,
    registration: ?wire.RexWorkerRegistration = null,
    handoff: ?wire.WorkerHandoffState = null,
    link_committed: bool = false,
    link: ?*Link = null,
    thread: ?std.Thread = null,
    failed: bool = false,
    child_open: bool = true,
    fn activeHandoff(self: *const Slot) ?wire.WorkerHandoffState {
        const p = self.handoff orelse return null;
        return if (registry_file.active(p)) p else null;
    }
    fn init() !Slot {
        const requests = try Native.pipe();
        errdefer for (requests) |fd| Native.close(fd);
        const results = try Native.pipe();
        errdefer for (results) |fd| Native.close(fd);
        const controls = try Native.pipe();
        errdefer for (controls) |fd| Native.close(fd);
        const client_requests = try Native.pipe();
        errdefer for (client_requests) |fd| Native.close(fd);
        const client_replies = try Native.pipe();
        return .{ .requests = requests, .results = results, .controls = controls, .client_requests = client_requests, .client_replies = client_replies };
    }
    fn childEnds(self: *const Slot) [5]tcp.fd_t {
        return .{ self.results[0], self.requests[1], self.controls[1], self.client_requests[0], self.client_replies[1] };
    }
    fn closeChildEnds(self: *Slot) void {
        if (!self.child_open) return;
        self.child_open = false;
        for (self.childEnds()) |fd| Native.close(fd);
    }
    fn fence(self: *Slot) void {
        if (self.failed) return;
        self.failed = true;
        for ([_]tcp.fd_t{ self.requests[0], self.results[1], self.controls[0], self.client_requests[1], self.client_replies[0] }) |fd| Native.close(fd);
    }
    fn deinit(self: *Slot, native: Native) void {
        self.closeChildEnds();
        if (self.thread) |thread| thread.join() else self.fence();
        if (self.link) |link| {
            if (self.thread == null) link.listener.deinit(native.io);
            a.destroy(link);
        }
    }
};
pub const Hub = struct {
    native: Native,
    arena: std.heap.ArenaAllocator,
    directory: std.Io.Dir,
    local_machine: []const u8,
    hub_id: ?[]const u8 = null,
    slots: std.ArrayList(Slot) = .empty,
    inherit: std.ArrayList(std.Io.File) = .empty,
    listener: ?std.Io.net.Server = null,
    thread: ?std.Thread = null,
    stopping: std.atomic.Value(bool) = .init(false),
    upgrade_requests: ?[2]tcp.fd_t = null,
    upgrade_replies: ?[2]tcp.fd_t = null,
    upgrade_child_open: bool = true,
    upgrade_failed: bool = false,
    pub fn init(native: Native, state_path: []const u8, local_machine: []const u8, port: u16) !*Hub {
        const self = try a.create(Hub);
        self.* = .{ .native = native, .arena = .init(a), .directory = try registryDirectory(native, state_path), .local_machine = local_machine };
        errdefer self.deinit();
        tcp.ignorePipe();
        const alloc = self.arena.allocator();
        const registry = try registry_file.load(native, alloc, state_path, local_machine);
        self.hub_id = registry.hubId;
        try self.slots.ensureTotalCapacity(a, 8);
        try self.inherit.ensureTotalCapacity(a, 42);
        self.upgrade_requests = try Native.pipe();
        try tcp.nonblock(self.upgrade_requests.?[1], true);
        self.upgrade_replies = try Native.pipe();
        self.inherit.appendAssumeCapacity(.{ .handle = self.upgrade_requests.?[0], .flags = .{ .nonblocking = false } });
        self.inherit.appendAssumeCapacity(.{ .handle = self.upgrade_replies.?[1], .flags = .{ .nonblocking = false } });
        for (0..8) |i| {
            var slot = try Slot.init();
            if (i < registry.hosts.len) slot.registration = registry.hosts[i];
            self.slots.appendAssumeCapacity(slot);
            for (slot.childEnds()) |fd| self.inherit.appendAssumeCapacity(.{ .handle = fd, .flags = .{ .nonblocking = false } });
        }
        for (registry.handoffs orelse &.{}) |pending| {
            for (self.slots.items) |*slot| if (slot.registration) |r| {
                if (std.mem.eql(u8, r.machineId, pending.plan.machineId)) {
                    slot.handoff = pending;
                    break;
                }
            };
        }
        self.listener = try (try std.Io.net.IpAddress.parse("127.0.0.1", enrollmentPort(port))).listen(native.io, .{ .reuse_address = true });
        _ = try Native.fcntl(self.listener.?.socket.handle, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
        return self;
    }
    pub fn json(self: *Hub) ![]u8 {
        var slots: [8]wire.RexRuntimeSlot = undefined;
        for (self.slots.items, 0..) |slot, i| slots[i] = .{ .registration = slot.registration, .readFd = slot.results[0], .writeFd = slot.requests[1], .controlFd = slot.controls[1], .clientReadFd = slot.client_requests[0], .clientWriteFd = slot.client_replies[1] };
        var pending: std.ArrayList(wire.WorkerHandoffState) = .empty;
        defer pending.deinit(a);
        for (self.slots.items) |slot| if (slot.activeHandoff()) |p| {
            try pending.append(a, p);
        };
        return std.json.Stringify.valueAlloc(a, wire.RexRuntimeRoutes{ .hubId = self.hub_id, .slots = &slots, .handoffReadFd = if (self.upgrade_requests) |p| p[0] else null, .handoffWriteFd = if (self.upgrade_replies) |p| p[1] else null, .handoffs = pending.items }, .{});
    }
    pub fn closeChildEnds(self: *Hub) void {
        for (self.slots.items) |*slot| slot.closeChildEnds();
        if (self.upgrade_child_open) {
            self.upgrade_child_open = false;
            if (self.upgrade_requests) |p| Native.close(p[0]);
            if (self.upgrade_replies) |p| Native.close(p[1]);
        }
        self.inherit.clearRetainingCapacity();
    }
    pub fn start(self: *Hub) !void {
        self.thread = try std.Thread.spawn(.{}, serve, .{self});
    }
    pub fn deinit(self: *Hub) void {
        self.stopping.store(true, .release);
        if (self.thread) |thread| thread.join();
        if (self.listener) |*listener| listener.deinit(self.native.io);
        self.closeChildEnds();
        if (self.upgrade_requests) |p| Native.close(p[1]);
        if (self.upgrade_replies) |p| Native.close(p[0]);
        for (self.slots.items) |*slot| slot.deinit(self.native);
        self.slots.deinit(a);
        self.inherit.deinit(a);
        self.directory.close(self.native.io);
        self.arena.deinit();
        a.destroy(self);
    }
    fn awaitRuntime(self: *Hub) !void {
        for (self.slots.items) |slot| {
            // Wait for the private runtime's readiness record, not a worker's
            // registration. Cold startup must not consume/fence a worker slot.
            while (true) {
                if (self.stopping.load(.acquire)) return error.Cancelled;
                var polls = [_]std.posix.pollfd{.{ .fd = slot.client_replies[0], .events = std.posix.POLL.IN, .revents = 0 }};
                if (try std.posix.poll(&polls, 100) != 0) break;
            }
            var header: [4]u8 = undefined;
            try self.readPipe(slot.client_replies[0], &header);
            const length = std.mem.readInt(u32, &header, .big);
            if (length == 0 or length > 4096) return error.RegistrationUnavailable;
            var body: [4096]u8 = undefined;
            try self.readPipe(slot.client_replies[0], body[0..length]);
            const ready = try wire.parseRexRuntimeReady(a, body[0..length]);
            defer ready.deinit();
            if (self.hub_id) |expected| {
                if (!std.mem.eql(u8, expected, ready.value.hubId)) return error.HubIdentityChanged;
            } else self.hub_id = try self.arena.allocator().dupe(u8, ready.value.hubId);
        }
    }
    fn serve(self: *Hub) void {
        self.awaitRuntime() catch |err| {
            if (!self.stopping.load(.acquire)) std.debug.print("deck: worker enrollment unavailable ({s}); runtime readiness unconfirmed\n", .{@errorName(err)});
            return;
        };
        while (!self.stopping.load(.acquire)) {
            var polls = [_]std.posix.pollfd{.{ .fd = self.listener.?.socket.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if ((std.posix.poll(&polls, 100) catch return) == 0) continue;
            const fd = tcp.accept(self.listener.?.socket.handle) catch continue;
            defer Native.close(fd);
            self.enroll(fd) catch {}; // No peer payload/credentials in diagnostics.
        }
    }
    fn readPipe(self: *Hub, fd: tcp.fd_t, bytes: []u8) !void {
        const deadline = tcp.now(self.native.io) + 5000;
        var offset: usize = 0;
        while (offset < bytes.len) {
            if (self.stopping.load(.acquire) or tcp.now(self.native.io) >= deadline) return error.RegistrationUnavailable;
            var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&polls, 100) == 0) continue;
            const n = try std.posix.read(fd, bytes[offset..]);
            if (n == 0) return error.RegistrationUnavailable;
            offset += n;
        }
    }
    fn enroll(self: *Hub, fd: tcp.fd_t) !void {
        const native = self.native;
        try tcp.requireLoopback(fd);
        const bytes = try tcp.receive(native.io, fd);
        defer a.free(bytes);
        var temporary = std.heap.ArenaAllocator.init(a);
        defer temporary.deinit();
        const temp = temporary.allocator();
        const raw = (try std.json.parseFromSlice(std.json.Value, temp, bytes, .{})).value;
        if (wire.validWorkerHandoffRequest(raw)) {
            const request = (try wire.parseWorkerHandoffRequest(temp, bytes)).value;
            const status = try self.upgrade(request, temp);
            return tcp.send(native.io, fd, wire.WorkerHandoffReply{ .kind = "worker_upgrade", .id = request.plan.id, .hubId = self.hub_id.?, .status = status });
        }
        if (!trust.validRexRegistration(raw)) return error.InvalidWorkerRegistration;
        var incoming = (try wire.parseRexWorkerRegistration(temp, bytes)).value;
        // Historical client authority is installed only by the offline hub
        // operator. A connecting worker may never extend its own allowlist.
        if (incoming.previousClients != null or incoming.upgradeId != null or incoming.upgradeHash != null) return error.InvalidWorkerRegistration;
        if (std.mem.eql(u8, incoming.machineId, self.local_machine)) return error.InvalidWorkerRegistration;
        if (incoming.hubId) |expected| if (self.hub_id) |actual| if (!std.mem.eql(u8, expected, actual)) return error.HubIdentityChanged;
        var selected: ?*Slot = null;
        for (self.slots.items) |*slot| if (slot.registration) |registered| {
            if (std.mem.eql(u8, registered.machineId, incoming.machineId)) {
                if (!trust.sameRexRegistration(registered, incoming)) return error.RegistrationMismatch;
                incoming = registered;
                selected = slot;
                break;
            }
        };
        if (selected == null) for (self.slots.items) |*slot| {
            if (slot.registration == null and !slot.failed) {
                selected = slot;
                break;
            }
        };
        const slot = selected orelse return error.WorkerCapacity;
        if (slot.failed) return error.RegistrationUnavailable;
        try self.activate(slot, incoming, temp);
        try tcp.send(native.io, fd, wire.RexEnrollmentAck{ .version = 1, .hubId = self.hub_id.?, .machineId = incoming.machineId, .port = slot.link.?.listener.socket.address.getPort() });
    }
    fn activate(self: *Hub, slot: *Slot, incoming: wire.RexWorkerRegistration, temp: std.mem.Allocator) !void {
        const native = self.native;
        if (slot.failed) return error.RegistrationUnavailable;
        if (slot.thread == null) {
            // A failed native/Pi handshake permanently fences this slot for this
            // process. Delayed ACKs cannot be mistaken for a new registration.
            errdefer slot.fence();
            const frame = try std.json.Stringify.valueAlloc(temp, wire.RexRegistrationFrame{ .kind = "register", .registration = incoming }, .{});
            var header: [4]u8 = undefined;
            std.mem.writeInt(u32, &header, @intCast(frame.len), .big);
            try tcp.writeAll(native.io, slot.client_requests[1], &header);
            try tcp.writeAll(native.io, slot.client_requests[1], frame);
            try self.readPipe(slot.client_replies[0], &header);
            const length = std.mem.readInt(u32, &header, .big);
            if (length == 0 or length > 4096) return error.RegistrationUnavailable;
            const reply = try temp.alloc(u8, length);
            try self.readPipe(slot.client_replies[0], reply);
            const ack = (try wire.parseRexRegistrationAck(temp, reply)).value;
            if (self.hub_id) |id| if (!std.mem.eql(u8, id, ack.hubId)) return error.HubIdentityChanged;
            if (incoming.hubId) |id| if (!std.mem.eql(u8, id, ack.hubId)) return error.HubIdentityChanged;
            const alloc = self.arena.allocator();
            // Generated parsers may borrow string slices from the encoded body.
            // The connection buffer is freed below; retain an owned copy first.
            const retained = try std.json.Stringify.valueAlloc(alloc, incoming, .{});
            var registration = (try wire.parseRexWorkerRegistration(alloc, retained)).value;
            registration.hubId = try alloc.dupe(u8, ack.hubId);
            self.hub_id = registration.hubId;
            slot.registration = registration;
            try self.saveRegistry(temp);
            var listener = try (try std.Io.net.IpAddress.parse("127.0.0.1", 0)).listen(native.io, .{ .reuse_address = true });
            errdefer listener.deinit(native.io);
            _ = try Native.fcntl(listener.socket.handle, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
            const link = try a.create(Link);
            errdefer a.destroy(link);
            link.* = .{ .native = native, .rex = registration, .listener = listener, .input = slot.requests[0], .output = slot.results[1], .control = slot.controls[0], .clients = .{ .input = slot.client_replies[0], .output = slot.client_requests[1] } };
            if (slot.handoff) |p| link.pause.store(p.phase == .prepared, .release);
            slot.link_committed = if (slot.handoff) |p| p.phase == .committed else false;
            slot.thread = try std.Thread.spawn(.{}, Link.serve, .{link});
            slot.link = link;
        }
    }
    fn saveRegistry(self: *Hub, alloc: std.mem.Allocator) !void {
        var hosts: std.ArrayList(wire.RexWorkerRegistration) = .empty;
        defer hosts.deinit(alloc);
        var pending: std.ArrayList(wire.WorkerHandoffState) = .empty;
        defer pending.deinit(alloc);
        for (self.slots.items) |s| {
            if (s.registration) |r| try hosts.append(alloc, r);
            if (s.handoff) |p| try pending.append(alloc, p);
        }
        try storage.save(self.native, alloc, self.directory, "rex-workers.json", wire.RexWorkerRegistry{ .version = 1, .hubId = self.hub_id, .hosts = hosts.items, .handoffs = if (pending.items.len > 0) pending.items else null });
    }
    fn writeUpgrade(self: *Hub, bytes: []const u8) !void {
        var offset: usize = 0;
        const end = tcp.now(self.native.io) + 5000;
        while (offset < bytes.len) {
            if (self.stopping.load(.acquire) or tcp.now(self.native.io) >= end) return error.HandoffUnavailable;
            var polls = [_]std.posix.pollfd{.{ .fd = self.upgrade_requests.?[1], .events = std.posix.POLL.OUT, .revents = 0 }};
            if (try std.posix.poll(&polls, 50) == 0) continue;
            const n = std.c.write(polls[0].fd, bytes[offset..].ptr, bytes.len - offset);
            switch (std.c.errno(n)) {
                .SUCCESS => {
                    if (n == 0) return error.HandoffUnavailable;
                    offset += @intCast(n);
                },
                .AGAIN, .INTR => {},
                else => return error.HandoffUnavailable,
            }
        }
    }
    fn admin(self: *Hub, request: wire.WorkerHandoffAdmin, alloc: std.mem.Allocator) !@FieldType(wire.WorkerHandoffReply, "status") {
        if (self.upgrade_failed or self.upgrade_requests == null) return error.HandoffUnavailable;
        errdefer {
            self.upgrade_failed = true; // Never consume a delayed ACK as a later phase.
            std.debug.print("deck: worker upgrade channel unconfirmed; retain transition custody and use same-build hub recovery, not pin resets\n", .{});
        }
        const body = try std.json.Stringify.valueAlloc(alloc, request, .{});
        if (body.len > 64 * 1024) return error.HandoffUnavailable;
        var header: [4]u8 = undefined;
        std.mem.writeInt(u32, &header, @intCast(body.len), .big);
        try self.writeUpgrade(&header);
        try self.writeUpgrade(body);
        try self.readPipe(self.upgrade_replies.?[0], &header);
        const length = std.mem.readInt(u32, &header, .big);
        if (length == 0 or length > 4096) return error.HandoffUnavailable;
        const bytes = try alloc.alloc(u8, length);
        try self.readPipe(self.upgrade_replies.?[0], bytes);
        const reply = (try wire.parseWorkerHandoffReply(alloc, bytes)).value;
        if (!std.mem.eql(u8, reply.id, request.plan.id) or !std.mem.eql(u8, reply.hubId, request.plan.hubId)) return error.HandoffUnavailable;
        const expected = switch (request.action) {
            .prepare => reply.status == .prepared or reply.status == .deferred,
            .commit => reply.status == .committed,
            .finish, .cancel => reply.status == .finished,
        };
        if (!expected) return error.HandoffUnavailable;
        return reply.status;
    }
    fn awaitFlag(self: *Hub, flag: *std.atomic.Value(bool)) !bool {
        const end = tcp.now(self.native.io) + 2000;
        while (tcp.now(self.native.io) < end and !self.stopping.load(.acquire)) {
            if (flag.load(.acquire)) return true;
            try self.native.io.sleep(.fromMilliseconds(10), .awake);
        }
        return false;
    }
    fn upgrade(self: *Hub, request: wire.WorkerHandoffRequest, temp: std.mem.Allocator) !@FieldType(wire.WorkerHandoffReply, "status") {
        const plan = request.plan;
        if (!handoff.valid(plan) or self.hub_id == null or !std.mem.eql(u8, self.hub_id.?, plan.hubId)) return error.InvalidHandoff;
        var selected: ?*Slot = null;
        for (self.slots.items) |*s| if (s.registration) |r| {
            if (std.mem.eql(u8, r.machineId, plan.machineId)) selected = s;
        };
        const slot = selected orelse return error.InvalidHandoff;
        const current = slot.registration.?;
        if (slot.activeHandoff()) |p| {
            if (!handoff.same(p.plan, plan)) return .deferred;
        }
        const released = if (slot.handoff) |p| blk: {
            if (!std.mem.eql(u8, p.plan.id, plan.id)) break :blk false;
            if (!handoff.same(p.plan, plan)) return .deferred;
            break :blk !registry_file.active(p);
        } else false;
        const after = handoff.matches(current, plan, true);
        if (!after and !handoff.matches(current, plan, false)) return .deferred;
        if (after and (current.upgradeId == null or !std.mem.eql(u8, current.upgradeId.?, plan.id) or current.upgradeHash == null or !std.mem.eql(u8, current.upgradeHash.?, &try handoff.hash(temp, plan)))) return .deferred;
        // Contact from a retained terminal package is not consent to roll the
        // worker back. Explicit offline administration remains separate.
        if (!after and slot.activeHandoff() == null) for (current.previousClients orelse &.{}) |previous| {
            if (std.mem.eql(u8, previous.executable, plan.client.executable)) return .deferred;
        };
        if (request.action == .probe) return if (self.upgrade_failed) .deferred else .supported;
        try self.activate(slot, current, temp);
        const link = slot.link.?;
        // A disconnected protocol-1 worker may already be retrying commit.
        // A released preparation permits a fresh prepare, NEVER a direct commit
        // across work admitted since force-start. No new wire action is needed.
        const reprepare = request.action == .commit and released and !after;
        if (request.action == .prepare or reprepare) {
            if (after) return if (slot.activeHandoff() != null or released) .committed else .finished;
            // Verify history capacity before pausing any admission or old process.
            _ = handoff.replacement(temp, current, plan) catch return .deferred;
            if (try self.admin(.{ .kind = "worker_upgrade", .action = .prepare, .plan = plan }, temp) != .prepared) return .deferred;
            link.pause.store(true, .release);
            if (!try self.awaitFlag(&link.quiescent)) {
                if (slot.activeHandoff() != null) return error.HandoffUnconfirmed;
                _ = try self.admin(.{ .kind = "worker_upgrade", .action = .cancel, .plan = plan }, temp);
                link.pause.store(false, .release);
                return .deferred;
            }
            if (slot.activeHandoff() == null) {
                const retained = try std.json.Stringify.valueAlloc(self.arena.allocator(), plan, .{});
                slot.handoff = .{ .plan = (try wire.parseWorkerHandoffPlan(self.arena.allocator(), retained)).value, .phase = .prepared };
            }
            try self.saveRegistry(temp);
            if (!reprepare) return .prepared;
        }
        if (request.action == .commit) {
            if (slot.activeHandoff() == null) {
                if (after and released) return .committed; // Exact already-published pins, lost ACK.
                return if (after) .finished else .deferred;
            }
            if (slot.handoff.?.phase == .prepared) {
                if (!link.quiescent.load(.acquire)) return error.HandoffUnconfirmed;
                slot.registration = try handoff.replacement(self.arena.allocator(), current, slot.handoff.?.plan);
                slot.handoff.?.phase = .committed;
            }
            try self.saveRegistry(temp); // Retain intent before accepting replacement bytes.
            if (try self.admin(.{ .kind = "worker_upgrade", .action = .commit, .plan = plan, .registration = slot.registration.? }, temp) != .committed) return error.HandoffUnconfirmed;
            if (!slot.link_committed) {
                link.replace(slot.registration.?);
                if (!try self.awaitFlag(&link.changed)) return error.HandoffUnconfirmed;
                slot.link_committed = true;
            }
            link.pause.store(false, .release);
            return .committed;
        }
        if (!after or !link.connected.load(.acquire)) return .deferred;
        if (slot.handoff) |p| {
            if (!handoff.same(p.plan, plan)) return .finished; // Late finish cannot erase another released receipt.
            if (p.phase != .committed and p.phase != .free_new) return error.HandoffUnconfirmed;
        }
        slot.handoff = null;
        try self.saveRegistry(temp);
        if (try self.admin(.{ .kind = "worker_upgrade", .action = .finish, .plan = plan }, temp) != .finished) return error.HandoffUnconfirmed;
        return .finished;
    }
};

test "handoff control rejects wrong-phase acknowledgements and never consumes a late reply as a retry" {
    const native = Native.testing();
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    const manager = try a.create(Hub);
    manager.* = .{ .native = native, .arena = .init(a), .directory = try tmp.dir.openDir(native.io, ".", .{ .iterate = true }), .local_machine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    defer manager.deinit();
    manager.upgrade_requests = try Native.pipe();
    manager.upgrade_replies = try Native.pipe();
    const plan: wire.WorkerHandoffPlan = .{ .version = 1, .id = "00000000-0000-4000-8000-000000000001", .hubId = "00000000-0000-4000-8000-000000000002", .machineId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", .beforeImplementation = &@as([64]u8, @splat('a')), .implementation = &@as([64]u8, @splat('b')), .beforeClient = .{ .executable = "/tools/old", .socket = "/private/worker.sock" }, .client = .{ .executable = "/tools/new", .socket = "/private/worker.sock" } };
    for ([_]@FieldType(wire.WorkerHandoffReply, "status"){ .committed, .prepared }) |status| {
        const bytes = try std.json.Stringify.valueAlloc(a, wire.WorkerHandoffReply{ .kind = "worker_upgrade", .id = plan.id, .hubId = plan.hubId, .status = status }, .{});
        defer a.free(bytes);
        var header: [4]u8 = undefined;
        std.mem.writeInt(u32, &header, @intCast(bytes.len), .big);
        try tcp.writeAll(native.io, manager.upgrade_replies.?[1], &header);
        try tcp.writeAll(native.io, manager.upgrade_replies.?[1], bytes);
        try std.testing.expectError(error.HandoffUnavailable, manager.admin(.{ .kind = "worker_upgrade", .action = .prepare, .plan = plan }, manager.arena.allocator()));
        try std.testing.expect(manager.upgrade_failed);
    }
}

test "automatic worker registry publication syncs its state directory" {
    const native: Native = .{ .io = std.testing.io, .environ = .empty };
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tmp.dir.realPathFileAlloc(native.io, ".", allocator);
    defer allocator.free(path);
    var directory = try registryDirectory(native, path);
    defer directory.close(native.io);
    const registry: wire.RexWorkerRegistry = .{ .version = 1, .hubId = "00000000-0000-4000-8000-000000000001", .hosts = &.{} };
    // A readable record alone is not success: save must also fsync the parent
    // before enrollment can acknowledge the worker and start its link listener.
    try storage.save(native, allocator, directory, "rex-workers.json", registry);
    const bytes = try directory.readFileAlloc(native.io, "rex-workers.json", allocator, .limited(4096));
    defer allocator.free(bytes);
    const saved = try wire.parseRexWorkerRegistry(allocator, bytes);
    defer saved.deinit();
    try std.testing.expectEqualStrings(registry.hubId.?, saved.value.hubId.?);
    try std.testing.expectEqual(@as(usize, 0), saved.value.hosts.len);
}

test "automatic enrollment requires matching runtime readiness on every slot" {
    const native: Native = .{ .io = std.testing.io, .environ = .empty };
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tmp.dir.realPathFileAlloc(native.io, ".", allocator);
    defer allocator.free(path);
    const hub_id = "00000000-0000-4000-8000-000000000001";
    const other = "00000000-0000-4000-8000-000000000002";
    const Case = enum { ready, wrong_kind, wrong_hub, mixed_hubs, closed, cancelled };
    for (std.enums.values(Case)) |case| {
        const manager = try a.create(Hub);
        manager.* = .{ .native = native, .arena = .init(a), .directory = try registryDirectory(native, path), .local_machine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .hub_id = if (case == .wrong_hub) hub_id else null };
        defer manager.deinit();
        try manager.slots.ensureTotalCapacity(a, 8);
        for (0..8) |_| manager.slots.appendAssumeCapacity(try Slot.init());
        if (case == .closed) manager.slots.items[0].closeChildEnds() else if (case == .cancelled) manager.stopping.store(true, .release) else {
            for (manager.slots.items, 0..) |slot, i| {
                const body = try std.json.Stringify.valueAlloc(allocator, .{ .kind = if (case == .wrong_kind) "registered" else "ready", .hubId = if (case == .wrong_hub or (case == .mixed_hubs and i == 7)) other else hub_id }, .{});
                defer allocator.free(body);
                var header: [4]u8 = undefined;
                std.mem.writeInt(u32, &header, @intCast(body.len), .big);
                try tcp.writeAll(native.io, slot.client_replies[1], &header);
                try tcp.writeAll(native.io, slot.client_replies[1], body);
            }
        }
        switch (case) {
            .ready => {
                try manager.awaitRuntime();
                try std.testing.expectEqualStrings(hub_id, manager.hub_id.?);
            },
            .wrong_kind => try std.testing.expectError(error.InvalidContract, manager.awaitRuntime()),
            .wrong_hub, .mixed_hubs => try std.testing.expectError(error.HubIdentityChanged, manager.awaitRuntime()),
            .closed => try std.testing.expectError(error.RegistrationUnavailable, manager.awaitRuntime()),
            .cancelled => try std.testing.expectError(error.Cancelled, manager.awaitRuntime()),
        }
        for (manager.slots.items) |slot| {
            try std.testing.expect(!slot.failed);
            try std.testing.expect(slot.registration == null);
        }
        try std.testing.expectError(error.FileNotFound, manager.directory.access(native.io, "rex-workers.json", .{}));
    }
}
