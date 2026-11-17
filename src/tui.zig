//! Local chat renderer. No Pi runtime, transcript store, admission queue,
//! retry timer, or implicit terminal creation lives here.
const std = @import("std");
const vaxis = @import("vaxis");
const fw = vaxis.vxfw;
const Native = @import("native.zig");
const Bridge = @import("tui_bridge.zig");
const Editor = @import("tui_editor.zig");
const ExternalEditor = @import("tui_external_editor.zig");
const wire = @import("generated/contracts.zig");
const TerminalStatus = @import("tui_status.zig");
const Theme = @import("tui_theme.zig");
const Markdown = @import("tui_markdown.zig");
const Filter = @import("tui_filter.zig");
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
    \\Ctrl-U/D, Ctrl-B/F    half / full page (Normal mode)
    \\Mouse drag           terminal selection; use terminal Copy/Paste
    \\:mouse-toggle        opt into wheel reporting (Shift-drag to select)
    \\:older, :latest       bounded canonical history pages
    \\
    \\Prompt i a I A o O    enter Insert mode; Esc returns to Normal
    \\h j k l, w b e W B E  grapheme / line / word motions
    \\0 ^ $ gg G            line / buffer motions; numeric counts
    \\d c y + motion        delete / change / yank; dd cc yy
    \\x X D C Y r, p P      edits / replace / internal-register paste
    \\v                     edit prompt in $EDITOR (Normal mode)
    \\V, u, Ctrl-R          linewise visual selection, undo / redo
    \\Space t / m / n       tasks / models / new task (Normal mode)
    \\Enter                 send; Shift-Enter (or Insert Ctrl-J) newline
    \\:sidebar-toggle       override responsive right sidebar visibility
    \\:tools                full tool inventory; j/k, PgUp/PgDn, g/G, Esc
    \\
    \\:new                  hub only: JSON task-brief composer (Ctrl-S creates)
    \\:hosts                registered hosts; Enter selects host for new task
    \\:brief                inspect saved creation brief (read only)
    \\:cancel               clear an unsubmitted task form, not admitted work
    \\:tasks                hub only: inspect tasks read-only
    \\:task TITLE           hub only: create task and open Rex
    \\:task-at JSON         hub only: {machineId,cwd,title} target
    \\:select ID :hub       hub only: inspect task / return to hub
    \\Task clients are Rex-bound and locked; use :rex open to participate.
    \\:rex                  selected task Rex status; i inspect, o open
    \\:rex open             explicit best-effort open; no automatic retry
    \\:model                type to filter; arrows/Ctrl-N/P, Enter, Esc
    \\Picker Ctrl-U         clear query; task Ctrl-F/R next/first page
    \\Shift-Tab             cycle supported thinking levels (idle chat)
    \\Ctrl-S or :send       explicitly submit (steer); save before send
    \\:retry / :discard     resolve saved input; no automatic replay
    \\:stop                 explicit stop request, not effect drainage
    \\:q or Ctrl-C          detach, never stop; :q! drops unsent text
    \\:help or F1           this help; Esc closes
    \\
    \\Saved requests are locked; retry uses original bytes, not preview.
    \\Starts in Insert mode; Esc then : enters a footer command.
    \\Unsubmitted text stays local. $EDITOR uses a temporary private file.
    \\:q protects unsent text; editor failure preserves it.
    \\Switching refuses unsent text or unresolved requests; nothing is lost.
    \\Markdown chat, bounded task pages, 16 KiB prompt, 32 undo steps.
    \\No macros, dot-repeat, text objects or clipboard reads.
