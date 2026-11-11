//! Bounded Vim-style editing policy. libvaxis owns terminal input and Unicode
//! grapheme segmentation; this module owns only the user's in-memory prompt.
const std = @import("std");
const vaxis = @import("vaxis");
const Editor = @This();
pub const limit = 16384;
pub const Mode = enum { normal, insert, visual, visual_line };
const Snapshot = struct { text: []u8, cursor: usize };
a: std.mem.Allocator,
text: std.ArrayList(u8) = .empty,
cursor: usize = 0,
mode: Mode = .normal,
anchor: usize = 0,
count: usize = 0,
pending: ?u21 = null,
operator_count: usize = 1,
insert_saved: bool = false,
register: std.ArrayList(u8) = .empty,
linewise: bool = false,
undo: std.ArrayList(Snapshot) = .empty,
redo: std.ArrayList(Snapshot) = .empty,

pub fn init(a: std.mem.Allocator) Editor {
    return .{ .a = a };
}
pub fn deinit(self: *Editor) void {
    self.text.deinit(self.a);
    self.register.deinit(self.a);
    self.clearStack(&self.undo);
    self.clearStack(&self.redo);
    self.undo.deinit(self.a);
    self.redo.deinit(self.a);
}
fn clearStack(self: *Editor, stack: *std.ArrayList(Snapshot)) void {
    for (stack.items) |s| self.a.free(s.text);
    stack.clearRetainingCapacity();
}
fn push(self: *Editor, stack: *std.ArrayList(Snapshot)) !void {
    if (stack.items.len == 32) self.a.free(stack.orderedRemove(0).text);
    const copy = try self.a.dupe(u8, self.text.items);
    errdefer self.a.free(copy);
    try stack.append(self.a, .{ .text = copy, .cursor = self.cursor });
}
fn checkpoint(self: *Editor) !void {
    try self.push(&self.undo);
    self.clearStack(&self.redo);
}
fn beforeInsert(self: *Editor) !void {
    if (!self.insert_saved) {
        try self.checkpoint();
        self.insert_saved = true;
    }
}
pub fn set(self: *Editor, value: []const u8) !void {
    if (value.len > limit or !std.unicode.utf8ValidateSlice(value)) return error.PromptTooLarge;
    self.text.clearRetainingCapacity();
    try self.text.appendSlice(self.a, value);
    self.cursor = 0;
    self.mode = .normal;
    self.pending = null;
    self.count = 0;
    self.clearStack(&self.undo);
    self.clearStack(&self.redo);
}
pub fn next(self: *const Editor, at: usize) usize {
    if (at >= self.text.items.len) return self.text.items.len;
    var it = vaxis.unicode.graphemeIterator(self.text.items[at..]);
    return at + (it.next() orelse return at).len;
}
pub fn prev(self: *const Editor, at: usize) usize {
    var it = vaxis.unicode.graphemeIterator(self.text.items[0..@min(at, self.text.items.len)]);
    var last: usize = 0;
    while (it.next()) |g| last = g.start;
    return last;
}
pub fn lineStart(self: *const Editor, at: usize) usize {
    const end = @min(at, self.text.items.len);
    return if (std.mem.lastIndexOfScalar(u8, self.text.items[0..end], '\n')) |n| n + 1 else 0;
}
pub fn lineEnd(self: *const Editor, at: usize) usize {
    return std.mem.indexOfScalarPos(u8, self.text.items, @min(at, self.text.items.len), '\n') orelse self.text.items.len;
}
fn snap(self: *Editor, forward: bool) void {
    var it = vaxis.unicode.graphemeIterator(self.text.items);
    while (it.next()) |g| {
        if (self.cursor > g.start and self.cursor < g.start + g.len) {
            self.cursor = if (forward) g.start + g.len else g.start;
            return;
        }
    }
}
fn clamp(self: *Editor) void {
    self.cursor = @min(self.cursor, self.text.items.len);
    self.snap(self.mode == .insert);
    if (self.mode != .insert and self.cursor == self.lineEnd(self.cursor) and self.cursor > self.lineStart(self.cursor)) self.cursor = self.prev(self.cursor);
}
fn class(self: *const Editor, at: usize, big: bool) u8 {
    if (at >= self.text.items.len) return 0;
    const c = self.text.items[at];
    if (std.ascii.isWhitespace(c)) return 0;
    if (big or c >= 128 or std.ascii.isAlphanumeric(c) or c == '_') return 1;
    return 2;
}
fn word(self: *const Editor, pos: usize, cp: u21) usize {
    const big = cp == 'W' or cp == 'B' or cp == 'E';
    var at = pos;
    if (cp == 'b' or cp == 'B') {
        at = self.prev(at);
        while (at > 0 and self.class(at, big) == 0) at = self.prev(at);
        const category = self.class(at, big);
        while (at > 0 and self.class(self.prev(at), big) == category) at = self.prev(at);
    } else if (cp == 'e' or cp == 'E') {
        at = self.next(at);
        while (at < self.text.items.len and self.class(at, big) == 0) at = self.next(at);
        const category = self.class(at, big);
        while (self.next(at) < self.text.items.len and self.class(self.next(at), big) == category) at = self.next(at);
    } else {
        const category = self.class(at, big);
        while (at < self.text.items.len and self.class(at, big) == category) at = self.next(at);
        while (at < self.text.items.len and self.class(at, big) == 0) at = self.next(at);
    }
    return at;
}
fn vertical(self: *const Editor, pos: usize, down: bool) usize {
    const start = self.lineStart(pos);
    var it = vaxis.unicode.graphemeIterator(self.text.items[start..pos]);
    var column: usize = 0;
    while (it.next()) |_| column += 1;
    var at: usize = if (down) blk: {
        const end = self.lineEnd(pos);
        if (end == self.text.items.len) return pos;
        break :blk end + 1;
    } else if (start == 0) return pos else self.lineStart(start - 1);
    const end = self.lineEnd(at);
    while (column > 0 and at < end) : (column -= 1) at = self.next(at);
    return at;
}
fn motion(self: *const Editor, cp: u21, n: usize) ?usize {
    var at = self.cursor;
    if (cp == '0') return self.lineStart(at);
    if (cp == '$') {
        for (1..n) |_| {
            const end = self.lineEnd(at);
            if (end < self.text.items.len) at = end + 1;
        }
        return self.lineEnd(at);
    }
    if (cp == '^') {
        at = self.lineStart(at);
        while (at < self.lineEnd(at) and std.ascii.isWhitespace(self.text.items[at])) at = self.next(at);
        return at;
    }
    if (cp == 'G') return self.lineStart(self.text.items.len);
    for (0..@min(n, limit)) |_| switch (cp) {
        'h' => {
            if (at > self.lineStart(at)) at = self.prev(at);
        },
        'l' => {
            if (at < self.lineEnd(at)) at = self.next(at);
        },
        'j' => at = self.vertical(at, true),
        'k' => at = self.vertical(at, false),
        'w', 'W', 'b', 'B', 'e', 'E' => at = self.word(at, cp),
        else => return null,
    };
    return at;
}
fn splice(self: *Editor, start: usize, end: usize, value: []const u8) !void {
    if (self.text.items.len - (end - start) + value.len > limit) return error.PromptTooLarge;
    try self.text.replaceRange(self.a, start, end - start, value);
    self.cursor = start + value.len;
    self.snap(self.mode == .insert);
}
fn operate(self: *Editor, op: u21, start: usize, end: usize, linewise: bool) !void {
    if (start == end) return;
    self.register.clearRetainingCapacity();
    try self.register.appendSlice(self.a, self.text.items[start..end]);
    if (linewise and self.register.items[self.register.items.len - 1] != '\n') try self.register.append(self.a, '\n');
    self.linewise = linewise;
    if (op == 'y') {
        self.cursor = start;
        self.mode = .normal;
        self.clamp();
        return;
    }
    try self.checkpoint();
    try self.splice(start, end, "");
    self.mode = if (op == 'c') .insert else .normal;
    self.insert_saved = op == 'c';
    self.clamp();
}
pub fn selection(self: *const Editor) ?[2]usize {
    if (self.mode != .visual and self.mode != .visual_line) return null;
    var start = @min(self.anchor, self.cursor);
    var end = @max(self.anchor, self.cursor);
    if (self.mode == .visual_line) {
        start = self.lineStart(start);
        end = self.lineEnd(end);
        if (end < self.text.items.len) end += 1;
    } else end = self.next(end);
    return .{ start, end };
}
fn restore(self: *Editor, backwards: bool) !void {
    const source = if (backwards) &self.undo else &self.redo;
    if (source.items.len == 0) return;
    try self.push(if (backwards) &self.redo else &self.undo);
    const saved = source.pop().?;
    defer self.a.free(saved.text);
    self.text.clearRetainingCapacity();
    try self.text.appendSlice(self.a, saved.text);
    self.cursor = saved.cursor;
    self.mode = .normal;
    self.clamp();
}
pub fn insert(self: *Editor, value: []const u8) !void {
    if (!std.unicode.utf8ValidateSlice(value) or self.text.items.len + value.len > limit) return error.PromptTooLarge;
    try self.beforeInsert();
    try self.splice(self.cursor, self.cursor, value);
}
pub fn paste(self: *Editor, value: []const u8) !void {
    if (value.len > limit) return error.PromptTooLarge;
    // Paste is data, never Vim commands or submission. Escape/control bytes are
    // refused, not interpreted by the terminal or the modal command handler.
    var clean: std.ArrayList(u8) = .empty;
    defer clean.deinit(self.a);
    var it = (std.unicode.Utf8View.init(value) catch return error.InvalidUtf8).iterator();
    var previous_cr = false;
    while (it.nextCodepointSlice()) |bytes| {
        const cp = std.unicode.utf8Decode(bytes) catch unreachable;
        if (cp == '\n' and previous_cr) {
            previous_cr = false;
            continue;
        }
        previous_cr = cp == '\r';
        if (cp == '\r') try clean.append(self.a, '\n') else if (cp == '\t') try clean.appendSlice(self.a, "    ") else if (cp == '\n' or (cp >= 32 and !(cp >= 127 and cp <= 159))) try clean.appendSlice(self.a, bytes);
    }
    if (self.text.items.len + clean.items.len > limit) return error.PromptTooLarge;
    if (clean.items.len == 0) return;
    if (self.mode != .insert) {
        self.mode = .insert;
        self.insert_saved = false;
    }
    try self.insert(clean.items);
}
pub fn key(self: *Editor, event: vaxis.Key) !void {
    if (event.matches(vaxis.Key.escape, .{}) or event.matches('[', .{ .ctrl = true })) {
        if (self.mode == .insert and self.cursor > self.lineStart(self.cursor)) self.cursor = self.prev(self.cursor);
        self.mode = .normal;
        self.pending = null;
        self.count = 0;
        self.clamp();
        return;
    }
    if (self.mode == .insert) {
        if (event.matches(vaxis.Key.left, .{})) {
            self.cursor = self.prev(self.cursor);
            return;
        }
        if (event.matches(vaxis.Key.right, .{})) {
            self.cursor = self.next(self.cursor);
            return;
        }
        if (event.matches(vaxis.Key.up, .{})) {
            self.cursor = self.vertical(self.cursor, false);
            return;
        }
        if (event.matches(vaxis.Key.down, .{})) {
            self.cursor = self.vertical(self.cursor, true);
            return;
        }
        if (event.matches(vaxis.Key.backspace, .{}) or event.matches('h', .{ .ctrl = true })) {
            if (self.cursor > 0) {
                try self.beforeInsert();
                try self.splice(self.prev(self.cursor), self.cursor, "");
            }
            return;
        }
        if (event.matches(vaxis.Key.delete, .{})) {
            try self.beforeInsert();
            try self.splice(self.cursor, self.next(self.cursor), "");
            return;
        }
        if (event.matches('w', .{ .ctrl = true }) or event.matches('u', .{ .ctrl = true })) {
            try self.beforeInsert();
            try self.splice(if (event.codepoint == 'w') self.word(self.cursor, 'b') else self.lineStart(self.cursor), self.cursor, "");
            return;
        }
        if (event.matches(vaxis.Key.enter, .{}) or event.matches(vaxis.Key.enter, .{ .shift = true }) or event.matches('j', .{ .ctrl = true })) {
            try self.insert("\n");
            return;
        }
        if (event.matches(vaxis.Key.tab, .{})) {
            try self.insert("    ");
            return;
        }
        if (!event.mods.ctrl and !event.mods.alt) if (event.text) |text| {
            try self.paste(text);
        };
        return;
    }
    if (event.matches('r', .{ .ctrl = true })) {
        if (self.mode == .normal) try self.restore(false);
        return;
    }
    if (event.mods.ctrl or event.mods.alt) return;
    const cp: u21 = if (event.text) |text| blk: {
        var it = (std.unicode.Utf8View.init(text) catch return).iterator();
        break :blk it.nextCodepoint() orelse return;
    } else event.codepoint;
    if (self.pending == 'r') {
        self.pending = null;
        if (event.text) |text| {
            if (self.cursor < self.lineEnd(self.cursor)) {
                try self.checkpoint();
                const at = self.cursor;
                try self.splice(at, self.next(at), text);
                self.cursor = at;
                self.clamp();
            }
        }
        return;
    }
    if (cp >= '0' and cp <= '9' and (cp != '0' or self.count > 0)) {
        self.count = @min(9999, self.count * 10 + cp - '0');
        return;
    }
    const counted = self.count > 0;
    const n = @max(1, self.count);
    self.count = 0;
    if (cp == 'G' and counted and self.pending == null) {
        self.cursor = 0;
        for (1..n) |_| self.cursor = self.vertical(self.cursor, true);
        self.clamp();
        return;
    }
    if (self.pending) |op| {
        self.pending = null;
        if (op == 'g') {
            if (cp == 'g') {
                self.cursor = 0;
                for (1..n) |_| self.cursor = self.vertical(self.cursor, true);
                self.clamp();
            }
            return;
        }
        const count = @min(limit, n * self.operator_count);
        if (cp == op) {
            const start = self.lineStart(self.cursor);
            var end = self.cursor;
            for (0..count) |_| {
                end = self.lineEnd(end);
                if (end < self.text.items.len) end += 1;
            }
            // cc preserves the current line break while replacing its text.
            if (op == 'c' and end > start and self.text.items[end - 1] == '\n') end -= 1;
            try self.operate(op, start, end, op != 'c');
            if (op == 'c') {
                self.mode = .insert;
                self.insert_saved = start != end;
            }
        } else {
            // Vim cw behaves as ce when starting on a word, not as dw + i.
            const motion_key = if (op == 'c' and cp == 'w' and self.class(self.cursor, false) != 0) @as(u21, 'e') else cp;
            const single_cw = op == 'c' and cp == 'w' and count == 1 and self.class(self.cursor, false) != self.class(self.next(self.cursor), false);
            if (if (single_cw) @as(?usize, self.cursor) else self.motion(motion_key, count)) |target| {
                var start = @min(self.cursor, target);
                var end = @max(self.cursor, target);
                const by_line = motion_key == 'j' or motion_key == 'k';
                if (by_line) {
                    start = self.lineStart(start);
                    end = self.lineEnd(end);
                    if (end < self.text.items.len and op != 'c') end += 1;
                } else if (motion_key == 'e' or motion_key == 'E') end = self.next(end);
                try self.operate(op, start, end, by_line and op != 'c');
            }
        }
        return;
    }
    if (self.selection()) |range| if (cp == 'd' or cp == 'x' or cp == 'c' or cp == 'y') {
        try self.operate(if (cp == 'x') 'd' else cp, range[0], range[1], self.mode == .visual_line);
        return;
    };
    const motion_key: u21 = switch (cp) {
        vaxis.Key.left => 'h',
        vaxis.Key.right => 'l',
        vaxis.Key.up => 'k',
        vaxis.Key.down, vaxis.Key.enter => 'j',
        else => cp,
    };
    if (self.motion(motion_key, n)) |at| {
        self.cursor = at;
        self.clamp();
        return;
    }
    if (self.selection() != null and cp != 'v' and cp != 'V' and cp != 'g') return;
    switch (cp) {
        'i', 'a', 'I', 'A' => {
            if (cp == 'a' and self.cursor < self.lineEnd(self.cursor)) self.cursor = self.next(self.cursor);
            if (cp == 'I') self.cursor = self.motion('^', 1).?;
            if (cp == 'A') self.cursor = self.lineEnd(self.cursor);
            self.mode = .insert;
            self.insert_saved = false;
        },
        'o', 'O' => {
            try self.checkpoint();
            const at = if (cp == 'o') self.lineEnd(self.cursor) else self.lineStart(self.cursor);
            try self.splice(at, at, "\n");
            if (cp == 'O') self.cursor = at;
            self.mode = .insert;
            self.insert_saved = true;
        },
        'v', 'V' => {
            const mode: Mode = if (cp == 'V') .visual_line else .visual;
            if (self.mode == mode) self.mode = .normal else {
                if (self.mode == .normal) self.anchor = self.cursor;
                self.mode = mode;
            }
        },
        'd', 'c', 'y', 'g', 'r' => {
            self.pending = cp;
            self.operator_count = n;
            if (cp == 'g') self.count = if (n > 1) n else 0;
        },
        'x' => {
            var end = self.cursor;
            for (0..n) |_| {
                if (end < self.lineEnd(end)) end = self.next(end);
            }
            try self.operate('d', self.cursor, end, false);
        },
        'X' => {
            var start = self.cursor;
            for (0..n) |_| {
                if (start > self.lineStart(start)) start = self.prev(start);
            }
            try self.operate('d', start, self.cursor, false);
        },
        'D', 'C' => {
            if (cp == 'C' and self.cursor == self.lineEnd(self.cursor)) {
                self.mode = .insert;
                self.insert_saved = false;
            } else try self.operate(if (cp == 'D') 'd' else 'c', self.cursor, self.lineEnd(self.cursor), false);
        },
        'Y' => {
            const start = self.lineStart(self.cursor);
            const end = self.lineEnd(self.cursor);
            try self.operate('y', start, @min(end + 1, self.text.items.len), true);
        },
        'p', 'P' => {
            if (self.register.items.len == 0) return;
            const extra: usize = if (self.linewise and cp == 'p' and self.lineEnd(self.cursor) == self.text.items.len) 1 else 0;
            if (self.text.items.len + self.register.items.len + extra > limit) return error.PromptTooLarge;
            try self.checkpoint();
            var at = if (cp == 'P') self.cursor else if (self.cursor < self.lineEnd(self.cursor)) self.next(self.cursor) else self.cursor;
            if (self.linewise) {
                at = if (cp == 'P') self.lineStart(self.cursor) else self.lineEnd(self.cursor);
                if (cp == 'p') {
                    if (at < self.text.items.len) at += 1 else {
                        try self.splice(at, at, "\n");
                        at += 1;
                    }
                }
            }
            try self.splice(at, at, self.register.items);
            self.cursor = if (self.linewise) at else self.prev(self.cursor);
            self.clamp();
        },
        'u' => try self.restore(true),
        else => {},
    }
}
fn keys(editor: *Editor, text: []const u8) !void {
    for (text) |c| {
        const one = [_]u8{c};
        try editor.key(.{ .codepoint = c, .text = &one });
    }
}
test "Vim insert, counts, operators, change, yank/paste and undo/redo" {
    var e = Editor.init(std.testing.allocator);
    defer e.deinit();
    try keys(&e, "ihello world");
    try e.key(.{ .codepoint = vaxis.Key.escape });
    try keys(&e, "0dw");
    try std.testing.expectEqualStrings("world", e.text.items);
    try keys(&e, "u");
    try std.testing.expectEqualStrings("hello world", e.text.items);
    try e.key(.{ .codepoint = 'r', .mods = .{ .ctrl = true } });
    try std.testing.expectEqualStrings("world", e.text.items);
    try keys(&e, "0cwZig");
    try e.key(.{ .codepoint = vaxis.Key.escape });
    try std.testing.expectEqualStrings("Zig", e.text.items);
    try keys(&e, "u0yyP");
    try std.testing.expectEqualStrings("world\nworld", e.text.items);
    try e.set("one two three");
    try keys(&e, "2dw");
    try std.testing.expectEqualStrings("three", e.text.items);
}
test "joined graphemes, counts and bounded undo history remain coherent" {
    var e = Editor.init(std.testing.allocator);
    defer e.deinit();
    try e.set("👩💻");
    try keys(&e, "a");
    try e.paste("\u{200d}");
    try std.testing.expectEqualStrings("👩‍💻", e.text.items);
    try std.testing.expectEqual(e.text.items.len, e.cursor);
    try e.key(.{ .codepoint = vaxis.Key.escape });
    try keys(&e, "x");
    try std.testing.expectEqualStrings("", e.text.items);
    try e.set("a word");
    try keys(&e, "cwZ");
    try e.key(.{ .codepoint = vaxis.Key.escape });
    try std.testing.expectEqualStrings("Z word", e.text.items);
    try e.set("one\ntwo\nthree");
    try keys(&e, "2Gdd");
    try std.testing.expectEqualStrings("one\nthree", e.text.items);
    for (0..40) |_| {
        try keys(&e, "ix");
        try e.key(.{ .codepoint = vaxis.Key.escape });
    }
    try std.testing.expectEqual(32, e.undo.items.len);
    const before = try std.testing.allocator.dupe(u8, e.text.items);
    defer std.testing.allocator.free(before);
    const large: [limit]u8 = @splat('x');
    try std.testing.expectError(error.PromptTooLarge, e.paste(&large));
    try std.testing.expectEqualStrings(before, e.text.items);
}

test "grapheme-safe motions, visual deletion, multiline and literal bracketed paste" {
    var e = Editor.init(std.testing.allocator);
    defer e.deinit();
    try e.set("a👩🏽‍💻éz");
    try keys(&e, "lx");
    try std.testing.expectEqualStrings("aéz", e.text.items);
    try keys(&e, "vld");
    try std.testing.expectEqualStrings("a", e.text.items);
    try e.set("one\ntwo\nthree");
    try keys(&e, "jdd");
    try std.testing.expectEqualStrings("one\nthree", e.text.items);
    try keys(&e, "u");
    try std.testing.expectEqualStrings("one\ntwo\nthree", e.text.items);
    try e.set("");
    try e.paste(":q\rhello\x1b[31m");
    try std.testing.expectEqualStrings(":q\nhello[31m", e.text.items);
    try std.testing.expectEqual(.insert, e.mode);
    try e.set("");
    try e.paste("a\r\nb\rc\n\td");
    try std.testing.expectEqualStrings("a\nb\nc\n    d", e.text.items);
}
