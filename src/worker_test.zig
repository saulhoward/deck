const std = @import("std");
const worker = @import("worker.zig");
const io = std.testing.io;
const Native = @import("native.zig");

fn call(allocator: std.mem.Allocator, journal: std.Io.Dir, body: []const u8) !std.json.Value {
    return (try std.json.parseFromSlice(std.json.Value, allocator, try worker.operation(Native.testing(), allocator, journal, "local", body), .{})).value.object.get("result").?;
}

test "native files preserve host affinity, return retained receipts and never reissue uncertain effects" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try tmp.dir.realPathFileAlloc(io, ".", allocator);
    try tmp.dir.createDir(io, "ops", .default_dir);
    var journal = try tmp.dir.openDir(io, "ops", .{});
    defer journal.close(io);
    const body = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "1", .machineId = "local", .cwd = cwd, .operation = "write", .args = .{ .path = "file.txt", .content = "hello" } }, .{});
    try std.testing.expect((try call(allocator, journal, body)).object.get("ok").?.bool);
    try tmp.dir.writeFile(io, .{ .sub_path = "file.txt", .data = "external" });
    try std.testing.expect((try call(allocator, journal, body)).object.get("ok").?.bool);
    try std.testing.expectEqualStrings("external", try tmp.dir.readFileAlloc(io, "file.txt", allocator, .limited(1024)));
    const conflict = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "1", .machineId = "local", .cwd = cwd, .operation = "write", .args = .{ .path = "file.txt", .content = "different" } }, .{});
    try std.testing.expectEqualStrings("conflict", (try call(allocator, journal, conflict)).object.get("code").?.string);
    const offline = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "2", .machineId = "remote", .cwd = cwd, .operation = "write", .args = .{ .path = "file.txt", .content = "wrong host" } }, .{});
    try std.testing.expectEqualStrings("offline", (try call(allocator, journal, offline)).object.get("code").?.string);
    const edit = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "3", .machineId = "local", .cwd = cwd, .operation = "edit", .args = .{ .path = "file.txt", .oldText = "external", .newText = "edited" } }, .{});
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(edit, &hash, .{});
    const hex = std.fmt.bytesToHex(hash, .lower);
    const accepted = try std.json.Stringify.valueAlloc(allocator, .{ .hash = hex[0..], .result = null }, .{});
    try journal.writeFile(io, .{ .sub_path = "3.json", .data = accepted });
    try std.testing.expectEqualStrings("effect_uncertain", (try call(allocator, journal, edit)).object.get("code").?.string);
    try std.testing.expectEqualStrings("external", try tmp.dir.readFileAlloc(io, "file.txt", allocator, .limited(1024)));
    const exact = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "4", .machineId = "local", .cwd = cwd, .operation = "edit", .args = .{ .path = "file.txt", .oldText = "external", .newText = "edited" } }, .{});
    try std.testing.expect((try call(allocator, journal, exact)).object.get("ok").?.bool);
    try std.testing.expectEqualStrings("edited", try tmp.dir.readFileAlloc(io, "file.txt", allocator, .limited(1024)));
    const read = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = "5", .machineId = "local", .cwd = cwd, .operation = "read", .args = .{ .path = "file.txt" } }, .{});
    try std.testing.expectEqualStrings("edited", (try call(allocator, journal, read)).object.get("output").?.string);
}