;
const base = Theme.base;
const dim = Theme.dim;
const accent = Theme.green;
const bar = Theme.dim;
const hub_bar = bar;
pub const Row = struct { text: []const u8 = "", style: vaxis.Style = base, offset: usize = 0, cells: ?Markdown.Line = null, speaker: ?[]const u8 = null, speaker_style: vaxis.Style = dim, user: bool = false };

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
        if (cp < 32 or (cp >= 127 and cp <= 159) or cp == 0x061c or cp == 0x200b or cp == 0x200e or cp == 0x200f or (cp >= 0x2028 and cp <= 0x202e) or (cp >= 0x2060 and cp <= 0x206f) or cp == 0xfeff) return "�";
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
pub fn displayWidth(ctx: fw.DrawContext, text: []const u8) usize {
    var it = vaxis.unicode.graphemeIterator(text);
    var width: usize = 0;
    while (it.next()) |g| width += glyph(ctx, g.bytes(text)).width;
    return width;
}
pub fn rows(ctx: fw.DrawContext, list: *std.ArrayList(Row), text: []const u8, width: u16, style: vaxis.Style) !void {
    // Soft-wrap at whitespace without inserting/removing a single source byte.
    // Keep byte offsets, including trailing spaces, for cursor/visual selection.
    var start: usize = 0;
    while (true) {
        var it = vaxis.unicode.graphemeIterator(text[start..]);
        var col: usize = 0;
        var boundary: ?usize = null;
        var end = text.len;
        var next: ?usize = null;
        while (it.next()) |g| {
            const chunk = g.bytes(text[start..]);
            const at = start + g.start;
            if (std.mem.eql(u8, chunk, "\n")) {
                end = at;
                next = at + g.len;
                break;
            }
            const columns = glyph(ctx, chunk).width;
            if (col + columns > width and col > 0) {
                end = boundary orelse at;
                next = end;
                break;
            }
            col += columns;
            if (std.mem.eql(u8, chunk, " ") or std.mem.eql(u8, chunk, "\t")) boundary = at + g.len;
        }
        try list.append(ctx.arena, .{ .text = text[start..end], .style = style, .offset = start });
        start = next orelse break;
    }
}
pub fn line(ctx: fw.DrawContext, surface: fw.Surface, x: u16, y: u16, text: []const u8, style: vaxis.Style, selection_range: ?[2]usize, offset: usize) void {
    lineLimit(ctx, surface, x, y, text, style, selection_range, offset, surface.size.width);
}
fn lineLimit(ctx: fw.DrawContext, surface: fw.Surface, x: u16, y: u16, text: []const u8, style: vaxis.Style, selection_range: ?[2]usize, offset: usize, right: u16) void {
    var it = vaxis.unicode.graphemeIterator(text);
    var col = x;
    while (it.next()) |g| {
        const displayed = glyph(ctx, g.bytes(text));
        const chunk = displayed.text;
        const width = displayed.width;
        if (@as(usize, col) + width > @min(right, surface.size.width)) break;
        var s = style;
        if (selection_range) |range| if (offset + g.start >= range[0] and offset + g.start < range[1]) {
            s.reverse = true;
        };
        surface.writeCell(col, y, .{ .char = .{ .grapheme = chunk, .width = width }, .style = s });
        col += width;
    }
}
fn isBash(part: wire.TuiPart) bool {
    return std.mem.eql(u8, part.toolName orelse "", "bash");
}
fn toolPartRows(ctx: fw.DrawContext, list: *std.ArrayList(Row), part: wire.TuiPart, width: u16, count: usize) !void {
    const name = part.toolName orelse "tool";
    const repeat = if (count > 1) try std.fmt.allocPrint(ctx.arena, " (×{d})", .{count}) else "";
    try rows(ctx, list, try std.fmt.allocPrint(ctx.arena, "{s}{s}{s}", .{ name, repeat, if (part.isError orelse false) " (error)" else "" }), width, dim);
    if (part.text.len == 0) return;
    var output: std.ArrayList(Row) = .empty;
    try rows(ctx, &output, part.text, width, dim);
    // A terminal newline ends the last line, not a ninth blank line.
    if (output.items.len > 1 and output.items[output.items.len - 1].text.len == 0) _ = output.pop();
    if (isBash(part)) {
        // The bridge preserves the UTF-8 tail even for byte-clipped results.
        // Count visual rows AFTER wrapping so narrow panes still show <= 8.
        try list.appendSlice(ctx.arena, output.items[output.items.len -| 8..]);
    } else {
        try list.appendSlice(ctx.arena, output.items[0..@min(8, output.items.len)]);
        if (output.items.len > 8) try rows(ctx, list, "[output truncated after 8 lines; full output retained in history]", width, dim) else if (part.clipped orelse false) try rows(ctx, list, "[view clipped; full output retained in history]", width, dim);
    }
}
fn legacyTool(text: []const u8) wire.TuiPart {
    const split = std.mem.indexOfScalar(u8, text, '\n') orelse text.len;
    const header = text[0..split];
    const failed = std.mem.endsWith(u8, header, " (error)");
    return .{ .kind = .tool, .toolName = if (failed) header[0 .. header.len - " (error)".len] else header, .isError = failed, .text = if (split < text.len) text[split + 1 ..] else "" };
}
fn toolRows(ctx: fw.DrawContext, list: *std.ArrayList(Row), text: []const u8, width: u16) !void {
    try toolPartRows(ctx, list, legacyTool(text), width, 1);
}
fn thinkingRows(ctx: fw.DrawContext, list: *std.ArrayList(Row), tokens: i64, width: u16) !void {
    if (tokens > 0) try rows(ctx, list, try std.fmt.allocPrint(ctx.arena, "[thinking: {d} tokens]", .{tokens}), width, dim);
}
// Only explicitly typed bash requests / hidden-only assistant entries are
// transparent to a bash run. Actual text, notices and other tools are barriers.
fn bashRequests(entry: wire.TuiEntry) bool {
    if (entry.role != .assistant) return false;
    const parts = entry.parts orelse return false;
    for (parts) |part| {
        if (part.kind == .text and part.text.len == 0) continue;
        if (part.kind != .tool_request or !isBash(part)) return false;
    }
    return true;
}
const BashRun = struct {
    count: usize = 0,
    latest: ?wire.TuiPart = null,
    thinking: i64 = 0,
    requests: std.ArrayList(wire.TuiPart) = .empty,
    fn add(self: *BashRun, part: wire.TuiPart) void {
        self.count += 1;
        self.latest = part;
        self.requests.clearRetainingCapacity();
    }
    fn flush(self: *BashRun, ctx: fw.DrawContext, list: *std.ArrayList(Row), width: u16, assistant: []const u8) !void {
        const first = list.items.len;
        if (self.latest) |part| {
            try toolPartRows(ctx, list, part, width, self.count);
            list.items[first].speaker = "·";
        }
        // A request AFTER the latest completed result is still pending: don't
        // hide it or count it as an output. Requests consumed by results vanish.
        for (self.requests.items) |part| try rows(ctx, list, part.text, width, dim);
        try thinkingRows(ctx, list, self.thinking, width);
        if (list.items.len > first) {
            if (self.latest == null) list.items[first].speaker = assistant;
            try list.append(ctx.arena, .{});
        }
        self.count = 0;
        self.latest = null;
        self.thinking = 0;
        self.requests.clearRetainingCapacity();
    }
};
fn messageRows(ctx: fw.DrawContext, chat: *std.ArrayList(Row), entry: wire.TuiEntry, width: u16, assistant: []const u8) !void {
    const user = entry.role == .user;
    if (user) {
        if (chat.items.len == 0) try chat.append(ctx.arena, .{});
        try chat.append(ctx.arena, .{ .user = true });
    }
    const first = chat.items.len;
    if (entry.parts) |parts| {
        var index: usize = 0;
        while (index < parts.len) {
            const part = parts[index];
            index += 1;
            switch (part.kind) {
                .notice, .tool_request => try rows(ctx, chat, part.text, width, dim),
                .tool => try toolPartRows(ctx, chat, part, width, 1),
                .text => {
                    // Adjacent text blocks form one Markdown document (fences
                    // and tables may span blocks). Notices never enter Markdown.
                    var text: std.ArrayList(u8) = .empty;
                    try text.appendSlice(ctx.arena, part.text);
                    while (index < parts.len and parts[index].kind == .text) : (index += 1) {
                        try text.append(ctx.arena, '\n');
                        try text.appendSlice(ctx.arena, parts[index].text);
                    }
                    if (text.items.len > 0) for (try Markdown.render(ctx, text.items, width, base)) |cells| try chat.append(ctx.arena, .{ .cells = cells });
                },
            }
        }
    } else if (entry.role == .assistant or user) {
        for (try Markdown.render(ctx, entry.text, width, base)) |cells| try chat.append(ctx.arena, .{ .cells = cells });
    } else if (entry.role == .tool) try toolRows(ctx, chat, entry.text, width) else try rows(ctx, chat, entry.text, width, dim);
    if (entry.role == .assistant) try thinkingRows(ctx, chat, entry.thinkingTokens orelse 0, width);
    if (chat.items.len == first) {
        if (!user) return; // Hidden/non-text-only entries produce no filler.
        try chat.append(ctx.arena, .{});
    }
    for (chat.items[first..]) |*row| row.user = user;
    chat.items[first].speaker = if (user) "•" else if (entry.role == .assistant) assistant else "·";
    chat.items[first].speaker_style = if (user) accent else dim;
    try chat.append(ctx.arena, .{ .user = user });
    if (user) try chat.append(ctx.arena, .{});
}
fn chatRows(ctx: fw.DrawContext, chat: *std.ArrayList(Row), entries: []const wire.TuiEntry, width: u16, assistant: []const u8) !void {
    var bash: BashRun = .{};
    for (entries) |entry| {
        if (bashRequests(entry)) {
            for (entry.parts.?) |part| if (part.kind == .tool_request) try bash.requests.append(ctx.arena, part);
            bash.thinking += entry.thinkingTokens orelse 0;
            continue;
        }
        if (entry.role == .tool) {
            const legacy = [_]wire.TuiPart{legacyTool(entry.text)};
            for (entry.parts orelse &legacy) |part| {
                if (part.kind == .tool and isBash(part)) {
                    bash.add(part);
                } else {
                    try bash.flush(ctx, chat, width, assistant);
                    try messageRows(ctx, chat, .{ .id = entry.id, .role = .tool, .text = "", .parts = &.{part} }, width, assistant);
                }
            }
        } else {
            try bash.flush(ctx, chat, width, assistant);
            try messageRows(ctx, chat, entry, width, assistant);
        }
    }
    try bash.flush(ctx, chat, width, assistant);
}
fn shortDirectory(a: std.mem.Allocator, directory: []const u8, home: ?[]const u8) ![]const u8 {
    if (home) |prefix| if (prefix.len > 0 and std.mem.startsWith(u8, directory, prefix) and (directory.len == prefix.len or directory[prefix.len] == '/')) return std.fmt.allocPrint(a, "~{s}", .{directory[prefix.len..]});
    return directory;
}
fn tailColumns(ctx: fw.DrawContext, text: []const u8, width: u16) ![]const u8 {
    var remaining = displayWidth(ctx, text);
    if (remaining <= width) return text;
    var it = vaxis.unicode.graphemeIterator(text);
    var start: usize = 0;
    while (remaining + 1 > width) {
        const g = it.next() orelse break;
        start = g.start + g.len;
        remaining -= glyph(ctx, g.bytes(text)).width;
    }
    return std.fmt.allocPrint(ctx.arena, "…{s}", .{text[start..]});
}
// Presentation order only. Wire pages/cursors retain canonical ascending IDs.
fn taskRoot(page: wire.TuiTasks, index: usize) u64 {
    var current = page.items[index];
    for (0..25) |_| {
        const parent = current.parentChatId orelse return std.fmt.parseInt(u64, current.chatId, 10) catch 0;
        var found = false;
        for (page.items) |row| if (std.mem.eql(u8, row.chatId, parent)) {
            current = row;
            found = true;
            break;
        };
        if (!found) return std.fmt.parseInt(u64, parent, 10) catch 0;
    }
    return 0; // The ingress guard refuses cyclic/non-ancestral parent IDs.
}
fn taskOrder(page: wire.TuiTasks) [25]usize {
    var order: [25]usize = undefined;
    for (0..page.items.len) |i| {
        order[i] = i;
        var j = i;
        while (j > 0 and taskRoot(page, order[j - 1]) > taskRoot(page, order[j])) : (j -= 1) std.mem.swap(usize, &order[j - 1], &order[j]);
    }
    return order;
}
test "task display groups children without changing the canonical page or IDs" {
    const page: wire.TuiTasks = .{ .items = &.{
        .{ .chatId = "1", .kind = .main, .title = "Hub", .machineId = "a", .cwd = "/" },
        .{ .chatId = "3", .kind = .task, .title = "Task", .machineId = "b", .cwd = "/remote" },
        .{ .chatId = "7", .kind = .subagent, .title = "Child", .machineId = "a", .cwd = "/", .parentChatId = "1" },
        .{ .chatId = "9", .kind = .subagent, .title = "Other page parent", .machineId = "c", .cwd = "/", .parentChatId = "2" },
    }, .next = "10" };
    const order = taskOrder(page);
    try std.testing.expectEqualSlices(usize, &.{ 0, 2, 3, 1 }, order[0..4]);
    try std.testing.expectEqualStrings("3", page.items[1].chatId);
    try std.testing.expectEqualStrings("10", page.next.?);
}
// Compact sidebar and expanded inventory share one projection. Compact rows
// never claim clipped data is complete: the sidebar links to the scrollable view.
fn inventoryRows(ctx: fw.DrawContext, list: *std.ArrayList(Row), snapshot: ?wire.TuiSnapshot, width: u16, compact: bool) !void {
    const inventory = if (snapshot) |s| s.toolInventory else null;
    const inv = inventory orelse {
        const unsupported = if (snapshot) |s| s.toolInventoryStatus == .unsupported else false;
        try rows(ctx, list, if (unsupported) "Inventory unsupported by hub" else "Inventory unavailable", width, Theme.orange);
        try rows(ctx, list, "Unknown, not an empty tool list.", width, dim);
        return;
    };
    if (!compact) {
        try rows(ctx, list, "Execution location: hub = central Deck host; worker local = this chat's assigned machine, not necessarily this terminal.", width, dim);
        if (inv.hubMachineId) |id| try rows(ctx, list, try std.fmt.allocPrint(ctx.arena, "Hub machine: {s}", .{id}), width, dim);
        if (inv.workerMachineId) |id| try rows(ctx, list, try std.fmt.allocPrint(ctx.arena, "Assigned machine: {s}", .{id}), width, dim);
        try list.append(ctx.arena, .{});
    }
    if (inv.mcp.len == 0) {
        try rows(ctx, list, "MCP SERVERS", width, accent);
        try rows(ctx, list, "No profiles for this chat", width, dim);
        try list.append(ctx.arena, .{});
    }
    for ([_]@FieldType(wire.InventoryMcpProfile, "location"){ .hub, .worker }) |location| {
        var count: usize = 0;
        for (inv.mcp) |profile| if (profile.location == location) {
            count += 1;
        };
        if (count == 0) continue;
        try rows(ctx, list, if (location == .hub) "MCP · HUB" else "MCP · WORKER LOCAL", width, accent);
        for ([_]@FieldType(wire.InventoryMcpProfile, "state"){ .enabled, .not_granted, .unavailable }) |state| {
            for (inv.mcp) |profile| {
                if (profile.location != location or profile.state != state) continue;
                const style = switch (state) {
                    .enabled => base,
                    .not_granted => dim,
                    .unavailable => Theme.orange,
                };
                const label = switch (state) {
                    .enabled => "enabled",
                    .not_granted => "not granted",
                    .unavailable => "unavailable",
                };
                const symbol = switch (state) {
                    .enabled => "●",
                    .not_granted => "○",
                    .unavailable => "!",
                };
                const summary = if (state == .unavailable)
                    try std.fmt.allocPrint(ctx.arena, "{s} {s} · {s}", .{ symbol, profile.profileId, label })
                else
                    try std.fmt.allocPrint(ctx.arena, "{s} {s} · {s} ({d})", .{ symbol, profile.profileId, label, profile.tools.len });
                try rows(ctx, list, summary, width, style);
                if (!compact) {
                    try rows(ctx, list, try std.fmt.allocPrint(ctx.arena, "  Host {s} · workspace {s}", .{ profile.machineId, if (profile.workspace) |workspace| @tagName(workspace) else "unknown" }), width, dim);
                    try rows(ctx, list, try std.fmt.allocPrint(ctx.arena, "  Revision {s}", .{profile.revision}), width, dim);
                    for (profile.tools) |tool| {
                        try rows(ctx, list, try std.fmt.allocPrint(ctx.arena, "  {s}", .{tool.name}), width, style);
                        try rows(ctx, list, try std.fmt.allocPrint(ctx.arena, "    {s}", .{tool.alias}), width, dim);
                    }
                    try list.append(ctx.arena, .{});
                }
            }
        }
        if (compact) try list.append(ctx.arena, .{});
    }
    for ([_]@FieldType(wire.InventoryBuiltin, "location"){ .worker, .hub, .environment }) |location| {
        var names: std.ArrayList(u8) = .empty;
        for (inv.builtins) |tool| {
            if (tool.location != location) continue;
            if (names.items.len > 0) try names.appendSlice(ctx.arena, " · ");
            try names.appendSlice(ctx.arena, tool.name);
        }
        if (names.items.len == 0) continue;
        try rows(ctx, list, switch (location) {
            .worker => "BUILT-IN · WORKER LOCAL",
            .hub => "BUILT-IN · HUB",
            .environment => "ENVIRONMENT TOOLS",
        }, width, accent);
        try rows(ctx, list, names.items, width, base);
        try list.append(ctx.arena, .{});
    }
    if (inv.builtins.len == 0) try rows(ctx, list, "No non-MCP model tools", width, dim);
    try rows(ctx, list, if (compact) "Enabled ≠ health checked" else "Not granted = approved candidate, NOT exposed to this model. Unavailable = missing or incompatible grant/catalog/model surface. Enabled does not prove server or worker health.", width, dim);
    try rows(ctx, list, if (compact) "Shell also exposes host commands." else "MCP is not the whole tool surface. File/shell and hub coordination tools above are separate. When bash or another execution tool is offered, host programs (e.g. git, compilers, tests) are accessible through it subject to that host's permissions and installed software; these are not separate MCP servers or an enumerated command allowlist.", width, dim);
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
    leader: bool = false,
    external_edit: bool = false,
    model_picker: bool = false,
    model_index: usize = 0,
    filter: Filter = .{},
    mouse_tracking: bool = false,
    home: ?[]const u8 = null,
    task_picker: bool = false,
    task_index: usize = 0,
    hosts_view: bool = false,
    host_index: usize = 0,
    brief_view: bool = false,
    tools_view: bool = false,
    tools_scroll: usize = 0,
    tools_max: usize = 0,
    tools_height: usize = 10,
    task_form: bool = false,
    rex_view: bool = false,
    settings_uncertain: bool = false,
    paste_mode: bool = false,
    filter_paste: bool = false,
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
    frame: u64 = 0,
    name_started: ?u64 = null,
    busy_started: ?u64 = null,
    activity_seen: u64 = 0,
    sidebar_override: ?bool = null,
    sidebar_visible: bool = false,
    pending_since: std.Io.Timestamp = .zero,
    shown_transport: TransportStatus = .quiet,
    uncertain: bool = false,
    online: bool = false,
    notice: [1024]u8 = undefined,
    notice_len: usize = 0,
    fn animation(self: *Model) ?u64 {
        if (self.name_started) |start| if (self.frame - start < 18) return self.frame - start;
        if (self.online and self.frame - self.activity_seen < 100) if (self.busy_started) |start| {
            const phase = (self.frame - start) % 160;
            if (phase < 18) return phase;
        };
        return null;
    }
    fn rune(s: wire.TuiSnapshot) []const u8 {
        if (std.mem.eql(u8, s.chatId, s.hubChatId)) return "Δ";
        const value = s.agentRune orelse return "·";
        return if (std.mem.eql(u8, value, "Δ")) "·" else value;
    }
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
    fn readOnly(self: *Model) bool {
        return if (self.state()) |s| s.clientMode == .hub and !std.mem.eql(u8, s.chatId, s.hubChatId) else false;
    }
    fn canWrite(self: *Model) bool {
        if (!self.readOnly()) return true;
        self.note("Read-only task inspection. :rex open to participate in its Rex session.");
        return false;
    }
    fn canList(self: *Model) bool {
        if (self.bridge.client_mode != .task) return true;
        self.note("Rex task client locked to this task. Use the hub TUI for other tasks.");
        return false;
    }
    fn settings(self: *Model) ?wire.ModelSettingsSnapshot {
        return if (self.state()) |s| s.modelSettings else null;
    }
    fn matches(self: *Model) Filter.Matches {
        var result: Filter.Matches = .{};
        const s = self.state() orelse return result;
        var buffer: [8192]u8 = undefined;
        if (self.task_picker) {
            if (s.tasks) |page| for (taskOrder(page)[0..page.items.len]) |index| {
                const item = page.items[index];
                const label = std.fmt.bufPrint(&buffer, "{s} {s} {s} {s} {s}", .{ item.agentName orelse "", item.title, item.chatId, item.machineId, item.cwd }) catch continue;
                result.add(self.filter, label, index);
            };
        } else if (self.hosts_view) {
            if (s.hosts) |hosts| for (hosts.items, 0..) |item, index| {
                const label = std.fmt.bufPrint(&buffer, "{s} {s} {s}", .{ item.machineId, @tagName(item.kind), @tagName(item.connection) }) catch continue;
                result.add(self.filter, label, index);
            };
        } else if (self.settings()) |settings_value| for (settings_value.models, 0..) |item, index| {
            const label = std.fmt.bufPrint(&buffer, "{s}/{s} {s}", .{ item.provider, item.modelId, item.name }) catch continue;
            result.add(self.filter, label, index);
        };
        return result;
    }
    fn filterKey(self: *Model, key: vaxis.Key, index: *usize) void {
        const count = self.matches().len;
        if (key.matches(vaxis.Key.down, .{}) or key.matches('n', .{ .ctrl = true })) index.* = @min(count -| 1, index.* + 1) else if (key.matches(vaxis.Key.up, .{}) or key.matches('p', .{ .ctrl = true })) index.* -|= 1 else if (self.filter.key(key)) index.* = 0;
    }
    fn configure(self: *Model, selection: wire.ModelSelection) !void {
        if (!self.canWrite()) return;
        const current = self.settings() orelse {
            self.note("Model settings unavailable; open :model (requires an updated hub).");
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
        if (!self.canWrite()) return;
        const current = self.settings() orelse {
            self.note("Open :model to read available settings first.");
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
        self.note("Selected model no longer in the hub catalog; choose :model.");
    }
    fn canNavigate(self: *Model) bool {
        if (!self.canList()) return false;
        if (self.locked() or (self.settings_uncertain and !self.readOnly())) {
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
        if (!self.canList()) return;
        if (try self.bridge.tasks(after)) self.pending_since = std.Io.Timestamp.now(self.bridge.io, .awake) else self.note("Client request in flight; task read not queued.");
    }
    fn beginTaskForm(self: *Model, machine: ?[]const u8) !void {
        if (!self.canNavigate()) return;
        if (self.readOnly()) {
            self.note("Return to :hub to create a task.");
            return;
        }
        if (self.bridge.pending != null) {
            self.note("Client request in flight; creation composer not queued.");
            return;
        }
        if (machine) |id| {
            const text = try std.fmt.allocPrint(self.a, "{{\"title\":\"\",\"machineId\":\"{s}\",\"cwd\":\"\",\"problem\":\"\",\"description\":\"\"}}", .{id});
            defer self.a.free(text);
            try self.editor.set(text);
        }
        self.hosts_view = false;
        self.task_form = true;
        self.focus = .prompt;
        self.note("Paste JSON {title,problem?,description?,machineId?,cwd?}. Ctrl-S creates; :cancel clears. No input/generation.");
    }
    fn submitTaskForm(self: *Model) !void {
        if (!self.canWrite() or !self.canList() or self.locked() or self.settings_uncertain) {
            self.note("Resolve saved requests/settings before creating.");
            return;
        }
        const raw = std.json.parseFromSlice(std.json.Value, self.a, self.editor.text.items, .{}) catch {
            self.note("Invalid task JSON; composer unchanged.");
            return;
        };
        defer raw.deinit();
        if (!@import("task_brief.zig").form(raw.value)) {
            self.note("Use title <=200, problem <=2048, description <=8192 bytes; host/cwd together. Composer unchanged.");
            return;
        }
        const form = try wire.parseTaskCreationForm(self.a, self.editor.text.items);
        defer form.deinit();
        if (try self.bridge.createForm(form.value)) self.pending_since = std.Io.Timestamp.now(self.bridge.io, .awake) else self.note("Client request in flight; creation not queued.");
    }
    fn createAt(self: *Model, json: []const u8) !void {
        if (!self.canNavigate()) return;
        const raw = std.json.parseFromSlice(std.json.Value, self.a, json, .{}) catch {
            self.note("Invalid :task-at JSON: use {machineId,cwd,title}.");
            return;
        };
        defer raw.deinit();
        if (!Bridge.validTaskTarget(raw.value)) {
            self.note("Invalid task target: full machine ID, absolute cwd, title up to 200 bytes required.");
            return;
        }
        const target = try wire.parseTaskCreationTarget(self.a, json);
        defer target.deinit();
        try self.createTask(target.value.title, target.value);
    }
    fn createTask(self: *Model, title: []const u8, target: ?wire.TaskCreationTarget) !void {
        if (!self.canNavigate()) return;
        if (self.readOnly()) {
            self.note("Return to :hub to create and open a Rex task.");
            return;
        }
        if (title.len == 0 or title.len > 200) {
            self.note("Task title must be 1 to 200 UTF-8 bytes.");
            return;
        }
        const started = if (target) |t| try self.bridge.createAt(t) else try self.bridge.request(.create, title, null);
        if (started) self.pending_since = std.Io.Timestamp.now(self.bridge.io, .awake) else self.note("Client request in flight; task creation not queued.");
    }
    fn issue(self: *Model, action: Action) !void {
        if (action == .hosts and !self.canList()) return;
        if (action == .send and self.task_form) return self.submitTaskForm();
        if ((action == .send or action == .retry or action == .discard or action == .stop or action == .configure) and !self.canWrite()) return;
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
        const saved = if (self.state()) |s| (if (s.draft) |draft| draft.saved and (draft.kind == .input or (self.task_form and draft.kind == .task)) else false) else false;
        if (!force and self.editor.text.items.len > 0 and !saved) {
            self.note("Prompt has no confirmed saved draft. :send / :retry, or :q! to detach without it.");
            return;
        }
        ctx.quit = true;
    }
    fn ex(self: *Model, ctx: *fw.EventContext) !void {
        const cmd = self.command.items;
        if (std.mem.eql(u8, cmd, "sidebar-toggle")) {
            self.sidebar_override = !self.sidebar_visible;
        } else if (std.mem.eql(u8, cmd, "tools")) {
            self.tools_view = true;
            self.tools_scroll = 0;
        } else if (std.mem.eql(u8, cmd, "new")) try self.beginTaskForm(null) else if (std.mem.eql(u8, cmd, "hosts")) try self.issue(.hosts) else if (std.mem.eql(u8, cmd, "brief")) {
            self.brief_view = true;
            self.help_scroll = 0;
        } else if (std.mem.eql(u8, cmd, "cancel") and self.task_form) {
            if (self.locked() or self.bridge.pending != null) self.note("Resolve the creation request with :retry or :discard first.") else {
                try self.editor.set("");
                self.task_form = false;
                self.note("Unsubmitted task form cleared; no task requested.");
            }
        } else if (std.mem.eql(u8, cmd, "mouse-toggle")) {
            self.mouse_tracking = !self.mouse_tracking;
            if (self.terminal_status) |status| try status.vx.setMouseMode(status.writer, self.mouse_tracking);
            self.note(if (self.mouse_tracking) "Mouse wheel reporting enabled; use terminal selection override (usually Shift-drag) to copy." else "Terminal mouse selection enabled; drag and use your terminal's Copy action. Ctrl-U/D scrolls history.");
        } else if (std.mem.eql(u8, cmd, "tasks")) try self.taskPage(null) else if (std.mem.startsWith(u8, cmd, "task-at ")) try self.createAt(cmd[8..]) else if (std.mem.startsWith(u8, cmd, "task ")) try self.createTask(std.mem.trim(u8, cmd[5..], " "), null) else if (std.mem.startsWith(u8, cmd, "select ")) {
            const id = std.mem.trim(u8, cmd[7..], " ");
            const n = std.fmt.parseInt(u64, id, 10) catch 0;
            if (n == 0 or n > 9007199254740991 or id[0] == '0' or !std.ascii.isDigit(id[0])) self.note("Use :select with a positive chat ID from :tasks.") else try self.selectChat(id);
        } else if (std.mem.eql(u8, cmd, "hub") or std.mem.eql(u8, cmd, "main")) {
            if (self.state()) |s| try self.selectChat(s.hubChatId);
        } else if (std.mem.eql(u8, cmd, "rex") or std.mem.eql(u8, cmd, "rex status")) try self.issue(.rexStatus) else if (std.mem.eql(u8, cmd, "rex inspect")) try self.issue(.rexInspect) else if (std.mem.eql(u8, cmd, "rex open") or std.mem.eql(u8, cmd, "rex reopen")) try self.issue(.rexOpen) else if (std.mem.eql(u8, cmd, "model")) try self.issue(.models) else if (std.mem.eql(u8, cmd, "q") or std.mem.eql(u8, cmd, "quit")) self.quit(ctx, false) else if (std.mem.eql(u8, cmd, "q!")) self.quit(ctx, true) else if (std.mem.eql(u8, cmd, "help")) self.help_visible = true else {
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
                const existing = if (self.filter_paste) self.filter.len else self.editor.text.items.len;
                const limit: usize = if (self.filter_paste) 256 else Editor.limit;
                if (self.paste_buffer.items.len + text.len + existing > limit) self.paste_overflow = true else try self.paste_buffer.appendSlice(self.a, text);
            }
            return;
        }
        if (key.matches('c', .{ .ctrl = true })) {
            self.quit(ctx, false);
            return;
        }
        if (self.tools_view) {
            if (key.matches(vaxis.Key.escape, .{}) or key.matches('q', .{})) self.tools_view = false else if (key.matches('j', .{}) or key.matches(vaxis.Key.down, .{})) self.tools_scroll = @min(self.tools_max, self.tools_scroll + 1) else if (key.matches('k', .{}) or key.matches(vaxis.Key.up, .{})) self.tools_scroll -|= 1 else if (key.matches(vaxis.Key.page_down, .{}) or key.matches('d', .{ .ctrl = true }) or key.matches('f', .{ .ctrl = true })) self.tools_scroll = @min(self.tools_max, self.tools_scroll + (if (key.matches('d', .{ .ctrl = true })) @max(1, self.tools_height / 2) else self.tools_height)) else if (key.matches(vaxis.Key.page_up, .{}) or key.matches('u', .{ .ctrl = true }) or key.matches('b', .{ .ctrl = true })) self.tools_scroll -|= (if (key.matches('u', .{ .ctrl = true })) @max(1, self.tools_height / 2) else self.tools_height) else if (key.matches('g', .{})) self.tools_scroll = 0 else if (key.matches('G', .{})) self.tools_scroll = self.tools_max;
            return;
        }
        if (self.brief_view) {
            if (key.matches(vaxis.Key.escape, .{}) or key.matches('q', .{})) self.brief_view = false else if (key.matches('j', .{}) or key.matches(vaxis.Key.down, .{})) self.help_scroll = @min(self.help_max, self.help_scroll + 1) else if (key.matches('k', .{}) or key.matches(vaxis.Key.up, .{})) self.help_scroll -|= 1;
            return;
        }
        if (self.hosts_view) {
            if (key.matches(vaxis.Key.escape, .{})) {
                self.hosts_view = false;
                return;
            }
            const hosts = if (self.state()) |s| s.hosts orelse return else return;
            if (key.matches('r', .{ .ctrl = true })) try self.issue(.hosts) else if (key.matches(vaxis.Key.enter, .{})) {
                if (self.matches().raw(self.host_index)) |raw| try self.beginTaskForm(hosts.items[raw].machineId);
            } else self.filterKey(key, &self.host_index);
            return;
        }
        if (self.task_picker) {
            if (key.matches(vaxis.Key.escape, .{})) {
                self.task_picker = false;
                return;
            }
            const page = if (self.state()) |s| s.tasks orelse return else return;
            if (key.matches('f', .{ .ctrl = true })) {
                if (page.next) |next| try self.taskPage(next);
            } else if (key.matches('r', .{ .ctrl = true })) try self.taskPage(null) else if (key.matches(vaxis.Key.enter, .{})) {
                if (self.matches().raw(self.task_index)) |raw| try self.selectChat(page.items[raw].chatId);
            } else self.filterKey(key, &self.task_index);
            return;
        }
        if (self.rex_view) {
            if (key.matches(vaxis.Key.escape, .{}) or key.matches('q', .{})) self.rex_view = false else if (key.matches('s', .{})) try self.issue(.rexStatus) else if (key.matches('i', .{})) try self.issue(.rexInspect) else if (key.matches('o', .{})) try self.issue(.rexOpen);
            return;
        }
        if (self.model_picker) {
            if (key.matches(vaxis.Key.escape, .{})) {
                self.model_picker = false;
                return;
            }
            const current = self.settings() orelse return;
            if (key.matches(vaxis.Key.enter, .{})) {
                const raw = self.matches().raw(self.model_index) orelse return;
                const model = current.models[raw];
                var level = model.defaultThinkingLevel;
                for (model.thinkingLevels) |supported| if (supported == current.selection.thinkingLevel) {
                    level = supported;
                    break;
                };
                try self.configure(.{ .provider = model.provider, .modelId = model.modelId, .thinkingLevel = level });
            } else self.filterKey(key, &self.model_index);
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
        const normal = self.focus == .chat or self.editor.mode != .insert or self.locked() or self.readOnly();
        if (normal and self.leader) {
            self.leader = false;
            if (key.matches('t', .{})) try self.taskPage(null) else if (key.matches('m', .{})) try self.issue(.models) else if (key.matches('n', .{})) try self.beginTaskForm(null);
            return;
        }
        if (key.matches(vaxis.Key.enter, .{ .shift = true }) and self.focus == .prompt) {
            if (!self.locked() and !self.readOnly()) {
                self.editor.mode = .insert;
                try self.editor.insert("\n");
            }
            return;
        }
        if (key.matches('s', .{ .ctrl = true }) or (self.focus == .prompt and key.matches(vaxis.Key.enter, .{}))) {
            try self.issue(.send);
            return;
        }
        if (normal and key.matches(' ', .{})) {
            self.leader = true;
            return;
        }
        if (normal and key.matches(':', .{})) {
            self.command_mode = true;
            return;
        }
        if (normal and key.matches('v', .{})) {
            if (!self.canWrite()) return;
            if (self.locked() or self.bridge.pending != null) {
                self.note("Editor unavailable while a request is pending or the prompt is locked.");
                return;
            }
            self.external_edit = true;
            ctx.quit = true; // Stop/join terminal input before giving the TTY to $EDITOR.
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
                if (!self.locked() and !self.readOnly()) try self.editor.key(key);
            }
            self.chat_g = false;
            return;
        }
        if (!self.locked() and !self.readOnly()) try self.editor.key(key) else if (key.matches(vaxis.Key.escape, .{})) self.editor.mode = .normal;
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
                // vxfw enables tracking during startup. Release it by default
                // so the terminal owns drag selection and its normal Copy action.
                if (self.terminal_status) |status| try status.vx.setMouseMode(status.writer, self.mouse_tracking);
                try ctx.requestFocus(self.widget());
                try self.issue(.poll);
                try ctx.tick(50, self.widget());
            },
            .tick => {
                const was_animated = self.animation() != null;
                self.frame +|= 1;
                if (was_animated or self.animation() != null) ctx.redraw = true;
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
                        if (self.snapshot == null or action == .select) self.name_started = self.frame;
                        if (action == .poll or action == .latest or action == .select) {
                            self.activity_seen = self.frame;
                            if (s.activityKnown and s.busy) {
                                if (self.busy_started == null) self.busy_started = self.frame;
                            } else self.busy_started = null;
                        }
                        if (self.terminal_status) |status| if (s.cwd) |cwd| try status.identity(rune(s), cwd);
                        if (action == .select) {
                            self.task_picker = false;
                            self.hosts_view = false;
                            self.brief_view = false;
                            self.tools_view = false;
                            self.task_form = false;
                            self.rex_view = false;
                            self.model_picker = false;
                            self.scroll = 0;
                            self.focus = .prompt;
                            self.uncertain = false;
                            self.settings_uncertain = s.settingsPending orelse false;
                            try self.editor.set(if (s.draft) |draft| draft.text else "");
                            if (self.terminal_status) |status| status.presentation = .{};
                        }
                        if (action == .tasks or action == .hosts or action == .models) self.filter.clear();
                        if (action == .tasks) {
                            self.task_picker = true;
                            self.task_index = 0;
                        }
                        if (action == .hosts) {
                            self.hosts_view = true;
                            self.host_index = 0;
                        }
                        if (action == .create) {
                            self.uncertain = false;
                            if (self.task_form) {
                                try self.editor.set("");
                                self.task_form = false;
                            }
                        }
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
                            self.task_form = false;
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
                if (self.ticks % 10 == 0 and self.bridge.pending == null and !self.command_mode and !self.leader and !self.paste_mode and !self.model_picker and !self.task_picker and !self.hosts_view and !self.brief_view and !self.rex_view) {
                    try self.issue(.poll);
                }
                // A slow background read becomes visible even without input or
                // a reply. Fast polling alone doesn't change the footer.
                if (self.transportStatus(std.Io.Timestamp.now(ctx.io, .awake)) != self.shown_transport) ctx.redraw = true;
                try ctx.tick(50, self.widget());
            },
            .key_press => |key| {
                // Give explicit input a quiet interval instead of starting a
                // background poll between the final typed character and Enter.
                // An already-issued request is never cancelled or replayed.
                self.ticks = 0;
                if (self.terminal_status) |status| status.presentation.acknowledge();
                self.press(ctx, key) catch |err| {
                    if (err == error.PromptTooLarge) self.note("Prompt limit: 16 KiB. Paste/edit refused; nothing submitted.") else if (err == error.InvalidUtf8) self.note("Invalid UTF-8 input refused; prompt unchanged.") else return err;
                };
                ctx.consumeAndRedraw();
            },
            .paste_start => {
                if (self.terminal_status) |status| status.presentation.acknowledge();
                self.paste_mode = true;
                self.leader = false;
                self.filter_paste = self.model_picker or self.task_picker or self.hosts_view;
                self.reject_paste = self.command_mode or self.help_visible or self.brief_view or self.tools_view or self.rex_view or (!self.filter_paste and (self.locked() or self.readOnly()));
                self.paste_overflow = false;
                self.paste_buffer.clearRetainingCapacity();
            },
            .paste_end => {
                self.ticks = 0;
                if (self.paste_overflow) self.note(if (self.filter_paste) "Search limit: 256 bytes; paste refused." else "Paste exceeds 16 KiB; entire paste refused, prompt unchanged.") else if (!self.reject_paste and self.filter_paste) {
                    if (self.filter.key(.{ .codepoint = 0, .text = self.paste_buffer.items })) {
                        self.model_index = 0;
                        self.task_index = 0;
                        self.host_index = 0;
                    }
                } else if (!self.reject_paste and !self.locked() and !self.readOnly()) {
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
                if (self.tools_view) {
                    if (mouse.button == .wheel_up) self.tools_scroll -|= 3 else if (mouse.button == .wheel_down) self.tools_scroll = @min(self.tools_max, self.tools_scroll + 3);
                } else if (mouse.button == .wheel_up) self.scroll = @min(self.scroll_max, self.scroll + 3) else if (mouse.button == .wheel_down) self.scroll -|= 3;
                ctx.consumeAndRedraw();
            },
            else => {},
        }
    }
    fn draw(ptr: *anyopaque, ctx: fw.DrawContext) std.mem.Allocator.Error!fw.Surface {
        const self: *Model = @ptrCast(@alignCast(ptr));
        self.shown_transport = self.transportStatus(std.Io.Timestamp.now(self.bridge.io, .awake));
        const w = @min(512, ctx.max.width orelse 80);
        // vxfw Surface multiplies u16 dimensions; stay below 65,536 cells.
        const h = @min(120, ctx.max.height orelse 24);
        var surface = try fw.Surface.init(ctx.arena, self.widget(), .{ .width = w, .height = h });
        @memset(surface.buffer, .{ .style = base });
        if (w == 0 or h == 0) return surface;
        if (w < 20 or h < 9) {
            line(ctx, surface, 0, 0, "Resize to 20 x 9", accent, null, 0);
            return surface;
        }
        const s = self.state();
        const status_bar = if (self.bridge.client_mode == .hub) hub_bar else bar;
        const title = try std.fmt.allocPrint(ctx.arena, " deck / {s} · {s} · chat {s} · {s} [{s}]", .{ if (self.bridge.client_mode == .hub) "hub" else "task / Rex locked", if (s) |v| v.title else "connecting", if (s) |v| v.chatId else "?", if (s) |v| v.model else "", if (self.settings()) |settings_value| @tagName(settings_value.selection.thinkingLevel) else "thinking unavailable" });
        for (0..w) |x| surface.writeCell(@intCast(x), 0, .{ .style = status_bar });
        line(ctx, surface, 0, 0, title, status_bar, null, 0);
        if (self.task_picker) {
            line(ctx, surface, 1, 1, "TASKS · filter this page · samples are not task lifecycle", accent, null, 0);
            line(ctx, surface, 1, 2, try std.fmt.allocPrint(ctx.arena, "Search: {s}", .{self.filter.query()}), base, null, 0);
            if (s) |snap| if (snap.tasks) |page| {
                const count = @as(usize, (h - 6) / 3);
                const start = (self.task_index + 1) -| count;
                const found = self.matches();
                for (found.items[start..@min(found.len, start + count)], start..) |item, index| {
                    const task = page.items[item.index];
                    const parent = if (task.parentChatId) |id| try std.fmt.allocPrint(ctx.arena, " child of {s}", .{id}) else "";
                    const text = try std.fmt.allocPrint(ctx.arena, "{s} {s} [{s}]{s} {s} · {s}", .{ if (index == self.task_index) ">" else " ", task.chatId, if (task.kind == .main) "hub" else @tagName(task.kind), parent, task.agentName orelse "unnamed", task.title });
                    const detail = try std.fmt.allocPrint(ctx.arena, "  saved {s}:{s}", .{ task.machineId, task.cwd });
                    const sample = try std.fmt.allocPrint(ctx.arena, "  link {s} · agent {s} · saved Rex {s}", .{ if (task.connection) |v| @tagName(v) else "unknown", if (task.activity) |v| @tagName(v) else "unknown", task.rexState orelse "unknown" });
                    var style = base;
                    style.reverse = index == self.task_index;
                    line(ctx, surface, 1, @intCast(3 + 3 * (index - start)), text, style, null, 0);
                    line(ctx, surface, 1, @intCast(4 + 3 * (index - start)), detail, dim, null, 0);
                    line(ctx, surface, 1, @intCast(5 + 3 * (index - start)), sample, dim, null, 0);
                }
                if (found.len == 0) line(ctx, surface, 1, 3, "No matches on this page. Ctrl-U clears search.", dim, null, 0);
                line(ctx, surface, 1, h - 3, if (page.next != null) "More pages: Ctrl-F · first page: Ctrl-R" else "Last page · first page: Ctrl-R", dim, null, 0);
            };
            line(ctx, surface, 1, h - 2, self.notice[0..self.notice_len], dim, null, 0);
            line(ctx, surface, 1, h - 1, "Type to filter · arrows/Ctrl-N/P · Enter inspect · Esc close", accent, null, 0);
            return surface;
        }
        if (self.hosts_view) {
            line(ctx, surface, 1, 1, "HOSTS · sampled connection is not readiness", accent, null, 0);
            line(ctx, surface, 1, 2, try std.fmt.allocPrint(ctx.arena, "Search: {s}", .{self.filter.query()}), base, null, 0);
            if (s) |snap| if (snap.hosts) |hosts| {
                const count = @as(usize, h - 7);
                const start = (self.host_index + 1) -| count;
                const found = self.matches();
                if (found.len == 0) line(ctx, surface, 1, 3, "No matches. Ctrl-U clears search.", dim, null, 0);
                for (found.items[start..@min(found.len, start + count)], start..) |item, index| {
                    const host = hosts.items[item.index];
                    const text = try std.fmt.allocPrint(ctx.arena, "{s} {s} · {s} · {s} · Rex {s}", .{ if (index == self.host_index) ">" else " ", host.machineId, @tagName(host.kind), @tagName(host.connection), if (host.rex) "approved" else "not approved" });
                    var style = base;
                    style.reverse = index == self.host_index;
                    line(ctx, surface, 1, @intCast(3 + index - start), text, style, null, 0);
                }
            };
            line(ctx, surface, 1, h - 3, "Sample only; offline tasks stay bound. No fallback or enrollment.", dim, null, 0);
            line(ctx, surface, 1, h - 2, self.notice[0..self.notice_len], dim, null, 0);
            line(ctx, surface, 1, h - 1, "Type to filter · arrows/Ctrl-N/P · Enter choose · Ctrl-R refresh · Esc", accent, null, 0);
            return surface;
        }
        if (self.tools_view) {
            @memset(surface.buffer, .{ .style = base });
            line(ctx, surface, 2, 1, try std.fmt.allocPrint(ctx.arena, "TOOLS · chat {s} · {s}", .{ if (s) |snap| snap.chatId else "?", if (self.online) "read only" else "STALE observation" }), Theme.orange, null, 0);
            line(ctx, surface, 2, 2, "Enabled = model-visible, not a health check.", dim, null, 0);
            var detail: std.ArrayList(Row) = .empty;
            try inventoryRows(ctx, &detail, s, w - 4, false);
            const count: usize = h - 6;
            self.tools_height = count;
            self.tools_max = detail.items.len -| count;
            self.tools_scroll = @min(self.tools_scroll, self.tools_max);
            for (detail.items[self.tools_scroll..@min(detail.items.len, self.tools_scroll + count)], 0..) |row, index| lineLimit(ctx, surface, 2, @intCast(4 + index), row.text, row.style, null, 0, w - 2);
            line(ctx, surface, 1, h - 1, try std.fmt.allocPrint(ctx.arena, "j/k · PgUp/PgDn · g/G · Esc close   {d}/{d}", .{ self.tools_scroll + 1, self.tools_max + 1 }), accent, null, 0);
            return surface;
        }
        if (self.brief_view) {
            line(ctx, surface, 1, 2, "TASK BRIEF · immutable creation snapshot · read only", accent, null, 0);
            var detail: std.ArrayList(Row) = .empty;
            if (s) |snap| {
                try rows(ctx, &detail, snap.title, w - 4, accent);
                if (snap.brief) |brief| {
                    try rows(ctx, &detail, try std.fmt.allocPrint(ctx.arena, "Problem:\n{s}\nDescription:\n{s}", .{ brief.problem orelse "", brief.description orelse "" }), w - 4, base);
                } else try rows(ctx, &detail, "No structured brief saved (legacy/title-only task).", w - 4, dim);
            }
            const count = @as(usize, h - 5);
            self.help_max = detail.items.len -| count;
            self.help_scroll = @min(self.help_scroll, self.help_max);
            for (detail.items[self.help_scroll..@min(detail.items.len, self.help_scroll + count)], 0..) |row, index| line(ctx, surface, 2, @intCast(3 + index), row.text, row.style, null, 0);
            line(ctx, surface, 1, h - 1, "j/k scroll · Esc close · brief changes never submit input", accent, null, 0);
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
            line(ctx, surface, 1, 1, "MODELS · hub catalog (account access not guaranteed)", accent, null, 0);
            line(ctx, surface, 1, 2, try std.fmt.allocPrint(ctx.arena, "Search: {s}", .{self.filter.query()}), base, null, 0);
            if (self.settings()) |settings_value| {
                const count = @as(usize, h - 6);
                const start = (self.model_index + 1) -| count;
                const found = self.matches();
                if (found.len == 0) line(ctx, surface, 1, 3, "No matches. Ctrl-U clears search.", dim, null, 0);
                for (found.items[start..@min(found.len, start + count)], start..) |item, index| {
                    const model = settings_value.models[item.index];
                    const current = std.mem.eql(u8, model.provider, settings_value.selection.provider) and std.mem.eql(u8, model.modelId, settings_value.selection.modelId);
                    const default_model = std.mem.eql(u8, model.provider, settings_value.defaultModel.provider) and std.mem.eql(u8, model.modelId, settings_value.defaultModel.modelId);
                    const text = try std.fmt.allocPrint(ctx.arena, "{s} {s}/{s} · {s}{s}{s}", .{ if (index == self.model_index) ">" else " ", model.provider, model.modelId, model.name, if (current) " [selected]" else "", if (default_model) " [hub default]" else "" });
                    var style = base;
                    style.reverse = index == self.model_index;
                    line(ctx, surface, 1, @intCast(3 + index - start), text, style, null, 0);
                }
            }
            line(ctx, surface, 1, h - 2, self.notice[0..self.notice_len], dim, null, 0);
            line(ctx, surface, 1, h - 1, if (self.readOnly()) "Read-only settings · Esc close · :rex open to participate" else "Type to filter · arrows/Ctrl-N/P · Enter select · Esc · idle chats only", accent, null, 0);
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
        // Normal chat has no banner; dialogs above retain their scoped headings.
        @memset(surface.buffer, .{ .style = base });
        const layout = Theme.Layout.init(w, self.sidebar_override);
        self.sidebar_visible = layout.sidebar > 0;
        const right = layout.main - 1;
        var prompt: std.ArrayList(Row) = .empty;
        try rows(ctx, &prompt, self.editor.text.items, layout.body, base);
        const last = prompt.items[prompt.items.len - 1];
        if (displayWidth(ctx, last.text) >= layout.body) try prompt.append(ctx.arena, .{ .offset = self.editor.text.items.len });
        const prompt_h: u16 = @intCast(@min(@max(2, @min(h / 2, h - 7)), @max(2, prompt.items.len)));
        const prompt_y = h - 3 - prompt_h;
        const upper = prompt_y - 1;
        const chat_h = upper - 1;
        self.chat_height = chat_h;
        var chat: std.ArrayList(Row) = .empty;
        if (s) |snap| try chatRows(ctx, &chat, snap.entries, layout.body, rune(snap));
        if (chat.items.len == 0) try rows(ctx, &chat, if (s == null) "Connecting to the local hub…" else if (self.readOnly()) "Read-only inspection · :rex open to participate" else "Enter to send · Esc for Normal mode · :help", layout.body, dim);
        self.scroll_max = chat.items.len -| chat_h;
        self.scroll = @min(self.scroll, self.scroll_max);
        const first = self.scroll_max - self.scroll;
        for (chat.items[first..@min(chat.items.len, first + chat_h)], 0..) |row, y| {
            if (row.user) for (0..layout.main) |x| surface.writeCell(@intCast(x), @intCast(y), .{ .style = Theme.user });
            var speaker_style = row.speaker_style;
            if (row.user) speaker_style.bg = Theme.user.bg;
            if (row.speaker) |speaker| lineLimit(ctx, surface, layout.x -| 2, @intCast(y), speaker, speaker_style, null, 0, layout.x);
            if (row.cells) |cells| {
                var x = layout.x;
                for (cells) |original| {
                    var cell = original;
                    if (row.user) cell.style.bg = Theme.user.bg;
                    if (x + cell.char.width > layout.x + layout.body) break;
                    surface.writeCell(x, @intCast(y), cell);
                    x += cell.char.width;
                }
            } else lineLimit(ctx, surface, layout.x, @intCast(y), row.text, row.style, null, 0, layout.x + layout.body);
        }
        const mode = if (self.readOnly()) "READ ONLY" else if (s != null and s.?.draft != null and !s.?.draft.?.saved) "LOCKED UNSAVED" else if (s != null and s.?.draft != null and s.?.draft.?.clipped) "SAVED PREVIEW" else if (s != null and s.?.draft != null and s.?.draft.?.saved) "SAVED LOCKED" else if (self.locked()) "LOCKED" else "";
        for (0..layout.main) |x| surface.writeCell(@intCast(x), upper, .{ .char = .{ .grapheme = "─", .width = 1 }, .style = Theme.rule });
        for (0..w) |x| surface.writeCell(@intCast(x), h - 3, .{ .char = .{ .grapheme = "─", .width = 1 }, .style = Theme.rule });
        const border = try std.fmt.allocPrint(ctx.arena, " {s}{s} ", .{ if (self.task_form) "TASK BRIEF " else "", mode });
        if (self.task_form or mode.len > 0) lineLimit(ctx, surface, 1, upper, border, dim, null, 0, right);
        if (self.editor.text.items.len * 5 >= Editor.limit * 4) {
            const bytes_label = try std.fmt.allocPrint(ctx.arena, " {d}/{d} bytes ", .{ self.editor.text.items.len, Editor.limit });
            if (layout.main > border.len + bytes_label.len + 4) lineLimit(ctx, surface, @intCast(right - bytes_label.len), upper, bytes_label, Theme.rule, null, 0, right);
        }
        // Operational notices remain visible above the prompt, never swallowed
        // by decorative chrome or the tool inventory sidebar.
        const notice = self.notice[0..self.notice_len];
        lineLimit(ctx, surface, 1, upper - 1, notice, dim, null, 0, right);
        if (notice.len == 0) if (s) |snap| {
            const preview = snap.preview[0 .. std.mem.indexOfScalar(u8, snap.preview, '\n') orelse snap.preview.len];
            if (preview.len > 0) lineLimit(ctx, surface, layout.x, upper - 1, try std.fmt.allocPrint(ctx.arena, "live · {s}", .{preview}), dim, null, 0, right);
        };
        var cursor_row: usize = 0;
        for (prompt.items, 0..) |row, i| if (self.editor.cursor >= row.offset) {
            cursor_row = i;
        };
        const start = (cursor_row + 1) -| prompt_h;
        for (prompt.items[start..@min(prompt.items.len, start + prompt_h)], 0..) |row, y| lineLimit(ctx, surface, layout.x, @intCast(prompt_y + y), row.text, base, self.editor.selection(), row.offset, layout.x + layout.body);
        if (self.focus == .prompt and !self.command_mode and !self.locked() and !self.readOnly()) {
            const row = prompt.items[cursor_row];
            const end = @min(self.editor.cursor - row.offset, row.text.len);
            surface.cursor = .{ .col = @intCast(layout.x + @min(layout.body - 1, displayWidth(ctx, row.text[0..end]))), .row = @intCast(prompt_y + cursor_row - start), .shape = if (self.editor.mode == .insert) .beam else .block };
        }
        var name_buffer: [192]u8 = undefined;
        const is_hub = if (s) |snap| std.mem.eql(u8, snap.chatId, snap.hubChatId) else false;
        const saved_name = if (is_hub) "hub" else if (s) |snap| snap.agentName orelse "unnamed" else "connecting";
        const identity = try std.fmt.allocPrint(ctx.arena, "{s} {s}", .{ if (s) |snap| rune(snap) else "·", Theme.name(&name_buffer, saved_name, if (is_hub) null else self.animation()) });
        const role = if (is_hub) "" else if (s) |snap| (if (snap.kind == .subagent) "subagent" else "agent") else "";
        if (layout.sidebar > 0) {
            for (0..h - 3) |y| surface.writeCell(layout.main, @intCast(y), .{ .char = .{ .grapheme = if (y == upper) "┤" else "│", .width = 1 }, .style = Theme.rule });
            surface.writeCell(layout.main, h - 3, .{ .char = .{ .grapheme = "┴", .width = 1 }, .style = Theme.rule });
            const available = layout.sidebar - 3;
            const identity_x: u16 = @intCast(layout.main + 2 + (available - @min(available, displayWidth(ctx, identity))) / 2);
            const role_x: u16 = @intCast(layout.main + 2 + (available - @min(available, displayWidth(ctx, role))) / 2);
            lineLimit(ctx, surface, identity_x, 2, identity, Theme.orange, null, 0, w - 1);
            lineLimit(ctx, surface, role_x, 4, role, dim, null, 0, w - 1);
            if (h >= 12) {
                lineLimit(ctx, surface, layout.main + 2, 6, if (self.online) "TOOLS" else "TOOLS · STALE", if (self.online) accent else Theme.orange, null, 0, w - 1);
                var inventory: std.ArrayList(Row) = .empty;
                try inventoryRows(ctx, &inventory, s, available, true);
                const count: usize = h - 11;
                for (inventory.items[0..@min(count, inventory.items.len)], 0..) |row, index| lineLimit(ctx, surface, layout.main + 2, @intCast(7 + index), row.text, row.style, null, 0, w - 1);
                const more = inventory.items.len -| count;
                const hint = if (more > 0) try std.fmt.allocPrint(ctx.arena, ":tools · +{d} rows", .{more}) else ":tools · full inventory";
                lineLimit(ctx, surface, layout.main + 2, h - 4, hint, accent, null, 0, w - 1);
            }
        }
        const footer_right = w - 1;
        const directory = if (s) |snap| snap.cwd orelse "directory unavailable" else "connecting";
        const branch = if (s) |snap| snap.gitBranch orelse "branch —" else "branch —";
        const location = try std.fmt.allocPrint(ctx.arena, "{s} ({s})", .{ try shortDirectory(ctx.arena, directory, self.home), branch });
        const shown_location = try tailColumns(ctx, location, (@as(u16, w) * 2) / 3);
        const location_x: u16 = @intCast(footer_right - displayWidth(ctx, shown_location));
        const problem = if (is_hub) "hub" else if (s) |snap| (if (snap.brief) |brief| brief.problem orelse snap.title else snap.title) else "connecting";
        const problem_line = problem[0 .. std.mem.indexOfScalar(u8, problem, '\n') orelse problem.len];
        const task_label = try std.fmt.allocPrint(ctx.arena, "{s} {s}", .{ if (s) |snap| rune(snap) else "·", problem_line });
        lineLimit(ctx, surface, 1, h - 2, task_label, Theme.orange, null, 0, location_x -| 1);
        lineLimit(ctx, surface, location_x, h - 2, shown_location, dim, null, 0, footer_right);
        const status = try std.fmt.allocPrint(ctx.arena, "{s} [{s}]", .{ if (s) |snap| snap.model else "model —", if (self.settings()) |settings_value| @tagName(settings_value.selection.thinkingLevel) else "thinking —" });
        // Reserve room for uncertainty even with long model names.
        const warning = if (!self.online) try std.fmt.allocPrint(ctx.arena, "STALE · {s}", .{self.shown_transport.text()}) else if (self.command_mode or self.shown_transport == .waiting or self.shown_transport == .fenced) self.shown_transport.text() else "";
        const warning_width = @min(footer_right - 2, displayWidth(ctx, warning));
        const model_width = @min(displayWidth(ctx, status), if (self.command_mode or warning_width > 0) footer_right / 2 else footer_right - 1);
        const model_x: u16 = @intCast(footer_right - model_width);
        lineLimit(ctx, surface, model_x, h - 1, status, dim, null, 0, footer_right);
        const command_right = model_x -| 1;
        if (self.command_mode) {
            const command_text = try std.fmt.allocPrint(ctx.arena, ":{s}", .{self.command.items});
            // Scroll the entry, not the model, when an Ex command is long.
            var start_byte: usize = 0;
            var it = vaxis.unicode.graphemeIterator(command_text);
            var remaining = displayWidth(ctx, command_text);
            while (remaining >= command_right -| 1) {
                const g = it.next() orelse break;
                start_byte = g.start + g.len;
                remaining -= glyph(ctx, g.bytes(command_text)).width;
            }
            lineLimit(ctx, surface, 1, h - 1, command_text[start_byte..], accent, null, 0, command_right);
            surface.cursor = .{ .row = h - 1, .col = @intCast(@min(command_right, 1 + remaining)), .shape = .beam };
            // Keep slot/fence information observable without displacing commands.
            if (warning_width > 0) lineLimit(ctx, surface, 1, upper - 1, warning, if (self.online) dim else Theme.orange, null, 0, right);
        } else if (warning_width > 0) lineLimit(ctx, surface, 1, h - 1, warning, Theme.orange, null, 0, command_right);
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
    var worker_socket: ?[]const u8 = null;
    var bootstrap_id: ?[]const u8 = null;
    var client_state: ?[]const u8 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--tui")) continue;
        const key = args[i];
        if (!std.mem.eql(u8, key, "--port") and !std.mem.eql(u8, key, "--task") and !std.mem.eql(u8, key, "--hub-id") and !std.mem.eql(u8, key, "--rex-allocation") and !std.mem.eql(u8, key, "--worker-socket") and !std.mem.eql(u8, key, "--agent-bootstrap") and !std.mem.eql(u8, key, "--client-state")) return error.UnsupportedTuiOption;
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
        if (std.mem.eql(u8, key, "--client-state")) {
            if (!@import("mcp_profiles.zig").absolute(args[i])) return error.InvalidArguments;
            client_state = args[i];
        }
        if (std.mem.eql(u8, key, "--agent-bootstrap")) {
            if (!wire.validRexUuid(.{ .string = args[i] })) return error.InvalidAllocation;
            bootstrap_id = args[i];
        }
        if (std.mem.eql(u8, key, "--worker-socket")) {
            if (!std.fs.path.isAbsolute(args[i]) or args[i].len > 100 or std.mem.indexOfAny(u8, args[i], "\x00\r\n") != null) return error.InvalidWorkerSocket;
            worker_socket = args[i];
        }
        try forwarded.appendSlice(init.gpa, &.{ key, args[i] });
    }
    if ((worker_socket != null or bootstrap_id != null) and allocation_id == null) return error.InvalidAllocation;
    if (bootstrap_id != null and client_state == null) return error.InvalidAllocation;
    if (allocation_id != null and (hub_id == null or chat_id == null)) return error.InvalidAllocation;
    var bridge = try Bridge.start(.{ .io = init.io, .environ = init.minimal.environ }, init.gpa, forwarded.items);
    defer bridge.deinit();
    bridge.client_mode = if (allocation_id != null) .task else .hub;
    if (hub_id) |id| bridge.hub_id = try init.gpa.dupe(u8, id);
    if (chat_id) |id| bridge.chat_id = try init.gpa.dupe(u8, id);
    var model: Model = .{ .a = init.gpa, .bridge = &bridge, .editor = Editor.init(init.gpa) };
    model.editor.mode = .insert;
    model.home = init.environ_map.get("HOME");
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
    const cwd = std.process.currentPathAlloc(init.io, init.gpa) catch null;
    defer if (cwd) |path| init.gpa.free(path);
    while (!stopping.load(.monotonic)) {
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
            // Bracketed paste uses key events; never decode/allocate unsolicited OSC 52.
            app.vx.opts.system_clipboard_allocator = null;
            var title_buffer: [192]u8 = undefined;
            const snapshot = model.state();
            var terminal_status: TerminalStatus = .{ .vx = &app.vx, .writer = app.tty.writer(), .title = TerminalStatus.identityTitle(&title_buffer, if (snapshot) |s| s.cwd orelse "unknown" else cwd orelse "unknown", if (snapshot) |s| Model.rune(s) else if (chat_id == null) "Δ" else "·") };
            defer terminal_status.end();
            try terminal_status.begin();
            model.terminal_status = &terminal_status;
            defer model.terminal_status = null;
            try app.run(model.widget(), .{ .framerate = 30 });
        } // Event loop joined, raw mode/alternate screen/title restored first.
        if (!model.external_edit or stopping.load(.monotonic)) break;
        model.external_edit = false;
        model.online = false;
        model.busy_started = null;
        const edited = ExternalEditor.run(.{ .io = init.io, .environ = init.minimal.environ }, init.gpa, init.environ_map, model.editor.text.items, &stopping) catch |err| {
            var message: [256]u8 = undefined;
            model.note(std.fmt.bufPrint(&message, "Editor failed ({s}); prompt unchanged. Set $EDITOR to an executable with optional arguments.", .{@errorName(err)}) catch "Editor failed; prompt unchanged.");
            continue;
        };
        defer init.gpa.free(edited);
        model.editor.replace(edited) catch {
            model.note("Could not load editor contents; prompt unchanged.");
            continue;
        };
        model.focus = .prompt;
        model.note("Editor contents loaded; Enter sends, i edits. Nothing submitted.");
    }
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
            .clientMode = .hub,
            .hubChatId = "1",
            .title = "Hub",
            .agentName = "wintermute",
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
    try std.testing.expectEqual(16, surface.cursor.?.col);
    var rendered: std.ArrayList(u8) = .empty;
    defer rendered.deinit(a);
    for (surface.buffer) |cell| try rendered.appendSlice(a, cell.char.grapheme);
    try std.testing.expect(std.mem.indexOf(u8, rendered.items, "Δ unsafe") != null);
    try std.testing.expect(std.mem.indexOf(u8, rendered.items, "wintermute") == null);
    try std.testing.expect(std.mem.indexOf(u8, rendered.items, "#1") == null);
    for (surface.buffer) |cell| {
        try std.testing.expect(std.mem.indexOfScalar(u8, cell.char.grapheme, 27) == null);
        try std.testing.expect(std.mem.indexOf(u8, cell.char.grapheme, "\xc2\x9b") == null);
    }
    var small = draw_ctx;
    small.max = .{ .width = 10, .height = 3 };
    try std.testing.expectEqual(30, (try Model.draw(&model, small)).buffer.len);
    small.max = .{ .width = 80, .height = 0 };
    try std.testing.expectEqual(0, (try Model.draw(&model, small)).buffer.len);
    for ([_]u16{ 20, 40, 80, 111, 112, 140, 512 }) |width| {
        for ([_]u16{ 9, 10, 24, 120 }) |height| {
            small.max = .{ .width = width, .height = height };
            model.sidebar_override = true;
            const resized = try Model.draw(&model, small);
            if (resized.cursor) |cursor| try std.testing.expect(cursor.col < width and cursor.row < height);
        }
    }
    model.sidebar_override = null;
    model.name_started = 0;
    model.frame = 0;
    try std.testing.expectEqual(@as(?u64, 0), model.animation());
    model.frame = 18;
    try std.testing.expect(model.animation() == null);
    model.online = true;
    model.activity_seen = 160;
    model.busy_started = 0;
    model.frame = 160;
    try std.testing.expectEqual(@as(?u64, 0), model.animation());
    model.frame = 320;
    try std.testing.expect(model.animation() == null); // stale busy never animates
    model.name_started = null;
    model.busy_started = null;
    model.online = false;
    var large = draw_ctx;
    large.max = .{ .width = 500, .height = 500 };
    bridge.pending = .{ .version = 1, .id = "pending", .action = .poll };
    model.pending_since = std.Io.Timestamp.now(bridge.io, .awake).subDuration(.fromMilliseconds(501));
    const started = model.pending_since;
    try model.issue(.older); // Refusal must not restart the waiting indicator's delay.
    try std.testing.expectEqualDeep(started, model.pending_since);
    const waiting_surface = try Model.draw(&model, large);
    try std.testing.expectEqual(500 * 120, waiting_surface.buffer.len);
    var footer: std.ArrayList(u8) = .empty;
    defer footer.deinit(a);
    for (waiting_surface.buffer[500 * 119 ..]) |cell| try footer.appendSlice(a, cell.char.grapheme);
    try std.testing.expect(std.mem.indexOf(u8, footer.items, "client waiting") != null);
    try std.testing.expect(std.mem.indexOf(u8, footer.items, "STALE") != null);
    bridge.pending = null;
    model.snapshot.?.value.case0.snapshot.draft = .{ .kind = .input, .requestId = "saved", .text = "preview", .clipped = false, .saved = false };
    try model.press(&ctx, .{ .codepoint = 'v', .text = "v" });
    try std.testing.expect(!model.external_edit and !ctx.quit);
    model.quit(&ctx, false);
    try std.testing.expect(!ctx.quit);
    model.snapshot.?.value.case0.snapshot.draft.?.saved = true;
    model.quit(&ctx, false);
    try std.testing.expect(ctx.quit);

    model.snapshot.?.value.case0.snapshot.draft.?.kind = .task;
    model.task_form = true;
    ctx.quit = false;
    model.quit(&ctx, false);
    try std.testing.expect(ctx.quit);
    model.task_form = false;
    model.snapshot.?.value.case0.snapshot.draft = null;
    try model.editor.set("UNSENT prompt");
    try model.beginTaskForm(null);
    try std.testing.expect(!model.task_form);
    try std.testing.expectEqualStrings("UNSENT prompt", model.editor.text.items);
    try model.editor.set("");
    model.settings_uncertain = false;
    try model.beginTaskForm(null);
    try std.testing.expect(model.task_form);
    try model.editor.set("{\"title\":\"Unsubmitted\"}");
    try model.command.appendSlice(a, "cancel");
    try model.ex(&ctx);
    try std.testing.expect(!model.task_form);
    try std.testing.expectEqualStrings("", model.editor.text.items);
    try std.testing.expect(bridge.pending == null);

    // Hub inspection keeps the hub color but cannot edit or mutate a task.
    model.snapshot.?.value.case0.snapshot.draft = null;
    model.snapshot.?.value.case0.snapshot.chatId = "2";
    try model.editor.set("");
    try std.testing.expect(model.readOnly());
    ctx.quit = false;
    try model.press(&ctx, .{ .codepoint = 'v', .text = "v" });
    try std.testing.expect(!model.external_edit and !ctx.quit);
    try model.press(&ctx, .{ .codepoint = 'i', .text = "i" });
    try Model.event(&model, &ctx, .paste_start);
    try model.press(&ctx, .{ .codepoint = 'x', .text = "must not edit" });
    try Model.event(&model, &ctx, .paste_end);
    try std.testing.expectEqualStrings("", model.editor.text.items);
    for ([_]Action{ .send, .retry, .discard, .stop }) |action| try model.issue(action);
    try std.testing.expect(bridge.pending == null);
    const inspect_surface = try Model.draw(&model, draw_ctx);
    try std.testing.expectEqualDeep(hub_bar.bg, inspect_surface.buffer[0].style.bg);
    try std.testing.expectEqualDeep(hub_bar.bg, inspect_surface.buffer[3999].style.bg);
    try std.testing.expect(inspect_surface.cursor == null);

    // Task clients use a different color and cannot navigate, including :main.
    bridge.client_mode = .task;
    model.snapshot.?.value.case0.snapshot.clientMode = .task;
    try std.testing.expect(!model.readOnly());
    for ([_][]const u8{ "tasks", "hosts", "new", "hub", "main", "select 1", "task no" }) |cmd| {
        try model.command.appendSlice(a, cmd);
        try model.ex(&ctx);
        try std.testing.expect(bridge.pending == null);
    }
    for ([_]u21{ 't', 'n' }) |key| {
        try model.press(&ctx, .{ .codepoint = ' ' });
        try model.press(&ctx, .{ .codepoint = key });
        try std.testing.expect(bridge.pending == null and !model.task_form and !model.leader);
    }
    bridge.pending = .{ .version = 1, .id = "read", .action = .poll };
    try model.press(&ctx, .{ .codepoint = 'v' });
    try std.testing.expect(!model.external_edit and !ctx.quit);
    bridge.pending = null;
    const task_surface = try Model.draw(&model, draw_ctx);
    try std.testing.expectEqualDeep(bar.bg, task_surface.buffer[0].style.bg);
    try std.testing.expectEqualDeep(bar.bg, task_surface.buffer[3999].style.bg);
    try std.testing.expectEqualDeep(hub_bar.bg, bar.bg); // Same monochrome chrome, authority is not a color.
    var wide_ctx = draw_ctx;
    wide_ctx.max.width = 140;
    model.sidebar_override = true;
    model.snapshot.?.value.case0.snapshot.agentRune = "ᚦ";
    const centered = try Model.draw(&model, wide_ctx);
    try std.testing.expectEqualStrings("ᚦ", centered.buffer[2 * 140 + 106].char.grapheme);
    try std.testing.expectEqualStrings("a", centered.buffer[4 * 140 + 110].char.grapheme);
    try model.press(&ctx, .{ .codepoint = 'v' });
    try std.testing.expect(model.external_edit and ctx.quit);
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

test "soft wrapping preserves exact bytes, Unicode clusters and cursor offsets" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    fw.DrawContext.init(.unicode);
    const ctx: fw.DrawContext = .{ .arena = arena.allocator(), .min = .{}, .max = .{ .width = 80, .height = 24 }, .cell_size = .{ .width = 8, .height = 16 } };
    var result: std.ArrayList(Row) = .empty;
    try rows(ctx, &result, "alpha beta gamma", 12, base);
    try std.testing.expectEqual(@as(usize, 2), result.items.len);
    try std.testing.expectEqualStrings("alpha beta ", result.items[0].text);
    try std.testing.expectEqualStrings("gamma", result.items[1].text);
    try std.testing.expectEqual(@as(usize, 11), result.items[1].offset);
    result.clearRetainingCapacity();
    try rows(ctx, &result, "界界 é\n\nend\n", 5, base);
    try std.testing.expectEqualStrings("界界 ", result.items[0].text);
    try std.testing.expectEqualStrings("é", result.items[1].text);
    try std.testing.expectEqual(@as(usize, 7), result.items[1].offset);
    try std.testing.expectEqualStrings("", result.items[result.items.len - 1].text);
    result.clearRetainingCapacity();
    try rows(ctx, &result, "12345678", 3, base);
    try std.testing.expectEqualStrings("123", result.items[0].text);
    try std.testing.expectEqualStrings("456", result.items[1].text);
    try std.testing.expectEqualStrings("78", result.items[2].text);
}

test "tools cap eight visual rows; bash keeps the tail without an extra truncation line" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    fw.DrawContext.init(.unicode);
    const ctx: fw.DrawContext = .{ .arena = arena.allocator(), .min = .{}, .max = .{ .width = 80, .height = 24 }, .cell_size = .{ .width = 8, .height = 16 } };
    var result: std.ArrayList(Row) = .empty;
    const original = "bash\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
    try toolRows(ctx, &result, original, 80);
    try std.testing.expectEqual(@as(usize, 9), result.items.len);
    try std.testing.expectEqualStrings("3", result.items[1].text);
    try std.testing.expectEqualStrings("10", result.items[8].text);
    result.clearRetainingCapacity();
    try toolRows(ctx, &result, "bash\n1\n2\n3\n4\n5\n6\n7\n8\n", 80);
    try std.testing.expectEqual(@as(usize, 9), result.items.len);
    const wide: [100]u8 = @splat('x');
    result.clearRetainingCapacity();
    try toolRows(ctx, &result, try std.fmt.allocPrint(ctx.arena, "read\n{s}", .{wide}), 10);
    try std.testing.expect(std.mem.startsWith(u8, result.items[9].text, "[output"));
    try std.testing.expectEqualStrings("~", try shortDirectory(ctx.arena, "/home/me", "/home/me"));
    try std.testing.expectEqualStrings("~/src", try shortDirectory(ctx.arena, "/home/me/src", "/home/me"));
    try std.testing.expectEqualStrings("/home/me-too/src", try shortDirectory(ctx.arena, "/home/me-too/src", "/home/me"));
}

