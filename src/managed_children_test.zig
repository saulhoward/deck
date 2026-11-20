const std = @import("std");
const hub = @import("hub.zig");
const V = std.json.Value;

fn parse(allocator: std.mem.Allocator, value: anytype) !V {
    const encoded = try std.json.Stringify.valueAlloc(allocator, value, .{});
    return (try std.json.parseFromSlice(V, allocator, encoded, .{})).value;
}

test "managed child shared request, ACK correlation, metadata and form contracts" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixtures = (try std.json.parseFromSlice(V, a, @embedFile("managed_children.test.json"), .{})).value;
    for (fixtures.array.items) |fixture| {
        const kind = fixture.object.get("kind").?.string;
        const expected = fixture.object.get("valid").?.bool;
        const actual = if (std.mem.eql(u8, kind, "request"))
            hub.validClientRequest(fixture.object.get("request").?)
        else if (std.mem.eql(u8, kind, "reply"))
            hub.validReply(fixture.object.get("request").?, fixture.object.get("reply").?)
        else if (std.mem.eql(u8, kind, "form"))
            @import("task_brief.zig").form(fixture.object.get("value").?)
        else if (std.mem.eql(u8, kind, "metadata")) blk: {
            const row = fixture.object.get("value").?;
            const request = try parse(a, .{ .version = 1, .id = "managed", .command = "list_chats", .args = .{ .limit = 50 } });
            const reply = try parse(a, .{ .version = 1, .id = "managed", .ok = true, .result = .{ .items = [_]V{row} } });
            const discovery = hub.validReply(request, reply);
            // Keep status shape closed: selected chat identity is on the outer
            // snapshot, not duplicated inside its saved metadata binding.
            var binding = try parse(a, row);
            _ = binding.object.swapRemove("chatId");
            const chat_id = row.object.get("chatId").?;
            const status_request = try parse(a, .{ .version = 1, .id = "managed", .hubId = "hub", .command = "status", .args = .{ .chatId = chat_id } });
            const status_reply = try parse(a, .{ .version = 1, .id = "managed", .ok = true, .result = .{ .hubId = "hub", .mainChatId = "1", .chatId = chat_id, .tools = "offline", .managedChildren = 1, .binding = binding } });
            const status = hub.validReply(status_request, status_reply);
            if (discovery != expected or status != expected) {
                std.debug.print("managed metadata fixture failed: {s} (discovery={}, status={})\n", .{ fixture.object.get("name").?.string, discovery, status });
                return error.InvalidManagedMetadata;
            }
            break :blk discovery;
        } else return error.UnknownManagedFixture;
        if (actual != expected) {
            std.debug.print("managed fixture failed: {s}\n", .{fixture.object.get("name").?.string});
            return error.InvalidManagedContract;
        }
    }
}
