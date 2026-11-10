const std = @import("std");
const Native = @import("native.zig");

pub fn node(native: Native, allocator: std.mem.Allocator) ![]const u8 {
    return native.environ.getAlloc(allocator, "DECK_NODE") catch |err| switch (err) {
        error.EnvironmentVariableMissing => allocator.dupe(u8, "node"),
        else => return err,
    };
}

pub fn entry(native: Native, allocator: std.mem.Allocator, override: ?[]const u8, name: []const u8) ![:0]const u8 {
    if (override) |path| return std.Io.Dir.cwd().realPathFileAlloc(native.io, path, allocator);
    // Keep the sentinel in the allocation type: currentPathAlloc and realPath
    // allocate it in Zig 0.17, and freeing a coerced []u8 would lose one byte.
    const root = if (native.environ.getPosix("DECK_RUNTIME_ROOT")) |path|
        try allocator.dupeSentinel(u8, path, 0)
    else
        try std.process.currentPathAlloc(native.io, allocator);
    defer allocator.free(root);
    const path = try std.fs.path.join(allocator, &.{ root, "runtime", "dist", name });
    defer allocator.free(path);
    return std.Io.Dir.cwd().realPathFileAlloc(native.io, path, allocator);
}

test "runtime path allocation retains sentinels for override, environment and absent fallback" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, "runtime/dist");
    try tmp.dir.writeFile(io, .{ .sub_path = "runtime/dist/probe.js", .data = "" });
    const root = try tmp.dir.realPathFileAlloc(io, ".", allocator);
    defer allocator.free(root);
    const expected = try tmp.dir.realPathFileAlloc(io, "runtime/dist/probe.js", allocator);
    defer allocator.free(expected);
    const variable = try std.mem.concatWithSentinel(allocator, u8, &.{ "DECK_RUNTIME_ROOT=", root }, 0);
    defer allocator.free(variable);
    const variables = [_:null]?[*:0]const u8{variable.ptr};
    const native: Native = .{ .io = io, .environ = .{ .block = .{ .slice = &variables } } };
    const configured = try entry(native, allocator, null, "probe.js");
    defer allocator.free(configured);
    try std.testing.expectEqualStrings(expected, configured);
    const override = try entry(native, allocator, expected, "unused.js");
    defer allocator.free(override);
    try std.testing.expectEqualStrings(expected, override);
    // No cwd changes or repository build artifacts are required for the fallback.
    try std.testing.expectError(error.FileNotFound, entry(.{ .io = io, .environ = .empty }, allocator, null, "deck-test-absent-entry.js"));
}
