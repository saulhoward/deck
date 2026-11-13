const std = @import("std");
const wire = @import("generated/contracts.zig");
const s = @import("mcp_schema.zig");
const V = std.json.Value;
fn safe(v: V) bool {
    return wire.validPiId(v) and (std.fmt.parseInt(u64, v.string, 10) catch return false) <= 9007199254740991;
}
fn unique(v: V) bool {
    for (v.array.items, 0..) |g, i| for (v.array.items[0..i]) |prior| if (s.equal(s.get(g, "machineId"), s.get(prior, "machineId")) and s.equal(s.get(g, "profileId"), s.get(prior, "profileId"))) return false;
    return true;
}
pub fn validArgs(command: []const u8, args: V) bool {
    if (std.mem.eql(u8, command, "mcp_catalog")) return args == .object and args.object.count() == 0;
    if (std.mem.eql(u8, command, "tool_profiles")) return wire.validStopArgs(args) and safe(s.get(args, "chatId"));
    if (std.mem.eql(u8, command, "set_tool_profiles")) return wire.validMcpGrantArgs(args) and safe(s.get(args, "chatId")) and unique(s.get(args, "profiles"));
    return true;
}
pub fn validCatalog(value: V) bool {
    if (!wire.validMcpCatalog(value)) return false;
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const bytes = std.json.Stringify.valueAlloc(a, value, .{}) catch return false;
    if (bytes.len > 256 * 1024) return false;
    const profiles = s.get(value, "profiles").array.items;
    for (profiles, 0..) |profile, i| {
        for (profiles[0..i]) |prior| if (s.equal(s.get(profile, "machineId"), s.get(prior, "machineId")) and s.equal(s.get(profile, "id"), s.get(prior, "id"))) return false;
        const tools = s.get(profile, "tools").array.items;
        for (tools, 0..) |tool, j| {
            for (tools[0..j]) |prior| if (s.equal(s.get(tool, "name"), s.get(prior, "name"))) return false;
            if (s.get(tool, "description").string.len > 2048) return false;
            _ = s.parse(a, s.get(tool, "inputSchema").string) catch return false;
            if (tool.object.get("outputSchema")) |output| {
                _ = s.parse(a, output.string) catch return false;
            }
        }
    }
    return true;
}
pub fn validReply(command: []const u8, args: V, result: V) bool {
    if (std.mem.eql(u8, command, "mcp_catalog")) return validCatalog(result);
    if (!std.mem.eql(u8, command, "tool_profiles") and !std.mem.eql(u8, command, "set_tool_profiles")) return true;
    if (!validArgs(command, args) or !wire.validMcpGrantSnapshot(result) or !safe(s.get(result, "chatId")) or !unique(s.get(result, "profiles")) or !s.equal(s.get(result, "chatId"), s.get(args, "chatId"))) return false;
    if (std.mem.eql(u8, command, "tool_profiles")) return true;
    const expected = s.get(args, "expectedRevision");
    const rev = s.get(result, "revision");
    const e: f64 = if (expected == .integer) @floatFromInt(expected.integer) else expected.float;
    const r: f64 = if (rev == .integer) @floatFromInt(rev.integer) else rev.float;
    return (r == e or r == e + 1) and s.equal(s.get(args, "profiles"), s.get(result, "profiles"));
}
