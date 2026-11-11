//! One outstanding client request; nonblocking pipe I/O keeps terminal detach
//! independent of an HTTP deadline. This child is not the Pi writer.
const std = @import("std");
const Native = @import("native.zig");
const paths = @import("runtime_paths.zig");
const model_settings = @import("model_settings.zig");
const wire = @import("generated/contracts.zig");
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
failed: bool = false,
hub_id: ?[]const u8 = null,
chat_id: ?[]const u8 = null,

pub fn start(native: Native, a: std.mem.Allocator, args: []const []const u8) !Bridge {
    const node = try paths.node(native, a);
    defer a.free(node);
    const entry = try paths.entry(native, a, null, "tui-bridge.js");
    defer a.free(entry);
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(a);
    try argv.appendSlice(a, &.{ node, entry });
    try argv.appendSlice(a, args);
    var child = try std.process.spawn(native.io, .{ .argv = argv.items, .stdin = .pipe, .stdout = .pipe, .stderr = .ignore });
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
}
pub fn request(self: *Bridge, action: @FieldType(wire.TuiRequest, "action"), text: ?[]const u8, hold: ?bool) !bool {
    return self.requestConfigured(action, text, hold, null, null, null);
}
pub fn configure(self: *Bridge, change: wire.ModelSettingsChange) !bool {
    return self.requestConfigured(.configure, null, null, change, null, null);
}
pub fn selectChat(self: *Bridge, chat_id: []const u8) !bool {
    return self.requestConfigured(.select, null, null, null, chat_id, null);
}
pub fn tasks(self: *Bridge, after: ?[]const u8) !bool {
    return self.requestConfigured(.tasks, null, null, null, null, after);
}
fn requestConfigured(self: *Bridge, action: @FieldType(wire.TuiRequest, "action"), text: ?[]const u8, hold: ?bool, configuration: ?wire.ModelSettingsChange, chat_id: ?[]const u8, after: ?[]const u8) !bool {
    if (self.failed or self.pending != null) return false;
    self.sequence += 1;
    const id = try std.fmt.bufPrint(&self.id_buf, "{d}", .{self.sequence});
    var request_value: wire.TuiRequest = .{ .version = 1, .id = id, .action = action, .text = text, .hold = hold, .configuration = configuration, .chatId = chat_id, .after = after };
    const bytes = try std.json.Stringify.valueAlloc(self.a, request_value, .{});
    defer self.a.free(bytes);
    const checked = try std.json.parseFromSlice(std.json.Value, self.a, bytes, .{});
    defer checked.deinit();
    if (!validRequest(checked.value)) return error.InvalidContract;
    if (bytes.len > cap or (action == .send and (text == null or text.?.len == 0 or text.?.len > 16384))) return error.InvalidContract;
    self.output.clearRetainingCapacity();
    self.sent = 0;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(bytes.len), .big);
    try self.output.appendSlice(self.a, &header);
    try self.output.appendSlice(self.a, bytes);
    // Commands may be edited while waiting. Keep correlation targets owned,
    // not borrowed from the command buffer or an old display page.
    if (chat_id) |target| request_value.chatId = try std.fmt.bufPrint(&self.target_buf, "{s}", .{target});
    if (after) |cursor| request_value.after = try std.fmt.bufPrint(&self.after_buf, "{s}", .{cursor});
    self.pending = request_value;
    return true;
}
pub fn validRequest(value: std.json.Value) bool {
    if (!wire.validTuiRequest(value)) return false;
    const action = value.object.get("action").?.string;
    const text = value.object.get("text");
    if (std.mem.eql(u8, action, "select")) {
        if (!safeId(value.object.get("chatId") orelse return false)) return false;
    } else if (value.object.contains("chatId")) return false;
    if (value.object.get("after")) |after| if (!std.mem.eql(u8, action, "tasks") or !safeId(after)) return false;
    if (value.object.contains("hold") and !std.mem.eql(u8, action, "poll")) return false;
    if (std.mem.eql(u8, action, "configure")) return value.object.contains("configuration") and text == null;
    if (value.object.contains("configuration")) return false;
    if (std.mem.eql(u8, action, "send") or std.mem.eql(u8, action, "create")) {
        const content = text orelse return false;
        return content.string.len <= (if (std.mem.eql(u8, action, "create")) @as(usize, 200) else 16384) and std.mem.trim(u8, content.string, " \t\r\n").len > 0;
    }
    return text == null;
}
fn safeId(value: std.json.Value) bool {
    return wire.validPiId(value) and (std.fmt.parseInt(u64, value.string, 10) catch return false) <= 9007199254740991;
}
pub fn validReply(value: std.json.Value, expected: []const u8, hub_id: ?[]const u8, chat_id: ?[]const u8) bool {
    if (!wire.validTuiResponse(value) or !std.mem.eql(u8, value.object.get("id").?.string, expected)) return false;
    if (!value.object.get("ok").?.bool) return true;
    const s = value.object.get("snapshot").?;
    if (hub_id) |id| if (!std.mem.eql(u8, id, s.object.get("hubId").?.string)) return false;
    const chat = s.object.get("chatId").?.string;
    if ((std.fmt.parseInt(u64, chat, 10) catch return false) > 9007199254740991) return false;
    if (chat_id) |id| if (!std.mem.eql(u8, id, chat)) return false;
    if (s.object.get("mainChatId")) |main_id| if (!safeId(main_id)) return false;
    if (s.object.get("tasks")) |page| {
        var previous: u64 = 0;
        if (page.object.get("after")) |after| {
            if (!safeId(after)) return false;
            previous = std.fmt.parseInt(u64, after.string, 10) catch return false;
        }
        const first_cursor = previous;
        for (page.object.get("items").?.array.items) |row| {
            const id = row.object.get("chatId").?;
            if (!safeId(id)) return false;
            const n = std.fmt.parseInt(u64, id.string, 10) catch return false;
            if (n <= previous) return false;
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
    if (s.object.get("modelSettings")) |settings| {
        if (!model_settings.validSnapshot(settings) or !std.mem.eql(u8, settings.object.get("hubId").?.string, s.object.get("hubId").?.string) or !std.mem.eql(u8, settings.object.get("chatId").?.string, chat)) return false;
    }
    var previous: f64 = 0;
    for (s.object.get("entries").?.array.items) |entry| {
        const raw = entry.object.get("id").?;
        const n: f64 = if (raw == .integer) @floatFromInt(raw.integer) else raw.float;
        if (n <= previous) return false;
        previous = n;
    }
    return true;
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
    if (!validReply(raw.value, pending.id, self.hub_id, if (pending.action == .select) pending.chatId else self.chat_id)) return error.InvalidFrame;
    // Own all strings: the receive buffer is reused while the UI retains the
    // last valid snapshot. Shape/semantic guards ran on the original bytes above.
    const parsed = try std.json.parseFromSlice(wire.TuiResponse, self.a, body, .{ .allocate = .alloc_always });
    errdefer parsed.deinit();
    if (parsed.value == .case0) {
        const s = parsed.value.case0.snapshot;
        if ((pending.action == .models or pending.action == .configure) and s.modelSettings == null) return error.InvalidFrame;
        if (pending.action == .tasks) {
            const page = s.tasks orelse return error.InvalidFrame;
            if ((pending.after == null) != (page.after == null) or (pending.after != null and !std.mem.eql(u8, pending.after.?, page.after.?))) return error.InvalidFrame;
        }
        if ((pending.action == .rexStatus or pending.action == .rexInspect) and s.rex == null) return error.InvalidFrame;
        if (pending.action == .rexInspect and s.rex.?.inspection == null) return error.InvalidFrame;
        if (self.hub_id == null) self.hub_id = try self.a.dupe(u8, s.hubId);
        if (self.chat_id == null or pending.action == .select) {
            const next = try self.a.dupe(u8, s.chatId);
            if (self.chat_id) |old| self.a.free(old);
            self.chat_id = next;
        }
    }
    self.input.clearRetainingCapacity();
    self.output.clearRetainingCapacity();
    self.pending = null;
    return parsed;
}

const TestPipe = struct {
    bridge: Bridge,
    peer_read: std.posix.fd_t,
    peer_write: std.posix.fd_t,
    fn init() !@This() {
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
    fn deinit(self: *@This()) void {
        self.bridge.deinit();
        Native.close(self.peer_read);
        if (self.peer_write >= 0) Native.close(self.peer_write);
    }
    fn reply(self: *@This(), bytes: []const u8) !void {
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
    try fixture.reply("{\"version\":1,\"id\":\"1\",\"ok\":true,\"snapshot\":{\"hubId\":\"hub\",\"chatId\":\"2\",\"title\":\"Task\",\"model\":\"mock\",\"tools\":\"offline\",\"activityKnown\":false,\"busy\":false,\"queued\":0,\"entries\":[],\"hasOlder\":false,\"historical\":false,\"preview\":\"\",\"notice\":\"\",\"draft\":null}}");
    const selected = (try fixture.bridge.poll()).?;
    selected.deinit();
    try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    try std.testing.expect(try fixture.bridge.selectChat("3"));
    try fixture.reply("{\"version\":1,\"id\":\"2\",\"ok\":false,\"error\":\"Selection refused\"}");
    const refused = (try fixture.bridge.poll()).?;
    refused.deinit();
    try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    try std.testing.expect(try fixture.bridge.request(.poll, null, false));
    try fixture.reply("{\"version\":1,\"id\":\"3\",\"ok\":true,\"snapshot\":{\"hubId\":\"hub\",\"chatId\":\"1\",\"title\":\"Old\",\"model\":\"mock\",\"tools\":\"offline\",\"activityKnown\":false,\"busy\":false,\"queued\":0,\"entries\":[],\"hasOlder\":false,\"historical\":false,\"preview\":\"\",\"notice\":\"\",\"draft\":null}}");
    try std.testing.expectError(error.InvalidFrame, fixture.bridge.poll());
    try std.testing.expectEqualStrings("2", fixture.bridge.chat_id.?);
    try std.testing.expect(fixture.bridge.failed);
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
    for ([_][]const u8{
        "{\"version\":1,\"id\":\"1\",\"action\":\"send\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"send\",\"text\":\" \"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"send\",\"text\":\"x\",\"hold\":true}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"poll\",\"text\":\"x\"}",
        "{\"version\":1,\"id\":\"1\",\"action\":\"configure\"}",
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