test "user panels pad full chat width, task footer uses brief, and filters cannot select absent rows" {
    const a = std.testing.allocator;
    var bridge: Bridge = .{ .a = a, .io = std.testing.io, .child = undefined };
    const owned = try a.create(std.heap.ArenaAllocator);
    owned.* = .init(a);
    var model: Model = .{ .a = a, .bridge = &bridge, .editor = Editor.init(a), .home = "/home/me", .snapshot = .{
        .arena = owned,
        .value = .{ .case0 = .{ .version = 1, .id = "1", .ok = true, .snapshot = .{
            .hubId = "hub",
            .chatId = "2",
            .hubChatId = "1",
            .clientMode = .task,
            .title = "Short title",
            .agentRune = "ᚦ",
            .agentName = "wintermute",
            .model = "mock",
            .tools = "offline",
            .cwd = "/home/me/project",
            .gitBranch = "feature/demo",
            .brief = .{ .problem = "Fix the actual task problem" },
            .activityKnown = false,
            .busy = false,
            .queued = 0,
            .entries = &.{ .{ .id = 1, .role = .user, .text = "**Hello**" }, .{ .id = 2, .role = .assistant, .text = "Answer", .thinkingTokens = 27 } },
            .hasOlder = false,
            .historical = false,
            .preview = "",
            .notice = "",
            .draft = null,
            .modelSettings = .{ .hubId = "hub", .chatId = "2", .selection = .{ .provider = "mock", .modelId = "zeta", .thinkingLevel = .off }, .defaultModel = .{ .provider = "mock", .modelId = "zeta" }, .models = &.{
                .{ .provider = "mock", .modelId = "zeta", .name = "Zeta", .thinkingLevels = &.{.off}, .defaultThinkingLevel = .off },
                .{ .provider = "mock", .modelId = "gpt-fast", .name = "GPT Fast", .thinkingLevels = &.{.off}, .defaultThinkingLevel = .off },
            } },
        } } },
    } };
    defer model.deinit();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    fw.DrawContext.init(.unicode);
    const draw_ctx: fw.DrawContext = .{ .arena = arena.allocator(), .min = .{}, .max = .{ .width = 140, .height = 40 }, .cell_size = .{ .width = 8, .height = 16 } };
    const surface = try Model.draw(&model, draw_ctx);
    for (1..4) |y| for (0..84) |x| try std.testing.expectEqualDeep(Theme.user.bg, surface.buffer[y * 140 + x].style.bg);
    for ([_]usize{ 0, 4 }) |y| for (0..84) |x| {
        const cell = surface.buffer[y * 140 + x];
        try std.testing.expectEqualDeep(base.bg, cell.style.bg);
        try std.testing.expectEqualStrings(" ", cell.char.grapheme);
    };
    try std.testing.expectEqualDeep(base.bg, surface.buffer[85].style.bg);
    try std.testing.expectEqualStrings("•", surface.buffer[2 * 140].char.grapheme);
    try std.testing.expectEqualDeep(base.fg, surface.buffer[5 * 140 + 2].style.fg);
    const thinking = "[thinking: 27 tokens]";
    for (thinking, 0..) |_, x| {
        const cell = surface.buffer[6 * 140 + 2 + x];
        try std.testing.expectEqualStrings(thinking[x..][0..1], cell.char.grapheme);
        try std.testing.expectEqualDeep(dim.fg, cell.style.fg);
    }
    var footer: std.ArrayList(u8) = .empty;
    defer footer.deinit(a);
    for (surface.buffer[38 * 140 .. 39 * 140]) |cell| try footer.appendSlice(a, cell.char.grapheme);
    try std.testing.expect(std.mem.indexOf(u8, footer.items, "ᚦ Fix the actual task problem") != null);
    try std.testing.expect(std.mem.endsWith(u8, footer.items, "~/project (feature/demo) "));
    // Empty/small prompts stay quiet; the first visible count is ceil(80%).
    const prompt: [Editor.limit]u8 = @splat('a');
    for ([_]usize{ 0, 1, 13107, 13108, Editor.limit }) |len| {
        try model.editor.set(prompt[0..len]);
        const drawn = try Model.draw(&model, draw_ctx);
        var text: std.ArrayList(u8) = .empty;
        for (drawn.buffer) |cell| try text.appendSlice(arena.allocator(), cell.char.grapheme);
        try std.testing.expectEqual(len >= 13108, std.mem.indexOf(u8, text.items, "/16384 bytes") != null);
        if (len >= 13108) try std.testing.expect(std.mem.indexOf(u8, text.items, try std.fmt.allocPrint(arena.allocator(), "{d}/16384 bytes", .{len})) != null);
    }
    try model.editor.set("");
    // Sidebar stops at the full-width footer; prompt keeps its own junction.
    for ([_]bool{ false, true }) |sidebar| {
        model.sidebar_override = sidebar;
        for ([_]u16{ 60, 100, 140 }) |width| {
            var resized = draw_ctx;
            resized.max.width = width;
            for ([_][]const u8{ "", "one\ntwo\nthree\nfour" }) |text| {
                try model.editor.set(text);
                const drawn = try Model.draw(&model, resized);
                const layout = Theme.Layout.init(width, sidebar);
                const upper: usize = if (text.len == 0) 34 else 32;
                if (sidebar) {
                    for (0..37) |y| try std.testing.expectEqualStrings(if (y == upper) "┤" else "│", drawn.buffer[y * width + layout.main].char.grapheme);
                    try std.testing.expectEqualStrings("┴", drawn.buffer[37 * width + layout.main].char.grapheme);
                    for (38..40) |y| try std.testing.expect(!std.mem.eql(u8, "│", drawn.buffer[y * width + layout.main].char.grapheme));
                    for (0..width) |x| try std.testing.expectEqualStrings(if (x == layout.main) "┴" else "─", drawn.buffer[37 * width + x].char.grapheme);
                } else {
                    for (drawn.buffer) |cell| try std.testing.expect(!std.mem.eql(u8, cell.char.grapheme, "┤"));
                }
            }
        }
    }
    try model.editor.set("");
    model.sidebar_override = null;
    model.snapshot.?.value.case0.snapshot.entries = &.{.{ .id = 1, .role = .assistant, .text = "Answer", .thinkingTokens = 0 }};
    const zero = try Model.draw(&model, draw_ctx);
    var zero_text: std.ArrayList(u8) = .empty;
    for (zero.buffer) |cell| try zero_text.appendSlice(arena.allocator(), cell.char.grapheme);
    try std.testing.expect(std.mem.indexOf(u8, zero_text.items, "[thinking:") == null);
    try std.testing.expect(!model.mouse_tracking);
    var event_ctx: fw.EventContext = .{ .io = std.testing.io, .alloc = a, .cmds = .empty };
    defer event_ctx.cmds.deinit(a);
    model.model_picker = true;
    try model.press(&event_ctx, .{ .codepoint = 'g', .text = "gpt" });
    try std.testing.expectEqual(@as(?usize, 1), model.matches().raw(model.model_index));
    try model.press(&event_ctx, .{ .codepoint = 'q', .text = "q" });
    try std.testing.expect(model.model_picker and model.matches().len == 0);
    try model.press(&event_ctx, .{ .codepoint = vaxis.Key.enter });
    try std.testing.expect(bridge.pending == null);
    try model.press(&event_ctx, .{ .codepoint = 'u', .mods = .{ .ctrl = true } });
    try Model.event(&model, &event_ctx, .paste_start);
    try model.press(&event_ctx, .{ .codepoint = 0, .text = "gpt" });
    try Model.event(&model, &event_ctx, .paste_end);
    try std.testing.expectEqualStrings("gpt", model.filter.query());
    try std.testing.expectEqualStrings("", model.editor.text.items);
    try std.testing.expect(bridge.pending == null);
    const filtered = try Model.draw(&model, draw_ctx);
    try std.testing.expectEqual(@as(u16, 140), filtered.size.width);
}

