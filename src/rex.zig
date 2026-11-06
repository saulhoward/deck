const std = @import("std");
const process = @import("shell.zig");
const Result = process.Result;
pub const Plan = struct {
    executable: []const u8,
    server: []const u8,
    hostId: []const u8,
    instanceId: []const u8,
    client: []const u8,
    port: u16,
    hubId: []const u8,
    chatId: []const u8,
    label: []const u8,
    allocationId: ?[]const u8 = null,
};
fn refuse(code: []const u8) Result {
    // Never expose CLI stderr, session contents or authentication diagnostics.
    return .{ .ok = false, .output = code, .code = code };
}
fn uuid(value: []const u8) bool {
    if (value.len != 36) return false;
    for (value, 0..) |byte, i| {
        if (i == 8 or i == 13 or i == 18 or i == 23) {
            if (byte != '-') return false;
        } else if (!std.ascii.isDigit(byte) and !(byte >= 'a' and byte <= 'f')) return false;
    }
    return true;
}
fn id(value: []const u8, prefix: []const u8) bool {
    return std.mem.startsWith(u8, value, prefix) and uuid(value[prefix.len..]);
}
fn absolute(value: []const u8) bool {
    return value.len > 0 and value.len <= 4096 and value[0] == '/' and std.mem.indexOfScalar(u8, value, 0) == null;
}
fn valid(plan: Plan) bool {
    if (!absolute(plan.executable) or !absolute(plan.client) or !std.mem.startsWith(u8, plan.server, "unix:///")) return false;
    const socket = plan.server["unix://".len..];
    if (!absolute(socket) or socket.len > 100 or std.mem.indexOfAny(u8, socket, "?#%\r\n") != null) return false;
    if (plan.allocationId) |allocation| if (!uuid(allocation)) return false;
    if (!uuid(plan.hostId) or !uuid(plan.instanceId) or !uuid(plan.hubId) or plan.port == 0) return false;
    if (plan.chatId.len == 0 or plan.chatId.len > 16 or plan.chatId[0] == '0') return false;
    for (plan.chatId) |byte| if (!std.ascii.isDigit(byte)) return false;
    if (plan.label.len == 0 or plan.label.len > 120) return false;
    for (plan.label) |byte| if (byte < 32 or byte >= 127) return false;
    return true;
}
fn cli(allocator: std.mem.Allocator, cwd: []const u8, plan: Plan, suffix: []const []const u8, cancelled: *std.atomic.Value(bool)) !Result {
    var argv: std.array_list.Managed([]const u8) = .init(allocator);
    try argv.appendSlice(&.{ plan.executable, "--autostart=false", "--timeout", "2s", "--server", plan.server });
    try argv.appendSlice(suffix);
    return process.runArgv(allocator, cwd, argv.items, 4, cancelled, null, true);
}
fn sameServer(allocator: std.mem.Allocator, cwd: []const u8, plan: Plan, cancelled: *std.atomic.Value(bool)) !bool {
    const result = try cli(allocator, cwd, plan, &.{ "server", "status", "--json" }, cancelled);
    if (!result.ok) return false;
    const Status = struct { endpoint: []const u8, host_id: []const u8, instance_id: []const u8, api_revision: u32 };
    const parsed = std.json.parseFromSlice(Status, allocator, result.output, .{ .ignore_unknown_fields = true }) catch return false;
    return parsed.value.api_revision == 8 and std.mem.eql(u8, parsed.value.endpoint, plan.server) and std.mem.eql(u8, parsed.value.host_id, plan.hostId) and std.mem.eql(u8, parsed.value.instance_id, plan.instanceId);
}

