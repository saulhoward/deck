//! One outstanding client request; nonblocking pipe I/O keeps terminal detach
//! independent of an HTTP deadline. This child is not the Pi writer.
const std = @import("std");
const Native = @import("native.zig");
const paths = @import("runtime_paths.zig");
const model_settings = @import("model_settings.zig");
const wire = @import("generated/contracts.zig");
const message_content = @import("message_content.zig");
const Bridge = @This();
const cap = 1024 * 1024;
a: std.mem.Allocator,
io: std.Io,
child: std.process.Child,
input: std.ArrayList(u8) = .empty,
output: std.ArrayList(u8) = .empty,
sent: usize = 0,
sequence: u64 = 0,
pending: ?wire.TuiRequest = null,
id_buf: [32]u8 = undefined,
target_buf: [20]u8 = undefined,
after_buf: [20]u8 = undefined,
before_buf: [20]u8 = undefined,
entry_buf: [20]u8 = undefined,
failed: bool = false,
hub_id: ?[]const u8 = null,
chat_id: ?[]const u8 = null,
hub_chat_id: ?[]const u8 = null,
inspect_parent_id: ?[]const u8 = null,
client_mode: wire.TuiClientMode = .hub,

pub fn start(native: Native, a: std.mem.Allocator, args: []const []const u8) !Bridge {
    return startEntry(native, a, "tui-bridge.js", args);
}
// Shared bounded child/pipe ownership; each renderer retains its own schema,
// reply correlation and authority checks. Entry names are native constants.
pub fn startEntry(native: Native, a: std.mem.Allocator, name: []const u8, args: []const []const u8) !Bridge {
    const node = try paths.node(native, a);
    defer a.free(node);
    const entry = try paths.entry(native, a, null, name);
    defer a.free(entry);
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(a);
    try argv.appendSlice(a, &.{ node, entry });
    try argv.appendSlice(a, args);
    // Client bridges need neither model/vault credentials nor Node/loader
    // injection. Preserve only client paths and native bootstrap provenance.
    var env = std.process.Environ.Map.init(a);
    defer env.deinit();
    for ([_][]const u8{ "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "REX_RUNTIME_DIR", "REX_BLOCK", "DECK_NODE", "DECK_RUNTIME_ROOT", "DECK_CLIENT_STATE_DIRECTORY" }) |key| if (native.environ.getPosix(key)) |value| try env.put(key, value);
    var child = try std.process.spawn(native.io, .{ .argv = argv.items, .environ_map = &env, .stdin = .pipe, .stdout = .pipe, .stderr = .ignore });
    errdefer {
        child.kill(native.io);
        Native.closeStreams(native.io, &child);
    }
    for ([_]std.Io.File{ child.stdin.?, child.stdout.? }) |file| {
        const flags = try Native.fcntl(file.handle, std.posix.F.GETFL, 0);
        const extra: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
        _ = try Native.fcntl(file.handle, std.posix.F.SETFL, flags | extra);
    }
    return .{ .a = a, .io = native.io, .child = child };
}
pub fn deinit(self: *Bridge) void {
    // EOF aborts the helper's HTTP observation/admission wait, never hub work.
    if (self.child.stdin) |file| file.close(self.io);
    self.child.stdin = null;
    if (self.child.id) |pid| {
        for (0..50) |_| {
            const waited = Native.waitNoHang(pid) catch break;
            if (waited.pid != 0) {
                self.child.id = null;
                break;
            }
            self.io.sleep(.fromMilliseconds(10), .awake) catch break;
        }
        if (self.child.id != null) self.child.kill(self.io);
    }
    Native.closeStreams(self.io, &self.child);
    self.input.deinit(self.a);
    self.output.deinit(self.a);
    if (self.hub_id) |id| self.a.free(id);
    if (self.chat_id) |id| self.a.free(id);
    if (self.hub_chat_id) |id| self.a.free(id);
    if (self.inspect_parent_id) |id| self.a.free(id);
}
pub fn request(self: *Bridge, action: @FieldType(wire.TuiRequest, "action"), text: ?[]const u8, hold: ?bool) !bool {
    return self.requestConfigured(action, text, hold, null, null, null, null, null, null, null, null);
}
pub fn configure(self: *Bridge, change: wire.ModelSettingsChange) !bool {
    return self.requestConfigured(.configure, null, null, change, null, null, null, null, null, null, null);
}
pub fn selectChat(self: *Bridge, chat_id: []const u8) !bool {
    return self.requestConfigured(.select, null, null, null, chat_id, null, null, null, null, null, null);
}
pub fn childOpen(self: *Bridge, child_id: []const u8) !bool {
    return self.requestConfigured(.childOpen, null, null, null, child_id, null, null, null, null, null, null);
}
pub fn tasks(self: *Bridge, after: ?[]const u8) !bool {
    return self.requestConfigured(.tasks, null, null, null, null, after, null, null, null, null, null);
}
/// Forward reads are scoped to one canonical ID, never a latest-page jump.
pub fn newer(self: *Bridge, after: i64) !bool {
    var buf: [20]u8 = undefined;
    const cursor = try std.fmt.bufPrint(&buf, "{d}", .{after});
    return self.requestConfigured(.newer, null, null, null, null, cursor, null, null, null, null, null);
}
pub fn older(self: *Bridge, before: ?i64) !bool {
    var buf: [20]u8 = undefined;
    const cursor = if (before) |id| try std.fmt.bufPrint(&buf, "{d}", .{id}) else null;
    return self.requestConfigured(.older, null, null, null, null, null, null, null, null, null, cursor);
}
pub fn createAt(self: *Bridge, target: wire.TaskCreationTarget) !bool {
    return self.requestConfigured(.create, null, null, null, null, null, target, null, null, null, null);
}
pub fn createForm(self: *Bridge, form: wire.TaskCreationForm) !bool {
    return self.requestConfigured(.create, null, null, null, null, null, null, form, null, null, null);
}
/// Read-only content of an entry in the already pinned selection. No chat
/// argument or navigation exception: captured task inspection remains read-only.
pub fn messageContent(self: *Bridge, entry_id: i64, offset: usize) !bool {
    // Do not overwrite entry_buf while a previous request still refers to it.
    if (self.failed or self.pending != null) return false;
    if (self.chat_id == null or entry_id <= 0 or entry_id > 9007199254740991 or offset > 16 * 1024 * 1024) return error.InvalidContract;
    const entry = try std.fmt.bufPrint(&self.entry_buf, "{d}", .{entry_id});
    return self.requestConfigured(.messageContent, null, null, null, null, null, null, null, entry, @intCast(offset), null);
}
fn requestConfigured(self: *Bridge, action: @FieldType(wire.TuiRequest, "action"), text: ?[]const u8, hold: ?bool, configuration: ?wire.ModelSettingsChange, chat_id: ?[]const u8, after: ?[]const u8, task_target: ?wire.TaskCreationTarget, task_form: ?wire.TaskCreationForm, entry_id: ?[]const u8, offset: ?i64, before: ?[]const u8) !bool {
    if (self.failed or self.pending != null) return false;
    if (self.client_mode == .task) {
        if (action == .select or action == .tasks or action == .hosts) return error.TaskLocked;
        if (action == .create) {
            const form = task_form orelse return error.TaskLocked;
            const parent = form.managedParentChatId orelse return error.TaskLocked;
            const own = self.chat_id orelse return error.TaskLocked;
            if (self.inspect_parent_id != null or !std.mem.eql(u8, parent, own)) return error.TaskLocked;
        }
        if (action == .childOpen and self.inspect_parent_id != null) return error.TaskLocked;
    }
    self.sequence += 1;
    const id = try std.fmt.bufPrint(&self.id_buf, "{d}", .{self.sequence});
    var request_value: wire.TuiRequest = .{ .version = 1, .id = id, .action = action, .text = text, .hold = hold, .configuration = configuration, .chatId = chat_id, .after = after, .before = before, .taskTarget = task_target, .taskForm = task_form, .entryId = entry_id, .offset = offset };
    const bytes = try std.json.Stringify.valueAlloc(self.a, request_value, .{});
    defer self.a.free(bytes);
    const checked = try std.json.parseFromSlice(std.json.Value, self.a, bytes, .{});
    defer checked.deinit();
    if (!validRequest(checked.value)) return error.InvalidContract;
    if (bytes.len > cap or (action == .send and (text == null or text.?.len == 0 or text.?.len > 16384))) return error.InvalidContract;
    self.output.clearRetainingCapacity();
    self.sent = 0;
    // Allocation/correlation failures before pending is installed must not leave
    // a partial frame for the resumed event loop to transmit.
    errdefer self.output.clearRetainingCapacity();
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(bytes.len), .big);
    try self.output.appendSlice(self.a, &header);
    try self.output.appendSlice(self.a, bytes);
    // Commands may be edited while waiting. Keep correlation targets owned,
    // not borrowed from the command buffer or an old display page.
    if (chat_id) |target| request_value.chatId = try std.fmt.bufPrint(&self.target_buf, "{s}", .{target});
    if (before) |cursor| request_value.before = try std.fmt.bufPrint(&self.before_buf, "{s}", .{cursor});
    if (after) |cursor| request_value.after = try std.fmt.bufPrint(&self.after_buf, "{s}", .{cursor});
    // The complete mutation payload is owned by output; reply correlation does
    // not retain borrowed JSON task-target strings after the command is parsed.
    request_value.taskTarget = null;
    request_value.taskForm = null;
    self.pending = request_value;
    return true;
}
pub fn validTaskTarget(value: std.json.Value) bool {
    if (!wire.validTaskCreationTarget(value)) return false;
    const cwd = value.object.get("cwd").?.string;
    const title = value.object.get("title").?.string;
    return @import("task_brief.zig").cwd(cwd) and @import("task_brief.zig").title(title) and @import("task_brief.zig").fields(value);
}
pub fn validRequest(value: std.json.Value) bool {
    if (!wire.validTuiRequest(value)) return false;
    const action = value.object.get("action").?.string;
    const text = value.object.get("text");
    if (std.mem.eql(u8, action, "select") or std.mem.eql(u8, action, "childOpen")) {
        if (!safeId(value.object.get("chatId") orelse return false)) return false;
    } else if (value.object.contains("chatId")) return false;
    if (std.mem.eql(u8, action, "messageContent")) {
        if (!safeId(value.object.get("entryId") orelse return false)) return false;
        const offset = value.object.get("offset") orelse return false;
        if (offset != .integer or offset.integer < 0 or offset.integer > 16 * 1024 * 1024) return false;
    } else if (value.object.contains("entryId") or value.object.contains("offset")) return false;
    if (value.object.get("after")) |after| if ((!std.mem.eql(u8, action, "tasks") and !std.mem.eql(u8, action, "newer")) or !safeId(after)) return false;
    if (std.mem.eql(u8, action, "newer") and !value.object.contains("after")) return false;
    if (value.object.get("before")) |before| if (!std.mem.eql(u8, action, "older") or !safeId(before)) return false;
    if (value.object.contains("hold") and !std.mem.eql(u8, action, "poll")) return false;
    if ((value.object.contains("taskTarget") or value.object.contains("taskForm")) and !std.mem.eql(u8, action, "create")) return false;
    if (value.object.contains("taskTarget") and value.object.contains("taskForm")) return false;
    if (std.mem.eql(u8, action, "configure")) return value.object.contains("configuration") and text == null;
    if (value.object.contains("configuration")) return false;
    if (value.object.get("taskForm")) |form| return std.mem.eql(u8, action, "create") and text == null and @import("task_brief.zig").form(form);
    if (value.object.get("taskTarget")) |target| return std.mem.eql(u8, action, "create") and text == null and validTaskTarget(target);
    if (std.mem.eql(u8, action, "subagent")) return wire.validAgentNameQuery(text orelse return false);
    if (std.mem.eql(u8, action, "send") or std.mem.eql(u8, action, "create")) {
        const content = text orelse return false;
        return content.string.len <= (if (std.mem.eql(u8, action, "create")) @as(usize, 200) else 16384) and std.mem.trim(u8, content.string, " \t\r\n").len > 0;
    }
    return text == null;
}
fn safeId(value: std.json.Value) bool {
    return wire.validPiId(value) and (std.fmt.parseInt(u64, value.string, 10) catch return false) <= 9007199254740991;
}
// Match the structured presentation to its bounded flat compatibility text.
// No bracket heuristics: only explicit part kinds carry UI provenance.
fn consumeText(remaining: *[]const u8, prefix: []const u8) bool {
    if (!std.mem.startsWith(u8, remaining.*, prefix)) return false;
    remaining.* = remaining.*[prefix.len..];
    return true;
}
fn validEntryParts(entry: std.json.Value) bool {
    var remaining = entry.object.get("text").?.string;
    if (remaining.len > 8192) return false;
    const parts = entry.object.get("parts") orelse return true;
    for (parts.array.items, 0..) |part, index| {
        if (index > 0 and !consumeText(&remaining, "\n")) return false;
        if (std.mem.eql(u8, part.object.get("kind").?.string, "tool")) {
            if (part.object.get("toolName")) |name| if (!consumeText(&remaining, name.string)) return false;
            if (part.object.get("isError")) |failed| if (failed.bool and !consumeText(&remaining, " (error)")) return false;
            if (!consumeText(&remaining, "\n")) return false;
        }
        if (!consumeText(&remaining, part.object.get("text").?.string)) return false;
    }
    return remaining.len == 0;
}
pub fn validReply(value: std.json.Value, expected: []const u8, hub_id: ?[]const u8, chat_id: ?[]const u8) bool {
    return validReplyContext(value, expected, hub_id, chat_id, null);
}
/// Payload-bearing reads are correlated to the outstanding request, never to
/// display entries or a newly returned selection. Ordinary replies forbid them.
pub fn validReplyAction(value: std.json.Value, request_value: wire.TuiRequest, hub_id: ?[]const u8, chat_id: ?[]const u8) bool {
    return validReplyContext(value, request_value.id, hub_id, chat_id, request_value);
}
fn validReplyContext(value: std.json.Value, expected: []const u8, hub_id: ?[]const u8, chat_id: ?[]const u8, request_value: ?wire.TuiRequest) bool {
    if (!wire.validTuiResponse(value) or !std.mem.eql(u8, value.object.get("id").?.string, expected)) return false;
    if (!value.object.get("ok").?.bool) return true;
    const s = value.object.get("snapshot").?;
    if (request_value != null and request_value.?.action == .messageContent) {
        const page = s.object.get("messageContent") orelse return false;
        var args: std.json.Value = .{ .object = .empty };
        defer args.object.deinit(std.heap.page_allocator);
        args.object.put(std.heap.page_allocator, "chatId", .{ .string = chat_id orelse return false }) catch return false;
        args.object.put(std.heap.page_allocator, "entryId", .{ .string = request_value.?.entryId orelse return false }) catch return false;
        args.object.put(std.heap.page_allocator, "offset", .{ .integer = request_value.?.offset orelse return false }) catch return false;
        if (!message_content.validArgs(args) or !message_content.validPage(args, page)) return false;
    } else if (s.object.contains("messageContent")) return false;
    if (request_value != null and request_value.?.action == .newer) {
        const after = request_value.?.after orelse return false;
        const echo = s.object.get("newerAfter") orelse return false;
        const found = s.object.get("newerFound") orelse return false;
        if (!safeId(echo) or !std.mem.eql(u8, after, echo.string)) return false;
        const boundary = std.fmt.parseInt(i64, after, 10) catch return false;
        var last = boundary;
        var message = false;
        if (found.bool) for (s.object.get("entries").?.array.items) |entry| {
            const raw = entry.object.get("id").?;
            const id: i64 = if (raw == .integer) raw.integer else @intFromFloat(raw.float);
            if (id <= boundary) return false;
            last = id;
            const role = entry.object.get("role").?.string;
            if (!std.mem.eql(u8, role, "tool")) {
                if (entry.object.get("parts")) |parts| {
                    for (parts.array.items) |part| {
                        if (std.mem.eql(u8, part.object.get("kind").?.string, "text") and part.object.get("text").?.string.len > 0) message = true;
                    }
                } else if (!std.mem.eql(u8, role, "note") and entry.object.get("text").?.string.len > 0) message = true;
            }
        };
        if (found.bool and !message) return false;
        if (s.object.get("newerNext")) |next| {
            if (!safeId(next)) return false;
            const n = std.fmt.parseInt(i64, next.string, 10) catch return false;
            if (n <= boundary or n < last) return false;
        }
    } else if (s.object.contains("newerAfter") or s.object.contains("newerFound") or s.object.contains("newerNext")) return false;
    if (hub_id) |id| if (!std.mem.eql(u8, id, s.object.get("hubId").?.string)) return false;
    const chat = s.object.get("chatId").?.string;
    if (!@import("managed_child.zig").validLink(s.object.get("chatId").?, s)) return false;
    if ((std.fmt.parseInt(u64, chat, 10) catch return false) > 9007199254740991) return false;
    if (chat_id) |id| if (!std.mem.eql(u8, id, chat)) return false;
    if (!@import("tool_inventory.zig").validInventoryFields(s)) return false;
    const hub_chat = s.object.get("hubChatId").?;
    if (!safeId(hub_chat)) return false;
    const task_mode = std.mem.eql(u8, s.object.get("clientMode").?.string, "task");
    const at_hub = std.mem.eql(u8, chat, hub_chat.string);
    if (task_mode and (at_hub or s.object.contains("tasks") or s.object.contains("hosts"))) return false;
    if (s.object.get("hosts")) |hosts| if (!@import("hub.zig").validHosts(hosts)) return false;
    if (s.object.get("brief")) |brief| if (!@import("task_brief.zig").valid(brief)) return false;
    const child = if (s.object.get("kind")) |kind| std.mem.eql(u8, kind.string, "subagent") else false;
    if (((!task_mode and !at_hub) or child) and s.object.get("draft").? != .null) return false;
    if (s.object.get("inspectParentChatId")) |parent| {
        if (!safeId(parent) or !child or at_hub or s.object.contains("tasks") or s.object.contains("hosts") or s.object.contains("rex") or (task_mode and std.mem.eql(u8, parent.string, hub_chat.string)) or (std.fmt.parseInt(u64, parent.string, 10) catch return false) >= (std.fmt.parseInt(u64, chat, 10) catch return false)) return false;
    }
    if (s.object.get("tasks")) |page| {
        var previous: u64 = 0;
        if (page.object.get("after")) |after| {
            if (!safeId(after)) return false;
            previous = std.fmt.parseInt(u64, after.string, 10) catch return false;
        }
        const first_cursor = previous;
        for (page.object.get("items").?.array.items) |row| {
            const id = row.object.get("chatId").?;
            if (!safeId(id) or !@import("managed_child.zig").validLink(id, row)) return false;
            const n = std.fmt.parseInt(u64, id.string, 10) catch return false;
            if (n <= previous) return false;
            if (row.object.get("parentChatId")) |parent| {
                if (!safeId(parent) or !std.mem.eql(u8, row.object.get("kind").?.string, "subagent") or (std.fmt.parseInt(u64, parent.string, 10) catch return false) >= n) return false;
            }
            previous = n;
        }
        if (page.object.get("next")) |next| {
            if (!safeId(next)) return false;
            const n = std.fmt.parseInt(u64, next.string, 10) catch return false;
            if (n <= first_cursor or n < previous) return false;
        }
    }
    if (s.object.get("rex")) |rex| {
        var args: std.json.Value = .{ .object = .empty };
        defer args.object.deinit(std.heap.page_allocator);
        args.object.put(std.heap.page_allocator, "chatId", .{ .string = chat }) catch return false;
        if (!@import("rex_open.zig").validReply("rex_status", args, s.object.get("hubId").?, rex.object.get("status").?)) return false;
        if (rex.object.get("inspection")) |inspection| if (!@import("rex_open.zig").validReply("rex_inspect", args, s.object.get("hubId").?, inspection)) return false;
    }
    if (s.object.get("agentStatus")) |status| if (!@import("views.zig").validAgentStatus(status)) return false;
    if (s.object.get("subagents")) |children| if (!@import("views.zig").validSubagents(children, s.object.get("chatId"))) return false;
    if (s.object.get("modelSettings")) |settings| {
        if (!model_settings.validSnapshot(settings) or !std.mem.eql(u8, settings.object.get("hubId").?.string, s.object.get("hubId").?.string) or !std.mem.eql(u8, settings.object.get("chatId").?.string, chat)) return false;
    }
    if (s.object.get("admittedInputs")) |inputs| {
        if (s.object.contains("inspectParentChatId") or child or (!task_mode and !at_hub)) return false;
        for (inputs.array.items, 0..) |input, i| {
            if (input.object.get("text").?.string.len > 8192) return false;
            for (inputs.array.items[0..i]) |prior| if (std.mem.eql(u8, prior.object.get("requestId").?.string, input.object.get("requestId").?.string)) return false;
        }
    }
    var previous: f64 = 0;
    var text_bytes: usize = 0;
    for (s.object.get("entries").?.array.items) |entry| {
        if (!validEntryParts(entry)) return false;
        text_bytes += entry.object.get("text").?.string.len;
        if (text_bytes > 128 * 1024) return false;
        const raw = entry.object.get("id").?;
        const n: f64 = if (raw == .integer) @floatFromInt(raw.integer) else raw.float;
        if (n <= previous) return false;
        previous = n;
    }
    return true;
}
// Inspection is the only task-client navigation exception. Ordinary replies
// cannot enter/leave it, and every child/sibling retains its original parent.
fn validNavigation(value: std.json.Value, action: @FieldType(wire.TuiRequest, "action"), chat: ?[]const u8, parent: ?[]const u8) bool {
    if (!value.object.get("ok").?.bool) return true;
    const snapshot = value.object.get("snapshot").?;
    const next = snapshot.object.get("inspectParentChatId");
    if (action == .subagent) {
        const expected = parent orelse chat orelse return false;
        return next != null and std.mem.eql(u8, expected, next.?.string);
    }
    if (action == .parent) return parent != null and next == null and std.mem.eql(u8, parent.?, snapshot.object.get("chatId").?.string);
    if (action == .select) return next == null;
    return (parent == null and next == null) or (parent != null and next != null and std.mem.eql(u8, parent.?, next.?.string));
}
pub fn poll(self: *Bridge) !?std.json.Parsed(wire.TuiResponse) {
    if (self.failed) return null;
    return self.receive() catch |err| {
        self.failed = true;
        return err;
    };
}
fn receive(self: *Bridge) !?std.json.Parsed(wire.TuiResponse) {
    if (self.sent < self.output.items.len) {
        const bytes = self.output.items[self.sent..];
        const n = std.c.write(self.child.stdin.?.handle, bytes.ptr, bytes.len);
        switch (std.c.errno(n)) {
            .SUCCESS => self.sent += @intCast(n),
            .AGAIN, .INTR => {},
            else => return error.BridgeWriteFailed,
        }
    }
    var buffer: [65536]u8 = undefined;
    const n = std.posix.read(self.child.stdout.?.handle, &buffer) catch |err| switch (err) {
        error.WouldBlock => return null,
        else => return err,
    };
    if (n == 0) return error.BridgeClosed;
    if (self.input.items.len + n > cap + 4) return error.InvalidFrame;
    try self.input.appendSlice(self.a, buffer[0..n]);
    if (self.input.items.len < 4) return null;
    const length = std.mem.readInt(u32, self.input.items[0..4], .big);
    if (length == 0 or length > cap) return error.InvalidFrame;
    if (self.input.items.len < length + 4) return null;
    if (self.input.items.len != length + 4) return error.InvalidFrame;
    const pending = self.pending orelse return error.InvalidFrame;
    const body = self.input.items[4..];
    if (!std.unicode.utf8ValidateSlice(body)) return error.InvalidFrame;
    const raw = try std.json.parseFromSlice(std.json.Value, self.a, body, .{});
    defer raw.deinit();
    if (!validReplyAction(raw.value, pending, self.hub_id, if (pending.action == .select) pending.chatId else if (pending.action == .subagent) null else if (pending.action == .parent) self.inspect_parent_id else self.chat_id)) return error.InvalidFrame;
    if (!validNavigation(raw.value, pending.action, self.chat_id, self.inspect_parent_id)) return error.InvalidFrame;
    // Own all strings: the receive buffer is reused while the UI retains the
    // last valid snapshot. Shape/semantic guards ran on the original bytes above.
    const parsed = try std.json.parseFromSlice(wire.TuiResponse, self.a, body, .{ .allocate = .alloc_always });
    errdefer parsed.deinit();
    if (parsed.value == .case0) {
        const s = parsed.value.case0.snapshot;
        if (s.clientMode != self.client_mode) return error.InvalidFrame;
        if (self.hub_chat_id) |id| if (!std.mem.eql(u8, id, s.hubChatId)) return error.InvalidFrame;
        if ((pending.action == .models or pending.action == .configure) and s.modelSettings == null) return error.InvalidFrame;
        if (pending.action == .hosts and s.hosts == null) return error.InvalidFrame;
        if (pending.action == .tasks) {
            const page = s.tasks orelse return error.InvalidFrame;
            if ((pending.after == null) != (page.after == null) or (pending.after != null and !std.mem.eql(u8, pending.after.?, page.after.?))) return error.InvalidFrame;
        }
        if ((pending.action == .rexStatus or pending.action == .rexInspect) and s.rex == null) return error.InvalidFrame;
        if (pending.action == .rexInspect and s.rex.?.inspection == null) return error.InvalidFrame;
        if (self.hub_id == null) self.hub_id = try self.a.dupe(u8, s.hubId);
        if (self.hub_chat_id == null) self.hub_chat_id = try self.a.dupe(u8, s.hubChatId);
        if (self.chat_id == null or pending.action == .select or pending.action == .subagent or pending.action == .parent) {
            const next = try self.a.dupe(u8, s.chatId);
            if (self.chat_id) |old| self.a.free(old);
            self.chat_id = next;
        }
        const parent = if (s.inspectParentChatId) |id| try self.a.dupe(u8, id) else null;
        if (self.inspect_parent_id) |old| self.a.free(old);
        self.inspect_parent_id = parent;
    }
    self.input.clearRetainingCapacity();
    self.output.clearRetainingCapacity();
    self.pending = null;
    return parsed;
}

pub const TestPipe = struct {
    bridge: Bridge,
    peer_read: std.posix.fd_t,
    peer_write: std.posix.fd_t,
    pub fn init() !@This() {
        const input = try Native.pipe();
        errdefer for (input) |fd| Native.close(fd);
        const output = try Native.pipe();
        errdefer for (output) |fd| Native.close(fd);
        const flags = try Native.fcntl(output[0], std.posix.F.GETFL, 0);
        _ = try Native.fcntl(output[0], std.posix.F.SETFL, flags | @as(u32, @bitCast(std.posix.O{ .NONBLOCK = true })));
        return .{ .peer_read = input[0], .peer_write = output[1], .bridge = .{
            .a = std.testing.allocator,
            .io = std.testing.io,
            .child = .{ .id = null, .thread_handle = {}, .stdin = .{ .handle = input[1], .flags = .{ .nonblocking = false } }, .stdout = .{ .handle = output[0], .flags = .{ .nonblocking = true } }, .stderr = null, .request_resource_usage_statistics = false },
        } };
    }
    pub fn deinit(self: *@This()) void {
        self.bridge.deinit();
        Native.close(self.peer_read);
        if (self.peer_write >= 0) Native.close(self.peer_write);
    }
    pub fn reply(self: *@This(), bytes: []const u8) !void {
        const file: std.Io.File = .{ .handle = self.peer_write, .flags = .{ .nonblocking = false } };
        var header: [4]u8 = undefined;
        std.mem.writeInt(u32, &header, @intCast(bytes.len), .big);
        try file.writeStreamingAll(std.testing.io, &header);
        try file.writeStreamingAll(std.testing.io, bytes);
    }
};
test "renderer pipe fences invalid/lost replies, owns strings, and never queues mutations" {
    for ([_][]const u8{ "\xff", "{", "{\"version\":1,\"id\":\"wrong\",\"ok\":false,\"error\":\"unconfirmed\"}" }) |bytes| {
        var fixture = try TestPipe.init();
        defer fixture.deinit();
        try std.testing.expect(try fixture.bridge.request(.send, "exact text", null));
        try std.testing.expect(!try fixture.bridge.request(.send, "not queued", null));
        try fixture.reply(bytes);
        if (fixture.bridge.poll()) |_| return error.AcceptedInvalidReply else |_| {}
        try std.testing.expect(fixture.bridge.failed);
        try std.testing.expect(!try fixture.bridge.request(.retry, null, null));
        try std.testing.expectEqual(1, fixture.bridge.sequence);
    }
    {
        var lost = try TestPipe.init();
        defer lost.deinit();
        try std.testing.expect(try lost.bridge.request(.send, "original", null));
        Native.close(lost.peer_write);
        lost.peer_write = -1;
        try std.testing.expectError(error.BridgeClosed, lost.bridge.poll());
        try std.testing.expect(lost.bridge.failed);
        try std.testing.expect(!try lost.bridge.request(.retry, null, null));
    }
    {
        var oversized = try TestPipe.init();
        defer oversized.deinit();
        try std.testing.expect(try oversized.bridge.request(.poll, null, false));
        var header: [4]u8 = undefined;
        std.mem.writeInt(u32, &header, cap + 1, .big);
        const file: std.Io.File = .{ .handle = oversized.peer_write, .flags = .{ .nonblocking = false } };
        try file.writeStreamingAll(std.testing.io, &header);
        try std.testing.expectError(error.InvalidFrame, oversized.bridge.poll());
        try std.testing.expect(oversized.bridge.failed);
    }
    var fixture = try TestPipe.init();
    defer fixture.deinit();
    try std.testing.expect(try fixture.bridge.request(.poll, null, false));
    try fixture.reply("{\"version\":1,\"id\":\"1\",\"ok\":false,\"error\":\"first owned string\"}");
    const first = (try fixture.bridge.poll()).?;
    defer first.deinit();
    try std.testing.expect(try fixture.bridge.request(.poll, null, false));
    try fixture.reply("{\"version\":1,\"id\":\"2\",\"ok\":false,\"error\":\"second snapshotxx\"}");
    const second = (try fixture.bridge.poll()).?;
    defer second.deinit();
    try std.testing.expectEqualStrings("first owned string", first.value.case1.@"error");
    try fixture.reply("{\"version\":1,\"id\":\"2\",\"ok\":false,\"error\":\"duplicate\"}");
    try std.testing.expectError(error.InvalidFrame, fixture.bridge.poll());
    try std.testing.expect(fixture.bridge.failed);
}

test "task page cursors and nested Rex observations validate before display" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixtures = try std.json.parseFromSlice(std.json.Value, a, @embedFile("contracts.test.json"), .{});
    var snapshot = fixtures.value.object.get("bases").?.object.get("TuiSnapshot").?;
    var response = (try std.json.parseFromSlice(std.json.Value, a, "{\"version\":1,\"id\":\"1\",\"ok\":true}", .{})).value;
    for ([_]struct { text: []const u8, valid: bool }{
        .{ .text = "{\"items\":[],\"after\":\"1\",\"next\":\"2\"}", .valid = true },
        .{ .text = "{\"items\":[],\"after\":\"2\",\"next\":\"2\"}", .valid = false },
        .{ .text = "{\"items\":[],\"next\":\"9007199254740992\"}", .valid = false },
        .{ .text = "{\"items\":[{\"chatId\":\"2\",\"kind\":\"task\",\"title\":\"x\",\"cwd\":\"/saved\",\"machineId\":\"worker\"}],\"after\":\"2\"}", .valid = false },
    }) |case| {
        const page = try std.json.parseFromSlice(std.json.Value, a, case.text, .{});
        try snapshot.object.put(a, "tasks", page.value);
        try response.object.put(a, "snapshot", snapshot);
        try std.testing.expectEqual(case.valid, validReply(response, "1", "hub", "1"));
    }
    _ = snapshot.object.swapRemove("tasks");
    const rex = fixtures.value.object.get("bases").?.object.get("TuiRex").?;
    try snapshot.object.put(a, "rex", rex);
    try snapshot.object.put(a, "hubId", .{ .string = "11111111-1111-4111-8111-111111111111" });
    try snapshot.object.put(a, "chatId", .{ .string = "2" });
    try response.object.put(a, "snapshot", snapshot);
    try std.testing.expect(validReply(response, "1", null, null));
    try snapshot.object.put(a, "chatId", .{ .string = "1" });
    try response.object.put(a, "snapshot", snapshot);
    try std.testing.expect(!validReply(response, "1", null, null));
}

