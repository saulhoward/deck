const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const boundary = @import("remote_contracts.zig");
const tailscale = @import("tailscale.zig");

pub fn load(native: Native, allocator: std.mem.Allocator, path: []const u8) !std.json.Parsed(wire.RemoteRegistry) {
    if (!std.fs.path.isAbsolute(path) or path.len > 4096 or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidRegistry;
    const file: std.Io.File = .{ .handle = try std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NONBLOCK = true, .NOFOLLOW = true }, 0), .flags = .{ .nonblocking = true } };
    defer file.close(native.io);
    const stat = try file.stat(native.io);
    if (stat.kind != .file or stat.size > 64 * 1024 or stat.permissions.toMode() & 0o077 != 0) return error.UnsafeRegistry;
    const bytes = try Native.readAll(native.io, file, allocator, 64 * 1024);
    defer allocator.free(bytes);
    if (!std.unicode.utf8ValidateSlice(bytes)) return error.InvalidRegistry;
    const raw = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer raw.deinit();
    if (!boundary.validRegistry(raw.value)) return error.InvalidRegistry;
    return std.json.parseFromSlice(wire.RemoteRegistry, allocator, bytes, .{ .allocate = .alloc_always });
}
pub fn run(native: Native, allocator: std.mem.Allocator, args: []const []const u8) !void {
    var registry_path: ?[]const u8 = null;
    var executable: ?[]const u8 = null;
    var machine: ?[]const u8 = null;
    var peer: ?[]const u8 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        if (i + 1 == args.len or args[i + 1].len == 0) return error.InvalidArguments;
        const slot = if (std.mem.eql(u8, args[i], "--registry")) &registry_path else if (std.mem.eql(u8, args[i], "--tailscale")) &executable else if (std.mem.eql(u8, args[i], "--machine")) &machine else if (std.mem.eql(u8, args[i], "--peer")) &peer else return error.InvalidArguments;
        if (slot.* != null) return error.InvalidArguments;
        slot.* = args[i + 1];
    }
    const address = try tailscale.endpoint(peer orelse return error.InvalidArguments);
    const id = machine orelse return error.InvalidArguments;
    if (!wire.validMachineIdentity(.{ .string = id })) return error.InvalidArguments;
    const cli = executable orelse return error.InvalidArguments;
    const registry = try load(native, allocator, registry_path orelse return error.InvalidArguments);
    defer registry.deinit();
    var registered: ?wire.RemoteHost = null;
    for (registry.value.hosts) |host| if (std.mem.eql(u8, host.machineId, id)) {
        registered = host;
        break;
    };
    const host = registered orelse return error.UnregisteredPeer;
    var cancelled: std.atomic.Value(bool) = .init(false);
    const observed = try tailscale.verify(native, allocator, cli, address, &cancelled);
    defer observed.deinit();
    if (!boundary.samePeer(host.peer, observed.value)) return error.PeerIdentityMismatch;
    const result: wire.RemoteCheckSnapshot = .{ .version = 1, .hubId = registry.value.hubId, .machineId = id, .registered = true, .client = host.client, .worker = host.implementation != null, .connection = "not_checked" };
    const output = try std.json.Stringify.valueAlloc(allocator, result, .{});
    defer allocator.free(output);
    try std.Io.File.stdout().writeStreamingAll(native.io, output);
    try std.Io.File.stdout().writeStreamingAll(native.io, "\n");
}
