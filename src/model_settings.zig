const std = @import("std");
const wire = @import("generated/contracts.zig");
fn is(command: []const u8, value: []const u8) bool {
    return std.mem.eql(u8, command, value);
}
fn safeId(value: std.json.Value) bool {
    if (!wire.validPiId(value)) return false;
    return (std.fmt.parseInt(u64, value.string, 10) catch return false) <= 9007199254740991;
}
fn eq(a: std.json.Value, b: std.json.Value, field: []const u8) bool {
    return std.mem.eql(u8, a.object.get(field).?.string, b.object.get(field).?.string);
}
fn same(a: std.json.Value, b: std.json.Value) bool {
    return eq(a, b, "provider") and eq(a, b, "modelId");
}
fn rank(value: std.json.Value) usize {
    for ([_][]const u8{ "off", "minimal", "low", "medium", "high", "xhigh", "max" }, 0..) |level, i| if (is(value.string, level)) return i;
    unreachable;
}
pub fn validArgs(command: []const u8, args: std.json.Value) bool {
    if (is(command, "model_settings")) return wire.validModelSettingsArgs(args) and safeId(args.object.get("chatId").?);
    if (is(command, "set_model_settings")) return wire.validSetModelSettingsArgs(args) and safeId(args.object.get("chatId").?);
    return true;
}
pub fn validSnapshot(value: std.json.Value) bool {
    if (!wire.validModelSettingsSnapshot(value) or !safeId(value.object.get("chatId").?)) return false;
    const models = value.object.get("models").?.array.items;
    for (models, 0..) |model, i| {
        for (models[0..i]) |other| if (same(model, other)) return false;
        const levels = model.object.get("thinkingLevels").?.array.items;
        var found = false;
        for (levels, 0..) |level, j| {
            if (j > 0 and rank(level) <= rank(levels[j - 1])) return false;
            if (is(level.string, model.object.get("defaultThinkingLevel").?.string)) found = true;
        }
        if (!found) return false;
    }
    return true;
}
pub fn validReply(command: []const u8, args: std.json.Value, hub: ?std.json.Value, result: std.json.Value) bool {
    if (!is(command, "model_settings") and !is(command, "set_model_settings")) return true;
    const expected_hub = hub orelse return false;
    if (!wire.validTransportId(expected_hub) or !validArgs(command, args)) return false;
    if (is(command, "model_settings")) {
        if (!validSnapshot(result)) return false;
    } else {
        if (!wire.validModelSettingsAck(result)) return false;
        const selection = result.object.get("selection").?;
        const expected = args.object.get("selection").?;
        if (!same(selection, expected) or !eq(selection, expected, "thinkingLevel")) return false;
    }
    return is(expected_hub.string, result.object.get("hubId").?.string) and eq(args, result, "chatId");
}

test "model settings fixtures preserve scope, catalog consistency and exact selection ACKs" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixtures = (try std.json.parseFromSlice(std.json.Value, a, @embedFile("model_settings.test.json"), .{})).value;
    for (fixtures.object.get("cases").?.array.items) |fixture| {
        const encoded = try std.json.Stringify.valueAlloc(a, fixtures.object.get(fixture.object.get("base").?.string).?, .{});
        var value = (try std.json.parseFromSlice(std.json.Value, a, encoded, .{})).value;
        if (fixture.object.get("set")) |patch| {
            var it = patch.object.iterator();
            while (it.next()) |entry| try value.object.put(a, entry.key_ptr.*, entry.value_ptr.*);
        }
        if (fixture.object.get("result")) |patch| {
            var result = value.object.getPtr("result").?;
            var it = patch.object.iterator();
            while (it.next()) |entry| try result.object.put(a, entry.key_ptr.*, entry.value_ptr.*);
        }
        std.testing.expectEqual(fixture.object.get("valid").?.bool, validReply(value.object.get("command").?.string, value.object.get("args").?, value.object.get("hubId"), value.object.get("result").?)) catch |err| {
            std.debug.print("settings fixture: {s}\n", .{fixture.object.get("name").?.string});
            return err;
        };
    }
}