test "task selection pins only the requested chat and owns correlation bytes" {
    var fixture = try TestPipe.init();
    defer fixture.deinit();
    fixture.bridge.hub_id = try std.testing.allocator.dupe(u8, "hub");
    fixture.bridge.chat_id = try std.testing.allocator.dupe(u8, "1");
    var target = [_]u8{'2'};
    try std.testing.expect(try fixture.bridge.selectChat(&target));
    target[0] = '3';
    try fixture.reply("{\"version\":1,\"id\":\"1\",\"ok\":true,\"snapshot\":{\"clientMode\":\"hub\",\"hubChatId\":\"1\",\"hubId\":\"hub\",\"chatId\":\"2\",\"title\":\"Task\",\"model\":\"mock\",\"tools\":\"offline\",\"activityKnown\":false,\"busy\":false,\"queued\":0,\"entries\":[],\"hasOlder\":false,\"historical\":false,\"preview\":\"\",\"notice\":\"\",\"draft\":null}}");
    const selected = (try fixture.bridge.poll()).?;
    selected.deinit();
    try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    try std.testing.expect(try fixture.bridge.selectChat("3"));
    try fixture.reply("{\"version\":1,\"id\":\"2\",\"ok\":false,\"error\":\"Selection refused\"}");
    const refused = (try fixture.bridge.poll()).?;
    refused.deinit();
    try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    try std.testing.expect(try fixture.bridge.request(.poll, null, false));
    try fixture.reply("{\"version\":1,\"id\":\"3\",\"ok\":true,\"snapshot\":{\"clientMode\":\"hub\",\"hubChatId\":\"1\",\"hubId\":\"hub\",\"chatId\":\"1\",\"title\":\"Old\",\"model\":\"mock\",\"tools\":\"offline\",\"activityKnown\":false,\"busy\":false,\"queued\":0,\"entries\":[],\"hasOlder\":false,\"historical\":false,\"preview\":\"\",\"notice\":\"\",\"draft\":null}}");
    try std.testing.expectError(error.InvalidFrame, fixture.bridge.poll());
    try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    try std.testing.expect(fixture.bridge.failed);
}

