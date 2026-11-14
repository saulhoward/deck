//! A creation form, not a chat or a second agent. Its process remains alive in
//! the same Rex block when the verified scope is handed to the existing TUI.
const std = @import("std");
const vaxis = @import("vaxis");
const fw = vaxis.vxfw;
const Editor = @import("tui_editor.zig");
const Bridge = @import("agent_form_bridge.zig");
const Theme = @import("tui_theme.zig");
const render = @import("tui.zig");
const wire = @import("generated/contracts.zig");
var stopping: std.atomic.Value(bool) = .init(false);
fn signal(_: std.posix.SIG) callconv(.c) void {
    stopping.store(true, .release);
}
const Model = struct {
    a: std.mem.Allocator,
    bridge: *Bridge,
    cwd: []const u8,
    problem: Editor,
    description: Editor,
    description_used: bool = false,
    focus: u8 = 0,
    response: ?std.json.Parsed(wire.AgentWizardResponse) = null,
    notice: []const u8 = "",
    paste_mode: bool = false,
    paste_overflow: bool = false,
    paste: std.ArrayList(u8) = .empty,
    ticks: usize = 0,
    external: bool = false,
    fn widget(self: *Model) fw.Widget {
        return .{ .userdata = self, .eventHandler = event, .drawFn = draw };
    }
    fn deinit(self: *Model) void {
        self.problem.deinit();
        self.description.deinit();
        self.paste.deinit(self.a);
        if (self.response) |r| r.deinit();
        if (self.notice.len > 0) self.a.free(self.notice);
    }
    fn note(self: *Model, text: []const u8) !void {
        const next = try self.a.dupe(u8, text);
        if (self.notice.len > 0) self.a.free(self.notice);
        self.notice = next;
    }
    fn phase(self: *const Model) @FieldType(wire.AgentWizardResponse, "phase") {
        return if (self.response) |r| r.value.phase else .form;
    }
    fn saved(self: *const Model) bool {
        return if (self.response) |r| r.value.saved else false;
    }
    fn editable(self: *const Model) bool {
        return !self.saved() and (self.phase() == .form or self.phase() == .blocked) and (self.bridge.pending == null or self.bridge.pending == .poll) and !self.bridge.pipe.failed;
    }
    fn editor(self: *Model) *Editor {
        return if (self.focus == 0) &self.problem else &self.description;
    }
    fn issue(self: *Model, action: Bridge.Action) !void {
        if (self.bridge.pipe.failed) return self.note("Creation bridge lost. Exact saved requests remain. Ctrl-C detaches; no work is stopped.");
        const accepted = self.bridge.request(action, if (action == .create) self.problem.text.items else null, if (action == .create and self.description_used) self.description.text.items else null) catch return self.note("A nonblank problem is required (2048 UTF-8 bytes); optional description is limited to 8192 bytes. Nothing submitted.");
        if (!accepted) return self.note("Request in flight; action not queued. Ctrl-C still detaches.");
        if (action != .poll) try self.note("Saving/requesting exact startup intent. Detach never cancels admitted work.");
    }
    fn press(self: *Model, ctx: *fw.EventContext, key: vaxis.Key) !void {
        if (self.paste_mode) {
            const text = if (key.matches(vaxis.Key.enter, .{})) "\r" else if (key.matches('j', .{ .ctrl = true })) "\n" else if (key.matches(vaxis.Key.tab, .{})) "\t" else key.text orelse "";
            if (self.paste.items.len + text.len > Editor.limit) self.paste_overflow = true else if (!self.paste_overflow) try self.paste.appendSlice(self.a, text);
            return;
        }
        if (key.matches('c', .{ .ctrl = true })) {
            ctx.quit = true;
            return;
        }
        if (key.matches(vaxis.Key.tab, .{})) {
            self.focus = (self.focus + 1) % (if (self.saved()) @as(u8, 4) else 3);
            return;
        }
        if (key.matches(vaxis.Key.tab, .{ .shift = true })) {
            const count: u8 = if (self.saved()) 4 else 3;
            self.focus = (self.focus + count - 1) % count;
            return;
        }
        if (key.matches('s', .{ .ctrl = true }) and self.editable()) {
            self.focus = 2;
            try self.issue(.create);
            return;
        }
        if (key.matches('e', .{ .ctrl = true }) and self.editable()) {
            self.description_used = !self.description_used;
            return;
        }
        if (key.matches(vaxis.Key.enter, .{})) {
            if (self.focus < 2) self.focus += 1 else if (self.focus == 3 and self.saved()) try self.issue(.discard) else if (self.phase() == .blocked and self.saved()) try self.issue(.retry) else if (self.editable()) try self.issue(.create);
            return;
        }
        if (self.focus < 2 and self.editable()) {
            const active = self.editor();
            if (key.matches('v', .{}) and active.mode == .normal) {
                self.external = true;
                ctx.quit = true;
                return;
            }
            if (key.matches(vaxis.Key.enter, .{ .shift = true })) {
                try active.insert("\n");
                if (self.focus == 1) self.description_used = true;
            } else {
                const before = std.hash.Wyhash.hash(0, active.text.items);
                try active.key(key);
                if (self.focus == 1 and before != std.hash.Wyhash.hash(0, active.text.items)) self.description_used = true;
            }
        }
    }
    fn event(ptr: *anyopaque, ctx: *fw.EventContext, ev: fw.Event) !void {
        const self: *Model = @ptrCast(@alignCast(ptr));
        switch (ev) {
            .init => {
                try ctx.requestFocus(self.widget());
                if (self.response == null) try self.issue(.poll);
                try ctx.tick(50, self.widget());
            },
            .tick => {
                if (stopping.load(.acquire)) {
                    ctx.quit = true;
                    return;
                }
                const reply = self.bridge.poll() catch blk: {
                    try self.note("Creation bridge lost; outcome unconfirmed. Saved drafts retained. Ctrl-C detaches without stopping work.");
                    break :blk null;
                };
                if (reply) |r| {
                    if (self.response) |old| old.deinit();
                    self.response = r;
                    try self.note(r.value.notice);
                    if (r.value.saved and self.focus < 2) self.focus = 2;
                    if (r.value.phase == .ready) ctx.quit = true;
                    ctx.redraw = true;
                    self.ticks = 0;
                }
                self.ticks += 1;
                if (self.ticks % 10 == 0 and self.phase() == .waiting and self.bridge.pending == null) try self.issue(.poll);
                try ctx.tick(50, self.widget());
            },
            .key_press => |key| {
                self.press(ctx, key) catch try self.note("Edit exceeds the bounded field buffer; nothing submitted.");
                ctx.consumeAndRedraw();
            },
            .paste_start => {
                self.paste_mode = true;
                self.paste_overflow = !self.editable() or self.focus > 1;
                self.paste.clearRetainingCapacity();
            },
            .paste_end => {
                if (!self.paste_overflow and self.editable() and self.focus < 2) {
                    // Preserve the data accepted by the terminal parser exactly;
                    // it is never interpreted as keys, commands or submission.
                    self.editor().insert(self.paste.items) catch try self.note("Paste refused in full; field unchanged.");
                    if (self.focus == 1) self.description_used = true;
                }
                self.paste_mode = false;
                self.paste.clearRetainingCapacity();
                ctx.consumeAndRedraw();
            },
            else => {},
        }
    }
    fn field(self: *Model, ctx: fw.DrawContext, surface: *fw.Surface, x: u16, y: u16, width: u16, height: u16, index: u8) !void {
        const e = if (index == 0) &self.problem else &self.description;
        var lines: std.ArrayList(render.Row) = .empty;
        try render.rows(ctx, &lines, e.text.items, width, Theme.base);
        if (lines.items.len == 0) try lines.append(ctx.arena, .{});
        var cursor: usize = 0;
        for (lines.items, 0..) |row, n| if (e.cursor >= row.offset) {
            cursor = n;
        };
        const start = if (self.focus == index and cursor >= height) cursor - height + 1 else 0;
        for (lines.items[start..], 0..) |row, n| {
            if (n >= height) break;
            render.line(ctx, surface.*, x, y + @as(u16, @intCast(n)), row.text, Theme.base, null, row.offset);
        }
        if (self.focus == index and self.editable() and cursor >= start and cursor - start < height) {
            const row = lines.items[cursor];
            const end = @min(row.text.len, e.cursor -| row.offset);
            surface.cursor = .{ .col = x + @as(u16, @intCast(@min(width -| 1, render.displayWidth(ctx, row.text[0..end])))), .row = y + @as(u16, @intCast(cursor - start)), .shape = if (e.mode == .insert) .beam else .block };
        }
    }
    fn draw(ptr: *anyopaque, ctx: fw.DrawContext) std.mem.Allocator.Error!fw.Surface {
        const self: *Model = @ptrCast(@alignCast(ptr));
        const w = @min(512, ctx.max.width orelse 80);
        const h = @min(120, ctx.max.height orelse 24);
        var surface = try fw.Surface.init(ctx.arena, self.widget(), .{ .width = w, .height = h });
        @memset(surface.buffer, .{ .style = Theme.base });
        if (w < 24 or h < 16) {
            if (h > 0 and w > 0) render.line(ctx, surface, 0, 0, "Resize to 24 x 16", Theme.green, null, 0);
            return surface;
        }
        const width = @min(w - 2, 80);
        const x = (w - width) / 2;
        render.line(ctx, surface, x, 1, "Create a task", Theme.green, null, 0);
        render.line(ctx, surface, x, 3, try std.fmt.allocPrint(ctx.arena, "Workspace: {s}", .{self.cwd}), Theme.dim, null, 0);
        const field_height = (h - 13) / 2;
        render.line(ctx, surface, x, 5, "Problem (required)", if (self.focus == 0) Theme.green else Theme.dim, null, 0);
        try self.field(ctx, &surface, x, 6, width, field_height, 0);
        const desc_y = 7 + field_height;
        render.line(ctx, surface, x, desc_y, if (self.description_used) "Description (included, even when empty)" else "Description (optional; omitted)", if (self.focus == 1) Theme.green else Theme.dim, null, 0);
        try self.field(ctx, &surface, x, desc_y + 1, width, field_height, 1);
        const button = if (self.phase() == .waiting) "[ Waiting for exact allocation ]" else if (self.saved()) "[ Retry exact request ]" else "[ Create & start ]";
        render.line(ctx, surface, x, h - 5, button, if (self.focus == 2) Theme.green else Theme.dim, null, 0);
        if (self.saved()) render.line(ctx, surface, x + @min(width - 1, 27), h - 5, "[ Discard locally ]", if (self.focus == 3) Theme.green else Theme.dim, null, 0);
        render.line(ctx, surface, x, h - 3, self.notice, Theme.dim, null, 0);
        render.line(ctx, surface, 0, h - 1, "Tab fields · Enter next/start · Shift-Enter newline · Ctrl-E description · Ctrl-C detach", Theme.dim, null, 0);
        return surface;
    }
};
pub fn run(init: std.process.Init, record: wire.RexBootstrapRecord, a: std.mem.Allocator) !?wire.AgentWizardReady {
    if (std.c.isatty(0) != 1 or std.c.isatty(1) != 1) return error.InteractiveTerminalRequired;
    stopping.store(false, .release);
    const signals = [_]std.posix.SIG{ .TERM, .HUP, .INT, .PIPE };
    var previous: [signals.len]std.posix.Sigaction = undefined;
    for (signals, 0..) |sig, n| {
        const handler: std.posix.Sigaction = .{ .handler = if (sig == .PIPE) .{ .handler = std.posix.SIG.IGN } else .{ .handler = signal }, .mask = std.posix.sigemptyset(), .flags = 0 };
        std.posix.sigaction(sig, &handler, &previous[n]);
    }
    defer for (signals, 0..) |sig, n| std.posix.sigaction(sig, &previous[n], null);
    var bridge = try Bridge.start(.{ .io = init.io, .environ = init.minimal.environ }, init.gpa, record.draftRoot, record.id);
    defer bridge.deinit();
    var model: Model = .{ .a = init.gpa, .bridge = &bridge, .cwd = record.cwd, .problem = Editor.init(init.gpa), .description = Editor.init(init.gpa) };
    model.problem.mode = .insert;
    model.description.mode = .insert;
    defer model.deinit();
    while (!stopping.load(.acquire)) {
        {
            var buffer: [4096]u8 = undefined;
            var app = fw.App.init(init.io, init.gpa, init.environ_map, &buffer) catch |err| {
                vaxis.recover();
                vaxis.tty.global_tty = null;
                return err;
            };
            defer {
                app.deinit();
                vaxis.tty.global_tty = null;
            }
            app.vx.opts.system_clipboard_allocator = null;
            try app.run(model.widget(), .{ .framerate = 30 });
        }
        if (!model.external or stopping.load(.acquire)) break;
        model.external = false;
        const edited = @import("tui_external_editor.zig").run(.{ .io = init.io, .environ = init.minimal.environ }, init.gpa, init.environ_map, model.editor().text.items, &stopping) catch {
            try model.note("External editor failed; field unchanged. Nothing submitted.");
            continue;
        };
        defer init.gpa.free(edited);
        if (edited.len > (if (model.focus == 0) @as(usize, 2048) else 8192)) {
            try model.note("Edited field exceeds its limit; original retained.");
            continue;
        }
        try model.editor().replace(edited);
        if (model.focus == 1) model.description_used = true;
        try model.note("Editor contents loaded. Nothing submitted; choose Create & start explicitly.");
    }
    if (!stopping.load(.acquire)) if (model.response) |reply| if (reply.value.ready) |ready| return .{ .chatId = try a.dupe(u8, ready.chatId), .allocationId = try a.dupe(u8, ready.allocationId), .inputId = try a.dupe(u8, ready.inputId) };
    return null;
}