test "untrusted terminal and bidi controls never reach cells" {
    try std.testing.expectEqualStrings("�", safeGrapheme("\x1b]52;c;SECRET\x07"));
    try std.testing.expectEqualStrings("�", safeGrapheme("\xc2\x9b31m"));
    try std.testing.expectEqualStrings("�", safeGrapheme("\u{202e}spoof"));
    try std.testing.expectEqualStrings("👩🏽‍💻", safeGrapheme("👩🏽‍💻"));
}

fn testSurfaceText(a: std.mem.Allocator, surface: fw.Surface) ![]const u8 {
    var text: std.ArrayList(u8) = .empty;
    for (surface.buffer, 0..) |cell, index| {
        try text.appendSlice(a, cell.char.grapheme);
        if ((index + 1) % surface.size.width == 0) try text.append(a, '\n');
    }
    return text.items;
}

test "tool inventory separates locations and grants, preserves unknown, and offers all overflow read-only" {
    const a = std.testing.allocator;
    var bridge: Bridge = .{ .a = a, .io = std.testing.io, .child = undefined };
    var model: Model = .{ .a = a, .bridge = &bridge, .editor = .init(a), .online = true, .snapshot = .{
        .arena = try a.create(std.heap.ArenaAllocator),
        .value = .{ .case0 = .{ .version = 1, .id = "1", .ok = true, .snapshot = .{
            .clientMode = .task,
            .hubChatId = "1",
            .hubId = "hub",
            .chatId = "2",
            .title = "Inventory",
            .model = "mock",
            .tools = "native-files + bash",
            .activityKnown = false,
            .busy = false,
            .queued = 0,
            .entries = &.{},
            .hasOlder = false,
            .historical = false,
            .preview = "",
            .notice = "",
            .draft = null,
        } } },
    } };
    model.snapshot.?.arena.* = std.heap.ArenaAllocator.init(a);
    defer model.deinit();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    fw.DrawContext.init(.unicode);
    var ctx: fw.DrawContext = .{ .arena = alloc, .min = .{}, .max = .{ .width = 140, .height = 40 }, .cell_size = .{ .width = 8, .height = 16 } };
    const snap = &model.snapshot.?.value.case0.snapshot;
    const unknown = try testSurfaceText(alloc, try Model.draw(&model, ctx));
    try std.testing.expect(std.mem.indexOf(u8, unknown, "Inventory unavailable") != null);
    try std.testing.expect(std.mem.indexOf(u8, unknown, "No profiles") == null);
    snap.toolInventoryStatus = .unsupported;
    try std.testing.expect(std.mem.indexOf(u8, try testSurfaceText(alloc, try Model.draw(&model, ctx)), "Inventory unsupported") != null);
    const hub_machine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const worker_machine = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const revision = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    snap.toolInventoryStatus = .ready;
    snap.toolInventory = .{ .chatId = "2", .hubMachineId = hub_machine, .workerMachineId = worker_machine, .builtins = &.{
        .{ .name = "read", .location = .worker },   .{ .name = "write", .location = .worker }, .{ .name = "edit", .location = .worker },                         .{ .name = "bash", .location = .worker },
        .{ .name = "task_list", .location = .hub }, .{ .name = "subagent", .location = .hub }, .{ .name = "custom_environment_tool", .location = .environment },
    }, .mcp = &.{
        .{ .profileId = "search", .machineId = hub_machine, .location = .hub, .workspace = .fixed, .revision = revision, .state = .enabled, .tools = &.{.{ .name = "search", .alias = "mcp_search_alias" }} },
        .{ .profileId = "workspace", .machineId = worker_machine, .location = .worker, .workspace = .task, .revision = revision, .state = .enabled, .tools = &.{.{ .name = "lookup", .alias = "mcp_lookup_alias" }} },
        .{ .profileId = "browser", .machineId = worker_machine, .location = .worker, .workspace = .task, .revision = revision, .state = .not_granted, .tools = &.{.{ .name = "browse", .alias = "mcp_browse_alias" }} },
        .{ .profileId = "old_revision", .machineId = worker_machine, .location = .worker, .revision = revision, .state = .unavailable, .tools = &.{} },
    } };
    const text = try testSurfaceText(alloc, try Model.draw(&model, ctx));
    for ([_][]const u8{ "MCP · HUB", "MCP · WORKER LOCAL", "search · enabled (1)", "workspace · enabled (1)", "browser · not granted (1)", "old_revision · unavailable", "BUILT-IN · WORKER LOCAL", "read · write · edit · bash", "BUILT-IN · HUB", "task_list · subagent", "ENVIRONMENT TOOLS", "custom_environment_tool" }) |expected| try std.testing.expect(std.mem.indexOf(u8, text, expected) != null);
    ctx.max.height = 24;
    try std.testing.expect(std.mem.indexOf(u8, try testSurfaceText(alloc, try Model.draw(&model, ctx)), ":tools · +") != null);
    model.online = false;
    try std.testing.expect(std.mem.indexOf(u8, try testSurfaceText(alloc, try Model.draw(&model, ctx)), "TOOLS · STALE") != null);
    model.online = true;
    var event: fw.EventContext = .{ .io = std.testing.io, .alloc = a, .cmds = .empty };
    defer event.cmds.deinit(a);
    try model.editor.set("preserve unsent prompt");
    try model.command.appendSlice(a, "tools");
    try model.ex(&event);
    try std.testing.expect(model.tools_view and bridge.pending == null);
    ctx.max = .{ .width = 100, .height = 12 }; // Full view also works without sidebar.
    var all: std.ArrayList(u8) = .empty;
    while (true) {
        try all.appendSlice(alloc, try testSurfaceText(alloc, try Model.draw(&model, ctx)));
        if (model.tools_scroll == model.tools_max) break;
        try model.press(&event, .{ .codepoint = vaxis.Key.page_down });
    }
    for ([_][]const u8{ "mcp_search_alias", "mcp_lookup_alias", "mcp_browse_alias", hub_machine, worker_machine, revision, "workspace unknown", "permissions" }) |expected| try std.testing.expect(std.mem.indexOf(u8, all.items, expected) != null);
    try model.press(&event, .{ .codepoint = 'g' });
    try std.testing.expectEqual(0, model.tools_scroll);
    try model.press(&event, .{ .codepoint = 'G' });
    try std.testing.expectEqual(model.tools_max, model.tools_scroll);
    try model.press(&event, .{ .codepoint = 's', .mods = .{ .ctrl = true } });
    try Model.event(&model, &event, .paste_start);
    try model.press(&event, .{ .codepoint = 0, .text = "do not insert or execute" });
    try Model.event(&model, &event, .paste_end);
    try std.testing.expectEqualStrings("preserve unsent prompt", model.editor.text.items);
    try std.testing.expect(bridge.pending == null);
    try model.press(&event, .{ .codepoint = vaxis.Key.escape });
    try std.testing.expect(!model.tools_view);
    snap.toolInventory.?.mcp = &.{};
    ctx.max = .{ .width = 140, .height = 40 };
    try std.testing.expect(std.mem.indexOf(u8, try testSurfaceText(alloc, try Model.draw(&model, ctx)), "No profiles for this chat") != null);
    // Fully populated inventory stays within every bounded surface/override.
    for ([_]u16{ 20, 60, 100, 112, 140, 512 }) |width| for ([_]u16{ 9, 12, 24, 120 }) |height| {
        ctx.max = .{ .width = width, .height = height };
        model.sidebar_override = true;
        _ = try Model.draw(&model, ctx);
        model.tools_view = true;
        _ = try Model.draw(&model, ctx);
        model.tools_view = false;
    };
}

