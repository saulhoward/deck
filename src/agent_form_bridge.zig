const std = @import("std");
const Native = @import("native.zig");
const Pipe = @import("tui_bridge.zig");
const wire = @import("generated/contracts.zig");
const Bridge = @This();
pub const Action = @FieldType(wire.AgentWizardRequest, "action");
pipe: Pipe,
pending: ?Action = null,
id: [32]u8 = undefined,
id_len: usize = 0,
pub fn start(native: Native, a: std.mem.Allocator, root: []const u8, id: []const u8) !Bridge {
    return .{ .pipe = try Pipe.startEntry(native, a, "agent-wizard-main.js", &.{ root, id }) };
}
pub fn deinit(self: *Bridge) void {
    self.pipe.deinit();
}
pub fn request(self: *Bridge, action: Action, problem: ?[]const u8, description: ?[]const u8) !bool {
    const p = &self.pipe;
    if (p.failed or self.pending != null) return false;
    if (action == .create) {
        if (problem == null or std.mem.trim(u8, problem.?, " \t\r\n").len == 0 or problem.?.len > 2048 or !std.unicode.utf8ValidateSlice(problem.?)) return error.InvalidForm;
        if (description) |text| if (text.len > 8192 or !std.unicode.utf8ValidateSlice(text)) return error.InvalidForm;
    } else if (problem != null or description != null) return error.InvalidForm;
    p.sequence += 1;
    self.id_len = (try std.fmt.bufPrint(&self.id, "{d}", .{p.sequence})).len;
    const value: wire.AgentWizardRequest = .{ .version = 1, .id = self.id[0..self.id_len], .action = action, .problem = problem, .description = description };
    const bytes = try std.json.Stringify.valueAlloc(p.a, value, .{});
    defer p.a.free(bytes);
    p.output.clearRetainingCapacity();
    p.sent = 0;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(bytes.len), .big);
    try p.output.appendSlice(p.a, &header);
    try p.output.appendSlice(p.a, bytes);
    self.pending = action;
    return true;
}
pub fn poll(self: *Bridge) !?std.json.Parsed(wire.AgentWizardResponse) {
    if (self.pipe.failed) return null;
    return self.receive() catch |err| {
        self.pipe.failed = true;
        return err;
    };
}
fn receive(self: *Bridge) !?std.json.Parsed(wire.AgentWizardResponse) {
    const p = &self.pipe;
    if (p.sent < p.output.items.len) {
        const bytes = p.output.items[p.sent..];
        const n = std.c.write(p.child.stdin.?.handle, bytes.ptr, bytes.len);
        switch (std.c.errno(n)) {
            .SUCCESS => p.sent += @intCast(n),
            .AGAIN, .INTR => {},
            else => return error.BridgeWriteFailed,
        }
    }
    var buffer: [16384]u8 = undefined;
    const n = std.posix.read(p.child.stdout.?.handle, &buffer) catch |err| switch (err) {
        error.WouldBlock => return null,
        else => return err,
    };
    if (n == 0) return error.BridgeClosed;
    if (p.input.items.len + n > 65540) return error.InvalidFrame;
    try p.input.appendSlice(p.a, buffer[0..n]);
    if (p.input.items.len < 4) return null;
    const length = std.mem.readInt(u32, p.input.items[0..4], .big);
    if (length == 0 or length > 65536) return error.InvalidFrame;
    if (p.input.items.len < length + 4) return null;
    if (p.input.items.len != length + 4 or self.pending == null) return error.InvalidFrame;
    const body = p.input.items[4..];
    const raw = try std.json.parseFromSlice(std.json.Value, p.a, body, .{});
    defer raw.deinit();
    if (!std.unicode.utf8ValidateSlice(body) or !wire.validAgentWizardResponse(raw.value)) return error.InvalidFrame;
    const parsed = try std.json.parseFromSlice(wire.AgentWizardResponse, p.a, body, .{ .allocate = .alloc_always });
    errdefer parsed.deinit();
    if (!std.mem.eql(u8, parsed.value.id, self.id[0..self.id_len]) or (parsed.value.phase == .ready) != (parsed.value.ready != null)) return error.InvalidFrame;
    if (parsed.value.ready) |ready| if ((std.fmt.parseInt(u64, ready.chatId, 10) catch return error.InvalidFrame) > 9007199254740991) return error.InvalidFrame;
    p.input.clearRetainingCapacity();
    p.output.clearRetainingCapacity();
    self.pending = null;
    return parsed;
}