test "task bridge pins client mode and hub chat identity and refuses navigation" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_]bool{ false, true }) |change_mode| {
        var fixture = try TestPipe.init();
        defer fixture.deinit();
        fixture.bridge.client_mode = .task;
        try std.testing.expectError(error.TaskLocked, fixture.bridge.selectChat("1"));
        try std.testing.expectError(error.TaskLocked, fixture.bridge.tasks(null));
        try std.testing.expectError(error.TaskLocked, fixture.bridge.request(.create, "no", null));
        const bases = try std.json.parseFromSlice(std.json.Value, a, @embedFile("contracts.test.json"), .{});
        var snapshot = bases.value.object.get("bases").?.object.get("TuiSnapshot").?;
        try snapshot.object.put(a, "clientMode", .{ .string = "task" });
        try snapshot.object.put(a, "chatId", .{ .string = "2" });
        var response = (try std.json.parseFromSlice(std.json.Value, a, "{\"version\":1,\"id\":\"1\",\"ok\":true}", .{})).value;
        try response.object.put(a, "snapshot", snapshot);
        try std.testing.expect(try fixture.bridge.request(.poll, null, false));
        try fixture.reply(try std.json.Stringify.valueAlloc(a, response, .{}));
        const first = (try fixture.bridge.poll()).?;
        first.deinit();
        try std.testing.expectEqualStrings("1", fixture.bridge.hub_chat_id.?);
        try snapshot.object.put(a, if (change_mode) "clientMode" else "hubChatId", .{ .string = if (change_mode) "hub" else "3" });
        try response.object.put(a, "snapshot", snapshot);
        try response.object.put(a, "id", .{ .string = "2" });
        try std.testing.expect(try fixture.bridge.request(.poll, null, false));
        try fixture.reply(try std.json.Stringify.valueAlloc(a, response, .{}));
        try std.testing.expectError(error.InvalidFrame, fixture.bridge.poll());
        try std.testing.expect(fixture.bridge.failed);
        try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    }
}

