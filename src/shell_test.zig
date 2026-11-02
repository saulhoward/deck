const std = @import("std");
const shell = @import("shell.zig");

fn cancelSoon(flag: *std.atomic.Value(bool)) void {
    std.Thread.sleep(100 * std.time.ns_per_ms);
    flag.store(true, .release);
}

test "bash returns bounded tails and exit status, including binary output" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try std.process.getCwdAlloc(allocator);
    var cancel = std.atomic.Value(bool).init(false);
    const ok = try shell.run(allocator, cwd, "printf hello; printf error >&2", 5, &cancel);
    try std.testing.expect(ok.ok);
    try std.testing.expect(std.mem.indexOf(u8, ok.output, "hello") != null);
    try std.testing.expect(std.mem.indexOf(u8, ok.output, "error") != null);
    const failed = try shell.run(allocator, cwd, "exit 7", 5, &cancel);
    try std.testing.expectEqual(@as(?u8, 7), failed.exitCode);
    try std.testing.expect(!failed.ok);
    const large = try shell.run(allocator, cwd, "for ((i=0;i<10000;i++)); do printf 0123456789; done", 5, &cancel);
    try std.testing.expect(large.ok and large.truncated and large.output.len < 66000);
    const binary = try shell.run(allocator, cwd, "printf '\\377'", 5, &cancel);
    try std.testing.expect(binary.ok and std.unicode.utf8ValidateSlice(binary.output));
    try std.testing.expect(std.mem.indexOf(u8, binary.output, "lossyUtf8=true") != null);
}

test "bash timeout and cancellation kill a TERM-resistant foreground group" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try std.process.getCwdAlloc(allocator);
    var cancel = std.atomic.Value(bool).init(false);
    var timer = try std.time.Timer.start();
    const timeout = try shell.run(allocator, cwd, "trap '' TERM; sleep 30", 1, &cancel);
    try std.testing.expectEqualStrings("timeout", timeout.code);
    try std.testing.expect(timer.read() < 4 * std.time.ns_per_s);
    const thread = try std.Thread.spawn(.{}, cancelSoon, .{&cancel});
    defer thread.join();
    timer.reset();
    const stopped = try shell.run(allocator, cwd, "trap '' TERM; sleep 30", 30, &cancel);
    try std.testing.expectEqualStrings("cancelled", stopped.code);
    try std.testing.expect(timer.read() < 4 * std.time.ns_per_s);
}

test "bash completion does not leave ordinary background descendants running" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const cwd = try tmp.dir.realpathAlloc(arena.allocator(), ".");
    var cancel = std.atomic.Value(bool).init(false);
    const result = try shell.run(arena.allocator(), cwd, "(sleep 1; printf orphan > marker) & printf done", 5, &cancel);
    try std.testing.expect(result.ok);
    std.Thread.sleep(1200 * std.time.ns_per_ms);
    try std.testing.expectError(error.FileNotFound, tmp.dir.access("marker", .{}));
}
