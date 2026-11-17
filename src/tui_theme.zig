//! Vesper-derived, presentation-only chrome and responsive geometry.
const std = @import("std");
const vaxis = @import("vaxis");
pub const base: vaxis.Style = .{ .fg = .{ .rgb = .{ 255, 255, 255 } }, .bg = .{ .rgb = .{ 16, 16, 16 } } };
// Muted dark-blue message panel, keeping Vesper's near-black contrast.
pub const user: vaxis.Style = .{ .fg = base.fg, .bg = .{ .rgb = .{ 24, 32, 48 } } };
pub const dim: vaxis.Style = .{ .fg = .{ .rgb = .{ 160, 160, 160 } }, .bg = base.bg };
pub const rule: vaxis.Style = .{ .fg = .{ .rgb = .{ 80, 80, 80 } }, .bg = base.bg };
pub const green: vaxis.Style = .{ .fg = .{ .rgb = .{ 153, 255, 228 } }, .bg = base.bg };
pub const orange: vaxis.Style = .{ .fg = .{ .rgb = .{ 255, 199, 153 } }, .bg = base.bg };
pub const Layout = struct {
    main: u16,
    sidebar: u16,
    body: u16,
    x: u16,
    pub fn init(width: u16, override: ?bool) Layout {
        // Explicit show works below the automatic threshold. At pathological
        // widths preserve at least ten chat columns rather than underflowing.
        // Spend spare width on the inventory before expanding chat margins.
        // Automatic layouts preserve the 80-column body plus four gutters.
        const side: u16 = if ((override orelse (width >= 112)) and width >= 20)
            (if (width >= 112) @min(56, width - 84) else @min(56, width / 3))
        else
            0;
        const main = width - side;
        const body = @min(80, main -| 4);
        return .{ .main = main, .sidebar = side, .body = @max(1, body), .x = (main - body) / 2 };
    }
};
// Presentation-only randomness. A session seed comes from Io.random; tests can
// use fixed seeds. Never shared with tool IDs, scheduling, or durable state.
fn random(state: *u64) u64 {
    state.* +%= 0x9e3779b97f4a7c15;
    var value = state.*;
    value = (value ^ (value >> 30)) *% 0xbf58476d1ce4e5b9;
    value = (value ^ (value >> 27)) *% 0x94d049bb133111eb;
    return value ^ (value >> 31);
}
pub const Target = enum { sidebar, problem };
pub const Pulse = struct { step: u64, duration: u64, seed: u64 };
pub const Animation = struct {
    mode: enum { idle, attachment, busy } = .idle,
    target: Target = .sidebar,
    started: u64 = 0,
    duration: u64 = 18,
    next: u64 = 0,
    seed: u64 = 0,
    random_state: u64 = 0,

    pub fn attach(self: *Animation, frame: u64, reveal: bool) void {
        self.mode = if (reveal) .attachment else .idle;
        self.target = .sidebar;
        self.started = frame;
        self.duration = 18;
        self.seed = random(&self.random_state);
    }
    fn start(self: *Animation, frame: u64) void {
        self.started = frame;
        self.duration = 16 + random(&self.random_state) % 5;
        self.seed = random(&self.random_state);
        self.next = frame + self.duration + 4 + random(&self.random_state) % 5;
    }
    pub fn advance(self: *Animation, frame: u64, fresh_busy: bool) void {
        if (!fresh_busy) {
            if (self.mode == .busy or (self.mode == .attachment and frame -| self.started >= self.duration)) self.mode = .idle;
            return;
        }
        if (self.mode != .busy) {
            self.mode = .busy;
            self.target = if (random(&self.random_state) % 2 == 0) .sidebar else .problem;
            self.start(frame);
        } else if (frame >= self.next) {
            self.target = if (self.target == .sidebar) .problem else .sidebar;
            self.start(frame);
        }
        // At 50ms/tick: alternate 800–1000ms pulses, 200–400ms gaps.
        // Each label is still for <= 1.8s, even if the other is offscreen.
    }
    pub fn pulse(self: Animation, target: Target, frame: u64) ?Pulse {
        if (self.mode == .idle or self.target != target or frame < self.started or frame - self.started >= self.duration) return null;
        return .{ .step = frame - self.started, .duration = self.duration, .seed = self.seed };
    }
};
// Assign a stable random reveal rank per grapheme for this pulse, not a new
// order each frame (settled characters must stay settled).
pub fn revealRanks(ranks: []usize, seed: u64) void {
    for (ranks, 0..) |*rank, index| rank.* = index;
    var state = seed;
    var remaining = ranks.len;
    while (remaining > 1) {
        const other = random(&state) % remaining;
        remaining -= 1;
        std.mem.swap(usize, &ranks[remaining], &ranks[other]);
    }
}
pub fn rune(seed: u64, step: u64, index: usize) u21 {
    var state = seed +% (step *% 0x9e3779b97f4a7c15) +% (@as(u64, @intCast(index)) *% 0xbf58476d1ce4e5b9);
    return @intCast(0x16a0 + random(&state) % 75);
}
test "sidebar geometry respects 80 columns and explicit narrow overrides" {
    try std.testing.expectEqual(@as(u16, 0), Layout.init(100, null).sidebar);
    try std.testing.expectEqual(@as(u16, 56), Layout.init(140, null).sidebar);
    try std.testing.expectEqual(@as(u16, 80), Layout.init(140, null).body);
    try std.testing.expect(Layout.init(60, true).sidebar > 0);
    try std.testing.expectEqual(@as(u16, 0), Layout.init(140, false).sidebar);
    for (20..513) |w| {
        const l = Layout.init(@intCast(w), true);
        try std.testing.expect(l.body <= 80 and l.x + l.body < l.main);
    }
}

