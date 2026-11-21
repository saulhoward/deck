const std = @import("std");
const Native = @import("native.zig");
const viewer = @import("tui_message_viewer.zig");
const helper = @import("tui_message_viewer_helper.zig");
const uuid = "00000000-0000-4000-8000-000000000001";
const session = "session:" ++ uuid;
const block = "block:" ++ uuid;
const fixture =
    \\#!/bin/sh
    \\base=${0%/*}
    \\printf '%s\n' "$@" >> "$base/calls"
    \\test -z "${OPENAI_API_KEY-}${REX_SESSION-}${REX_BLOCK-}${REX_SERVER-}" || exit 8
    \\mode=$(/bin/cat "$base/mode")
    \\case "$*" in
    \\  *'server status --json')
    \\    if [ "$mode" = remote ]; then transport=tcp; else transport=unix; fi
    \\    instance=00000000-0000-4000-8000-000000000001
    \\    if [ "$mode" = changed ] && [ -f "$base/inspected" ]; then instance=00000000-0000-4000-8000-000000000002; fi
    \\    printf '{"endpoint":"unix:///tmp/deck-viewer-fake.sock","host_id":"00000000-0000-4000-8000-000000000001","instance_id":"%s","api_revision":16,"you":{"transport":"%s"}}\n' "$instance" "$transport";;
    \\  *'api call session.describe_block '*)
    \\    : > "$base/inspected"
    \\    if [ "$mode" = wrong ]; then exit 3; fi
    \\    printf '%s\n' '{"block":{"block_id":"block:00000000-0000-4000-8000-000000000001","window_id":"window:00000000-0000-4000-8000-000000000001","host_id":"00000000-0000-4000-8000-000000000001","flavor":"com.superlogical.terminal.shell","placement":"placed"}}';;
    \\  *'run --session '*)
    \\    for last; do :; done
    \\    printf '%s' "$last" > "$base/launched"
    \\    if [ "$mode" = uncertain ]; then echo SECRET >&2; exit 1; fi
    \\    printf '%s\n' '{"window_id":"window:00000000-0000-4000-8000-000000000002","block_ids":["block:00000000-0000-4000-8000-000000000002"]}';;
    \\  *) exit 7;;
    \\esac
    \\
;
const Fixture = struct {
    tmp: std.testing.TmpDir,
    root: []const u8,
    env: std.process.Environ.Map,
    native: Native,
    fn init(a: std.mem.Allocator) !Fixture {
        var tmp = std.testing.tmpDir(.{ .iterate = true });
        errdefer tmp.cleanup();
        const root = try tmp.dir.realPathFileAlloc(std.testing.io, ".", a);
        const rex = try tmp.dir.createFile(std.testing.io, "rex", .{ .permissions = .fromMode(0o700) });
        try rex.writeStreamingAll(std.testing.io, fixture);
        rex.close(std.testing.io);
        try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "mode", .data = "ok" });
        const nvim = try tmp.dir.createFile(std.testing.io, "nvim", .{ .permissions = .fromMode(0o700) });
        try nvim.writeStreamingAll(std.testing.io, "#!/bin/sh\nexit 0\n");
        nvim.close(std.testing.io);
        var env = std.process.Environ.Map.init(a);
        try env.put("PATH", root); // Cannot fall through to the user's real Rex.
        try env.put("TMPDIR", root);
        try env.put("REX_SESSION", session);
        try env.put("REX_BLOCK", block);
        try env.put("REX_SERVER", "unix:///tmp/deck-viewer-fake.sock");
        try env.put("EDITOR", "/bin/echo --wait 'two words' '$HOME;$(touch INJECTED)' \"\"");
        try env.put("OPENAI_API_KEY", "SECRET");
        return .{ .tmp = tmp, .root = root, .env = env, .native = .{ .io = std.testing.io, .environ = .{ .block = try env.createPosixBlock(a, .{}) } } };
    }
    fn read(self: *Fixture, a: std.mem.Allocator, path: []const u8) ![]u8 {
        const file = try self.tmp.dir.openFile(self.native.io, path, .{});
        defer file.close(self.native.io);
        return Native.readAll(self.native.io, file, a, 1024 * 1024);
    }
};

test "message viewer full export, same-session literal argv, private copy and no wait" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var f = try Fixture.init(a);
    defer f.tmp.cleanup();
    var cancelled = std.atomic.Value(bool).init(false);
    const content = try a.alloc(u8, 24 * 1024);
    @memset(content, 'x');
    const tail = "$(touch INJECTED); <end>";
    @memcpy(content[content.len - tail.len ..], tail);
    try viewer.open(f.native, a, &f.env, content, .nvim, &cancelled);
    const calls = try f.read(a, "calls");
    try std.testing.expect(std.mem.indexOf(u8, calls, "run\n--session\n" ++ session ++ "\n--cwd\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, calls, "\n--shell=none\n--json\n--\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, calls, "session.describe_block\n{\"session_id\":\"" ++ session ++ "\",\"block_id\":\"" ++ block ++ "\"}") != null);
    for ([_][]const u8{ "\nnew\n", "--wait", "SECRET", "INJECTED", "two words" }) |forbidden| try std.testing.expect(std.mem.indexOf(u8, calls, forbidden) == null);
    const path = try f.read(a, "launched");
    const root = std.fs.path.dirname(path).?;
    const exported = try @import("mcp_profiles.zig").readPrivate(f.native, a, try std.fs.path.join(a, &.{ root, "message.md" }), viewer.limit);
    try std.testing.expectEqualSlices(u8, content, exported);
    const control = try @import("mcp_profiles.zig").readPrivate(f.native, a, path, helper.control_limit);
    const parsed = try std.json.parseFromSlice(helper.Control, a, control, .{});
    try std.testing.expectEqualStrings(try std.process.currentPathAlloc(f.native.io, a), parsed.value.cwd);
    try std.testing.expectEqual(@as(usize, 1), parsed.value.argv.len);
    try std.testing.expectEqualStrings(try std.fs.path.join(a, &.{ f.root, "nvim" }), parsed.value.argv[0]);
    const dstat = try std.Io.Dir.cwd().statFile(f.native.io, root, .{});
    const fstat = try std.Io.Dir.cwd().statFile(f.native.io, path, .{});
    try std.testing.expectEqual(@as(u32, 0o700), dstat.permissions.toMode() & 0o777);
    try std.testing.expectEqual(@as(u32, 0o600), fstat.permissions.toMode() & 0o777);
}

test "message viewer preflight rejects cap, missing programs and native Rex context before effects" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var f = try Fixture.init(a);
    defer f.tmp.cleanup();
    var cancelled = std.atomic.Value(bool).init(false);
    const big = try a.alloc(u8, viewer.limit + 1);
    try std.testing.expectError(error.MessageTooLarge, viewer.open(f.native, a, &f.env, big, .nvim, &cancelled));
    try std.testing.expectError(error.LeafUnavailable, viewer.open(f.native, a, &f.env, "", .leaf, &cancelled));
    // No fallback to EDITOR (the fixture has a working /bin/echo).
    try f.tmp.dir.rename("nvim", f.tmp.dir, "hidden-nvim", f.native.io);
    try std.testing.expectError(error.NvimUnavailable, viewer.open(f.native, a, &f.env, "", .nvim, &cancelled));
    try f.tmp.dir.rename("hidden-nvim", f.tmp.dir, "nvim", f.native.io);
    _ = f.env.swapRemove("EDITOR");
    try f.env.put("REX_SESSION", "abbreviated");
    try std.testing.expectError(error.ViewerRexContext, viewer.open(f.native, a, &f.env, "", .nvim, &cancelled));
    try f.env.put("REX_SESSION", session);
    try f.env.put("REX_SERVER", "https://remote.example");
    try std.testing.expectError(error.ViewerRexUnavailable, viewer.open(f.native, a, &f.env, "", .nvim, &cancelled));
    cancelled.store(true, .release);
    try std.testing.expectError(error.Cancelled, viewer.open(f.native, a, &f.env, "", .nvim, &cancelled));
    try std.testing.expectError(error.FileNotFound, f.read(a, "calls"));
    var it = f.tmp.dir.iterate();
    while (try it.next(f.native.io)) |entry| try std.testing.expect(!std.mem.startsWith(u8, entry.name, "deck-message-"));
}

test "message viewer membership and transport refuse; uncertain run is not retried or cleaned" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var f = try Fixture.init(a);
    defer f.tmp.cleanup();
    var cancelled = std.atomic.Value(bool).init(false);
    try f.tmp.dir.writeFile(f.native.io, .{ .sub_path = "mode", .data = "wrong" });
    try std.testing.expectError(error.ViewerRexContext, viewer.open(f.native, a, &f.env, "full text", .nvim, &cancelled));
    try f.tmp.dir.writeFile(f.native.io, .{ .sub_path = "mode", .data = "remote" });
    try std.testing.expectError(error.ViewerRexUnavailable, viewer.open(f.native, a, &f.env, "full text", .nvim, &cancelled));
    try std.testing.expectError(error.FileNotFound, f.read(a, "launched"));
    try f.tmp.dir.writeFile(f.native.io, .{ .sub_path = "mode", .data = "uncertain" });
    try std.testing.expectError(error.ViewerLaunchUnconfirmed, viewer.open(f.native, a, &f.env, "full text", .nvim, &cancelled));
    const path = try f.read(a, "launched");
    _ = try @import("mcp_profiles.zig").readPrivate(f.native, a, path, helper.control_limit);
    const calls = try f.read(a, "calls");
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, calls, "\nrun\n"));
}

test "message viewer leaf resolves PATH and absent REX_SERVER uses pinned local discovery" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var f = try Fixture.init(a);
    defer f.tmp.cleanup();
    const leaf = try f.tmp.dir.createFile(f.native.io, "leaf", .{ .permissions = .fromMode(0o700) });
    try leaf.writeStreamingAll(f.native.io, "#!/bin/sh\nexit 0\n");
    leaf.close(f.native.io);
    _ = f.env.swapRemove("EDITOR");
    _ = f.env.swapRemove("REX_SERVER");
    var cancelled = std.atomic.Value(bool).init(false);
    try viewer.open(f.native, a, &f.env, "# markdown\n", .leaf, &cancelled);
    const path = try f.read(a, "launched");
    const control = try @import("mcp_profiles.zig").readPrivate(f.native, a, path, helper.control_limit);
    const parsed = try std.json.parseFromSlice(helper.Control, a, control, .{});
    try std.testing.expectEqual(@as(usize, 1), parsed.value.argv.len);
    try std.testing.expectEqualStrings(try std.fs.path.join(a, &.{ f.root, "leaf" }), parsed.value.argv[0]);
    const calls = try f.read(a, "calls");
    try std.testing.expect(std.mem.startsWith(u8, calls, "--autostart=false\n--timeout\n2s\nserver\nstatus\n--json\n"));
    try std.testing.expect(std.mem.indexOf(u8, calls, "--server\nunix:///tmp/deck-viewer-fake.sock\nrun\n") != null);
    // The helper itself does not need any model/hub context to launch/clean up.
    try helper.run(f.native, a, path);
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.cwd().statFile(f.native.io, path, .{}));
}

test "message viewer rejects Rex identity changes between discovery and membership" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var f = try Fixture.init(a);
    defer f.tmp.cleanup();
    try f.tmp.dir.writeFile(f.native.io, .{ .sub_path = "mode", .data = "changed" });
    var cancelled = std.atomic.Value(bool).init(false);
    try std.testing.expectError(error.ViewerRexUnavailable, viewer.open(f.native, a, &f.env, "message", .nvim, &cancelled));
    try std.testing.expectError(error.FileNotFound, f.read(a, "launched"));
    var it = f.tmp.dir.iterate();
    while (try it.next(f.native.io)) |entry| try std.testing.expect(!std.mem.startsWith(u8, entry.name, "deck-message-"));
}

test "message viewer cannot authorize cleanup when child exit cannot be reaped" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var f = try Fixture.init(a);
    defer f.tmp.cleanup();
    _ = f.env.swapRemove("EDITOR");
    var cancelled = std.atomic.Value(bool).init(false);
    try viewer.open(f.native, a, &f.env, "private export", .nvim, &cancelled);
    const path = try f.read(a, "launched");
    // Simulate an embedding process which auto-reaps children. ECHILD must not
    // authorize cleanup or signaling a PID that might have been reused.
    var previous: std.posix.Sigaction = undefined;
    const ignore: std.posix.Sigaction = .{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(.CHLD, &ignore, &previous);
    defer std.posix.sigaction(.CHLD, &previous, null);
    try std.testing.expectError(error.ViewerExitUnconfirmed, helper.run(f.native, a, path));
    _ = try @import("mcp_profiles.zig").readPrivate(f.native, a, path, helper.control_limit);
    const message = try std.fs.path.join(a, &.{ std.fs.path.dirname(path).?, "message.md" });
    try std.testing.expectEqualStrings("private export", try @import("mcp_profiles.zig").readPrivate(f.native, a, message, viewer.limit));
}
