//! Bounded, read-only canonical message download. The renderer pauses its event
//! loop with no outstanding request; these snapshots are never display pages.
const std = @import("std");
const Native = @import("native.zig");
const Bridge = @import("tui_bridge.zig");
const wire = @import("generated/contracts.zig");

pub const limit = 16 * 1024 * 1024;
const chunk_limit = 32 * 1024;
const chunk_timeout_ms = 12_000;
pub const DownloadError = error{
    MessageContentBusy,
    MessageContentUnavailable,
    MessageContentCancelled,
    MessageContentTimeout,
    InvalidMessageContent,
    OutOfMemory,
};

/// Returns allocator-owned full UTF-8 text, never a clipped history fallback.
/// A remote refusal (including older hubs and oversized bodies) is deliberately
/// a generic MessageContentUnavailable, not untrusted model/display text.
pub fn download(native: Native, a: std.mem.Allocator, bridge: *Bridge, entry_id: i64, cancelled: *std.atomic.Value(bool)) DownloadError![]u8 {
    return downloadWithTimeout(native, a, bridge, entry_id, cancelled, chunk_timeout_ms);
}

fn downloadWithTimeout(native: Native, a: std.mem.Allocator, bridge: *Bridge, entry_id: i64, cancelled: *std.atomic.Value(bool), timeout_ms: i64) DownloadError![]u8 {
    // A caller bug must not abandon somebody else's pending request.
    if (bridge.pending != null) return error.MessageContentBusy;
    if (bridge.failed) return error.MessageContentUnavailable;
    const chat = bridge.chat_id orelse return error.MessageContentUnavailable;
    var content = try Content.init(chat, entry_id);
    defer content.deinit(a);
    // Keep pending identity intact and fence reads/writes if we abandon a chunk.
    // Clearing pending instead could misattribute a late reply to the next read.
    errdefer if (bridge.pending != null) {
        bridge.failed = true;
    };
    while (true) {
        if (cancelled.load(.acquire)) return error.MessageContentCancelled;
        const started = bridge.messageContent(entry_id, content.used) catch |err| return transportError(err);
        if (!started) return error.MessageContentUnavailable;
        const since = std.Io.Timestamp.now(native.io, .awake);
        while (true) {
            if (cancelled.load(.acquire)) return error.MessageContentCancelled;
            if (since.durationTo(std.Io.Timestamp.now(native.io, .awake)).nanoseconds >= @as(i96, timeout_ms) * std.time.ns_per_ms) return error.MessageContentTimeout;
            if (bridge.poll() catch |err| return transportError(err)) |reply| {
                defer reply.deinit();
                if (cancelled.load(.acquire)) return error.MessageContentCancelled;
                if (reply.value != .case0) return error.MessageContentUnavailable;
                const page = reply.value.case0.snapshot.messageContent orelse return error.InvalidMessageContent;
                if (try content.accept(a, page)) {
                    // Atomic cancellation may race the final digest computation.
                    if (cancelled.load(.acquire)) return error.MessageContentCancelled;
                    return content.take();
                }
                break;
            }
            native.io.sleep(.fromMilliseconds(10), .awake) catch return error.MessageContentCancelled;
        }
    }
}

fn transportError(err: anyerror) DownloadError {
    return if (err == error.OutOfMemory) error.OutOfMemory else error.MessageContentUnavailable;
}

