const std = @import("std");
const Native = @import("native.zig");
pub const Result = struct { ok: bool, output: []const u8, code: []const u8 = "ok", exitCode: ?u8 = null, truncated: bool = false };
const limit = 64 * 1024;
pub const progress_limit = 2048;
pub const Progress = struct {
    context: *anyopaque,
    // A replacement tail, never an append delta. Must not perform I/O or retain the slice.
    publish: *const fn (*anyopaque, []const u8, bool) void,
};

pub fn run(native: Native, allocator: std.mem.Allocator, cwd: []const u8, command: []const u8, seconds: u32, cancelled: *std.atomic.Value(bool)) !Result {
    return runObserved(native, allocator, cwd, command, seconds, cancelled, null);
}
pub fn runObserved(native: Native, allocator: std.mem.Allocator, cwd: []const u8, command: []const u8, seconds: u32, cancelled: *std.atomic.Value(bool), progress: ?Progress) !Result {
    if (command.len == 0) return error.InvalidArguments;
    return runArgv(native, allocator, cwd, &.{ "bash", "--noprofile", "--norc", "-c", command }, seconds, cancelled, progress, false);
}
// Shared owned-process runner. Raw mode is for bounded native CLI JSON, not a
// model tool: malformed/truncated/lossy output cannot become a trusted result.
pub fn runArgv(native: Native, allocator: std.mem.Allocator, cwd: []const u8, argv: []const []const u8, seconds: u32, cancelled: *std.atomic.Value(bool), progress: ?Progress, raw: bool) !Result {
    return runOwned(native, allocator, cwd, argv, seconds, cancelled, progress, raw, null, null);
}
pub const Captured = struct { result: Result, stdout: []const u8, stderr: []const u8 };
const Capture = struct { streams: [2]std.array_list.Managed(u8) };
// Separate bounded channels are needed to recognize an exact native error, never
// a diagnostic-looking string in stdout. Neither channel is retained as a receipt.
pub fn runArgvCaptured(native: Native, allocator: std.mem.Allocator, cwd: []const u8, argv: []const []const u8, seconds: u32, cancelled: *std.atomic.Value(bool)) !Captured {
    return runArgvCapturedContext(native, allocator, cwd, argv, seconds, cancelled, null);
}
// Only the launcher helper needs these two validated lookup hints. Never pass
// ambient Rex routing/focus, credentials or loader settings to raw CLI tools.
pub const RexContext = struct { session: []const u8, block: []const u8 };
pub fn runArgvCapturedContext(native: Native, allocator: std.mem.Allocator, cwd: []const u8, argv: []const []const u8, seconds: u32, cancelled: *std.atomic.Value(bool), context: ?RexContext) !Captured {
    if (context) |c| if (!@import("generated/contracts.zig").validRexSessionId(.{ .string = c.session }) or !@import("generated/contracts.zig").validRexBlockId(.{ .string = c.block })) return error.InvalidArguments;
    var capture = Capture{ .streams = .{ .init(allocator), .init(allocator) } };
    defer for (&capture.streams) |*stream| stream.deinit();
    const result = try runOwned(native, allocator, cwd, argv, seconds, cancelled, null, true, &capture, context);
    return .{ .result = result, .stdout = try allocator.dupe(u8, capture.streams[0].items), .stderr = try allocator.dupe(u8, capture.streams[1].items) };
}
fn runOwned(native: Native, allocator: std.mem.Allocator, cwd: []const u8, argv: []const []const u8, seconds: u32, cancelled: *std.atomic.Value(bool), progress: ?Progress, raw: bool, capture: ?*Capture, context: ?RexContext) !Result {
    const io = native.io;
    if (!std.fs.path.isAbsolute(cwd) or argv.len == 0 or seconds == 0 or seconds > 300) return error.InvalidArguments;
    if (cancelled.load(.acquire)) return .{ .ok = false, .output = "Cancelled before spawn", .code = "cancelled" };
    var env = try native.environ.createMap(allocator);
    defer env.deinit();
    _ = env.swapRemove("BASH_ENV");
    _ = env.swapRemove("OPENAI_API_KEY"); // Model credentials are hub inputs, not shell defaults.
    if (raw) {
        // CLI transport gets no hub credentials, ambient Rex routing/focus,
        // loader/Node injection or Deck runtime overrides. Rex launches the
        // client from its own environment, using our packaged client wrapper.
        var clean = std.process.Environ.Map.init(allocator);
        errdefer clean.deinit();
        for ([_][]const u8{ "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "REX_RUNTIME_DIR" }) |key| if (env.get(key)) |value| try clean.put(key, value);
        if (context) |c| {
            try clean.put("REX_SESSION", c.session);
            try clean.put("REX_BLOCK", c.block);
        }
        env.deinit();
        env = clean;
    }
    var child = try std.process.spawn(io, .{
        .argv = argv,
        .cwd = .{ .path = cwd },
        .environ_map = &env,
        .pgid = 0,
        .stdin = .ignore,
        .stdout = .pipe,
        .stderr = .pipe,
    });
    const pid = child.id.?;
    var reaped = false;
    defer {
        // Foreground command ownership ends here, including ordinary background descendants.
        if (!reaped) {
            std.posix.kill(-pid, std.posix.SIG.KILL) catch {};
            _ = child.wait(io) catch {};
        }
    }
    defer if (reaped) Native.closeStreams(io, &child);
    const files = [_]std.Io.File{ child.stdout.?, child.stderr.? };
    var open = [_]bool{ true, true };
    for (files) |file| {
        const flags = try Native.fcntl(file.handle, std.posix.F.GETFL, 0);
        _ = try Native.fcntl(file.handle, std.posix.F.SETFL, flags | @as(u32, @bitCast(std.posix.O{ .NONBLOCK = true })));
    }
    const tail = try allocator.alloc(u8, limit);
    defer allocator.free(tail);
    var used: usize = 0;
    var truncated = false;
    const started = std.Io.Clock.awake.now(io);
    var stopping: ?u64 = null;
    var reason: []const u8 = "ok";
    var status: ?u32 = null;
    var dirty = false;
    var published: ?u64 = null;
    while (true) {
        const now: u64 = @intCast(started.durationTo(std.Io.Clock.awake.now(io)).toNanoseconds());
        if (stopping == null and (cancelled.load(.acquire) or now >= @as(u64, seconds) * std.time.ns_per_s)) {
            reason = if (cancelled.load(.acquire)) "cancelled" else "timeout";
            stopping = now;
            std.posix.kill(-pid, std.posix.SIG.TERM) catch {};
        }
        if (stopping) |at| if (!reaped and now - at >= 250 * std.time.ns_per_ms) {
            std.posix.kill(-pid, std.posix.SIG.KILL) catch {};
        };
        var polls = [_]std.posix.pollfd{
            .{ .fd = if (open[0]) files[0].handle else -1, .events = std.posix.POLL.IN, .revents = 0 },
            .{ .fd = if (open[1]) files[1].handle else -1, .events = std.posix.POLL.IN, .revents = 0 },
        };
        _ = try std.posix.poll(&polls, 25);
        // One bounded read per stream/iteration keeps timeout/control checks independent of output volume.
        for (files, 0..) |file, index| {
            if (!open[index]) continue;
            var chunk: [8192]u8 = undefined;
            const count = std.posix.read(file.handle, &chunk) catch |err| switch (err) {
                error.WouldBlock => continue,
                else => return err,
            };
            if (count == 0) {
                open[index] = false;
                continue;
            }
            if (capture) |sink| {
                const stream = &sink.streams[index];
                try stream.appendSlice(chunk[0..@min(count, limit - stream.items.len)]);
            }
            if (used + count > limit) {
                const drop = used + count - limit;
                std.mem.copyForwards(u8, tail[0 .. used - drop], tail[drop..used]);
                used -= drop;
                truncated = true;
            }
            @memcpy(tail[used .. used + count], chunk[0..count]);
            used += count;
            dirty = true;
        }
        if (progress) |sink| if (dirty and (published == null or now - published.? >= 250 * std.time.ns_per_ms)) {
            const start = used - @min(used, progress_limit);
            sink.publish(sink.context, tail[start..used], truncated or start > 0);
            published = now;
            dirty = false;
        };
        if (status == null) {
            const result = try Native.waitNoHang(pid);
            if (result.pid != 0) {
                status = result.status;
                reaped = true;
                child.id = null;
                std.posix.kill(-pid, std.posix.SIG.KILL) catch {};
            }
        }
        if (status != null and !open[0] and !open[1]) break;
        // A descendant that deliberately escaped the group may retain a pipe. Never hang shutdown on it.
        if (stopping) |at| if (now - at >= std.time.ns_per_s and status != null) {
            truncated = true;
            break;
        };
        if (status != null and stopping == null) stopping = now;
    }
    const exit_code: u8 = if (std.posix.W.IFEXITED(status.?)) std.posix.W.EXITSTATUS(status.?) else 128 + @as(u8, @intCast(@backingInt(std.posix.W.TERMSIG(status.?))));
    const lossy = !std.unicode.utf8ValidateSlice(tail[0..used]);
    if (lossy) {
        for (tail[0..used]) |*byte| if (byte.* >= 128) {
            byte.* = '?';
        };
    }
    if (raw) return .{ .ok = exit_code == 0 and std.mem.eql(u8, reason, "ok") and !lossy and !truncated, .output = try allocator.dupe(u8, tail[0..used]), .code = if (lossy or truncated) "invalid_output" else if (std.mem.eql(u8, reason, "ok") and exit_code != 0) "exit_nonzero" else reason, .exitCode = exit_code, .truncated = truncated };
    return .{ .ok = exit_code == 0 and std.mem.eql(u8, reason, "ok"), .output = try std.fmt.allocPrint(allocator, "exitCode={d} status={s} truncated={} lossyUtf8={}\n{s}", .{ exit_code, reason, truncated, lossy, tail[0..used] }), .code = if (std.mem.eql(u8, reason, "ok") and exit_code != 0) "exit_nonzero" else reason, .exitCode = exit_code, .truncated = truncated };
}

test "raw launcher context forwards only full Rex hints and never routing or injection settings" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var env: [7:null]?[*:0]u8 = .{ @constCast("PATH=/usr/bin:/bin"), @constCast("REX_SESSION=ambient"), @constCast("REX_BLOCK=ambient"), @constCast("REX_SERVER=https://untrusted.invalid"), @constCast("BASH_ENV=/untrusted"), @constCast("NODE_OPTIONS=--require=/untrusted"), @constCast("OPENAI_API_KEY=fixture-only") };
    const native: Native = .{ .io = std.testing.io, .environ = .{ .block = .{ .slice = &env } } };
    var cancelled = std.atomic.Value(bool).init(false);
    const context: RexContext = .{ .session = "session:00000000-0000-4000-8000-000000000001", .block = "block:00000000-0000-4000-8000-000000000001" };
    const plain = try runArgvCaptured(native, a, "/", &.{"/usr/bin/env"}, 2, &cancelled);
    try std.testing.expect(plain.result.ok and std.mem.indexOf(u8, plain.stdout, "REX_") == null);
    const here = try runArgvCapturedContext(native, a, "/", &.{"/usr/bin/env"}, 2, &cancelled, context);
    try std.testing.expect(here.result.ok and std.mem.indexOf(u8, here.stdout, context.session) != null and std.mem.indexOf(u8, here.stdout, context.block) != null);
    for ([_][]const u8{ "REX_SERVER", "BASH_ENV", "NODE_OPTIONS", "OPENAI_API_KEY", "ambient" }) |forbidden| try std.testing.expect(std.mem.indexOf(u8, here.stdout, forbidden) == null);
    try std.testing.expectError(error.InvalidArguments, runArgvCapturedContext(native, a, "/", &.{"/never-execute"}, 2, &cancelled, .{ .session = "short", .block = context.block }));
}
