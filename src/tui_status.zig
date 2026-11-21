//! Terminal-only presentation of validated Pi observations. No work scheduling,
//! completion inference from activity, persistent acknowledgements or Rex RPC.
const std = @import("std");
const vaxis = @import("vaxis");
const wire = @import("generated/contracts.zig");
const Reporter = @This();

const State = enum { unknown, idle, working, done, failed, review, disconnected };
const Report = struct { state: State, outcome: u64 = 0 };
pub const View = struct {
    online: bool,
    fenced: bool,
    unresolved_input: bool,
    settings_uncertain: bool,
};
pub const Presentation = struct {
    current: Report = .{ .state = .unknown },
    at: std.Io.Timestamp = .zero,
    initialized: bool = false,
    acknowledged: u64 = 0,

    pub fn observe(self: *Presentation, status: ?wire.AgentStatus, now: std.Io.Timestamp) void {
        self.current = .{ .state = .unknown };
        self.at = now;
        if (status) |s| {
            const id = if (s.taskId orelse s.settledTaskId) |text| std.fmt.parseInt(u64, text, 10) catch 0 else 0;
            // Old completed history is not newly unread just because we attached.
            if (!self.initialized and (s.state == .done or s.settledTaskId != null)) self.acknowledged = id;
            self.initialized = true;
            self.current = .{ .state = switch (s.state) {
                .idle => .idle,
                .working => .working,
                .done => .done,
                .@"error" => .failed,
            }, .outcome = id };
        }
    }
    pub fn invalidate(self: *Presentation) void {
        self.current = .{ .state = .unknown };
    }
    pub fn acknowledge(self: *Presentation) void {
        self.acknowledged = @max(self.acknowledged, self.current.outcome);
    }
    pub fn report(self: Presentation, view: View, now: std.Io.Timestamp) Report {
        if (view.fenced) return .{ .state = .disconnected };
        if (view.unresolved_input) return .{ .state = .review };
        if (!view.online or view.settings_uncertain or self.at.durationTo(now).nanoseconds >= 5 * std.time.ns_per_s) return .{ .state = .unknown };
        if ((self.current.state == .done or self.current.state == .failed) and self.current.outcome <= self.acknowledged) return .{ .state = .idle };
        if (self.current.state == .working) return .{ .state = .working };
        return self.current;
    }
};

vx: *vaxis.Vaxis,
writer: *std.Io.Writer,
title: []const u8,
presentation: Presentation = .{},
last: Report = .{ .state = .unknown },
title_pushed: bool = false,
title_storage: [192]u8 = undefined,

pub fn identity(self: *Reporter, rune: []const u8, label: []const u8) !void {
    var buffer: [192]u8 = undefined;
    const title = identityTitle(&buffer, label, rune);
    if (std.mem.eql(u8, title, self.title)) return;
    @memcpy(self.title_storage[0..title.len], title);
    self.title = self.title_storage[0..title.len];
    try self.vx.setTitle(self.writer, self.title);
    self.last = .{ .state = .unknown, .outcome = std.math.maxInt(u64) };
}

pub fn begin(self: *Reporter) !void {
    // Window-title stack only, not shell integration or a process-name change.
    try self.writer.writeAll("\x1b[22;2t");
    try self.writer.flush();
    self.title_pushed = true;
    try self.vx.setTitle(self.writer, self.title);
    try self.vx.clearProgramStatus(self.writer, "deck");
}
pub fn end(self: *Reporter) void {
    // Detach is not agent cancellation or completion. Never clear other apps.
    self.vx.clearProgramStatus(self.writer, "deck") catch {};
    if (self.title_pushed) {
        self.writer.writeAll("\x1b[23;2t") catch {};
        self.writer.flush() catch {};
        self.title_pushed = false;
    }
}
pub fn publish(self: *Reporter, view: View, now: std.Io.Timestamp) !void {
    const next = self.presentation.report(view, now);
    if (std.meta.eql(next, self.last)) return;
    if (next.state == .unknown) {
        try self.vx.clearProgramStatus(self.writer, "deck");
    } else {
        try self.vx.reportProgramStatus(self.writer, .{
            .id = "deck",
            .app = "deck",
            .title = self.title,
            .state = switch (next.state) {
                .idle => .idle,
                .working => .working,
                .done => .done,
                .failed => .@"error",
                .review, .disconnected => .blocked,
                .unknown => unreachable,
            },
            .msg = switch (next.state) {
                .idle => "Agent idle",
                .working => "Agent work pending or running",
                .done => "Agent reply ready",
                .failed => "Agent run failed; inspect the chat",
                .review => "Review saved/unconfirmed input; agent work may still be running",
                .disconnected => "Client disconnected; reopen to observe the agent",
                .unknown => unreachable,
            },
        });
    }
    self.last = next;
}