fn testRowsText(a: std.mem.Allocator, rendered: []const Row) ![]const u8 {
    var text: std.ArrayList(u8) = .empty;
    for (rendered) |row| {
        if (row.cells) |cells| {
            for (cells) |cell| try text.appendSlice(a, cell.char.grapheme);
        } else try text.appendSlice(a, row.text);
        try text.append(a, '\n');
    }
    return text.items;
}

test "typed notices always use dim grey, literal message brackets stay white, hidden entries add no filler" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    fw.DrawContext.init(.unicode);
    const ctx: fw.DrawContext = .{ .arena = a, .min = .{}, .max = .{ .width = 80, .height = 40 }, .cell_size = .{ .width = 8, .height = 16 } };
    var rendered: std.ArrayList(Row) = .empty;
    const entries: []const wire.TuiEntry = &.{
        .{ .id = 1, .role = .assistant, .text = "ignored flat fallback", .parts = &.{
            .{ .kind = .text, .text = "[error]\n[non-text content]" },
            .{ .kind = .notice, .text = "[view clipped]" },
            .{ .kind = .tool_request, .toolName = "read", .text = "[tool requested: read]" },
            .{ .kind = .notice, .text = "[error]" },
        }, .thinkingTokens = 27 },
        .{ .id = 2, .role = .assistant, .text = "must not show", .parts = &.{} },
    };
    try chatRows(ctx, &rendered, entries, 80, "Δ");
    try std.testing.expectEqual(7, rendered.items.len); // two literal rows, four notices, one gap
    for (rendered.items[0..2]) |row| for (row.cells.?) |cell| try std.testing.expectEqualDeep(base.fg, cell.style.fg);
    for (rendered.items[2..6]) |row| {
        try std.testing.expect(row.cells == null);
        try std.testing.expectEqualDeep(dim.fg, row.style.fg);
    }
    try std.testing.expectEqualStrings("[thinking: 27 tokens]", rendered.items[5].text);
    try std.testing.expect(std.mem.indexOf(u8, try testRowsText(a, rendered.items), "must not show") == null);
    // Notice wrapping does not route continuation lines through Markdown.
    rendered.clearRetainingCapacity();
    try chatRows(ctx, &rendered, &.{.{ .id = 3, .role = .assistant, .text = "", .parts = &.{.{ .kind = .notice, .text = "[a **long** generated notice that wraps]" }} }}, 10, "Δ");
    try std.testing.expect(rendered.items.len > 3);
    for (rendered.items[0 .. rendered.items.len - 1]) |row| {
        try std.testing.expect(row.cells == null);
        try std.testing.expectEqualDeep(dim.fg, row.style.fg);
        try std.testing.expect(displayWidth(ctx, row.text) <= 10);
    }
}

