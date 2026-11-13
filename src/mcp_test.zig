const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const schema = @import("mcp_schema.zig");
const profiles = @import("mcp_profiles.zig");
const mcp = @import("mcp_stdio.zig");
test "shared MCP semantic fixtures" {
    const a = std.testing.allocator;
    const cases = try std.json.parseFromSlice(std.json.Value, a, @embedFile("mcp.test.json"), .{});
    defer cases.deinit();
    for (cases.value.array.items) |case| {
        const kind = schema.get(case, "kind");
        const value = schema.get(case, "value");
        const actual = if (schema.eq(kind, "schema")) schema.supported(value) else if (schema.eq(kind, "match")) schema.matches(schema.get(case, "schema"), value) else if (schema.eq(kind, "result")) mcp.validResult(value) else blk: {
            const parsed = std.json.parseFromSlice(std.json.Value, a, value.string, .{}) catch break :blk false;
            defer parsed.deinit();
            break :blk mcp.validRpcReply(parsed.value, "call:7");
        };
        try std.testing.expectEqual(schema.get(case, "valid").bool, actual);
    }
}
test "MCP native schema subset rejects ignored keywords and preserves scalar validation" {
    const a = std.testing.allocator;
    const s = try schema.parse(a, "{\"type\":\"object\",\"properties\":{\"count\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":9}},\"required\":[\"count\"],\"additionalProperties\":false}");
    defer s.deinit();
    const good = try std.json.parseFromSlice(std.json.Value, a, "{\"count\":9}", .{});
    defer good.deinit();
    const bad = try std.json.parseFromSlice(std.json.Value, a, "{\"count\":10}", .{});
    defer bad.deinit();
    try std.testing.expect(schema.matches(s.value, good.value));
    try std.testing.expect(!schema.matches(s.value, bad.value));
    try std.testing.expectError(error.UnsupportedSchema, schema.parse(a, "{\"type\":\"object\",\"properties\":{},\"required\":[],\"additionalProperties\":false,\"oneOf\":[]}"));
}
test "native MCP owns stdio negotiation catalog call and cleanup without a Node tool host" {
    const native = Native.testing();
    const io = native.io;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const cwd = try tmp.dir.realPathFileAlloc(io, ".", a);
    const executable = try std.Io.Dir.cwd().realPathFileAlloc(io, "/bin/sh", a);
    const file = try std.Io.Dir.cwd().openFile(io, executable, .{});
    defer file.close(io);
    const bytes = try Native.readAll(io, file, a, 16 * 1024 * 1024);
    const digest = profiles.hash(bytes);
    const input = "{\"type\":\"object\",\"properties\":{},\"required\":[],\"additionalProperties\":false}";
    const script =
        \\read request
        \\printf '%s\n' '{"jsonrpc":"2.0","id":"initialize","result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}}'
        \\read initialized
        \\read catalog
        \\printf '%s\n' '{"jsonrpc":"2.0","id":"catalog:0","result":{"tools":[{"name":"count","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}}]}}'
        \\read call
        \\printf x >> count
        \\printf 'PRIVATE DIAGNOSTIC' >&2
        \\printf '%s\n' '{"jsonrpc":"2.0","id":"call:42","result":{"content":[{"type":"text","text":"one"}],"structuredContent":{"count":1}}}'
        \\read shutdown
    ;
    const tool: wire.McpTool = .{ .name = "count", .description = "Counter fixture", .inputSchema = input };
    const profile: wire.McpPrivateProfile = .{ .id = "fixture", .executable = executable, .sha256 = &digest, .argv = &.{ "-c", script }, .cwd = "$TASK", .env = &.{}, .files = &.{}, .tools = &.{tool} };
    var cancelled = std.atomic.Value(bool).init(false);
    const request: wire.NativeRequest = .{ .version = 1, .id = "42", .machineId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .cwd = cwd, .operation = .mcp_call, .args = .{} };
    var stale = false;
    const result = mcp.invoke(native, a, profile, tool, request, .{ .version = 1, .profileId = "fixture", .revision = &digest, .tool = "count", .schemaHash = &digest, .conversationId = "1", .taskMachineId = request.machineId, .grantRevision = 1, .argumentsJSON = "{}" }, &cancelled, &stale);
    try std.testing.expect(!stale);
    try std.testing.expectEqualStrings("mcp_result", result.code);
    try std.testing.expect(result.ok);
    try std.testing.expect(std.mem.indexOf(u8, result.output, "PRIVATE") == null);
    try std.testing.expectEqualStrings("x", try tmp.dir.readFileAlloc(io, "count", a, .limited(100)));
    const raw = try std.json.parseFromSlice(std.json.Value, a, result.output, .{});
    try std.testing.expect(mcp.validRpcReply(raw.value, "call:42"));
    // Exercise generated private-profile loading/export without launching a process.
    const config = try std.json.Stringify.valueAlloc(a, wire.McpHostConfig{ .version = 1, .machineId = request.machineId, .profiles = &.{profile} }, .{});
    const f = try tmp.dir.createFile(io, "profiles.json", .{ .permissions = .fromMode(0o600) });
    try f.writeStreamingAll(io, config);
    f.close(io);
    var loaded = try profiles.Profiles.load(native, try std.fs.path.join(a, &.{ cwd, "profiles.json" }));
    defer loaded.deinit();
    try std.testing.expectEqual(@as(usize, 1), loaded.public.profiles.len);
}
