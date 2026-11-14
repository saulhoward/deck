//! Explicit local $EDITOR handoff. No hub request, runtime or durable draft.
const std = @import("std");
const Native = @import("native.zig");
const Editor = @import("tui_editor.zig");
// Zig 0.17's libc-backed posix wrappers do not expose these two functions.
extern "c" fn tcgetpgrp(c_int) std.posix.pid_t;
extern "c" fn tcsetpgrp(c_int, std.posix.pid_t) c_int;
fn foreground(fd: c_int, pid: std.posix.pid_t) !void {
    while (true) switch (std.c.errno(tcsetpgrp(fd, pid))) {
        .SUCCESS => return,
        .INTR => continue,
        else => return error.TerminalHandoff,
    };
}

// A small argv grammar, not a shell: quotes/backslashes are supported, but no
// expansion, interpolation, pipelines or redirection are performed.
fn arguments(a: std.mem.Allocator, value: []const u8) ![]const []const u8 {
    if (value.len == 0 or value.len > 4096 or std.mem.indexOfAny(u8, value, "\x00\r\n") != null) return error.InvalidEditor;
    var argv: std.ArrayList([]const u8) = .empty;
    var word: std.ArrayList(u8) = .empty;
    var quote: ?u8 = null;
    var escaped = false;
    var started = false;
    for (value) |c| {
        if (escaped) {
            try word.append(a, c);
            escaped = false;
        } else if (c == '\\' and quote != '\'') {
            escaped = true;
            started = true;
        } else if (quote) |q| {
            if (c == q) quote = null else try word.append(a, c);
        } else if (c == '\'' or c == '"') {
            quote = c;
            started = true;
        } else if (c == ' ' or c == '\t') {
            if (started) {
                try argv.append(a, try word.toOwnedSlice(a));
                started = false;
            }
        } else {
            started = true;
            try word.append(a, c);
        }
        if (argv.items.len > 32) return error.InvalidEditor;
    }
    if (escaped or quote != null) return error.InvalidEditor;
    if (started) try argv.append(a, try word.toOwnedSlice(a));
    if (argv.items.len == 0 or argv.items.len > 32 or argv.items[0].len == 0) return error.InvalidEditor;
    return argv.toOwnedSlice(a);
}

pub fn run(native: Native, a: std.mem.Allocator, env: *std.process.Environ.Map, original: []const u8, cancelled: *std.atomic.Value(bool)) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const scratch = arena.allocator();
    const editor = try arguments(scratch, env.get("EDITOR") orelse return error.EditorNotSet);
    const tmp = env.get("TMPDIR") orelse "/tmp";
    if (!std.fs.path.isAbsolute(tmp) or tmp.len > 4096 or std.mem.indexOfScalar(u8, tmp, 0) != null) return error.InvalidTemporaryDirectory;
    var random: [16]u8 = undefined;
    native.io.random(&random);
    const root = try std.fmt.allocPrint(scratch, "{s}/deck-editor-{s}", .{ tmp, std.fmt.bytesToHex(random, .lower) });
    try std.Io.Dir.createDirAbsolute(native.io, root, .fromMode(0o700));
    defer std.Io.Dir.cwd().deleteTree(native.io, root) catch {};
    const path = try std.fs.path.join(scratch, &.{ root, "prompt.md" });
    {
        const file = try std.Io.Dir.cwd().createFile(native.io, path, .{ .exclusive = true, .permissions = .fromMode(0o600) });
        defer file.close(native.io);
        try file.writeStreamingAll(native.io, original);
    }
    const argv = try scratch.alloc([]const u8, editor.len + 1);
    @memcpy(argv[0..editor.len], editor);
    argv[editor.len] = path;
    const tty = try std.posix.openat(std.posix.AT.FDCWD, "/dev/tty", .{ .ACCMODE = .RDWR, .CLOEXEC = true }, 0);
    defer Native.close(tty);
    const previous_group = tcgetpgrp(tty);
    if (previous_group < 0) return error.TerminalHandoff;
    const previous_modes = try std.posix.tcgetattr(tty);
    defer std.posix.tcsetattr(tty, .FLUSH, previous_modes) catch {};
    // The parent must reclaim the TTY while backgrounded. The editor gets its
    // own foreground group, so Ctrl-C goes to it, not to the client/bridge.
    var previous_ttou: std.posix.Sigaction = undefined;
    const ignore: std.posix.Sigaction = .{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(.TTOU, &ignore, &previous_ttou);
    defer std.posix.sigaction(.TTOU, &previous_ttou, null);
    if (cancelled.load(.monotonic)) return error.Cancelled;
    var child = try std.process.spawn(native.io, .{ .argv = argv, .environ_map = env, .pgid = 0 });
    const pid = child.id.?;
    var reaped = false;
    defer {
        // End our owned editor group, including ordinary background children.
        std.posix.kill(-pid, .KILL) catch {};
        if (!reaped) _ = child.wait(native.io) catch {};
    }
    defer foreground(tty, previous_group) catch {};
    try foreground(tty, pid);
    // A fast terminal reader may have received SIGTTIN before the handoff.
    std.posix.kill(-pid, .CONT) catch {};
    while (true) {
        if (cancelled.load(.monotonic)) return error.Cancelled;
        var status: c_int = 0;
        const waited = std.c.waitpid(pid, &status, std.posix.W.NOHANG | std.posix.W.UNTRACED);
        if (waited < 0) {
            if (std.c.errno(waited) == .INTR) continue;
            return error.EditorWait;
        }
        if (waited == pid) {
            const result: u32 = @bitCast(status);
            // Do not leave a stopped foreground editor hanging the attachment.
            if (std.posix.W.IFSTOPPED(result)) return error.EditorSuspended;
            reaped = true;
            if (!std.posix.W.IFEXITED(result) or std.posix.W.EXITSTATUS(result) != 0) return error.EditorExit;
            break;
        }
        try native.io.sleep(.fromMilliseconds(25), .awake);
    }
    // Reuse the regular-file/no-follow/owner/private-mode/size guard. It invokes
    // no MCP operation. Editors may atomically replace the file, but not with a
    // symlink, FIFO, oversized file or public file.
    const value = try @import("mcp_profiles.zig").readPrivate(native, a, path, Editor.limit);
    errdefer a.free(value);
    if (!std.unicode.utf8ValidateSlice(value) or std.mem.indexOfScalar(u8, value, 0) != null) return error.InvalidEditorText;
    return value;
}

test "EDITOR argv supports quoted paths and flags without shell evaluation" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const argv = try arguments(a, "'/Applications/My Editor' --wait \"a b\" escaped\\ space '$HOME;$(id)' ''");
    try std.testing.expectEqual(@as(usize, 6), argv.len);
    for (argv, [_][]const u8{ "/Applications/My Editor", "--wait", "a b", "escaped space", "$HOME;$(id)", "" }) |actual, expected| try std.testing.expectEqualStrings(expected, actual);
    for ([_][]const u8{ "", "  ", "''", "editor 'unfinished", "editor\\", "editor\n--flag", "editor\x00bad" }) |value| try std.testing.expectError(error.InvalidEditor, arguments(a, value));
}