test "six consecutive bash outputs collapse across requests and hidden reasoning to the latest eight rows" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    fw.DrawContext.init(.unicode);
    const ctx: fw.DrawContext = .{ .arena = a, .min = .{}, .max = .{ .width = 80, .height = 40 }, .cell_size = .{ .width = 8, .height = 16 } };
    var entries: std.ArrayList(wire.TuiEntry) = .empty;
    for (0..6) |i| {
        try entries.append(a, .{ .id = @intCast(3 * i + 1), .role = .assistant, .text = "", .parts = &.{.{ .kind = .tool_request, .toolName = "bash", .text = "[tool requested: bash]" }}, .thinkingTokens = 2 });
        try entries.append(a, .{ .id = @intCast(3 * i + 2), .role = .assistant, .text = "", .parts = &.{} });
        const parts = try a.alloc(wire.TuiPart, 1);
        parts[0] = .{ .kind = .tool, .toolName = "bash", .text = if (i == 5) "old1\nold2\nfinal3\nfinal4\nfinal5\nfinal6\nfinal7\nfinal8\nfinal9\nfinal10\n" else "old output must disappear" };
        try entries.append(a, .{ .id = @intCast(3 * i + 3), .role = .tool, .text = "", .parts = parts });
    }
    var rendered: std.ArrayList(Row) = .empty;
    try chatRows(ctx, &rendered, entries.items, 80, "Δ");
    try std.testing.expectEqualStrings("bash (×6)", rendered.items[0].text);
    try std.testing.expectEqualStrings("final3", rendered.items[1].text);
    try std.testing.expectEqualStrings("final10", rendered.items[8].text);
    try std.testing.expectEqualStrings("[thinking: 12 tokens]", rendered.items[9].text);
    try std.testing.expectEqual(11, rendered.items.len);
    const text = try testRowsText(a, rendered.items);
    try std.testing.expect(std.mem.indexOf(u8, text, "old") == null);
    try std.testing.expect(std.mem.indexOf(u8, text, "tool requested") == null);
    for (rendered.items[0..10]) |row| try std.testing.expectEqualDeep(dim.fg, row.style.fg);
    // A pending request is visible and does not increment the completed count.
    try entries.append(a, .{ .id = 19, .role = .assistant, .text = "", .parts = &.{.{ .kind = .tool_request, .toolName = "bash", .text = "[tool requested: bash]" }} });
    rendered.clearRetainingCapacity();
    try chatRows(ctx, &rendered, entries.items, 80, "Δ");
    try std.testing.expectEqualStrings("bash (×6)", rendered.items[0].text);
    try std.testing.expectEqualStrings("[tool requested: bash]", rendered.items[9].text);
    // Rendering is pure: earlier results and canonical IDs are unchanged.
    try std.testing.expectEqualStrings("old output must disappear", entries.items[2].parts.?[0].text);
    try std.testing.expectEqual(18, entries.items[17].id);
}