test "native validation precedes acceptance and preserves exact old receipt and hash bytes" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cwd = try tmp.dir.realPathFileAlloc(io, ".", a);
    try tmp.dir.createDir(io, "ops", .default_dir);
    var journal = try tmp.dir.openDir(io, "ops", .{});
    defer journal.close(io);
    try tmp.dir.writeFile(io, .{ .sub_path = "file.txt", .data = "untouched" });
    for ([_]struct { op: []const u8, args: []const u8 }{
        .{ .op = "environment", .args = "{}" },
        .{ .op = "read", .args = "{\"path\":\"file.txt\",\"content\":\"PRIVATE\"}" },
        .{ .op = "write", .args = "{\"path\":\"file.txt\"}" },
        .{ .op = "edit", .args = "{\"path\":\"file.txt\",\"oldText\":\"\",\"newText\":\"PRIVATE\"}" },
        .{ .op = "bash", .args = "{\"command\":\"touch must-not-exist\",\"timeout\":301}" },
        .{ .op = "rex_allocate", .args = "{\"plan\":\"{}\"}" },
    }) |fixture| {
        const args = (try std.json.parseFromSlice(std.json.Value, a, fixture.args, .{})).value;
        const body = try std.json.Stringify.valueAlloc(a, .{ .version = 1, .id = "100", .machineId = "local", .cwd = cwd, .operation = fixture.op, .args = args }, .{});
        try std.testing.expectError(error.InvalidContract, worker.operation(Native.testing(), a, journal, "local", body));
        try std.testing.expectError(error.FileNotFound, journal.readFileAlloc(io, "100.json", a, .limited(1024)));
        try std.testing.expectEqualStrings("untouched", try tmp.dir.readFileAlloc(io, "file.txt", a, .limited(1024)));
    }
    const canonical = try std.json.Stringify.valueAlloc(a, .{ .version = 1, .id = "1", .machineId = "local", .cwd = cwd, .operation = "write", .args = .{ .path = "file.txt", .content = "once" } }, .{});
    const body = try std.mem.concat(a, u8, &.{ "\n ", canonical, "\n" });
    try std.testing.expect((try call(a, journal, body)).object.get("ok").?.bool);
    const retained = try journal.readFileAlloc(io, "1.json", a, .limited(4096));
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(body, &digest, .{});
    const hash = std.fmt.bytesToHex(digest, .lower);
    try std.testing.expect(std.mem.indexOf(u8, retained, &hash) != null);
    try tmp.dir.writeFile(io, .{ .sub_path = "file.txt", .data = "external" });
    try std.testing.expect((try call(a, journal, body)).object.get("ok").?.bool);
    try std.testing.expectEqualStrings("conflict", (try call(a, journal, canonical)).object.get("code").?.string);
    try std.testing.expectEqualStrings(retained, try journal.readFileAlloc(io, "1.json", a, .limited(4096)));
    for ([_][]const u8{
        "{\"ok\":true,\"output\":\"PRIVATE\",\"code\":\"effect_uncertain\"}",
        "{\"ok\":true,\"output\":\"PRIVATE\",\"truncated\":true}",
        "{\"ok\":true,\"output\":\"PRIVATE\",\"exitCode\":0}",
        "{\"ok\":true,\"output\":\"PRIVATE\",\"extra\":true}",
    }) |result| {
        const corrupted = try std.fmt.allocPrint(a, "{{\"hash\":\"{s}\",\"result\":{s}}}", .{ hash, result });
        try journal.writeFile(io, .{ .sub_path = "1.json", .data = corrupted });
        try std.testing.expectError(error.InvalidContract, worker.operation(Native.testing(), a, journal, "local", body));
        try std.testing.expectEqualStrings(corrupted, try journal.readFileAlloc(io, "1.json", a, .limited(4096)));
        try std.testing.expectEqualStrings("external", try tmp.dir.readFileAlloc(io, "file.txt", a, .limited(1024)));
    }
    const legacy = try std.fmt.allocPrint(a, "{{ \"hash\":\"{s}\", \"result\":{{\"ok\":true,\"output\":\"legacy result\"}} }}", .{hash});
    try journal.writeFile(io, .{ .sub_path = "1.json", .data = legacy });
    try std.testing.expectEqualStrings("legacy result", (try call(a, journal, body)).object.get("output").?.string);
    try std.testing.expectEqualStrings(legacy, try journal.readFileAlloc(io, "1.json", a, .limited(4096)));
    try std.testing.expectEqualStrings("external", try tmp.dir.readFileAlloc(io, "file.txt", a, .limited(1024)));
}
