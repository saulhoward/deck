//! Native endpoint selection and managed worker/terminal ownership. No Pi
//! runtime or credentials are started here; explicit remote selection never
//! falls back to a local hub. Names are resolved by the scoped client helper.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const storage = @import("private_store.zig");
const forward = @import("rex_forward.zig");
const Mode = enum { create, list, @"resume", drafts, discard, recover };
const Options = struct { hub: ?[]const u8 = null, local: bool = false, directory: ?[]const u8 = null, rex: ?[]const u8 = null, server: ?[]const u8 = null, port: u16 = 52800, mode: Mode = .create, value: ?[]const u8 = null, confirm: bool = false };
const Ready = struct { hubId: []const u8, machineId: []const u8 };
const help =
    \\deck agent [--hub REX_HOST | --local] [--directory STATE] [--port 52800]
    \\deck agent [same connection options] --list
    \\deck agent [same connection options] --resume NAME
    \\deck agent [same connection options] --drafts
    \\deck agent [same connection options] --discard REQUEST_ID --confirm
    \\deck agent [same connection options] --recover STARTUP_ID --confirm
    \\
    \\Selection: --hub, then DECK_HUB_REX_HOST, otherwise local; --local ignores env.
    \\Rex API 14 is required for automatic startup. --rex ABS / --server UNIX_URL
    \\override the local Rex executable/server. No install, endpoint or host fallback.
    \\Worker and task terminal stay on this machine. Workspace is the invoking cwd.
    \\New tasks open a form in Rex: required problem, optional description, then
    \\explicit Create & start. It becomes the task TUI in the same terminal.
    \\Detach never stops work. Uncertain input requires explicit :retry / :discard.
    \\--resume resolves a name on this worker, never creates a new task.
    \\Advanced direct/legacy clients retain --tui, --no-tui and --launch-from.
    \\
