const std = @import("std");
const wire = @import("generated/contracts.zig");
pub fn validPeer(value: std.json.Value) bool {
    if (!wire.validTailPeer(value)) return false;
    const id = value.object.get("userId").?.string;
    if (id.len > 1 and id[0] == '0') return false;
    _ = std.fmt.parseInt(u64, id, 10) catch return false;
    return true;
}
fn ordered(values: std.json.Value) bool {
    var previous: usize = 0;
    for (values.array.items) |value| {
        const index: usize = if (std.mem.eql(u8, value.string, "files")) 1 else if (std.mem.eql(u8, value.string, "bash")) 2 else 3;
        if (index <= previous) return false;
        previous = index;
    }
    return true;
}
pub fn validRexClient(value: std.json.Value) bool {
    if (!wire.validWorkerRexClient(value)) return false;
    for ([_][]const u8{ "executable", "socket" }) |key| {
        const s = value.object.get(key).?.string;
        if (!std.fs.path.isAbsolute(s) or std.mem.indexOfAny(u8, s, "\x00\r\n") != null or s.len > (if (std.mem.eql(u8, key, "socket")) @as(usize, 100) else 4096)) return false;
    }
    return true;
}
pub fn sameRexClient(left: ?wire.WorkerRexClient, right: ?wire.WorkerRexClient) bool {
    if (left == null or right == null) return left == null and right == null;
    return std.mem.eql(u8, left.?.executable, right.?.executable) and std.mem.eql(u8, left.?.socket, right.?.socket);
}
pub fn validRegistry(value: std.json.Value) bool {
    if (!wire.validRemoteRegistry(value)) return false;
    const hosts = value.object.get("hosts").?.array.items;
    for (hosts, 0..) |host, i| {
        const peer = host.object.get("peer").?;
        if (!validPeer(peer)) return false;
        const implementation = host.object.contains("implementation");
        const capabilities = host.object.get("capabilities");
        if (implementation != (capabilities != null) or (!host.object.get("client").?.bool and !implementation)) return false;
        if (capabilities) |caps| if (!ordered(caps)) return false;
        if (host.object.get("rexClient")) |client| {
            if (!implementation or !validRexClient(client)) return false;
            const caps = capabilities.?.array.items;
            if (caps.len != 3 or !std.mem.eql(u8, caps[2].string, "rex")) return false;
        }
        for (hosts[0..i]) |other| {
            if (std.mem.eql(u8, host.object.get("machineId").?.string, other.object.get("machineId").?.string) or
                std.mem.eql(u8, peer.object.get("nodeId").?.string, other.object.get("peer").?.object.get("nodeId").?.string)) return false;
        }
    }
    return true;
}
pub fn validHello(value: std.json.Value) bool {
    if (!wire.validRemoteWorkerHello(value) or !ordered(value.object.get("capabilities").?)) return false;
    if (value.object.get("rexClient")) |client| if (!validRexClient(client) or value.object.get("capabilities").?.array.items.len != 3) return false;
    return true;
}

// Borrowed registered configuration, owned connection slots. The network owner
// must serialize access. These slots are not Pi task states or an effect queue.
pub const Gate = struct {
    registry: wire.RemoteRegistry,
    slots: [64]Slot = @splat(.{}),
    boot_nonce: [32]u8,
    counter: u64 = 0,
    const Slot = struct { phase: enum { offline, challenged, connected } = .offline, connection: [64]u8 = @splat(0) };
    pub const Ticket = struct { index: usize, connection: [64]u8 };

    pub fn init(io: std.Io, registry: wire.RemoteRegistry) Gate {
        // Caller must validate registry before decoding and retain its storage.
        std.debug.assert(registry.hosts.len <= 64);
        var boot_nonce: [32]u8 = undefined;
        io.random(&boot_nonce);
        return .{ .registry = registry, .boot_nonce = boot_nonce };
    }
    pub fn host(self: *const Gate, peer: wire.TailPeer, machine: []const u8) ?usize {
        for (self.registry.hosts, 0..) |registered, i| {
            if (std.mem.eql(u8, registered.machineId, machine) and samePeer(registered.peer, peer)) return i;
        }
        return null;
    }
    pub fn client(self: *const Gate, peer: wire.TailPeer) bool {
        for (self.registry.hosts) |registered| if (registered.client and samePeer(registered.peer, peer)) return true;
        return false;
    }
    pub fn challenge(self: *Gate, peer: wire.TailPeer, machine: []const u8) !Ticket {
        const i = self.host(peer, machine) orelse return error.UnregisteredPeer;
        if (self.registry.hosts[i].implementation == null) return error.WorkerNotRegistered;
        if (self.slots[i].phase != .offline) return error.ConnectionBusy;
        self.counter = std.math.add(u64, self.counter, 1) catch return error.GenerationExhausted;
        var hash = std.crypto.hash.sha2.Sha256.init(.{});
        hash.update(&self.boot_nonce);
        var count: [8]u8 = undefined;
        std.mem.writeInt(u64, &count, self.counter, .big);
        hash.update(&count);
        hash.update(machine);
        const connection = std.fmt.bytesToHex(hash.finalResult(), .lower);
        self.slots[i] = .{ .phase = .challenged, .connection = connection };
        return .{ .index = i, .connection = connection };
    }
    fn matches(self: *const Gate, ticket: Ticket) bool {
        return ticket.index < self.registry.hosts.len and std.mem.eql(u8, &self.slots[ticket.index].connection, &ticket.connection);
    }
    pub fn accept(self: *Gate, peer: wire.TailPeer, ticket: Ticket, hello: wire.RemoteWorkerHello) !void {
        // The peer argument must come from the local verifier for THIS socket,
        // never a hello/header, saved label, prior sample or caller-supplied flag.
        errdefer _ = self.disconnect(ticket);
        if (!self.matches(ticket) or self.slots[ticket.index].phase != .challenged) return error.StaleConnection;
        const registered = self.registry.hosts[ticket.index];
        if (hello.version != 1 or !samePeer(registered.peer, peer) or !std.mem.eql(u8, self.registry.hubId, hello.hubId) or
            !std.mem.eql(u8, registered.machineId, hello.machineId) or !std.mem.eql(u8, &ticket.connection, hello.connectionId) or
            !std.mem.eql(u8, registered.implementation.?, hello.implementation) or
            !std.mem.eql(wire.WorkerCapability, registered.capabilities.?, hello.capabilities) or !sameRexClient(registered.rexClient, hello.rexClient)) return error.IdentityMismatch;
        self.slots[ticket.index].phase = .connected;
    }
    pub fn connected(self: *const Gate, ticket: Ticket) bool {
        return self.matches(ticket) and self.slots[ticket.index].phase == .connected;
    }
    pub fn disconnect(self: *Gate, ticket: Ticket) bool {
        // Late cleanup cannot close a replacement or make it appear offline.
        if (!self.matches(ticket) or self.slots[ticket.index].phase == .offline) return false;
        self.slots[ticket.index].phase = .offline;
        return true;
    }
};
pub fn samePeer(a: wire.TailPeer, b: wire.TailPeer) bool {
    return std.mem.eql(u8, a.nodeId, b.nodeId) and std.mem.eql(u8, a.userId, b.userId);
}
