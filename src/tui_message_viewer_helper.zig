//! Internal export lifetime owner. The command line contains only a private
//! control path; message bytes are never parsed as arguments or executable code.
//! HUP/TERM/INT stop the owned viewer before removing its export. SIGKILL and
//! crashes cannot run cleanup; those private files require manual removal after
//! confirming the viewer has exited. Viewers must stay attached (e.g. --wait),
//! not daemonize and leave another process using the export after their exit.
const std = @import("std");
const Native = @import("native.zig");
const private = @import("mcp_profiles.zig");
pub const control_limit = 32 * 1024;
pub const Control = struct { version: u8 = 1, argv: []const []const u8, cwd: []const u8 };

// This runs in a dedicated helper, never in the parent TUI. The handler only
// records the first request with a lock-free atomic; all I/O is in the wait loop.
var stop_signal = std.atomic.Value(u32).init(0);
fn stop(sig: std.posix.SIG) callconv(.c) void {
    _ = stop_signal.cmpxchgStrong(0, @backingInt(sig), .monotonic, .monotonic);
}
const StopSignals = struct {
    const signals = [_]std.posix.SIG{ .HUP, .TERM, .INT };
    previous: [signals.len]std.posix.Sigaction,

    fn mask() std.posix.sigset_t {
        var set = std.posix.sigemptyset();
        for (signals) |sig| std.posix.sigaddset(&set, sig);
        return set;
    }
    fn install() StopSignals {
        const set = mask();
        var previous_mask: std.posix.sigset_t = undefined;
        std.posix.sigprocmask(std.posix.SIG.BLOCK, &set, &previous_mask);
        defer std.posix.sigprocmask(std.posix.SIG.SETMASK, &previous_mask, null);
        stop_signal.store(0, .monotonic);
        var result: StopSignals = undefined;
        const action: std.posix.Sigaction = .{ .handler = .{ .handler = stop }, .mask = set, .flags = 0 };
        for (signals, 0..) |sig, i| std.posix.sigaction(sig, &action, &result.previous[i]);
        return result;
    }
    fn restore(self: *const StopSignals) void {
        const set = mask();
        var previous_mask: std.posix.sigset_t = undefined;
        std.posix.sigprocmask(std.posix.SIG.BLOCK, &set, &previous_mask);
        defer std.posix.sigprocmask(std.posix.SIG.SETMASK, &previous_mask, null);
        for (signals, 0..) |sig, i| std.posix.sigaction(sig, &self.previous[i], null);
    }
};

fn waitForViewer(native: Native, pid: std.posix.pid_t, exited: *bool) !void {
    var stopping: ?std.Io.Timestamp = null;
    var killing: ?std.Io.Timestamp = null;
    while (true) {
        var status: c_int = 0;
        const waited = std.c.waitpid(pid, &status, std.posix.W.NOHANG);
        if (waited == pid) {
            const result: u32 = @bitCast(status);
            if (std.posix.W.IFEXITED(result) or std.posix.W.IFSIGNALED(result)) {
                exited.* = true;
                if (stop_signal.load(.monotonic) != 0) return error.ViewerInterrupted;
                if (!std.posix.W.IFEXITED(result) or std.posix.W.EXITSTATUS(result) != 0) return error.ViewerExit;
                return;
            }
        } else if (waited < 0 and std.c.errno(waited) != .INTR) {
            // In particular, ECHILD is not proof of exit and no longer grants
            // permission to signal this PID (it could now belong to someone else).
            return error.ViewerExitUnconfirmed;
        }
        const requested = stop_signal.load(.monotonic);
        if (requested != 0 and stopping == null) {
            stopping = .now(native.io, .awake);
            // Never signal 0, a parent group or the inherited foreground group.
            // This unreaped direct child cannot have had its PID reused. Keeping
            // its group unchanged also preserves terminal input (no SIGTTIN).
            std.debug.assert(pid > 0);
            std.posix.kill(pid, @fromBackingInt(@intCast(requested))) catch {};
        }
        if (killing) |started| {
            if (started.untilNow(native.io, .awake).toMilliseconds() >= 1000) return error.ViewerExitUnconfirmed;
        } else if (stopping) |started| {
            if (started.untilNow(native.io, .awake).toMilliseconds() >= 1000) {
                std.posix.kill(pid, .KILL) catch {};
                killing = .now(native.io, .awake);
            }
        }
        // A blocking child.wait would hide the stop request. EINTR also reaches
        // this sleep, rather than spinning on a stream of repeated signals.
        try native.io.sleep(.fromMilliseconds(10), .awake);
    }
}

fn retained(native: Native, a: std.mem.Allocator, root: []const u8) void {
    // Quote user-selected TMPDIR characters; never print message bytes or argv.
    const quoted = std.json.Stringify.valueAlloc(a, root, .{}) catch return;
    const message = std.fmt.allocPrint(a, "deck: viewer exit unconfirmed; retaining private export directory: {s}. Only after confirming the viewer has exited, remove message.md and control.json and this directory.\n", .{quoted}) catch return;
    std.Io.File.stderr().writeStreamingAll(native.io, message) catch {};
}

