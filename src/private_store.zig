//! Small native client/connection metadata, not a task store or execution queue.
const std = @import("std");
const Native = @import("native.zig");
fn owner(fd: std.posix.fd_t) !void {
    const uid = if (@import("builtin").os.tag == .linux) blk: {
        const linux = std.os.linux;
        var info: linux.Statx = undefined;
        while (true) switch (linux.errno(linux.statx(fd, "", linux.AT.EMPTY_PATH, .{ .UID = true }, &info))) {
            .SUCCESS => break,
            .INTR => continue,
            else => return error.UnsafeClientStorage,
        };
        if (!info.mask.UID) return error.UnsafeClientStorage;
        break :blk info.uid;
    } else blk: {
        var info: std.c.Stat = undefined;
        if (std.c.fstat(fd, &info) != 0) return error.UnsafeClientStorage;
        break :blk info.uid;
    };
    if (uid != std.c.geteuid()) return error.UnsafeClientStorage;
}
pub fn directory(native: Native, path: []const u8) !std.Io.Dir {
    return openDirectory(native, path, true);
}
pub fn openDirectory(native: Native, path: []const u8, create: bool) !std.Io.Dir {
    if (!@import("mcp_profiles.zig").absolute(path)) return error.UnsafeClientStorage;
    const missing = if (std.Io.Dir.cwd().statFile(native.io, path, .{ .follow_symlinks = false })) |_| false else |err| switch (err) {
        error.FileNotFound => true,
        else => return err,
    };
    if (missing and !create) return error.FileNotFound;
    if (missing) try std.Io.Dir.cwd().createDirPath(native.io, path);
    const fd = try std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY, .DIRECTORY = true, .CLOEXEC = true, .NOFOLLOW = true }, 0);
    var dir: std.Io.Dir = .{ .handle = fd };
    errdefer dir.close(native.io);
    try owner(fd);
    if (missing) try dir.setPermissions(native.io, .fromMode(0o700));
    const info = try (std.Io.File{ .handle = fd, .flags = .{ .nonblocking = false } }).stat(native.io);
    if (info.kind != .directory or info.permissions.toMode() & 0o077 != 0) return error.UnsafeClientStorage;
    return dir;
}
pub fn lock(native: Native, dir: std.Io.Dir, name: []const u8) !std.Io.File {
    const fd = try std.posix.openat(dir.handle, name, .{ .ACCMODE = .RDWR, .CREAT = true, .CLOEXEC = true, .NOFOLLOW = true, .NONBLOCK = true }, 0o600);
    const file: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = true } };
    errdefer file.close(native.io);
    try owner(fd);
    const info = try file.stat(native.io);
    if (info.kind != .file or info.permissions.toMode() & 0o077 != 0) return error.UnsafeClientStorage;
    if (!try file.tryLock(native.io, .exclusive)) return error.ClientAlreadyStarting;
    return file;
}
// A live handoff inherits the SAME flock description across exec. Compare
// device+inode against the private lock name; a supplied FD is not authority.
pub fn inheritedLock(native: Native, dir: std.Io.Dir, fd: std.posix.fd_t) !std.Io.File {
    if (fd < 3) return error.InvalidHandoffLock;
    const held: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = false } };
    const other_fd = try std.posix.openat(dir.handle, "writer.lock", .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NOFOLLOW = true, .NONBLOCK = true }, 0);
    defer Native.close(other_fd);
    try owner(fd);
    try owner(other_fd);
    for ([_]std.posix.fd_t{ fd, other_fd }) |candidate| {
        const info = try (std.Io.File{ .handle = candidate, .flags = .{ .nonblocking = false } }).stat(native.io);
        if (info.kind != .file or info.permissions.toMode() & 0o077 != 0) return error.InvalidHandoffLock;
    }
    if (!std.mem.eql(u64, &try fileKey(fd), &try fileKey(other_fd)) or !try held.tryLock(native.io, .exclusive)) return error.InvalidHandoffLock;
    _ = try Native.fcntl(fd, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
    return held;
}
fn fileKey(fd: std.posix.fd_t) ![3]u64 {
    if (@import("builtin").os.tag == .linux) {
        const linux = std.os.linux;
        var info: linux.Statx = undefined;
        while (true) switch (linux.errno(linux.statx(fd, "", linux.AT.EMPTY_PATH, .{ .INO = true }, &info))) {
            .SUCCESS => break,
            .INTR => continue,
            else => return error.InvalidHandoffLock,
        };
        if (!info.mask.INO) return error.InvalidHandoffLock;
        return .{ info.dev_major, info.dev_minor, info.ino };
    } else {
        var info: std.c.Stat = undefined;
        if (std.c.fstat(fd, &info) != 0) return error.InvalidHandoffLock;
        return .{ @intCast(info.dev), 0, info.ino };
    }
}
pub fn save(native: Native, allocator: std.mem.Allocator, dir: std.Io.Dir, name: []const u8, value: anytype) !void {
    const bytes = try std.json.Stringify.valueAlloc(allocator, value, .{});
    defer allocator.free(bytes);
    if (bytes.len > 64 * 1024) return error.InvalidClientMetadata;
    var random: [16]u8 = undefined;
    native.io.random(&random);
    const temporary = try std.fmt.allocPrint(allocator, ".{s}.tmp", .{std.fmt.bytesToHex(random, .lower)});
    defer allocator.free(temporary);
    defer dir.deleteFile(native.io, temporary) catch {};
    const file = try dir.createFile(native.io, temporary, .{ .exclusive = true, .permissions = .fromMode(0o600) });
    defer file.close(native.io);
    try file.writeStreamingAll(native.io, bytes);
    try file.sync(native.io);
    try dir.rename(temporary, dir, name, native.io);
    try (std.Io.File{ .handle = dir.handle, .flags = .{ .nonblocking = false } }).sync(native.io);
}