;
pub fn managed(args: []const []const u8) bool {
    if (args.len > 0 and std.mem.eql(u8, args[0], "--wizard")) return true;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        for ([_][]const u8{ "--tui", "--no-tui", "--message", "--task", "--hub-id", "--rex-allocation", "--worker-socket", "--agent-bootstrap", "--client-state", "--launch-from" }) |flag| if (std.mem.eql(u8, args[i], flag)) return false;
        if (std.mem.eql(u8, args[i], "--local") or std.mem.eql(u8, args[i], "--list") or std.mem.eql(u8, args[i], "--drafts") or std.mem.eql(u8, args[i], "--confirm") or std.mem.eql(u8, args[i], "--help")) continue;
        i += 1;
    }
    return true;
}
fn options(args: []const []const u8) !Options {
    var o: Options = .{};
    var seen_mode = false;
    var seen_port = false;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const key = args[i];
        if (std.mem.eql(u8, key, "--local") and !o.local) {
            o.local = true;
            continue;
        }
        if (std.mem.eql(u8, key, "--confirm") and !o.confirm) {
            o.confirm = true;
            continue;
        }
        if ((std.mem.eql(u8, key, "--list") or std.mem.eql(u8, key, "--drafts")) and !seen_mode) {
            o.mode = if (std.mem.eql(u8, key, "--list")) .list else .drafts;
            seen_mode = true;
            continue;
        }
        i += 1;
        if (i >= args.len) return error.InvalidArguments;
        const value = args[i];
        if (std.mem.eql(u8, key, "--hub") and o.hub == null) o.hub = value else if (std.mem.eql(u8, key, "--directory") and o.directory == null) o.directory = value else if (std.mem.eql(u8, key, "--rex") and o.rex == null) o.rex = value else if (std.mem.eql(u8, key, "--server") and o.server == null) o.server = value else if (std.mem.eql(u8, key, "--port") and !seen_port) {
            o.port = try std.fmt.parseInt(u16, value, 10);
            seen_port = true;
            if (o.port == 0) return error.InvalidArguments;
        } else if ((std.mem.eql(u8, key, "--resume") or std.mem.eql(u8, key, "--discard") or std.mem.eql(u8, key, "--recover")) and !seen_mode and value.len > 0 and value.len <= 200 and std.unicode.utf8ValidateSlice(value)) {
            o.mode = if (std.mem.eql(u8, key, "--resume")) .@"resume" else if (std.mem.eql(u8, key, "--recover")) .recover else .discard;
            o.value = value;
            seen_mode = true;
        } else return error.InvalidArguments;
    }
    if (o.hub != null and o.local or (o.mode == .discard or o.mode == .recover) != o.confirm) return error.InvalidArguments;
    if (o.value) |value| {
        if (o.mode == .@"resume") {
            if (!wire.validAgentName(.{ .string = value })) return error.InvalidArguments;
        } else if (!wire.validRexUuid(.{ .string = value })) return error.InvalidArguments;
    }
    if (o.rex) |value| if (!@import("mcp_profiles.zig").absolute(value)) return error.InvalidArguments;
    if (o.server) |value| if (!@import("rex_endpoint.zig").valid(value)) return error.InvalidArguments;
    return o;
}
fn selectedHub(o: Options, env: ?[]const u8) !?[]const u8 {
    if (o.local) return null;
    const value = o.hub orelse env orelse return null;
    if (!forward.remoteEndpoint(value) and !@import("rex_endpoint.zig").valid(value)) return error.InvalidHubEndpoint;
    return value;
}
fn localTarget(native: Native, a: std.mem.Allocator, cwd: []const u8, o: Options, cancelled: *std.atomic.Value(bool)) !wire.RexOpenTarget {
    const result = try @import("rex_resolve.zig").resolve(native, a, cwd, try std.json.Stringify.valueAlloc(a, wire.RexTargetOptions{ .executable = o.rex, .server = o.server }, .{}), cancelled);
    if (!result.ok) return error.LocalRexUnavailable;
    return (try wire.parseRexOpenTarget(a, result.output)).value;
}
fn control(native: Native, a: std.mem.Allocator, cwd: []const u8, kind: []const u8, selected: []const u8, root: []const u8, action: []const u8, value: ?[]const u8, cancelled: *std.atomic.Value(bool)) !@import("shell.zig").Captured {
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(a, &.{ try @import("runtime_paths.zig").node(native, a), try @import("runtime_paths.zig").entry(native, a, null, "agent-control-main.js"), kind, selected, action, root });
    if (value) |v| try argv.append(a, v);
    return @import("shell.zig").runArgvCaptured(native, a, cwd, argv.items, 15, cancelled);
}
fn ready(native: Native, a: std.mem.Allocator, cwd: []const u8, kind: []const u8, selected: []const u8, root: []const u8, cancelled: *std.atomic.Value(bool)) !Ready {
    const result = try control(native, a, cwd, kind, selected, root, "ready", null, cancelled);
    if (!result.result.ok or result.stderr.len != 0) return error.SelectedHubUnavailable;
    const value = (try std.json.parseFromSlice(Ready, a, result.stdout, .{})).value;
    if (!wire.validRexUuid(.{ .string = value.hubId }) or !wire.validMachineIdentity(.{ .string = value.machineId })) return error.InvalidHubIdentity;
    return value;
}
fn connection(native: Native, a: std.mem.Allocator, directory: []const u8) !wire.RexWorkerConnection {
    const bytes = try @import("mcp_profiles.zig").readPrivate(native, a, try std.fs.path.join(a, &.{ directory, "rex-connection.json" }), 16384);
    return (try wire.parseRexWorkerConnection(a, bytes)).value;
}
fn pinned(c: wire.RexWorkerConnection, identity: forward.Identity, port: u16, client: []const u8, implementation: []const u8) bool {
    return std.mem.eql(u8, c.hostId, identity.host_id) and std.mem.eql(u8, c.account, identity.account) and c.hubPort == port and std.mem.eql(u8, c.rexClient.executable, client) and std.mem.eql(u8, c.implementation, implementation);
}
fn workerDirectory(native: Native, a: std.mem.Allocator, root: []const u8, hub: []const u8, executable: []const u8, identity: forward.Identity, port: u16, client: []const u8, cwd: []const u8, cancelled: *std.atomic.Value(bool)) ![]const u8 {
    const parent_path = try std.fs.path.join(a, &.{ root, "workers" });
    var parent = try storage.directory(native, parent_path);
    defer parent.close(native.io);
    const encoded = try std.json.Stringify.valueAlloc(a, .{ identity.host_id, identity.account, port }, .{});
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(encoded, &digest, .{});
    const key = std.fmt.bytesToHex(digest, .lower);
    const held = try storage.lock(native, parent, try std.fmt.allocPrint(a, "{s}.lock", .{key}));
    defer held.close(native.io);
    const path = try std.fs.path.join(a, &.{ parent_path, &key });
    var dir = try storage.directory(native, path);
    defer dir.close(native.io);
    const implementation = try @import("remote_worker.zig").digest(native);
    const prior = connection(native, a, path) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    if (prior) |c| if (!pinned(c, identity, port, client, &implementation) or c.pendingSession) return error.WorkerConflict;
    const writer = storage.lock(native, dir, "writer.lock") catch |err| switch (err) {
        error.ClientAlreadyStarting => null,
        else => return err,
    };
    if (writer) |file| {
        file.close(native.io); // Child takes actual exclusion; parent never owns its runtime.
        var env: std.process.Environ.Map = .init(a);
        for ([_][]const u8{ "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "REX_RUNTIME_DIR", "DECK_NODE", "DECK_RUNTIME_ROOT" }) |name| if (native.environ.getPosix(name)) |v| try env.put(name, v);
        // No inherited terminal/stdin lifetime or provider/vault credentials.
        // Do not set a process group here: the child performs setsid itself.
        var child = try std.process.spawn(native.io, .{ .argv = &.{ client, "worker", "rex", "--detach", "--directory", path, "--hub", hub, "--rex", executable, "--client", client, "--port", try std.fmt.allocPrint(a, "{d}", .{port}) }, .environ_map = &env, .stdin = .ignore, .stdout = .ignore, .stderr = .ignore });
        Native.closeStreams(native.io, &child);
        // Deliberately not killed on timeout/detach: this worker may already
        // own issued effects. Readiness is proven by exclusion plus scoped RPC.
    }
    const start = std.Io.Timestamp.now(native.io, .awake);
    while (start.durationTo(std.Io.Timestamp.now(native.io, .awake)).toMilliseconds() < 30000) {
        const c = connection(native, a, path) catch |err| switch (err) {
            error.FileNotFound => {
                try native.io.sleep(.fromMilliseconds(100), .awake);
                continue;
            },
            else => return err,
        };
        if (!pinned(c, identity, port, client, &implementation)) return error.WorkerConflict;
        const probe = storage.lock(native, dir, "writer.lock") catch |err| switch (err) {
            error.ClientAlreadyStarting => null,
            else => return err,
        };
        if (probe) |file| {
            file.close(native.io);
            return error.WorkerUnavailable;
        }
        if (c.hubId != null and !c.pendingSession) {
            _ = ready(native, a, cwd, "worker", path, root, cancelled) catch {
                try native.io.sleep(.fromMilliseconds(100), .awake);
                continue;
            };
            return path;
        }
        try native.io.sleep(.fromMilliseconds(100), .awake);
    }
    return error.WorkerUnavailable;
}
fn uuid(native: Native, a: std.mem.Allocator) ![]const u8 {
    var bytes: [16]u8 = undefined;
    native.io.random(&bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = std.fmt.bytesToHex(bytes, .lower);
    return std.fmt.allocPrint(a, "{s}-{s}-{s}-{s}-{s}", .{ hex[0..8], hex[8..12], hex[12..16], hex[16..20], hex[20..32] });
}
fn wizard(init: std.process.Init, a: std.mem.Allocator, root: []const u8, id: []const u8) !void {
    const native: Native = .{ .io = init.io, .environ = init.minimal.environ };
    var record: wire.RexBootstrapRecord = undefined;
    for (0..200) |_| {
        record = try @import("rex_bootstrap.zig").load(native, a, root, id);
        if (record.binding != null) break;
        try native.io.sleep(.fromMilliseconds(50), .awake);
    }
    const binding = record.binding orelse return error.BootstrapLaunchUnconfirmed;
    if (binding.pid != std.c.getpid() or !std.mem.eql(u8, binding.blockId, native.environ.getPosix("REX_BLOCK") orelse return error.InvalidBootstrap) or record.claim != null) return error.InvalidBootstrap;
    const scope = (try @import("agent_form.zig").run(init, record, a)) orelse return;
    record = try @import("rex_bootstrap.zig").load(native, a, root, id);
    const claim = record.claim orelse return error.InvalidBootstrap;
    if (!std.mem.eql(u8, claim.chatId, scope.chatId) or !std.mem.eql(u8, claim.allocationId, scope.allocationId)) return error.InvalidBootstrap;
    var args: std.ArrayList([]const u8) = .empty;
    try args.appendSlice(a, &.{ "--tui", "--port", try std.fmt.allocPrint(a, "{d}", .{record.port}), "--hub-id", record.hubId, "--task", scope.chatId, "--rex-allocation", scope.allocationId, "--agent-bootstrap", id, "--client-state", root });
    if (record.workerSocket) |socket| try args.appendSlice(a, &.{ "--worker-socket", socket });
    try @import("tui.zig").run(init, args.items); // Same process, session and block.
}
pub fn run(init: std.process.Init, args: []const []const u8) !void {
    const native: Native = .{ .io = init.io, .environ = init.minimal.environ };
    var arena = std.heap.ArenaAllocator.init(init.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    if (args.len == 1 and std.mem.eql(u8, args[0], "--help")) return std.Io.File.stdout().writeStreamingAll(native.io, help);
    if (args.len == 4 and std.mem.eql(u8, args[0], "--wizard") and std.mem.eql(u8, args[2], "--client-state")) return wizard(init, a, args[3], args[1]);
    const o = try options(args);
    const selected = try selectedHub(o, native.environ.getPosix("DECK_HUB_REX_HOST"));
    const cwd = try std.process.currentPathAlloc(native.io, a);
    const root = if (o.directory == null and native.environ.getPosix("DECK_CLIENT_STATE_DIRECTORY") != null) native.environ.getPosix("DECK_CLIENT_STATE_DIRECTORY").? else try std.fs.path.join(a, &.{ try @import("state.zig").directory(native, a, o.directory), "client" });
    var root_dir = try storage.directory(native, root);
    defer root_dir.close(native.io);
    const port = try std.fmt.allocPrint(a, "{d}", .{o.port});
    const client = try @import("rex.zig").clientPath(native, a);
    var cancelled = std.atomic.Value(bool).init(false);
    var target: ?wire.RexOpenTarget = null;
    var worker_path: ?[]const u8 = null;
    if (selected) |hub| {
        const executable = o.rex orelse try @import("rex_resolve.zig").findRex(native, a);
        const remote = try forward.identity(native, a, executable, hub, &cancelled);
        target = localTarget(native, a, cwd, o, &cancelled) catch null;
        var same_host = false;
        if (target) |local| {
            const observed = try forward.identity(native, a, local.executable, local.server, &cancelled);
            same_host = std.mem.eql(u8, remote.value.host_id, observed.value.host_id) and std.mem.eql(u8, remote.value.account, observed.value.account);
        }
        if (!same_host) worker_path = try workerDirectory(native, a, root, hub, executable, remote.value, o.port, client, cwd, &cancelled);
    }
    const kind: []const u8 = if (worker_path != null) "worker" else "local";
    const endpoint = worker_path orelse port;
    const connected = try ready(native, a, cwd, kind, endpoint, root, &cancelled);
    const starts_path = try std.fs.path.join(a, &.{ root, "startups" });
    var starts = try storage.directory(native, starts_path);
    defer starts.close(native.io);
    const scope_bytes = try std.json.Stringify.valueAlloc(a, connected, .{});
    var scope_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(scope_bytes, &scope_hash, .{});
    const scope_key = std.fmt.bytesToHex(scope_hash, .lower);
    const launch_lock = try storage.lock(native, starts, try std.fmt.allocPrint(a, "{s}.lock", .{scope_key}));
    defer launch_lock.close(native.io);
    const pending_name = try std.fmt.allocPrint(a, "{s}.pending.json", .{scope_key});
    const pending_bytes = @import("mcp_profiles.zig").readPrivate(native, a, try std.fs.path.join(a, &.{ starts_path, pending_name }), 4096) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    if (pending_bytes) |bytes| {
        const pending = (try wire.parseRexBootstrapIndex(a, bytes)).value;
        if (!std.mem.eql(u8, pending.hubId, connected.hubId) or !std.mem.eql(u8, pending.machineId, connected.machineId)) return error.InvalidBootstrap;
        if (o.mode == .create) return error.BootstrapLaunchUnconfirmed;
        if (o.mode == .drafts) try std.Io.File.stdout().writeStreamingAll(native.io, try std.fmt.allocPrint(a, "{s} bootstrap-launch-unconfirmed; inspect Rex before --discard {s} --confirm\n", .{ pending.id, pending.id }));
        if (o.mode == .discard and std.mem.eql(u8, o.value.?, pending.id)) {
            var boot_dir = try storage.directory(native, try @import("rex_bootstrap.zig").path(native, a, root, pending.id));
            defer boot_dir.close(native.io);
            try storage.save(native, a, boot_dir, "discarded.json", .{ .version = @as(u8, 1) });
            // Completion/recovery may already have removed the index while a
            // crashed launcher left its fence. Clear only this startup's exact
            // input draft, never cancel work or infer that Rex did not create.
            const discarded = try control(native, a, cwd, kind, endpoint, root, "discard-startup", pending.id, &cancelled);
            if (!discarded.result.ok) return error.AgentActionUnconfirmed;
            try starts.deleteFile(native.io, pending_name);
            try (std.Io.File{ .handle = starts.handle, .flags = .{ .nonblocking = false } }).sync(native.io);
            return std.Io.File.stdout().writeStreamingAll(native.io, "Unconfirmed startup intent discarded explicitly. Its possible Rex session was not stopped/deleted; inspect it separately.\n");
        }
    }
    if (o.mode != .create) {
        const result = try control(native, a, cwd, kind, endpoint, root, @tagName(o.mode), o.value, &cancelled);
        try std.Io.File.stdout().writeStreamingAll(native.io, result.stdout);
        try std.Io.File.stderr().writeStreamingAll(native.io, result.stderr);
        if (!result.result.ok) return error.AgentActionUnconfirmed;
        return;
    }
    if (target == null) target = try localTarget(native, a, cwd, o, &cancelled);
    _ = try forward.identity(native, a, target.?.executable, target.?.server, &cancelled);
    const socket = if (worker_path) |path| (try connection(native, a, path)).rexClient.socket else null;
    const record: wire.RexBootstrapRecord = .{ .version = 1, .id = try uuid(native, a), .hubId = connected.hubId, .machineId = connected.machineId, .cwd = cwd, .client = client, .draftRoot = root, .port = o.port, .workerSocket = socket, .target = target.? };
    const prepared = try control(native, a, cwd, kind, endpoint, root, "prepare", null, &cancelled);
    if (!prepared.result.ok) {
        try std.Io.File.stderr().writeStreamingAll(native.io, prepared.stderr);
        return error.AgentActionUnconfirmed;
    }
    const index: wire.RexBootstrapIndex = .{ .version = 1, .id = record.id, .hubId = record.hubId, .machineId = record.machineId };
    try storage.save(native, a, starts, try std.fmt.allocPrint(a, "{s}.json", .{record.id}), index);
    try storage.save(native, a, starts, pending_name, index);
    const launched = try @import("rex_bootstrap.zig").launch(native, a, record, &cancelled);
    try starts.deleteFile(native.io, pending_name);
    try (std.Io.File{ .handle = starts.handle, .flags = .{ .nonblocking = false } }).sync(native.io);
    try std.Io.File.stdout().writeStreamingAll(native.io, try std.fmt.allocPrint(a, "Task creation Rex session: {s}\nReview Problem, optional Description and workspace; choose Create & start.\n", .{launched.sessionId}));
}

test "agent selection honors explicit/env/local and never treats URL spellings as host identity" {
    try std.testing.expectEqualStrings("https://explicit.example", (try selectedHub(try options(&.{ "--hub", "https://explicit.example" }), "https://env.example")).?);
    try std.testing.expectEqualStrings("https://env.example", (try selectedHub(try options(&.{}), "https://env.example")).?);
    try std.testing.expect((try selectedHub(try options(&.{"--local"}), "bad endpoint")) == null);
    try std.testing.expect((try selectedHub(try options(&.{}), null)) == null);
    try std.testing.expectError(error.InvalidHubEndpoint, selectedHub(try options(&.{}), ""));
    try std.testing.expectError(error.InvalidArguments, options(&.{ "--local", "--hub", "https://host.example" }));
    try std.testing.expectError(error.InvalidArguments, options(&.{ "--discard", "id" }));
    try std.testing.expectError(error.InvalidArguments, options(&.{ "--discard", "id", "--confirm" }));
    try std.testing.expectError(error.InvalidArguments, options(&.{ "--resume", "unsafe\nname" }));
    try std.testing.expect(managed(&.{}));
    try std.testing.expect(managed(&.{ "--hub", "--no-tui" }));
    try std.testing.expect(!managed(&.{ "--port", "52800", "--no-tui" }));
}
