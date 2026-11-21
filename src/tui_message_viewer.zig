//! Explicit client-local export. Not a Pi task, draft edit, or task Rex allocation.
//! A Rex-owned helper outlives the invoking TUI and owns the export's lifetime.
const std = @import("std");
const Native = @import("native.zig");
const Allocator = std.mem.Allocator;
const wire = @import("generated/contracts.zig");
const processlib = @import("shell.zig");
const resolve = @import("rex_resolve.zig");
const private = @import("mcp_profiles.zig");
const helper = @import("tui_message_viewer_helper.zig");
pub const Kind = enum { nvim, leaf };
pub const limit = 16 * 1024 * 1024;
pub const helper_command = "__message-viewer";

fn executable(native: Native, a: Allocator, env: *std.process.Environ.Map, kind: Kind) ![]const u8 {
    var dirs = std.mem.splitScalar(u8, env.get("PATH") orelse "", ':');
    while (dirs.next()) |dir| {
        // Never accidentally execute a workspace program via empty/relative PATH.
        if (!private.absolute(dir)) continue;
        const path = try std.fs.path.join(a, &.{ dir, @tagName(kind) });
        available(native, path) catch continue;
        return path;
    }
    return error.ViewerUnavailable;
}
fn available(native: Native, path: []const u8) !void {
    if (!private.absolute(path)) return error.ViewerUnavailable;
    std.Io.Dir.cwd().access(native.io, path, .{ .execute = true }) catch return error.ViewerUnavailable;
    const info = std.Io.Dir.cwd().statFile(native.io, path, .{}) catch return error.ViewerUnavailable;
    if (info.kind != .file) return error.ViewerUnavailable;
}
fn cli(native: Native, a: Allocator, cwd: []const u8, target: wire.RexOpenTarget, suffix: []const []const u8, cancelled: *std.atomic.Value(bool)) !processlib.Captured {
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(a, &.{ target.executable, "--autostart=false", "--timeout", "2s", "--server", target.server });
    try argv.appendSlice(a, suffix);
    return processlib.runArgvCaptured(native, a, cwd, argv.items, 4, cancelled);
}
fn targetFor(native: Native, a: Allocator, cwd: []const u8, options: wire.RexTargetOptions, cancelled: *std.atomic.Value(bool)) !wire.RexOpenTarget {
    const result = try resolve.resolve(native, a, cwd, try std.json.Stringify.valueAlloc(a, options, .{}), cancelled);
    if (cancelled.load(.acquire)) return error.Cancelled;
    if (!result.ok) return error.ViewerRexUnavailable;
    return (try wire.parseRexOpenTarget(a, result.output)).value;
}
fn membership(native: Native, a: Allocator, cwd: []const u8, target: wire.RexOpenTarget, session: []const u8, block: []const u8, cancelled: *std.atomic.Value(bool)) !void {
    // Native block-inspect API: unlike a CLI label/focus lookup, this fails when
    // the exact block is not a member of the exact session. Schema confirmed by
    // Rex `api describe session.describe_block` (API 8+, also used by block inspect).
    const args = try std.json.Stringify.valueAlloc(a, .{ .session_id = session, .block_id = block }, .{});
    const result = try cli(native, a, cwd, target, &.{ "api", "call", "session.describe_block", args }, cancelled);
    if (cancelled.load(.acquire)) return error.Cancelled;
    if (!result.result.ok or result.stderr.len != 0) return error.ViewerRexContext;
    const Description = struct { block: struct { block_id: []const u8, window_id: []const u8, host_id: []const u8, flavor: []const u8, placement: []const u8 } };
    const value = (std.json.parseFromSlice(Description, a, result.stdout, .{ .ignore_unknown_fields = true }) catch return error.ViewerRexContext).value.block;
    if (!std.mem.eql(u8, value.block_id, block) or !std.mem.eql(u8, value.host_id, target.hostId) or
        !wire.validRexWindowId(.{ .string = value.window_id }) or !std.mem.eql(u8, value.flavor, "com.superlogical.terminal.shell") or !std.mem.eql(u8, value.placement, "placed")) return error.ViewerRexContext;
}
fn admitted(a: Allocator, bytes: []const u8, session: []const u8, invoking_block: []const u8) bool {
    const Creation = struct { session_id: ?[]const u8 = null, window_id: []const u8, block_ids: []const []const u8 };
    const value = (std.json.parseFromSlice(Creation, a, bytes, .{ .ignore_unknown_fields = true }) catch return false).value;
    if (value.session_id) |sid| if (!std.mem.eql(u8, sid, session)) return false;
    return wire.validRexWindowId(.{ .string = value.window_id }) and value.block_ids.len == 1 and
        wire.validRexBlockId(.{ .string = value.block_ids[0] }) and !std.mem.eql(u8, value.block_ids[0], invoking_block);
}
fn uncertainty(native: Native, a: Allocator, root: []const u8) void {
    // JSON-quote even a user-chosen TMPDIR: no terminal control injection and no
    // raw Rex stderr, editor flags, content, or provider environment in errors.
    const quoted = std.json.Stringify.valueAlloc(a, root, .{}) catch return;
    const message = std.fmt.allocPrint(a, "\r\ndeck: viewer launch unconfirmed; do not automatically retry. Private export directory: {s}. Inspect Rex; only after its viewer has exited, remove message.md and control.json and this directory.\r\n", .{quoted}) catch return;
    std.Io.File.stderr().writeStreamingAll(native.io, message) catch {};
}

