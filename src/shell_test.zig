const std = @import("std");
const shell = @import("shell.zig");
const Native = @import("native.zig");
const io = std.testing.io;

fn cancelSoon(flag: *std.atomic.Value(bool)) void {
    io.sleep(.fromMilliseconds(100), .awake) catch unreachable;
    flag.store(true, .release);
}

test "bash returns bounded tails and exit status, including binary output" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try std.process.currentPathAlloc(io, allocator);
    var cancel = std.atomic.Value(bool).init(false);
    const ok = try shell.run(Native.testing(), allocator, cwd, "printf hello; printf error >&2", 5, &cancel);
    try std.testing.expect(ok.ok);
    try std.testing.expect(std.mem.indexOf(u8, ok.output, "hello") != null);
    try std.testing.expect(std.mem.indexOf(u8, ok.output, "error") != null);
    const failed = try shell.run(Native.testing(), allocator, cwd, "exit 7", 5, &cancel);
    try std.testing.expectEqual(@as(?u8, 7), failed.exitCode);
    try std.testing.expect(!failed.ok);
    const large = try shell.run(Native.testing(), allocator, cwd, "for ((i=0;i<10000;i++)); do printf 0123456789; done", 5, &cancel);
    try std.testing.expect(large.ok and large.truncated and large.output.len < 66000);
    const binary = try shell.run(Native.testing(), allocator, cwd, "printf '\\377'", 5, &cancel);
    try std.testing.expect(binary.ok and std.unicode.utf8ValidateSlice(binary.output));
    try std.testing.expect(std.mem.indexOf(u8, binary.output, "lossyUtf8=true") != null);
}

test "bash timeout and cancellation kill a TERM-resistant foreground group" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try std.process.currentPathAlloc(io, allocator);
    var cancel = std.atomic.Value(bool).init(false);
    var started = std.Io.Clock.awake.now(io);
    const timeout = try shell.run(Native.testing(), allocator, cwd, "trap '' TERM; sleep 30", 1, &cancel);
    try std.testing.expectEqualStrings("timeout", timeout.code);
    try std.testing.expect(started.durationTo(std.Io.Clock.awake.now(io)).toNanoseconds() < 4 * std.time.ns_per_s);
    const thread = try std.Thread.spawn(.{}, cancelSoon, .{&cancel});
    defer thread.join();
    started = std.Io.Clock.awake.now(io);
    const stopped = try shell.run(Native.testing(), allocator, cwd, "trap '' TERM; sleep 30", 30, &cancel);
    try std.testing.expectEqualStrings("cancelled", stopped.code);
    try std.testing.expect(started.durationTo(std.Io.Clock.awake.now(io)).toNanoseconds() < 4 * std.time.ns_per_s);
}

test "bash completion does not leave ordinary background descendants running" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const cwd = try tmp.dir.realPathFileAlloc(io, ".", arena.allocator());
    var cancel = std.atomic.Value(bool).init(false);
    const result = try shell.run(Native.testing(), arena.allocator(), cwd, "(sleep 1; printf orphan > marker) & printf done", 5, &cancel);
    try std.testing.expect(result.ok);
    try io.sleep(.fromMilliseconds(1200), .awake);
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "marker", .{}));
}
