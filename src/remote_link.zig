//! One registered worker, one listener, one generation. Independent native pipes
//! prevent one unavailable host fencing another. No request is replayed on loss.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const boundary = @import("native_contracts.zig");
const trust = @import("remote_contracts.zig");
const tcp = @import("remote_io.zig");
const a = tcp.a;
const relay = @import("task_relay.zig");
pub const Verify = *const fn (Native, std.mem.Allocator, []const u8, std.Io.net.IpAddress, *std.atomic.Value(bool)) anyerror!std.json.Parsed(wire.TailPeer);
pub const Link = struct {
    native: Native,
    registry: wire.RemoteRegistry,
    index: usize,
    tailscale: []const u8,
    listener: std.Io.net.Server,
    verify: Verify = @import("tailscale.zig").verify,
    input: tcp.fd_t,
    output: tcp.fd_t,
    control: tcp.fd_t,
    clients: ?relay.Pipes = null,
    const Pending = struct {
        body: []u8,
        request: std.json.Parsed(wire.NativeRequest),
        deadline: i64,
        fn deinit(self: @This()) void {
            self.request.deinit();
            a.free(self.body);
        }
    };
    const Connection = struct {
        data: tcp.fd_t,
        control: tcp.fd_t,
        clients: ?tcp.fd_t = null,
        ticket: trust.Gate.Ticket,
        fn close(self: @This()) void {
            tcp.shutdown(self.data);
            tcp.shutdown(self.control);
            Native.close(self.data);
            Native.close(self.control);
            if (self.clients) |fd| {
                tcp.shutdown(fd);
                Native.close(fd);
            }
        }
    };
    fn verified(self: *Link, fd: tcp.fd_t) !void {
        var cancelled = std.atomic.Value(bool).init(false);
        // The address is obtained from this connected socket, not an intro,
        // registry address or earlier remote-check sample.
        const seen = try self.verify(self.native, a, self.tailscale, try tcp.peer(fd), &cancelled);
        defer seen.deinit();
        if (!trust.samePeer(seen.value, self.registry.hosts[self.index].peer)) return error.PeerIdentityMismatch;
    }
    fn handshake(self: *Link, gate: *trust.Gate, fd: tcp.fd_t) !Connection {
        errdefer Native.close(fd);
        try tcp.timeout(fd);
        try self.verified(fd);
        const bytes = try tcp.receive(self.native.io, fd);
        defer a.free(bytes);
        const intro = try wire.parseRemoteLinkHeader(a, bytes);
        defer intro.deinit();
        const host = self.registry.hosts[self.index];
        if (intro.value.channel != .data or intro.value.connectionId != null or !std.mem.eql(u8, intro.value.hubId, self.registry.hubId) or !std.mem.eql(u8, intro.value.machineId, host.machineId)) return error.InvalidHandshake;
        const ticket = try gate.challenge(host.peer, host.machineId);
        errdefer _ = gate.disconnect(ticket);
        const challenge: wire.RemoteWorkerHello = .{ .version = 1, .hubId = self.registry.hubId, .machineId = host.machineId, .connectionId = &ticket.connection, .implementation = host.implementation.?, .capabilities = host.capabilities.?, .rexClient = host.rexClient };
        try tcp.send(self.native.io, fd, challenge);
        const answer = try tcp.receive(self.native.io, fd);
        defer a.free(answer);
        const hello = try wire.parseRemoteWorkerHello(a, answer);
        defer hello.deinit();
        try gate.accept(host.peer, ticket, hello.value);
        try tcp.send(self.native.io, fd, wire.RemoteLinkHeader{ .version = 1, .channel = .data, .hubId = challenge.hubId, .machineId = challenge.machineId, .connectionId = challenge.connectionId });
        const control = try self.pair(.control, ticket);
        errdefer Native.close(control);
        const clients = if (host.rexClient != null) try self.pair(.clients, ticket) else null;
        errdefer if (clients) |socket| Native.close(socket);
        try tcp.nonblock(fd, true);
        return .{ .data = fd, .control = control, .clients = clients, .ticket = ticket };
    }
    fn pair(self: *Link, channel: @FieldType(wire.RemoteLinkHeader, "channel"), ticket: trust.Gate.Ticket) !tcp.fd_t {
        var poll = [_]std.posix.pollfd{.{ .fd = self.listener.socket.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&poll, 20000) == 0) return error.ChannelUnavailable;
        const fd = try tcp.accept(self.listener.socket.handle);
        errdefer Native.close(fd);
        try tcp.timeout(fd);
        try self.verified(fd);
        const bytes = try tcp.receive(self.native.io, fd);
        defer a.free(bytes);
        const header = try wire.parseRemoteLinkHeader(a, bytes);
        defer header.deinit();
        if (header.value.channel != channel or header.value.connectionId == null or !std.mem.eql(u8, header.value.connectionId.?, &ticket.connection) or !std.mem.eql(u8, header.value.hubId, self.registry.hubId) or !std.mem.eql(u8, header.value.machineId, self.registry.hosts[self.index].machineId)) return error.InvalidHandshake;
        try tcp.send(self.native.io, fd, header.value);
        try tcp.nonblock(fd, true);
        return fd;
    }
    pub fn serve(self: *Link) void {
        defer self.listener.deinit(self.native.io);
        defer Native.close(self.input);
        defer Native.close(self.output);
        defer Native.close(self.control);
        defer if (self.clients) |pipes| {
            Native.close(pipes.input);
            Native.close(pipes.output);
        };
        self.loop() catch {}; // Only this host's private pipes fence on local failure.
    }
    fn failure(queue: *tcp.Queue, request: wire.NativeRequest, uncertain: bool) !void {
        const bytes = if (request.operation == .bash_progress)
            try std.json.Stringify.valueAlloc(a, .{ .version = 1, .id = request.id, .progress = .{ .output = "", .truncated = false, .lossyUtf8 = false } }, .{})
        else
            try std.json.Stringify.valueAlloc(a, .{ .version = 1, .id = request.id, .result = .{ .ok = false, .code = if (uncertain) "effect_uncertain" else "offline", .output = if (uncertain) "effect_uncertain: remote connection lost; issued effects may have happened; not replayed" else "offline: assigned worker/capability unavailable; this attempt was not sent; earlier attempts may have happened; no local fallback" } }, .{});
        defer a.free(bytes);
        try boundary.checkReply(a, request, bytes);
        try queue.append(bytes);
    }
    fn loop(self: *Link) !void {
        const io = self.native.io;
        for ([_]tcp.fd_t{ self.input, self.output, self.control, self.listener.socket.handle }) |fd| try tcp.nonblock(fd, true);
        var gate = trust.Gate.init(io, self.registry);
        var client_relay: ?relay.Hub = if (self.clients) |pipes| try relay.Hub.init(pipes) else null;
        if (client_relay) |*r| r.launcher = std.mem.indexOfScalar(wire.WorkerCapability, self.registry.hosts[self.index].capabilities.?, .launcher) != null;
        defer if (client_relay) |*r| r.deinit();
        var connection: ?Connection = null;
        defer if (connection) |c| c.close();
        var input: tcp.Reader = .{};
        defer input.deinit();
        var replies: tcp.Reader = .{};
        defer replies.deinit();
        var to_worker: tcp.Queue = .{};
        defer to_worker.deinit();
        var to_pi: tcp.Queue = .{};
        defer to_pi.deinit();
        var pending: std.ArrayList(Pending) = .empty;
        defer {
            for (pending.items) |p| p.deinit();
            pending.deinit(a);
        }
        var cancellations: [8]u8 = undefined;
        var cancel_used: usize = 0;
        var cancelled: [16]u64 = @splat(0);
        var cancel_at: usize = 0;
        var controls: [160]u8 = undefined;
        var control_used: usize = 0;
        var heartbeat: [8]u8 = undefined;
        var heartbeat_used: usize = 0;
        var last_ping = tcp.now(io);
        var last_pong = last_ping;
        while (true) {
            var polls = [_]std.posix.pollfd{
                .{ .fd = self.listener.socket.handle, .events = std.posix.POLL.IN, .revents = 0 },
                .{ .fd = self.input, .events = if (pending.items.len + to_pi.items.items.len < 20) std.posix.POLL.IN else 0, .revents = 0 },
                .{ .fd = self.control, .events = std.posix.POLL.IN, .revents = 0 },
                .{ .fd = self.output, .events = if (to_pi.items.items.len > 0) std.posix.POLL.OUT else 0, .revents = 0 },
                .{ .fd = if (connection) |c| c.data else -1, .events = std.posix.POLL.IN | (if (to_worker.items.items.len > 0) @as(i16, std.posix.POLL.OUT) else 0), .revents = 0 },
                .{ .fd = if (connection) |c| c.control else -1, .events = std.posix.POLL.IN | (if (control_used > 0) @as(i16, std.posix.POLL.OUT) else 0), .revents = 0 },
                .{ .fd = if (connection) |c| c.clients orelse -1 else -1, .events = std.posix.POLL.IN | (if (client_relay != null and client_relay.?.to_worker.items.items.len > 0) @as(i16, std.posix.POLL.OUT) else 0), .revents = 0 },
                .{ .fd = if (self.clients) |p| p.input else -1, .events = std.posix.POLL.IN, .revents = 0 },
                .{ .fd = if (self.clients) |p| p.output else -1, .events = if (client_relay != null and client_relay.?.to_pi.items.items.len > 0) std.posix.POLL.OUT else 0, .revents = 0 },
            };
            _ = try std.posix.poll(&polls, 100);
            // Always service cancellations independently of data/result pressure.
            if (polls[2].revents != 0) {
                const n = try std.posix.read(self.control, cancellations[cancel_used..]);
                if (n == 0) return;
                cancel_used += n;
                if (cancel_used == 8) {
                    const id = std.mem.readInt(u64, &cancellations, .big);
                    if (!boundary.validCancellationId(id)) return error.InvalidCancellation;
                    cancelled[cancel_at] = id;
                    cancel_at = (cancel_at + 1) % cancelled.len;
                    if (connection != null) {
                        if (control_used + 8 > controls.len) return error.ControlCapacity;
                        @memcpy(controls[control_used..][0..8], &cancellations);
                        control_used += 8;
                    }
                    cancel_used = 0;
                }
            }
            try to_pi.flush(self.output, null);
            var lost = false;
            if (client_relay) |*r| r.step(io, if (connection) |c| c.clients else null, if (connection) |c| &c.ticket.connection else null) catch |err| {
                if (err == error.ClientPipeFailed) return err;
                lost = true;
            };
            if (connection) |c| {
                if (!gate.connected(c.ticket)) return error.StaleConnection;
                if (tcp.now(io) - last_ping >= 1000 and control_used + 8 <= controls.len) {
                    @memset(controls[control_used..][0..8], 0);
                    control_used += 8;
                    last_ping = tcp.now(io);
                }
                if (control_used > 0) {
                    const n = std.c.write(c.control, &controls, control_used);
                    switch (std.c.errno(n)) {
                        .SUCCESS => {
                            const sent: usize = @intCast(n);
                            std.mem.copyForwards(u8, &controls, controls[sent..control_used]);
                            control_used -= sent;
                        },
                        .AGAIN, .INTR => {},
                        else => lost = true,
                    }
                }
                if (polls[5].revents & (std.posix.POLL.IN | std.posix.POLL.HUP | std.posix.POLL.ERR) != 0) {
                    const n = std.posix.read(c.control, heartbeat[heartbeat_used..]) catch 0;
                    if (n == 0) lost = true else {
                        heartbeat_used += n;
                        if (heartbeat_used == 8) {
                            if (std.mem.readInt(u64, &heartbeat, .big) != 0) lost = true;
                            heartbeat_used = 0;
                            last_pong = tcp.now(io);
                        }
                    }
                }
                if (tcp.now(io) - last_pong > 5000) lost = true;
                for (pending.items) |p| if (tcp.now(io) >= p.deadline) {
                    lost = true;
                };
                to_worker.flush(c.data, io) catch {
                    lost = true;
                };
                const reply = replies.read(io, c.data) catch blk: {
                    lost = true;
                    break :blk null;
                };
                if (reply) |body| {
                    const raw = if (std.unicode.utf8ValidateSlice(body)) std.json.parseFromSlice(std.json.Value, a, body, .{}) catch null else null;
                    if (raw) |value| {
                        defer value.deinit();
                        var found: ?usize = null;
                        for (pending.items, 0..) |p, i| {
                            if (boundary.validReply(p.request.value.id, p.request.value.operation, value.value)) {
                                found = i;
                                break;
                            }
                        }
                        if (found) |i| {
                            try to_pi.append(body);
                            pending.orderedRemove(i).deinit();
                        } else lost = true;
                    } else lost = true;
                    replies.reset();
                }
                if (lost) {
                    c.close();
                    if (client_relay) |*r| r.disconnect();
                    connection = null;
                    _ = gate.disconnect(c.ticket);
                    to_worker.clear();
                    replies.reset();
                    control_used = 0;
                    heartbeat_used = 0;
                    while (pending.pop()) |p| {
                        defer p.deinit();
                        try failure(&to_pi, p.request.value, true);
                    }
                }
            }
            if (polls[0].revents & std.posix.POLL.IN != 0) {
                const incoming = tcp.accept(self.listener.socket.handle) catch |err| switch (err) {
                    error.WouldBlock => continue,
                    else => return err,
                };
                if (connection != null) Native.close(incoming) else {
                    connection = self.handshake(&gate, incoming) catch null;
                    if (connection != null) for (cancelled) |id| {
                        if (id != 0) {
                            std.mem.writeInt(u64, controls[control_used..][0..8], id, .big);
                            control_used += 8;
                        }
                    };
                    last_ping = tcp.now(io);
                    last_pong = last_ping;
                }
            }
            if (pending.items.len + to_pi.items.items.len < 20) {
                if (try input.read(io, self.input)) |body| {
                    const copy = try a.dupe(u8, body);
                    var retained = false;
                    defer if (!retained) a.free(copy);
                    const parsed = try boundary.parseRequest(a, copy);
                    defer if (!retained) parsed.deinit();
                    const request = parsed.value;
                    const wrong_mcp_host = if (request.operation == .mcp_call) blk: {
                        const plan = try wire.parseMcpCallPlan(a, request.args.plan.?);
                        defer plan.deinit();
                        break :blk !std.mem.eql(u8, plan.value.taskMachineId, request.machineId);
                    } else false;
                    var duplicate = false;
                    for (pending.items) |p| {
                        if (std.mem.eql(u8, p.request.value.id, request.id)) duplicate = true;
                    }
                    if (duplicate) return error.DuplicateRequest;
                    if (request.operation == .link_status and std.mem.eql(u8, request.machineId, self.registry.hosts[self.index].machineId)) {
                        // Hub-local observation only: no worker request, journal or execution.
                        const reply = try std.json.Stringify.valueAlloc(a, .{ .version = 1, .id = request.id, .result = .{ .ok = true, .code = "link_status", .output = if (connection != null) @as([]const u8, "connected") else "offline" } }, .{});
                        defer a.free(reply);
                        try to_pi.append(reply);
                    } else if (wrong_mcp_host or connection == null or !std.mem.eql(u8, request.machineId, self.registry.hosts[self.index].machineId) or (if (request.operation == .mcp_call) std.mem.indexOfScalar(wire.WorkerCapability, self.registry.hosts[self.index].capabilities.?, .mcp) == null else !supported(request.operation) and self.clients == null)) {
                        try failure(&to_pi, request, false);
                    } else {
                        try to_worker.append(copy);
                        try pending.append(a, .{ .body = copy, .request = parsed, .deadline = tcp.now(io) + (if (request.operation == .bash) (request.args.timeout orelse 60) * 1000 + 5000 else @as(i64, 30000)) });
                        retained = true;
                    }
                    input.reset();
                }
            }
        }
    }
};
pub fn supported(op: wire.NativeOperation) bool {
    return op == .read or op == .write or op == .edit or op == .bash or op == .bash_progress;
}