test "renderer boundary correlates transport, chat, hub and canonical history before display" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixture = try std.json.parseFromSlice(std.json.Value, a, @embedFile("contracts.test.json"), .{});
    var snapshot = fixture.value.object.get("bases").?.object.get("TuiSnapshot").?;
    var response = (try std.json.parseFromSlice(std.json.Value, a, "{\"version\":1,\"id\":\"1\",\"ok\":true}", .{})).value;
    try response.object.put(a, "snapshot", snapshot);
    try std.testing.expect(validReply(response, "1", "hub", "1"));
    try std.testing.expect(!validReply(response, "wrong", "hub", "1"));
    try std.testing.expect(!validReply(response, "1", "wrong", "1"));
    try std.testing.expect(!validReply(response, "1", "hub", "2"));
    for ([_]@FieldType(wire.TuiRequest, "action"){ .models, .configure }) |action| {
        var pipe = try TestPipe.init();
        defer pipe.deinit();
        if (action == .models) {
            try std.testing.expect(try pipe.bridge.request(.models, null, null));
        } else {
            const selection: wire.ModelSelection = .{ .provider = "mock", .modelId = "alpha", .thinkingLevel = .medium };
            try std.testing.expect(try pipe.bridge.configure(.{ .expected = selection, .selection = selection }));
        }
        try pipe.reply(try std.json.Stringify.valueAlloc(a, response, .{}));
        try std.testing.expectError(error.InvalidFrame, pipe.bridge.poll());
        try std.testing.expect(pipe.bridge.failed);
    }
    var settings = fixture.value.object.get("bases").?.object.get("ModelSettingsSnapshot").?;
    try snapshot.object.put(a, "modelSettings", settings);
    try response.object.put(a, "snapshot", snapshot);
    try std.testing.expect(validReply(response, "1", "hub", "1"));
    try settings.object.put(a, "chatId", .{ .string = "2" });
    try snapshot.object.put(a, "modelSettings", settings);
    try response.object.put(a, "snapshot", snapshot);
    try std.testing.expect(!validReply(response, "1", "hub", "1"));
    _ = snapshot.object.swapRemove("modelSettings");
    const entries = (try std.json.parseFromSlice(std.json.Value, a, "[{\"id\":2,\"role\":\"user\",\"text\":\"x\"},{\"id\":1,\"role\":\"assistant\",\"text\":\"y\"}]", .{})).value;
    try snapshot.object.put(a, "entries", entries);
    try response.object.put(a, "snapshot", snapshot);
    try std.testing.expect(!validReply(response, "1", null, null));
    const target: wire.TaskCreationTarget = .{ .machineId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .cwd = "/remote workspace 🧪", .title = " exact title " };
    var create_pipe = try TestPipe.init();
    defer create_pipe.deinit();
    create_pipe.bridge.client_mode = .task;
    try std.testing.expectError(error.TaskLocked, create_pipe.bridge.createAt(target));
    create_pipe.bridge.client_mode = .hub;
    try std.testing.expect(try create_pipe.bridge.createAt(target));
    const creation = try std.json.parseFromSlice(std.json.Value, a, create_pipe.bridge.output.items[4..], .{});
    try std.testing.expect(validRequest(creation.value));
    var creation_value = creation.value;
    try creation_value.object.put(a, "action", .{ .string = "send" });
    try std.testing.expect(!validRequest(creation_value));
    try creation_value.object.put(a, "action", .{ .string = "create" });
    try creation_value.object.getPtr("taskTarget").?.object.put(a, "cwd", .{ .string = "relative" });
    try std.testing.expect(!validRequest(creation_value));
    for ([_][]const u8{
        "{\"version\":1,\"id\":\"1\",\"action\":\"send\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"send\",\"text\":\" \"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"send\",\"text\":\"x\",\"hold\":true}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"poll\",\"text\":\"x\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"configure\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"childOpen\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"childOpen\",\"chatId\":\"9007199254740992\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"childOpen\",\"chatId\":\"3\",\"text\":\"x\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"select\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"select\",\"chatId\":\"9007199254740992\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"poll\",\"chatId\":\"2\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"rexOpen\",\"text\":\"x\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"send\",\"text\":\"x\",\"after\":\"1\"}",
    }) |bytes| {
        const raw = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
        try std.testing.expect(!validRequest(raw.value));
    }
}

