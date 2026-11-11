const std = @import("std");
const wire = @import("generated/contracts.zig");
const boundary = @import("remote_contracts.zig");
const tailscale = @import("tailscale.zig");

test "shared remote registration and handshake claims reject identity drift" {
    const a = std.testing.allocator;
    const fixtures = try std.json.parseFromSlice(std.json.Value, a, @embedFile("remote.test.json"), .{});
    defer fixtures.deinit();
    for (fixtures.value.object.get("cases").?.array.items) |case| {
        const kind = case.object.get("kind").?.string;
        const bytes = try std.json.Stringify.valueAlloc(a, fixtures.value.object.get("bases").?.object.get(kind).?, .{});
        defer a.free(bytes);
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const allocator = arena.allocator();
        const parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
        var value = parsed.value;
        if (case.object.get("path")) |path| {
            var target = &value;
            const keys = path.array.items;
            for (keys[0 .. keys.len - 1]) |key| {
                target = if (key == .integer) &target.array.items[@intCast(key.integer)] else target.object.getPtr(key.string).?;
            }
            const last = keys[keys.len - 1].string;
            if (case.object.get("remove") != null) {
                _ = target.object.swapRemove(last);
            } else try target.object.put(allocator, last, case.object.get("value").?);
        }
        const actual = if (std.mem.eql(u8, kind, "peer")) boundary.validPeer(value) else if (std.mem.eql(u8, kind, "registry")) boundary.validRegistry(value) else boundary.validHello(value);
        if (actual != case.object.get("valid").?.bool) {
            std.debug.print("Remote fixture: {s}\n", .{case.object.get("name").?.string});
            return error.InvalidRemoteBoundary;
        }
    }
}

test "native connection gate isolates hosts and fences stale replies and cleanup" {
    const a = std.testing.allocator;
    const fixtures = try std.json.parseFromSlice(std.json.Value, a, @embedFile("remote.test.json"), .{});
    defer fixtures.deinit();
    const bytes = try std.json.Stringify.valueAlloc(a, fixtures.value.object.get("bases").?.object.get("registry").?, .{});
    defer a.free(bytes);
    const parsed = try wire.parseRemoteRegistry(a, bytes);
    defer parsed.deinit();
    var other = parsed.value.hosts[0];
    other.machineId = "dddddddddddddddddddddddddddddddd";
    other.peer.nodeId = "nOther";
    other.client = false;
    const hosts = [_]wire.RemoteHost{ parsed.value.hosts[0], other };
    var registry = parsed.value;
    registry.hosts = &hosts;
    var gate = boundary.Gate.init(std.testing.io, registry);
    const host = hosts[0];
    try std.testing.expect(gate.client(host.peer));
    try std.testing.expect(!gate.client(other.peer));
    try std.testing.expectError(error.UnregisteredPeer, gate.challenge(other.peer, host.machineId));
    const first = try gate.challenge(host.peer, host.machineId);
    var hello: wire.RemoteWorkerHello = .{ .version = 1, .hubId = registry.hubId, .machineId = host.machineId, .connectionId = &first.connection, .implementation = host.implementation.?, .capabilities = host.capabilities.? };
    try std.testing.expect(!gate.connected(first));
    try gate.accept(host.peer, first, hello);
    try std.testing.expect(gate.connected(first));
    try std.testing.expectError(error.ConnectionBusy, gate.challenge(host.peer, host.machineId));
    const independent = try gate.challenge(other.peer, other.machineId);
    try gate.accept(other.peer, independent, .{ .version = 1, .hubId = registry.hubId, .machineId = other.machineId, .connectionId = &independent.connection, .implementation = other.implementation.?, .capabilities = other.capabilities.? });
    try std.testing.expect(gate.disconnect(first));
    const second = try gate.challenge(host.peer, host.machineId);
    try std.testing.expect(!std.mem.eql(u8, &first.connection, &second.connection));
    hello.connectionId = &second.connection;
    try gate.accept(host.peer, second, hello);
    try std.testing.expect(!gate.connected(first));
    try std.testing.expect(!gate.disconnect(first));
    try std.testing.expectError(error.StaleConnection, gate.accept(host.peer, first, hello));
    try std.testing.expect(gate.connected(second));
    try std.testing.expect(gate.connected(independent));
    // Duplicate startup fences only that current connection.
    try std.testing.expectError(error.StaleConnection, gate.accept(host.peer, second, hello));
    try std.testing.expect(!gate.connected(second));
    try std.testing.expect(gate.connected(independent));
    for (0..6) |change| {
        const ticket = try gate.challenge(host.peer, host.machineId);
        hello = .{ .version = 1, .hubId = registry.hubId, .machineId = host.machineId, .connectionId = &ticket.connection, .implementation = host.implementation.?, .capabilities = host.capabilities.? };
        var peer = host.peer;
        switch (change) {
            0 => hello.hubId = "wrong-hub",
            1 => hello.machineId = other.machineId,
            2 => peer.userId = "1",
            3 => hello.implementation = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            4 => hello.capabilities = &.{.files},
            else => hello.version = 2,
        }
        try std.testing.expectError(error.IdentityMismatch, gate.accept(peer, ticket, hello));
        try std.testing.expect(!gate.connected(ticket));
    }
    var restarted = boundary.Gate.init(std.testing.io, registry);
    const fresh = try restarted.challenge(host.peer, host.machineId);
    try std.testing.expect(!std.mem.eql(u8, &fresh.connection, &first.connection));
    try std.testing.expect(!restarted.connected(first));
    try std.testing.expect(gate.connected(independent));
}