/// Returns launch admission, not viewer readiness. Never waits for the viewer.
/// `env` is the native invoking client's environment, not runtime/model context.
pub fn open(native: Native, a: Allocator, env: *std.process.Environ.Map, content: []const u8, kind: Kind, cancelled: *std.atomic.Value(bool)) !void {
    if (content.len > limit) return error.MessageTooLarge; // Before all effects.
    if (cancelled.load(.acquire)) return error.Cancelled;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const scratch = arena.allocator();
    const cwd = try std.process.currentPathAlloc(native.io, scratch);
    const program = executable(native, scratch, env, kind) catch return switch (kind) {
        .nvim => error.NvimUnavailable,
        .leaf => error.LeafUnavailable,
    };
    const session = env.get("REX_SESSION") orelse return error.ViewerRexContext;
    const block = env.get("REX_BLOCK") orelse return error.ViewerRexContext;
    if (!wire.validRexSessionId(.{ .string = session }) or !wire.validRexBlockId(.{ .string = block })) return error.ViewerRexContext;
    const server = env.get("REX_SERVER");
    if (server) |s| if (!@import("rex_endpoint.zig").valid(s)) return error.ViewerRexUnavailable;
    const rex = resolve.findRex(native, scratch) catch return error.ViewerRexUnavailable;
    const target = try targetFor(native, scratch, cwd, .{ .executable = rex, .server = server }, cancelled);
    try membership(native, scratch, cwd, target, session, block, cancelled);
    // Fence restarts/identity changes across membership inspection. No saved
    // RexDoc or task allocation is involved in this local user action.
    _ = try targetFor(native, scratch, cwd, .{ .executable = target.executable, .server = target.server, .hostId = target.hostId, .instanceId = target.instanceId }, cancelled);
    const client = try @import("rex.zig").clientPath(native, scratch);
    try available(native, client);
    const tmp = env.get("TMPDIR") orelse "/tmp";
    if (!private.absolute(tmp)) return error.InvalidTemporaryDirectory;
    const parent = try std.Io.Dir.cwd().realPathFileAlloc(native.io, tmp, scratch);
    var random: [16]u8 = undefined;
    native.io.random(&random);
    const root = try std.fmt.allocPrint(scratch, "{s}/deck-message-{s}", .{ parent, std.fmt.bytesToHex(random, .lower) });
    if (cancelled.load(.acquire)) return error.Cancelled;
    try std.Io.Dir.createDirAbsolute(native.io, root, .fromMode(0o700));
    var dir = try @import("private_store.zig").openDirectory(native, root, false);
    defer dir.close(native.io);
    var dispatched = false;
    defer if (!dispatched) helper.cleanup(native, dir, root);
    try helper.write(native, dir, "message.md", content);
    const control = try std.json.Stringify.valueAlloc(scratch, helper.Control{ .argv = &.{program}, .cwd = cwd }, .{});
    if (control.len > helper.control_limit) return error.InvalidViewerControl;
    try helper.write(native, dir, "control.json", control);
    const path = try std.fs.path.join(scratch, &.{ root, "control.json" });
    if (cancelled.load(.acquire)) return error.Cancelled;
    // From this point every failure is uncertain: the server may already have
    // launched an independent terminal. Neither cancel nor TUI detach owns it.
    dispatched = true;
    const result = cli(native, scratch, cwd, target, &.{ "run", "--session", session, "--cwd", cwd, "--shell=none", "--json", "--", client, helper_command, path }, cancelled) catch {
        uncertainty(native, scratch, root);
        return error.ViewerLaunchUnconfirmed;
    };
    if (!result.result.ok or result.stderr.len != 0 or cancelled.load(.acquire) or !admitted(scratch, result.stdout, session, block)) {
        uncertainty(native, scratch, root);
        return error.ViewerLaunchUnconfirmed;
    }
}

pub const runHelper = helper.run;

test {
    _ = @import("tui_message_viewer_test.zig");
}
