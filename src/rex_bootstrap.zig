//! Private provenance for a managed task-creation terminal. Adoption claims an
//! existing exact block/process; it never starts a second terminal or retargets
//! a task. Native operation receipts retain the resulting allocation evidence.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const storage = @import("private_store.zig");
const shell = @import("shell.zig");
pub fn path(native: Native, a: std.mem.Allocator, client_root: []const u8, id: []const u8) ![]const u8 {
    if (!wire.validRexUuid(.{ .string = id }) or !@import("mcp_profiles.zig").absolute(client_root)) return error.InvalidBootstrap;
    var client = try storage.openDirectory(native, client_root, false);
    client.close(native.io);
    const root = try std.fs.path.join(a, &.{ client_root, "startups" });
    var parent = try storage.openDirectory(native, root, false);
    parent.close(native.io);
    return std.fs.path.join(a, &.{ root, id });
}
pub fn load(native: Native, a: std.mem.Allocator, client_root: []const u8, id: []const u8) !wire.RexBootstrapRecord {
    const root = try path(native, a, client_root, id);
    var dir = try storage.openDirectory(native, root, false);
    defer dir.close(native.io);
    const bytes = try @import("mcp_profiles.zig").readPrivate(native, a, try std.fs.path.join(a, &.{ root, "record.json" }), 16 * 1024);
    const value = (try wire.parseRexBootstrapRecord(a, bytes)).value;
    if (!std.mem.eql(u8, value.id, id) or !std.mem.eql(u8, value.draftRoot, client_root) or !@import("mcp_profiles.zig").absolute(value.cwd) or !@import("mcp_profiles.zig").absolute(value.client) or !@import("mcp_profiles.zig").absolute(value.draftRoot) or !@import("mcp_profiles.zig").absolute(value.target.executable) or !@import("rex_endpoint.zig").valid(value.target.server)) return error.InvalidBootstrap;
    if (value.workerSocket) |socket| if (!@import("mcp_profiles.zig").absolute(socket) or socket.len > 100) return error.InvalidBootstrap;
    return value;
}
fn cli(native: Native, a: std.mem.Allocator, cwd: []const u8, target: wire.RexOpenTarget, suffix: []const []const u8, cancelled: *std.atomic.Value(bool)) !shell.Captured {
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(a, &.{ target.executable, "--autostart=false", "--timeout", "2s", "--server", target.server });
    try argv.appendSlice(a, suffix);
    return shell.runArgvCaptured(native, a, cwd, argv.items, 4, cancelled);
}
fn identity(native: Native, a: std.mem.Allocator, target: wire.RexOpenTarget, cancelled: *std.atomic.Value(bool)) !void {
    const observed = try @import("rex_forward.zig").identity(native, a, target.executable, target.server, cancelled);
    if (!std.mem.eql(u8, observed.value.host_id, target.hostId) or !std.mem.eql(u8, observed.value.instance_id, target.instanceId)) return error.RexIdentityChanged;
}
fn process(native: Native, a: std.mem.Allocator, record: wire.RexBootstrapRecord, binding: wire.RexBootstrapBinding, cancelled: *std.atomic.Value(bool)) !i64 {
    const result = try cli(native, a, record.cwd, record.target, &.{ "block", "call", "process", "--session", binding.sessionId, "--block", binding.blockId }, cancelled);
    if (!result.result.ok or result.stderr.len != 0) return error.BootstrapNotRunning;
    const value = (try std.json.parseFromSlice(struct { child: ?struct { pid: i64 } = null }, a, result.stdout, .{ .ignore_unknown_fields = true })).value;
    const child = value.child orelse return error.BootstrapNotRunning;
    if (child.pid < 1 or child.pid > 2147483647) return error.BootstrapNotRunning;
    return child.pid;
}
pub fn launch(native: Native, a: std.mem.Allocator, record: wire.RexBootstrapRecord, cancelled: *std.atomic.Value(bool)) !wire.RexBootstrapBinding {
    if (record.binding != null or record.claim != null) return error.InvalidBootstrap;
    const root = try path(native, a, record.draftRoot, record.id);
    var dir = try storage.directory(native, root);
    defer dir.close(native.io);
    const held = try storage.lock(native, dir, "launcher.lock");
    defer held.close(native.io);
    if (dir.access(native.io, "record.json", .{})) |_| return error.BootstrapLaunchUnconfirmed else |err| if (err != error.FileNotFound) return err;
    // Resolve the actual packaged wrapper, not a caller-selected process.
    const actual = try @import("rex.zig").clientPath(native, a);
    const expected = try std.Io.Dir.cwd().realPathFileAlloc(native.io, actual, a);
    if (!std.mem.eql(u8, expected, try std.Io.Dir.cwd().realPathFileAlloc(native.io, record.client, a))) return error.InvalidBootstrap;
    try identity(native, a, record.target, cancelled);
    try storage.save(native, a, dir, "record.json", record); // Unbound intent fences lost creation ACKs.
    const result = try cli(native, a, record.cwd, record.target, &.{ "new", "deck-agent-new", "--json", "--cwd", record.cwd, "--shell=none", "--keep-open", "--", record.client, "agent", "--wizard", record.id, "--client-state", record.draftRoot }, cancelled);
    if (!result.result.ok or result.stderr.len != 0 or cancelled.load(.acquire)) return error.BootstrapLaunchUnconfirmed;
    const created = (try std.json.parseFromSlice(struct { session_id: []const u8, initial_windows: []struct { window_id: []const u8, block_ids: [][]const u8 } }, a, result.stdout, .{ .ignore_unknown_fields = true })).value;
    if (!wire.validRexSessionId(.{ .string = created.session_id }) or created.initial_windows.len != 1) return error.BootstrapLaunchUnconfirmed;
    const window = created.initial_windows[0];
    if (!wire.validRexWindowId(.{ .string = window.window_id }) or window.block_ids.len != 1 or !wire.validRexBlockId(.{ .string = window.block_ids[0] })) return error.BootstrapLaunchUnconfirmed;
    var binding: wire.RexBootstrapBinding = .{ .sessionId = created.session_id, .windowId = window.window_id, .blockId = window.block_ids[0], .pid = 1 };
    binding.pid = try process(native, a, record, binding, cancelled);
    try identity(native, a, record.target, cancelled);
    var saved = record;
    saved.binding = binding;
    try storage.save(native, a, dir, "record.json", saved);
    return binding;
}
pub fn adopt(native: Native, a: std.mem.Allocator, cwd: []const u8, machine: []const u8, plan: wire.RexAllocationPlan, cancelled: *std.atomic.Value(bool)) !shell.Result {
    const bootstrap = plan.bootstrap orelse return error.InvalidBootstrap;
    const root = try path(native, a, bootstrap.root, bootstrap.id);
    var dir = try storage.openDirectory(native, root, false);
    defer dir.close(native.io);
    const held = try storage.lock(native, dir, "claim.lock");
    defer held.close(native.io);
    var record = try load(native, a, bootstrap.root, bootstrap.id);
    const binding = record.binding orelse return error.BootstrapLaunchUnconfirmed;
    if (plan.allocationId == null or plan.clientState == null or !std.mem.eql(u8, plan.clientState.?, record.draftRoot) or !std.mem.eql(u8, record.hubId, plan.hubId) or !std.mem.eql(u8, record.machineId, machine) or !std.mem.eql(u8, record.cwd, cwd) or !std.mem.eql(u8, record.client, plan.client) or record.port != plan.port or
        !std.mem.eql(u8, record.target.executable, plan.executable) or !std.mem.eql(u8, record.target.server, plan.server) or !std.mem.eql(u8, record.target.hostId, plan.hostId) or !std.mem.eql(u8, record.target.instanceId, plan.instanceId) or !std.mem.eql(u8, binding.blockId, bootstrap.blockId)) return error.InvalidBootstrap;
    if ((record.workerSocket == null) != (plan.workerSocket == null)) return error.InvalidBootstrap;
    if (record.workerSocket) |socket| if (!std.mem.eql(u8, socket, plan.workerSocket.?)) return error.InvalidBootstrap;
    if (plan.sessionId) |sid| if (!std.mem.eql(u8, sid, binding.sessionId)) return error.InvalidBootstrap;
    if (record.claim) |claim| if (!std.mem.eql(u8, claim.chatId, plan.chatId) or !std.mem.eql(u8, claim.allocationId, plan.allocationId.?)) return error.BootstrapAlreadyClaimed;
    try identity(native, a, record.target, cancelled);
    if (try process(native, a, record, binding, cancelled) != binding.pid) return error.BootstrapNotRunning;
    const query: wire.RexInspectionQuery = .{ .executable = plan.executable, .scope = .{ .server = plan.server, .hostId = plan.hostId, .instanceId = plan.instanceId, .sessionId = binding.sessionId, .windowId = binding.windowId, .blockId = binding.blockId } };
    const inspected = try @import("rex_inspect.zig").inspect(native, a, cwd, try std.json.Stringify.valueAlloc(a, query, .{}), cancelled);
    if (!inspected.ok or (try wire.parseRexInspectionObservation(a, inspected.output)).value.state != .running or cancelled.load(.acquire)) return error.BootstrapNotRunning;
    record.claim = .{ .chatId = plan.chatId, .allocationId = plan.allocationId.? };
    try storage.save(native, a, dir, "record.json", record);
    const creation: wire.RexCreation = .{ .version = 1, .server = plan.server, .hostId = plan.hostId, .instanceId = plan.instanceId, .sessionId = binding.sessionId, .windowId = binding.windowId, .blockId = binding.blockId, .chatId = plan.chatId, .hubId = plan.hubId, .allocationId = plan.allocationId, .readiness = "not_checked" };
    return .{ .ok = true, .code = "allocated", .output = try std.json.Stringify.valueAlloc(a, creation, .{}) };
}

