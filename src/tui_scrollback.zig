//! Bounded, owned copies of projected history pages only. No requests, cursors,
//! transcript storage, draft, status or other snapshot state belongs here.
const std = @import("std");
const wire = @import("generated/contracts.zig");
const Allocator = std.mem.Allocator;
const Self = @This();

pub const max_pages = 16;
pub const max_bytes = 8 * 1024 * 1024;
pub const max_page_bytes = 1024 * 1024;

pub const Page = struct {
    parsed: std.json.Parsed([]const wire.TuiEntry),
    /// The caller refreshes this count each draw, including after reflow.
    rows: usize,
    /// Serialized entries size, not the parsed arena's allocation size.
    bytes: usize,

    pub fn entries(self: *const Page) []const wire.TuiEntry {
        return self.parsed.value;
    }
};

/// Newest first. Append the previously oldest displayed page before replacing
/// it with an older snapshot. Render the current snapshot, then these in reverse.
pages: std.ArrayList(Page) = .empty,
bytes: usize = 0,
newer_omitted: bool = false,

/// Own a copy before changing the cache; failures leave all prior pages intact.
/// Empty pages are a no-op. Return the rendered rows evicted from the NEWEST end
/// (index zero), so the caller can adjust its viewport. Use the same allocator
/// for retain and clear. Input is an already bounded, validated bridge page.
pub fn retain(self: *Self, a: Allocator, entries: []const wire.TuiEntry, rows: usize) !usize {
    if (entries.len == 0) return 0;

    // The bridge already caps frames, but check the serialized entries size
    // without allocating first so even an oversized caller cannot grow a JSON
    // buffer without bound. This pass retains no bytes.
    var size = std.Io.Writer.Discarding.init(&.{});
    try std.json.Stringify.value(entries, .{}, &size.writer);
    if (size.fullCount() > max_page_bytes) return error.PageTooLarge;

    const encoded = try std.json.Stringify.valueAlloc(a, entries, .{});
    defer a.free(encoded);
    const parsed = try std.json.parseFromSlice([]const wire.TuiEntry, a, encoded, .{ .allocate = .alloc_always });
    errdefer parsed.deinit();
    try self.pages.append(a, .{ .parsed = parsed, .rows = rows, .bytes = encoded.len });
    self.bytes += encoded.len;

    var dropped_rows: usize = 0;
    while (self.pages.items.len > max_pages or self.bytes > max_bytes) {
        const page = self.pages.orderedRemove(0);
        dropped_rows += page.rows;
        self.bytes -= page.bytes;
        page.parsed.deinit();
        self.newer_omitted = true;
    }
    return dropped_rows;
}

/// Free every owned arena and the list allocation; safe to reuse or clear again.
pub fn clear(self: *Self, a: Allocator) void {
    for (self.pages.items) |page| page.parsed.deinit();
    self.pages.deinit(a);
    self.* = .{};
}