// One exact allocation, capped before allocating. Neither a growing ArrayList
// nor per-page arenas retain another copy of the complete message. Pins are
// copied: page strings cease to exist when each bridge reply is deinitialized.
const Content = struct {
    chat: [20]u8 = undefined,
    chat_len: usize,
    entry: i64,
    digest: [64]u8 = undefined,
    bytes: ?[]u8 = null,
    used: usize = 0,
    complete: bool = false,

    fn init(chat: []const u8, entry: i64) DownloadError!Content {
        if (chat.len == 0 or chat.len > 16 or chat[0] == '0' or entry <= 0 or entry > 9007199254740991) return error.InvalidMessageContent;
        for (chat) |c| if (!std.ascii.isDigit(c)) return error.InvalidMessageContent;
        const chat_number = std.fmt.parseInt(u64, chat, 10) catch return error.InvalidMessageContent;
        if (chat_number > 9007199254740991) return error.InvalidMessageContent;
        var result: Content = .{ .chat_len = chat.len, .entry = entry };
        @memcpy(result.chat[0..chat.len], chat);
        return result;
    }
    fn deinit(self: *Content, a: std.mem.Allocator) void {
        if (self.bytes) |bytes| a.free(bytes);
    }
    fn accept(self: *Content, a: std.mem.Allocator, page: wire.MessageContentPage) DownloadError!bool {
        var entry_buf: [20]u8 = undefined;
        const entry = std.fmt.bufPrint(&entry_buf, "{d}", .{self.entry}) catch unreachable;
        if (self.complete or !std.mem.eql(u8, page.chatId, self.chat[0..self.chat_len]) or !std.mem.eql(u8, page.entryId, entry)) return error.InvalidMessageContent;
        if (page.offset < 0 or page.totalBytes < 0 or page.totalBytes > limit or page.offset > page.totalBytes) return error.InvalidMessageContent;
        if (page.sha256.len != 64 or page.text.len > chunk_limit or !std.unicode.utf8ValidateSlice(page.text)) return error.InvalidMessageContent;
        for (page.sha256) |c| if (!(c >= '0' and c <= '9') and !(c >= 'a' and c <= 'f')) return error.InvalidMessageContent;
        const total: usize = @intCast(page.totalBytes);
        const offset: usize = @intCast(page.offset);
        if (offset != self.used or page.text.len > total - offset) return error.InvalidMessageContent;
        const end = offset + page.text.len;
        if (end < total) {
            if (page.text.len == 0 or page.next == null or page.next.? != @as(i64, @intCast(end))) return error.InvalidMessageContent;
        } else if (page.next != null) return error.InvalidMessageContent;
        if (self.bytes) |bytes| {
            if (total != bytes.len or !std.mem.eql(u8, page.sha256, &self.digest)) return error.InvalidMessageContent;
        } else {
            self.bytes = try a.alloc(u8, total);
            @memcpy(&self.digest, page.sha256);
        }
        @memcpy(self.bytes.?[offset..end], page.text);
        self.used = end;
        if (end < total) return false;
        var actual: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(self.bytes.?, &actual, .{});
        const actual_hex = std.fmt.bytesToHex(actual, .lower);
        if (!std.mem.eql(u8, &actual_hex, &self.digest)) return error.InvalidMessageContent;
        self.complete = true;
        return true;
    }
    fn take(self: *Content) []u8 {
        std.debug.assert(self.complete);
        const bytes = self.bytes.?;
        self.bytes = null;
        return bytes;
    }
};