/// Saved problem first; legacy/missing/blank problems use the task title.
/// This is presentation only: never derive the label from the workspace path.
pub fn problem(snapshot: wire.TuiSnapshot) []const u8 {
    if (snapshot.brief) |brief| if (brief.problem) |text| {
        if (std.mem.trim(u8, text, " \t\r\n").len > 0) return text;
    };
    return snapshot.title;
}
/// One bounded, single-line, control-safe title for both OSC 2 and OSC 7501.
/// Preserve UTF-8 boundaries and never interpret problem text as a path.
pub fn identityTitle(out: *[192]u8, label: []const u8, rune: []const u8) []const u8 {
    const name = if (std.mem.eql(u8, rune, "Δ")) "hub" else label;
    const symbol = if (wire.validAgentRune(.{ .string = rune })) rune else "·";
    @memcpy(out[0..symbol.len], symbol);
    @memcpy(out[symbol.len..][0..3], " - ");
    const prefix_len = symbol.len + 3;
    var n: usize = prefix_len;
    var i: usize = 0;
    var space = false;
    while (i < name.len) {
        var bytes: []const u8 = "�";
        var size: usize = 1;
        var cp: u21 = 0xfffd;
        if (std.unicode.utf8ByteSequenceLength(name[i])) |len| {
            if (i + len <= name.len) {
                if (std.unicode.utf8Decode(name[i..][0..len])) |point| {
                    cp = point;
                    size = len;
                    bytes = name[i..][0..len];
                } else |_| {}
            }
        } else |_| {}
        i += size;
        if (cp == ' ' or cp == '\t' or cp == '\r' or cp == '\n' or cp == 0x2028 or cp == 0x2029) {
            space = n > prefix_len;
            continue;
        }
        if (cp < 0x20 or (cp >= 0x7f and cp <= 0x9f) or cp == 0x061c or (cp >= 0x200b and cp <= 0x200f) or (cp >= 0x2028 and cp <= 0x202e) or (cp >= 0x2060 and cp <= 0x206f) or cp == 0xfeff) continue;
        if (n + @intFromBool(space) + bytes.len > out.len) break;
        if (space) {
            out[n] = ' ';
            n += 1;
            space = false;
        }
        @memcpy(out[n..][0..bytes.len], bytes);
        n += bytes.len;
    }
    if (n == prefix_len) {
        @memcpy(out[n..][0..7], "unknown");
        n += 7;
    }
    return out[0..n];
}

test "terminal status uses fresh settled observations, not polling, ACKs or old history" {
    var p: Presentation = .{};
    const now: std.Io.Timestamp = .zero;
    const view: View = .{ .online = true, .fenced = false, .unresolved_input = false, .settings_uncertain = false };
    p.observe(.{ .state = .done, .taskId = "1" }, now);
    try std.testing.expectEqual(State.idle, p.report(view, now).state);
    p.observe(.{ .state = .working }, now);
    try std.testing.expectEqual(State.working, p.report(view, now).state);
    p.observe(.{ .state = .done, .taskId = "2" }, now);
    try std.testing.expectEqual(State.done, p.report(view, now).state);
    p.acknowledge();
    p.observe(.{ .state = .done, .taskId = "2" }, now);
    try std.testing.expectEqual(State.idle, p.report(view, now).state);
    p.observe(.{ .state = .@"error", .taskId = "3" }, now);
    try std.testing.expectEqual(State.failed, p.report(view, now).state);
    try std.testing.expectEqual(State.unknown, p.report(view, now.addDuration(.fromSeconds(5))).state);
    p.invalidate();
    try std.testing.expectEqual(State.unknown, p.report(view, now).state);
    p.observe(null, now);
    try std.testing.expectEqual(State.unknown, p.report(view, now).state);
    var late_attach: Presentation = .{};
    late_attach.observe(.{ .state = .working, .settledTaskId = "10" }, now);
    late_attach.observe(.{ .state = .done, .taskId = "10" }, now);
    try std.testing.expectEqual(State.idle, late_attach.report(view, now).state);
    late_attach.observe(.{ .state = .working }, now);
    late_attach.observe(.{ .state = .done, .taskId = "11" }, now);
    try std.testing.expectEqual(State.done, late_attach.report(view, now).state);
    var changed = view;
    changed.unresolved_input = true;
    try std.testing.expectEqual(State.review, p.report(changed, now).state);
    changed.fenced = true;
    try std.testing.expectEqual(State.disconnected, p.report(changed, now).state);
}