test "scrollback owns Unicode entries and every typed part independently of the source" {
    const a = std.testing.allocator;
    var cache: Self = .{};
    defer cache.clear(a);
    {
        var source = std.heap.ArenaAllocator.init(a);
        defer source.deinit();
        const sa = source.allocator();
        const text = try sa.dupe(u8, "界 é 👩‍💻\nquoted: \"hello\"\\\t");
        const tool_name = try sa.dupe(u8, "functions.工具");
        const parts = try sa.dupe(wire.TuiPart, &.{
            .{ .kind = .text, .text = text },
            .{ .kind = .notice, .text = "clipped", .clipped = true },
            .{ .kind = .tool_request, .text = "request", .toolName = tool_name, .isError = false },
            .{ .kind = .tool, .text = text, .toolName = tool_name, .isError = true, .clipped = false },
        });
        const entries = try sa.dupe(wire.TuiEntry, &.{
            .{ .id = 42, .role = .assistant, .text = text, .parts = parts, .thinkingTokens = 123 },
            .{ .id = 43, .role = .user, .text = "plain" },
            .{ .id = 44, .role = .tool, .text = "", .parts = &.{} },
        });
        const encoded = try std.json.Stringify.valueAlloc(a, entries, .{});
        defer a.free(encoded);
        try std.testing.expectEqual(@as(usize, 0), try cache.retain(a, entries, 19));
        try std.testing.expectEqual(encoded.len, cache.bytes);
        try std.testing.expectEqual(encoded.len, cache.pages.items[0].bytes);
        @memset(text, 'x');
        @memset(tool_name, 'y');
        parts[2] = .{ .kind = .text, .text = "changed" };
        entries[0] = .{ .id = 99, .role = .note, .text = "changed" };
    }
    const page = &cache.pages.items[0];
    const entries = page.entries();
    try std.testing.expectEqual(@as(usize, 19), page.rows);
    try std.testing.expectEqual(@as(usize, 3), entries.len);
    try std.testing.expectEqual(@as(i64, 42), entries[0].id);
    try std.testing.expectEqual(.assistant, entries[0].role);
    try std.testing.expectEqualStrings("界 é 👩‍💻\nquoted: \"hello\"\\\t", entries[0].text);
    try std.testing.expectEqual(@as(?i64, 123), entries[0].thinkingTokens);
    const parts = entries[0].parts.?;
    try std.testing.expectEqual(@as(usize, 4), parts.len);
    try std.testing.expectEqual(.text, parts[0].kind);
    try std.testing.expectEqualStrings(entries[0].text, parts[0].text);
    try std.testing.expect(parts[0].toolName == null and parts[0].isError == null and parts[0].clipped == null);
    try std.testing.expectEqual(.notice, parts[1].kind);
    try std.testing.expectEqualStrings("clipped", parts[1].text);
    try std.testing.expectEqual(@as(?bool, true), parts[1].clipped);
    try std.testing.expectEqual(.tool_request, parts[2].kind);
    try std.testing.expectEqualStrings("request", parts[2].text);
    try std.testing.expectEqualStrings("functions.工具", parts[2].toolName.?);
    try std.testing.expectEqual(@as(?bool, false), parts[2].isError);
    try std.testing.expectEqual(.tool, parts[3].kind);
    try std.testing.expectEqualStrings(entries[0].text, parts[3].text);
    try std.testing.expectEqualStrings("functions.工具", parts[3].toolName.?);
    try std.testing.expectEqual(@as(?bool, true), parts[3].isError);
    try std.testing.expectEqual(@as(?bool, false), parts[3].clipped);
    try std.testing.expectEqual(@as(i64, 43), entries[1].id);
    try std.testing.expectEqual(.user, entries[1].role);
    try std.testing.expectEqualStrings("plain", entries[1].text);
    try std.testing.expect(entries[1].parts == null and entries[1].thinkingTokens == null);
    try std.testing.expectEqual(.tool, entries[2].role);
    try std.testing.expectEqual(@as(usize, 0), entries[2].parts.?.len);
    try std.testing.expect(!cache.newer_omitted);
}

test "scrollback pages are newest first and reverse rendering preserves entry order" {
    const a = std.testing.allocator;
    var cache: Self = .{};
    defer cache.clear(a);
    for (0..3) |i| {
        const first: i64 = @intCast(7 - 2 * i);
        const entries: []const wire.TuiEntry = &.{
            .{ .id = first, .role = .user, .text = "first" },
            .{ .id = first + 1, .role = .assistant, .text = "second" },
        };
        try std.testing.expectEqual(@as(usize, 0), try cache.retain(a, entries, i + 2));
        try std.testing.expectEqual(first, cache.pages.items[i].entries()[0].id);
    }
    var next_id: i64 = 3; // The current older snapshot would render IDs 1 and 2.
    var i = cache.pages.items.len;
    while (i > 0) {
        i -= 1;
        for (cache.pages.items[i].entries()) |entry| {
            try std.testing.expectEqual(next_id, entry.id);
            next_id += 1;
        }
    }
    try std.testing.expectEqual(@as(i64, 9), next_id);
}

