const std = @import("std");
const wire = @import("generated/contracts.zig");
const V = std.json.Value;
fn field(v: V, name: []const u8) V {
    return v.object.get(name).?;
}
fn same(a: V, b: V) bool {
    return a == .string and b == .string and std.mem.eql(u8, a.string, b.string);
}
fn tag(v: V, text: []const u8) bool {
    return v == .string and std.mem.eql(u8, v.string, text);
}
fn safeId(v: V) bool {
    if (!wire.validPiId(v)) return false;
    const n = std.fmt.parseInt(u64, v.string, 10) catch return false;
    return n > 0 and n <= 9007199254740991;
}
fn units(v: V, cap: usize) bool {
    if (v != .string) return false;
    const view = std.unicode.Utf8View.init(v.string) catch return false;
    var it = view.iterator();
    var n: usize = 0;
    while (it.nextCodepoint()) |cp| {
        n += if (cp > 0xffff) @as(usize, 2) else 1;
        if (n > cap) return false;
    }
    return true;
}
fn argsObject(raw: V) V {
    return if (raw == .null) .{ .object = .empty } else raw;
}
pub fn validArgs(command: []const u8, value: V) bool {
    const args = argsObject(value);
    if (std.mem.eql(u8, command, "status")) {
        if (!wire.validStatusArgs(args)) return false;
        return if (args.object.get("chatId")) |id| safeId(id) else true;
    }
    if (std.mem.eql(u8, command, "login_start")) return wire.validLoginStartArgs(args) and units(field(args, "requestId"), 200000);
    if (std.mem.eql(u8, command, "login_status")) return wire.validLoginStatusArgs(args);
    if (std.mem.eql(u8, command, "login_cancel")) return wire.validLoginCancelArgs(args) and units(field(args, "loginId"), 200000);
    if (std.mem.eql(u8, command, "login_reply")) return wire.validLoginReplyArgs(args) and units(field(args, "loginId"), 200000) and units(field(args, "promptId"), 200000) and units(field(args, "answer"), 200000);
    return true;
}
fn loginSnapshot(v: V) bool {
    if (!wire.validLoginSnapshot(v)) return false;
    if (v.object.get("id")) |id| {
        if (!units(id, 200000)) return false;
    }
    if (v.object.get("prompt")) |prompt| {
        if (!units(field(prompt, "id"), 200000)) return false;
        if (prompt.object.get("options")) |options| {
            for (options.array.items, 0..) |option, index| {
                if (!units(field(option, "id"), 200000)) return false;
                for (options.array.items[0..index]) |prior| if (same(field(option, "id"), field(prior, "id"))) return false;
            }
        }
    }
    return true;
}
pub fn validReply(command: []const u8, raw: V, expected_hub: ?V, value: V) bool {
    const args = argsObject(raw);
    if (!validArgs(command, args)) return false;
    if (std.mem.eql(u8, command, "status")) {
        if (!wire.validStatusSnapshot(value) or !safeId(field(value, "mainChatId")) or !safeId(field(value, "chatId")) or !units(field(value, "hubId"), 200)) return false;
        if (!same(field(value, "chatId"), args.object.get("chatId") orelse field(value, "mainChatId"))) return false;
        if (expected_hub) |hub| {
            if (!same(hub, field(value, "hubId"))) return false;
        }
        const tools = field(value, "tools");
        if (!tag(tools, "offline") and !tag(tools, "native-files + bash")) return false;
        if (value.object.get("provider")) |provider| {
            if (value.object.get("model")) |model| {
                if (model.object.get("provider")) |other| {
                    if (!same(provider, other)) return false;
                }
            }
        }
        if (value.object.get("binding")) |binding| {
            if (binding.object.get("brief")) |brief| if (!@import("task_brief.zig").valid(brief)) return false;
            const parent = binding.object.get("parentChatId");
            const owner = binding.object.get("ownerTaskId");
            if ((parent == null) != (owner == null)) return false;
            if (parent) |id| {
                if (!safeId(id) or !safeId(owner.?)) return false;
            }
        }
        return true;
    }
    if (std.mem.eql(u8, command, "login_start")) return loginSnapshot(value) and same(value.object.get("id") orelse .null, field(args, "requestId"));
    if (std.mem.eql(u8, command, "login_status")) return loginSnapshot(value);
    if (std.mem.eql(u8, command, "login_reply")) return wire.validLoginReplyAck(value);
    if (std.mem.eql(u8, command, "login_cancel")) return wire.validLoginCancelAck(value);
    return true;
}
test "login arguments preserve UTF-16 bounds separately from schema code points" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    for ([_]usize{ 100000, 100001 }) |count| {
        const text = try allocator.alloc(u8, 4 * count);
        for (0..count) |i| @memcpy(text[i * 4 ..][0..4], "🌍");
        const encoded = try std.json.Stringify.valueAlloc(allocator, .{ .requestId = text }, .{});
        const parsed = try std.json.parseFromSlice(V, allocator, encoded, .{});
        try std.testing.expect(wire.validLoginStartArgs(parsed.value));
        try std.testing.expectEqual(count == 100000, validArgs("login_start", parsed.value));
    }
}

test "status/login shared semantic fixtures" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const fixtures = try std.json.parseFromSlice(V, arena.allocator(), @embedFile("status_login.test.json"), .{});
    for (fixtures.value.array.items) |fixture| {
        const actual = validReply(field(fixture, "command").string, fixture.object.get("args") orelse .null, fixture.object.get("hubId"), field(fixture, "result"));
        if (actual != field(fixture, "valid").bool) {
            std.debug.print("status/login fixture: {s}\n", .{field(fixture, "name").string});
            return error.InvalidStatusLoginContract;
        }
    }
}
