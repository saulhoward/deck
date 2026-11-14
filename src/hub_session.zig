//! Local managed hub terminal. Separate from task allocation/participation.
//! Serialize launchers and retain an uncertain intent before touching Rex. A
//! missing acknowledgement never authorizes duplicate creation or label adoption.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const storage = @import("private_store.zig");
const Status = struct { hubId: []const u8, chatId: []const u8, machineId: []const u8, cwd: []const u8 };
const Record = struct { version: u32 = 1, hubId: []const u8, chatId: []const u8, port: u16, target: wire.RexOpenTarget, pending: bool = false, binding: ?wire.RexCreation = null };
const Options = struct { port: u16 = 52800, directory: ?[]const u8 = null, executable: ?[]const u8 = null, server: ?[]const u8 = null };
fn options(args: []const []const u8) !Options {
    var value: Options = .{};
    var seen_port = false;
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        if (i + 1 >= args.len) return error.InvalidArguments;
        if (std.mem.eql(u8, args[i], "--port") and !seen_port) {
            value.port = try std.fmt.parseInt(u16, args[i + 1], 10);
            if (value.port == 0) return error.InvalidArguments;
            seen_port = true;
        } else if (std.mem.eql(u8, args[i], "--directory") and value.directory == null) {
            value.directory = args[i + 1];
        } else if (std.mem.eql(u8, args[i], "--rex") and value.executable == null) {
            value.executable = args[i + 1];
        } else if (std.mem.eql(u8, args[i], "--server") and value.server == null) {
            value.server = args[i + 1];
        } else return error.InvalidArguments;
    }
    return value;
}
// Explicit old client modes stay direct; bare hub (and --port/--directory) now
// manages a Rex terminal. Never interpret an option's value as a flag.
pub fn managed(args: []const []const u8) bool {
    var i: usize = 0;
    while (i < args.len) : (i += 2) {
        for ([_][]const u8{ "--here", "--tui", "--no-tui", "--message", "--task", "--hub-id", "--login", "--help" }) |flag| if (std.mem.eql(u8, args[i], flag)) return false;
    }
    return true;
}
fn print(native: Native, allocator: std.mem.Allocator, binding: wire.RexCreation, reused: bool) !void {
    const text = try std.fmt.allocPrint(allocator, "Hub Rex session: {s}\n{s}\n", .{ binding.sessionId, if (reused) "Existing TUI process observed; no new terminal created." else "Hub TUI launched; session creation is not a responsiveness guarantee." });
    defer allocator.free(text);
    try std.Io.File.stdout().writeStreamingAll(native.io, text);
}
pub fn run(native: Native, allocator: std.mem.Allocator, args: []const []const u8) !void {
    const opts = try options(args);
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var cancelled = std.atomic.Value(bool).init(false);
    const cwd = try std.process.currentPathAlloc(native.io, a);
    const port = try std.fmt.allocPrint(a, "{d}", .{opts.port});
    const node = try @import("runtime_paths.zig").node(native, a);
    const entry = try @import("runtime_paths.zig").entry(native, a, null, "startup-status.js");
    const observed = try @import("shell.zig").runArgvCaptured(native, a, cwd, &.{ node, entry, port }, 12, &cancelled);
    if (!observed.result.ok or observed.stderr.len != 0) return error.LocalHubUnavailable;
    const status = (try std.json.parseFromSlice(Status, a, observed.stdout, .{})).value;
    if (!wire.validRexUuid(.{ .string = status.hubId }) or !wire.validPiId(.{ .string = status.chatId }) or !@import("mcp_profiles.zig").absolute(status.cwd)) return error.InvalidHubIdentity;
    if (opts.directory) |_| {
        const path = try @import("state.zig").directory(native, a, opts.directory);
        var dir = try std.Io.Dir.cwd().openDir(native.io, path, .{});
        defer dir.close(native.io);
        const config = try @import("state.zig").load(native.io, a, dir);
        if (!std.mem.eql(u8, config.value.machine_id, status.machineId)) return error.HubIdentityChanged;
    }
    const root = if (opts.directory == null and native.environ.getPosix("DECK_CLIENT_STATE_DIRECTORY") != null) native.environ.getPosix("DECK_CLIENT_STATE_DIRECTORY").? else try std.fs.path.join(a, &.{ try @import("state.zig").directory(native, a, opts.directory), "client" });
    var root_dir = try storage.directory(native, root);
    defer root_dir.close(native.io);
    const managed_root = try std.fs.path.join(a, &.{ root, "hubs" });
    var hubs_dir = try storage.directory(native, managed_root);
    defer hubs_dir.close(native.io);
    const path = try std.fs.path.join(a, &.{ managed_root, status.hubId });
    var dir = try storage.directory(native, path);
    defer dir.close(native.io);
    const held = try storage.lock(native, dir, "launcher.lock");
    defer held.close(native.io);
    const record_path = try std.fs.path.join(a, &.{ path, "session.json" });
    const bytes = @import("mcp_profiles.zig").readPrivate(native, a, record_path, 16 * 1024) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    var record: Record = if (bytes) |text| (try std.json.parseFromSlice(Record, a, text, .{})).value else blk: {
        const target = try std.json.Stringify.valueAlloc(a, wire.RexTargetOptions{ .executable = opts.executable, .server = opts.server }, .{});
        const resolved = try @import("rex_resolve.zig").resolve(native, a, status.cwd, target, &cancelled);
        if (!resolved.ok) return error.LocalRexUnavailable;
        break :blk .{ .hubId = status.hubId, .chatId = status.chatId, .port = opts.port, .target = (try wire.parseRexOpenTarget(a, resolved.output)).value };
    };
    if (record.version != 1 or !std.mem.eql(u8, record.hubId, status.hubId) or !std.mem.eql(u8, record.chatId, status.chatId) or record.port != opts.port) return error.HubIdentityChanged;
    if (!@import("mcp_profiles.zig").absolute(record.target.executable) or !@import("rex_endpoint.zig").valid(record.target.server)) return error.InvalidClientMetadata;
    if (opts.executable) |exe| if (!std.mem.eql(u8, exe, record.target.executable)) return error.HubIdentityChanged;
    if (opts.server) |server| if (!@import("rex_endpoint.zig").same(server, record.target.server)) return error.HubIdentityChanged;
    if (record.pending) return error.HubLaunchUnconfirmed;
    var session: ?[]const u8 = null;
    if (record.binding) |binding| {
        const encoded = try std.json.Stringify.valueAlloc(a, binding, .{});
        _ = try wire.parseRexCreation(a, encoded);
        if (!std.mem.eql(u8, binding.hubId, status.hubId) or !std.mem.eql(u8, binding.chatId, status.chatId) or !@import("rex_endpoint.zig").same(binding.server, record.target.server) or !std.mem.eql(u8, binding.hostId, record.target.hostId) or !std.mem.eql(u8, binding.instanceId, record.target.instanceId)) return error.InvalidClientMetadata;
        const query: wire.RexInspectionQuery = .{ .executable = record.target.executable, .scope = .{ .server = binding.server, .hostId = binding.hostId, .instanceId = binding.instanceId, .sessionId = binding.sessionId, .windowId = binding.windowId, .blockId = binding.blockId } };
        const result = try @import("rex_inspect.zig").inspect(native, a, status.cwd, try std.json.Stringify.valueAlloc(a, query, .{}), &cancelled);
        if (!result.ok) return error.HubLaunchUnconfirmed;
        const observation = (try wire.parseRexInspectionObservation(a, result.output)).value;
        switch (observation.state) {
            .running => return print(native, allocator, binding, true),
            .exited, .missing_terminal => session = binding.sessionId,
            .missing_session => {},
            else => return error.HubLaunchUnconfirmed,
        }
    }
    const exe = try std.process.executablePathAlloc(native.io, a);
    const client = if (std.mem.eql(u8, std.fs.path.basename(exe), ".deck-wrapped")) try std.fs.path.join(a, &.{ std.fs.path.dirname(exe).?, "deck" }) else exe;
    const plan: wire.RexAllocationPlan = .{ .executable = record.target.executable, .server = record.target.server, .hostId = record.target.hostId, .instanceId = record.target.instanceId, .client = client, .port = opts.port, .hubId = status.hubId, .chatId = status.chatId, .label = "deck-hub", .sessionId = session, .clientState = root };
    record.pending = true;
    try storage.save(native, a, dir, "session.json", record);
    const result = try @import("rex.zig").allocateHub(native, a, status.cwd, try std.json.Stringify.valueAlloc(a, plan, .{}), &cancelled);
    if (!result.ok) return error.HubLaunchUnconfirmed;
    record.binding = (try wire.parseRexCreation(a, result.output)).value;
    record.pending = false;
    try storage.save(native, a, dir, "session.json", record);
    try print(native, allocator, record.binding.?, false);
}

test "managed hub defaults never confuse option values with client modes" {
    try std.testing.expect(managed(&.{}));
    try std.testing.expect(managed(&.{ "--port", "52800" }));
    try std.testing.expect(managed(&.{ "--directory", "--here" }));
    try std.testing.expect(!managed(&.{ "--port", "52800", "--here" }));
    try std.testing.expect(!managed(&.{ "--message", "hello" }));
    try std.testing.expect(!managed(&.{"--tui"}));
}
