//! Adopt the CURRENT native Deck process, never a new Rex block or a shell PID.
//! All Rex operations are bounded read-only calls with autostart disabled. The
//! environment supplies lookup hints only; local kernel and Rex proofs must meet.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const os = @import("rex_here_process.zig");
const endpoint = @import("rex_endpoint.zig");
pub const Presence = enum { running, exited };
const Target = wire.RexOpenTarget;
const Binding = wire.RexBootstrapBinding;
const Cancelled = std.atomic.Value(bool);
fn call(native: Native, a: std.mem.Allocator, target: Target, args: []const []const u8, cancelled: *Cancelled) ![]const u8 {
    if (cancelled.load(.acquire)) return error.Cancelled;
    if (!endpoint.valid(target.server) or !@import("mcp_profiles.zig").absolute(target.executable)) return error.InvalidBootstrap;
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(a, &.{ target.executable, "--autostart=false", "--timeout", "2s", "--server", target.server });
    try argv.appendSlice(a, args);
    // The saved canonical chat cwd is NOT necessarily the invoking cwd on resume.
    const result = try @import("shell.zig").runArgvCaptured(native, a, "/", argv.items, 4, cancelled);
    if (cancelled.load(.acquire)) return error.Cancelled;
    if (!result.result.ok or result.result.truncated or result.stderr.len != 0) return error.RexReadFailed;
    return result.stdout;
}
fn identity(native: Native, a: std.mem.Allocator, target: Target, cancelled: *Cancelled) !void {
    const bytes = try call(native, a, target, &.{ "server", "status", "--json" }, cancelled);
    const Status = struct { endpoint: []const u8, host_id: []const u8, instance_id: []const u8, api_revision: @import("rex.zig").ApiRevision, you: struct { transport: []const u8 } };
    const status = (try std.json.parseFromSlice(Status, a, bytes, .{ .ignore_unknown_fields = true })).value;
    if (!endpoint.same(status.endpoint, target.server) or !std.mem.eql(u8, status.you.transport, "unix") or !std.mem.eql(u8, status.host_id, target.hostId) or !std.mem.eql(u8, status.instance_id, target.instanceId)) return error.RexIdentityChanged;
    if (!@import("rex.zig").supportedAutomaticApi(status.api_revision.value)) return error.InvalidRexIdentity;
}
fn describe(native: Native, a: std.mem.Allocator, target: Target, sid: []const u8, bid: []const u8, cancelled: *Cancelled) ![]const u8 {
    if (!wire.validRexSessionId(.{ .string = sid }) or !wire.validRexBlockId(.{ .string = bid })) return error.InvalidBootstrap;
    const args = try std.json.Stringify.valueAlloc(a, .{ .session_id = sid, .block_id = bid }, .{});
    const bytes = try call(native, a, target, &.{ "api", "call", "session.describe_block", args }, cancelled);
    const Description = struct { block: struct { block_id: []const u8, window_id: []const u8, host_id: []const u8, flavor: []const u8, placement: []const u8 } };
    const block = (try std.json.parseFromSlice(Description, a, bytes, .{ .ignore_unknown_fields = true })).value.block;
    if (!std.mem.eql(u8, block.block_id, bid) or !wire.validRexWindowId(.{ .string = block.window_id }) or !std.mem.eql(u8, block.host_id, target.hostId) or !std.mem.eql(u8, block.flavor, "com.superlogical.terminal.shell") or !std.mem.eql(u8, block.placement, "placed")) return error.BindingConflict;
    return block.window_id;
}
const RexProcess = struct { pid: i64, user_id: i64 };
const Processes = struct { child: ?RexProcess = null, foreground: ?RexProcess = null };
fn processes(native: Native, a: std.mem.Allocator, target: Target, b: Binding, cancelled: *Cancelled) !Processes {
    const args = try std.json.Stringify.valueAlloc(a, .{ .session_id = b.sessionId, .block_id = b.blockId, .args = struct {}{} }, .{});
    const bytes = try call(native, a, target, &.{ "api", "call", "com.superlogical.terminal.process", args }, cancelled);
    const value = (try std.json.parseFromSlice(Processes, a, bytes, .{ .ignore_unknown_fields = true })).value;
    for ([_]?RexProcess{ value.child, value.foreground }) |item| {
        const p = item orelse return error.ProcessReadFailed;
        if (p.pid < 1 or p.pid > 2147483647 or p.user_id < 0 or p.user_id > 4294967295) return error.InvalidProcess;
    }
    return value;
}
fn membership(native: Native, a: std.mem.Allocator, value: Processes, client: os.Sample, root: os.Sample) !void {
    const child = value.child orelse return error.ProcessReadFailed;
    const foreground = value.foreground orelse return error.ProcessReadFailed;
    if (child.pid != root.proof.pid or child.user_id != root.proof.uid or client.proof.uid != root.proof.uid or client.proof.uid != std.c.getuid() or std.c.geteuid() != std.c.getuid()) return error.ProcessConflict;
    if (client.proof.pgid != client.kernel.foreground) return error.NotForeground;
    try os.descendant(native, a, client, root);
    const fg = try os.sample(native, a, foreground.pid);
    if (foreground.user_id != fg.proof.uid or fg.proof.pgid != client.proof.pgid) return error.ProcessConflict;
    try os.descendant(native, a, fg, root);
}
/// Pure capture: callers persist the returned record + index before admission.
/// `base.client` remains the approved worker launch wrapper; it is intentionally
/// NOT equated with the native executable that the OS proves for this PID.
pub fn capture(native: Native, a: std.mem.Allocator, base: wire.RexBootstrapRecord, chat_id: []const u8, cancelled: *Cancelled) !wire.RexBootstrapRecord {
    if (base.binding != null or base.here != null or base.claim != null or !wire.validPiId(.{ .string = chat_id })) return error.InvalidBootstrap;
    const sid = native.environ.getPosix("REX_SESSION") orelse return error.NotRexTerminal;
    const bid = native.environ.getPosix("REX_BLOCK") orelse return error.NotRexTerminal;
    if (!wire.validRexSessionId(.{ .string = sid }) or !wire.validRexBlockId(.{ .string = bid })) return error.NotRexTerminal;
    if (cancelled.load(.acquire)) return error.Cancelled;
    const client = try os.sample(native, a, std.c.getpid());
    if (client.proof.pgid != client.kernel.foreground) return error.NotForeground;
    try identity(native, a, base.target, cancelled);
    const window = try describe(native, a, base.target, sid, bid, cancelled);
    const binding: Binding = .{ .sessionId = try a.dupe(u8, sid), .windowId = window, .blockId = try a.dupe(u8, bid), .pid = client.proof.pid };
    const value = try processes(native, a, base.target, binding, cancelled);
    const root = try os.sample(native, a, value.child.?.pid);
    try membership(native, a, value, client, root);
    var record = base;
    record.binding = binding;
    record.here = .{ .chatId = try a.dupe(u8, chat_id), .process = client.proof, .terminal = root.proof };
    if (try verify(native, a, record, cancelled) != .running) return error.BootstrapNotRunning;
    return record;
}
/// Only kernel absence/death or changed birth is `exited`. A surviving shell,
/// unreadable PID, foreground handoff, exec, changed TTY, or Rex conflict never
/// silently becomes running or absence. No persistence occurs here.
pub fn verify(native: Native, a: std.mem.Allocator, record: wire.RexBootstrapRecord, cancelled: *Cancelled) !Presence {
    const proof = record.here orelse return error.InvalidBootstrap;
    const b = record.binding orelse return error.InvalidBootstrap;
    if (b.pid != proof.process.pid) return error.BindingConflict;
    if (proof.process.uid != std.c.getuid() or proof.terminal.uid != proof.process.uid or std.c.geteuid() != std.c.getuid()) return error.ProcessConflict;
    // Validate even callers constructing typed records directly (not just JSON).
    const checked = try wire.parseRexHereProof(a, try std.json.Stringify.valueAlloc(a, proof, .{}));
    checked.deinit();
    try identity(native, a, record.target, cancelled);
    if (!std.mem.eql(u8, b.windowId, try describe(native, a, record.target, b.sessionId, b.blockId, cancelled))) return error.BindingConflict;
    const before = try os.probe(native, a, proof.process.pid);
    const exited = before == null or !std.mem.eql(u8, before.?.start, proof.process.start);
    if (!exited) {
        const client = try os.sample(native, a, proof.process.pid);
        const root = try os.sample(native, a, proof.terminal.pid);
        if (!os.same(client.proof, proof.process) or !os.same(root.proof, proof.terminal)) return error.ProcessConflict;
        try membership(native, a, try processes(native, a, record.target, b, cancelled), client, root);
        if (!os.same(client.proof, (try os.sample(native, a, client.proof.pid)).proof) or !os.same(root.proof, (try os.sample(native, a, root.proof.pid)).proof)) return error.ProcessConflict;
    }
    if (!std.mem.eql(u8, b.windowId, try describe(native, a, record.target, b.sessionId, b.blockId, cancelled))) return error.BindingConflict;
    try identity(native, a, record.target, cancelled);
    if (cancelled.load(.acquire)) return error.Cancelled;
    if (exited) return .exited;
    // The final Rex helper must not hide a client exit/foreground handoff.
    const last = (try os.probe(native, a, proof.process.pid)) orelse return .exited;
    if (!std.mem.eql(u8, last.start, proof.process.start)) return .exited;
    const final_client = try os.sample(native, a, proof.process.pid);
    const final_root = try os.sample(native, a, proof.terminal.pid);
    if (!os.same(final_client.proof, proof.process) or !os.same(final_root.proof, proof.terminal) or final_client.kernel.foreground != final_client.proof.pgid) return error.ProcessConflict;
    try os.descendant(native, a, final_client, final_root);
    return .running;
}

test "here capture rejects absent/partial/short environment before any Rex invocation" {
    const base: wire.RexBootstrapRecord = .{ .version = 1, .id = "00000000-0000-4000-8000-000000000001", .hubId = "00000000-0000-4000-8000-000000000001", .machineId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .cwd = "/saved", .client = "/wrapper", .draftRoot = "/private", .port = 52800, .target = .{ .executable = "/never-execute", .server = "unix:///tmp/rex.sock", .hostId = "00000000-0000-4000-8000-000000000001", .instanceId = "00000000-0000-4000-8000-000000000001" } };
    var cancelled = Cancelled.init(false);
    try std.testing.expectError(error.NotRexTerminal, capture(.{ .io = std.testing.io, .environ = .empty }, std.testing.allocator, base, "1", &cancelled));
    var env: [2:null]?[*:0]u8 = .{ @constCast("REX_SESSION=session:short"), @constCast("REX_BLOCK=block:short") };
    try std.testing.expectError(error.NotRexTerminal, capture(.{ .io = std.testing.io, .environ = .{ .block = .{ .slice = &env } } }, std.testing.allocator, base, "1", &cancelled));
}
