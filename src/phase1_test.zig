const std = @import("std");
const brief = @import("task_brief.zig");
const bridge = @import("tui_bridge.zig");
const native = @import("native_contracts.zig");
test "Phase 1 shared contracts refuse malformed form, host and native observation payloads" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, @embedFile("phase1.test.json"), .{});
    defer parsed.deinit();
    for (parsed.value.array.items) |case| {
        const kind = case.object.get("kind").?.string;
        const value = case.object.get("value").?;
        const valid = if (std.mem.eql(u8, kind, "form")) brief.form(value) else if (std.mem.eql(u8, kind, "brief")) brief.valid(value) else if (std.mem.eql(u8, kind, "hosts")) @import("hub.zig").validHosts(value) else if (std.mem.eql(u8, kind, "request")) bridge.validRequest(value) else if (std.mem.eql(u8, kind, "briefAck")) @import("hub.zig").validCreationAck(case.object.get("args").?, value, true) else if (std.mem.eql(u8, kind, "nativeRequest")) native.validRequest(std.testing.allocator, value) else native.validResult(.link_status, value);
        try std.testing.expectEqual(case.object.get("valid").?.bool, valid);
    }
    var emoji: [51 * 4]u8 = undefined;
    for (0..51) |i| @memcpy(emoji[i * 4 ..][0..4], "😀");
    try std.testing.expect(brief.title(emoji[0..200]));
    try std.testing.expect(!brief.title(&emoji));
    try std.testing.expect(!brief.title("\xef\xbb\xbf\xe3\x80\x80"));
    var value: std.json.Value = .{ .object = .empty };
    defer value.object.deinit(std.testing.allocator);
    var description: [2049 * 4]u8 = undefined;
    for (0..2049) |i| @memcpy(description[i * 4 ..][0..4], "😀");
    try value.object.put(std.testing.allocator, "description", .{ .string = description[0..8192] });
    try std.testing.expect(brief.valid(value));
    try value.object.put(std.testing.allocator, "description", .{ .string = &description });
    try std.testing.expect(!brief.valid(value));
}
