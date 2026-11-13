//! Disposable native test profile; no installed/product dependency.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const profiles = @import("mcp_profiles.zig");
pub fn create(a: std.mem.Allocator, dir: std.Io.Dir, machine: []const u8) !profiles.Profiles {
    const native = Native.testing();
    const io = native.io;
    const executable = try std.Io.Dir.cwd().realPathFileAlloc(io, "/bin/sh", a);
    const file = try std.Io.Dir.cwd().openFile(io, executable, .{});
    defer file.close(io);
    const digest = profiles.hash(try Native.readAll(io, file, a, 16 * 1024 * 1024));
    const script =
        \\read request
        \\printf '%s\n' '{"jsonrpc":"2.0","id":"initialize","result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}}'
        \\read initialized
        \\read catalog
        \\printf '%s\n' '{"jsonrpc":"2.0","id":"catalog:0","result":{"tools":[{"name":"counter","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}}]}}'
        \\read call
        \\id=${call#*\"id\":\"}
        \\id=${id%%\"*}
        \\printf x >> counter
        \\printf '{"jsonrpc":"2.0","id":"%s","result":{"content":[{"type":"text","text":"remote fixture result"}]}}\n' "$id"
        \\read shutdown
    ;
    const tool: wire.McpTool = .{ .name = "counter", .description = "Disposable transport fixture", .inputSchema = "{\"type\":\"object\",\"properties\":{},\"required\":[],\"additionalProperties\":false}" };
    const profile: wire.McpPrivateProfile = .{ .id = "fixture", .executable = executable, .sha256 = &digest, .argv = &.{ "-c", script }, .cwd = "$TASK", .files = &.{}, .env = &.{}, .tools = &.{tool} };
    const bytes = try std.json.Stringify.valueAlloc(a, wire.McpHostConfig{ .version = 1, .machineId = machine, .profiles = &.{profile} }, .{});
    const out = try dir.createFile(io, "mcp.json", .{ .permissions = .fromMode(0o600) });
    try out.writeStreamingAll(io, bytes);
    out.close(io);
    return profiles.Profiles.load(native, try dir.realPathFileAlloc(io, "mcp.json", a));
}
