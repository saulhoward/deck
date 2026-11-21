//! Hub-owned automatic-worker pins and control custody. Caller owns the hub
//! writer lock. A released plan is retry evidence, not an admission/route lock.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const handoff = @import("handoff_contracts.zig");

pub fn active(state: wire.WorkerHandoffState) bool {
    return switch (state.phase) {
        .prepared, .committed => true,
        .free_old, .free_new => false,
    };
}

/// The result borrows the caller's arena, including the original string bytes.
pub fn load(native: Native, arena: std.mem.Allocator, state_path: []const u8, local_machine: []const u8) !wire.RexWorkerRegistry {
    const path = try std.fs.path.join(arena, &.{ state_path, "rex-workers.json" });
    const bytes = @import("mcp_profiles.zig").readPrivate(native, arena, path, 64 * 1024) catch |err| switch (err) {
        error.FileNotFound => return .{ .version = 1, .hosts = &.{} },
        else => return err,
    };
    const registry = (try wire.parseRexWorkerRegistry(arena, bytes)).value;
    if (registry.hosts.len > 0 and registry.hubId == null) return error.InvalidWorkerRegistration;
    const raw = (try std.json.parseFromSlice(std.json.Value, arena, bytes, .{})).value;
    for (raw.object.get("hosts").?.array.items, registry.hosts, 0..) |value, host, index| {
        if (!@import("remote_contracts.zig").validRexRegistration(value) or std.mem.eql(u8, host.machineId, local_machine) or host.hubId == null or !std.mem.eql(u8, host.hubId.?, registry.hubId.?)) return error.InvalidWorkerRegistration;
        for (registry.hosts[0..index]) |prior| if (std.mem.eql(u8, prior.machineId, host.machineId)) return error.InvalidWorkerRegistration;
    }
    const states = registry.handoffs orelse &.{};
    for (states, 0..) |state, i| {
        if (!handoff.valid(state.plan)) return error.InvalidHandoff;
        for (states[0..i]) |prior| if (std.mem.eql(u8, prior.plan.machineId, state.plan.machineId)) return error.InvalidHandoff;
        const after = state.phase == .committed or state.phase == .free_new;
        for (registry.hosts) |host| {
            if (!handoff.matches(host, state.plan, after)) continue;
            if (after and (host.upgradeId == null or !std.mem.eql(u8, host.upgradeId.?, state.plan.id) or host.upgradeHash == null or !std.mem.eql(u8, host.upgradeHash.?, &try handoff.hash(arena, state.plan)))) return error.InvalidHandoff;
            break;
        } else return error.InvalidHandoff;
    }
    return registry;
}

/// Publish only AFTER Pi's discard transaction has committed, before admitting
/// any new work. Do not drop the evidence an offline worker needs to finish a
/// lost control ACK, or change current pins, sockets, capabilities or receipts.
pub fn release(native: Native, arena: std.mem.Allocator, dir: std.Io.Dir, registry: wire.RexWorkerRegistry) !usize {
    const states = try arena.dupe(wire.WorkerHandoffState, registry.handoffs orelse return 0);
    var count: usize = 0;
    for (states) |*state| {
        state.phase = switch (state.phase) {
            .prepared => .free_old,
            .committed => .free_new,
            .free_old, .free_new => continue,
        };
        count += 1;
    }
    if (count > 0) {
        var updated = registry;
        updated.handoffs = states;
        try @import("private_store.zig").save(native, arena, dir, "rex-workers.json", updated);
    } else if (states.len > 0) {
        // Retry after a successful rename but unconfirmed directory fsync.
        try Native.syncDirectory(native.io, dir);
    }
    return count;
}
