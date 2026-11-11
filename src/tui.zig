//! Local chat renderer. No Pi runtime, transcript store, admission queue,
//! retry timer, or implicit terminal creation lives here.
const std = @import("std");
const vaxis = @import("vaxis");
const fw = vaxis.vxfw;
const Native = @import("native.zig");
const Bridge = @import("tui_bridge.zig");
const Editor = @import("tui_editor.zig");
const wire = @import("generated/contracts.zig");
const TerminalStatus = @import("tui_status.zig");
const Action = @FieldType(wire.TuiRequest, "action");
var stopping: std.atomic.Value(bool) = .init(false);
fn signal(_: std.posix.SIG) callconv(.c) void {
    stopping.store(true, .monotonic);
}
const help =
    \\DECK · local client / Vim-style editing
    \\
    \\Tab or Ctrl-W w       switch chat / prompt (Normal mode)
    \\Ctrl-W k / j          focus chat / prompt
    \\Chat j/k, gg/G        scroll / oldest loaded / latest
    \\Ctrl-U/D, Ctrl-B/F    half / full page; mouse wheel scrolls
    \\:older, :latest       bounded canonical history pages
    \\
    \\Prompt i a I A o O    enter Insert mode; Esc returns to Normal
    \\h j k l, w b e W B E  grapheme / line / word motions
    \\0 ^ $ gg G            line / buffer motions; numeric counts
    \\d c y + motion        delete / change / yank; dd cc yy
    \\x X D C Y r, p P      edits / replace / internal-register paste
    \\v V, u, Ctrl-R        visual selection, undo / redo
    \\Insert Enter          newline (never submit); Ctrl-W/U edit
    \\
    \\/tasks                task picker; j/k, Enter select, n next, g first
    \\/task TITLE           create task; /select ID or /main switches
    \\/rex                  selected task Rex status; i inspect, o open
    \\/rex open             explicit best-effort open; no automatic retry
    \\/model or :model      hub model picker; j/k/arrows, Enter, Esc
    \\Shift-Tab             cycle supported thinking levels (idle chat)
    \\Ctrl-S or :send       explicitly submit (steer); save before send
    \\:retry / :discard     resolve saved input; no automatic replay
    \\:stop                 explicit stop request, not effect drainage
    \\:q or Ctrl-C          detach, never stop; :q! drops unsent text
    \\:help or F1           this help; Esc closes
    \\
    \\Saved requests are locked; retry uses original bytes, not preview.
    \\Unsubmitted editor text is in memory only. :q protects it.
    \\Switching refuses unsent text or unresolved requests; nothing is lost.
    \\Plain text, bounded task pages, 16 KiB prompt, 32 undo steps.
    \\No macros, dot-repeat, search, text objects or system clipboard.
;
const base: vaxis.Style = .{ .fg = .{ .rgb = .{ 218, 224, 234 } }, .bg = .{ .rgb = .{ 19, 23, 31 } } };
const dim: vaxis.Style = .{ .fg = .{ .rgb = .{ 135, 149, 170 } }, .bg = base.bg };
const accent: vaxis.Style = .{ .fg = .{ .rgb = .{ 116, 206, 188 } }, .bg = base.bg, .bold = true };
const bar: vaxis.Style = .{ .fg = base.fg, .bg = .{ .rgb = .{ 35, 44, 60 } } };
const Row = struct { text: []const u8, style: vaxis.Style, offset: usize };

const TransportStatus = enum {
    quiet,
    idle,
    waiting,
    fenced,

    fn observe(action: ?Action, elapsed: std.Io.Duration, precise: bool, failed: bool) TransportStatus {
        if (failed) return .fenced;
        if (action) |a| {
            if (a != .poll or precise or elapsed.nanoseconds >= 500 * std.time.ns_per_ms) return .waiting;
        } else if (precise) return .idle;
        // Neutral, not a claim that the request slot or worker is idle.
        return .quiet;
    }
    fn text(self: TransportStatus) []const u8 {
        return switch (self) {
            .quiet => "client",
            .idle => "client idle",
            .waiting => "client waiting",
            .fenced => "client fenced",
        };
    }
};

