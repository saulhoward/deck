//! Native Rex-connected worker daemon. No Node/Pi, model credentials, scheduler,
//! transcript copy or effect replay. The invoking account consents to this hub
//! using its native tools by starting this connection.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const forward = @import("rex_forward.zig");
const storage = @import("private_store.zig");
const tcp = @import("remote_io.zig");
const state = @import("state.zig");
const worker = @import("remote_worker.zig");
var stopping = std.atomic.Value(bool).init(false);
fn stop(_: std.posix.SIG) callconv(.c) void {
    stopping.store(true, .release);
}
const Options = struct { directory: []const u8, server: []const u8, client: []const u8, executable: ?[]const u8 = null, port: u16 = 52800, detached: bool = false };
fn options(args: []const []const u8) !Options {
    var dir: ?[]const u8 = null;
    var server: ?[]const u8 = null;
    var client: ?[]const u8 = null;
    var executable: ?[]const u8 = null;
    var port: u16 = 52800;
    var seen_port = false;
    var detached = false;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--detach") and !detached) {
            detached = true;
            continue;
        }
        if (i + 1 >= args.len) return error.InvalidArguments;
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--directory") and dir == null) {
            dir = args[i + 1];
        } else if (std.mem.eql(u8, arg, "--hub") and server == null) {
            server = args[i + 1];
        } else if (std.mem.eql(u8, arg, "--client") and client == null) {
            client = args[i + 1];
        } else if (std.mem.eql(u8, arg, "--rex") and executable == null) {
            executable = args[i + 1];
        } else if (std.mem.eql(u8, arg, "--port") and !seen_port) {
            port = try std.fmt.parseInt(u16, args[i + 1], 10);
            seen_port = true;
            if (port == 0) return error.InvalidArguments;
        } else return error.InvalidArguments;
        i += 1;
    }
    if (dir == null or server == null or client == null or !@import("mcp_profiles.zig").absolute(dir.?) or !@import("mcp_profiles.zig").absolute(client.?)) return error.InvalidArguments;
    return .{ .directory = dir.?, .server = server.?, .client = client.?, .executable = executable, .port = port, .detached = detached };
}
fn cli(native: Native, a: std.mem.Allocator, cwd: []const u8, connection: wire.RexWorkerConnection, suffix: []const []const u8) !@import("shell.zig").Captured {
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(a, &.{ connection.executable, "--autostart=false", "--timeout", "2s", "--server", connection.server });
    try argv.appendSlice(a, suffix);
    return @import("shell.zig").runArgvCaptured(native, a, cwd, argv.items, 4, &stopping);
}
fn session(native: Native, a: std.mem.Allocator, dir: std.Io.Dir, cwd: []const u8, connection: *wire.RexWorkerConnection) ![]const u8 {
    if (connection.pendingSession) return error.RexSessionUnconfirmed;
    if (connection.sessionId) |id| {
        // API call avoids CLI label lookup; only a definitive missing full ID
        // permits another owned session. Transport/auth errors never do.
        const request = try std.json.Stringify.valueAlloc(a, .{ .session_id = id }, .{});
        const inspected = try cli(native, a, cwd, connection.*, &.{ "api", "call", "session.view", request });
        if (inspected.result.ok and inspected.stderr.len == 0) {
            const observed = (try std.json.parseFromSlice(struct { session_id: []const u8 }, a, inspected.stdout, .{ .ignore_unknown_fields = true })).value;
            if (!std.mem.eql(u8, observed.session_id, id)) return error.RexSessionUnconfirmed;
            return id;
        }
        const absent = try std.fmt.allocPrint(a, "Error: stream response \"control-1\" failed: session {s} not found (status=404 code=session_not_found)\n", .{id});
        if (inspected.stdout.len != 0 or !std.mem.eql(u8, inspected.stderr, absent)) return error.RexSessionUnavailable;
    }
    connection.pendingSession = true;
    try storage.save(native, a, dir, "rex-connection.json", connection.*);
    const created = try cli(native, a, cwd, connection.*, &.{ "api", "call", "session.create", "{\"label\":\"deck-worker-transport\"}" });
    if (!created.result.ok or created.stderr.len != 0) return error.RexSessionUnconfirmed;
    const value = (try std.json.parseFromSlice(struct { session_id: []const u8 }, a, created.stdout, .{ .ignore_unknown_fields = true })).value;
    if (!wire.validRexSessionId(.{ .string = value.session_id })) return error.RexSessionUnconfirmed;
    connection.sessionId = value.session_id;
    connection.pendingSession = false;
    try storage.save(native, a, dir, "rex-connection.json", connection.*);
    return value.session_id;
}
fn load(native: Native, a: std.mem.Allocator, path: []const u8) !wire.RexWorkerConnection {
    const bytes = try @import("mcp_profiles.zig").readPrivate(native, a, path, 16 * 1024);
    const raw = (try std.json.parseFromSlice(std.json.Value, a, bytes, .{})).value;
    if (!wire.validRexWorkerConnection(raw) or !@import("remote_contracts.zig").validRexClient(raw.object.get("rexClient").?)) return error.InvalidWorkerConfig;
    return (try wire.parseRexWorkerConnection(a, bytes)).value;
}
pub fn run(native: Native, args: []const []const u8) !void {
    const opts = try options(args);
    if (opts.detached and std.c.setsid() < 0) return error.WorkerDetachFailed;
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const executable = opts.executable orelse try @import("rex_resolve.zig").findRex(native, a);
    const identity = try forward.identity(native, a, executable, opts.server, &stopping);
    const cwd = try std.process.currentPathAlloc(native.io, a);
    try state.initialize(native.io, a, opts.directory);
    var dir = try storage.directory(native, opts.directory);
    defer dir.close(native.io);
    const held = try state.lock(native.io, dir);
    defer held.close(native.io);
    const config = (try state.load(native.io, a, dir)).value;
    const socket_root = try std.fmt.allocPrint(a, "/tmp/deck-rex-{d}-{s}", .{ std.c.geteuid(), config.machine_id });
    var socket_dir = try storage.directory(native, socket_root);
    defer socket_dir.close(native.io);
    const client: wire.WorkerRexClient = .{ .executable = opts.client, .socket = try std.fs.path.join(a, &.{ socket_root, "client.sock" }) };
    const path = try std.fs.path.join(a, &.{ opts.directory, "rex-connection.json" });
    const prior = load(native, a, path) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    const implementation = try worker.digest(native);
    var connection: wire.RexWorkerConnection = prior orelse .{ .pid = std.c.getpid(), .implementation = &implementation, .version = 1, .server = opts.server, .hostId = identity.value.host_id, .account = identity.value.account, .executable = executable, .hubPort = opts.port, .pendingSession = false, .rexClient = client };
    if (!std.mem.eql(u8, connection.implementation, &implementation) or !std.mem.eql(u8, connection.hostId, identity.value.host_id) or !std.mem.eql(u8, connection.account, identity.value.account) or connection.hubPort != opts.port or !@import("remote_contracts.zig").sameRexClient(connection.rexClient, client)) return error.WorkerIdentityChanged;
    if (connection.pendingSession) return error.RexSessionUnconfirmed;
    // URL aliases may change spelling only after authenticated host/account
    // equality. They never change the pinned hub or worker identity.
    connection.pid = std.c.getpid(); // Diagnostic only; reuse requires writer exclusion and scoped RPC.
    connection.server = opts.server;
    connection.executable = executable;
    try storage.save(native, a, dir, "rex-connection.json", connection);
    const journal = try std.fs.path.join(a, &.{ opts.directory, "operations" });
    try std.Io.Dir.cwd().createDirPath(native.io, journal);
    const action: std.posix.Sigaction = .{ .handler = .{ .handler = stop }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(.TERM, &action, null);
    std.posix.sigaction(.INT, &action, null);
    tcp.ignorePipe();
    while (!stopping.load(.acquire)) {
        var attempt = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer attempt.deinit();
        const alloc = attempt.allocator();
        var current = try load(native, alloc, path);
        connected(native, alloc, dir, cwd, &current, config.machine_id, &implementation, journal) catch |err| {
            switch (err) {
                error.RexSessionUnconfirmed, error.RexIdentityChanged, error.WorkerIdentityChanged, error.RexForwardRequiresApi14 => return err,
                else => if (!stopping.load(.acquire)) std.Io.File.stderr().writeStreamingAll(native.io, "deck: Rex worker disconnected/unavailable; no issued effect replayed\n") catch {},
            }
        };
        if (!stopping.load(.acquire)) try native.io.sleep(.fromMilliseconds(500), .awake);
    }
}
fn connected(native: Native, a: std.mem.Allocator, dir: std.Io.Dir, cwd: []const u8, connection: *wire.RexWorkerConnection, machine: []const u8, implementation: []const u8, journal: []const u8) !void {
    const observed = try forward.identity(native, a, connection.executable, connection.server, &stopping);
    if (!std.mem.eql(u8, observed.value.host_id, connection.hostId) or !std.mem.eql(u8, observed.value.account, connection.account)) return error.RexIdentityChanged;
    const sid = try session(native, a, dir, cwd, connection);
    var registration_tunnel = try forward.Tunnel.open(native, a, connection.executable, connection.server, sid, @import("rex_enrollment.zig").enrollmentPort(@intCast(connection.hubPort)), &stopping);
    defer registration_tunnel.close();
    const fd = try tcp.connect(try std.Io.net.IpAddress.parse("127.0.0.1", registration_tunnel.port));
    defer Native.close(fd);
    const registration: wire.RexWorkerRegistration = .{ .version = 1, .hubId = connection.hubId, .machineId = machine, .implementation = implementation, .capabilities = worker.configuredCapabilities(connection.rexClient, false, true), .rexClient = connection.rexClient };
    try tcp.send(native.io, fd, registration);
    const reply = try tcp.receive(native.io, fd);
    defer tcp.a.free(reply);
    const ack = (try wire.parseRexEnrollmentAck(a, reply)).value;
    if (!std.mem.eql(u8, ack.machineId, machine)) return error.WorkerIdentityChanged;
    if (connection.hubId) |id| if (!std.mem.eql(u8, id, ack.hubId)) return error.WorkerIdentityChanged;
    connection.hubId = ack.hubId;
    try storage.save(native, a, dir, "rex-connection.json", connection.*);
    var effects_tunnel = try forward.Tunnel.open(native, a, connection.executable, connection.server, sid, @intCast(ack.port), &stopping);
    defer effects_tunnel.close();
    try worker.sessionRex(native, .{ .hubId = ack.hubId, .machineId = machine, .rexClient = connection.rexClient, .launcher = true }, implementation, journal, &effects_tunnel, &stopping, null);
}