fn testPage(text: []const u8) wire.MessageContentPage {
    return .{ .chatId = "2", .entryId = "7", .offset = 0, .totalBytes = @intCast(text.len), .sha256 = "", .text = text };
}
fn testDigest(text: []const u8) [64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(text, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

test "content aggregation owns pins and downloads full UTF-8 text including empty content" {
    const a = std.testing.allocator;
    for ([_][]const u8{ "", "hello 🧪\nworld" }) |text| {
        var content = try Content.init("2", 7);
        defer content.deinit(a);
        var page = testPage(text);
        const digest = testDigest(text);
        page.sha256 = &digest;
        try std.testing.expect(try content.accept(a, page));
        const bytes = content.take();
        defer a.free(bytes);
        try std.testing.expectEqualStrings(text, bytes);
    }
    const text = "first 🧪\nsecond\n";
    const digest = testDigest(text);
    var content = try Content.init("2", 7);
    defer content.deinit(a);
    var first = testPage(text);
    first.sha256 = &digest;
    first.text = text[0..11];
    first.next = 11;
    try std.testing.expect(!try content.accept(a, first));
    var last = first;
    last.offset = 11;
    last.text = text[11..];
    last.next = null;
    try std.testing.expect(try content.accept(a, last));
    const bytes = content.take();
    defer a.free(bytes);
    try std.testing.expectEqualStrings(text, bytes);
}

test "content rejects wrong identity hash sparse offsets stalled progress and bounds" {
    const a = std.testing.allocator;
    const digest = testDigest("abcdef");
    const Case = enum { chat, entry, offset, over_limit, negative, long_chunk, utf8, digest_shape, wrong_hash, missing_next, sparse_next, stalled, terminal_next };
    for (std.enums.values(Case)) |case| {
        var content = try Content.init("2", 7);
        defer content.deinit(a);
        var page = testPage("abcdef");
        page.sha256 = &digest;
        switch (case) {
            .chat => page.chatId = "3",
            .entry => page.entryId = "8",
            .offset => page.offset = 1,
            .over_limit => page.totalBytes = limit + 1,
            .negative => page.offset = -1,
            .long_chunk => page.text = &@as([chunk_limit + 1]u8, @splat('x')),
            .utf8 => page.text = "\xff",
            .digest_shape => page.sha256 = &@as([63]u8, @splat('0')),
            .wrong_hash => page.sha256 = &@as([64]u8, @splat('0')),
            .missing_next => page.text = "abc",
            .sparse_next => {
                page.text = "abc";
                page.next = 4;
            },
            .stalled => {
                page.text = "";
                page.next = 0;
            },
            .terminal_next => page.next = 6,
        }
        try std.testing.expectError(error.InvalidMessageContent, content.accept(a, page));
    }
    for ([_]bool{ false, true }) |change_digest| {
        var content = try Content.init("2", 7);
        defer content.deinit(a);
        var page = testPage("abcdef");
        page.sha256 = &digest;
        page.text = "abc";
        page.next = 3;
        try std.testing.expect(!try content.accept(a, page));
        page.offset = 3;
        page.text = "def";
        page.next = null;
        if (change_digest) page.sha256 = &@as([64]u8, @splat('0')) else {
            page.totalBytes = 7;
            page.next = 6;
        }
        try std.testing.expectError(error.InvalidMessageContent, content.accept(a, page));
    }
}

test "download refuses pending work and cancellation never sends a read" {
    var fixture = try Bridge.TestPipe.init();
    defer fixture.deinit();
    fixture.bridge.chat_id = try std.testing.allocator.dupe(u8, "2");
    var cancelled = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.MessageContentCancelled, download(Native.testing(), std.testing.allocator, &fixture.bridge, 7, &cancelled));
    try std.testing.expectEqual(0, fixture.bridge.sequence);
    try std.testing.expect(!fixture.bridge.failed);
    try std.testing.expect(try fixture.bridge.request(.poll, null, false));
    try std.testing.expectError(error.MessageContentBusy, download(Native.testing(), std.testing.allocator, &fixture.bridge, 7, &cancelled));
    try std.testing.expect(!fixture.bridge.failed);
    try std.testing.expectEqual(.poll, fixture.bridge.pending.?.action);
}

test "download timeout fences pending identity and remote errors never become content" {
    for ([_]bool{ false, true }) |timeout| {
        var fixture = try Bridge.TestPipe.init();
        defer fixture.deinit();
        fixture.bridge.chat_id = try std.testing.allocator.dupe(u8, "2");
        var cancelled = std.atomic.Value(bool).init(false);
        if (!timeout) try fixture.reply("{\"version\":1,\"id\":\"1\",\"ok\":false,\"error\":\"remote model text must never be opened\"}");
        try std.testing.expectError(if (timeout) error.MessageContentTimeout else error.MessageContentUnavailable, downloadWithTimeout(Native.testing(), std.testing.allocator, &fixture.bridge, 7, &cancelled, if (timeout) 0 else chunk_timeout_ms));
        try std.testing.expectEqual(timeout, fixture.bridge.failed);
        try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
        if (timeout) {
            try std.testing.expectEqualStrings("7", fixture.bridge.pending.?.entryId.?);
            try std.testing.expect(!try fixture.bridge.messageContent(8, 0));
        } else try std.testing.expect(fixture.bridge.pending == null);
    }
}

const TestServer = struct {
    fixture: *Bridge.TestPipe,
    text: []const u8,
    cancel: ?*std.atomic.Value(bool) = null,
    failure: ?anyerror = null,
    reads: usize = 0,

    fn run(self: *@This()) void {
        self.serve() catch |err| {
            self.failure = err;
        };
    }
    fn readExact(fd: std.posix.fd_t, bytes: []u8) !void {
        var used: usize = 0;
        while (used < bytes.len) {
            const n = try std.posix.read(fd, bytes[used..]);
            if (n == 0) return error.EndOfStream;
            used += n;
        }
    }
    fn serve(self: *@This()) !void {
        const digest = testDigest(self.text);
        var offset: usize = 0;
        while (true) {
            var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
            defer arena.deinit();
            const a = arena.allocator();
            var header: [4]u8 = undefined;
            try readExact(self.fixture.peer_read, &header);
            const len = std.mem.readInt(u32, &header, .big);
            if (len > 1024) return error.InvalidFrame;
            const raw = try a.alloc(u8, len);
            try readExact(self.fixture.peer_read, raw);
            const request = (try std.json.parseFromSlice(std.json.Value, a, raw, .{})).value;
            try std.testing.expect(Bridge.validRequest(request));
            try std.testing.expectEqualStrings("messageContent", request.object.get("action").?.string);
            try std.testing.expectEqualStrings("7", request.object.get("entryId").?.string);
            try std.testing.expectEqual(@as(i64, @intCast(offset)), request.object.get("offset").?.integer);
            try std.testing.expect(!request.object.contains("chatId"));
            self.reads += 1;
            if (self.cancel) |cancel| {
                cancel.store(true, .release);
                return;
            }
            const end = @min(offset + chunk_limit, self.text.len);
            var page = testPage(self.text[offset..end]);
            page.offset = @intCast(offset);
            page.totalBytes = @intCast(self.text.len);
            page.sha256 = &digest;
            page.next = if (end < self.text.len) @intCast(end) else null;
            const fixtures = (try std.json.parseFromSlice(std.json.Value, a, @embedFile("contracts.test.json"), .{})).value;
            var snapshot = fixtures.object.get("bases").?.object.get("TuiSnapshot").?;
            try snapshot.object.put(a, "chatId", .{ .string = "2" });
            const page_json = try std.json.Stringify.valueAlloc(a, page, .{});
            try snapshot.object.put(a, "messageContent", (try std.json.parseFromSlice(std.json.Value, a, page_json, .{})).value);
            try self.fixture.reply(try std.json.Stringify.valueAlloc(a, .{
                .version = 1,
                .id = request.object.get("id").?.string,
                .ok = true,
                .snapshot = snapshot,
            }, .{}));
            offset = end;
            if (offset == self.text.len) return;
        }
    }
};

test "download reads sequential full chunks without adopting display snapshots" {
    const a = std.testing.allocator;
    var fixture = try Bridge.TestPipe.init();
    defer fixture.deinit();
    fixture.bridge.chat_id = try a.dupe(u8, "2");
    fixture.bridge.hub_id = try a.dupe(u8, "hub");
    fixture.bridge.hub_chat_id = try a.dupe(u8, "1");
    const text = try a.alloc(u8, 2 * chunk_limit + 100);
    defer a.free(text);
    @memset(text, 'x');
    const tail = "\nUTF-8 🧪 complete final tail, not a clipped history fallback.";
    @memcpy(text[text.len - tail.len ..], tail);
    var server: TestServer = .{ .fixture = &fixture, .text = text };
    const thread = try std.Thread.spawn(.{}, TestServer.run, .{&server});
    var cancelled = std.atomic.Value(bool).init(false);
    const result = download(Native.testing(), a, &fixture.bridge, 7, &cancelled);
    // EOF also releases the test peer if a failed assertion prevents later reads.
    fixture.bridge.child.stdin.?.close(fixture.bridge.io);
    fixture.bridge.child.stdin = null;
    thread.join();
    const bytes = try result;
    defer a.free(bytes);
    if (server.failure) |err| return err;
    try std.testing.expectEqual(3, server.reads);
    try std.testing.expectEqualStrings(text, bytes);
    try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    try std.testing.expectEqualStrings("hub", fixture.bridge.hub_id.?);
    try std.testing.expectEqualStrings("1", fixture.bridge.hub_chat_id.?);
    try std.testing.expect(fixture.bridge.pending == null and !fixture.bridge.failed);
}

test "download atomic cancellation after sending fences the pending request" {
    const a = std.testing.allocator;
    var fixture = try Bridge.TestPipe.init();
    defer fixture.deinit();
    fixture.bridge.chat_id = try a.dupe(u8, "2");
    var cancelled = std.atomic.Value(bool).init(false);
    var server: TestServer = .{ .fixture = &fixture, .text = "", .cancel = &cancelled };
    const thread = try std.Thread.spawn(.{}, TestServer.run, .{&server});
    const result = download(Native.testing(), a, &fixture.bridge, 7, &cancelled);
    fixture.bridge.child.stdin.?.close(fixture.bridge.io);
    fixture.bridge.child.stdin = null;
    thread.join();
    if (result) |bytes| {
        a.free(bytes);
        return error.UnexpectedDownload;
    } else |err| try std.testing.expectEqual(error.MessageContentCancelled, err);
    if (server.failure) |err| return err;
    try std.testing.expectEqual(1, server.reads);
    try std.testing.expect(fixture.bridge.failed);
    try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    try std.testing.expectEqualStrings("7", fixture.bridge.pending.?.entryId.?);
    try fixture.reply("{\"version\":1,\"id\":\"1\",\"ok\":false,\"error\":\"late\"}");
    try std.testing.expect((try fixture.bridge.poll()) == null);
    try std.testing.expect(!try fixture.bridge.request(.poll, null, false));
}
