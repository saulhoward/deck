//! Bounded, local-only Ex completion. Suggestions never execute commands or
//! fetch names. A cycle owns its candidates so an in-flight poll cannot change
//! the selection under the user's fingers.
const std = @import("std");
const Completion = @This();

pub const commands = [_][]const u8{
    "agentsmd", "brief", "child-open ", "cancel", "discard", "help",        "hosts",    "hub",        "latest",     "main",    "model", "mouse-toggle",   "new",  "new-child", "older", "parent",
    "q",        "q!",    "quit",        "retry",  "rex",     "rex inspect", "rex open", "rex reopen", "rex status", "select ", "send",  "sidebar-toggle", "stop", "subagent ", "task ", "task-at ",
    "tasks",    "tools",
};
const Text = struct {
    bytes: [80]u8 = undefined,
    len: usize = 0,
    fn init(text: []const u8) Text {
        std.debug.assert(text.len <= 80);
        var result: Text = .{ .len = text.len };
        @memcpy(result.bytes[0..text.len], text);
        return result;
    }
    fn slice(self: *const Text) []const u8 {
        return self.bytes[0..self.len];
    }
};

pub const Names = struct {
    scope: [16]u8 = undefined,
    scope_len: usize = 0,
    items: [32]Text = undefined,
    len: usize = 0,
    pub fn select(self: *Names, scope: []const u8) bool {
        if (std.mem.eql(u8, self.scope[0..self.scope_len], scope)) return false;
        self.len = 0;
        self.scope_len = if (scope.len <= self.scope.len) scope.len else 0;
        @memcpy(self.scope[0..self.scope_len], scope[0..self.scope_len]);
        return true;
    }
    pub fn add(self: *Names, name: []const u8) void {
        if (name.len == 0 or name.len > 64 or !std.ascii.isAlphabetic(name[0])) return;
        for (name) |c| if (!std.ascii.isAlphanumeric(c) and c != '-') return;
        for (self.items[0..self.len]) |*item| if (std.ascii.eqlIgnoreCase(item.slice(), name)) return;
        if (self.len == self.items.len) {
            std.mem.copyForwards(Text, self.items[0 .. self.len - 1], self.items[1..self.len]);
            self.len -= 1;
        }
        self.items[self.len] = Text.init(name);
        self.len += 1;
    }
};

matches: [@max(commands.len, 32)]Text = undefined,
len: usize = 0,
index: usize = 0,
active: bool = false,
last: Text = .{},

pub fn reset(self: *Completion) void {
    self.active = false;
    self.len = 0;
}
fn starts(text: []const u8, prefix: []const u8) bool {
    return text.len >= prefix.len and std.ascii.eqlIgnoreCase(text[0..prefix.len], prefix);
}
fn add(self: *Completion, text: []const u8) void {
    if (self.len == self.matches.len) return;
    var at = self.len;
    while (at > 0 and std.ascii.orderIgnoreCase(text, self.matches[at - 1].slice()) == .lt) : (at -= 1) self.matches[at] = self.matches[at - 1];
    self.matches[at] = Text.init(text);
    self.len += 1;
}
pub fn complete(self: *Completion, a: std.mem.Allocator, command: *std.ArrayList(u8), names: *const Names, reverse: bool) !void {
    if (self.active and std.mem.eql(u8, command.items, self.last.slice())) {
        self.index = if (reverse) (self.index + self.len - 1) % self.len else (self.index + 1) % self.len;
    } else {
        self.reset();
        if (command.items.len > 256) return;
        if (starts(command.items, "subagent ")) {
            const prefix = std.mem.trim(u8, command.items[9..], " ");
            for (names.items[0..names.len]) |*name| if (starts(name.slice(), prefix)) {
                var buffer: [80]u8 = undefined;
                self.add(try std.fmt.bufPrint(&buffer, "subagent {s}", .{name.slice()}));
            };
        } else {
            for (commands) |candidate| if (starts(candidate, command.items)) self.add(candidate);
        }
        if (self.len == 0) return; // No match leaves exact bytes and notices alone.
        self.index = if (reverse) self.len - 1 else 0;
    }
    const selected = self.matches[self.index];
    try command.ensureTotalCapacity(a, selected.len);
    command.clearRetainingCapacity();
    command.appendSliceAssumeCapacity(selected.slice());
    self.last = selected;
    // A uniquely completed argument-taking verb hands the next Tab to its
    // arguments. Ambiguous verb cycles stay on the original candidate list.
    self.active = !(self.len == 1 and std.mem.endsWith(u8, selected.slice(), " "));
}

