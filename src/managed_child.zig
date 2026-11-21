const std = @import("std");
const wire = @import("generated/contracts.zig");
const V = std.json.Value;

pub fn safeId(value: V) bool {
    if (!wire.validPiId(value)) return false;
    return (std.fmt.parseInt(u64, value.string, 10) catch return false) <= 9007199254740991;
}
pub fn precedes(parent: V, child: V) bool {
    if (!safeId(parent) or !safeId(child)) return false;
    return (std.fmt.parseInt(u64, parent.string, 10) catch return false) < (std.fmt.parseInt(u64, child.string, 10) catch return false);
}
// Navigation metadata, never captured-child ownership. The containing generated
// shape must be checked first. A managed link always belongs to an ownerless task.
pub fn validLink(chat_id: V, value: V) bool {
    if (value != .object) return false;
    const parent = value.object.get("managedParentChatId") orelse return true;
    const kind = value.object.get("kind") orelse return false;
    return kind == .string and std.mem.eql(u8, kind.string, "task") and !value.object.contains("parentChatId") and !value.object.contains("ownerTaskId") and precedes(parent, chat_id);
}

// Called after the closed generated create shape. Match JavaScript trim's
// whitespace set without trimming or changing the problem's saved bytes.
pub fn problemBrief(value: V) bool {
    const problem = value.object.get("problem") orelse return false;
    const description = value.object.get("description") orelse return false;
    if (problem != .string or description != .string or description.string.len != 0) return false;
    return problemText(problem.string);
}

pub fn problemText(text: []const u8) bool {
    if (text.len > 2048) return false;
    var it = (std.unicode.Utf8View.init(text) catch return false).iterator();
    while (it.nextCodepoint()) |cp| switch (cp) {
        9...13, 32, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => {},
        else => return true,
    };
    return false;
}

test "problem text matches JavaScript Unicode whitespace without rewriting" {
    for ([_][]const u8{ "", " \t\r\n", "\u{3000}", "\u{a0}", "\u{feff}", "\u{1680}\u{2000}\u{2028}\u{2029}\u{202f}\u{205f}" }) |text| try std.testing.expect(!problemText(text));
    for ([_][]const u8{ "x", "\u{3000}x\u{feff}", "\u{85}", "\u{200b}" }) |text| try std.testing.expect(problemText(text));
}
