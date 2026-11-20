const std = @import("std");
const hub = @import("hub.zig");
const V = std.json.Value;

test "message content shared UTF-8, identity, digest and nested response fixtures" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixtures = (try std.json.parseFromSlice(V, a, @embedFile("message_content.test.json"), .{})).value;
    for (fixtures.array.items) |original| {
        var fixture = original;
        if (fixture.object.get("repeat")) |repeat| {
            var target = &fixture;
            for (repeat.object.get("path").?.array.items) |key| {
                target = if (key == .integer) &target.array.items[@intCast(key.integer)] else target.object.getPtr(key.string).?;
            }
            const text = repeat.object.get("text").?.string;
            const count: usize = @intCast(repeat.object.get("count").?.integer);
            const repeated = try a.alloc(u8, count * text.len);
            for (0..count) |i| @memcpy(repeated[i * text.len ..][0..text.len], text);
            target.* = .{ .string = repeated };
        }
        const request = fixture.object.get("request").?;
        const actual = if (fixture.object.get("reply")) |reply| hub.validReply(request, reply) else hub.validClientRequest(request);
        if (actual != fixture.object.get("valid").?.bool) {
            std.debug.print("message content fixture failed: {s}\n", .{fixture.object.get("name").?.string});
            return error.InvalidMessageContentContract;
        }
    }
}

test "message content failure policy is always read only after send" {
    for ([_]@import("generated/contracts.zig").FailureSource{ .local, .remote, .transport }) |source| {
        for ([_][]const u8{ "too_large", "invalid_response", "future_error" }) |code| {
            const policy = @import("command_policy.zig").failure("message_content", code, source);
            try std.testing.expectEqual(@as(@TypeOf(policy.outcome), if (source == .local) .not_sent else .read_only), policy.outcome);
            try std.testing.expectEqual(@as(@TypeOf(policy.action), if (source == .local) .fix_request else .retry_read), policy.action);
            try std.testing.expect(policy.preserveDrafts and !policy.automaticMutationRetry);
        }
    }
}