pub fn allocate(allocator: std.mem.Allocator, cwd: []const u8, encoded: []const u8, cancelled: *std.atomic.Value(bool)) !Result {
    if (encoded.len > 16 * 1024) return refuse("invalid");
    const parsed = std.json.parseFromSlice(Plan, allocator, encoded, .{}) catch return refuse("invalid");
    const plan = parsed.value;
    if (!valid(plan)) return refuse("invalid");
    // Only our own Deck client (the packaged wrapper when present), never an
    // arbitrary process/runner chosen by a model or a public caller.
    const native = try std.fs.selfExePathAlloc(allocator);
    const client = if (std.mem.eql(u8, std.fs.path.basename(native), ".deck-wrapped")) try std.fs.path.join(allocator, &.{ std.fs.path.dirname(native).?, "deck" }) else native;
    const requested = std.fs.cwd().realpathAlloc(allocator, plan.client) catch return refuse("invalid");
    if (!std.mem.eql(u8, requested, client)) return refuse("invalid");
    if (cancelled.load(.acquire)) return refuse("cancelled");
    if (!(sameServer(allocator, cwd, plan, cancelled) catch false)) return refuse(if (cancelled.load(.acquire)) "cancelled" else "server_unavailable");
    if (cancelled.load(.acquire)) return refuse("cancelled");
    const port = try std.fmt.allocPrint(allocator, "{d}", .{plan.port});
    // From this point any failure is uncertain. Killing this CLI cannot undo
    // an allocation that Rex already accepted on its independent connection.
    var launch: std.array_list.Managed([]const u8) = .init(allocator);
    try launch.appendSlice(&.{ "new", plan.label, "--json", "--cwd", cwd, "--shell=none", "--keep-open", "--", client, "agent", "--no-tui", "--port", port, "--task", plan.chatId, "--hub-id", plan.hubId });
    if (plan.allocationId) |allocation| try launch.appendSlice(&.{ "--rex-allocation", allocation });
    const created = cli(allocator, cwd, plan, launch.items, cancelled) catch return refuse("effect_uncertain");
    if (!created.ok or cancelled.load(.acquire)) return refuse("effect_uncertain");
    const Created = struct { session_id: []const u8, initial_windows: []struct { window_id: []const u8, block_ids: [][]const u8 } };
    const value = std.json.parseFromSlice(Created, allocator, created.output, .{ .ignore_unknown_fields = true }) catch return refuse("effect_uncertain");
    const session = value.value;
    if (!id(session.session_id, "session:") or session.initial_windows.len != 1) return refuse("effect_uncertain");
    const window = session.initial_windows[0];
    if (!id(window.window_id, "window:") or window.block_ids.len != 1 or !id(window.block_ids[0], "block:")) return refuse("effect_uncertain");
    const listed = cli(allocator, cwd, plan, &.{ "block", "ls", "--session", session.session_id, "--json", "--short=false" }, cancelled) catch return refuse("effect_uncertain");
    if (!listed.ok) return refuse("effect_uncertain");
    const Blocks = struct { blocks: []struct { block_id: []const u8, window_id: ?[]const u8 = null, host_id: []const u8, flavor: []const u8 } };
    const blocks = std.json.parseFromSlice(Blocks, allocator, listed.output, .{ .ignore_unknown_fields = true }) catch return refuse("effect_uncertain");
    var matched: usize = 0;
    for (blocks.value.blocks) |block| if (std.mem.eql(u8, block.block_id, window.block_ids[0])) {
        if (block.window_id == null or !std.mem.eql(u8, block.window_id.?, window.window_id) or !std.mem.eql(u8, block.host_id, plan.hostId) or !std.mem.eql(u8, block.flavor, "com.superlogical.terminal.shell")) return refuse("effect_uncertain");
        matched += 1;
    };
    if (matched != 1 or !(sameServer(allocator, cwd, plan, cancelled) catch false) or cancelled.load(.acquire)) return refuse("effect_uncertain");
    return .{ .ok = true, .code = "allocated", .output = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .server = plan.server, .hostId = plan.hostId, .instanceId = plan.instanceId, .sessionId = session.session_id, .windowId = window.window_id, .blockId = window.block_ids[0], .chatId = plan.chatId, .hubId = plan.hubId, .allocationId = plan.allocationId, .readiness = "not_checked" }, .{}) };
}
