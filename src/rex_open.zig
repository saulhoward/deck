const std = @import("std");
const contracts = @import("generated/contracts.zig");
const V = std.json.Value;
fn field(value: V, key: []const u8) V {
    return if (value == .object) value.object.get(key) orelse .null else .null;
}
fn equal(a: V, b: V) bool {
    return a == .string and b == .string and std.mem.eql(u8, a.string, b.string);
}
fn is(value: V, text: []const u8) bool {
    return equal(value, .{ .string = text });
}
fn safeId(value: V) bool {
    return contracts.validPiId(value) and (std.fmt.parseInt(u64, value.string, 10) catch return false) <= 9007199254740991;
}
fn number(value: V) f64 {
    return if (value == .integer) @floatFromInt(value.integer) else value.float;
}
pub fn validArgs(command: []const u8, args: V) bool {
    if (std.mem.eql(u8, command, "rex_open")) {
        if (!contracts.validRexOpenArgs(args) or !safeId(field(args, "chatId"))) return false;
        if (args.object.get("target")) |target| {
            if (target.object.get("executable")) |exe| {
                if (exe.string.len > 4096 or exe.string[0] != '/' or std.mem.indexOfScalar(u8, exe.string, 0) != null) return false;
            }
            if (target.object.get("server")) |server| {
                if (!@import("rex_endpoint.zig").valid(server.string)) return false;
            }
        }
        return true;
    }
    if (std.mem.eql(u8, command, "rex_status") or std.mem.eql(u8, command, "rex_inspect")) return contracts.validRexReadArgs(args) and safeId(field(args, "chatId"));
    return true;
}
pub fn validReply(command: []const u8, args: V, hub_id: V, result: V) bool {
    if (!std.mem.eql(u8, command, "rex_open") and !std.mem.eql(u8, command, "rex_status") and !std.mem.eql(u8, command, "rex_inspect")) return true;
    if (!contracts.validRexUuid(hub_id) or !validArgs(command, args) or !equal(field(args, "chatId"), field(result, "chatId"))) return false;
    if (std.mem.eql(u8, command, "rex_open")) return contracts.validRexOpenAck(result) and equal(field(args, "requestId"), field(result, "requestId")) and safeId(field(result, "taskId"));
    if (!equal(field(result, "hubId"), hub_id)) return false;
    const task_id = field(result, "taskId");
    if (task_id != .null and !safeId(task_id)) return false;
    if (std.mem.eql(u8, command, "rex_inspect")) {
        if (!contracts.validRexInspectionSnapshot(result) or number(field(result, "finishedAtMs")) < number(field(result, "startedAtMs"))) return false;
        const observation = field(result, "observation");
        return is(field(result, "status"), "sampled") == (observation != .null) and (observation == .null or is(field(observation, "state"), "exited") == (field(observation, "exitCode") != .null));
    }
    if (!contracts.validRexStatusSnapshot(result) or is(field(result, "status"), "unallocated") != (task_id == .null)) return false;
    const binding = field(result, "binding");
    if (is(field(result, "status"), "allocated") and binding == .null) return false;
    for ([_]V{ binding, field(result, "previousBinding") }) |item| {
        if (item != .null and (!equal(field(item, "chatId"), field(args, "chatId")) or !equal(field(item, "hubId"), hub_id) or !safeId(field(item, "taskId")))) return false;
    }
    return binding == .null or equal(field(binding, "taskId"), task_id);
}

test "public Rex semantic fixtures" {
    const parsed = try std.json.parseFromSlice(V, std.testing.allocator, @embedFile("rex_open.test.json"), .{ .allocate = .alloc_always });
    defer parsed.deinit();
    for (parsed.value.array.items) |fixture| {
        const actual = validReply(field(fixture, "command").string, field(fixture, "args"), field(fixture, "hubId"), field(fixture, "result"));
        if (actual != field(fixture, "valid").bool) std.debug.print("Rex fixture: {s}\n", .{field(fixture, "name").string});
        try std.testing.expectEqual(field(fixture, "valid").bool, actual);
    }
}
