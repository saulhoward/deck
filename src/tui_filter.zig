//! Bounded, local-only picker filtering. Results retain their original IDs.
const std = @import("std");
const vaxis = @import("vaxis");
const Filter = @This();
text: [256]u8 = undefined,
len: usize = 0,
pub fn query(self: *const Filter) []const u8 {
    return self.text[0..self.len];
}
pub fn clear(self: *Filter) void {
    self.len = 0;
}
pub fn key(self: *Filter, event: vaxis.Key) bool {
    if (event.matches('u', .{ .ctrl = true })) {
        self.clear();
        return true;
    }
    if (event.matches(vaxis.Key.backspace, .{})) {
        var it = vaxis.unicode.graphemeIterator(self.query());
        var end: usize = 0;
        while (it.next()) |g| end = g.start;
        self.len = end;
        return true;
    }
    if (!event.mods.ctrl and !event.mods.alt) if (event.text) |value| {
        if (self.len + value.len > self.text.len) return false;
        var it = (std.unicode.Utf8View.init(value) catch return false).iterator();
        while (it.nextCodepoint()) |cp| if (cp < 32 or (cp >= 127 and cp <= 159)) return false;
        @memcpy(self.text[self.len..][0..value.len], value);
        self.len += value.len;
        return true;
    };
    return false;
}
fn fold(cp: u21) u21 {
    return if (cp < 128) std.ascii.toLower(@intCast(cp)) else cp;
}
// Ordered Unicode subsequence, ASCII case folding, contiguous/boundary bonuses.
// Linear scan, stable ties, no regex or subprocess. Not fzf's query language.
pub fn score(query_text: []const u8, label: []const u8) ?i32 {
    var query_it = (std.unicode.Utf8View.init(query_text) catch return null).iterator();
    var text_it = (std.unicode.Utf8View.init(label) catch return null).iterator();
    var result: i32 = 0;
    var previous: u21 = ' ';
    while (query_it.nextCodepoint()) |wanted| {
        var gap: i32 = 0;
        while (text_it.nextCodepoint()) |cp| {
            defer previous = cp;
            if (fold(cp) == fold(wanted)) {
                result += gap * 2 - (if (gap == 0) @as(i32, 8) else 0) - (if (previous < 128 and !std.ascii.isAlphanumeric(@intCast(previous))) @as(i32, 4) else 0);
                break;
            }
            gap += 1;
        } else return null;
    }
    return result;
}
pub const Matches = struct {
    const Item = struct { index: usize, score: i32 };
    items: [256]Item = undefined,
    len: usize = 0,
    pub fn add(self: *Matches, filter: Filter, label: []const u8, index: usize) void {
        const value = score(filter.query(), label) orelse return;
        if (self.len == self.items.len) return;
        var at = self.len;
        while (at > 0 and value < self.items[at - 1].score) : (at -= 1) self.items[at] = self.items[at - 1];
        self.items[at] = .{ .index = index, .score = value };
        self.len += 1;
    }
    pub fn raw(self: Matches, selected: usize) ?usize {
        return if (selected < self.len) self.items[selected].index else null;
    }
};
test "picker filtering is bounded, Unicode-safe and preserves raw identities" {
    var f: Filter = .{};
    try std.testing.expect(f.key(.{ .codepoint = 'g', .text = "gpt" }));
    var found: Matches = .{};
    found.add(f, "unrelated", 0);
    found.add(f, "giant pretty tree", 1);
    found.add(f, "GPT-fast", 7);
    try std.testing.expectEqual(@as(usize, 2), found.len);
    try std.testing.expectEqual(@as(?usize, 7), found.raw(0));
    try std.testing.expectEqual(@as(?usize, 1), found.raw(1));
    try std.testing.expect(found.raw(2) == null);
    try std.testing.expect(score("界é", "a界 b é") != null);
    try std.testing.expect(score("é界", "a界 b é") == null);
    f.clear();
    try std.testing.expect(f.key(.{ .codepoint = 'e', .text = "é👩‍💻" }));
    _ = f.key(.{ .codepoint = vaxis.Key.backspace });
    try std.testing.expectEqualStrings("é", f.query());
    try std.testing.expect(!f.key(.{ .codepoint = 0, .text = "\x1b[2J" }));
    const huge: [256]u8 = @splat('x');
    try std.testing.expect(!f.key(.{ .codepoint = 'x', .text = &huge }));
    _ = f.key(.{ .codepoint = 'u', .mods = .{ .ctrl = true } });
    try std.testing.expectEqual(@as(usize, 0), f.len);
}