test "structured content matches flat text and byte bounds before renderer display" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var response = (try std.json.parseFromSlice(std.json.Value, a,
        \\{"version":1,"id":"1","ok":true,"snapshot":{"clientMode":"hub","hubChatId":"1","hubId":"hub","chatId":"1","title":"Task","model":"mock","tools":"offline","activityKnown":false,"busy":false,"queued":0,"entries":[],"hasOlder":false,"historical":false,"preview":"","notice":"","draft":null}}
    , .{})).value;
    const snapshot = response.object.getPtr("snapshot").?;
    for ([_]struct { entries: []const u8, valid: bool }{
        .{ .entries = "[{\"id\":1,\"role\":\"assistant\",\"text\":\"[error]\"}]", .valid = true },
        .{ .entries = "[{\"id\":1,\"role\":\"assistant\",\"text\":\"\",\"parts\":[]}]", .valid = true },
        .{ .entries = "[{\"id\":1,\"role\":\"assistant\",\"text\":\"must not vanish\",\"parts\":[]}]", .valid = false },
        .{ .entries = "[{\"id\":1,\"role\":\"assistant\",\"text\":\"body\\n[error]\",\"parts\":[{\"kind\":\"text\",\"text\":\"body\"},{\"kind\":\"notice\",\"text\":\"[error]\"}]}]", .valid = true },
        .{ .entries = "[{\"id\":1,\"role\":\"tool\",\"text\":\"bash (error)\\noutput\",\"parts\":[{\"kind\":\"tool\",\"toolName\":\"bash\",\"isError\":true,\"clipped\":true,\"text\":\"output\"}]}]", .valid = true },
        .{ .entries = "[{\"id\":1,\"role\":\"tool\",\"text\":\"bash\\noutput\",\"parts\":[{\"kind\":\"tool\",\"toolName\":\"bash\",\"isError\":true,\"text\":\"output\"}]}]", .valid = false },
    }) |case| {
        try snapshot.object.put(a, "entries", (try std.json.parseFromSlice(std.json.Value, a, case.entries, .{})).value);
        try std.testing.expectEqual(case.valid, validReply(response, "1", "hub", "1"));
    }
    for ([_]usize{ 8192, 8193 }) |length| {
        const text = try a.alloc(u8, length);
        @memset(text, 'a');
        const encoded = try std.json.Stringify.valueAlloc(a, [_]wire.TuiEntry{.{ .id = 1, .role = .assistant, .text = text, .parts = &.{.{ .kind = .text, .text = text }} }}, .{});
        try snapshot.object.put(a, "entries", (try std.json.parseFromSlice(std.json.Value, a, encoded, .{})).value);
        try std.testing.expectEqual(length == 8192, validReply(response, "1", "hub", "1"));
    }
    const payload = try a.alloc(u8, 8192);
    @memset(payload, 'x');
    var entries: [17]wire.TuiEntry = undefined;
    for (&entries, 0..) |*entry, index| entry.* = .{ .id = @intCast(index + 1), .role = .assistant, .text = payload };
    for ([_]usize{ 16, 17 }) |length| {
        const encoded = try std.json.Stringify.valueAlloc(a, entries[0..length], .{});
        try snapshot.object.put(a, "entries", (try std.json.parseFromSlice(std.json.Value, a, encoded, .{})).value);
        try std.testing.expectEqual(length == 16, validReply(response, "1", "hub", "1"));
    }
}

