const std = @import("std");
const wire = @import("generated/contracts.zig");
const V = std.json.Value;
pub fn fields(value: V) bool {
    if (value != .object) return false;
    inline for (.{ .{ "problem", @as(usize, 2048) }, .{ "description", @as(usize, 8192) } }) |field| {
        if (value.object.get(field[0])) |text| if (text != .string or text.string.len > field[1] or !std.unicode.utf8ValidateSlice(text.string)) return false;
    }
    return true;
}
pub fn valid(value: V) bool {
    return wire.validTaskBrief(value) and fields(value);
}
pub fn title(text: []const u8) bool {
    if (text.len == 0 or text.len > 200) return false;
    var it = (std.unicode.Utf8View.init(text) catch return false).iterator();
    while (it.nextCodepoint()) |cp| switch (cp) {
        9...13, 32, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => {},
        else => return true,
    };
    return false;
}
pub fn cwd(text: []const u8) bool {
    return text.len > 0 and text[0] == '/' and text.len <= 4096 and std.unicode.utf8ValidateSlice(text) and std.mem.indexOfScalar(u8, text, 0) == null;
}
pub fn form(value: V) bool {
    if (!wire.validTaskCreationForm(value) or !fields(value) or !title(value.object.get("title").?.string)) return false;
    const path = value.object.get("cwd");
    return (value.object.contains("machineId") == (path != null)) and (if (path) |p| cwd(p.string) else true);
}
