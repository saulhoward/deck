const std = @import("std");
const Native = @import("native.zig");
const process = @import("shell.zig");
const Result = process.Result;
const contracts = @import("generated/contracts.zig");
const endpoint = @import("rex_endpoint.zig");
pub const Plan = contracts.RexAllocationPlan;
// Rex revision N supports APIs 0..N. Gate on the oldest API needed by each
// surface, not an allowlist of releases. Keep the reported revision in the
// same unsigned-32-bit domain used by discovery/identity JSON decoding.
pub const allocation_api_minimum = 8;
pub const automatic_api_minimum = 14;
// std.json's ordinary integer decoder also accepts numeric strings. A claimed
// API maximum must be an actual integer, not a coerced/malformed status field.
pub const ApiRevision = struct {
    value: u32,
    pub fn jsonParse(allocator: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !@This() {
        const value = try std.json.Value.jsonParse(allocator, source, options);
        if (value != .integer or value.integer < 0 or value.integer > std.math.maxInt(u32)) return error.InvalidNumber;
        return .{ .value = @intCast(value.integer) };
    }
    pub fn jsonStringify(self: @This(), writer: anytype) !void {
        try writer.write(self.value);
    }
};
pub fn supportedApi(revision: i64) bool {
    return revision >= allocation_api_minimum and revision <= std.math.maxInt(u32);
}
pub fn supportedAutomaticApi(revision: i64) bool {
    return supportedApi(revision) and revision >= automatic_api_minimum;
}
test "Rex backwards compatibility uses feature minimums, not release allowlists" {
    for ([_]i64{ 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 99, std.math.maxInt(u32) }) |revision| {
        try std.testing.expect(supportedApi(revision));
        try std.testing.expectEqual(revision >= automatic_api_minimum, supportedAutomaticApi(revision));
    }
    for ([_]i64{ -1, 0, 7, @as(i64, std.math.maxInt(u32)) + 1, 9007199254740991 }) |revision| {
        try std.testing.expect(!supportedApi(revision));
        try std.testing.expect(!supportedAutomaticApi(revision));
    }
}
test "Rex API revision requires an unsigned JSON integer without coercion" {
    const Status = struct { api_revision: ApiRevision };
    for ([_][]const u8{ "0", "8", "14", "16", "99", "4294967295" }) |number| {
        const bytes = try std.fmt.allocPrint(std.testing.allocator, "{{\"api_revision\":{s}}}", .{number});
        defer std.testing.allocator.free(bytes);
        const parsed = try std.json.parseFromSlice(Status, std.testing.allocator, bytes, .{});
        defer parsed.deinit();
        try std.testing.expectEqual(try std.fmt.parseInt(u32, number, 10), parsed.value.api_revision.value);
        const encoded = try std.json.Stringify.valueAlloc(std.testing.allocator, parsed.value, .{});
        defer std.testing.allocator.free(encoded);
        try std.testing.expectEqualStrings(bytes, encoded);
    }
    for ([_][]const u8{ "{}", "{\"api_revision\":\"16\"}", "{\"api_revision\":-1}", "{\"api_revision\":16.5}", "{\"api_revision\":4294967296}", "{\"api_revision\":null}", "{\"api_revision\":true}", "{\"api_revision\":{}}" }) |bytes| {
        if (std.json.parseFromSlice(Status, std.testing.allocator, bytes, .{})) |parsed| {
            parsed.deinit();
            return error.TestExpectedInvalidRevision;
        } else |_| {}
    }
}
fn refuse(code: []const u8) Result {
    // Never expose CLI stderr, session contents or authentication diagnostics.
    return .{ .ok = false, .output = code, .code = code };
}
fn absolute(value: []const u8) bool {
    return value.len > 0 and value.len <= 4096 and value[0] == '/' and std.mem.indexOfScalar(u8, value, 0) == null;
}
fn valid(plan: Plan) bool {
    return absolute(plan.executable) and absolute(plan.client) and endpoint.valid(plan.server) and (plan.clientState == null or absolute(plan.clientState.?)) and (plan.bootstrap == null or absolute(plan.bootstrap.?.root));
}
fn cli(native: Native, allocator: std.mem.Allocator, cwd: []const u8, plan: Plan, suffix: []const []const u8, cancelled: *std.atomic.Value(bool)) !Result {
    var argv: std.array_list.Managed([]const u8) = .init(allocator);
    try argv.appendSlice(&.{ plan.executable, "--autostart=false", "--timeout", "2s", "--server", plan.server });
    try argv.appendSlice(suffix);
    return process.runArgv(native, allocator, cwd, argv.items, 4, cancelled, null, true);
}
fn sameServer(native: Native, allocator: std.mem.Allocator, cwd: []const u8, plan: Plan, cancelled: *std.atomic.Value(bool)) !bool {
    const result = try cli(native, allocator, cwd, plan, &.{ "server", "status", "--json" }, cancelled);
    if (!result.ok) return false;
    const Status = struct { endpoint: []const u8, host_id: []const u8, instance_id: []const u8, api_revision: ApiRevision };
    const parsed = std.json.parseFromSlice(Status, allocator, result.output, .{ .ignore_unknown_fields = true }) catch return false;
    return supportedApi(parsed.value.api_revision.value) and endpoint.same(parsed.value.endpoint, plan.server) and std.mem.eql(u8, parsed.value.host_id, plan.hostId) and std.mem.eql(u8, parsed.value.instance_id, plan.instanceId);
}

pub fn clientPath(native: Native, allocator: std.mem.Allocator) ![]const u8 {
    const executable = try std.process.executablePathAlloc(native.io, allocator);
    if (std.mem.eql(u8, std.fs.path.basename(executable), ".deck-wrapped")) return std.fs.path.join(allocator, &.{ std.fs.path.dirname(executable).?, "deck" });
    return executable;
}
pub fn allocate(native: Native, allocator: std.mem.Allocator, cwd: []const u8, encoded: []const u8, cancelled: *std.atomic.Value(bool)) !Result {
    return allocateUsing(native, allocator, cwd, encoded, cancelled, null);
}
pub fn allocateUsing(native: Native, allocator: std.mem.Allocator, cwd: []const u8, encoded: []const u8, cancelled: *std.atomic.Value(bool), approved: ?contracts.WorkerRexClient) !Result {
    return allocateClient(native, allocator, cwd, encoded, cancelled, approved, false, null);
}
pub fn allocateBound(native: Native, allocator: std.mem.Allocator, cwd: []const u8, machine: []const u8, encoded: []const u8, cancelled: *std.atomic.Value(bool), approved: ?contracts.WorkerRexClient) !Result {
    return allocateClient(native, allocator, cwd, encoded, cancelled, approved, false, machine);
}
// Dedicated local hub launcher; never exposed as a native tool operation or a
// worker capability. Canonical hub terminals are not task allocations.
pub fn allocateHub(native: Native, allocator: std.mem.Allocator, cwd: []const u8, encoded: []const u8, cancelled: *std.atomic.Value(bool)) !Result {
    return allocateClient(native, allocator, cwd, encoded, cancelled, null, true, null);
}
fn allocateClient(native: Native, allocator: std.mem.Allocator, cwd: []const u8, encoded: []const u8, cancelled: *std.atomic.Value(bool), approved: ?contracts.WorkerRexClient, hub_client: bool, machine: ?[]const u8) !Result {
    if (encoded.len > 16 * 1024) return refuse("invalid");
    const parsed = contracts.parseRexAllocationPlan(allocator, encoded) catch return refuse("invalid");
    defer parsed.deinit();
    const plan = parsed.value;
    if (!valid(plan) or (hub_client and (plan.workerSocket != null or plan.allocationId != null or plan.bootstrap != null))) return refuse("invalid");
    // Only our own Deck client (the packaged wrapper when present), never an
    // arbitrary process/runner chosen by a model or a public caller.
    const executable = try std.process.executablePathAlloc(native.io, allocator);
    const client = if (approved) |c| c.executable else if (std.mem.eql(u8, std.fs.path.basename(executable), ".deck-wrapped")) try std.fs.path.join(allocator, &.{ std.fs.path.dirname(executable).?, "deck" }) else executable;
    if (approved) |c| {
        if (plan.workerSocket == null or plan.allocationId == null or !std.mem.eql(u8, plan.client, c.executable) or !std.mem.eql(u8, plan.workerSocket.?, c.socket)) return refuse("invalid");
    } else if (plan.workerSocket != null) return refuse("invalid");
    const requested = std.Io.Dir.cwd().realPathFileAlloc(native.io, plan.client, allocator) catch return refuse("invalid");
    const expected = std.Io.Dir.cwd().realPathFileAlloc(native.io, client, allocator) catch return refuse("invalid");
    if (!std.mem.eql(u8, requested, expected)) return refuse("invalid");
    if (cancelled.load(.acquire)) return refuse("cancelled");
    if (!(sameServer(native, allocator, cwd, plan, cancelled) catch false)) return refuse(if (cancelled.load(.acquire)) "cancelled" else "server_unavailable");
    if (cancelled.load(.acquire)) return refuse("cancelled");
    if (plan.bootstrap != null) {
        return @import("rex_bootstrap.zig").adopt(native, allocator, cwd, machine orelse return refuse("invalid"), plan, cancelled) catch |err| switch (err) {
            error.InvalidBootstrap, error.BootstrapAlreadyClaimed => refuse("invalid"),
            error.BootstrapNotRunning => refuse("server_unavailable"),
            else => refuse("effect_uncertain"),
        };
    }
    const port = try std.fmt.allocPrint(allocator, "{d}", .{plan.port});
    // From this point any failure is uncertain. Killing this CLI cannot undo
    // an allocation that Rex already accepted on its independent connection.
    var launch: std.array_list.Managed([]const u8) = .init(allocator);
    if (plan.sessionId) |session_id| {
        try launch.appendSlice(&.{ "run", "--session", session_id, "--label", plan.label, "--focus=false" });
    } else {
        try launch.appendSlice(&.{ "new", plan.label });
    }
    try launch.appendSlice(&.{ "--json", "--cwd", cwd, "--shell=none", "--keep-open", "--", client });
    if (hub_client) {
        try launch.appendSlice(&.{ "hub", "--here", "--tui", "--port", port, "--hub-id", plan.hubId });
    } else try launch.appendSlice(&.{ "agent", "--tui", "--port", port, "--task", plan.chatId, "--hub-id", plan.hubId });
    if (plan.allocationId) |allocation| try launch.appendSlice(&.{ "--rex-allocation", allocation });
    if (plan.workerSocket) |socket| try launch.appendSlice(&.{ "--worker-socket", socket });
    if (plan.clientState) |root| try launch.appendSlice(&.{ "--client-state", root });
    const created = cli(native, allocator, cwd, plan, launch.items, cancelled) catch return refuse("effect_uncertain");
    if (!created.ok or cancelled.load(.acquire)) return refuse("effect_uncertain");
    const Window = struct { window_id: []const u8, block_ids: [][]const u8 };
    const Created = struct { session_id: []const u8, initial_windows: []Window };
    const session: Created = if (plan.sessionId) |session_id| blk: {
        const value = std.json.parseFromSlice(Window, allocator, created.output, .{ .ignore_unknown_fields = true }) catch return refuse("effect_uncertain");
        const windows = try allocator.alloc(Window, 1);
        windows[0] = value.value;
        break :blk .{ .session_id = session_id, .initial_windows = windows };
    } else blk: {
        const value = std.json.parseFromSlice(Created, allocator, created.output, .{ .ignore_unknown_fields = true }) catch return refuse("effect_uncertain");
        break :blk value.value;
    };
    if (!contracts.validRexSessionId(.{ .string = session.session_id }) or session.initial_windows.len != 1) return refuse("effect_uncertain");
    const window = session.initial_windows[0];
    if (!contracts.validRexWindowId(.{ .string = window.window_id }) or window.block_ids.len != 1 or !contracts.validRexBlockId(.{ .string = window.block_ids[0] })) return refuse("effect_uncertain");
    const listed = cli(native, allocator, cwd, plan, &.{ "block", "ls", "--session", session.session_id, "--json", "--short=false" }, cancelled) catch return refuse("effect_uncertain");
    if (!listed.ok) return refuse("effect_uncertain");
    const Blocks = struct { blocks: []struct { block_id: []const u8, window_id: ?[]const u8 = null, host_id: []const u8, flavor: []const u8 } };
    const blocks = std.json.parseFromSlice(Blocks, allocator, listed.output, .{ .ignore_unknown_fields = true }) catch return refuse("effect_uncertain");
    var matched: usize = 0;
    for (blocks.value.blocks) |block| if (std.mem.eql(u8, block.block_id, window.block_ids[0])) {
        if (block.window_id == null or !std.mem.eql(u8, block.window_id.?, window.window_id) or !std.mem.eql(u8, block.host_id, plan.hostId) or !std.mem.eql(u8, block.flavor, "com.superlogical.terminal.shell")) return refuse("effect_uncertain");
        matched += 1;
    };
    if (matched != 1 or !(sameServer(native, allocator, cwd, plan, cancelled) catch false) or cancelled.load(.acquire)) return refuse("effect_uncertain");
    const creation: contracts.RexCreation = .{ .version = 1, .server = plan.server, .hostId = plan.hostId, .instanceId = plan.instanceId, .sessionId = session.session_id, .windowId = window.window_id, .blockId = window.block_ids[0], .chatId = plan.chatId, .hubId = plan.hubId, .allocationId = plan.allocationId, .readiness = "not_checked" };
    const output = try std.json.Stringify.valueAlloc(allocator, creation, .{});
    const checked = contracts.parseRexCreation(allocator, output) catch return refuse("effect_uncertain");
    checked.deinit();
    return .{ .ok = true, .code = "allocated", .output = output };
}
