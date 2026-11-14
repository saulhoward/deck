//! Vesper-derived, presentation-only chrome and responsive geometry.
const std = @import("std");
const vaxis = @import("vaxis");
pub const base: vaxis.Style = .{ .fg = .{ .rgb = .{ 255, 255, 255 } }, .bg = .{ .rgb = .{ 16, 16, 16 } } };
pub const dim: vaxis.Style = .{ .fg = .{ .rgb = .{ 160, 160, 160 } }, .bg = base.bg };
pub const rule: vaxis.Style = .{ .fg = .{ .rgb = .{ 80, 80, 80 } }, .bg = base.bg };
pub const green: vaxis.Style = .{ .fg = .{ .rgb = .{ 153, 255, 228 } }, .bg = base.bg };
pub const orange: vaxis.Style = .{ .fg = .{ .rgb = .{ 255, 199, 153 } }, .bg = base.bg };
pub const Layout = struct {
    main: u16,
    sidebar: u16,
    body: u16,
    x: u16,
    pub fn init(width: u16, override: ?bool) Layout {
        // Explicit show works below the automatic threshold. At pathological
        // widths preserve at least ten chat columns rather than underflowing.
        const side: u16 = if ((override orelse (width >= 112)) and width >= 20) @min(28, width / 3) else 0;
        const main = width - side;
        const body = @min(80, main -| 4);
        return .{ .main = main, .sidebar = side, .body = @max(1, body), .x = (main - body) / 2 };
    }
};
// A bounded 900ms reveal; periodic busy pulses use the same presentation only.
pub fn name(out: *[192]u8, saved: []const u8, phase: ?u64) []const u8 {
    const step = phase orelse {
        @memcpy(out[0..saved.len], saved);
        return out[0..saved.len];
    };
    const settled = @min(saved.len, (step * saved.len) / 18);
    var n: usize = 0;
    for (saved, 0..) |c, i| {
        if (i < settled) {
            out[n] = c;
            n += 1;
        } else {
            const cp: u21 = @intCast(0x16a0 + (i * 17 + step * 13) % 75);
            var bytes: [4]u8 = undefined;
            const len = std.unicode.utf8Encode(cp, &bytes) catch unreachable;
            @memcpy(out[n..][0..len], bytes[0..len]);
            n += len;
        }
    }
    return out[0..n];
}
test "sidebar geometry respects 80 columns and explicit narrow overrides" {
    try std.testing.expectEqual(@as(u16, 0), Layout.init(100, null).sidebar);
    try std.testing.expectEqual(@as(u16, 28), Layout.init(140, null).sidebar);
    try std.testing.expectEqual(@as(u16, 80), Layout.init(140, null).body);
    try std.testing.expect(Layout.init(60, true).sidebar > 0);
    try std.testing.expectEqual(@as(u16, 0), Layout.init(140, false).sidebar);
    for (20..513) |w| {
        const l = Layout.init(@intCast(w), true);
        try std.testing.expect(l.body <= 80 and l.x + l.body < l.main);
    }
    var out: [192]u8 = undefined;
    try std.testing.expectEqualStrings("wintermute", name(&out, "wintermute", 18));
    try std.testing.expect(std.unicode.utf8ValidateSlice(name(&out, "wintermute", 0)));
    const longest: [64]u8 = @splat('a');
    try std.testing.expectEqual(@as(usize, 192), name(&out, &longest, 0).len);
}