// Defense in depth at the final terminal boundary. Even a compromised bridge
// cannot install OSC links/clipboard, emit CSI, or hide labels with bidi controls.
fn safeGrapheme(text: []const u8) []const u8 {
    if (text.len > 256) return "�";
    var it = (std.unicode.Utf8View.init(text) catch return "�").iterator();
    while (it.nextCodepoint()) |cp| {
        if (cp < 32 or (cp >= 127 and cp <= 159) or cp == 0x200e or cp == 0x200f or (cp >= 0x202a and cp <= 0x202e) or (cp >= 0x2066 and cp <= 0x2069)) return "�";
    }
    if (vaxis.gwidth.gwidth(text, .unicode) == 0) return "�";
    return text;
}
fn glyph(ctx: fw.DrawContext, text: []const u8) struct { text: []const u8, width: u8 } {
    const safe = safeGrapheme(text);
    const width = ctx.stringWidth(safe);
    // Respect the library's negotiated width method, including legacy terminals.
    // Pathological standalone/very-wide clusters get a display-only replacement.
    if (width == 0 or width > 16) return .{ .text = "�", .width = 1 };
    return .{ .text = safe, .width = @intCast(width) };
}
fn displayWidth(ctx: fw.DrawContext, text: []const u8) usize {
    var it = vaxis.unicode.graphemeIterator(text);
    var width: usize = 0;
    while (it.next()) |g| width += glyph(ctx, g.bytes(text)).width;
    return width;
}
fn rows(ctx: fw.DrawContext, list: *std.ArrayList(Row), text: []const u8, width: u16, style: vaxis.Style) !void {
    var it = vaxis.unicode.graphemeIterator(text);
    var start: usize = 0;
    var col: usize = 0;
    while (it.next()) |g| {
        const chunk = g.bytes(text);
        if (std.mem.eql(u8, chunk, "\n")) {
            try list.append(ctx.arena, .{ .text = text[start..g.start], .style = style, .offset = start });
            start = g.start + g.len;
            col = 0;
            continue;
        }
        const w = glyph(ctx, chunk).width;
        if (col + w > width and col > 0) {
            try list.append(ctx.arena, .{ .text = text[start..g.start], .style = style, .offset = start });
            start = g.start;
            col = 0;
        }
        col += w;
    }
    try list.append(ctx.arena, .{ .text = text[start..], .style = style, .offset = start });
}
fn line(ctx: fw.DrawContext, surface: fw.Surface, x: u16, y: u16, text: []const u8, style: vaxis.Style, selection_range: ?[2]usize, offset: usize) void {
    var it = vaxis.unicode.graphemeIterator(text);
    var col = x;
    while (it.next()) |g| {
        const displayed = glyph(ctx, g.bytes(text));
        const chunk = displayed.text;
        const width = displayed.width;
        if (@as(usize, col) + width > surface.size.width) break;
        var s = style;
        if (selection_range) |range| if (offset + g.start >= range[0] and offset + g.start < range[1]) {
            s.reverse = true;
        };
        surface.writeCell(col, y, .{ .char = .{ .grapheme = chunk, .width = width }, .style = s });
        col += width;
    }
}
const Model = struct {
    a: std.mem.Allocator,
    bridge: *Bridge,
    editor: Editor,
    terminal_status: ?*TerminalStatus = null,
    snapshot: ?std.json.Parsed(wire.TuiResponse) = null,
    focus: enum { prompt, chat } = .prompt,
    command: std.ArrayList(u8) = .empty,
    command_mode: bool = false,
    command_prefix: u8 = ':',
    model_picker: bool = false,
    model_index: usize = 0,
    task_picker: bool = false,
    task_index: usize = 0,
    rex_view: bool = false,
    settings_uncertain: bool = false,
    paste_mode: bool = false,
    reject_paste: bool = false,
    paste_overflow: bool = false,
    paste_buffer: std.ArrayList(u8) = .empty,
    help_visible: bool = false,
    help_scroll: usize = 0,
    help_max: usize = 0,
    window_prefix: bool = false,
    chat_g: bool = false,
    chat_count: usize = 0,
    scroll: usize = 0,
    scroll_max: usize = 0,
    chat_height: usize = 10,
    ticks: u64 = 0,
    pending_since: std.Io.Timestamp = .zero,
    shown_transport: TransportStatus = .quiet,
    uncertain: bool = false,
    online: bool = false,
    notice: [1024]u8 = undefined,
    notice_len: usize = 0,
    fn deinit(self: *Model) void {
        if (self.snapshot) |s| s.deinit();
        self.editor.deinit();
        self.command.deinit(self.a);
        self.paste_buffer.deinit(self.a);
    }
    fn widget(self: *Model) fw.Widget {
        return .{ .userdata = self, .eventHandler = event, .drawFn = draw };
    }
    fn state(self: *Model) ?wire.TuiSnapshot {
        return if (self.snapshot) |s| s.value.case0.snapshot else null;
    }
    fn note(self: *Model, text: []const u8) void {
        var n = @min(text.len, self.notice.len);
        while (n > 0 and !std.unicode.utf8ValidateSlice(text[0..n])) n -= 1;
        @memcpy(self.notice[0..n], text[0..n]);
        self.notice_len = n;
    }
    fn locked(self: *Model) bool {
        if (self.state()) |s| if (s.draft != null) return true;
        if (self.bridge.pending) |p| if (p.action == .send or p.action == .retry or p.action == .discard or p.action == .create or p.action == .select) return true;
        return self.uncertain or self.snapshot == null or self.bridge.failed;
    }
    fn transportStatus(self: *Model, now: std.Io.Timestamp) TransportStatus {
        return TransportStatus.observe(if (self.bridge.pending) |p| p.action else null, self.pending_since.durationTo(now), self.command_mode or self.snapshot == null, self.bridge.failed);
    }
    fn settings(self: *Model) ?wire.ModelSettingsSnapshot {
        return if (self.state()) |s| s.modelSettings else null;
    }
    fn configure(self: *Model, selection: wire.ModelSelection) !void {
        const current = self.settings() orelse {
            self.note("Model settings unavailable; open /model (requires an updated hub).");
            return;
        };
        if (self.locked() or self.settings_uncertain) {
            self.note("Resolve unconfirmed requests/settings before changing model or thinking.");
            return;
        }
        if (try self.bridge.configure(.{ .expected = current.selection, .selection = selection })) {
            self.pending_since = std.Io.Timestamp.now(self.bridge.io, .awake);
            self.model_picker = false;
        } else self.note("Client request in flight; settings action not queued. Try again after its reply.");
    }
    fn cycleThinking(self: *Model) !void {
        const current = self.settings() orelse {
            self.note("Open /model to read available settings first.");
            return;
        };
        for (current.models) |model| {
            if (!std.mem.eql(u8, model.provider, current.selection.provider) or !std.mem.eql(u8, model.modelId, current.selection.modelId)) continue;
            if (model.thinkingLevels.len == 1 and model.thinkingLevels[0] == current.selection.thinkingLevel) {
                self.note("This model has only one supported thinking level.");
                return;
            }
            var next = model.defaultThinkingLevel;
            for (model.thinkingLevels, 0..) |level, index| if (level == current.selection.thinkingLevel) {
                next = model.thinkingLevels[(index + 1) % model.thinkingLevels.len];
                break;
            };
            var selection = current.selection;
            selection.thinkingLevel = next;
            try self.configure(selection);
            return;
        }
        self.note("Selected model no longer in the hub catalog; choose /model.");
    }
    fn canNavigate(self: *Model) bool {
        if (self.locked() or self.settings_uncertain) {
            self.note("Resolve saved requests/settings before switching or creating tasks.");
            return false;
        }
        if (self.editor.text.items.len != 0) {
            self.note("Unsent prompt preserved. Send or clear it before switching or creating tasks.");
            return false;
        }
        return true;
    }
    fn selectChat(self: *Model, id: []const u8) !void {
        if (!self.canNavigate()) return;
        if (try self.bridge.selectChat(id)) self.pending_since = std.Io.Timestamp.now(self.bridge.io, .awake) else self.note("Client request in flight; selection not queued.");
    }
    fn taskPage(self: *Model, after: ?[]const u8) !void {
        if (try self.bridge.tasks(after)) self.pending_since = std.Io.Timestamp.now(self.bridge.io, .awake) else self.note("Client request in flight; task read not queued.");
    }
    fn createTask(self: *Model, title: []const u8) !void {
        if (!self.canNavigate()) return;
        if (title.len == 0 or title.len > 200) {
            self.note("Task title must be 1 to 200 UTF-8 bytes.");
            return;
        }
        if (try self.bridge.request(.create, title, null)) self.pending_since = std.Io.Timestamp.now(self.bridge.io, .awake) else self.note("Client request in flight; task creation not queued.");
    }
    fn issue(self: *Model, action: Action) !void {
        if (self.settings_uncertain and (action == .send or action == .retry)) {
            self.note("Settings outcome unconfirmed; wait for a fresh observation before input.");
            return;
        }
        if (self.bridge.failed) {
            self.note("Client bridge lost; issued outcome unconfirmed. Detach and inspect saved drafts; no replay.");
            return;
        }
        if (action == .send and self.locked()) {
            self.note("Saved/unconfirmed request locked: :retry or :discard; instruction drafts use --no-tui");
            return;
        }
        if (action == .send and std.mem.trim(u8, self.editor.text.items, " \t\r\n").len == 0) return;
        if (try self.bridge.request(action, if (action == .send) self.editor.text.items else null, if (action == .poll) self.scroll > 0 else null)) {
            self.pending_since = std.Io.Timestamp.now(self.bridge.io, .awake);
            if (action == .rexStatus or action == .rexInspect or action == .rexOpen) self.rex_view = true;
            if (action == .send or action == .retry or action == .stop or action == .rexOpen) {
                if (self.terminal_status) |status| status.presentation.invalidate();
            }
        } else self.note("Client request in flight; action not queued. Try again after its reply.");
    }
    fn quit(self: *Model, ctx: *fw.EventContext, force: bool) void {
        const saved = if (self.state()) |s| (if (s.draft) |draft| draft.saved and draft.kind == .input else false) else false;
        if (!force and self.editor.text.items.len > 0 and !saved) {
            self.note("Prompt has no confirmed saved draft. :send / :retry, or :q! to detach without it.");
            return;
        }
        ctx.quit = true;
    }
    fn ex(self: *Model, ctx: *fw.EventContext) !void {
        const cmd = self.command.items;
        if (std.mem.eql(u8, cmd, "tasks")) try self.taskPage(null) else if (std.mem.startsWith(u8, cmd, "task ")) try self.createTask(std.mem.trim(u8, cmd[5..], " ")) else if (std.mem.startsWith(u8, cmd, "select ")) {
            const id = std.mem.trim(u8, cmd[7..], " ");
            const n = std.fmt.parseInt(u64, id, 10) catch 0;
            if (n == 0 or n > 9007199254740991 or id[0] == '0' or !std.ascii.isDigit(id[0])) self.note("Use /select with a positive chat ID from /tasks.") else try self.selectChat(id);
        } else if (std.mem.eql(u8, cmd, "main")) {
            if (self.state()) |s| if (s.mainChatId) |id| try self.selectChat(id);
        } else if (std.mem.eql(u8, cmd, "rex") or std.mem.eql(u8, cmd, "rex status")) try self.issue(.rexStatus) else if (std.mem.eql(u8, cmd, "rex inspect")) try self.issue(.rexInspect) else if (std.mem.eql(u8, cmd, "rex open") or std.mem.eql(u8, cmd, "rex reopen")) try self.issue(.rexOpen) else if (std.mem.eql(u8, cmd, "model")) try self.issue(.models) else if (self.command_prefix == '/') self.note("Use /tasks, /task TITLE, /select ID, /main, /rex or /model.") else if (std.mem.eql(u8, cmd, "q") or std.mem.eql(u8, cmd, "quit")) self.quit(ctx, false) else if (std.mem.eql(u8, cmd, "q!")) self.quit(ctx, true) else if (std.mem.eql(u8, cmd, "help")) self.help_visible = true else {
            const action: ?Action = if (std.mem.eql(u8, cmd, "send")) .send else if (std.mem.eql(u8, cmd, "retry")) .retry else if (std.mem.eql(u8, cmd, "discard")) .discard else if (std.mem.eql(u8, cmd, "stop")) .stop else if (std.mem.eql(u8, cmd, "older")) .older else if (std.mem.eql(u8, cmd, "latest")) .latest else null;
            if (action) |a| try self.issue(a) else self.note("Unknown command. :help shows the supported Vim and client commands.");
        }
        self.command_mode = false;
        self.command.clearRetainingCapacity();
    }
    fn press(self: *Model, ctx: *fw.EventContext, key: vaxis.Key) !void {
        if (self.paste_mode) {
            if (!self.reject_paste and !self.paste_overflow) {
                const text = if (key.matches(vaxis.Key.enter, .{})) "\r" else if (key.matches('j', .{ .ctrl = true })) "\n" else if (key.matches(vaxis.Key.tab, .{})) "    " else key.text orelse "";
                if (self.paste_buffer.items.len + text.len + self.editor.text.items.len > Editor.limit) self.paste_overflow = true else try self.paste_buffer.appendSlice(self.a, text);
            }
            return;
        }
        if (key.matches('c', .{ .ctrl = true })) {
            self.quit(ctx, false);
            return;
        }
        if (self.task_picker) {
            if (key.matches(vaxis.Key.escape, .{}) or key.matches('q', .{})) {
                self.task_picker = false;
                return;
            }
            const page = if (self.state()) |s| s.tasks orelse return else return;
            if (key.matches('n', .{})) {
                if (page.next) |next| try self.taskPage(next);
            } else if (key.matches('g', .{})) try self.taskPage(null) else if (page.items.len > 0) {
                if (key.matches('j', .{}) or key.matches(vaxis.Key.down, .{})) self.task_index = @min(page.items.len - 1, self.task_index + 1) else if (key.matches('k', .{}) or key.matches(vaxis.Key.up, .{})) self.task_index -|= 1 else if (key.matches(vaxis.Key.enter, .{})) try self.selectChat(page.items[self.task_index].chatId);
            }
            return;
        }
        if (self.rex_view) {
            if (key.matches(vaxis.Key.escape, .{}) or key.matches('q', .{})) self.rex_view = false else if (key.matches('s', .{})) try self.issue(.rexStatus) else if (key.matches('i', .{})) try self.issue(.rexInspect) else if (key.matches('o', .{})) try self.issue(.rexOpen);
            return;
        }
        if (self.model_picker) {
            if (key.matches(vaxis.Key.escape, .{}) or key.matches('q', .{})) {
                self.model_picker = false;
                return;
            }
            const current = self.settings() orelse return;
            if (current.models.len == 0) return;
            if (key.matches('j', .{}) or key.matches(vaxis.Key.down, .{})) self.model_index = @min(current.models.len - 1, self.model_index + 1) else if (key.matches('k', .{}) or key.matches(vaxis.Key.up, .{})) self.model_index -|= 1 else if (key.matches(vaxis.Key.enter, .{})) {
                const model = current.models[self.model_index];
                var level = model.defaultThinkingLevel;
                for (model.thinkingLevels) |supported| if (supported == current.selection.thinkingLevel) {
                    level = supported;
                    break;
                };
                try self.configure(.{ .provider = model.provider, .modelId = model.modelId, .thinkingLevel = level });
            }
            return;
        }
        if (key.matches(vaxis.Key.tab, .{ .shift = true })) {
            try self.cycleThinking();
            return;
        }
        if (self.help_visible) {
            if (key.matches(vaxis.Key.escape, .{}) or key.matches('q', .{})) self.help_visible = false else if (key.matches('j', .{}) or key.matches(vaxis.Key.down, .{})) self.help_scroll = @min(self.help_max, self.help_scroll + 1) else if (key.matches('k', .{}) or key.matches(vaxis.Key.up, .{})) self.help_scroll -|= 1 else if (key.matches(vaxis.Key.page_down, .{})) self.help_scroll = @min(self.help_max, self.help_scroll + 10) else if (key.matches(vaxis.Key.page_up, .{})) self.help_scroll -|= 10;
            return;
        }
        if (key.matches(vaxis.Key.f1, .{})) {
            self.help_visible = true;
            return;
        }
        if (self.command_mode) {
            if (key.matches(vaxis.Key.escape, .{})) {
                self.command_mode = false;
                self.command.clearRetainingCapacity();
            } else if (key.matches(vaxis.Key.enter, .{})) try self.ex(ctx) else if (key.matches(vaxis.Key.backspace, .{})) {
                var it = vaxis.unicode.graphemeIterator(self.command.items);
                var last: usize = 0;
                while (it.next()) |g| last = g.start;
                self.command.shrinkRetainingCapacity(last);
            } else if (!key.mods.ctrl and !key.mods.alt) {
                if (key.text) |text| {
                    if (std.unicode.utf8ValidateSlice(text) and self.command.items.len + text.len <= 256 and std.mem.indexOfAny(u8, text, "\x00\r\n\x1b") == null) try self.command.appendSlice(self.a, text);
                }
            }
            return;
        }
        if (key.matches('s', .{ .ctrl = true })) {
            try self.issue(.send);
            return;
        }
        const normal = self.focus == .chat or self.editor.mode != .insert or self.locked();
        if ((normal and key.matches(':', .{})) or ((normal or self.editor.text.items.len == 0) and key.matches('/', .{}))) {
            self.command_mode = true;
            self.command_prefix = if (key.matches('/', .{})) '/' else ':';
            return;
        }
        if (normal and self.window_prefix) {
            self.window_prefix = false;
            if (key.matches('k', .{})) self.focus = .chat else if (key.matches('j', .{})) self.focus = .prompt else if (key.matches('w', .{}) or key.matches('w', .{ .ctrl = true })) self.focus = if (self.focus == .chat) .prompt else .chat;
            return;
        }
        if (normal and key.matches('w', .{ .ctrl = true })) {
            self.window_prefix = true;
            return;
        }
        if (normal and key.matches(vaxis.Key.tab, .{})) {
            self.focus = if (self.focus == .chat) .prompt else .chat;
            return;
        }
        const up = key.matches(vaxis.Key.page_up, .{}) or (normal and (key.matches('u', .{ .ctrl = true }) or key.matches('b', .{ .ctrl = true })));
        const down = key.matches(vaxis.Key.page_down, .{}) or (normal and (key.matches('d', .{ .ctrl = true }) or key.matches('f', .{ .ctrl = true })));
        if (up or down) {
            const amount = @max(1, if (key.matches('u', .{ .ctrl = true }) or key.matches('d', .{ .ctrl = true })) self.chat_height / 2 else self.chat_height);
            self.scroll = if (up) @min(self.scroll_max, self.scroll + amount) else self.scroll -| amount;
            return;
        }
        if (self.focus == .chat) {
            const cp = key.codepoint;
            if (cp >= '1' and cp <= '9') {
                self.chat_count = @min(9999, self.chat_count * 10 + cp - '0');
                return;
            }
            const count = @max(1, self.chat_count);
            self.chat_count = 0;
            if (key.matches('k', .{}) or key.matches(vaxis.Key.up, .{})) self.scroll = @min(self.scroll_max, self.scroll + count) else if (key.matches('j', .{}) or key.matches(vaxis.Key.down, .{})) self.scroll -|= count else if (key.matches('G', .{})) {
                self.scroll = 0;
                try self.issue(.latest);
            } else if (key.matches('g', .{})) {
                if (self.chat_g) self.scroll = self.scroll_max;
                self.chat_g = !self.chat_g;
                return;
            } else if (key.matches('i', .{})) {
                self.focus = .prompt;
                if (!self.locked()) try self.editor.key(key);
            }
            self.chat_g = false;
            return;
        }
        if (!self.locked()) try self.editor.key(key) else if (key.matches(vaxis.Key.escape, .{})) self.editor.mode = .normal;
    }
    fn event(ptr: *anyopaque, ctx: *fw.EventContext, ev: fw.Event) !void {
        const self: *Model = @ptrCast(@alignCast(ptr));
        defer if (self.terminal_status) |status| {
            status.publish(.{
                .online = self.online,
                .fenced = self.bridge.failed,
                .unresolved_input = self.uncertain or (if (self.state()) |s| s.draft != null else false),
                .settings_uncertain = self.settings_uncertain,
            }, std.Io.Timestamp.now(ctx.io, .awake)) catch {};
        };
        switch (ev) {
            .init => {
                try ctx.requestFocus(self.widget());
                try self.issue(.poll);
                try ctx.tick(50, self.widget());
            },
            .tick => {
                if (stopping.load(.monotonic)) {
                    ctx.quit = true;
                    return;
                }
                const action: ?Action = if (self.bridge.pending) |p| p.action else null;
                const received = self.bridge.poll() catch {
                    self.online = false;
                    if (self.terminal_status) |status| status.presentation.invalidate();
                    self.note("Client bridge lost; outcome unconfirmed. Saved drafts remain. Detach with :q.");
                    ctx.redraw = true;
                    try ctx.tick(50, self.widget());
                    return;
                };
                if (received) |response| {
                    // Leave a usable idle interval after each observation; a
                    // slow read must not trigger an immediate new poll.
                    self.ticks = 0;
                    ctx.redraw = true;
                    if (response.value == .case1) {
                        self.note(response.value.case1.@"error");
                        self.online = false;
                        if (self.terminal_status) |status| status.presentation.invalidate();
                        if (action == .send or action == .retry or action == .create) self.uncertain = true;
                        if (action == .configure) self.settings_uncertain = true;
                        response.deinit();
                    } else {
                        const s = response.value.case0.snapshot;
                        if (action == .select) {
                            self.task_picker = false;
                            self.rex_view = false;
                            self.model_picker = false;
                            self.scroll = 0;
                            self.focus = .prompt;
                            self.uncertain = false;
                            self.settings_uncertain = s.settingsPending orelse false;
                            try self.editor.set(if (s.draft) |draft| draft.text else "");
                            if (self.terminal_status) |status| status.presentation = .{};
                        }
                        if (action == .tasks) {
                            self.task_picker = true;
                            self.task_index = 0;
                        }
                        if (action == .create) self.uncertain = false;
                        // Only a fresh observation updates the indicator: action
                        // ACKs and older pages can carry cached display fields.
                        if (action == .poll or action == .latest) {
                            if (self.terminal_status) |status| status.presentation.observe(s.agentStatus, std.Io.Timestamp.now(ctx.io, .awake));
                        }
                        if (s.settingsPending) |pending| self.settings_uncertain = pending else if (s.modelSettings != null and (action == .poll or action == .latest or action == .models or action == .configure)) self.settings_uncertain = false;
                        if (action == .models) {
                            self.model_picker = true;
                            self.model_index = 0;
                            if (s.modelSettings) |settings_value| for (settings_value.models, 0..) |model, index| {
                                if (std.mem.eql(u8, model.provider, settings_value.selection.provider) and std.mem.eql(u8, model.modelId, settings_value.selection.modelId)) {
                                    self.model_index = index;
                                    break;
                                }
                            };
                        }
                        if (self.snapshot == null and s.draft != null) try self.editor.set(s.draft.?.text);
                        if (action == .send or action == .retry or action == .discard) {
                            self.uncertain = false;
                            try self.editor.set("");
                            self.scroll = 0;
                        }
                        if (action == .older or action == .latest) self.scroll = 0;
                        if (action != .poll or self.snapshot == null) self.note(s.notice);
                        if (self.snapshot) |old| old.deinit();
                        self.snapshot = response;
                        self.online = true;
                    }
                }
                self.ticks += 1;
                if (self.ticks % 10 == 0 and self.bridge.pending == null and !self.command_mode and !self.paste_mode and !self.model_picker and !self.task_picker and !self.rex_view) {
                    try self.issue(.poll);
                }
                // A slow background read becomes visible even without input or
                // a reply. Fast polling alone doesn't change the footer.
                if (self.transportStatus(std.Io.Timestamp.now(ctx.io, .awake)) != self.shown_transport) ctx.redraw = true;
                try ctx.tick(50, self.widget());
            },
            .key_press => |key| {
                if (self.terminal_status) |status| status.presentation.acknowledge();
                self.press(ctx, key) catch |err| {
                    if (err == error.PromptTooLarge) self.note("Prompt limit: 16 KiB. Paste/edit refused; nothing submitted.") else if (err == error.InvalidUtf8) self.note("Invalid UTF-8 input refused; prompt unchanged.") else return err;
                };
                ctx.consumeAndRedraw();
            },
            .paste_start => {
                if (self.terminal_status) |status| status.presentation.acknowledge();
                self.paste_mode = true;
                self.reject_paste = self.command_mode or self.help_visible or self.model_picker or self.task_picker or self.rex_view or self.locked();
                self.paste_overflow = false;
                self.paste_buffer.clearRetainingCapacity();
            },
            .paste_end => {
                if (self.paste_overflow) self.note("Paste exceeds 16 KiB; entire paste refused, prompt unchanged.") else if (!self.reject_paste and !self.locked()) {
                    self.editor.paste(self.paste_buffer.items) catch |err| {
                        if (err == error.PromptTooLarge or err == error.InvalidUtf8) self.note("Invalid or oversized paste refused in full; prompt unchanged.") else return err;
                    };
                }
                self.paste_mode = false;
                self.reject_paste = false;
                self.paste_buffer.clearRetainingCapacity();
                ctx.consumeAndRedraw();
            },
            .paste => self.note("Clipboard replies ignored; use terminal bracketed paste."),
            .mouse => |mouse| {
                if (self.terminal_status) |status| status.presentation.acknowledge();
                if (mouse.button == .wheel_up) self.scroll = @min(self.scroll_max, self.scroll + 3) else if (mouse.button == .wheel_down) self.scroll -|= 3;
                ctx.consumeAndRedraw();
            },
            else => {},
        }
    }
    fn draw(ptr: *anyopaque, ctx: fw.DrawContext) std.mem.Allocator.Error!fw.Surface {
        const self: *Model = @ptrCast(@alignCast(ptr));
        self.shown_transport = self.transportStatus(std.Io.Timestamp.now(self.bridge.io, .awake));
        const w = @min(240, ctx.max.width orelse 80);
        const h = @min(120, ctx.max.height orelse 24);
        var surface = try fw.Surface.init(ctx.arena, self.widget(), .{ .width = w, .height = h });
        @memset(surface.buffer, .{ .style = base });
        if (w < 20 or h < 9) {
            line(ctx, surface, 0, 0, "Resize to 20 x 9", accent, null, 0);
            return surface;
        }
        const s = self.state();
        const title = try std.fmt.allocPrint(ctx.arena, " deck / {s}  ·  chat {s}  ·  {s} [{s}]", .{ if (s) |v| v.title else "connecting", if (s) |v| v.chatId else "?", if (s) |v| v.model else "", if (self.settings()) |settings_value| @tagName(settings_value.selection.thinkingLevel) else "thinking unavailable" });
        for (0..w) |x| surface.writeCell(@intCast(x), 0, .{ .style = bar });
        line(ctx, surface, 0, 0, title, bar, null, 0);
        if (self.task_picker) {
            line(ctx, surface, 1, 2, "TASKS · saved chats (labels are not host availability)", accent, null, 0);
            if (s) |snap| if (snap.tasks) |page| {
                const count = @as(usize, h - 7);
                const start = (self.task_index + 1) -| count;
                for (page.items[start..@min(page.items.len, start + count)], start..) |task, index| {
                    const text = try std.fmt.allocPrint(ctx.arena, "{s} {s} [{s}] {s} · {s}", .{ if (index == self.task_index) ">" else " ", task.chatId, @tagName(task.kind), task.title, task.cwd });
                    var style = base;
                    style.reverse = index == self.task_index;
                    line(ctx, surface, 1, @intCast(3 + index - start), text, style, null, 0);
                }
                if (page.items.len == 0) line(ctx, surface, 1, 3, "Empty scanned page; n continues when a cursor is available.", dim, null, 0);
                line(ctx, surface, 1, h - 3, if (page.next != null) "More pages: n · first page: g" else "Last page · first page: g", dim, null, 0);
            };
            line(ctx, surface, 1, h - 2, self.notice[0..self.notice_len], dim, null, 0);
            line(ctx, surface, 1, h - 1, "j/k · Enter select · Esc cancel · /task TITLE creates", accent, null, 0);
            return surface;
        }
        if (self.rex_view) {
            line(ctx, surface, 1, 2, "REX · selected chat · terminal presence is not agent health", accent, null, 0);
            var detail: std.ArrayList(Row) = .empty;
            if (s) |snap| if (snap.rex) |rex| {
                try rows(ctx, &detail, try std.fmt.allocPrint(ctx.arena, "{s}Allocation: {s} (historical, not readiness)", .{ if (self.online) "" else "STALE · ", @tagName(rex.status.status) }), w - 4, base);
                if (rex.status.binding orelse rex.status.previousBinding) |binding| {
                    try rows(ctx, &detail, try std.fmt.allocPrint(ctx.arena, "{s}Machine: {s}\nServer: {s}\nSession: {s}\nWindow: {s}\nTerminal: {s}", .{ if (rex.status.binding == null) "Previous binding · " else "", binding.machineId, binding.server, binding.sessionId, binding.windowId, binding.blockId }), w - 4, dim);
                }
                if (rex.inspection) |inspection| {
                    try rows(ctx, &detail, try std.fmt.allocPrint(ctx.arena, "Presence: {s} · sample {d} ms", .{ if (inspection.observation) |observation| @tagName(observation.state) else @tagName(inspection.status), inspection.finishedAtMs }), w - 4, accent);
                } else try rows(ctx, &detail, "Presence: not sampled; press i to inspect", w - 4, dim);
            };
            for (detail.items[0..@min(detail.items.len, h - 7)], 0..) |row, index| line(ctx, surface, 2, @intCast(3 + index), row.text, row.style, null, 0);
            line(ctx, surface, 1, h - 3, "Best-effort open may leave duplicates; inspect before repeating.", dim, null, 0);
            line(ctx, surface, 1, h - 2, self.notice[0..self.notice_len], dim, null, 0);
            line(ctx, surface, 1, h - 1, "s status · i inspect · o open/reopen · Esc close", accent, null, 0);
            return surface;
        }
        if (self.model_picker) {
            line(ctx, surface, 1, 2, "MODELS · hub catalog (account access not guaranteed)", accent, null, 0);
            if (self.settings()) |settings_value| {
                const count = @as(usize, h - 6);
                const start = (self.model_index + 1) -| count;
                for (settings_value.models[start..@min(settings_value.models.len, start + count)], start..) |model, index| {
                    const current = std.mem.eql(u8, model.provider, settings_value.selection.provider) and std.mem.eql(u8, model.modelId, settings_value.selection.modelId);
                    const default_model = std.mem.eql(u8, model.provider, settings_value.defaultModel.provider) and std.mem.eql(u8, model.modelId, settings_value.defaultModel.modelId);
                    const text = try std.fmt.allocPrint(ctx.arena, "{s} {s}/{s} · {s}{s}{s}", .{ if (index == self.model_index) ">" else " ", model.provider, model.modelId, model.name, if (current) " [selected]" else "", if (default_model) " [hub default]" else "" });
                    var style = base;
                    style.reverse = index == self.model_index;
                    line(ctx, surface, 1, @intCast(3 + index - start), text, style, null, 0);
                }
            }
            line(ctx, surface, 1, h - 2, self.notice[0..self.notice_len], dim, null, 0);
            line(ctx, surface, 1, h - 1, "j/k or arrows · Enter select · Esc cancel · idle chats only", accent, null, 0);
            return surface;
        }
        if (self.help_visible) {
            var help_rows: std.ArrayList(Row) = .empty;
            try rows(ctx, &help_rows, help, w - 4, base);
            self.help_max = help_rows.items.len -| (h - 4);
            self.help_scroll = @min(self.help_scroll, self.help_max);
            for (help_rows.items[self.help_scroll..@min(help_rows.items.len, self.help_scroll + h - 4)], 0..) |row, y| line(ctx, surface, 2, @intCast(y + 2), row.text, row.style, null, 0);
            line(ctx, surface, 1, h - 1, "HELP · j/k scroll · Esc close", accent, null, 0);
            return surface;
        }
        const prompt_h: u16 = @min(7, @max(2, h / 4));
        const chat_h = h - prompt_h - 5;
        self.chat_height = chat_h;
        var chat: std.ArrayList(Row) = .empty;
        if (s) |snap| for (snap.entries) |entry| {
            var role_style = accent;
            if (entry.role == .assistant) role_style.fg = .{ .rgb = .{ 153, 177, 247 } };
            if (entry.role == .tool or entry.role == .note) role_style = dim;
            const label = try std.fmt.allocPrint(ctx.arena, "{s} · #{d}", .{ @tagName(entry.role), entry.id });
            try rows(ctx, &chat, label, w - 4, role_style);
            try rows(ctx, &chat, entry.text, w - 4, if (entry.role == .note or entry.role == .tool) dim else base);
            try rows(ctx, &chat, "", w - 4, base);
        };
        if (chat.items.len == 0) try rows(ctx, &chat, if (s == null) "Connecting to the local hub…" else "No retained messages. Press i to write; Ctrl-S to submit.", w - 4, dim);
        self.scroll_max = chat.items.len -| chat_h;
        self.scroll = @min(self.scroll, self.scroll_max);
        const first = self.scroll_max - self.scroll;
        for (chat.items[first..@min(chat.items.len, first + chat_h)], 0..) |row, y| line(ctx, surface, 2, @intCast(y + 1), row.text, row.style, null, 0);
        const preview = if (s) |snap| snap.preview else "";
        const live = if (preview.len > 0) try std.fmt.allocPrint(ctx.arena, " live sample · {s}", .{preview[0 .. std.mem.indexOfScalar(u8, preview, '\n') orelse preview.len]}) else "";
        line(ctx, surface, 1, chat_h + 1, live, dim, null, 0);
        const mode = if (s != null and s.?.draft != null and !s.?.draft.?.saved) "LOCKED UNSAVED" else if (s != null and s.?.draft != null and s.?.draft.?.clipped) "SAVED PREVIEW" else if (s != null and s.?.draft != null and s.?.draft.?.saved) "SAVED LOCKED" else if (self.locked()) "LOCKED" else switch (self.editor.mode) {
            .normal => "NORMAL",
            .insert => "INSERT",
            .visual => "VISUAL",
            .visual_line => "V-LINE",
        };
        const border = try std.fmt.allocPrint(ctx.arena, " ── PROMPT / {s} {s} ──  {d}/16384 bytes", .{ mode, if (self.focus == .prompt) "●" else "○", self.editor.text.items.len });
        line(ctx, surface, 0, chat_h + 2, border, accent, null, 0);
        var prompt: std.ArrayList(Row) = .empty;
        try rows(ctx, &prompt, self.editor.text.items, w - 4, base);
        var cursor_row: usize = 0;
        for (prompt.items, 0..) |row, i| if (self.editor.cursor >= row.offset) {
            cursor_row = i;
        };
        const start = (cursor_row + 1) -| prompt_h;
        for (prompt.items[start..@min(prompt.items.len, start + prompt_h)], 0..) |row, y| line(ctx, surface, 2, @intCast(chat_h + 3 + y), row.text, row.style, self.editor.selection(), row.offset);
        if (self.focus == .prompt and !self.command_mode and !self.locked()) {
            const row = prompt.items[cursor_row];
            const end = @min(self.editor.cursor - row.offset, row.text.len);
            const col = @min(w - 3, 2 + displayWidth(ctx, row.text[0..end]));
            surface.cursor = .{ .col = @intCast(col), .row = @intCast(chat_h + 3 + cursor_row - start), .shape = if (self.editor.mode == .insert) .beam else .block };
        }
        if (self.command_mode) {
            const command_line = try std.fmt.allocPrint(ctx.arena, "{c}{s}", .{ self.command_prefix, self.command.items });
            line(ctx, surface, 1, h - 2, command_line, accent, null, 0);
            surface.cursor = .{ .row = h - 2, .col = @intCast(@min(w - 1, displayWidth(ctx, self.command.items) + 2)), .shape = .beam };
        } else line(ctx, surface, 1, h - 2, self.notice[0..self.notice_len], dim, null, 0);
        for (0..w) |x| surface.writeCell(@intCast(x), h - 1, .{ .style = bar });
        const queued = if (s != null and s.?.activityKnown) try std.fmt.allocPrint(ctx.arena, "{d}", .{s.?.queued}) else "?";
        const status = try std.fmt.allocPrint(ctx.arena, " {s} · {s} / {s} · {s}{s} · queued {s} · {s} · {s}", .{ self.shown_transport.text(), if (self.focus == .chat) "CHAT" else "PROMPT", mode, if (self.online) "" else "STALE / ", if (s) |snap| (if (!snap.activityKnown) "activity unavailable" else if (snap.busy) "busy sample" else "idle sample") else "connecting", queued, if (s) |snap| snap.tools else "", if (s) |snap| (if (snap.historical) "older / :latest" else if (self.scroll > 0) "scroll held" else "latest") else "" });
        line(ctx, surface, 0, h - 1, status, bar, null, 0);
        const hints = "  ^S send  :help  :q ";
        if (w >= 60) line(ctx, surface, @intCast(w - hints.len), h - 1, hints, bar, null, 0);
        return surface;
    }
};

