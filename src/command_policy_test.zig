const std = @import("std");
const wire = @import("generated/contracts.zig");
const policy = @import("command_policy.zig");
const hub = @import("hub.zig");
const V = std.json.Value;
test "client command failure policies agree with TypeScript and never authorize automatic mutation retry" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixtures = (try std.json.parseFromSlice(V, a, @embedFile("command_policy.test.json"), .{})).value;
    for (fixtures.array.items) |fixture| {
        const source = try std.json.parseFromValue(wire.FailureSource, a, fixture.object.get("source").?, .{});
        const result = policy.failure(fixture.object.get("command").?.string, fixture.object.get("code").?.string, source.value);
        try std.testing.expectEqualStrings(fixture.object.get("outcome").?.string, @tagName(result.outcome));
        try std.testing.expectEqualStrings(fixture.object.get("action").?.string, @tagName(result.action));
        try std.testing.expect(result.preserveDrafts and !result.automaticMutationRetry);
    }
}
test "Zig client command args agree with TypeScript without execution or storage" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixtures = (try std.json.parseFromSlice(V, a, @embedFile("command_args.test.json"), .{})).value;
    const bases = (try std.json.parseFromSlice(V, a, @embedFile("contracts.test.json"), .{})).value.object.get("bases").?;
    for (fixtures.array.items) |fixture| {
        const base = if (fixture.object.get("schema")) |schema| bases.object.get(schema.string).? else fixture.object.get("args").?;
        const encoded = try std.json.Stringify.valueAlloc(a, base, .{});
        var args = (try std.json.parseFromSlice(V, a, encoded, .{})).value;
        if (fixture.object.get("repeat")) |repeat| {
            const text = repeat.object.get("text").?.string;
            const count: usize = @intCast(repeat.object.get("count").?.integer);
            const repeated = try a.alloc(u8, count * text.len);
            for (0..count) |i| @memcpy(repeated[i * text.len ..][0..text.len], text);
            try args.object.put(a, repeat.object.get("field").?.string, .{ .string = repeated });
        }
        const command = fixture.object.get("command").?.string;
        const expected = fixture.object.get("valid").?.bool;
        if (hub.validCommandArgs(command, args) != expected) {
            std.debug.print("command args mismatch: {s}\n", .{command});
            return error.CommandContractMismatch;
        }
    }
    const request = (try std.json.parseFromSlice(V, a, "{\"version\":1,\"id\":\"t\",\"command\":\"stop\",\"args\":{\"chatId\":\"1\"}}", .{})).value;
    const ok = (try std.json.parseFromSlice(V, a, "{\"version\":1,\"id\":\"t\",\"ok\":true,\"result\":{\"requested\":true}}", .{})).value;
    try std.testing.expect(hub.validReply(request, ok));
    var wrong = ok;
    try wrong.object.put(a, "id", .{ .string = "other" });
    try std.testing.expect(!hub.validReply(request, wrong));
    const future_error = (try std.json.parseFromSlice(V, a, "{\"version\":1,\"id\":\"t\",\"ok\":false,\"error\":{\"code\":\"future_error\",\"message\":\"uncertain\"}}", .{})).value;
    try std.testing.expect(hub.validReply(request, future_error));
    try std.testing.expect(hub.validClientRequest(request));
    var scoped = request;
    try scoped.object.put(a, "hubId", .{ .string = "hub" });
    try std.testing.expect(hub.validClientRequest(scoped));
    var astral: [404]u8 = undefined;
    for (0..101) |i| @memcpy(astral[i * 4 ..][0..4], "🌍");
    for ([_]V{ .null, .{ .object = .empty }, .{ .string = "" }, .{ .string = &astral } }) |invalid_hub| {
        try scoped.object.put(a, "hubId", invalid_hub);
        try std.testing.expect(!hub.validClientRequest(scoped));
        // Wrong/malformed expected identity is not accepted on successful ACKs.
        const ack = (try std.json.parseFromSlice(V, a, "{\"version\":1,\"id\":\"t\",\"ok\":true,\"result\":{\"requested\":true}}", .{})).value;
        try std.testing.expect(!hub.validReply(scoped, ack));
    }
}
