const std = @import("std");
const wire = @import("generated/contracts.zig");
const trust = @import("remote_contracts.zig");
pub fn valid(plan: wire.WorkerHandoffPlan) bool {
    return std.fs.path.isAbsolute(plan.client.executable) and std.fs.path.isAbsolute(plan.beforeClient.executable) and std.mem.indexOfAny(u8, plan.client.executable, "\x00\r\n") == null and plan.client.socket.len <= 100 and std.mem.eql(u8, plan.client.socket, plan.beforeClient.socket) and (!std.mem.eql(u8, plan.implementation, plan.beforeImplementation) or !trust.sameRexClient(plan.client, plan.beforeClient));
}
pub fn same(left: wire.WorkerHandoffPlan, right: wire.WorkerHandoffPlan) bool {
    return std.mem.eql(u8, left.id, right.id) and std.mem.eql(u8, left.hubId, right.hubId) and std.mem.eql(u8, left.machineId, right.machineId) and std.mem.eql(u8, left.beforeImplementation, right.beforeImplementation) and std.mem.eql(u8, left.implementation, right.implementation) and trust.sameRexClient(left.beforeClient, right.beforeClient) and trust.sameRexClient(left.client, right.client);
}
pub fn matches(reg: wire.RexWorkerRegistration, plan: wire.WorkerHandoffPlan, after: bool) bool {
    return reg.hubId != null and std.mem.eql(u8, reg.hubId.?, plan.hubId) and std.mem.eql(u8, reg.machineId, plan.machineId) and std.mem.eql(u8, reg.implementation, if (after) plan.implementation else plan.beforeImplementation) and trust.sameRexClient(reg.rexClient, if (after) plan.client else plan.beforeClient) and std.mem.eql(wire.WorkerCapability, reg.capabilities, &.{ .files, .bash, .rex, .launcher });
}
pub fn hash(a: std.mem.Allocator, plan: wire.WorkerHandoffPlan) ![64]u8 {
    const bytes = try std.json.Stringify.valueAlloc(a, plan, .{});
    defer a.free(bytes);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}
pub fn replacement(a: std.mem.Allocator, old: wire.RexWorkerRegistration, plan: wire.WorkerHandoffPlan) !wire.RexWorkerRegistration {
    if (!valid(plan) or !matches(old, plan, false)) return error.InvalidHandoff;
    var previous: std.ArrayList(wire.WorkerRexClient) = .empty;
    if (!std.mem.eql(u8, old.rexClient.executable, plan.client.executable)) try previous.append(a, old.rexClient);
    for (old.previousClients orelse &.{}) |client| if (!std.mem.eql(u8, client.executable, plan.client.executable)) {
        try previous.append(a, client);
    };
    if (previous.items.len > 8) return error.HandoffHistoryFull;
    var next = old;
    next.implementation = plan.implementation;
    next.rexClient = plan.client;
    next.previousClients = try previous.toOwnedSlice(a);
    next.upgradeId = plan.id;
    next.upgradeHash = try a.dupe(u8, &try hash(a, plan));
    return next;
}