pub fn selected(args: []const []const u8, terminal: bool) !bool {
    var force = false;
    var plain = false;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--tui")) force = true else if (std.mem.eql(u8, arg, "--no-tui")) plain = true else {
            if (std.mem.eql(u8, arg, "--message")) plain = true;
            // Value bytes are never reinterpreted as flags (notably --message).
            if (std.mem.startsWith(u8, arg, "--")) i += 1;
        }
    }
    if (force and plain) return error.ConflictingClientModes;
    return force or (terminal and !plain);
}

pub fn run(init: std.process.Init, args: []const []const u8) !void {
    if (std.c.isatty(0) != 1 or std.c.isatty(1) != 1) return error.InteractiveTerminalRequired;
    var forwarded: std.ArrayList([]const u8) = .empty;
    defer forwarded.deinit(init.gpa);
    var hub_id: ?[]const u8 = null;
    var chat_id: ?[]const u8 = null;
    var allocation_id: ?[]const u8 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--tui")) continue;
        const key = args[i];
        if (!std.mem.eql(u8, key, "--port") and !std.mem.eql(u8, key, "--task") and !std.mem.eql(u8, key, "--hub-id") and !std.mem.eql(u8, key, "--rex-allocation")) return error.UnsupportedTuiOption;
        i += 1;
        if (i == args.len) return error.MissingOptionValue;
        if (std.mem.eql(u8, key, "--port")) {
            const n = std.fmt.parseInt(u16, args[i], 10) catch return error.InvalidPort;
            if (n == 0) return error.InvalidPort;
        }
        if (std.mem.eql(u8, key, "--task")) {
            const n = std.fmt.parseInt(u64, args[i], 10) catch return error.InvalidChat;
            if (n == 0 or n > 9007199254740991 or args[i][0] == '0') return error.InvalidChat;
            chat_id = args[i];
        }
        if (std.mem.eql(u8, key, "--hub-id")) {
            if (args[i].len == 0 or args[i].len > 200 or !std.unicode.utf8ValidateSlice(args[i])) return error.InvalidHub;
            hub_id = args[i];
        }
        if (std.mem.eql(u8, key, "--rex-allocation")) {
            if (!wire.validRexUuid(.{ .string = args[i] })) return error.InvalidAllocation;
            allocation_id = args[i];
        }
        try forwarded.appendSlice(init.gpa, &.{ key, args[i] });
    }
    if (allocation_id != null and (hub_id == null or chat_id == null)) return error.InvalidAllocation;
    var bridge = try Bridge.start(.{ .io = init.io, .environ = init.minimal.environ }, init.gpa, forwarded.items);
    defer bridge.deinit();
    if (hub_id) |id| bridge.hub_id = try init.gpa.dupe(u8, id);
    if (chat_id) |id| bridge.chat_id = try init.gpa.dupe(u8, id);
    var model: Model = .{ .a = init.gpa, .bridge = &bridge, .editor = Editor.init(init.gpa) };
    defer model.deinit();
    stopping.store(false, .monotonic);
    const signals = [_]std.posix.SIG{ .TERM, .HUP, .INT };
    var previous: [signals.len]std.posix.Sigaction = undefined;
    const handler: std.posix.Sigaction = .{ .handler = .{ .handler = signal }, .mask = std.posix.sigemptyset(), .flags = 0 };
    for (signals, 0..) |sig, n| std.posix.sigaction(sig, &handler, &previous[n]);
    defer for (signals, 0..) |sig, n| std.posix.sigaction(sig, &previous[n], null);
    var previous_pipe: std.posix.Sigaction = undefined;
    const ignore_pipe: std.posix.Sigaction = .{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(.PIPE, &ignore_pipe, &previous_pipe);
    defer std.posix.sigaction(.PIPE, &previous_pipe, null);
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
    // Bracketed paste uses key events; never decode/allocate unsolicited OSC 52.
    app.vx.opts.system_clipboard_allocator = null;
    const cwd = std.process.currentPathAlloc(init.io, init.gpa) catch null;
    defer if (cwd) |path| init.gpa.free(path);
    var title_buffer: [192]u8 = undefined;
    var terminal_status: TerminalStatus = .{ .vx = &app.vx, .writer = app.tty.writer(), .title = TerminalStatus.directoryTitle(&title_buffer, cwd orelse "unknown") };
    defer terminal_status.end();
    try terminal_status.begin();
    model.terminal_status = &terminal_status;
    try app.run(model.widget(), .{ .framerate = 30 });
}