test "busy pulses stagger randomly with bounded silence, and stop on idle or stale samples" {
    for (0..32) |seed| {
        var animation: Animation = .{ .random_state = seed };
        var last: [2]u64 = .{ 0, 0 };
        var seen: [2]bool = .{ false, false };
        var durations: [5]bool = @splat(false);
        var previous_seed: ?u64 = null;
        for (0..4000) |frame| {
            animation.advance(frame, true);
            const left = animation.pulse(.sidebar, frame);
            const right = animation.pulse(.problem, frame);
            try std.testing.expect(left == null or right == null);
            for ([_]?Pulse{ left, right }, 0..) |pulse, index| {
                if (pulse) |p| {
                    seen[index] = true;
                    last[index] = frame;
                    durations[p.duration - 16] = true;
                    if (p.step == 0) {
                        if (previous_seed) |prior| try std.testing.expect(prior != p.seed);
                        previous_seed = p.seed;
                    }
                }
                try std.testing.expect(frame - last[index] <= 36);
            }
        }
        try std.testing.expect(seen[0] and seen[1]);
        for (durations) |seen_duration| try std.testing.expect(seen_duration);
        animation.advance(4000, false);
        try std.testing.expect(animation.pulse(.sidebar, 4000) == null and animation.pulse(.problem, 4000) == null);
        animation.attach(4001, true);
        try std.testing.expect(animation.pulse(.sidebar, 4001) != null);
        animation.advance(4019, false);
        try std.testing.expect(animation.pulse(.sidebar, 4019) == null);
    }
}
test "reveal order is a seeded permutation, not a left-to-right pass" {
    var ranks: [64]usize = undefined;
    revealRanks(&ranks, 42);
    var seen: [64]bool = @splat(false);
    var moved: usize = 0;
    for (ranks, 0..) |rank, index| {
        try std.testing.expect(rank < ranks.len and !seen[rank]);
        seen[rank] = true;
        if (rank != index) moved += 1;
    }
    try std.testing.expect(moved > 32);
    var again: [64]usize = undefined;
    revealRanks(&again, 42);
    try std.testing.expectEqualSlices(usize, &ranks, &again);
    revealRanks(&again, 43);
    try std.testing.expect(!std.mem.eql(usize, &ranks, &again));
}
