//! Live automatic-worker custody transfer. Local offers name already-installed
//! verified packages. Hub approval cannot supply an executable or run a shell.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const storage = @import("private_store.zig");
const tcp = @import("remote_io.zig");
const forward = @import("rex_forward.zig");
const trust = @import("remote_contracts.zig");
const contract = @import("handoff_contracts.zig");
const worker = @import("remote_worker.zig");
pub const filename = "live-handoff.json";
pub fn load(native: Native, a: std.mem.Allocator, path: []const u8) !?wire.WorkerHandoffLocal {
    const bytes = @import("mcp_profiles.zig").readPrivate(native, a, try std.fs.path.join(a, &.{ path, filename }), 16384) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
    const record = (try wire.parseWorkerHandoffLocal(a, bytes)).value;
    if (!contract.valid(record.plan)) return error.InvalidHandoff;
    return record;
}
fn connection(native: Native, a: std.mem.Allocator, path: []const u8) !wire.RexWorkerConnection {
    const bytes = try @import("mcp_profiles.zig").readPrivate(native, a, try std.fs.path.join(a, &.{ path, "rex-connection.json" }), 16384);
    return (try wire.parseRexWorkerConnection(a, bytes)).value;
}
fn scoped(c: wire.RexWorkerConnection, plan: wire.WorkerHandoffPlan, after: bool) bool {
    return !c.pendingSession and c.hubId != null and c.sessionId != null and std.mem.eql(u8, c.hubId.?, plan.hubId) and std.mem.eql(u8, c.implementation, if (after) plan.implementation else plan.beforeImplementation) and trust.sameRexClient(c.rexClient, if (after) plan.client else plan.beforeClient);
}
fn sameScope(c: wire.RexWorkerConnection, before: wire.RexWorkerConnection) bool {
    return !c.pendingSession and std.mem.eql(u8, c.hostId, before.hostId) and std.mem.eql(u8, c.account, before.account) and c.hubPort == before.hubPort and c.sessionId != null and before.sessionId != null and std.mem.eql(u8, c.sessionId.?, before.sessionId.?);
}
fn rpc(native: Native, a: std.mem.Allocator, c: wire.RexWorkerConnection, action: @FieldType(wire.WorkerHandoffRequest, "action"), plan: wire.WorkerHandoffPlan, cancelled: *std.atomic.Value(bool)) !@FieldType(wire.WorkerHandoffReply, "status") {
    const observed = try forward.identity(native, a, c.executable, c.server, cancelled);
    if (!sameScope(c, c) or !std.mem.eql(u8, c.hostId, observed.value.host_id) or !std.mem.eql(u8, c.account, observed.value.account)) return error.InvalidHandoff;
    var tunnel = try forward.Tunnel.open(native, a, c.executable, c.server, c.sessionId.?, @import("rex_enrollment.zig").enrollmentPort(@intCast(c.hubPort)), cancelled);
    defer tunnel.close();
    const fd = try tcp.connect(try std.Io.net.IpAddress.parse("127.0.0.1", tunnel.port));
    defer Native.close(fd);
    try tcp.send(native.io, fd, wire.WorkerHandoffRequest{ .kind = "worker_upgrade", .action = action, .plan = plan });
    const bytes = try tcp.receive(native.io, fd);
    defer tcp.a.free(bytes);
    const reply = (try wire.parseWorkerHandoffReply(a, bytes)).value;
    if (!std.mem.eql(u8, reply.id, plan.id) or !std.mem.eql(u8, reply.hubId, plan.hubId)) return error.InvalidHandoff;
    return reply.status;
}
pub const Manager = struct {
    native: Native,
    directory: std.Io.Dir,
    path: []const u8,
    machine: []const u8,
    implementation: []const u8,
    client: wire.WorkerRexClient,
    listener: worker.LocalListener,
    socket: []const u8,
    arena: std.heap.ArenaAllocator = .init(std.heap.page_allocator),
    intent: ?wire.WorkerHandoffLocal = null,
    thread: ?std.Thread = null,
    done: std.atomic.Value(bool) = .init(false),
    interrupt: *std.atomic.Value(bool),
    shutdown: *std.atomic.Value(bool),
    intent_synced: bool = true,
    drain: @import("worker.zig").Drain = .{},
    drained: std.atomic.Value(bool) = .init(false),
    replacement_ready: std.atomic.Value(bool) = .init(false),
    pub fn init(native: Native, dir: std.Io.Dir, path: []const u8, machine: []const u8, implementation: []const u8, client: wire.WorkerRexClient, interrupt: *std.atomic.Value(bool), shutdown: *std.atomic.Value(bool)) !*Manager {
        const self = try std.heap.page_allocator.create(Manager);
        errdefer std.heap.page_allocator.destroy(self);
        const socket = try std.fmt.allocPrint(std.heap.page_allocator, "{s}.upgrade", .{client.socket});
        errdefer std.heap.page_allocator.free(socket);
        self.* = .{ .native = native, .directory = dir, .path = path, .machine = machine, .implementation = implementation, .client = client, .socket = socket, .listener = try worker.clientListener(native, socket), .interrupt = interrupt, .shutdown = shutdown };
        errdefer {
            self.arena.deinit();
            @import("task_relay.zig").closeLocal(native.io, &self.listener.server, socket, self.listener.inode);
        }
        self.intent = try load(native, self.arena.allocator(), path);
        if (self.intent != null and self.intent.?.phase == .deferred) self.intent = null; // No retained custody; an offline transition may have changed pins.
        if (self.intent) |pending| {
            const c = try connection(native, self.arena.allocator(), path);
            if (!std.mem.eql(u8, pending.plan.machineId, machine) or !sameScope(c, pending.before) or (!scoped(c, pending.plan, false) and !scoped(c, pending.plan, true)) or (pending.phase == .committed and !scoped(c, pending.plan, true))) return error.InvalidHandoff;
            if (pending.phase == .prepared or (pending.phase == .committed and !self.isReplacement(pending.plan))) self.drain.requested.store(true, .release);
        }
        self.thread = try std.Thread.spawn(.{}, serve, .{self});
        return self;
    }
    pub fn deinit(self: *Manager) void {
        self.done.store(true, .release);
        if (self.thread) |t| t.join() else @import("task_relay.zig").closeLocal(self.native.io, &self.listener.server, self.socket, self.listener.inode);
        self.arena.deinit();
        std.heap.page_allocator.free(self.socket);
        std.heap.page_allocator.destroy(self);
    }
    fn isReplacement(self: *Manager, plan: wire.WorkerHandoffPlan) bool {
        return std.mem.eql(u8, self.implementation, plan.implementation) and trust.sameRexClient(self.client, plan.client);
    }
    fn retain(self: *Manager, value: wire.WorkerHandoffLocal) !void {
        // Only this thread writes intent; main observes it only after acquire of
        // replacement_ready, when this thread has stopped changing it.
        const bytes = try std.json.Stringify.valueAlloc(std.heap.page_allocator, value, .{});
        defer std.heap.page_allocator.free(bytes);
        if (bytes.len > 16384) return error.InvalidHandoff;
        const replacement = blk: {
            var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            errdefer arena.deinit();
            const encoded = try arena.allocator().dupe(u8, bytes);
            const parsed = try wire.parseWorkerHandoffLocal(arena.allocator(), encoded);
            break :blk .{ .arena = arena, .value = parsed.value };
        };
        self.arena.deinit();
        self.arena = replacement.arena;
        self.intent = replacement.value;
        self.intent_synced = false;
        try storage.save(self.native, self.arena.allocator(), self.directory, filename, self.intent.?);
        self.intent_synced = true;
    }
    fn serve(self: *Manager) void {
        defer @import("task_relay.zig").closeLocal(self.native.io, &self.listener.server, self.socket, self.listener.inode);
        var next: i64 = 0;
        while (!self.done.load(.acquire) and !self.shutdown.load(.acquire)) {
            var polls = [_]std.posix.pollfd{.{ .fd = self.listener.server.socket.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if ((std.posix.poll(&polls, 100) catch return) != 0) {
                const fd = tcp.accept(self.listener.server.socket.handle) catch continue;
                defer Native.close(fd);
                self.offer(fd) catch {}; // No credentials or peer payload in diagnostics.
            }
            if (tcp.now(self.native.io) >= next) {
                self.advance() catch {}; // Unconfirmed control phases retain their intent and fence.
                next = tcp.now(self.native.io) + 500;
            }
            if (self.replacement_ready.load(.acquire)) return;
        }
    }
    fn offer(self: *Manager, fd: tcp.fd_t) !void {
        var temporary = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer temporary.deinit();
        const a = temporary.allocator();
        const bytes = try tcp.receive(self.native.io, fd);
        defer tcp.a.free(bytes);
        const plan = (try wire.parseWorkerHandoffPlan(a, bytes)).value;
        var status: @FieldType(wire.WorkerHandoffReply, "status") = .deferred;
        if (contract.valid(plan) and std.mem.eql(u8, plan.machineId, self.machine)) blk: {
            if (self.intent) |pending| if (pending.phase != .deferred) {
                if (contract.same(pending.plan, plan)) status = .pending;
                break :blk;
            };
            const c = try connection(self.native, a, self.path);
            if (!scoped(c, plan, false)) break :blk;
            var next = c;
            next.implementation = plan.implementation;
            next.rexClient = plan.client;
            if ((try std.json.Stringify.valueAlloc(a, next, .{})).len > 16384 or (try std.json.Stringify.valueAlloc(a, wire.WorkerHandoffLocal{ .plan = plan, .before = c, .phase = .requested }, .{})).len > 16384) break :blk;
            @import("worker_client.zig").verify(self.native, a, plan.client.executable, plan.implementation, self.implementation, &self.done) catch break :blk;
            // Probe is read-only. Legacy/unavailable hubs cannot cause a process
            // exit or any pin change, and never provide the replacement path.
            if ((rpc(self.native, a, c, .probe, plan, &self.done) catch break :blk) != .supported) break :blk;
            try self.retain(.{ .plan = plan, .before = c, .phase = .requested });
            status = .pending;
        }
        try tcp.send(self.native.io, fd, wire.WorkerHandoffReply{ .kind = "worker_upgrade", .id = plan.id, .hubId = plan.hubId, .status = status });
    }
    fn advance(self: *Manager) !void {
        var pending = self.intent orelse return;
        if (!self.intent_synced) {
            try storage.save(self.native, self.arena.allocator(), self.directory, filename, pending);
            self.intent_synced = true;
        }
        if (pending.phase == .deferred) return;
        var temporary = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer temporary.deinit();
        const a = temporary.allocator();
        var c = try connection(self.native, a, self.path);
        if (!sameScope(c, pending.before) or (!scoped(c, pending.plan, false) and !scoped(c, pending.plan, true))) return error.InvalidHandoff;
        if (pending.phase == .requested) {
            const status = try rpc(self.native, a, c, .prepare, pending.plan, &self.done);
            if (status == .deferred) {
                pending.phase = .deferred;
                try self.retain(pending);
                return;
            }
            if (status == .finished) {
                // A completed transition cannot be resurrected as permission
                // to drain/replace a currently admitted worker after a stale restore.
                if (!scoped(c, pending.plan, true) or !self.isReplacement(pending.plan)) return error.HandoffUnconfirmed;
                pending.phase = .committed;
                try self.retain(pending);
                return;
            }
            if (status != .prepared and status != .committed) return error.HandoffUnconfirmed;
            pending.phase = .prepared;
            try self.retain(pending);
            self.drain.requested.store(true, .release);
            return;
        }
        if (pending.phase == .prepared) {
            self.drain.requested.store(true, .release);
            if (!self.drain.idle.load(.acquire)) return;
            self.interrupt.store(true, .release);
            if (!self.drained.load(.acquire)) return;
            // Session native workers/control/relay have all joined; the actual
            // writer lock remains held. No live effect is inherited across exec.
            try @import("worker_client.zig").verify(self.native, a, pending.plan.client.executable, pending.plan.implementation, self.implementation, &self.done);
            if (try rpc(self.native, a, c, .commit, pending.plan, &self.done) != .committed) return error.HandoffUnconfirmed;
            c.implementation = pending.plan.implementation;
            c.rexClient = pending.plan.client;
            try storage.save(self.native, a, self.directory, "rex-connection.json", c);
            pending.phase = .committed;
            try self.retain(pending);
            pending = self.intent.?;
            if (self.isReplacement(pending.plan)) {
                self.drain.requested.store(false, .release);
                self.interrupt.store(false, .release);
            }
        }
        if (!self.isReplacement(pending.plan)) {
            if (!self.drained.load(.acquire)) return;
            self.replacement_ready.store(true, .release);
            return;
        }
        // A completed socket handshake is not yet a running native service:
        // journal open, relay creation and native controller startup must succeed.
        if (!self.drain.ready.load(.acquire)) return;
        if (try rpc(self.native, a, c, .finish, pending.plan, &self.done) == .finished) {
            try self.directory.deleteFile(self.native.io, filename);
            try (std.Io.File{ .handle = self.directory.handle, .flags = .{ .nonblocking = false } }).sync(self.native.io);
            self.intent = null;
        }
    }
};

// Foreground launcher request. A private socket and exact expected scope, not a
// PID file, identify the live worker. The daemon continues after CLI detachment.
pub fn request(native: Native, a: std.mem.Allocator, path: []const u8, c: wire.RexWorkerConnection, client: []const u8, implementation: []const u8) !void {
    var cancelled = std.atomic.Value(bool).init(false);
    @import("worker_client.zig").verify(native, a, client, implementation, implementation, &cancelled) catch return error.WorkerUpgradeDeferred;
    var plan: wire.WorkerHandoffPlan = undefined;
    if (try load(native, a, path)) |pending| {
        if (pending.phase != .deferred) {
            if (!std.mem.eql(u8, pending.plan.implementation, implementation) or !std.mem.eql(u8, pending.plan.client.executable, client)) return error.WorkerUpgradeDeferred;
            return; // The worker owns retry of its original control intent.
        }
    }
    const dir = try storage.openDirectory(native, path, false);
    defer dir.close(native.io);
    const config = try @import("state.zig").load(native.io, a, dir);
    defer config.deinit();
    var random: [16]u8 = undefined;
    native.io.random(&random);
    random[6] = (random[6] & 15) | 64;
    random[8] = (random[8] & 63) | 128;
    const hex = std.fmt.bytesToHex(random, .lower);
    plan = .{ .version = 1, .id = try std.fmt.allocPrint(a, "{s}-{s}-{s}-{s}-{s}", .{ hex[0..8], hex[8..12], hex[12..16], hex[16..20], hex[20..32] }), .hubId = c.hubId orelse return error.WorkerUpgradeDeferred, .machineId = config.value.machine_id, .beforeImplementation = c.implementation, .beforeClient = c.rexClient, .implementation = implementation, .client = .{ .executable = client, .socket = c.rexClient.socket } };
    const socket = try std.fmt.allocPrint(a, "{s}.upgrade", .{c.rexClient.socket});
    var parent = try storage.openDirectory(native, std.fs.path.dirname(socket).?, false);
    defer parent.close(native.io);
    if ((try std.Io.Dir.cwd().statFile(native.io, socket, .{ .follow_symlinks = false })).kind != .unix_domain_socket) return error.WorkerUpgradeDeferred;
    var stream = try (try std.Io.net.UnixAddress.init(socket)).connect(native.io);
    defer stream.close(native.io);
    try tcp.send(native.io, stream.socket.handle, plan);
    const bytes = try tcp.receive(native.io, stream.socket.handle);
    defer tcp.a.free(bytes);
    const reply = (try wire.parseWorkerHandoffReply(a, bytes)).value;
    if (!std.mem.eql(u8, reply.id, plan.id) or !std.mem.eql(u8, reply.hubId, plan.hubId)) return error.WorkerUpgradeUnconfirmed;
    if (reply.status != .pending) return error.WorkerUpgradeDeferred;
}
