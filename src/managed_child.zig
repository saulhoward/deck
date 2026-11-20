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