test "tailscale verifier accepts only literal direct-node endpoints" {
    for ([_][]const u8{ "127.0.0.1:1", "100.64.0.1:0", "100.64.0.1", "100.128.0.1:52800", "example.ts.net:52800", "[::1]:1", "[::ffff:100.64.0.1]:1", "[fd7a:115c:a1e0::1%1]:1", "100.64.0.1:1\n" }) |raw| try std.testing.expectError(error.InvalidPeerAddress, tailscale.endpoint(raw));
    _ = try tailscale.endpoint("100.64.0.1:52800");
    _ = try tailscale.endpoint("[fd7a:115c:a1e0::1]:52800");
}

test "whois projection checks address, authorization, expiry and exact u64 owner" {
    const a = std.testing.allocator;
    const address = try tailscale.endpoint("100.64.0.1:52800");
    const prefix = "{\"Node\":{\"StableID\":\"nPeer\",\"User\":18446744073709551615,\"MachineAuthorized\":true,\"Addresses\":[\"100.64.0.1/32\"],\"KeyExpiry\":\"2099-01-01T00:00:00Z\"},\"UserProfile\":{\"ID\":18446744073709551615}}";
    const valid = try tailscale.parseWhois(a, prefix, address, 1700000000);
    defer valid.deinit();
    try std.testing.expectEqualStrings("18446744073709551615", valid.value.userId);
    // Real peer responses omit this legacy omitempty field. The identity still
    // must match an explicit registration; this projection alone grants nothing.
    const omitted = "\"MachineAuthorized\":true,";
    const at = std.mem.indexOf(u8, prefix, omitted).?;
    const bytes_without_flag = try std.mem.concat(a, u8, &.{ prefix[0..at], prefix[at + omitted.len ..] });
    defer a.free(bytes_without_flag);
    const remote_peer = try tailscale.parseWhois(a, bytes_without_flag, address, 1700000000);
    defer remote_peer.deinit();
    try std.testing.expectEqualStrings(valid.value.nodeId, remote_peer.value.nodeId);
    try std.testing.expectEqualStrings(valid.value.userId, remote_peer.value.userId);
    const fixtures = [_]struct { before: []const u8, after: []const u8 }{
        .{ .before = "nPeer", .after = "worker.example" },
        .{ .before = "\"ID\":18446744073709551615", .after = "\"ID\":1" },
        .{ .before = "true", .after = "false" },
        .{ .before = "100.64.0.1/32", .after = "100.64.0.2/32" },
        .{ .before = "100.64.0.1/32", .after = "100.64.0.1/10" },
        .{ .before = "2099-01-01", .after = "2020-01-01" },
        .{ .before = "2099-01-01", .after = "2099-02-29" },
        .{ .before = "2099-01-01", .after = "2099-13-01" },
        .{ .before = "00:00:00Z", .after = "00:00:00+00:00" },
        .{ .before = "\"MachineAuthorized\":true", .after = "\"MachineAuthorized\":\"true\"" },
        .{ .before = "\"Node\":", .after = "\"Node\":{},\"Node\":" },
    };
    for (fixtures) |case| {
        const start = std.mem.indexOf(u8, prefix, case.before).?;
        const bytes = try std.mem.concat(a, u8, &.{ prefix[0..start], case.after, prefix[start + case.before.len ..] });
        defer a.free(bytes);
        if (tailscale.parseWhois(a, bytes, address, 1700000000)) |unexpected| {
            unexpected.deinit();
            return error.AcceptedInvalidPeer;
        } else |_| {}
    }
}

test "local Tailscale backend must be running with a valid direct-node identity" {
    const a = std.testing.allocator;
    const good = "{\"BackendState\":\"Running\",\"Self\":{\"ID\":\"nLocal\",\"UserID\":18446744073709551615,\"TailscaleIPs\":[\"100.64.0.2\",\"fd7a:115c:a1e0::2\"]}}";
    try tailscale.checkLocalStatus(a, good);
    for ([_]struct { before: []const u8, after: []const u8 }{
        .{ .before = "Running", .after = "Stopped" },
        .{ .before = "Running", .after = "NeedsLogin" },
        .{ .before = "Running", .after = "NeedsMachineAuth" },
        .{ .before = "Running", .after = "Starting" },
        .{ .before = "nLocal", .after = "local.example.ts.net" },
        .{ .before = "18446744073709551615", .after = "18446744073709551616" },
        .{ .before = "18446744073709551615", .after = "\"18446744073709551615\"" },
        .{ .before = "100.64.0.2", .after = "127.0.0.1" },
        .{ .before = "\"ID\":\"nLocal\"", .after = "\"ID\":null" },
    }) |case| {
        const at = std.mem.indexOf(u8, good, case.before).?;
        const raw = try std.mem.concat(a, u8, &.{ good[0..at], case.after, good[at + case.before.len ..] });
        defer a.free(raw);
        if (tailscale.checkLocalStatus(a, raw)) |_| return error.AcceptedInvalidLocalStatus else |_| {}
    }
    try std.testing.expectError(error.InvalidPeerEvidence, tailscale.checkLocalStatus(a, "{\"BackendState\":\"Running\",\"Self\":null}"));
}
