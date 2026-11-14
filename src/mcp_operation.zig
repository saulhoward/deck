//! Operation-specific v2 receipts; original native v1 receipts stay untouched.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const schema = @import("mcp_schema.zig");
const profiles = @import("mcp_profiles.zig");
const transport = @import("mcp_stdio.zig");
const boundary = @import("native_contracts.zig");
const Result = @import("shell.zig").Result;
fn retained(native: Native, a: std.mem.Allocator, dir: std.Io.Dir, name: []const u8, hash: []const u8) !?Result {
    const fd = std.posix.openat(dir.handle, name, .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .CLOEXEC = true, .NONBLOCK = true }, 0) catch |e| {
        if (e == error.FileNotFound) return null;
        return e;
    };
    const f: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = true } };
    defer f.close(native.io);
    const stat = try f.stat(native.io);
    if (stat.kind != .file or stat.size > 1024 * 1024) return error.InvalidReceipt;
    const bytes = try Native.readAll(native.io, f, a, 1024 * 1024);
    const raw = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    if (wire.validNativeReceipt(raw.value)) return .{ .ok = false, .code = "conflict", .output = "Operation ID already belongs to a different native request" };
    const p = try wire.parseMcpReceipt(a, bytes);
    if (!std.mem.eql(u8, p.value.hash, hash)) return .{ .ok = false, .code = "conflict", .output = "Operation ID reused with conflicting MCP request bytes" };
    const result = p.value.result orelse return .{ .ok = false, .code = "effect_uncertain", .output = "effect_uncertain: MCP accepted without a retained result; not repeated" };
    if (!boundary.validResult(.mcp_call, raw.value.object.get("result").?)) return error.InvalidReceipt;
    return .{ .ok = result.ok, .output = result.output, .code = result.code orelse return error.InvalidReceipt, .truncated = result.truncated orelse false };
}
fn syncDirectory(native: Native, dir: std.Io.Dir) !void {
    // File fsync alone does not make a newly published receipt name durable.
    // A default Dir is O_PATH on Linux, which cannot be fsynced. Open a readable
    // handle relative to it so we sync the same directory without closing the caller's handle.
    const file = try dir.openFile(native.io, ".", .{});
    defer file.close(native.io);
    try file.sync(native.io);
}
fn save(native: Native, a: std.mem.Allocator, dir: std.Io.Dir, name: []const u8, hash: []const u8, result: ?Result) !void {
    const bytes = try std.json.Stringify.valueAlloc(a, .{ .version = 2, .kind = "mcp", .hash = hash, .result = result }, .{});
    var nonce: [16]u8 = undefined;
    native.io.random(&nonce);
    const hex = std.fmt.bytesToHex(nonce, .lower);
    const temp = try std.fmt.allocPrint(a, "{s}.{s}.mcp-tmp", .{ name, hex });
    const f = try dir.createFile(native.io, temp, .{ .exclusive = true, .permissions = .fromMode(0o600) });
    defer f.close(native.io);
    defer dir.deleteFile(native.io, temp) catch {};
    try f.writeStreamingAll(native.io, bytes);
    try f.sync(native.io);
    if (result == null) try dir.hardLink(temp, dir, name, native.io, .{}) else try dir.rename(temp, dir, name, native.io);
    try syncDirectory(native, dir);
}
pub fn operation(native: Native, a: std.mem.Allocator, dir: std.Io.Dir, machine: []const u8, body: []const u8, request: wire.NativeRequest, cancelled: *std.atomic.Value(bool), configured: ?*const profiles.Profiles, hub_service: bool) !Result {
    if (!std.mem.eql(u8, machine, request.machineId)) return .{ .ok = false, .code = "offline", .output = "Assigned MCP host unavailable; no fallback" };
    const digest = profiles.hash(body);
    const name = try std.fmt.allocPrint(a, "{s}.json", .{request.id});
    if (try retained(native, a, dir, name, &digest)) |result| return result;
    const config = configured orelse return .{ .ok = false, .code = "mcp_refused", .output = "MCP is not approved on this host; tool not dispatched" };
    const parsed = try wire.parseMcpCallPlan(a, request.args.plan.?);
    const plan = parsed.value;
    const index = config.index(plan.profileId, plan.revision) orelse return .{ .ok = false, .code = "mcp_refused", .output = "MCP profile/revision unavailable; tool not dispatched" };
    const profile = config.config.profiles[index];
    const stale_name = try std.fmt.allocPrint(a, "mcp-{s}.stale", .{plan.revision});
    if (dir.statFile(native.io, stale_name, .{ .follow_symlinks = false })) |_| return .{ .ok = false, .code = "mcp_catalog_changed", .output = "MCP profile is stale; review and approve a new configuration revision" } else |err| {
        if (err != error.FileNotFound) return err;
    }
    if (!std.mem.eql(u8, config.config.machineId, machine) or (!std.mem.eql(u8, plan.taskMachineId, machine) and (!hub_service or std.mem.eql(u8, profile.cwd, "$TASK")))) return .{ .ok = false, .code = "mcp_refused", .output = "MCP workspace binding refused; no fallback" };
    const tool = blk: {
        for (profile.tools) |tool| if (std.mem.eql(u8, tool.name, plan.tool)) break :blk tool;
        return .{ .ok = false, .code = "mcp_refused", .output = "MCP tool is not approved" };
    };
    const expected = profiles.toolHash(tool);
    const input = try schema.parse(a, tool.inputSchema);
    const args = try std.json.parseFromSlice(std.json.Value, a, plan.argumentsJSON, .{});
    if (!std.mem.eql(u8, &expected, plan.schemaHash) or !schema.matches(input.value, args.value)) return .{ .ok = false, .code = "mcp_refused", .output = "MCP schema/arguments refused; tool not dispatched" };
    if (cancelled.load(.acquire)) return .{ .ok = false, .code = "cancelled", .output = "MCP cancelled before acceptance" };
    // Exclusive acceptance before spawn. Existing/corrupt evidence never permits a retry.
    try save(native, a, dir, name, &digest, null);
    var stale = false;
    const result = transport.invoke(native, a, profile, tool, request, plan, cancelled, &stale);
    if (stale) {
        const marker = dir.createFile(native.io, stale_name, .{ .exclusive = true, .permissions = .fromMode(0o600) }) catch |err| switch (err) {
            error.PathAlreadyExists => null,
            else => return err,
        };
        if (marker) |file| {
            defer file.close(native.io);
            try file.sync(native.io);
            try syncDirectory(native, dir);
        }
    }
    const frame = try std.json.Stringify.valueAlloc(a, .{ .version = 1, .id = request.id, .result = result }, .{});
    try boundary.checkReply(a, request, frame);
    try save(native, a, dir, name, &digest, result);
    return result;
}

test "MCP receipts are durable with default and iterable directory handles" {
    const native = Native.testing();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const digest = profiles.hash("request");
    for ([_]bool{ false, true }) |iterate| {
        var tmp = std.testing.tmpDir(.{ .iterate = iterate });
        defer tmp.cleanup();
        try save(native, a, tmp.dir, "42.json", &digest, null);
        const accepted = (try retained(native, a, tmp.dir, "42.json", &digest)).?;
        try std.testing.expectEqualStrings("effect_uncertain", accepted.code);
        const result: Result = .{ .ok = false, .code = "mcp_refused", .output = "Not dispatched" };
        try save(native, a, tmp.dir, "42.json", &digest, result);
        const completed = (try retained(native, a, tmp.dir, "42.json", &digest)).?;
        try std.testing.expectEqual(result.ok, completed.ok);
        try std.testing.expectEqualStrings(result.code, completed.code);
        try std.testing.expectEqualStrings(result.output, completed.output);
    }
}
