const std = @import("std");
const boundary = @import("native_contracts.zig");
const wire = @import("generated/contracts.zig");
const V = std.json.Value;
fn merge(allocator: std.mem.Allocator, value: *V, patch: V) !void {
    var iter = patch.object.iterator();
    while (iter.next()) |entry| try value.object.put(allocator, entry.key_ptr.*, entry.value_ptr.*);
}
test "native request/result/progress semantic fixtures agree across boundaries" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixtures = (try std.json.parseFromSlice(V, a, @embedFile("native_contracts.test.json"), .{})).value;
    const bases = (try std.json.parseFromSlice(V, a, @embedFile("contracts.test.json"), .{})).value.object.get("bases").?;
    for (fixtures.array.items) |fixture| {
        var request = (try std.json.parseFromSlice(V, a, "{\"version\":1,\"id\":\"1\",\"machineId\":\"worker\",\"cwd\":\"/saved\",\"operation\":\"read\",\"args\":{\"path\":\"x\"}}", .{})).value;
        if (fixture.object.get("set")) |patch| try merge(a, &request, patch);
        if (fixture.object.get("planSchema")) |schema| {
            const plan = try std.json.Stringify.valueAlloc(a, bases.object.get(schema.string).?, .{});
            var args: V = .{ .object = .empty };
            try args.object.put(a, "plan", .{ .string = plan });
            try request.object.put(a, "args", args);
        }
        var reply = (try std.json.parseFromSlice(V, a, "{\"version\":1}", .{})).value;
        try reply.object.put(a, "id", request.object.get("id").?);
        const payload = fixture.object.get("reply");
        if (payload) |patch| try merge(a, &reply, patch);
        if (fixture.object.get("repeat")) |repeat| {
            const text = repeat.object.get("text").?.string;
            const count: usize = @intCast(repeat.object.get("count").?.integer);
            const repeated = try a.alloc(u8, count * text.len);
            for (0..count) |i| @memcpy(repeated[i * text.len ..][0..text.len], text);
            const target = if (payload != null) reply.object.getPtr("progress").? else request.object.getPtr("args").?;
            try target.object.put(a, repeat.object.get("field").?.string, .{ .string = repeated });
        }
        const encoded = try std.json.Stringify.valueAlloc(a, request, .{});
        const expected = fixture.object.get("valid").?.bool;
        var actual = boundary.validRequest(a, request);
        if (payload != null) {
            try std.testing.expect(actual);
            const parsed = try boundary.parseRequest(a, encoded);
            actual = boundary.validReply(parsed.value.id, parsed.value.operation, reply);
            const response = try std.json.Stringify.valueAlloc(a, reply, .{});
            if (expected) try boundary.checkReply(a, parsed.value, response) else try std.testing.expectError(error.InvalidContract, boundary.checkReply(a, parsed.value, response));
        } else if (expected) {
            const parsed = try boundary.parseRequest(a, encoded);
            parsed.deinit();
        } else try std.testing.expectError(error.InvalidContract, boundary.parseRequest(a, encoded));
        if (actual != expected) {
            std.debug.print("native fixture failed: {s}\n", .{fixture.object.get("name").?.string});
            return error.NativeContractMismatch;
        }
    }
}
test "binary cancellation IDs use only safe Pi or high-half ephemeral namespaces" {
    for ([_]u64{ 1, 9007199254740991, @as(u64, 1) << 63, std.math.maxInt(u64) }) |id| try std.testing.expect(boundary.validCancellationId(id));
    for ([_]u64{ 0, 9007199254740992, (@as(u64, 1) << 63) - 1 }) |id| try std.testing.expect(!boundary.validCancellationId(id));
}
