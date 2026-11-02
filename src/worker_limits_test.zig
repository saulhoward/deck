const std = @import("std");
const worker = @import("worker.zig");

fn invoke(allocator: std.mem.Allocator, journal: std.fs.Dir, cwd: []const u8, id: []const u8, op: []const u8, args: anytype) !std.json.Value {
    const body = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = id, .machineId = "local", .cwd = cwd, .operation = op, .args = args }, .{});
    return (try std.json.parseFromSlice(std.json.Value, allocator, try worker.operation(allocator, journal, "local", body), .{})).value.object.get("result").?;
}

test "native file tools bound data, reject ambiguous edits, binary and non-regular reads" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try tmp.dir.realpathAlloc(allocator, ".");
    try tmp.dir.makeDir("ops");
    var journal = try tmp.dir.openDir("ops", .{});
    defer journal.close();
    try tmp.dir.writeFile(.{ .sub_path = "text.txt", .data = "repeat repeat" });
    const ambiguous = try invoke(allocator, journal, cwd, "1", "edit", .{ .path = "text.txt", .oldText = "repeat", .newText = "changed" });
    try std.testing.expectEqualStrings("conflict", ambiguous.object.get("code").?.string);
    const large = try allocator.alloc(u8, 129 * 1024);
    @memset(large, 'x');
    try std.testing.expect(!(try invoke(allocator, journal, cwd, "2", "write", .{ .path = "text.txt", .content = large })).object.get("ok").?.bool);
    try std.testing.expectEqualStrings("repeat repeat", try tmp.dir.readFileAlloc(allocator, "text.txt", 1024));
    try tmp.dir.writeFile(.{ .sub_path = "binary.dat", .data = "\xff\xfe" });
    try std.testing.expect(!(try invoke(allocator, journal, cwd, "3", "read", .{ .path = "binary.dat" })).object.get("ok").?.bool);
    try std.testing.expect(!(try invoke(allocator, journal, cwd, "4", "read", .{ .path = "/dev/null" })).object.get("ok").?.bool);
}
