//! Deliberately small JSON Schema subset shared with runtime/src/mcp-contracts.ts.
const std = @import("std");
pub const V = std.json.Value;
pub fn get(v: V, key: []const u8) V {
    return if (v == .object) v.object.get(key) orelse .null else .null;
}
pub fn eq(v: V, s: []const u8) bool {
    return v == .string and std.mem.eql(u8, v.string, s);
}
fn has(v: V, key: []const u8) bool {
    return v == .object and v.object.contains(key);
}
fn one(s: []const u8, names: []const []const u8) bool {
    for (names) |name| if (std.mem.eql(u8, s, name)) return true;
    return false;
}
fn num(v: V) ?f64 {
    const n: f64 = switch (v) {
        .integer => @floatFromInt(v.integer),
        .float => v.float,
        else => return null,
    };
    return if (std.math.isFinite(n) and @abs(n) <= 9007199254740991) n else null;
}
fn count(v: V, max: usize) bool {
    const n = num(v) orelse return false;
    return n >= 0 and n <= @as(f64, @floatFromInt(max)) and @floor(n) == n;
}
fn validKey(s: []const u8) bool {
    return s.len > 0 and s.len <= 64 and !one(s, &.{ "__proto__", "constructor", "prototype" });
}
pub fn equal(a: V, b: V) bool {
    if (num(a)) |n| {
        if (num(b)) |m| return n == m;
    }
    if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
    return switch (a) {
        .null => true,
        .bool => a.bool == b.bool,
        .string => std.mem.eql(u8, a.string, b.string),
        .array => blk: {
            if (a.array.items.len != b.array.items.len) break :blk false;
            for (a.array.items, b.array.items) |x, y| if (!equal(x, y)) break :blk false;
            break :blk true;
        },
        .object => blk: {
            if (a.object.count() != b.object.count()) break :blk false;
            var it = a.object.iterator();
            while (it.next()) |p| if (!equal(p.value_ptr.*, b.object.get(p.key_ptr.*) orelse break :blk false)) break :blk false;
            break :blk true;
        },
        else => false,
    };
}
pub fn boundedJson(v: V) bool {
    var nodes: usize = 0;
    return bounded(v, 0, &nodes);
}
fn bounded(v: V, depth: usize, nodes: *usize) bool {
    nodes.* += 1;
    if (nodes.* > 8192 or depth > 32) return false;
    return switch (v) {
        .null, .bool => true,
        .string => v.string.len <= 65536,
        .integer, .float => num(v) != null,
        .array => blk: {
            for (v.array.items) |item| if (!bounded(item, depth + 1, nodes)) break :blk false;
            break :blk true;
        },
        .object => blk: {
            var it = v.object.iterator();
            while (it.next()) |p| if (!bounded(p.value_ptr.*, depth + 1, nodes)) break :blk false;
            break :blk true;
        },
        else => false,
    };
}
pub fn supported(v: V) bool {
    var nodes: usize = 0;
    return visit(v, 0, &nodes);
}
fn visit(v: V, depth: usize, nodes: *usize) bool {
    nodes.* += 1;
    if (v != .object or depth > 8 or nodes.* > 256 or get(v, "type") != .string) return false;
    const t = get(v, "type").string;
    const extra: []const []const u8 = if (std.mem.eql(u8, t, "object")) &.{ "properties", "required", "additionalProperties" } else if (std.mem.eql(u8, t, "array")) &.{ "items", "minItems", "maxItems" } else if (std.mem.eql(u8, t, "string")) &.{ "minLength", "maxLength" } else if (one(t, &.{ "number", "integer" })) &.{ "minimum", "maximum" } else if (one(t, &.{ "boolean", "null" })) &.{} else return false;
    var it = v.object.iterator();
    while (it.next()) |p| if (!one(p.key_ptr.*, &.{ "type", "description", "title", "enum" }) and !one(p.key_ptr.*, extra)) return false;
    for ([_][]const u8{ "description", "title" }) |k| if (v.object.get(k)) |s| if (s != .string or s.string.len > 2048) return false;
    if (v.object.get("enum")) |e| {
        if (one(t, &.{ "object", "array" }) or e != .array or e.array.items.len == 0 or e.array.items.len > 32) return false;
        for (e.array.items, 0..) |item, i| {
            if (!matchesInner(v, item, false)) return false;
            for (e.array.items[0..i]) |prior| if (equal(item, prior)) return false;
        }
    }
    if (std.mem.eql(u8, t, "object")) {
        const p = get(v, "properties");
        const r = get(v, "required");
        const a = get(v, "additionalProperties");
        if (a != .bool or a.bool or p != .object or p.object.count() > 32 or r != .array or r.array.items.len > 32) return false;
        for (r.array.items, 0..) |k, i| {
            if (k != .string or !p.object.contains(k.string)) return false;
            for (r.array.items[0..i]) |prior| if (equal(k, prior)) return false;
        }
        var props = p.object.iterator();
        while (props.next()) |prop| if (!validKey(prop.key_ptr.*) or !visit(prop.value_ptr.*, depth + 1, nodes)) return false;
    } else if (std.mem.eql(u8, t, "array")) {
        if (!count(get(v, "maxItems"), 64)) return false;
        const max: usize = @intFromFloat(num(get(v, "maxItems")).?);
        if ((has(v, "minItems") and !count(get(v, "minItems"), max)) or !visit(get(v, "items"), depth + 1, nodes)) return false;
    } else if (std.mem.eql(u8, t, "string")) {
        if (has(v, "maxLength") and !count(get(v, "maxLength"), 32768)) return false;
        const max: usize = if (has(v, "maxLength")) @intFromFloat(num(get(v, "maxLength")).?) else 32768;
        if (has(v, "minLength") and !count(get(v, "minLength"), max)) return false;
    } else if (one(t, &.{ "number", "integer" })) {
        if ((has(v, "minimum") and num(get(v, "minimum")) == null) or (has(v, "maximum") and num(get(v, "maximum")) == null)) return false;
        if ((num(get(v, "minimum")) orelse -9007199254740991) > (num(get(v, "maximum")) orelse 9007199254740991)) return false;
    }
    return true;
}
pub fn matches(s: V, v: V) bool {
    return matchesInner(s, v, true);
}
fn matchesInner(s: V, v: V, enumeration: bool) bool {
    if (enumeration) if (s.object.get("enum")) |e| {
        var found = false;
        for (e.array.items) |item| {
            if (equal(item, v)) found = true;
        }
        if (!found) return false;
    };
    const t = get(s, "type");
    if (eq(t, "object")) {
        if (v != .object) return false;
        const props = get(s, "properties");
        for (get(s, "required").array.items) |r| if (!v.object.contains(r.string)) return false;
        var it = v.object.iterator();
        while (it.next()) |p| if (!matches(props.object.get(p.key_ptr.*) orelse return false, p.value_ptr.*)) return false;
        return true;
    }
    if (eq(t, "array")) {
        if (v != .array) return false;
        const n: f64 = @floatFromInt(v.array.items.len);
        if (n < (num(get(s, "minItems")) orelse 0) or n > (num(get(s, "maxItems")) orelse return false)) return false;
        for (v.array.items) |item| if (!matches(get(s, "items"), item)) return false;
        return true;
    }
    if (eq(t, "string")) {
        if (v != .string) return false;
        const n: f64 = @floatFromInt(std.unicode.utf8CountCodepoints(v.string) catch return false);
        return n >= (num(get(s, "minLength")) orelse 0) and n <= (num(get(s, "maxLength")) orelse 32768);
    }
    if (eq(t, "number") or eq(t, "integer")) {
        const n = num(v) orelse return false;
        return (!eq(t, "integer") or @floor(n) == n) and n >= (num(get(s, "minimum")) orelse -9007199254740991) and n <= (num(get(s, "maximum")) orelse 9007199254740991);
    }
    if (eq(t, "boolean")) return v == .bool;
    return eq(t, "null") and v == .null;
}
pub fn parse(a: std.mem.Allocator, bytes: []const u8) !std.json.Parsed(V) {
    if (bytes.len > 16384 or !std.unicode.utf8ValidateSlice(bytes)) return error.UnsupportedSchema;
    const p = try std.json.parseFromSlice(V, a, bytes, .{});
    errdefer p.deinit();
    if (!supported(p.value) or !eq(get(p.value, "type"), "object")) return error.UnsupportedSchema;
    return p;
}
