const std = @import("std");

pub fn node(allocator: std.mem.Allocator) ![]const u8 {
    return std.process.getEnvVarOwned(allocator, "DECK_NODE") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => allocator.dupe(u8, "node"),
        else => return err,
    };
}

pub fn entry(allocator: std.mem.Allocator, override: ?[]const u8, name: []const u8) ![]const u8 {
    if (override) |path| return std.fs.cwd().realpathAlloc(allocator, path);
    const root = std.process.getEnvVarOwned(allocator, "DECK_RUNTIME_ROOT") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try std.process.getCwdAlloc(allocator),
        else => return err,
    };
    defer allocator.free(root);
    const path = try std.fs.path.join(allocator, &.{ root, "runtime", "dist", name });
    defer allocator.free(path);
    return std.fs.cwd().realpathAlloc(allocator, path);
}
