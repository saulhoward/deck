const std = @import("std");
const Native = @import("native.zig");
const Io = std.Io;

pub const Config = struct { version: u32 = 1, machine_id: []const u8 };

pub fn directory(native: Native, allocator: std.mem.Allocator, override: ?[]const u8) ![]const u8 {
    if (override) |path| {
        const cwd = try std.process.currentPathAlloc(native.io, allocator);
        defer allocator.free(cwd);
        return std.fs.path.resolve(allocator, &.{ cwd, path });
    }
    const home = try native.environ.getAlloc(allocator, "HOME");
    defer allocator.free(home);
    if (@import("builtin").os.tag == .macos) return std.fs.path.join(allocator, &.{ home, "Library", "Application Support", "deck" });
    const xdg = native.environ.getAlloc(allocator, "XDG_STATE_HOME") catch return std.fs.path.join(allocator, &.{ home, ".local", "state", "deck" });
    defer allocator.free(xdg);
    return std.fs.path.join(allocator, &.{ xdg, "deck" });
}

pub fn lock(io: Io, dir: Io.Dir) !Io.File {
    return dir.createFile(io, "writer.lock", .{ .truncate = false, .read = true, .permissions = .fromMode(0o600), .lock = .exclusive, .lock_nonblocking = true });
}

pub fn requireComplete(io: Io, dir: Io.Dir) !void {
    if (dir.statFile(io, ".restore-incomplete", .{ .follow_symlinks = false })) |_| return error.RestoreIncomplete else |err| if (err != error.FileNotFound) return err;
}

// A restore destination is never an existing directory, even an empty one.
// The caller acquires its writer lock before adding the incomplete marker.
pub fn restoreDirectory(io: Io, allocator: std.mem.Allocator, source: []const u8, destination: []const u8) !void {
    const from = try Io.Dir.cwd().realPathFileAlloc(io, source, allocator);
    defer allocator.free(from);
    const parent = try Io.Dir.cwd().realPathFileAlloc(io, std.fs.path.dirname(destination) orelse return error.InvalidArguments, allocator);
    defer allocator.free(parent);
    const target = try std.fs.path.join(allocator, &.{ parent, std.fs.path.basename(destination) });
    defer allocator.free(target);
    if (std.mem.eql(u8, from, target) or (std.mem.startsWith(u8, target, from) and target.len > from.len and target[from.len] == std.fs.path.sep)) return error.InvalidArguments;
    try Io.Dir.cwd().createDir(io, destination, .fromMode(0o700));
}

pub fn markRestore(io: Io, dir: Io.Dir) !void {
    var entries = dir.iterate();
    while (try entries.next(io)) |entry| if (!std.mem.eql(u8, entry.name, "writer.lock")) return error.PathAlreadyExists;
    try dir.setPermissions(io, .fromMode(0o700));
    const marker = try dir.createFile(io, ".restore-incomplete", .{ .exclusive = true, .permissions = .fromMode(0o600) });
    defer marker.close(io);
    try marker.writeStreamingAll(io, "Incomplete restore; init and serve must refuse this directory.\n");
    try marker.sync(io);
}

pub fn initialize(io: Io, allocator: std.mem.Allocator, path: []const u8) !void {
    try Io.Dir.cwd().createDirPath(io, path);
    var dir = try Io.Dir.cwd().openDir(io, path, .{});
    defer dir.close(io);
    const held = try lock(io, dir);
    defer held.close(io);
    try requireComplete(io, dir);
    if (dir.access(io, "config.json", .{})) |_| {
        const existing = try load(io, allocator, dir);
        existing.deinit();
        return;
    } else |err| if (err != error.FileNotFound) return err;
    // Only set permissions on a directory we are initializing, not on arbitrary ancestors.
    try dir.setPermissions(io, .fromMode(0o700));
    var bytes: [16]u8 = undefined;
    io.random(&bytes);
    const id = std.fmt.bytesToHex(bytes, .lower);
    const data = try std.json.Stringify.valueAlloc(allocator, Config{ .machine_id = &id }, .{});
    defer allocator.free(data);
    // Rename is atomic; a crash leaves either no config or a complete config. Lock serializes init.
    const file = try dir.createFile(io, "config.json.tmp", .{ .permissions = .fromMode(0o600) });
    defer file.close(io);
    try file.writeStreamingAll(io, data);
    try file.sync(io);
    try dir.rename("config.json.tmp", dir, "config.json", io);
}

pub fn load(io: Io, allocator: std.mem.Allocator, dir: Io.Dir) !std.json.Parsed(Config) {
    try requireComplete(io, dir);
    const data = try dir.readFileAlloc(io, "config.json", allocator, .limited(16 * 1024));
    defer allocator.free(data);
    const parsed = try std.json.parseFromSlice(Config, allocator, data, .{ .allocate = .alloc_always });
    errdefer parsed.deinit();
    if (parsed.value.version != 1 or parsed.value.machine_id.len != 32) return error.InvalidConfig;
    for (parsed.value.machine_id) |byte| if (!std.ascii.isHex(byte)) return error.InvalidConfig;
    return parsed;
}

test "init is private, idempotent and refuses incompatible config" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    const path = try tmp.dir.realPathFileAlloc(io, ".", allocator);
    defer allocator.free(path);
    try initialize(io, allocator, path);
    const first = try tmp.dir.readFileAlloc(io, "config.json", allocator, .limited(1024));
    defer allocator.free(first);
    try initialize(io, allocator, path);
    const second = try tmp.dir.readFileAlloc(io, "config.json", allocator, .limited(1024));
    defer allocator.free(second);
    try std.testing.expectEqualStrings(first, second);
    try tmp.dir.writeFile(io, .{ .sub_path = "config.json", .data = "{\"version\":2,\"machine_id\":\"bad\"}" });
    try std.testing.expectError(error.InvalidConfig, initialize(io, allocator, path));
}

test "incomplete restore rejects both init and config loading without inventing identity" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    const path = try tmp.dir.realPathFileAlloc(io, ".", allocator);
    defer allocator.free(path);
    try tmp.dir.writeFile(io, .{ .sub_path = ".restore-incomplete", .data = "incomplete" });
    try std.testing.expectError(error.RestoreIncomplete, initialize(io, allocator, path));
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "config.json", .{}));
    try tmp.dir.writeFile(io, .{ .sub_path = "config.json", .data = "{\"version\":1,\"machine_id\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}" });
    try std.testing.expectError(error.RestoreIncomplete, load(io, allocator, tmp.dir));
}

test "a second writer cannot acquire the lock" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const first = try lock(io, tmp.dir);
    defer first.close(io);
    try std.testing.expectError(error.WouldBlock, lock(io, tmp.dir));
}