test "renderer subagent samples validate nested semantics and selected-chat scope before display" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var response = (try std.json.parseFromSlice(std.json.Value, a,
        \\{"version":1,"id":"1","ok":true,"snapshot":{"clientMode":"hub","hubChatId":"1","hubId":"hub","chatId":"1","title":"Task","model":"mock","tools":"offline","activityKnown":false,"busy":false,"queued":0,"entries":[],"hasOlder":false,"historical":false,"preview":"","notice":"","draft":null}}
    , .{})).value;
    const snapshot = response.object.getPtr("snapshot").?;
    // Reuse the shared semantic corpus at the final native renderer boundary.
    // Request-shape and outer-request scope cases belong to the live-view guard.
    const fixtures = try std.json.parseFromSlice(std.json.Value, a, @embedFile("views.test.json"), .{});
    for (fixtures.value.array.items) |fixture| {
        if (!std.mem.startsWith(u8, fixture.object.get("name").?.string, "subagents ")) continue;
        const args = fixture.object.get("args").?;
        if (!@import("views.zig").validArgs("activity", args)) continue;
        const activity = fixture.object.get("result").?;
        const chat = activity.object.get("chatId").?;
        if (args == .object) if (args.object.get("chatId")) |requested| {
            if (!std.mem.eql(u8, requested.string, chat.string)) continue;
        };
        try snapshot.object.put(a, "chatId", chat);
        _ = snapshot.object.swapRemove("subagents");
        if (activity.object.get("subagents")) |children| try snapshot.object.put(a, "subagents", children);
        const expected = fixture.object.get("valid").?.bool;
        // Even on first reply without an externally pinned chat, nested samples
        // must bind to the containing snapshot, never an arbitrary parent.
        if (validReply(response, "1", "hub", null) != expected or validReply(response, "1", "hub", chat.string) != expected) {
            std.debug.print("renderer subagent fixture failed: {s}\n", .{fixture.object.get("name").?.string});
            return error.InvalidSubagentContract;
        }
    }
    // A selected task's children are scoped to that task, not the hub chat.
    try snapshot.object.put(a, "chatId", .{ .string = "2" });
    for ([_][]const u8{ "hub", "task" }) |mode| {
        try snapshot.object.put(a, "clientMode", .{ .string = mode });
        for ([_]struct { parent: []const u8, valid: bool }{
            .{ .parent = "2", .valid = true },
            .{ .parent = "1", .valid = false },
            .{ .parent = "3", .valid = false },
        }) |case| {
            var children = (try std.json.parseFromSlice(std.json.Value, a,
                \\{"chatId":"2","items":[{"chatId":"4","title":"Child","status":{"state":"working"}}],"hasMore":false}
            , .{})).value;
            try children.object.put(a, "chatId", .{ .string = case.parent });
            try snapshot.object.put(a, "subagents", children);
            try std.testing.expectEqual(case.valid, validReply(response, "1", "hub", "2"));
            try std.testing.expectEqual(case.valid, validReply(response, "1", "hub", null));
        }
    }
}

