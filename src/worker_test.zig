const std = @import("std");
const worker = @import("worker.zig");

fn call(allocator: std.mem.Allocator, journal: std.fs.Dir, body: []const u8) !std.json.Value {
    return (try std.json.parseFromSlice(std.json.Value, allocator, try worker.operation(allocator, journal, "local", body), .{})).value.object.get("result").?;
}

test "native files preserve host affinity, return retained receipts and never reissue uncertain effects" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try tmp.dir.realpathAlloc(allocator, ".");
    try tmp.dir.makeDir("ops");
    var journal = try tmp.dir.openDir("ops", .{});
    defer journal.close();
    const body = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "1", .machineId = "local", .cwd = cwd, .operation = "write", .args = .{ .path = "file.txt", .content = "hello" } }, .{});
    try std.testing.expect((try call(allocator, journal, body)).object.get("ok").?.bool);
    try tmp.dir.writeFile(.{ .sub_path = "file.txt", .data = "external" });
    try std.testing.expect((try call(allocator, journal, body)).object.get("ok").?.bool);
    try std.testing.expectEqualStrings("external", try tmp.dir.readFileAlloc(allocator, "file.txt", 1024));
    const conflict = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "1", .machineId = "local", .cwd = cwd, .operation = "write", .args = .{ .path = "file.txt", .content = "different" } }, .{});
    try std.testing.expectEqualStrings("conflict", (try call(allocator, journal, conflict)).object.get("code").?.string);
    const offline = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "2", .machineId = "remote", .cwd = cwd, .operation = "write", .args = .{ .path = "file.txt", .content = "wrong host" } }, .{});
    try std.testing.expectEqualStrings("offline", (try call(allocator, journal, offline)).object.get("code").?.string);
    const edit = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "3", .machineId = "local", .cwd = cwd, .operation = "edit", .args = .{ .path = "file.txt", .oldText = "external", .newText = "edited" } }, .{});
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(edit, &hash, .{});
    const hex = std.fmt.bytesToHex(hash, .lower);
    const accepted = try std.json.Stringify.valueAlloc(allocator, .{ .hash = hex[0..], .result = null }, .{});
    try journal.writeFile(.{ .sub_path = "3.json", .data = accepted });
    try std.testing.expectEqualStrings("effect_uncertain", (try call(allocator, journal, edit)).object.get("code").?.string);
    try std.testing.expectEqualStrings("external", try tmp.dir.readFileAlloc(allocator, "file.txt", 1024));
    const exact = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "4", .machineId = "local", .cwd = cwd, .operation = "edit", .args = .{ .path = "file.txt", .oldText = "external", .newText = "edited" } }, .{});
    try std.testing.expect((try call(allocator, journal, exact)).object.get("ok").?.bool);
    try std.testing.expectEqualStrings("edited", try tmp.dir.readFileAlloc(allocator, "file.txt", 1024));
    const read = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "5", .machineId = "local", .cwd = cwd, .operation = "read", .args = .{ .path = "file.txt" } }, .{});
    try std.testing.expectEqualStrings("edited", (try call(allocator, journal, read)).object.get("output").?.string);
}
