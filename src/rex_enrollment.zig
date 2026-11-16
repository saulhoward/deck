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
    link: ?*Link = null,
    thread: ?std.Thread = null,
    failed: bool = false,
    child_open: bool = true,
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
    pub fn init(native: Native, state_path: []const u8, local_machine: []const u8, port: u16) !*Hub {
        const self = try a.create(Hub);
        self.* = .{ .native = native, .arena = .init(a), .directory = try registryDirectory(native, state_path), .local_machine = local_machine };
        errdefer self.deinit();
        tcp.ignorePipe();
        const alloc = self.arena.allocator();
        const path = try std.fs.path.join(alloc, &.{ state_path, "rex-workers.json" });
        const bytes = @import("mcp_profiles.zig").readPrivate(native, alloc, path, 64 * 1024) catch |err| switch (err) {
            error.FileNotFound => null,
            else => return err,
        };
        var registry: wire.RexWorkerRegistry = .{ .version = 1, .hosts = &.{} };
        if (bytes) |text| {
            registry = (try wire.parseRexWorkerRegistry(alloc, text)).value;
            if (registry.hosts.len > 0 and registry.hubId == null) return error.InvalidWorkerRegistration;
            const raw = (try std.json.parseFromSlice(std.json.Value, alloc, text, .{})).value;
            for (raw.object.get("hosts").?.array.items) |host| if (!trust.validRexRegistration(host)) return error.InvalidWorkerRegistration;
            for (registry.hosts, 0..) |host, index| {
                if (std.mem.eql(u8, host.machineId, local_machine) or host.hubId == null or !std.mem.eql(u8, host.hubId.?, registry.hubId.?)) return error.InvalidWorkerRegistration;
                for (registry.hosts[0..index]) |prior| if (std.mem.eql(u8, prior.machineId, host.machineId)) return error.InvalidWorkerRegistration;
            }
        }
        self.hub_id = registry.hubId;
        try self.slots.ensureTotalCapacity(a, 8);
        try self.inherit.ensureTotalCapacity(a, 40);
        for (0..8) |i| {
            var slot = try Slot.init();
            if (i < registry.hosts.len) slot.registration = registry.hosts[i];
            self.slots.appendAssumeCapacity(slot);
            for (slot.childEnds()) |fd| self.inherit.appendAssumeCapacity(.{ .handle = fd, .flags = .{ .nonblocking = false } });
        }
        self.listener = try (try std.Io.net.IpAddress.parse("127.0.0.1", enrollmentPort(port))).listen(native.io, .{ .reuse_address = true });
        _ = try Native.fcntl(self.listener.?.socket.handle, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
        return self;
    }
    pub fn json(self: *Hub) ![]u8 {
        var slots: [8]wire.RexRuntimeSlot = undefined;
        for (self.slots.items, 0..) |slot, i| slots[i] = .{ .registration = slot.registration, .readFd = slot.results[0], .writeFd = slot.requests[1], .controlFd = slot.controls[1], .clientReadFd = slot.client_requests[0], .clientWriteFd = slot.client_replies[1] };
        return std.json.Stringify.valueAlloc(a, wire.RexRuntimeRoutes{ .hubId = self.hub_id, .slots = &slots }, .{});
    }
    pub fn closeChildEnds(self: *Hub) void {
        for (self.slots.items) |*slot| slot.closeChildEnds();
        self.inherit.clearRetainingCapacity();
    }
    pub fn start(self: *Hub) !void {
        self.thread = try std.Thread.spawn(.{}, serve, .{self});
    }
    pub fn deinit(self: *Hub) void {
        self.stopping.store(true, .release);
        if (self.thread) |thread| thread.join();
        if (self.listener) |*listener| listener.deinit(self.native.io);
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
        if (!trust.validRexRegistration(raw)) return error.InvalidWorkerRegistration;
        const incoming = (try wire.parseRexWorkerRegistration(temp, bytes)).value;
        if (std.mem.eql(u8, incoming.machineId, self.local_machine)) return error.InvalidWorkerRegistration;
        if (incoming.hubId) |expected| if (self.hub_id) |actual| if (!std.mem.eql(u8, expected, actual)) return error.HubIdentityChanged;
        var selected: ?*Slot = null;
        for (self.slots.items) |*slot| if (slot.registration) |registered| {
            if (std.mem.eql(u8, registered.machineId, incoming.machineId)) {
                if (!trust.sameRexRegistration(registered, incoming)) return error.RegistrationMismatch;
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
            const retained = try alloc.dupe(u8, bytes);
            var registration = (try wire.parseRexWorkerRegistration(alloc, retained)).value;
            registration.hubId = try alloc.dupe(u8, ack.hubId);
            self.hub_id = registration.hubId;
            slot.registration = registration;
            var hosts: std.ArrayList(wire.RexWorkerRegistration) = .empty;
            for (self.slots.items) |s| if (s.registration) |r| try hosts.append(temp, r);
            try storage.save(native, temp, self.directory, "rex-workers.json", wire.RexWorkerRegistry{ .version = 1, .hubId = self.hub_id, .hosts = hosts.items });
            var listener = try (try std.Io.net.IpAddress.parse("127.0.0.1", 0)).listen(native.io, .{ .reuse_address = true });
            errdefer listener.deinit(native.io);
            _ = try Native.fcntl(listener.socket.handle, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
            const link = try a.create(Link);
            errdefer a.destroy(link);
            link.* = .{ .native = native, .rex = registration, .listener = listener, .input = slot.requests[0], .output = slot.results[1], .control = slot.controls[0], .clients = .{ .input = slot.client_replies[0], .output = slot.client_requests[1] } };
            slot.thread = try std.Thread.spawn(.{}, Link.serve, .{link});
            slot.link = link;
        }
        try tcp.send(native.io, fd, wire.RexEnrollmentAck{ .version = 1, .hubId = self.hub_id.?, .machineId = incoming.machineId, .port = slot.link.?.listener.socket.address.getPort() });
    }
};

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