test "Ex completion cycles commands and Rex actions without completing arbitrary arguments" {
    const a = std.testing.allocator;
    var c: Completion = .{};
    var names: Names = .{};
    var text: std.ArrayList(u8) = .empty;
    defer text.deinit(a);
    try text.appendSlice(a, "s");
    try c.complete(a, &text, &names, false);
    try std.testing.expectEqualStrings("select ", text.items);
    try c.complete(a, &text, &names, false);
    try std.testing.expectEqualStrings("send", text.items);
    try c.complete(a, &text, &names, true);
    try std.testing.expectEqualStrings("select ", text.items);
    for ([_]struct { input: []const u8, result: []const u8 }{
        .{ .input = "", .result = "agentsmd" },
        .{ .input = "SUB", .result = "subagent " },
        .{ .input = "rex op", .result = "rex open" },
        .{ .input = "rex ", .result = "rex inspect" },
        .{ .input = "q!", .result = "q!" },
        .{ .input = "task Keep 界", .result = "task Keep 界" },
        .{ .input = "task-at {\"title\":\"s\"}", .result = "task-at {\"title\":\"s\"}" },
        .{ .input = "unknown", .result = "unknown" },
        .{ .input = "subagent missing", .result = "subagent missing" },
    }) |case| {
        c.reset();
        text.clearRetainingCapacity();
        try text.appendSlice(a, case.input);
        try c.complete(a, &text, &names, false);
        try std.testing.expectEqualStrings(case.result, text.items);
    }
    // Every supported spelling is reachable, including aliases and commands
    // whose full spelling is also a prefix (q/quit, task/task-at/tasks, rex).
    for (commands) |candidate| {
        c.reset();
        text.clearRetainingCapacity();
        try text.appendSlice(a, candidate);
        try c.complete(a, &text, &names, false);
        try std.testing.expectEqualStrings(candidate, text.items);
    }
}

test "subagent completion owns case-insensitive scoped names and stable bounded cycles" {
    const a = std.testing.allocator;
    var names: Names = .{};
    try std.testing.expect(names.select("1"));
    names.add("DS002");
    names.add("DS001");
    names.add("ds001");
    names.add("bad name");
    names.add("\x1b[2J");
    try std.testing.expectEqual(2, names.len);
    var c: Completion = .{};
    var text: std.ArrayList(u8) = .empty;
    defer text.deinit(a);
    try text.appendSlice(a, "sub");
    try c.complete(a, &text, &names, false);
    try std.testing.expectEqualStrings("subagent ", text.items);
    try c.complete(a, &text, &names, false);
    try std.testing.expectEqualStrings("subagent DS001", text.items);
    names.add("DS1000"); // Arrival must not reorder the active cycle.
    try c.complete(a, &text, &names, false);
    try std.testing.expectEqualStrings("subagent DS002", text.items);
    try c.complete(a, &text, &names, false);
    try std.testing.expectEqualStrings("subagent DS001", text.items);
    c.reset();
    text.clearRetainingCapacity();
    try text.appendSlice(a, "subagent  ds00");
    try c.complete(a, &text, &names, true);
    try std.testing.expectEqualStrings("subagent DS002", text.items);
    try std.testing.expect(!names.select("1"));
    try std.testing.expect(names.select("2"));
    try std.testing.expectEqual(0, names.len);
    for (0..40) |i| {
        var buffer: [64]u8 = undefined;
        names.add(try std.fmt.bufPrint(&buffer, "NM{d}", .{i}));
    }
    try std.testing.expectEqual(32, names.len);
    const large: [256]u8 = @splat('x');
    c.reset();
    text.clearRetainingCapacity();
    try text.appendSlice(a, &large);
    try c.complete(a, &text, &names, false);
    try std.testing.expectEqualStrings(&large, text.items);
}
