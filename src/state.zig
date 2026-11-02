const std = @import("std");

pub const Config = struct { version: u32 = 1, machine_id: []const u8 };

pub fn directory(allocator: std.mem.Allocator, override: ?[]const u8) ![]const u8 {
    if (override) |path| {
        const cwd = try std.process.getCwdAlloc(allocator);
        defer allocator.free(cwd);
        return std.fs.path.resolve(allocator, &.{ cwd, path });
    }
    const home = try std.process.getEnvVarOwned(allocator, "HOME");
    defer allocator.free(home);
    if (@import("builtin").os.tag == .macos) return std.fs.path.join(allocator, &.{ home, "Library", "Application Support", "deck" });
    const xdg = std.process.getEnvVarOwned(allocator, "XDG_STATE_HOME") catch return std.fs.path.join(allocator, &.{ home, ".local", "state", "deck" });
    defer allocator.free(xdg);
    return std.fs.path.join(allocator, &.{ xdg, "deck" });
}

pub fn lock(dir: std.fs.Dir) !std.fs.File {
    return dir.createFile("writer.lock", .{ .truncate = false, .read = true, .mode = 0o600, .lock = .exclusive, .lock_nonblocking = true });
}

pub fn initialize(allocator: std.mem.Allocator, path: []const u8) !void {
    try std.fs.cwd().makePath(path);
    var dir = try std.fs.cwd().openDir(path, .{});
    defer dir.close();
    const held = try lock(dir);
    defer held.close();
    if (dir.access("config.json", .{})) |_| {
        const existing = try load(allocator, dir);
        existing.deinit();
        return;
    } else |err| if (err != error.FileNotFound) return err;
    // Only set permissions on a directory we are initializing, not on arbitrary ancestors.
    try dir.chmod(0o700);
    var bytes: [16]u8 = undefined;
    std.crypto.random.bytes(&bytes);
    const id = std.fmt.bytesToHex(bytes, .lower);
    const data = try std.json.Stringify.valueAlloc(allocator, Config{ .machine_id = &id }, .{});
    defer allocator.free(data);
    // Rename is atomic; a crash leaves either no config or a complete config. Lock serializes init.
    const file = try dir.createFile("config.json.tmp", .{ .mode = 0o600 });
    defer file.close();
    try file.writeAll(data);
    try file.sync();
    try dir.rename("config.json.tmp", "config.json");
}

pub fn load(allocator: std.mem.Allocator, dir: std.fs.Dir) !std.json.Parsed(Config) {
    const data = try dir.readFileAlloc(allocator, "config.json", 16 * 1024);
    defer allocator.free(data);
    const parsed = try std.json.parseFromSlice(Config, allocator, data, .{ .allocate = .alloc_always });
    errdefer parsed.deinit();
    if (parsed.value.version != 1 or parsed.value.machine_id.len != 32) return error.InvalidConfig;
    for (parsed.value.machine_id) |byte| if (!std.ascii.isHex(byte)) return error.InvalidConfig;
    return parsed;
}

test "init is private, idempotent and refuses incompatible config" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const allocator = std.testing.allocator;
    const path = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(path);
    try initialize(allocator, path);
    const first = try tmp.dir.readFileAlloc(allocator, "config.json", 1024);
    defer allocator.free(first);
    try initialize(allocator, path);
    const second = try tmp.dir.readFileAlloc(allocator, "config.json", 1024);
    defer allocator.free(second);
    try std.testing.expectEqualStrings(first, second);
    try tmp.dir.writeFile(.{ .sub_path = "config.json", .data = "{\"version\":2,\"machine_id\":\"bad\"}" });
    try std.testing.expectError(error.InvalidConfig, initialize(allocator, path));
}

test "a second writer cannot acquire the lock" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const first = try lock(tmp.dir);
    defer first.close();
    try std.testing.expectError(error.WouldBlock, lock(tmp.dir));
}
