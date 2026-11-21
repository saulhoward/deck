//! OS-owned process identity. Environment, argv and `ps` output are not proof.
//! Null means a kernel-confirmed missing/dead process only; all read failures
//! remain errors. No signals, process creation, or terminal handoff here.
const std = @import("std");
const builtin = @import("builtin");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
extern "c" fn tcgetpgrp(c_int) std.posix.pid_t;
extern "c" fn getsid(std.posix.pid_t) std.posix.pid_t;
extern "c" fn proc_pidinfo(c_int, c_int, u64, *anyopaque, c_int) c_int;
extern "c" fn proc_pidpath(c_int, [*]u8, u32) c_int;
extern "c" fn devname_r(std.c.dev_t, std.c.mode_t, [*]u8, c_int) ?[*:0]u8;
// Stable public libproc ABI (PROC_PIDTBSDINFO), not opaque provider data.
const BsdInfo = extern struct {
    flags: u32,
    status: u32,
    xstatus: u32,
    pid: u32,
    ppid: u32,
    uid: u32,
    gid: u32,
    ruid: u32,
    rgid: u32,
    svuid: u32,
    svgid: u32,
    reserved: u32,
    comm: [16]u8,
    name: [32]u8,
    nfiles: u32,
    pgid: u32,
    jobc: u32,
    tdev: u32,
    tpgid: u32,
    nice: i32,
    start_sec: u64,
    start_usec: u64,
};
pub const Probe = struct {
    pid: i64,
    ppid: i64,
    pgid: i64,
    uid: i64,
    start: []const u8,
    tty_dev: u64,
    foreground: i64,
    session: i64,
    // Set ONLY by the root-only Darwin probe after kernel credentials and the
    // canonical system login executable are verified. Never persisted/trusted.
    login_real_uid: ?i64 = null,
};
pub const Sample = struct { proof: wire.RexHereProcess, kernel: Probe };
fn validPid(pid: i64) !std.posix.pid_t {
    if (pid < 1 or pid > 2147483647) return error.InvalidProcess;
    return @intCast(pid);
}
fn readFile(native: Native, a: std.mem.Allocator, path: []const u8, limit: usize) ![]const u8 {
    const f = try std.Io.Dir.cwd().openFile(native.io, path, .{});
    defer f.close(native.io);
    return Native.readAll(native.io, f, a, limit);
}
const LinuxStat = struct { ppid: i64, pgid: i64, session: i64, tty: u32, foreground: i64, ticks: u64, dead: bool };
fn linuxStat(bytes: []const u8, pid: i64) !LinuxStat {
    // comm can contain spaces and parentheses; only the LAST ')' terminates it.
    const left = std.mem.indexOfScalar(u8, bytes, '(') orelse return error.InvalidProcess;
    const right = std.mem.lastIndexOfScalar(u8, bytes, ')') orelse return error.InvalidProcess;
    if (right <= left or left < 2 or try std.fmt.parseInt(i64, std.mem.trim(u8, bytes[0..left], " "), 10) != pid) return error.InvalidProcess;
    var it = std.mem.tokenizeAny(u8, bytes[right + 1 ..], " \n");
    var fields: [20][]const u8 = undefined; // fields 3 (state) through 22 (birth ticks).
    for (&fields) |*f| f.* = it.next() orelse return error.InvalidProcess;
    if (fields[0].len != 1) return error.InvalidProcess;
    const tty = try std.fmt.parseInt(i32, fields[4], 10);
    return .{ .ppid = try std.fmt.parseInt(i64, fields[1], 10), .pgid = try std.fmt.parseInt(i64, fields[2], 10), .session = try std.fmt.parseInt(i64, fields[3], 10), .tty = @bitCast(tty), .foreground = try std.fmt.parseInt(i64, fields[5], 10), .ticks = try std.fmt.parseInt(u64, fields[19], 10), .dead = fields[0][0] == 'Z' or fields[0][0] == 'X' or fields[0][0] == 'x' };
}
fn linuxUid(bytes: []const u8) !i64 {
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "Uid:")) continue;
        var it = std.mem.tokenizeAny(u8, line[4..], " \t");
        const uid = try std.fmt.parseInt(u32, it.next() orelse return error.InvalidProcess, 10);
        for (0..3) |_| if (try std.fmt.parseInt(u32, it.next() orelse return error.InvalidProcess, 10) != uid) return error.ProcessConflict;
        if (it.next() != null) return error.InvalidProcess;
        return uid;
    }
    return error.InvalidProcess;
}
pub fn probe(native: Native, a: std.mem.Allocator, pid: i64) !?Probe {
    const id = try validPid(pid);
    if (builtin.os.tag == .macos) {
        var b: BsdInfo = undefined;
        const rc = proc_pidinfo(id, 3, 0, &b, @sizeOf(BsdInfo));
        if (rc != @sizeOf(BsdInfo)) {
            if (rc <= 0 and std.c.errno(-1) == .SRCH) return null;
            return error.ProcessReadFailed;
        }
        if (b.pid != pid) return error.ProcessConflict;
        if (b.status == 5) return null; // SZOMB: the old executable is no longer alive.
        if (b.uid != b.ruid or b.uid != b.svuid) return error.ProcessConflict;
        const sid = getsid(id);
        if (sid < 1) return error.ProcessReadFailed;
        return .{ .pid = pid, .ppid = b.ppid, .pgid = b.pgid, .uid = b.uid, .start = try darwinStart(a, b.start_sec, b.start_usec), .tty_dev = b.tdev, .foreground = @as(i32, @bitCast(b.tpgid)), .session = sid };
    } else if (builtin.os.tag == .linux) {
        const path = try std.fmt.allocPrint(a, "/proc/{d}/stat", .{pid});
        const bytes = readFile(native, a, path, 8192) catch |err| {
            if (err == error.FileNotFound) {
                // A missing/unmounted procfs is a read failure, not proof all
                // clients exited. Only a missing PID in a readable procfs counts.
                _ = try linuxStat(try readFile(native, a, "/proc/self/stat", 8192), std.c.getpid());
                return null;
            }
            return err;
        };
        const stat = try linuxStat(bytes, pid);
        if (stat.dead) return null;
        const uid = try linuxUid(try readFile(native, a, try std.fmt.allocPrint(a, "/proc/{d}/status", .{pid}), 32 * 1024));
        const boot = std.mem.trim(u8, try readFile(native, a, "/proc/sys/kernel/random/boot_id", 128), "\n");
        if (!wire.validRexUuid(.{ .string = boot })) return error.InvalidProcess;
        // Linux dev_t's userspace representation preserves the encoded tty_nr bits.
        return .{ .pid = pid, .ppid = stat.ppid, .pgid = stat.pgid, .uid = uid, .start = try std.fmt.allocPrint(a, "linux:{s}:{d}", .{ boot, stat.ticks }), .tty_dev = stat.tty, .foreground = stat.foreground, .session = stat.session };
    } else return error.UnsupportedPlatform;
}
fn darwinStart(a: std.mem.Allocator, sec: u64, usec: u64) ![]const u8 {
    if (sec == 0 or usec >= 1000000) return error.InvalidProcess;
    var boot: [64]u8 = undefined;
    var len: usize = boot.len;
    if (std.c.sysctlbyname("kern.bootsessionuuid", &boot, &len, null, 0) != 0 or len < 2 or len > boot.len) return error.ProcessReadFailed;
    const uuid = std.mem.trimEnd(u8, boot[0..len], "\x00");
    for (boot[0..uuid.len]) |*c| c.* = std.ascii.toLower(c.*);
    if (!wire.validRexUuid(.{ .string = uuid })) return error.InvalidProcess;
    return std.fmt.allocPrint(a, "darwin:{s}:{d}:{d}", .{ uuid, sec, usec });
}
fn darwinExecutable(pid: i64, buf: *[4096]u8) ![]const u8 {
    const n = proc_pidpath(try validPid(pid), buf, buf.len);
    if (n <= 0 or n >= buf.len) return error.ProcessReadFailed;
    return buf[0..@intCast(n)];
}
fn rootCredentials(uid: u32, ruid: u32, saved_uid: u32, caller: u32) !?i64 {
    if (uid == caller and ruid == caller and saved_uid == caller) return null;
    // The only privilege exception is login at the EXACT Rex root, not any
    // root-owned shell, a foreign user's login, or another setuid transition.
    if (caller != 0 and uid == 0 and saved_uid == 0 and ruid == caller) return ruid;
    return error.LoginRootCredentialsMismatch;
}
fn systemLogin(pid: i64) !void {
    var buf: [4096]u8 = undefined;
    const exe = darwinExecutable(pid, &buf) catch return error.LoginRootExecutableReadFailed;
    if (!std.mem.eql(u8, exe, "/usr/bin/login")) return error.LoginRootExecutableMismatch;
    // proc_pidpath is the kernel's canonical executable path, NOT argv/comm.
    // Verify the named system file too; never follow a replacement symlink or
    // accept a caller-writable login. login need not have a setuid file bit:
    // macOS launches it as root, then it sets the caller's real UID itself.
    const fd = std.posix.openat(std.posix.AT.FDCWD, "/usr/bin/login", .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .CLOEXEC = true, .NONBLOCK = true }, 0) catch return error.LoginRootExecutableReadFailed;
    defer Native.close(fd);
    var stat: std.c.Stat = undefined;
    if (std.c.fstat(fd, &stat) != 0) return error.LoginRootExecutableReadFailed;
    if (stat.mode & std.c.S.IFMT != std.c.S.IFREG or stat.uid != 0 or stat.mode & 0o022 != 0 or stat.mode & 0o111 == 0) return error.LoginRootExecutableMismatch;
}
/// Root-only kernel read. Darwin libproc denies even BSD info for system login
/// (euid=svuid=0, ruid=caller); public KERN_PROC_PID provides the complete birth,
/// credentials, ancestry and terminal identity without relaxing read failures.
/// Do NOT use this for clients, foreground processes or intermediate ancestors.
fn probeRoot(native: Native, a: std.mem.Allocator, pid: i64) !?Probe {
    if (builtin.os.tag != .macos) return probe(native, a, pid);
    const id = try validPid(pid);
    const k = (try @import("rex_here_darwin.zig").read(id)) orelse return null;
    const e = k.kp_eproc;
    const caller = std.c.getuid();
    if (std.c.geteuid() != caller) return error.ProcessConflict;
    const login_uid = try rootCredentials(e.e_ucred.cr_uid, e.e_pcred.p_ruid, e.e_pcred.p_svuid, caller);
    if (login_uid != null) {
        try systemLogin(pid);
        if (k.kp_proc.p_flag & 0x2 == 0) return error.NotTerminal; // P_CONTROLT
    }
    const sid = getsid(id);
    if (sid < 1) return error.RootProcessReadFailed;
    const birth = k.kp_proc.p_un.p_starttime;
    return .{ .pid = pid, .ppid = e.e_ppid, .pgid = e.e_pgid, .uid = e.e_ucred.cr_uid, .start = try darwinStart(a, @intCast(birth.tv_sec), @intCast(birth.tv_usec)), .tty_dev = @as(u32, @bitCast(e.e_tdev)), .foreground = e.e_tpgid, .session = sid, .login_real_uid = login_uid };
}
/// This predicate consumes a freshly kernel-verified Sample, never record data.
fn rootOwnedBy(root: Sample, uid: i64) bool {
    if (root.kernel.login_real_uid) |real_uid| {
        return builtin.os.tag == .macos and uid != 0 and real_uid == uid and root.kernel.uid == 0 and std.mem.eql(u8, root.proof.executable, "/usr/bin/login");
    }
    return root.kernel.uid == uid;
}
fn ttyPath(a: std.mem.Allocator, dev: u64) ![]const u8 {
    if (dev == 0 or dev == 0xffffffff) return error.NotTerminal;
    if (builtin.os.tag == .macos) {
        var buf: [128]u8 = undefined;
        const name = devname_r(@bitCast(@as(u32, @intCast(dev))), std.c.S.IFCHR, &buf, buf.len) orelse return error.NotTerminal;
        const text = std.mem.span(name);
        // Rex terminals are PTYs, never serial/console aliases.
        if (!std.mem.startsWith(u8, text, "ttys") or std.mem.indexOfScalar(u8, text, '/') != null) return error.NotTerminal;
        return std.fmt.allocPrint(a, "/dev/{s}", .{text});
    } else if (builtin.os.tag == .linux) {
        const major = (dev >> 8) & 0xfff;
        const minor = (dev & 0xff) | ((dev >> 12) & 0xfff00);
        if (major < 136 or major > 143) return error.NotTerminal;
        return std.fmt.allocPrint(a, "/dev/pts/{d}", .{(major - 136) * 256 + minor});
    } else return error.UnsupportedPlatform;
}
/// Bind the kernel controlling-terminal device to the actual PTY and its current
/// foreground group, without taking ownership or changing the terminal.
fn terminal(p: Probe, path: [:0]const u8) !void {
    const fd = try std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY, .NOCTTY = true, .NONBLOCK = true, .CLOEXEC = true, .NOFOLLOW = true }, 0);
    defer Native.close(fd);
    if (builtin.os.tag == .linux) {
        const linux = std.os.linux;
        var stat: linux.Statx = undefined;
        if (linux.errno(linux.statx(fd, "", linux.AT.EMPTY_PATH, .{ .TYPE = true }, &stat)) != .SUCCESS or !stat.mask.TYPE) return error.ProcessReadFailed;
        if (stat.mode & std.c.S.IFMT != std.c.S.IFCHR or stat.rdev_major != (p.tty_dev >> 8) & 0xfff or stat.rdev_minor != (p.tty_dev & 0xff) | ((p.tty_dev >> 12) & 0xfff00)) return error.ProcessConflict;
    } else {
        var stat: std.c.Stat = undefined;
        if (std.c.fstat(fd, &stat) != 0) return error.ProcessReadFailed;
        if (stat.mode & std.c.S.IFMT != std.c.S.IFCHR or @as(u32, @bitCast(stat.rdev)) != p.tty_dev) return error.ProcessConflict;
    }
    if (p.foreground < 1) return error.ProcessConflict;
    // Darwin rejects tcgetpgrp on another session's controlling terminal. A
    // worker must still inspect its client: libproc e_tpgid (/proc tpgid on
    // Linux) is the kernel's foreground group for e_tdev, not a Rex/shell hint.
    // For capture and same-session reads additionally cross-check the ioctl.
    const own_session = getsid(0);
    if (own_session < 1) return error.ProcessReadFailed;
    if (own_session == p.session) {
        const fg = tcgetpgrp(fd);
        if (fg < 1) return error.ProcessReadFailed;
        if (fg != p.foreground) return error.ProcessConflict;
    }
}
pub fn sameProbe(left: Probe, right: Probe) bool {
    return left.pid == right.pid and left.ppid == right.ppid and left.pgid == right.pgid and left.uid == right.uid and left.tty_dev == right.tty_dev and left.foreground == right.foreground and left.session == right.session and left.login_real_uid == right.login_real_uid and std.mem.eql(u8, left.start, right.start);
}
pub fn sample(native: Native, a: std.mem.Allocator, pid: i64) !Sample {
    return sampleImpl(native, a, pid, false);
}
/// Only the exact Rex terminal child/root may use this entry point.
pub fn sampleRoot(native: Native, a: std.mem.Allocator, pid: i64) !Sample {
    return sampleImpl(native, a, pid, true);
}
fn sampleImpl(native: Native, a: std.mem.Allocator, pid: i64, root: bool) !Sample {
    const p = (try (if (root) probeRoot(native, a, pid) else probe(native, a, pid))) orelse return error.ProcessGone;
    const tty = try ttyPath(a, p.tty_dev);
    try terminal(p, try a.dupeSentinel(u8, tty, 0));
    var buf: [4096]u8 = undefined;
    const exe = if (builtin.os.tag == .macos) try darwinExecutable(pid, &buf) else if (builtin.os.tag == .linux) blk: {
        const n = try std.Io.Dir.cwd().readLink(native.io, try std.fmt.allocPrint(a, "/proc/{d}/exe", .{pid}), &buf);
        if (n == buf.len or std.mem.endsWith(u8, buf[0..n], " (deleted)")) return error.ProcessReadFailed;
        break :blk buf[0..n];
    } else return error.UnsupportedPlatform;
    if (!@import("mcp_profiles.zig").absolute(exe)) return error.InvalidProcess;
    if (p.login_real_uid != null and !std.mem.eql(u8, exe, "/usr/bin/login")) return error.LoginRootExecutableMismatch;
    if (!sameProbe(p, (try (if (root) probeRoot(native, a, pid) else probe(native, a, pid))) orelse return error.ProcessReadFailed)) return error.ProcessConflict;
    return .{ .kernel = p, .proof = .{ .pid = pid, .ppid = p.ppid, .pgid = p.pgid, .uid = p.uid, .start = p.start, .tty = tty, .executable = try a.dupe(u8, exe) } };
}
pub fn same(left: wire.RexHereProcess, right: wire.RexHereProcess) bool {
    return left.pid == right.pid and left.ppid == right.ppid and left.pgid == right.pgid and left.uid == right.uid and std.mem.eql(u8, left.start, right.start) and std.mem.eql(u8, left.tty, right.tty) and std.mem.eql(u8, left.executable, right.executable);
}
/// Walk only to the exact terminal root, never to an arbitrary surviving shell.
/// Every link is kernel-read, caller-owned, same session/TTY and rechecked.
/// Only the final EXACT root may be a verified privileged system login.
pub fn descendant(native: Native, a: std.mem.Allocator, child: Sample, root: Sample) !void {
    const caller = std.c.getuid();
    if (std.c.geteuid() != caller or child.kernel.uid != caller or child.kernel.login_real_uid != null or !rootOwnedBy(root, caller)) return error.ProcessConflict;
    var chain: [65]Probe = undefined;
    var used: usize = 0;
    var current = child.kernel;
    while (true) {
        if (current.tty_dev != root.kernel.tty_dev or current.session != root.kernel.session or current.foreground != root.kernel.foreground) return error.ProcessConflict;
        if (current.pid != root.proof.pid and (current.uid != caller or current.login_real_uid != null)) return error.ProcessConflict;
        for (chain[0..used]) |old| if (old.pid == current.pid) return error.ProcessConflict;
        chain[used] = current;
        used += 1;
        if (current.pid == root.proof.pid) {
            if (!sameProbe(current, root.kernel)) return error.ProcessConflict;
            break;
        }
        if (used == chain.len or current.ppid < 1) return error.ProcessConflict;
        current = (try (if (current.ppid == root.proof.pid) probeRoot(native, a, current.ppid) else probe(native, a, current.ppid))) orelse return error.ProcessReadFailed;
    }
    for (chain[0..used]) |old| {
        const again = (try (if (old.pid == root.proof.pid) probeRoot(native, a, old.pid) else probe(native, a, old.pid))) orelse return error.ProcessReadFailed;
        if (!sameProbe(old, again)) return error.ProcessConflict;
    }
}