test "scrollback count cap drops newest rows, supports aliased input, and clears for reuse" {
    const a = std.testing.allocator;
    var cache: Self = .{};
    defer cache.clear(a);
    for (0..max_pages) |i| {
        const entries: []const wire.TuiEntry = &.{.{ .id = @intCast(max_pages + 1 - i), .role = .note, .text = "saved" }};
        try std.testing.expectEqual(@as(usize, 0), try cache.retain(a, entries, i + 1));
    }
    try std.testing.expect(!cache.newer_omitted);
    // Reflow updates, rather than the original count, must drive compensation.
    cache.pages.items[0].rows = 70;
    try std.testing.expectEqual(@as(usize, 70), try cache.retain(a, &.{.{ .id = 1, .role = .note, .text = "oldest" }}, 90));
    try std.testing.expectEqual(@as(usize, max_pages), cache.pages.items.len);
    try std.testing.expect(cache.newer_omitted);
    try std.testing.expectEqual(@as(i64, 16), cache.pages.items[0].entries()[0].id);
    try std.testing.expectEqual(@as(i64, 1), cache.pages.items[max_pages - 1].entries()[0].id);

    // Cloning must finish before trimming even if input lives in the evictee.
    try std.testing.expectEqual(@as(usize, 2), try cache.retain(a, cache.pages.items[0].entries(), 100));
    try std.testing.expectEqual(@as(i64, 15), cache.pages.items[0].entries()[0].id);
    try std.testing.expectEqual(@as(i64, 16), cache.pages.items[max_pages - 1].entries()[0].id);
    try std.testing.expectEqualStrings("saved", cache.pages.items[max_pages - 1].entries()[0].text);
    var total_bytes: usize = 0;
    for (cache.pages.items) |page| total_bytes += page.bytes;
    try std.testing.expectEqual(total_bytes, cache.bytes);

    var failing = std.testing.FailingAllocator.init(a, .{ .fail_index = 0 });
    try std.testing.expectEqual(@as(usize, 0), try cache.retain(failing.allocator(), &.{}, 999));
    try std.testing.expectEqual(total_bytes, cache.bytes);
    try std.testing.expectEqual(@as(usize, max_pages), cache.pages.items.len);
    try std.testing.expect(cache.newer_omitted);
    try std.testing.expect(!failing.has_induced_failure);

    cache.clear(a);
    try std.testing.expectEqual(@as(usize, 0), cache.pages.items.len);
    try std.testing.expectEqual(@as(usize, 0), cache.pages.capacity);
    try std.testing.expectEqual(@as(usize, 0), cache.bytes);
    try std.testing.expect(!cache.newer_omitted);
    try std.testing.expectEqual(@as(usize, 0), try cache.retain(failing.allocator(), &.{}, 999));
    cache.clear(a);
    try std.testing.expectEqual(@as(usize, 0), try cache.retain(a, &.{.{ .id = 50, .role = .user, .text = "reused" }}, 0));
    try std.testing.expectEqual(@as(usize, 1), cache.pages.items.len);
    try std.testing.expectEqual(@as(usize, 0), cache.pages.items[0].rows);
    try std.testing.expect(!cache.newer_omitted);
}

// Exact serialized sizes using parts within wire text/count limits. ASCII
// payload needs no escaping; only the fixed JSON overhead must be subtracted.
const SizedTestPage = struct {
    text: [8192]u8 = @splat('x'),
    parts: [128]wire.TuiPart = undefined,
    entries: [1]wire.TuiEntry = undefined,

    fn init(self: *SizedTestPage, a: Allocator, bytes: usize) !void {
        for (&self.parts) |*part| part.* = .{ .kind = .text, .text = "" };
        self.entries = .{.{ .id = 1, .role = .assistant, .text = "", .parts = &self.parts }};
        const encoded = try std.json.Stringify.valueAlloc(a, &self.entries, .{});
        defer a.free(encoded);
        var remaining = bytes - encoded.len;
        for (&self.parts) |*part| {
            part.text = self.text[0..@min(remaining, self.text.len)];
            remaining -= part.text.len;
        }
        try std.testing.expectEqual(@as(usize, 0), remaining);
    }
};

