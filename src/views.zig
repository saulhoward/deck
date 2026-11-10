const std = @import("std");
const wire = @import("generated/contracts.zig");

fn safeId(value: std.json.Value) bool {
    return wire.validPiId(value) and (std.fmt.parseInt(u64, value.string, 10) catch return false) <= 9007199254740991;
}
fn same(actual: std.json.Value, expected: ?std.json.Value) bool {
    return safeId(actual) and (if (expected) |id| safeId(id) and std.mem.eql(u8, actual.string, id.string) else true);
}
fn unitsWithin(value: std.json.Value, maximum: usize) bool {
    const view = std.unicode.Utf8View.init(value.string) catch return false;
    var it = view.iterator();
    var units: usize = 0;
    while (it.nextCodepoint()) |point| {
        units += if (point > 0xffff) @as(usize, 2) else 1;
        if (units > maximum) return false;
    }
    return true;
}
fn liveArgs(args: std.json.Value) bool {
    if (args == .null) return true; // Legacy omitted/null envelope args default.
    if (!wire.validLiveViewArgs(args)) return false;
    return if (args.object.get("chatId")) |id| safeId(id) else true;
}
fn instructionArgs(args: std.json.Value) bool {
    if (args == .null) return true;
    if (!wire.validInstructionStatusArgs(args)) return false;
    if (args.object.get("chatId")) |id| if (!safeId(id)) return false;
    if (args.object.get("taskId")) |id| if (!safeId(id)) return false;
    return true;
}
fn activity(value: std.json.Value, chat: ?std.json.Value) bool {
    if (!wire.validActivitySnapshot(value) or !same(value.object.get("chatId").?, chat)) return false;
    if (value.object.get("runTaskId")) |id| if (!safeId(id)) return false;
    for (value.object.get("tools").?.array.items) |tool| {
        if (!unitsWithin(tool.object.get("callId").?, 128) or !unitsWithin(tool.object.get("name").?, 80)) return false;
        if (tool.object.get("taskId")) |id| if (!safeId(id)) return false;
    }
    return true;
}
fn progress(value: std.json.Value, chat: ?std.json.Value) bool {
    if (!wire.validProgressSnapshot(value) or !same(value.object.get("chatId").?, chat)) return false;
    const run = value.object.get("runTaskId");
    if (run) |id| if (!safeId(id)) return false;
    if (run == null and (value.object.contains("generation") or value.object.contains("tools") or value.object.contains("toolSlotsOmitted"))) return false;
    if (value.object.get("generation")) |generation| if (!unitsWithin(generation.object.get("text").?, 2048)) return false;
    if (value.object.get("tools")) |tools| {
        for (tools.array.items) |tool| {
            if (!safeId(tool.object.get("taskId").?) or !unitsWithin(tool.object.get("text").?, 512)) return false;
        }
    }
    return true;
}
fn source(value: std.json.Value) bool {
    if (!wire.validInstructionSourceView(value) or !safeId(value.object.get("taskId").?)) return false;
    const cwd = value.object.get("cwd").?;
    return std.mem.startsWith(u8, cwd.string, "/") and unitsWithin(cwd, 256) and unitsWithin(value.object.get("machineId").?, 80);
}
fn instructionTask(value: std.json.Value) bool {
    if (!wire.validInstructionTaskView(value) or !safeId(value.object.get("taskId").?)) return false;
    const outcome = value.object.get("outcome");
    const result = value.object.get("result");
    const omitted = value.object.contains("resultOmitted");
    if (!std.mem.eql(u8, value.object.get("state").?.string, "terminal")) return outcome == null and result == null and !omitted;
    if (outcome == null) return false;
    if (!std.mem.eql(u8, outcome.?.string, "completed")) return result == null and !omitted;
    if ((result != null) == omitted) return false;
    if (result) |record| {
        if (std.mem.eql(u8, record.object.get("status").?.string, "applied")) {
            const applied = record.object.get("source").?;
            return source(applied) and same(applied.object.get("taskId").?, value.object.get("taskId"));
        }
    }
    return true;
}
fn instructions(value: std.json.Value, chat: ?std.json.Value, task: ?std.json.Value) bool {
    if (!wire.validInstructionSnapshot(value) or !same(value.object.get("chatId").?, chat)) return false;
    const current = value.object.get("source").?;
    if (current != .null and !source(current)) return false;
    if (value.object.contains("sourceOmitted") and current != .null) return false;
    const imported = value.object.get("import").?;
    if (imported != .null and !instructionTask(imported)) return false;
    if (task) |id| if (imported == .null or !same(imported.object.get("taskId").?, id)) return false;
    return true;
}
test "live view semantics and UTF-16 limits agree with TypeScript" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixtures = try std.json.parseFromSlice(std.json.Value, allocator, @embedFile("views.test.json"), .{});
    for (fixtures.value.array.items) |fixture| {
        var result = fixture.object.get("result").?;
        if (fixture.object.get("repeat")) |repeat| {
            const path = repeat.object.get("path").?.array.items;
            var target = &result;
            for (path[0 .. path.len - 1]) |key| target = target.object.getPtr(key.string).?;
            const text = repeat.object.get("text").?.string;
            const count: usize = @intCast(repeat.object.get("count").?.integer);
            const repeated = try allocator.alloc(u8, text.len * count);
            for (0..count) |index| @memcpy(repeated[index * text.len ..][0..text.len], text);
            try target.object.put(path[path.len - 1].string, .{ .string = repeated });
        }
        const command = fixture.object.get("command").?.string;
        const args = fixture.object.get("args").?;
        const actual = if (std.mem.eql(u8, command, "history")) wire.validHistoryArgs(args) and wire.validHistoryPage(result) and validAttachments(args, result) else validReply(command, args, result);
        if (actual != fixture.object.get("valid").?.bool) {
            std.debug.print("view fixture failed: {s}\n", .{fixture.object.get("name").?.string});
            return error.InvalidViewContract;
        }
    }
}
pub fn validReply(command: []const u8, args: std.json.Value, result: std.json.Value) bool {
    if (std.mem.eql(u8, command, "activity") or std.mem.eql(u8, command, "progress")) {
        if (!liveArgs(args)) return false;
        const chat = if (args == .object) args.object.get("chatId") else null;
        return if (std.mem.eql(u8, command, "activity")) activity(result, chat) else progress(result, chat);
    }
    if (std.mem.eql(u8, command, "instruction_status")) {
        if (!instructionArgs(args)) return false;
        return instructions(result, if (args == .object) args.object.get("chatId") else null, if (args == .object) args.object.get("taskId") else null);
    }
    return true;
}
// Called only after generated history args/page validation. Do not allow an
// unrequested, wrong-chat or malformed attachment to advance canonical cursors.
pub fn validAttachments(args: std.json.Value, page: std.json.Value) bool {
    const chat = args.object.get("chatId");
    if (page.object.get("activity")) |value| {
        if (!(args.object.get("includeActivity") orelse return false).bool or !activity(value, chat)) return false;
    }
    if (page.object.get("progress")) |value| {
        if (!(args.object.get("includeProgress") orelse return false).bool or !progress(value, chat)) return false;
    }
    if (page.object.get("instructions")) |value| {
        if (!(args.object.get("includeInstructions") orelse return false).bool or !instructions(value, chat, null)) return false;
    }
    return true;
}
