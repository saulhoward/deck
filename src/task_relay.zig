//! Bounded, ephemeral task RPC, separate from effects and cancellation streams.
//! Every socket belongs to the same verified worker generation. No store/replay.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const tcp = @import("remote_io.zig");
const a = tcp.a;
pub const Pipes = struct { input: tcp.fd_t, output: tcp.fd_t };
fn sameScope(x: wire.TaskClientScope, y: wire.TaskClientScope) bool {
    return std.mem.eql(u8, x.hubId, y.hubId) and std.mem.eql(u8, x.chatId, y.chatId) and std.mem.eql(u8, x.allocationId, y.allocationId) and std.mem.eql(u8, x.blockId, y.blockId);
}
fn frame(bytes: []const u8) !std.json.Parsed(wire.TaskRelayFrame) {
    if (!std.unicode.utf8ValidateSlice(bytes)) return error.InvalidFrame;
    const raw = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer raw.deinit();
    if (!wire.validTaskRelayFrame(raw.value)) return error.InvalidFrame;
    return std.json.parseFromSlice(wire.TaskRelayFrame, a, bytes, .{ .allocate = .alloc_always });
}
pub const Hub = struct {
    pipes: Pipes,
    network: tcp.Reader = .{},
    replies: tcp.Reader = .{},
    to_pi: tcp.Queue = .{},
    to_worker: tcp.Queue = .{},
    pending: std.ArrayList(std.json.Parsed(wire.TaskRelayFrame)) = .empty,
    pub fn init(pipes: Pipes) !Hub {
        try tcp.nonblock(pipes.input, true);
        try tcp.nonblock(pipes.output, true);
        return .{ .pipes = pipes };
    }
    pub fn deinit(self: *Hub) void {
        self.network.deinit();
        self.replies.deinit();
        self.to_pi.deinit();
        self.to_worker.deinit();
        for (self.pending.items) |p| p.deinit();
        self.pending.deinit(a);
    }
    pub fn disconnect(self: *Hub) void {
        self.network.reset();
        self.to_worker.clear();
        // Calls accepted before loss may already be partly in the private pipe.
        // Complete that original forwarding, never resend it to a new worker.
        // Keep their slots until the hub replies, even if their clients detached.
    }
    pub fn step(self: *Hub, io: std.Io, fd: ?tcp.fd_t, generation: ?[]const u8) !void {
        self.to_pi.flush(self.pipes.output, io) catch return error.ClientPipeFailed;
        if (self.replies.read(io, self.pipes.input) catch return error.ClientPipeFailed) |bytes| {
            defer self.replies.reset();
            const reply = frame(bytes) catch return error.ClientPipeFailed;
            defer reply.deinit();
            var found: ?usize = null;
            for (self.pending.items, 0..) |p, i| if (std.mem.eql(u8, p.value.id, reply.value.id) and std.mem.eql(u8, p.value.connectionId, reply.value.connectionId) and sameScope(p.value.scope, reply.value.scope)) {
                found = i;
                break;
            };
            const index = found orelse return error.ClientPipeFailed;
            self.pending.orderedRemove(index).deinit();
            if (generation) |g| if (std.mem.eql(u8, g, reply.value.connectionId)) try self.to_worker.append(bytes);
        }
        if (fd) |socket| {
            try self.to_worker.flush(socket, io);
            if (self.pending.items.len + self.to_worker.items.items.len >= 8) return;
            if (try self.network.read(io, socket)) |bytes| {
                defer self.network.reset();
                const request = try frame(bytes);
                errdefer request.deinit();
                if (!std.mem.eql(u8, request.value.connectionId, generation.?)) return error.StaleConnection;
                for (self.pending.items) |p| if (std.mem.eql(u8, p.value.id, request.value.id)) return error.DuplicateClientRequest;
                try self.pending.ensureUnusedCapacity(a, 1);
                try self.to_pi.append(bytes);
                self.pending.appendAssumeCapacity(request);
            }
        }
    }
};
pub fn closeLocal(io: std.Io, listener: *std.Io.net.Server, path: []const u8, inode: std.Io.File.INode) void {
    listener.deinit(io);
    const current = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return;
    if (current.kind == .unix_domain_socket and current.inode == inode) std.Io.Dir.cwd().deleteFile(io, path) catch {};
}
pub const Worker = struct {
    native: Native,
    socket: tcp.fd_t,
    listener: std.Io.net.Server,
    local_path: []const u8,
    local_inode: std.Io.File.INode,
    generation: []const u8,
    stopping: *std.atomic.Value(bool),
    data: tcp.fd_t,
    control: tcp.fd_t,
    const Slot = struct {
        fd: tcp.fd_t = -1,
        reader: tcp.Reader = .{},
        output: tcp.Queue = .{},
        request: ?std.json.Parsed(wire.TaskClientRequest) = null,
        id: [64]u8 = @splat(0),
        began: i64 = 0,
        answered: bool = false,
        fn close(self: *Slot) void {
            if (self.fd >= 0) {
                Native.close(self.fd);
                self.fd = -1;
            }
        }
        fn clear(self: *Slot) void {
            self.close();
            self.reader.reset();
            self.output.clear();
            if (self.request) |r| r.deinit();
            self.request = null;
            self.answered = false;
        }
        fn deinit(self: *Slot) void {
            self.clear();
            self.reader.deinit();
            self.output.deinit();
        }
    };
    pub fn serve(self: *Worker) void {
        defer closeLocal(self.native.io, &self.listener, self.local_path, self.local_inode);
        self.loop() catch {};
        self.stopping.store(true, .release);
        tcp.shutdown(self.data);
        tcp.shutdown(self.control);
    }
    fn loop(self: *Worker) !void {
        const io = self.native.io;
        try tcp.nonblock(self.socket, true);
        try tcp.nonblock(self.listener.socket.handle, true);
        var slots: [8]Slot = @splat(.{});
        defer for (&slots) |*slot| slot.deinit();
        var output: tcp.Queue = .{};
        defer output.deinit();
        var reader: tcp.Reader = .{};
        defer reader.deinit();
        var counter: u64 = 0;
        while (!self.stopping.load(.acquire)) {
            var polls: [10]std.posix.pollfd = undefined;
            polls[0] = .{ .fd = self.listener.socket.handle, .events = std.posix.POLL.IN, .revents = 0 };
            polls[1] = .{ .fd = self.socket, .events = std.posix.POLL.IN | (if (output.items.items.len > 0) @as(i16, std.posix.POLL.OUT) else 0), .revents = 0 };
            for (slots, 0..) |slot, i| polls[i + 2] = .{ .fd = slot.fd, .events = std.posix.POLL.IN | (if (slot.output.items.items.len > 0) @as(i16, std.posix.POLL.OUT) else 0), .revents = 0 };
            _ = try std.posix.poll(&polls, 50);
            if (polls[0].revents != 0) {
                const client = try tcp.accept(self.listener.socket.handle);
                var assigned = false;
                for (&slots) |*slot| if (slot.fd < 0 and slot.request == null) {
                    tcp.nonblock(client, true) catch |err| {
                        Native.close(client);
                        return err;
                    };
                    slot.fd = client;
                    slot.began = tcp.now(io);
                    counter = try std.math.add(u64, counter, 1);
                    var hash = std.crypto.hash.sha2.Sha256.init(.{});
                    hash.update(self.generation);
                    var bytes: [8]u8 = undefined;
                    std.mem.writeInt(u64, &bytes, counter, .big);
                    hash.update(&bytes);
                    slot.id = std.fmt.bytesToHex(hash.finalResult(), .lower);
                    assigned = true;
                    break;
                };
                if (!assigned) Native.close(client);
            }
            try output.flush(self.socket, io);
            if (try reader.read(io, self.socket)) |bytes| {
                defer reader.reset();
                const reply = try frame(bytes);
                defer reply.deinit();
                if (!std.mem.eql(u8, reply.value.connectionId, self.generation)) return error.StaleConnection;
                var found = false;
                for (&slots) |*slot| if (slot.request) |request| {
                    if (std.mem.eql(u8, &slot.id, reply.value.id) and sameScope(request.value.scope, reply.value.scope) and !slot.answered) {
                        slot.answered = true;
                        found = true;
                        if (slot.fd >= 0) try slot.output.append(reply.value.body) else slot.clear();
                        break;
                    }
                };
                if (!found) return error.UnsolicitedClientReply;
            }
            for (&slots, 0..) |*slot, i| {
                if (slot.fd < 0 and slot.request == null) continue;
                if (tcp.now(io) - slot.began > 15000 and slot.request != null and !slot.answered) return error.ClientTimeout;
                if (tcp.now(io) - slot.began > 10000) {
                    slot.close();
                    if (slot.request == null or slot.answered) slot.clear();
                    continue;
                }
                if (slot.fd < 0) continue;
                if (slot.request == null) {
                    const body = slot.reader.read(io, slot.fd) catch {
                        slot.clear();
                        continue;
                    };
                    if (body) |bytes| {
                        const request = parseClient(bytes) catch {
                            slot.clear();
                            continue;
                        };
                        slot.request = request;
                        const encoded = try std.json.Stringify.valueAlloc(a, wire.TaskRelayFrame{ .connectionId = self.generation, .id = &slot.id, .scope = request.value.scope, .body = request.value.body }, .{});
                        defer a.free(encoded);
                        // The network envelope has more fields than the local one.
                        // Reject this client, not the independent effect/control link.
                        if (encoded.len > tcp.cap) {
                            slot.clear();
                            continue;
                        }
                        try output.append(encoded);
                        slot.reader.reset();
                    }
                } else if (polls[i + 2].revents & (std.posix.POLL.IN | std.posix.POLL.HUP | std.posix.POLL.ERR) != 0) {
                    // Extra input or detach closes just this client; it never stops
                    // an admitted hub task or frees an outstanding correlation.
                    slot.close();
                    if (slot.answered) slot.clear();
                    continue;
                }
                if (slot.fd >= 0) slot.output.flush(slot.fd, io) catch {
                    slot.clear();
                };
                if (slot.answered and slot.output.items.items.len == 0) slot.clear();
            }
        }
    }
};
fn parseClient(bytes: []const u8) !std.json.Parsed(wire.TaskClientRequest) {
    if (!std.unicode.utf8ValidateSlice(bytes)) return error.InvalidFrame;
    const raw = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer raw.deinit();
    if (!wire.validTaskClientRequest(raw.value)) return error.InvalidFrame;
    return std.json.parseFromSlice(wire.TaskClientRequest, a, bytes, .{ .allocate = .alloc_always });
}