pub fn write(native: Native, dir: std.Io.Dir, name: []const u8, bytes: []const u8) !void {
    const file = try dir.createFile(native.io, name, .{ .exclusive = true, .permissions = .fromMode(0o600) });
    defer file.close(native.io);
    try file.writeStreamingAll(native.io, bytes);
    try file.sync(native.io);
}
pub fn cleanup(native: Native, dir: std.Io.Dir, root: []const u8) void {
    // No recursive removal, configurable filenames, or following editor-created
    // symlinks. Unknown backup files are deliberately left for manual cleanup.
    dir.deleteFile(native.io, "message.md") catch {};
    dir.deleteFile(native.io, "control.json") catch {};
    std.Io.Dir.cwd().deleteDir(native.io, root) catch {};
}
fn ownerAndLinks(fd: std.posix.fd_t) !void {
    if (@import("builtin").os.tag == .linux) {
        const linux = std.os.linux;
        var info: linux.Statx = undefined;
        while (true) switch (linux.errno(linux.statx(fd, "", linux.AT.EMPTY_PATH, .{ .UID = true, .NLINK = true }, &info))) {
            .SUCCESS => break,
            .INTR => continue,
            else => return error.InvalidViewerControl,
        };
        if (!info.mask.UID or !info.mask.NLINK or info.uid != std.c.geteuid() or info.nlink != 1) return error.InvalidViewerControl;
    } else {
        var info: std.c.Stat = undefined;
        if (std.c.fstat(fd, &info) != 0 or info.uid != std.c.geteuid() or info.nlink != 1) return error.InvalidViewerControl;
    }
}
fn openPrivate(native: Native, dir: std.Io.Dir, name: []const u8, max: usize) !std.Io.File {
    const fd = try std.posix.openat(dir.handle, name, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NOFOLLOW = true, .NONBLOCK = true }, 0);
    const file: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = true } };
    errdefer file.close(native.io);
    try ownerAndLinks(fd);
    const info = try file.stat(native.io);
    if (info.kind != .file or info.size > max or info.permissions.toMode() & 0o777 != 0o600) return error.InvalidViewerControl;
    return file;
}
fn rootPath(path: []const u8) ![]const u8 {
    if (!private.absolute(path) or !std.mem.eql(u8, std.fs.path.basename(path), "control.json")) return error.InvalidViewerControl;
    var parts = std.mem.splitScalar(u8, path[1..], '/');
    while (parts.next()) |part| if (part.len == 0 or std.mem.eql(u8, part, ".") or std.mem.eql(u8, part, "..")) return error.InvalidViewerControl;
    const root = std.fs.path.dirname(path) orelse return error.InvalidViewerControl;
    const name = std.fs.path.basename(root);
    const prefix = "deck-message-";
    if (!std.mem.startsWith(u8, name, prefix) or name.len != prefix.len + 32) return error.InvalidViewerControl;
    for (name[prefix.len..]) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return error.InvalidViewerControl;
    return root;
}
fn valid(value: Control) bool {
    if (value.version != 1 or !private.absolute(value.cwd) or value.argv.len == 0 or value.argv.len > 32 or !private.absolute(value.argv[0])) return false;
    var total: usize = 0;
    for (value.argv) |arg| {
        if (arg.len > 4096 or std.mem.indexOfScalar(u8, arg, 0) != null) return false;
        total += arg.len;
    }
    return total <= 8192;
}
pub fn run(native: Native, a: std.mem.Allocator, path: []const u8) !void {
    // Install all three handlers atomically before any spawn, and keep them
    // installed through child exit and cleanup. Do not spawn with them blocked.
    const signals = StopSignals.install();
    defer signals.restore();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const scratch = arena.allocator();
    const root = try rootPath(path);
    var dir = try @import("private_store.zig").openDirectory(native, root, false);
    defer dir.close(native.io);
    const info = try (std.Io.File{ .handle = dir.handle, .flags = .{ .nonblocking = false } }).stat(native.io);
    if (info.permissions.toMode() & 0o777 != 0o700) return error.InvalidViewerControl;
    const control = try openPrivate(native, dir, "control.json", control_limit);
    defer control.close(native.io);
    // A repeated manual invocation cannot delete a live helper's export.
    if (!try control.tryLock(native.io, .exclusive)) return error.ViewerAlreadyRunning;
    const bytes = try Native.readAll(native.io, control, scratch, control_limit);
    const value = (try std.json.parseFromSlice(Control, scratch, bytes, .{})).value;
    if (!valid(value)) return error.InvalidViewerControl;
    const content = try openPrivate(native, dir, "message.md", @import("tui_message_viewer.zig").limit);
    content.close(native.io);
    // Invalid/untrusted control paths never authorize cleanup. Once validated,
    // clean known files on spawn failure or confirmed exit, never a wait error.
    var safe_to_cleanup = true;
    defer if (safe_to_cleanup) cleanup(native, dir, root) else retained(native, scratch, root);
    const argv = try scratch.alloc([]const u8, value.argv.len + 1);
    @memcpy(argv[0..value.argv.len], value.argv);
    argv[value.argv.len] = try std.fs.path.join(scratch, &.{ root, "message.md" });
    var environment = try native.environ.createMap(scratch);
    var clean = std.process.Environ.Map.init(scratch);
    // Do not inherit hub/provider keys, loader injection or shell startup hooks.
    for ([_][]const u8{ "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME" }) |key| if (environment.get(key)) |v| try clean.put(key, v);
    if (stop_signal.load(.monotonic) != 0) return error.ViewerInterrupted;
    // Same Rex terminal/foreground group; no inherited parent-TUI ownership.
    // No stdio pipes/resources to release with child.wait: waitpid below reaps
    // the exact child, and only then authorizes removal of its private export.
    const child = try std.process.spawn(native.io, .{ .argv = argv, .cwd = .{ .path = value.cwd }, .environ_map = &clean });
    safe_to_cleanup = false;
    try waitForViewer(native, child.id.?, &safe_to_cleanup);
}