test "subagent navigation replies retain parent authority and remain read-only" {
    const a = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(std.json.Value, a,
        \\{"version":1,"id":"1","ok":true,"snapshot":{"clientMode":"task","hubId":"hub","hubChatId":"1","chatId":"3","inspectParentChatId":"2","kind":"subagent","agentName":"WM001","title":"Review","model":"mock","tools":"offline","activityKnown":false,"busy":false,"queued":0,"entries":[],"hasOlder":false,"historical":false,"preview":"","notice":"","draft":null}}
    , .{});
    defer parsed.deinit();
    try std.testing.expect(validReply(parsed.value, "1", "hub", null));
    try std.testing.expect(validNavigation(parsed.value, .subagent, "2", null));
    try std.testing.expect(validNavigation(parsed.value, .subagent, "4", "2"));
    try std.testing.expect(validNavigation(parsed.value, .poll, "3", "2"));
    try std.testing.expect(!validNavigation(parsed.value, .poll, "2", null));
    try std.testing.expect(!validNavigation(parsed.value, .subagent, "4", null));
    try std.testing.expect(!validNavigation(parsed.value, .parent, "3", "2"));
    for ([_][]const u8{ "wm001", "WM001", "wM001" }) |name| {
        const bytes = try std.fmt.allocPrint(a, "{{\"version\":1,\"id\":\"a\",\"action\":\"subagent\",\"text\":\"{s}\"}}", .{name});
        defer a.free(bytes);
        const request_value = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
        defer request_value.deinit();
        try std.testing.expect(validRequest(request_value.value));
    }
}

test "admitted echoes validate identity uniqueness, byte bounds and writable scope" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixtures = try std.json.parseFromSlice(std.json.Value, a, @embedFile("contracts.test.json"), .{});
    var snapshot = fixtures.value.object.get("bases").?.object.get("TuiSnapshot").?;
    var response = (try std.json.parseFromSlice(std.json.Value, a, "{\"version\":1,\"id\":\"1\",\"ok\":true}", .{})).value;
    for ([_]struct { text: []const u8, valid: bool }{
        .{ .text = "[{\"requestId\":\"r\",\"text\":\"pending\"}]", .valid = true },
        .{ .text = "[{\"requestId\":\"r\",\"text\":\"x\"},{\"requestId\":\"r\",\"text\":\"y\"}]", .valid = false },
        .{ .text = "[{\"requestId\":\"r\",\"text\":\"x\",\"id\":1}]", .valid = false },
        .{ .text = "null", .valid = false },
    }) |case| {
        try snapshot.object.put(a, "admittedInputs", (try std.json.parseFromSlice(std.json.Value, a, case.text, .{})).value);
        try response.object.put(a, "snapshot", snapshot);
        try std.testing.expectEqual(case.valid, validReply(response, "1", "hub", "1"));
    }
    for ([_]usize{ 2730, 2731 }) |count| {
        var text: std.ArrayList(u8) = .empty;
        for (0..count) |_| try text.appendSlice(a, "界");
        const encoded = try std.json.Stringify.valueAlloc(a, [_]wire.TuiAdmittedInput{.{ .requestId = "r", .text = text.items }}, .{});
        try snapshot.object.put(a, "admittedInputs", (try std.json.parseFromSlice(std.json.Value, a, encoded, .{})).value);
        try response.object.put(a, "snapshot", snapshot);
        try std.testing.expectEqual(count == 2730, validReply(response, "1", "hub", "1"));
    }
    try snapshot.object.put(a, "admittedInputs", (try std.json.parseFromSlice(std.json.Value, a, "[{\"requestId\":\"r\",\"text\":\"x\"}]", .{})).value);
    try snapshot.object.put(a, "chatId", .{ .string = "2" });
    try response.object.put(a, "snapshot", snapshot);
    try std.testing.expect(!validReply(response, "1", "hub", "2"));
    try snapshot.object.put(a, "clientMode", .{ .string = "task" });
    try response.object.put(a, "snapshot", snapshot);
    try std.testing.expect(validReply(response, "1", "hub", "2"));
    try snapshot.object.put(a, "kind", .{ .string = "subagent" });
    try response.object.put(a, "snapshot", snapshot);
    try std.testing.expect(!validReply(response, "1", "hub", "2"));
}

test "task bridge creates only its own managed children and childOpen never selects the child" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_]bool{ false, true }) |navigate| {
        var fixture = try TestPipe.init();
        defer fixture.deinit();
        fixture.bridge.client_mode = .task;
        fixture.bridge.hub_id = try std.testing.allocator.dupe(u8, "hub");
        fixture.bridge.hub_chat_id = try std.testing.allocator.dupe(u8, "1");
        fixture.bridge.chat_id = try std.testing.allocator.dupe(u8, "2");
        try std.testing.expectError(error.TaskLocked, fixture.bridge.createForm(.{ .title = "Cross-parent", .managedParentChatId = "1" }));
        try std.testing.expectError(error.TaskLocked, fixture.bridge.createForm(.{ .title = "Unscoped" }));
        try std.testing.expectError(error.TaskLocked, fixture.bridge.request(.hosts, null, null));
        try std.testing.expect(try fixture.bridge.createForm(.{ .title = "Child", .managedParentChatId = "2" }));
        const bases = (try std.json.parseFromSlice(std.json.Value, a, @embedFile("contracts.test.json"), .{})).value;
        var snapshot = bases.object.get("bases").?.object.get("TuiSnapshot").?;
        try snapshot.object.put(a, "clientMode", .{ .string = "task" });
        try snapshot.object.put(a, "chatId", .{ .string = "2" });
        var response = (try std.json.parseFromSlice(std.json.Value, a, "{\"version\":1,\"id\":\"1\",\"ok\":true}", .{})).value;
        try response.object.put(a, "snapshot", snapshot);
        try fixture.reply(try std.json.Stringify.valueAlloc(a, response, .{}));
        const created = (try fixture.bridge.poll()).?;
        created.deinit();
        try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
        var child = [_]u8{'3'};
        try std.testing.expect(try fixture.bridge.childOpen(&child));
        child[0] = '4';
        try std.testing.expectEqualStrings("3", fixture.bridge.pending.?.chatId.?);
        if (navigate) try snapshot.object.put(a, "chatId", .{ .string = "3" });
        try response.object.put(a, "snapshot", snapshot);
        try response.object.put(a, "id", .{ .string = "2" });
        try fixture.reply(try std.json.Stringify.valueAlloc(a, response, .{}));
        if (navigate) {
            try std.testing.expectError(error.InvalidFrame, fixture.bridge.poll());
        } else {
            const opened = (try fixture.bridge.poll()).?;
            opened.deinit();
            fixture.bridge.inspect_parent_id = try std.testing.allocator.dupe(u8, "1");
            try std.testing.expectError(error.TaskLocked, fixture.bridge.childOpen("3"));
            try std.testing.expectError(error.TaskLocked, fixture.bridge.createForm(.{ .title = "Captured", .managedParentChatId = "2" }));
        }
        try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    }
}

test "message content requests own identity and have no navigation or mutation arguments" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var fixture = try TestPipe.init();
    defer fixture.deinit();
    try std.testing.expectError(error.InvalidContract, fixture.bridge.messageContent(7, 0));
    fixture.bridge.chat_id = try std.testing.allocator.dupe(u8, "2");
    for ([_]i64{ 0, -1, 9007199254740992 }) |entry| try std.testing.expectError(error.InvalidContract, fixture.bridge.messageContent(entry, 0));
    try std.testing.expectError(error.InvalidContract, fixture.bridge.messageContent(7, 16777217));
    try std.testing.expect(try fixture.bridge.messageContent(7, 32768));
    try std.testing.expect(!try fixture.bridge.messageContent(9999, 0));
    try std.testing.expectEqualStrings("7", fixture.bridge.pending.?.entryId.?);
    try std.testing.expectEqual(32768, fixture.bridge.pending.?.offset.?);
    const request_value = (try std.json.parseFromSlice(std.json.Value, a, fixture.bridge.output.items[4..], .{})).value;
    try std.testing.expect(validRequest(request_value));
    try std.testing.expectEqual(5, request_value.object.count());
    try std.testing.expect(!request_value.object.contains("chatId"));
    for ([_][]const u8{
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"7\",\"offset\":0}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"9007199254740991\",\"offset\":16777216}",
    }) |bytes| try std.testing.expect(validRequest((try std.json.parseFromSlice(std.json.Value, a, bytes, .{})).value));
    for ([_][]const u8{
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"offset\":0}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"7\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"7\",\"offset\":-1}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"7\",\"offset\":16777217}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"9007199254740992\",\"offset\":0}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"7\",\"offset\":0,\"chatId\":\"2\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"7\",\"offset\":0,\"text\":\"send\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"7\",\"offset\":0,\"hold\":true}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"messageContent\",\"entryId\":\"7\",\"offset\":0,\"after\":\"1\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"poll\",\"entryId\":\"7\",\"offset\":0}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"send\",\"text\":\"x\",\"offset\":0}",
    }) |bytes| try std.testing.expect(!validRequest((try std.json.parseFromSlice(std.json.Value, a, bytes, .{})).value));
}

