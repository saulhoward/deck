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

/// One bounded, control-safe title for both OSC 2 and OSC 7501. Preserve UTF-8
/// boundaries; filesystem bytes need not be UTF-8. Never emit raw path controls.
pub fn directoryTitle(out: *[192]u8, cwd: []const u8) []const u8 {
    const trimmed = std.mem.trimEnd(u8, cwd, "/");
    const name = if (trimmed.len == 0) "/" else std.fs.path.basename(trimmed);
    const prefix = "Δ - ";
    @memcpy(out[0..prefix.len], prefix);
    var n: usize = prefix.len;
    var i: usize = 0;
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
        if (cp < 0x20 or (cp >= 0x7f and cp <= 0x9f) or cp == 0x061c or (cp >= 0x200b and cp <= 0x200f) or (cp >= 0x2028 and cp <= 0x202e) or (cp >= 0x2060 and cp <= 0x206f) or cp == 0xfeff) continue;
        if (n + bytes.len > out.len) break;
        @memcpy(out[n..][0..bytes.len], bytes);
        n += bytes.len;
    }
    if (n == prefix.len) {
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
    try std.testing.expectEqualStrings("Δ - repo", directoryTitle(&title, "/tmp/repo/"));
    try std.testing.expectEqualStrings("Δ - /", directoryTitle(&title, "/"));
    const unsafe = directoryTitle(&title, "/tmp/ab\x1b\x07\n\t\x7f\u{85}\u{202e}cd\xff");
    try std.testing.expectEqualStrings("Δ - abcd�", unsafe);
    var unicode_name: [300]u8 = undefined;
    for (0..100) |i| @memcpy(unicode_name[i * 3 ..][0..3], "界");
    const long = directoryTitle(&title, &unicode_name);
    try std.testing.expect(long.len <= 192 and std.unicode.utf8ValidateSlice(long));
    var vx: vaxis.Vaxis = undefined; // These Vaxis methods only write to the supplied writer.
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var reporter: Reporter = .{ .vx = &vx, .writer = &output.writer, .title = directoryTitle(&title, "/tmp/repo") };
    try reporter.begin();
    const view: View = .{ .online = true, .fenced = false, .unresolved_input = false, .settings_uncertain = false };
    reporter.presentation.observe(.{ .state = .working }, .zero);
    try reporter.publish(view, .zero);
    const size = output.written().len;
    for (0..100) |_| try reporter.publish(view, .zero);
    try std.testing.expectEqual(size, output.written().len);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b]7501;state=working:id=deck:app=deck:title=") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "progress=") == null);
    reporter.end();
    try std.testing.expect(std.mem.endsWith(u8, output.written(), "\x1b]7501;state=clear:id=deck\x1b\\\x1b[23;2t"));
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b]7501;state=clear\x1b\\") == null);
}
