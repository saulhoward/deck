//! Bounded display-only Markdown. Never emits terminal escapes/OSC, executes
//! HTML, fetches links/images, or changes retained message bytes.
const std = @import("std");
const vaxis = @import("vaxis");
const fw = vaxis.vxfw;
const theme = @import("tui_theme.zig");
pub const Line = []const vaxis.Cell;
const Cells = std.ArrayList(vaxis.Cell);

fn append(ctx: fw.DrawContext, cells: *Cells, text: []const u8, style: vaxis.Style) !void {
    var it = vaxis.unicode.graphemeIterator(text);
    while (it.next()) |g| {
        var bytes = g.bytes(text);
        var unsafe = bytes.len > 256;
        var cps = (std.unicode.Utf8View.init(bytes) catch {
            try cells.append(ctx.arena, .{ .char = .{ .grapheme = "�", .width = 1 }, .style = style });
            continue;
        }).iterator();
        while (cps.nextCodepoint()) |cp| if (cp < 32 or (cp >= 127 and cp <= 159) or cp == 0x061c or cp == 0x200b or cp == 0x200e or cp == 0x200f or (cp >= 0x2028 and cp <= 0x202e) or (cp >= 0x2060 and cp <= 0x206f) or cp == 0xfeff) {
            unsafe = true;
        };
        if (unsafe) bytes = "�";
        var columns = ctx.stringWidth(bytes);
        if (columns == 0 or columns > 16) {
            bytes = "�";
            columns = 1;
        }
        try cells.append(ctx.arena, .{ .char = .{ .grapheme = bytes, .width = @intCast(columns) }, .style = style });
    }
}
fn inlineText(ctx: fw.DrawContext, cells: *Cells, text: []const u8, style: vaxis.Style, depth: u8) std.mem.Allocator.Error!void {
    if (depth >= 8) return append(ctx, cells, text, style);
    var i: usize = 0;
    var plain: usize = 0;
    while (i < text.len) {
        var marker: usize = 0;
        if (text[i] == '*' or text[i] == '_' or text[i] == '`' or text[i] == '~') {
            marker = if (i + 1 < text.len and text[i + 1] == text[i]) 2 else 1;
            if (text[i] == '~' and marker == 1) marker = 0;
            // Don't turn snake_case or identifiers into emphasis.
            if (text[i] == '_' and i > 0 and std.ascii.isAlphanumeric(text[i - 1])) marker = 0;
        }
        if (marker > 0) {
            if (std.mem.indexOfPos(u8, text, i + marker, text[i..][0..marker])) |end| {
                if (end > i + marker) {
                    try append(ctx, cells, text[plain..i], style);
                    var changed = style;
                    switch (text[i]) {
                        '`' => changed.bg = .{ .rgb = .{ 42, 42, 42 } },
                        '~' => changed.strikethrough = true,
                        else => {
                            if (marker == 2) changed.bold = true else changed.italic = true;
                        },
                    }
                    if (text[i] == '`') try append(ctx, cells, text[i + marker .. end], changed) else try inlineText(ctx, cells, text[i + marker .. end], changed, depth + 1);
                    i = end + marker;
                    plain = i;
                    continue;
                }
            }
        }
        if (text[i] == '\\' and i + 1 < text.len and std.ascii.isPunctuation(text[i + 1])) {
            try append(ctx, cells, text[plain..i], style);
            try append(ctx, cells, text[i + 1 ..][0..1], style);
            i += 2;
            plain = i;
            continue;
        }
        if (text[i] == '[') {
            if (std.mem.indexOfPos(u8, text, i + 1, "](")) |middle| {
                if (std.mem.indexOfScalarPos(u8, text, middle + 2, ')')) |end| {
                    try append(ctx, cells, text[plain..i], style);
                    try inlineText(ctx, cells, text[i + 1 .. middle], style, depth + 1);
                    try append(ctx, cells, " (", theme.dim);
                    try append(ctx, cells, text[middle + 2 .. end], theme.dim);
                    try append(ctx, cells, ")", theme.dim);
                    i = end + 1;
                    plain = i;
                    continue;
                }
            }
        }
        i += 1;
    }
    try append(ctx, cells, text[plain..], style);
}
fn width(cells: Line) usize {
    var n: usize = 0;
    for (cells) |c| n += c.char.width;
    return n;
}
fn space(cell: vaxis.Cell) bool {
    return std.mem.eql(u8, cell.char.grapheme, " ");
}
fn wrap(ctx: fw.DrawContext, out: *std.ArrayList(Line), cells: Line, columns: u16) !void {
    if (cells.len == 0) {
        try out.append(ctx.arena, cells);
        return;
    }
    var start: usize = 0;
    while (start < cells.len) {
        var end = start;
        var cols: usize = 0;
        var last_space: ?usize = null;
        while (end < cells.len and cols + cells[end].char.width <= columns) : (end += 1) {
            cols += cells[end].char.width;
            if (space(cells[end])) last_space = end;
        }
        if (end == start) {
            try out.append(ctx.arena, try ctx.arena.dupe(vaxis.Cell, &.{.{ .char = .{ .grapheme = "�", .width = 1 }, .style = cells[start].style }}));
            start += 1;
            continue;
        }
        if (end < cells.len) if (last_space) |at| {
            if (at > start) end = at;
        };
        try out.append(ctx.arena, cells[start..end]);
        start = end;
        while (start < cells.len and space(cells[start])) start += 1;
    }
}
fn splitCells(a: std.mem.Allocator, text: []const u8) ![][]const u8 {
    const trimmed = std.mem.trim(u8, text, " \t\r");
    var body = trimmed;
    if (std.mem.startsWith(u8, body, "|")) body = body[1..];
    if (std.mem.endsWith(u8, body, "|")) body = body[0 .. body.len - 1];
    var cells: std.ArrayList([]const u8) = .empty;
    var start: usize = 0;
    var escaped = false;
    var code = false;
    for (body, 0..) |c, i| {
        if (c == '`' and !escaped) code = !code;
        if (c == '|' and !escaped and !code) {
            try cells.append(a, std.mem.trim(u8, body[start..i], " \t"));
            start = i + 1;
        }
        escaped = c == '\\' and !escaped;
    }
    try cells.append(a, std.mem.trim(u8, body[start..], " \t"));
    return cells.toOwnedSlice(a);
}
fn separator(cells: [][]const u8) bool {
    if (cells.len < 2 or cells.len > 16) return false;
    for (cells) |cell| {
        const dashes = std.mem.trim(u8, cell, ":");
        if (dashes.len < 3) return false;
        for (dashes) |c| if (c != '-') return false;
    }
    return true;
}
fn table(ctx: fw.DrawContext, out: *std.ArrayList(Line), lines: []const []const u8, alignment: [][]const u8, columns: u16, style: vaxis.Style) !void {
    const count = alignment.len;
    var widths: [16]u16 = @splat(1);
    var parsed: std.ArrayList([]Line) = .empty;
    for (lines, 0..) |text, r| {
        const values = try splitCells(ctx.arena, text);
        const row = try ctx.arena.alloc(Line, count);
        for (0..count) |col| {
            var cells: Cells = .empty;
            var s = style;
            s.bold = r == 0;
            if (col < values.len) try inlineText(ctx, &cells, values[col], s, 0);
            row[col] = try cells.toOwnedSlice(ctx.arena);
            widths[col] = @max(widths[col], @as(u16, @intCast(@min(80, width(row[col])))));
        }
        try parsed.append(ctx.arena, row);
    }
    if (columns < count * 4 - 2) {
        // Very narrow pane: readable stacked fields, never truncated data.
        for (parsed.items) |row| {
            for (row) |cell| try wrap(ctx, out, cell, columns);
            try out.append(ctx.arena, &.{});
        }
        return;
    }
    const budget = columns - 2 * (count - 1);
    while (true) {
        var total: usize = 0;
        var largest: usize = 0;
        for (widths[0..count], 0..) |w, i| {
            total += w;
            if (w > widths[largest]) largest = i;
        }
        if (total <= budget) break;
        widths[largest] -= 1;
    }
    for (parsed.items, 0..) |row, r| {
        var wrapped: [16]std.ArrayList(Line) = @splat(.empty);
        var height: usize = 1;
        for (row, 0..) |cell, col| {
            try wrap(ctx, &wrapped[col], cell, widths[col]);
            height = @max(height, wrapped[col].items.len);
        }
        for (0..height) |y| {
            var cells: Cells = .empty;
            for (0..count) |col| {
                if (col > 0) try append(ctx, &cells, "  ", theme.dim);
                const part: Line = if (y < wrapped[col].items.len) wrapped[col].items[y] else &.{};
                const spare = widths[col] - width(part);
                const right = std.mem.endsWith(u8, alignment[col], ":");
                const before = if (right) (if (std.mem.startsWith(u8, alignment[col], ":")) spare / 2 else spare) else 0;
                for (0..before) |_| try append(ctx, &cells, " ", style);
                try cells.appendSlice(ctx.arena, part);
                for (0..spare - before) |_| try append(ctx, &cells, " ", style);
            }
            try out.append(ctx.arena, try cells.toOwnedSlice(ctx.arena));
        }
        if (r == 0) {
            var cells: Cells = .empty;
            for (0..count) |col| {
                if (col > 0) try append(ctx, &cells, "  ", theme.rule);
                for (0..widths[col]) |_| try append(ctx, &cells, "─", theme.rule);
            }
            try out.append(ctx.arena, try cells.toOwnedSlice(ctx.arena));
        }
    }
}
pub fn render(ctx: fw.DrawContext, text: []const u8, columns: u16, style: vaxis.Style) ![]Line {
    var source: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, text, '\n');
    while (it.next()) |row| try source.append(ctx.arena, std.mem.trimEnd(u8, row, "\r"));
    var out: std.ArrayList(Line) = .empty;
    var fence: ?u8 = null;
    var fence_size: usize = 0;
    var i: usize = 0;
    while (i < source.items.len) : (i += 1) {
        const raw = source.items[i];
        const trimmed = std.mem.trimStart(u8, raw, " ");
        if (trimmed.len >= 3 and (trimmed[0] == '`' or trimmed[0] == '~')) {
            var n: usize = 0;
            while (n < trimmed.len and trimmed[n] == trimmed[0]) : (n += 1) {}
            if (n >= 3 and (fence == null or (fence.? == trimmed[0] and n >= fence_size))) {
                if (fence != null) fence = null else {
                    fence = trimmed[0];
                    fence_size = n;
                }
                try out.append(ctx.arena, &.{});
                continue;
            }
        }
        if (fence != null) {
            var cells: Cells = .empty;
            var code = style;
            code.bg = .{ .rgb = .{ 32, 32, 32 } };
            try append(ctx, &cells, raw, code);
            try wrap(ctx, &out, cells.items, columns);
            continue;
        }
        if (i + 1 < source.items.len and std.mem.indexOfScalar(u8, raw, '|') != null) {
            const alignment = try splitCells(ctx.arena, source.items[i + 1]);
            if (separator(alignment) and (try splitCells(ctx.arena, raw)).len == alignment.len) {
                var end = i + 2;
                while (end < source.items.len and std.mem.indexOfScalar(u8, source.items[end], '|') != null and std.mem.trim(u8, source.items[end], " ").len > 0) : (end += 1) {}
                var table_lines: std.ArrayList([]const u8) = .empty;
                try table_lines.append(ctx.arena, raw);
                try table_lines.appendSlice(ctx.arena, source.items[i + 2 .. end]);
                try table(ctx, &out, table_lines.items, alignment, columns, style);
                i = end - 1;
                continue;
            }
        }
        var body = raw;
        var s = style;
        var prefix: []const u8 = "";
        var hashes: usize = 0;
        while (hashes < trimmed.len and trimmed[hashes] == '#') : (hashes += 1) {}
        if (hashes > 0 and hashes <= 6 and hashes < trimmed.len and trimmed[hashes] == ' ') {
            body = trimmed[hashes + 1 ..];
            s.bold = true;
        }
        if (std.mem.startsWith(u8, trimmed, "> ")) {
            body = trimmed[2..];
            prefix = "│ ";
            s = theme.dim;
        }
        if (std.mem.startsWith(u8, trimmed, "- ") or std.mem.startsWith(u8, trimmed, "* ") or std.mem.startsWith(u8, trimmed, "+ ")) {
            body = trimmed[2..];
            prefix = "• ";
        }
        if (std.mem.eql(u8, trimmed, "---") or std.mem.eql(u8, trimmed, "***") or std.mem.eql(u8, trimmed, "___")) {
            var cells: Cells = .empty;
            for (0..columns) |_| try append(ctx, &cells, "─", theme.rule);
            try out.append(ctx.arena, try cells.toOwnedSlice(ctx.arena));
            continue;
        }
        var cells: Cells = .empty;
        try append(ctx, &cells, prefix, theme.dim);
        try inlineText(ctx, &cells, body, s, 0);
        try wrap(ctx, &out, cells.items, columns);
    }
    return out.toOwnedSlice(ctx.arena);
}
test "Markdown emphasis, Unicode tables and hostile controls stay bounded display data" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    fw.DrawContext.init(.unicode);
    const ctx: fw.DrawContext = .{ .arena = arena.allocator(), .min = .{}, .max = .{ .width = 80, .height = 40 }, .cell_size = .{ .width = 8, .height = 16 } };
    const text = "# Heading\n**bold** and `code`\n| Name | Value |\n| :--- | ---: |\n| 界👩‍💻 | long wrapping value |\n```\n**literal**\n```\n\x1b]52;c;bad\x07";
    for ([_]u16{ 8, 20, 80 }) |cols| {
        const lines = try render(ctx, text, cols, theme.base);
        var bold = false;
        var joined: std.ArrayList(u8) = .empty;
        for (lines) |row| {
            try std.testing.expect(width(row) <= cols);
            for (row) |cell| {
                bold = bold or cell.style.bold;
                try joined.appendSlice(ctx.arena, cell.char.grapheme);
                try std.testing.expect(std.mem.indexOfScalar(u8, cell.char.grapheme, 27) == null);
            }
        }
        try std.testing.expect(bold);
        if (cols == 80) try std.testing.expect(std.mem.indexOf(u8, joined.items, "**literal**") != null);
    }
}