test "bash runs stop at messages, other tools and notices, including multiple results per entry" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    fw.DrawContext.init(.unicode);
    const ctx: fw.DrawContext = .{ .arena = a, .min = .{}, .max = .{ .width = 80, .height = 40 }, .cell_size = .{ .width = 8, .height = 16 } };
    const bash: wire.TuiPart = .{ .kind = .tool, .toolName = "bash", .text = "body" };
    const entries: []const wire.TuiEntry = &.{
        .{ .id = 1, .role = .tool, .text = "", .parts = &.{ bash, bash, .{ .kind = .tool, .toolName = "read", .text = "file body" }, bash, bash } },
        .{ .id = 2, .role = .assistant, .text = "", .parts = &.{.{ .kind = .text, .text = "Message boundary" }} },
        .{ .id = 3, .role = .tool, .text = "", .parts = &.{bash} },
        .{ .id = 4, .role = .note, .text = "", .parts = &.{.{ .kind = .notice, .text = "[retained notice]" }} },
        .{ .id = 5, .role = .tool, .text = "bash\nlegacy first" },
        .{ .id = 6, .role = .tool, .text = "bash (error)\nlegacy latest" },
    };
    var rendered: std.ArrayList(Row) = .empty;
    try chatRows(ctx, &rendered, entries, 80, "Δ");
    try std.testing.expectEqualStrings("bash (×2)\nbody\n\nread\nfile body\n\nbash (×2)\nbody\n\nMessage boundary\n\nbash\nbody\n\n[retained notice]\n\nbash (×2) (error)\nlegacy latest\n\n", try testRowsText(a, rendered.items));
    // Resizing bounds *visual* rows, including wide graphemes and final LF.
    const unicode = "界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界\nlast\n";
    for ([_]u16{ 4, 10, 80 }) |width| {
        rendered.clearRetainingCapacity();
        try toolPartRows(ctx, &rendered, .{ .kind = .tool, .toolName = "bash", .text = unicode, .clipped = true }, width, 1);
        try std.testing.expect(rendered.items.len <= 9);
        try std.testing.expectEqualStrings("last", rendered.items[rendered.items.len - 1].text);
        for (rendered.items) |row| try std.testing.expect(displayWidth(ctx, row.text) <= width);
    }
}
