const std = @import("std");
const Native = @import("native.zig");
const shell = @import("shell.zig");
const wire = @import("generated/contracts.zig");
const endpoint = @import("rex_endpoint.zig");
fn refused(code: []const u8) shell.Result {
    return .{ .ok = false, .code = code, .output = code };
}
fn absolute(path: []const u8) bool {
    return path.len > 0 and path.len <= 4096 and path[0] == '/' and std.mem.indexOfScalar(u8, path, 0) == null;
}
fn findRex(native: Native, allocator: std.mem.Allocator) ![]const u8 {
    const path = try native.environ.getAlloc(allocator, "PATH");
    defer allocator.free(path);
    var dirs = std.mem.splitScalar(u8, path, ':');
    while (dirs.next()) |dir| {
        // Never search the task workspace via an empty/relative PATH component.
        if (!absolute(dir)) continue;
        const candidate = try std.fs.path.join(allocator, &.{ dir, "rex" });
        defer allocator.free(candidate);
        if (!absolute(candidate)) continue;
        std.Io.Dir.cwd().access(native.io, candidate, .{ .execute = true }) catch continue;
        const stat = std.Io.Dir.cwd().statFile(native.io, candidate, .{}) catch continue;
        if (stat.kind == .file) return allocator.dupe(u8, candidate);
    }
    return error.FileNotFound;
}

// Read-only discovery on the assigned worker. No receipt, Pi task, server start,
// session lookup, terminal creation or implicit remote/home-host routing.
pub fn resolve(native: Native, allocator: std.mem.Allocator, cwd: []const u8, encoded: []const u8, cancelled: *std.atomic.Value(bool)) !shell.Result {
    if (encoded.len > 16 * 1024 or !std.fs.path.isAbsolute(cwd)) return refused("invalid");
    const parsed = wire.parseRexTargetOptions(allocator, encoded) catch return refused("invalid");
    defer parsed.deinit();
    const options = parsed.value;
    const executable = options.executable orelse (findRex(native, allocator) catch return refused("rex_unavailable"));
    if (!absolute(executable)) return refused("invalid");
    if (options.server) |server| {
        if (!endpoint.valid(server)) return refused("invalid");
    }
    var argv: std.array_list.Managed([]const u8) = .init(allocator);
    defer argv.deinit();
    try argv.appendSlice(&.{ executable, "--autostart=false", "--timeout", "2s" });
    if (options.server) |server| try argv.appendSlice(&.{ "--server", server });
    try argv.appendSlice(&.{ "server", "status", "--json" });
    // Raw runner drops REX_SERVER/HOME/focus and credential env overrides. With
    // no --server Rex uses its per-account local Unix socket, not a host label.
    const result = shell.runArgvCaptured(native, allocator, cwd, argv.items, 4, cancelled) catch return refused("rex_unavailable");
    if (!result.result.ok or result.result.truncated or cancelled.load(.acquire)) return refused("rex_unavailable");
    const Status = struct { endpoint: []const u8, host_id: []const u8, instance_id: []const u8, api_revision: u32, you: struct { transport: []const u8 } };
    const status = std.json.parseFromSlice(Status, allocator, result.stdout, .{ .ignore_unknown_fields = true }) catch return refused("rex_unavailable");
    defer status.deinit();
    const value = status.value;
    if (!@import("rex.zig").supportedApi(value.api_revision) or !std.mem.eql(u8, value.you.transport, "unix") or !endpoint.valid(value.endpoint)) return refused("rex_unavailable");
    if (options.server) |server| {
        if (!endpoint.same(server, value.endpoint)) return refused("rex_unavailable");
    }
    if (options.hostId) |host| {
        if (!std.mem.eql(u8, host, value.host_id)) return refused("rex_unavailable");
    }
    if (options.instanceId) |instance| {
        if (!std.mem.eql(u8, instance, value.instance_id)) return refused("rex_unavailable");
    }
    const target: wire.RexOpenTarget = .{ .executable = executable, .server = value.endpoint, .hostId = value.host_id, .instanceId = value.instance_id };
    const output = try std.json.Stringify.valueAlloc(allocator, target, .{});
    const checked = wire.parseRexOpenTarget(allocator, output) catch return refused("rex_unavailable");
    checked.deinit();
    return .{ .ok = true, .code = "rex_resolved", .output = output };
}