test "content replies correlate page identity and reject stale payloads on ordinary polls" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const Case = enum { valid, missing, stale, wrong_chat, wrong_entry, wrong_offset, wrong_total, wrong_digest, sparse_next, navigation };
    for (std.enums.values(Case)) |case| {
        var fixture = try TestPipe.init();
        defer fixture.deinit();
        fixture.bridge.chat_id = try std.testing.allocator.dupe(u8, "2");
        const bases = (try std.json.parseFromSlice(std.json.Value, a, @embedFile("contracts.test.json"), .{})).value;
        var snapshot = bases.object.get("bases").?.object.get("TuiSnapshot").?;
        try snapshot.object.put(a, "chatId", .{ .string = "2" });
        var page = (try std.json.parseFromSlice(std.json.Value, a,
            \\{"chatId":"2","entryId":"7","offset":0,"totalBytes":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","text":"abc"}
        , .{})).value;
        switch (case) {
            .wrong_chat => try page.object.put(a, "chatId", .{ .string = "3" }),
            .wrong_entry => try page.object.put(a, "entryId", .{ .string = "8" }),
            .wrong_offset => try page.object.put(a, "offset", .{ .integer = 1 }),
            .wrong_total => try page.object.put(a, "totalBytes", .{ .integer = 16777217 }),
            .wrong_digest => try page.object.put(a, "sha256", .{ .string = "bad" }),
            .sparse_next => try page.object.put(a, "next", .{ .integer = 4 }),
            .navigation => try snapshot.object.put(a, "chatId", .{ .string = "3" }),
            else => {},
        }
        if (case != .missing) try snapshot.object.put(a, "messageContent", page);
        var response = (try std.json.parseFromSlice(std.json.Value, a, "{\"version\":1,\"id\":\"1\",\"ok\":true}", .{})).value;
        try response.object.put(a, "snapshot", snapshot);
        if (case == .stale) {
            try std.testing.expect(try fixture.bridge.request(.poll, null, false));
        } else try std.testing.expect(try fixture.bridge.messageContent(7, 0));
        try fixture.reply(try std.json.Stringify.valueAlloc(a, response, .{}));
        if (case == .valid) {
            const reply = (try fixture.bridge.poll()).?;
            defer reply.deinit();
            try std.testing.expectEqualStrings("abc", reply.value.case0.snapshot.messageContent.?.text);
            try std.testing.expect(fixture.bridge.pending == null);
        } else {
            try std.testing.expectError(error.InvalidFrame, fixture.bridge.poll());
            try std.testing.expect(fixture.bridge.failed);
        }
        try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    }
}

test "task content reads preserve own and captured read-only selections" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_]bool{ false, true }) |captured| {
        var fixture = try TestPipe.init();
        defer fixture.deinit();
        fixture.bridge.client_mode = .task;
        fixture.bridge.chat_id = try std.testing.allocator.dupe(u8, "3");
        if (captured) fixture.bridge.inspect_parent_id = try std.testing.allocator.dupe(u8, "2");
        const bases = (try std.json.parseFromSlice(std.json.Value, a, @embedFile("contracts.test.json"), .{})).value;
        var snapshot = bases.object.get("bases").?.object.get("TuiSnapshot").?;
        try snapshot.object.put(a, "clientMode", .{ .string = "task" });
        try snapshot.object.put(a, "chatId", .{ .string = "3" });
        if (captured) {
            try snapshot.object.put(a, "kind", .{ .string = "subagent" });
            try snapshot.object.put(a, "inspectParentChatId", .{ .string = "2" });
        }
        const page = (try std.json.parseFromSlice(std.json.Value, a,
            \\{"chatId":"3","entryId":"7","offset":0,"totalBytes":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","text":"abc"}
        , .{})).value;
        try snapshot.object.put(a, "messageContent", page);
        var response = (try std.json.parseFromSlice(std.json.Value, a, "{\"version\":1,\"id\":\"1\",\"ok\":true}", .{})).value;
        try response.object.put(a, "snapshot", snapshot);
        try std.testing.expect(try fixture.bridge.messageContent(7, 0));
        try fixture.reply(try std.json.Stringify.valueAlloc(a, response, .{}));
        const reply = (try fixture.bridge.poll()).?;
        reply.deinit();
        try std.testing.expectEqualStrings("3", fixture.bridge.chat_id.?);
        try std.testing.expectEqual(captured, fixture.bridge.inspect_parent_id != null);
        if (captured) try std.testing.expectEqualStrings("2", fixture.bridge.inspect_parent_id.?);
        try std.testing.expectEqual(.task, fixture.bridge.client_mode);
    }
}

test "forward request cursors are safe owned and replies are action scoped with monotonic continuation" {
    const a = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const scratch = arena.allocator();
    for ([_][]const u8{
        "{\"version\":1,\"id\":\"1\",\"action\":\"newer\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"newer\",\"after\":\"0\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"newer\",\"after\":\"9007199254740992\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"poll\",\"after\":\"1\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"poll\",\"before\":\"1\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"newer\",\"after\":\"1\",\"hold\":true}",
    }) |bytes| {
        const raw = try std.json.parseFromSlice(std.json.Value, scratch, bytes, .{});
        try std.testing.expect(!validRequest(raw.value));
    }
    var pipe = try TestPipe.init();
    defer pipe.deinit();
    try std.testing.expect(try pipe.bridge.newer(100));
    try std.testing.expect(!try pipe.bridge.newer(999));
    try std.testing.expectEqualStrings("100", pipe.bridge.pending.?.after.?);
    var response = (try std.json.parseFromSlice(std.json.Value, scratch,
        \\{"version":1,"id":"1","ok":true,"snapshot":{"clientMode":"hub","hubChatId":"1","hubId":"hub","chatId":"1","title":"Task","model":"mock","tools":"offline","activityKnown":false,"busy":false,"queued":0,"entries":[{"id":101,"role":"user","text":"new"}],"hasOlder":true,"historical":false,"preview":"","notice":"","draft":null,"newerAfter":"100","newerFound":true}}
    , .{})).value;
    const request_value = pipe.bridge.pending.?;
    try std.testing.expect(validReplyAction(response, request_value, "hub", "1"));
    try std.testing.expect(!validReply(response, "1", "hub", "1"));
    const snapshot = response.object.getPtr("snapshot").?;
    try snapshot.object.put(scratch, "newerAfter", .{ .string = "99" });
    try std.testing.expect(!validReplyAction(response, request_value, "hub", "1"));
    try snapshot.object.put(scratch, "newerAfter", .{ .string = "100" });
    for ([_][]const u8{ "100", "99", "9007199254740992" }) |cursor| {
        try snapshot.object.put(scratch, "newerNext", .{ .string = cursor });
        try std.testing.expect(!validReplyAction(response, request_value, "hub", "1"));
    }
    try snapshot.object.put(scratch, "newerNext", .{ .string = "101" });
    try std.testing.expect(validReplyAction(response, request_value, "hub", "1"));
    // JSON integer spellings may be exponent/decimal numbers. Guard without
    // accessing the wrong Value union tag before the typed parser runs.
    const entry = &snapshot.object.getPtr("entries").?.array.items[0];
    try entry.object.put(scratch, "id", .{ .float = 101.0 });
    try std.testing.expect(validReplyAction(response, request_value, "hub", "1"));
    try entry.object.put(scratch, "id", .{ .integer = 100 });
    try std.testing.expect(!validReplyAction(response, request_value, "hub", "1"));
}