test "paste is atomic literal data and layout uses bounded grapheme-safe surfaces" {
    const a = std.testing.allocator;
    var bridge: Bridge = .{ .a = a, .io = std.testing.io, .child = undefined };
    const owned = try a.create(std.heap.ArenaAllocator);
    owned.* = .init(a);
    var model: Model = .{ .a = a, .bridge = &bridge, .editor = Editor.init(a), .snapshot = .{
        .arena = owned,
        .value = .{ .case0 = .{ .version = 1, .id = "1", .ok = true, .snapshot = .{
            .hubId = "hub",
            .chatId = "1",
            .title = "Main",
            .model = "mock",
            .tools = "offline",
            .activityKnown = false,
            .busy = false,
            .queued = 0,
            .entries = &.{.{ .id = 1, .role = .assistant, .text = "unsafe \x1b]52;c;data\x07 \xc2\x9b control" }},
            .hasOlder = false,
            .historical = false,
            .preview = "",
            .notice = "",
            .draft = null,
        } } },
    } };
    defer model.deinit();
    var ctx: fw.EventContext = .{ .io = std.testing.io, .alloc = a, .cmds = .empty };
    defer ctx.cmds.deinit(a);
    try model.editor.paste("base");
    try Model.event(&model, &ctx, .paste_start);
    const huge: [Editor.limit]u8 = @splat('x');
    try model.press(&ctx, .{ .codepoint = 'x', .text = &huge });
    try Model.event(&model, &ctx, .paste_end);
    try std.testing.expectEqualStrings("base", model.editor.text.items);
    try std.testing.expect(std.mem.indexOf(u8, model.notice[0..model.notice_len], "entire paste refused") != null);
    try Model.event(&model, &ctx, .paste_start);
    try model.press(&ctx, .{ .codepoint = 's', .mods = .{ .ctrl = true } });
    try model.press(&ctx, .{ .codepoint = ':', .text = ":q!\n" });
    try Model.event(&model, &ctx, .paste_end);
    try std.testing.expectEqualStrings("base:q!\n", model.editor.text.items);
    try std.testing.expect(!ctx.quit and !model.command_mode and bridge.pending == null);
    try Model.event(&model, &ctx, .paste_start);
    try model.press(&ctx, .{ .codepoint = 'x', .text = "\xff" });
    try Model.event(&model, &ctx, .paste_end);
    try std.testing.expectEqualStrings("base:q!\n", model.editor.text.items);
    try model.editor.set("");
    try model.editor.paste("A界👩‍💻é");
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    fw.DrawContext.init(.unicode);
    const draw_ctx: fw.DrawContext = .{ .arena = arena.allocator(), .min = .{}, .max = .{ .width = 100, .height = 40 }, .cell_size = .{ .width = 8, .height = 16 } };
    const surface = try Model.draw(&model, draw_ctx);
    try std.testing.expectEqual(8, surface.cursor.?.col);
    for (surface.buffer) |cell| {
        try std.testing.expect(std.mem.indexOfScalar(u8, cell.char.grapheme, 27) == null);
        try std.testing.expect(std.mem.indexOf(u8, cell.char.grapheme, "\xc2\x9b") == null);
    }
    var small = draw_ctx;
    small.max = .{ .width = 10, .height = 3 };
    try std.testing.expectEqual(30, (try Model.draw(&model, small)).buffer.len);
    var large = draw_ctx;
    large.max = .{ .width = 500, .height = 500 };
    bridge.pending = .{ .version = 1, .id = "pending", .action = .poll };
    model.pending_since = std.Io.Timestamp.now(bridge.io, .awake).subDuration(.fromMilliseconds(501));
    const started = model.pending_since;
    try model.issue(.older); // Refusal must not restart the waiting indicator's delay.
    try std.testing.expectEqualDeep(started, model.pending_since);
    const waiting_surface = try Model.draw(&model, large);
    try std.testing.expectEqual(240 * 120, waiting_surface.buffer.len);
    var footer: std.ArrayList(u8) = .empty;
    defer footer.deinit(a);
    for (waiting_surface.buffer[240 * 119 ..]) |cell| try footer.appendSlice(a, cell.char.grapheme);
    try std.testing.expect(std.mem.indexOf(u8, footer.items, "client waiting") != null);
    try std.testing.expect(std.mem.indexOf(u8, footer.items, "offline") != null);
    bridge.pending = null;
    model.snapshot.?.value.case0.snapshot.draft = .{ .kind = .input, .requestId = "saved", .text = "preview", .clipped = false, .saved = false };
    model.quit(&ctx, false);
    try std.testing.expect(!ctx.quit);
    model.snapshot.?.value.case0.snapshot.draft.?.saved = true;
    model.quit(&ctx, false);
    try std.testing.expect(ctx.quit);
}