test "creation form accepts typing during read-only startup, preserves paste and requires explicit start" {
    const a = std.testing.allocator;
    var bridge: Bridge = .{ .pipe = .{ .a = a, .io = std.testing.io, .child = undefined }, .pending = .poll };
    defer bridge.pipe.input.deinit(a);
    defer bridge.pipe.output.deinit(a);
    var model: Model = .{ .a = a, .bridge = &bridge, .cwd = "/workspace", .problem = Editor.init(a), .description = Editor.init(a) };
    defer model.deinit();
    model.problem.mode = .insert;
    model.description.mode = .insert;
    var ctx: fw.EventContext = .{ .io = std.testing.io, .alloc = a, .cmds = .empty };
    defer ctx.cmds.deinit(a);
    try model.press(&ctx, .{ .codepoint = 'p', .text = "  problem 🌍  " });
    try std.testing.expectEqualStrings("  problem 🌍  ", model.problem.text.items);
    try model.press(&ctx, .{ .codepoint = vaxis.Key.enter });
    try std.testing.expectEqual(@as(u8, 1), model.focus);
    try std.testing.expect(!model.description_used);
    try Model.event(&model, &ctx, .paste_start);
    try model.press(&ctx, .{ .codepoint = vaxis.Key.tab });
    try model.press(&ctx, .{ .codepoint = ':', .text = ":q!\n exact " });
    try model.press(&ctx, .{ .codepoint = 's', .mods = .{ .ctrl = true } });
    try Model.event(&model, &ctx, .paste_end);
    try std.testing.expectEqualStrings("\t:q!\n exact ", model.description.text.items);
    try std.testing.expect(!ctx.quit and model.description_used and bridge.pending == .poll);
    try model.press(&ctx, .{ .codepoint = vaxis.Key.enter });
    try std.testing.expectEqual(@as(u8, 2), model.focus);
    try model.press(&ctx, .{ .codepoint = vaxis.Key.enter });
    try std.testing.expectEqual(@as(usize, 0), bridge.pipe.output.items.len); // Not queued behind a read.
    bridge.pending = null;
    try model.press(&ctx, .{ .codepoint = vaxis.Key.enter });
    try std.testing.expect(bridge.pending == .create);
    const request = try wire.parseAgentWizardRequest(a, bridge.pipe.output.items[4..]);
    defer request.deinit();
    try std.testing.expectEqualStrings(model.problem.text.items, request.value.problem.?);
    try std.testing.expectEqualStrings(model.description.text.items, request.value.description.?);
    try model.press(&ctx, .{ .codepoint = vaxis.Key.tab });
    try model.press(&ctx, .{ .codepoint = 'x', .text = "not allowed" });
    try std.testing.expectEqualStrings("  problem 🌍  ", model.problem.text.items);
}