test "native bootstrap proof refuses wrong host/root/cwd/claim and unsafe records before any Rex invocation" {
    const native: Native = .{ .io = std.testing.io, .environ = .empty };
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.setPermissions(native.io, .fromMode(0o700));
    const root = try tmp.dir.realPathFileAlloc(native.io, ".", a);
    var starts = try storage.directory(native, try std.fs.path.join(a, &.{ root, "startups" }));
    defer starts.close(native.io);
    const id = "00000000-0000-4000-8000-000000000001";
    const machine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    var dir = try storage.directory(native, try path(native, a, root, id));
    defer dir.close(native.io);
    const record: wire.RexBootstrapRecord = .{ .version = 1, .id = id, .hubId = id, .machineId = machine, .cwd = "/saved", .client = "/no-deck", .draftRoot = root, .port = 52800, .target = .{ .executable = "/no-rex", .server = "unix:///tmp/test.sock", .hostId = id, .instanceId = id }, .binding = .{ .sessionId = "session:00000000-0000-4000-8000-000000000001", .windowId = "window:00000000-0000-4000-8000-000000000001", .blockId = "block:00000000-0000-4000-8000-000000000001", .pid = 1 }, .claim = .{ .chatId = "2", .allocationId = id } };
    try storage.save(native, a, dir, "record.json", record);
    var plan: wire.RexAllocationPlan = .{ .executable = record.target.executable, .server = record.target.server, .hostId = id, .instanceId = id, .client = record.client, .port = 52800, .hubId = id, .chatId = "3", .allocationId = "00000000-0000-4000-8000-000000000002", .label = "task", .bootstrap = .{ .id = id, .root = root, .blockId = record.binding.?.blockId }, .clientState = root };
    var cancelled = std.atomic.Value(bool).init(false);
    try std.testing.expectError(error.InvalidBootstrap, adopt(native, a, "/saved", "other", plan, &cancelled));
    try std.testing.expectError(error.InvalidBootstrap, adopt(native, a, "/changed", machine, plan, &cancelled));
    try std.testing.expectError(error.BootstrapAlreadyClaimed, adopt(native, a, "/saved", machine, plan, &cancelled));
    plan.clientState = "/another-cache";
    try std.testing.expectError(error.InvalidBootstrap, adopt(native, a, "/saved", machine, plan, &cancelled));
    plan.clientState = root;
    const file = try dir.openFile(native.io, "record.json", .{});
    defer file.close(native.io);
    try file.setPermissions(native.io, .fromMode(0o644));
    try std.testing.expectError(error.UnsafeMcpFile, load(native, a, root, id));
    const absent = try std.fs.path.join(a, &.{ root, "never-created" });
    try std.testing.expectError(error.FileNotFound, path(native, a, absent, id));
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.cwd().statFile(native.io, absent, .{}));
}