test "Linux stat parsing is bounded and comm cannot forge birth or ancestry" {
    const s = try linuxStat("42 (a tricky ) name) S 2 42 2 34816 42 0 0 0 0 0 0 0 0 0 0 0 0 0 123456 0", 42);
    try std.testing.expectEqual(123456, s.ticks);
    try std.testing.expectEqual(2, s.ppid);
    try std.testing.expectEqual(42, s.foreground);
    try std.testing.expectError(error.InvalidProcess, linuxStat("41 (wrong) S", 42));
    try std.testing.expectError(error.InvalidProcess, linuxStat("42 (short) S 2", 42));
    try std.testing.expectError(error.ProcessConflict, linuxUid("Uid:\t1000 0 0 0\n"));
}
test "native birth identity reads this actual process; impossible PID is absent" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const p = (try probe(Native.testing(), arena.allocator(), std.c.getpid())).?;
    try std.testing.expectEqual(std.c.getuid(), p.uid);
    try std.testing.expect(p.start.len > 36 and p.start.len <= 128);
    try std.testing.expectEqual(null, try probe(Native.testing(), arena.allocator(), 2147483647));
    try std.testing.expectError(error.InvalidProcess, probe(Native.testing(), arena.allocator(), 0));
}

test "root credential exception is only real-caller effective-and-saved-root" {
    try std.testing.expectEqual(null, try rootCredentials(501, 501, 501, 501));
    try std.testing.expectEqual(null, try rootCredentials(0, 0, 0, 0));
    try std.testing.expectEqual(@as(?i64, 501), try rootCredentials(0, 501, 0, 501));
    for ([_][4]u32{
        .{ 0, 0, 0, 501 }, // arbitrary root, not caller's login
        .{ 0, 502, 0, 501 }, // another user's login
        .{ 0, 501, 501, 501 }, // wrong saved UID
        .{ 501, 501, 0, 501 }, // ordinary client retaining saved privilege
        .{ 502, 501, 502, 501 }, // other setuid executable
        .{ 502, 502, 502, 501 }, // foreign ordinary root
    }) |ids| try std.testing.expectError(error.LoginRootCredentialsMismatch, rootCredentials(ids[0], ids[1], ids[2], ids[3]));
}

test "root-only Darwin sysctl matches libproc birth UID ancestry and terminal" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const normal = (try probe(Native.testing(), a, std.c.getpid())).?;
    const root = (try probeRoot(Native.testing(), a, std.c.getpid())).?;
    try std.testing.expect(sameProbe(normal, root));
    try std.testing.expectEqual(null, root.login_real_uid);
    try std.testing.expectEqual(null, try probeRoot(Native.testing(), a, 2147483647));
    try std.testing.expectError(error.InvalidProcess, probeRoot(Native.testing(), a, 0));
    try std.testing.expectError(error.LoginRootExecutableMismatch, systemLogin(std.c.getpid()));
    var changed = root;
    changed.login_real_uid = std.c.getuid();
    try std.testing.expect(!sameProbe(root, changed));
}