test "scrollback byte cap is inclusive and accounts for multiple newest page evictions" {
    const a = std.testing.allocator;
    var cache: Self = .{};
    defer cache.clear(a);
    var page: SizedTestPage = .{};
    try page.init(a, max_page_bytes / 2);
    try std.testing.expectEqual(@as(usize, 0), try cache.retain(a, &page.entries, 13));
    try std.testing.expectEqual(@as(usize, 0), try cache.retain(a, &page.entries, 21));
    try page.init(a, max_page_bytes);
    for (0..7) |i| {
        page.entries[0].id = @intCast(i + 2);
        try std.testing.expectEqual(@as(usize, 0), try cache.retain(a, &page.entries, i + 1));
    }
    try std.testing.expectEqual(@as(usize, max_bytes), cache.bytes);
    try std.testing.expectEqual(@as(usize, 9), cache.pages.items.len);
    try std.testing.expect(!cache.newer_omitted);
    cache.pages.items[0].rows = 31;
    page.entries[0].id = 9;
    try std.testing.expectEqual(@as(usize, 52), try cache.retain(a, &page.entries, 99));
    try std.testing.expectEqual(@as(usize, max_bytes), cache.bytes);
    try std.testing.expectEqual(@as(usize, 8), cache.pages.items.len);
    try std.testing.expect(cache.newer_omitted);
    for (cache.pages.items, 0..) |saved, i| {
        try std.testing.expectEqual(@as(i64, @intCast(i + 2)), saved.entries()[0].id);
        try std.testing.expectEqual(@as(usize, max_page_bytes), saved.bytes);
    }
}

test "scrollback rejects oversized pages without allocation or changing saved pages" {
    const a = std.testing.allocator;
    var cache: Self = .{};
    defer cache.clear(a);
    _ = try cache.retain(a, &.{.{ .id = 42, .role = .note, .text = "keep" }}, 4);
    const old_bytes = cache.bytes;
    const old_arena = cache.pages.items[0].parsed.arena;
    var page: SizedTestPage = .{};
    try page.init(a, max_page_bytes + 1);
    var failing = std.testing.FailingAllocator.init(a, .{ .fail_index = 0 });
    try std.testing.expectError(error.PageTooLarge, cache.retain(failing.allocator(), &page.entries, 999));
    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(old_bytes, cache.bytes);
    try std.testing.expectEqual(@as(usize, 1), cache.pages.items.len);
    try std.testing.expectEqual(old_arena, cache.pages.items[0].parsed.arena);
    try std.testing.expectEqual(@as(usize, 4), cache.pages.items[0].rows);
    try std.testing.expectEqualStrings("keep", cache.pages.items[0].entries()[0].text);
    try std.testing.expect(!cache.newer_omitted);
}

fn allocationFailureCase(a: Allocator) !void {
    var cache: Self = .{};
    defer cache.clear(a);
    // Exercise empty/growing lists and a full cache, both before and after its
    // omission flag is set. Every error must leave the previously owned pages.
    for (0..max_pages + 2) |i| {
        const old_len = cache.pages.items.len;
        const old_bytes = cache.bytes;
        const old_omitted = cache.newer_omitted;
        var old_pages: [max_pages]Page = undefined;
        @memcpy(old_pages[0..old_len], cache.pages.items);
        const entries: []const wire.TuiEntry = &.{.{
            .id = @intCast(i + 1),
            .role = .assistant,
            .text = "界 é 👩‍💻",
            .parts = &.{.{ .kind = .tool, .text = "result", .toolName = "functions.工具", .isError = false }},
        }};
        _ = cache.retain(a, entries, i + 1) catch |err| {
            try std.testing.expectEqual(old_len, cache.pages.items.len);
            try std.testing.expectEqual(old_bytes, cache.bytes);
            try std.testing.expectEqual(old_omitted, cache.newer_omitted);
            for (old_pages[0..old_len], cache.pages.items) |old, current| {
                try std.testing.expectEqual(old.parsed.arena, current.parsed.arena);
                try std.testing.expectEqual(old.parsed.value.ptr, current.parsed.value.ptr);
                try std.testing.expectEqual(old.rows, current.rows);
                try std.testing.expectEqual(old.bytes, current.bytes);
                try std.testing.expectEqualStrings("界 é 👩‍💻", current.entries()[0].text);
                try std.testing.expectEqualStrings("functions.工具", current.entries()[0].parts.?[0].toolName.?);
            }
            return err;
        };
    }
}

test "scrollback allocation failures preserve cached pages and leak no arenas" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationFailureCase, .{});
}
