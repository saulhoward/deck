const std = @import("std");
const shell = @import("shell.zig");
const wire = @import("generated/contracts.zig");
const Value = std.json.Value;
const Query = wire.RexInspectionQuery;
const Observation = wire.RexInspectionObservation;
const State = wire.RexPresenceState;

fn call(allocator: std.mem.Allocator, cwd: []const u8, query: Query, args: []const []const u8, cancelled: *std.atomic.Value(bool)) !shell.Captured {
    var argv: std.array_list.Managed([]const u8) = .init(allocator);
    defer argv.deinit();
    try argv.appendSlice(&.{ query.executable, "--autostart=false", "--timeout", "2s", "--server", query.scope.server });
    try argv.appendSlice(args);
    return shell.runArgvCaptured(allocator, cwd, argv.items, 4, cancelled);
}
fn json(allocator: std.mem.Allocator, result: shell.Captured) !Value {
    if (!result.result.ok or result.stderr.len != 0) return error.ReadFailed;
    return (try std.json.parseFromSlice(Value, allocator, result.stdout, .{})).value;
}
fn object(value: Value) !std.json.ObjectMap {
    return if (value == .object) value.object else error.InvalidResponse;
}
fn field(value: Value, key: []const u8) !Value {
    return (try object(value)).get(key) orelse error.InvalidResponse;
}
fn text(value: Value) ![]const u8 {
    return if (value == .string) value.string else error.InvalidResponse;
}
fn array(value: Value) ![]const Value {
    return switch (value) {
        .null => &.{},
        .array => value.array.items,
        else => error.InvalidResponse,
    };
}
fn integer(value: Value, min: i64, max: i64) !i64 {
    const n: i64 = switch (value) {
        .integer => value.integer,
        .float => if (std.math.isFinite(value.float) and @floor(value.float) == value.float and value.float >= @as(f64, @floatFromInt(min)) and value.float <= @as(f64, @floatFromInt(max))) @intFromFloat(value.float) else return error.InvalidResponse,
        else => return error.InvalidResponse,
    };
    return if (n >= min and n <= max) n else error.InvalidResponse;
}
const Identity = enum { same, changed, unavailable, inconclusive, cancelled };
fn identity(allocator: std.mem.Allocator, cwd: []const u8, query: Query, cancelled: *std.atomic.Value(bool)) Identity {
    const result = call(allocator, cwd, query, &.{ "server", "status", "--json" }, cancelled) catch return .unavailable;
    if (cancelled.load(.acquire)) return .cancelled;
    if (!result.result.ok) return if (std.mem.eql(u8, result.result.code, "invalid_output")) .inconclusive else .unavailable;
    const value = json(allocator, result) catch return .inconclusive;
    const endpoint = text(field(value, "endpoint") catch return .inconclusive) catch return .inconclusive;
    const host = field(value, "host_id") catch return .inconclusive;
    const instance = field(value, "instance_id") catch return .inconclusive;
    if (!wire.validRexUuid(host) or !wire.validRexUuid(instance)) return .inconclusive;
    const revision = integer(field(value, "api_revision") catch return .inconclusive, 0, 9007199254740991) catch return .inconclusive;
    if (!@import("rex.zig").supportedApi(revision)) return .inconclusive;
    return if (std.mem.eql(u8, endpoint, query.scope.server) and std.mem.eql(u8, host.string, query.scope.hostId) and std.mem.eql(u8, instance.string, query.scope.instanceId)) .same else .changed;
}
fn add(seen: *std.StringHashMap(void), id: []const u8) !void {
    if ((try seen.getOrPut(id)).found_existing) return error.BindingConflict;
}
const Block = struct { id: []const u8, window: []const u8, host: []const u8, flavor: []const u8 };
const View = struct { revision: i64, found: bool, coherent: bool, blocks: []const Block };
fn complete(value: Value) !void {
    const fields = try object(value);
    for ([_][]const u8{ "truncated", "partial", "has_more", "next", "next_cursor", "cursor" }) |key| {
        if (fields.contains(key)) return error.UnsupportedResponse;
    }
}
fn view(allocator: std.mem.Allocator, value: Value, query: Query) !View {
    try complete(value);
    const sid = try field(value, "session_id");
    if (!wire.validRexSessionId(sid) or !std.mem.eql(u8, sid.string, query.scope.sessionId)) return error.BindingConflict;
    const revision = try integer(try field(value, "revision"), 0, 9007199254740991);
    var windows = std.StringHashMap(void).init(allocator);
    var blocks = std.StringHashMap(void).init(allocator);
    var metadata: std.array_list.Managed(Block) = .init(allocator);
    defer metadata.deinit();
    defer windows.deinit();
    defer blocks.deinit();
    var found = false;
    var coherent = false;
    const items = try array(try field(value, "windows"));
    if (items.len > 128) return error.InvalidResponse;
    var layers_count: usize = 0;
    for (items) |window| {
        const wid = try field(window, "window_id");
        if (!wire.validRexWindowId(wid)) return error.InvalidResponse;
        try add(&windows, wid.string);
        const layers = try array(try field(window, "layers"));
        layers_count += layers.len;
        if (layers_count > 128) return error.InvalidResponse;
        for (layers) |layer| for (try array(try field(layer, "blocks"))) |block| {
            const bid = try field(block, "block_id");
            const host = try field(block, "host_id");
            const flavor = try text(try field(block, "flavor"));
            if (!wire.validRexBlockId(bid) or !wire.validRexUuid(host)) return error.InvalidResponse;
            try add(&blocks, bid.string);
            try metadata.append(.{ .id = bid.string, .window = wid.string, .host = host.string, .flavor = flavor });
            if (blocks.count() > 512) return error.InvalidResponse;
            if (std.mem.eql(u8, bid.string, query.scope.blockId)) {
                found = true;
                coherent = std.mem.eql(u8, wid.string, query.scope.windowId) and std.mem.eql(u8, host.string, query.scope.hostId) and std.mem.eql(u8, flavor, "com.superlogical.terminal.shell");
            }
        };
    }
    return .{ .revision = revision, .found = found, .coherent = coherent, .blocks = try metadata.toOwnedSlice() };
}
fn list(allocator: std.mem.Allocator, value: Value, query: Query, before: View) !struct { found: bool, coherent: bool, complete: bool } {
    try complete(value);
    const blocks = try array(try field(value, "blocks"));
    if (blocks.len > 512) return error.InvalidResponse;
    var consistent = true;
    var placed_count: usize = 0;
    var seen = std.StringHashMap(void).init(allocator);
    defer seen.deinit();
    var found = false;
    var coherent = false;
    for (blocks) |block| {
        const bid = try field(block, "block_id");
        const host = try field(block, "host_id");
        // Detached API 8 summaries may omit their optional window identity.
        const wid = (try object(block)).get("window_id") orelse .null;
        const flavor = try text(try field(block, "flavor"));
        const placement = try text(try field(block, "placement"));
        if (!wire.validRexBlockId(bid) or !wire.validRexUuid(host) or (wid != .null and !wire.validRexWindowId(wid))) return error.InvalidResponse;
        if (!std.mem.eql(u8, placement, "placed") and !std.mem.eql(u8, placement, "detached")) return error.InvalidResponse;
        try add(&seen, bid.string);
        if (std.mem.eql(u8, placement, "placed")) {
            placed_count += 1;
            var matched = false;
            for (before.blocks) |entry| {
                if (std.mem.eql(u8, entry.id, bid.string) and wid == .string and std.mem.eql(u8, entry.window, wid.string) and std.mem.eql(u8, entry.host, host.string) and std.mem.eql(u8, entry.flavor, flavor)) matched = true;
            }
            if (!matched) consistent = false;
        } else {
            if (wid != .null) consistent = false;
            for (before.blocks) |entry| {
                if (std.mem.eql(u8, entry.id, bid.string)) consistent = false;
            }
        }
        if (std.mem.eql(u8, bid.string, query.scope.blockId)) {
            found = true;
            coherent = wid == .string and std.mem.eql(u8, wid.string, query.scope.windowId) and std.mem.eql(u8, host.string, query.scope.hostId) and std.mem.eql(u8, flavor, "com.superlogical.terminal.shell") and std.mem.eql(u8, placement, "placed");
        }
    }
    return .{ .found = found, .coherent = coherent, .complete = consistent and placed_count == before.blocks.len };
}
fn process(value: Value) !struct { state: State, exit: ?i64 } {
    // API 8 omits absent optional process fields (including child/foreground
    // after exit). Omitted/null without a completed exit record is pending.
    const fields = try object(value);
    const child = fields.get("child") orelse .null;
    const foreground = fields.get("foreground") orelse .null;
    const exit = fields.get("last_exit") orelse .null;
    if (child != .null) _ = try integer(try field(child, "pid"), 1, 4294967295);
    if (foreground != .null) _ = try integer(try field(foreground, "pid"), 1, 4294967295);
    const code = if (exit == .null) null else try integer(try field(exit, "exit_code"), -2147483648, 2147483647);
    return if (child != .null or foreground != .null) .{ .state = .running, .exit = null } else if (code != null) .{ .state = .exited, .exit = code } else .{ .state = .pending, .exit = null };
}
fn failure(err: anyerror) State {
    return if (err == error.BindingConflict) .conflict else .inconclusive;
}
fn objects(allocator: std.mem.Allocator, cwd: []const u8, query: Query, cancelled: *std.atomic.Value(bool)) !Observation {
    var observation = Observation{ .version = 1, .scope = query.scope, .state = .inconclusive, .exitCode = null, .revision = null };
    const args = try std.json.Stringify.valueAlloc(allocator, .{ .session_id = query.scope.sessionId }, .{});
    const first = try call(allocator, cwd, query, &.{ "api", "call", "session.view", args }, cancelled);
    // Installed API 8 evidence: the native API path, not CLI target resolution.
    // Require exact scoped stderr, empty stdout, normal exit 3 and lossless bounds.
    const absent = try std.fmt.allocPrint(allocator, "Error: stream response \"control-1\" failed: session {s} not found (status=404 code=session_not_found)\n", .{query.scope.sessionId});
    if (std.mem.eql(u8, first.result.code, "exit_nonzero") and first.result.exitCode == 3 and !first.result.truncated and first.stdout.len == 0 and std.mem.eql(u8, first.stderr, absent)) {
        observation.state = .missing_session;
        return observation;
    }
    const before = view(allocator, try json(allocator, first), query) catch |err| {
        observation.state = failure(err);
        return observation;
    };
    observation.revision = before.revision;
    const listed = list(allocator, try json(allocator, try call(allocator, cwd, query, &.{ "api", "call", "session.list_blocks", args }, cancelled)), query, before) catch |err| {
        observation.state = failure(err);
        return observation;
    };
    if ((before.found and !before.coherent) or (listed.found and !listed.coherent) or before.found != listed.found) {
        observation.state = .conflict;
    } else if (!listed.complete) {
        observation.state = .inconclusive;
    } else if (!listed.found) {
        observation.state = .missing_terminal;
    } else {
        const process_args = try std.json.Stringify.valueAlloc(allocator, .{ .session_id = query.scope.sessionId, .block_id = query.scope.blockId, .args = struct {}{} }, .{});
        const state = try process(try json(allocator, try call(allocator, cwd, query, &.{ "api", "call", "com.superlogical.terminal.process", process_args }, cancelled)));
        observation.state = state.state;
        observation.exitCode = state.exit;
    }
    const after = try view(allocator, try json(allocator, try call(allocator, cwd, query, &.{ "api", "call", "session.view", args }, cancelled)), query);
    if (after.revision != before.revision or after.found != before.found or after.coherent != before.coherent) {
        observation.state = .inconclusive;
        observation.exitCode = null;
    }
    return observation;
}
pub fn inspect(allocator: std.mem.Allocator, cwd: []const u8, encoded: []const u8, cancelled: *std.atomic.Value(bool)) !shell.Result {
    if (encoded.len > 16 * 1024) return .{ .ok = false, .code = "invalid", .output = "invalid" };
    const parsed = wire.parseRexInspectionQuery(allocator, encoded) catch return .{ .ok = false, .code = "invalid", .output = "invalid" };
    defer parsed.deinit();
    const query = parsed.value;
    const socket = if (std.mem.startsWith(u8, query.scope.server, "unix:///")) query.scope.server[7..] else "";
    if (!std.fs.path.isAbsolute(cwd) or query.executable.len > 4096 or !std.fs.path.isAbsolute(query.executable) or std.mem.indexOfScalar(u8, query.executable, 0) != null or socket.len == 0 or socket.len > 100 or std.mem.indexOfAny(u8, socket, "?#%\x00\r\n") != null) return .{ .ok = false, .code = "invalid", .output = "invalid" };
    var observation = Observation{ .version = 1, .scope = query.scope, .state = .inconclusive, .exitCode = null, .revision = null };
    const before = identity(allocator, cwd, query, cancelled);
    if (before == .same) {
        observation = objects(allocator, cwd, query, cancelled) catch |err| blk: {
            observation.state = failure(err);
            break :blk observation;
        };
        switch (identity(allocator, cwd, query, cancelled)) {
            .same => {},
            .changed => observation.state = .identity_changed,
            .cancelled => observation.state = .cancelled,
            .unavailable, .inconclusive => observation.state = .inconclusive,
        }
    } else observation.state = switch (before) {
        .changed => .identity_changed,
        .unavailable => .unavailable,
        .cancelled => .cancelled,
        else => .inconclusive,
    };
    if (cancelled.load(.acquire)) observation.state = .cancelled;
    if (observation.state != .exited) observation.exitCode = null;
    const output = try std.json.Stringify.valueAlloc(allocator, observation, .{});
    const checked = try wire.parseRexInspectionObservation(allocator, output);
    checked.deinit();
    return .{ .ok = true, .code = "rex_inspected", .output = output };
}
