const std = @import("std");
const wire = @import("generated/contracts.zig");
const V = std.json.Value;
pub const chunk_bytes = 32768;
pub const max_bytes = 16777216;
fn safeId(value: V) bool {
    if (!wire.validPiId(value)) return false;
    return (std.fmt.parseInt(u64, value.string, 10) catch return false) <= 9007199254740991;
}
fn number(value: V) usize {
    return switch (value) {
        .integer => |n| @intCast(n),
        .float => |n| @intFromFloat(n),
        else => unreachable,
    };
}
pub fn validArgs(value: V) bool {
    return wire.validMessageContentArgs(value) and safeId(value.object.get("chatId").?) and safeId(value.object.get("entryId").?);
}
// Offset/identity and UTF-8 byte validation, not just generated shape guards.
// Consumers assembling pages additionally pin totalBytes/sha256 and verify the
// full digest before displaying the export. Partial pages cannot prove a hash.
pub fn validPage(args: V, value: V) bool {
    if (!validArgs(args) or !wire.validMessageContentPage(value)) return false;
    for ([_][]const u8{ "chatId", "entryId" }) |key| {
        if (!std.mem.eql(u8, args.object.get(key).?.string, value.object.get(key).?.string)) return false;
    }
    const offset = number(value.object.get("offset").?);
    if (offset != number(args.object.get("offset").?)) return false;
    const text = value.object.get("text").?.string;
    if (text.len > chunk_bytes or !std.unicode.utf8ValidateSlice(text)) return false;
    const end = offset + text.len;
    const total = number(value.object.get("totalBytes").?);
    if (end > total) return false;
    const next = value.object.get("next");
    if (end < total) {
        if (text.len < chunk_bytes - 3 or next == null or number(next.?) != end) return false;
    } else if (next != null) return false;
    if (offset == 0 and end == total) {
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(text, &digest, .{});
        const hex = std.fmt.bytesToHex(digest, .lower);
        if (!std.mem.eql(u8, &hex, value.object.get("sha256").?.string)) return false;
    }
    return true;
}