test "OSC title and status are bounded, safe, change-only and cleaned up by namespace" {
    var title: [192]u8 = undefined;
    try std.testing.expectEqualStrings("Δ - hub", identityTitle(&title, "Ignored hub problem", "Δ"));
    try std.testing.expectEqualStrings("ᚦ - Fix /api/path handling", identityTitle(&title, "Fix /api/path handling", "ᚦ"));
    try std.testing.expectEqualStrings("· - Legacy task title", identityTitle(&title, "Legacy task title", "invalid rune"));
    try std.testing.expectEqualStrings("ᚦ - First line second line 界", identityTitle(&title, "  First line\n\tsecond line 界  ", "ᚦ"));
    try std.testing.expectEqualStrings("· - unknown", identityTitle(&title, " \n\t\x1b\x07", ""));
    const unsafe = identityTitle(&title, "ab\x1b\x07\n\t\x7f\u{85}\u{202e}cd\xff", "·");
    try std.testing.expectEqualStrings("· - ab cd�", unsafe);
    var unicode_name: [300]u8 = undefined;
    for (0..100) |i| @memcpy(unicode_name[i * 3 ..][0..3], "界");
    const long = identityTitle(&title, &unicode_name, "ᚦ");
    try std.testing.expect(long.len <= 192 and std.unicode.utf8ValidateSlice(long));
    var vx: vaxis.Vaxis = undefined; // These Vaxis methods only write to the supplied writer.
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var reporter: Reporter = .{ .vx = &vx, .writer = &output.writer, .title = identityTitle(&title, "Fix the parser", "ᚦ") };
    try reporter.begin();
    const view: View = .{ .online = true, .fenced = false, .unresolved_input = false, .settings_uncertain = false };
    reporter.presentation.observe(.{ .state = .working }, .zero);
    try reporter.publish(view, .zero);
    const size = output.written().len;
    for (0..100) |_| try reporter.publish(view, .zero);
    try std.testing.expectEqual(size, output.written().len);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b]7501;state=working:id=deck:app=deck:title=") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "progress=") == null);
    try reporter.identity("ᚦ", "Fix the parser");
    try std.testing.expectEqual(size, output.written().len);
    try reporter.identity("ᚦ", "New problem / same workspace");
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b]2;ᚦ - New problem / same workspace\x1b\\") != null);
    const changed = output.written().len;
    try reporter.publish(view, .zero); // Same activity, new coherent title.
    try std.testing.expect(output.written().len > changed);
    var encoded_title: [256]u8 = undefined;
    const encoded = std.base64.standard.Encoder.encode(&encoded_title, reporter.title);
    try std.testing.expect(std.mem.indexOf(u8, output.written()[changed..], encoded) != null);
    const published = output.written().len;
    try reporter.identity("ᚦ", " New problem / same workspace\n");
    try reporter.publish(view, .zero);
    try std.testing.expectEqual(published, output.written().len);
    reporter.end();
    try std.testing.expect(std.mem.endsWith(u8, output.written(), "\x1b]7501;state=clear:id=deck\x1b\\\x1b[23;2t"));
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b]7501;state=clear\x1b\\") == null);
}

test "terminal problem comes from the saved brief with a legacy title fallback, never cwd" {
    var snapshot: wire.TuiSnapshot = .{
        .clientMode = .task,
        .hubChatId = "1",
        .hubId = "hub",
        .chatId = "2",
        .title = "Legacy task title",
        .model = "",
        .tools = "",
        .activityKnown = false,
        .busy = false,
        .queued = 0,
        .entries = &.{},
        .hasOlder = false,
        .historical = false,
        .preview = "",
        .notice = "",
        .draft = null,
    };
    try std.testing.expectEqualStrings("Legacy task title", problem(snapshot));
    snapshot.brief = .{ .description = "Description is not the problem" };
    try std.testing.expectEqualStrings("Legacy task title", problem(snapshot));
    for ([_][]const u8{ "", " \t\r\n" }) |blank| {
        snapshot.brief.?.problem = blank;
        try std.testing.expectEqualStrings("Legacy task title", problem(snapshot));
    }
    snapshot.brief.?.problem = "  Fix /api/path\nwith Unicode 界  ";
    snapshot.cwd = "/unrelated/workspace";
    try std.testing.expectEqualStrings(snapshot.brief.?.problem.?, problem(snapshot));
    snapshot.cwd = null;
    try std.testing.expectEqualStrings(snapshot.brief.?.problem.?, problem(snapshot));
}