test "transport display suppresses quick polls but shows slow reads and explicit actions" {
    // Repeated healthy background observations keep exactly the same label.
    for (0..20) |_| {
        try std.testing.expectEqual(TransportStatus.quiet, TransportStatus.observe(null, .zero, false, false));
        try std.testing.expectEqual(TransportStatus.quiet, TransportStatus.observe(.poll, .fromMilliseconds(499), false, false));
        try std.testing.expectEqual(TransportStatus.quiet, TransportStatus.observe(null, .fromMilliseconds(499), false, false));
    }
    try std.testing.expectEqualStrings("client", TransportStatus.quiet.text());
    try std.testing.expectEqual(TransportStatus.waiting, TransportStatus.observe(.poll, .fromMilliseconds(500), false, false));
    try std.testing.expectEqual(TransportStatus.quiet, TransportStatus.observe(null, .fromMilliseconds(1000), false, false));
    for ([_]Action{ .send, .retry, .discard, .stop, .older, .latest, .models, .configure }) |action|
        try std.testing.expectEqual(TransportStatus.waiting, TransportStatus.observe(action, .zero, false, false));
    // Startup and Ex commands still expose the exact slot, not debounced readiness.
    try std.testing.expectEqual(TransportStatus.waiting, TransportStatus.observe(.poll, .zero, true, false));
    try std.testing.expectEqual(TransportStatus.idle, TransportStatus.observe(null, .zero, true, false));
    try std.testing.expectEqual(TransportStatus.fenced, TransportStatus.observe(.poll, .zero, false, true));
    try std.testing.expectEqual(TransportStatus.fenced, TransportStatus.observe(null, .zero, true, true));
}

test "TTY selection preserves plain mode and literal flag-looking message bytes" {
    try std.testing.expect(try selected(&.{}, true));
    try std.testing.expect(!try selected(&.{}, false));
    try std.testing.expect(!try selected(&.{"--no-tui"}, true));
    try std.testing.expect(!try selected(&.{ "--message", "--tui" }, true));
    try std.testing.expect(try selected(&.{ "--hub-id", "--no-tui" }, true));
    try std.testing.expectError(error.ConflictingClientModes, selected(&.{ "--tui", "--no-tui" }, true));
}

test "untrusted terminal and bidi controls never reach cells" {
    try std.testing.expectEqualStrings("�", safeGrapheme("\x1b]52;c;SECRET\x07"));
    try std.testing.expectEqualStrings("�", safeGrapheme("\xc2\x9b31m"));
    try std.testing.expectEqualStrings("�", safeGrapheme("\u{202e}spoof"));
    try std.testing.expectEqualStrings("👩🏽‍💻", safeGrapheme("👩🏽‍💻"));
}
