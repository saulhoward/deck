//! Worker-only startup: native effects and receipts, no Node/Pi/provider store.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const trust = @import("remote_contracts.zig");
const tailscale = @import("tailscale.zig");
const tcp = @import("remote_io.zig");
const state = @import("state.zig");
const a = tcp.a;
pub const capabilities = [_]wire.WorkerCapability{ .files, .bash };
const rex_capabilities = [_]wire.WorkerCapability{ .files, .bash, .rex };
const mcp_capabilities = [_]wire.WorkerCapability{ .files, .bash, .mcp };
const all_capabilities = [_]wire.WorkerCapability{ .files, .bash, .rex, .mcp };
const launcher_capabilities = [_]wire.WorkerCapability{ .files, .bash, .rex, .launcher };
const launcher_mcp_capabilities = [_]wire.WorkerCapability{ .files, .bash, .rex, .mcp, .launcher };
pub fn configuredCapabilities(client: ?wire.WorkerRexClient, mcp: bool, launcher: bool) []const wire.WorkerCapability {
    if (launcher and client != null) return if (mcp) &launcher_mcp_capabilities else &launcher_capabilities;
    return capabilitiesWithMcp(client, mcp);
}
pub fn capabilitiesWithMcp(client: ?wire.WorkerRexClient, mcp: bool) []const wire.WorkerCapability {
    return if (mcp) (if (client != null) &all_capabilities else &mcp_capabilities) else capabilitiesFor(client);
}
pub fn capabilitiesFor(client: ?wire.WorkerRexClient) []const wire.WorkerCapability {
    return if (client != null) &rex_capabilities else &capabilities;
}
var stopping = std.atomic.Value(bool).init(false);
fn stop(_: std.posix.SIG) callconv(.c) void {
    stopping.store(true, .release);
}
pub fn digest(native: Native) ![64]u8 {
    const path = try std.process.executablePathAlloc(native.io, a);
    defer a.free(path);
    const file = try std.Io.Dir.cwd().openFile(native.io, path, .{});
    defer file.close(native.io);
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    var buf: [65536]u8 = undefined;
    while (true) {
        const n = try std.posix.read(file.handle, &buf);
        if (n == 0) break;
        hash.update(buf[0..n]);
    }
    return std.fmt.bytesToHex(hash.finalResult(), .lower);
}
pub fn load(native: Native, path: []const u8) !std.json.Parsed(wire.RemoteWorkerConfig) {
    const fd = try std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NOFOLLOW = true, .NONBLOCK = true }, 0);
    const file: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = true } };
    defer file.close(native.io);
    const stat = try file.stat(native.io);
    if (stat.kind != .file or stat.size > 4096 or stat.permissions.toMode() & 0o077 != 0) return error.UnsafeWorkerConfig;
    const bytes = try Native.readAll(native.io, file, a, 4096);
    defer a.free(bytes);
    const raw = try wire.parseRemoteWorkerConfig(a, bytes);
    defer raw.deinit();
    const peer_value = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer peer_value.deinit();
    if (!trust.validPeer(peer_value.value.object.get("hubPeer").?)) return error.InvalidWorkerConfig;
    if (peer_value.value.object.get("rexClient")) |client| if (!trust.validRexClient(client)) return error.InvalidWorkerConfig;
    if (raw.value.mcp) |path_mcp| if (!@import("mcp_profiles.zig").absolute(path_mcp)) return error.InvalidWorkerConfig;
    if (raw.value.launcher) |enabled| if (!enabled or raw.value.rexClient == null) return error.InvalidWorkerConfig;
    _ = try tailscale.endpoint(raw.value.hubAddress);
    return std.json.parseFromSlice(wire.RemoteWorkerConfig, a, bytes, .{ .allocate = .alloc_always });
}
fn verified(native: Native, executable: []const u8, fd: tcp.fd_t, expected: wire.TailPeer, verify: @import("remote_link.zig").Verify, stop_flag: *std.atomic.Value(bool)) !void {
    const observed = try verify(native, a, executable, try tcp.peer(fd), stop_flag);
    defer observed.deinit();
    if (!trust.samePeer(observed.value, expected)) return error.PeerIdentityMismatch;
}
fn ack(io: std.Io, fd: tcp.fd_t, expected: wire.RemoteLinkHeader) !void {
    const bytes = try tcp.receive(io, fd);
    defer a.free(bytes);
    const parsed = try wire.parseRemoteLinkHeader(a, bytes);
    defer parsed.deinit();
    const value = parsed.value;
    if (value.channel != expected.channel or value.connectionId == null or !std.mem.eql(u8, value.connectionId.?, expected.connectionId.?) or !std.mem.eql(u8, value.machineId, expected.machineId) or !std.mem.eql(u8, value.hubId, expected.hubId)) return error.InvalidHandshake;
}
const Controller = struct {
    native: Native,
    data: tcp.fd_t,
    remote: tcp.fd_t,
    local: tcp.fd_t,
    done: std.atomic.Value(bool) = .init(false),
    stop_flag: *std.atomic.Value(bool),
    fn run(self: *@This()) void {
        defer Native.close(self.local);
        defer tcp.shutdown(self.data); // Wake idle/partial data reads and blocked writes.
        self.loop() catch {};
    }
    fn loop(self: *@This()) !void {
        var bytes: [8]u8 = undefined;
        var used: usize = 0;
        var last = tcp.now(self.native.io);
        try tcp.nonblock(self.local, true);
        while (!self.done.load(.acquire) and !self.stop_flag.load(.acquire)) {
            if (tcp.now(self.native.io) - last > 5000) return error.HeartbeatTimeout;
            var polls = [_]std.posix.pollfd{.{ .fd = self.remote, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&polls, 100) == 0) continue;
            const n = try std.posix.read(self.remote, bytes[used..]);
            if (n == 0) return;
            used += n;
            if (used == 8) {
                const id = std.mem.readInt(u64, &bytes, .big);
                if (id == 0) {
                    try tcp.writeUntil(self.native.io, self.remote, &bytes, tcp.now(self.native.io) + 5000);
                    last = tcp.now(self.native.io);
                } else {
                    if (!@import("native_contracts.zig").validCancellationId(id)) return error.InvalidCancellation;
                    const written = std.c.write(self.local, &bytes, 8);
                    if (written != 8) return error.ControlUnavailable;
                }
                used = 0;
            }
        }
    }
};
// Address/verifier injection is for isolated native tests; the CLI always uses
// strict direct Tailscale addresses and local-daemon verification on both sockets.
pub fn session(native: Native, config: wire.RemoteWorkerConfig, implementation: []const u8, executable: []const u8, journal: []const u8, address: std.Io.net.IpAddress, verify: @import("remote_link.zig").Verify, stop_flag: *std.atomic.Value(bool)) !void {
    var mcp = if (config.mcp) |path| try @import("mcp_profiles.zig").Profiles.load(native, path) else null;
    defer if (mcp) |*p| p.deinit();
    return sessionConfigured(native, config, implementation, executable, journal, address, verify, stop_flag, if (mcp) |*p| p else null);
}
fn sessionConfigured(native: Native, config: wire.RemoteWorkerConfig, implementation: []const u8, executable: []const u8, journal: []const u8, address: std.Io.net.IpAddress, verify: @import("remote_link.zig").Verify, stop_flag: *std.atomic.Value(bool), mcp: ?*const @import("mcp_profiles.zig").Profiles) !void {
    if (config.launcher) |enabled| if (!enabled or config.rexClient == null) return error.InvalidWorkerConfig;
    if (mcp) |p| if (!std.mem.eql(u8, p.config.machineId, config.machineId)) return error.McpHostMismatch;
    const data = try tcp.connect(address);
    defer Native.close(data);
    try verified(native, executable, data, config.hubPeer, verify, stop_flag);
    try tcp.send(native.io, data, wire.RemoteLinkHeader{ .version = 1, .channel = .data, .hubId = config.hubId, .machineId = config.machineId });
    const bytes = try tcp.receive(native.io, data);
    defer a.free(bytes);
    const challenge = try wire.parseRemoteWorkerHello(a, bytes);
    defer challenge.deinit();
    const hello = challenge.value;
    if (!std.mem.eql(u8, hello.hubId, config.hubId) or !std.mem.eql(u8, hello.machineId, config.machineId) or !std.mem.eql(u8, hello.implementation, implementation) or !std.mem.eql(wire.WorkerCapability, hello.capabilities, configuredCapabilities(config.rexClient, mcp != null, config.launcher orelse false)) or !trust.sameRexClient(hello.rexClient, config.rexClient)) return error.RegistrationMismatch;
    try tcp.send(native.io, data, hello);
    var header: wire.RemoteLinkHeader = .{ .version = 1, .channel = .data, .hubId = config.hubId, .machineId = config.machineId, .connectionId = hello.connectionId };
    try ack(native.io, data, header);
    const control = try tcp.connect(address);
    defer Native.close(control);
    try verified(native, executable, control, config.hubPeer, verify, stop_flag);
    header.channel = .control;
    try tcp.send(native.io, control, header);
    try ack(native.io, control, header);
    const clients = if (config.rexClient != null) try tcp.connect(address) else null;
    defer if (clients) |fd| Native.close(fd);
    if (clients) |fd| {
        try verified(native, executable, fd, config.hubPeer, verify, stop_flag);
        header.channel = .clients;
        try tcp.send(native.io, fd, header);
        try ack(native.io, fd, header);
    }
    var listener = if (config.rexClient) |client| try clientListener(native, client.socket) else null;
    var listener_owned = true;
    defer if (listener_owned) {
        if (listener) |*local| @import("task_relay.zig").closeLocal(native.io, &local.server, config.rexClient.?.socket, local.inode);
    };
    const pipe = try Native.pipe();
    var owned = true;
    defer if (owned) {
        Native.close(pipe[0]);
        Native.close(pipe[1]);
    };
    const input = try tcp.duplicate(data);
    var input_owned = true;
    defer if (input_owned) Native.close(input);
    const output = try tcp.duplicate(data);
    var output_owned = true;
    defer if (output_owned) Native.close(output);
    var controller: Controller = .{ .native = native, .data = data, .remote = control, .local = pipe[1], .stop_flag = stop_flag };
    const thread = try std.Thread.spawn(.{}, Controller.run, .{&controller});
    owned = false;
    var local_owned = true;
    defer if (local_owned) Native.close(pipe[0]);
    defer {
        controller.done.store(true, .release);
        thread.join();
    }
    const Relay = @import("task_relay.zig").Worker;
    var relay: Relay = undefined;
    var relay_thread: ?std.Thread = null;
    if (clients) |fd| {
        relay = .{ .native = native, .socket = fd, .listener = listener.?.server, .local_path = config.rexClient.?.socket, .local_inode = listener.?.inode, .generation = hello.connectionId, .launcher = config.launcher orelse false, .stopping = &controller.done, .data = data, .control = control };
        relay_thread = try std.Thread.spawn(.{}, Relay.serve, .{&relay});
        listener_owned = false;
    }
    defer {
        controller.done.store(true, .release);
        if (clients) |fd| tcp.shutdown(fd);
        if (relay_thread) |t| t.join();
    }
    input_owned = false;
    output_owned = false;
    local_owned = false;
    if (config.launcher orelse false) std.Io.File.stderr().writeStreamingAll(native.io, "deck: approved launcher relay enabled (list/create/open/inspect only)\n") catch {};
    std.Io.File.stderr().writeStreamingAll(native.io, if (mcp != null) (if (clients != null) "deck: worker connected (files/bash/MCP/Rex task relay; no Pi runtime)\n" else "deck: worker connected (files/bash/MCP; no Pi runtime)\n") else if (clients != null) "deck: worker connected (files/bash/Rex task relay; no Pi runtime)\n" else "deck: worker connected (files/bash only; no Pi runtime)\n") catch {};
    @import("worker.zig").serveRemoteMcp(native, input, output, pipe[0], journal, config.machineId, config.rexClient, mcp);
}
const LocalListener = struct { server: std.Io.net.Server, inode: std.Io.File.INode };
fn clientListener(native: Native, path: []const u8) !LocalListener {
    const parent = try std.Io.Dir.cwd().statFile(native.io, std.fs.path.dirname(path) orelse return error.UnsafeClientSocket, .{ .follow_symlinks = false });
    if (parent.kind != .directory or parent.permissions.toMode() & 0o077 != 0) return error.UnsafeClientSocket;
    const previous = std.Io.Dir.cwd().statFile(native.io, path, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    if (previous) |s| {
        if (s.kind != .unix_domain_socket) return error.UnsafeClientSocket;
        try std.Io.Dir.cwd().deleteFile(native.io, path);
    }
    var server = try (try std.Io.net.UnixAddress.init(path)).listen(native.io, .{ .kernel_backlog = 8 });
    var inode: ?std.Io.File.INode = null;
    errdefer if (inode) |n| @import("task_relay.zig").closeLocal(native.io, &server, path, n) else server.deinit(native.io);
    const observed = try std.Io.Dir.cwd().statFile(native.io, path, .{ .follow_symlinks = false });
    if (observed.kind != .unix_domain_socket) return error.UnsafeClientSocket;
    inode = observed.inode;
    _ = try Native.fcntl(server.socket.handle, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
    try std.Io.Dir.cwd().setFilePermissions(native.io, path, .fromMode(0o600), .{});
    return .{ .server = server, .inode = inode.? };
}
pub fn run(native: Native, args: []const []const u8) !void {
    if (args.len == 1 and std.mem.eql(u8, args[0], "--help")) {
        try std.Io.File.stdout().writeStreamingAll(native.io,
            \\deck-worker (also available as deck worker):
            \\  peer --tailscale ABSOLUTE_EXECUTABLE
            \\  init --directory NEW_ABSOLUTE_DIRECTORY --hub-id HUB_ID --hub-address TAILSCALE_IP:PORT --hub-node STABLE_NODE_ID --hub-user DECIMAL_USER_ID [--client /absolute/deck] [--mcp /private/profiles.json] [--launcher]
            \\  identity|run --directory ABSOLUTE_DIRECTORY --tailscale ABSOLUTE_EXECUTABLE
            \\Explicit peer/implementation approval is required. Default: files/bash only.
            \\--client opts into Rex (local Unix, API 8/10) and a private task relay socket.
            \\Approve its exact client path/socket and files,bash,rex capabilities on the hub.
            \\--mcp opts into native stdio MCP; approve files,bash,mcp (or files,bash,rex,mcp).
            \\--launcher requires --client; explicitly approve launcher as the final capability.
            \\Full-client entry: deck agent --launch-from ABS_WORKER_DIRECTORY (not a hub login).
            \\deck-worker mcp export --config /private/profiles.json
            \\deck-worker mcp probe --config /private/profiles.json --profile ID [--workspace ABS]
            \\No Pi store, inference, provider login, inbound TCP listener, or effect replay.
            \\
        );
        return;
    }
    if (args.len == 0) return error.InvalidArguments;
    var directory: ?[]const u8 = null;
    var executable: ?[]const u8 = null;
    var hub_id: ?[]const u8 = null;
    var hub_address: ?[]const u8 = null;
    var node: ?[]const u8 = null;
    var user: ?[]const u8 = null;
    var client: ?[]const u8 = null;
    var mcp_path: ?[]const u8 = null;
    var launcher = false;
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--launcher")) {
            if (launcher) return error.InvalidArguments;
            launcher = true;
            continue;
        }
        if (i + 1 == args.len or args[i + 1].len == 0) return error.InvalidArguments;
        const slot = if (std.mem.eql(u8, args[i], "--directory")) &directory else if (std.mem.eql(u8, args[i], "--tailscale")) &executable else if (std.mem.eql(u8, args[i], "--hub-id")) &hub_id else if (std.mem.eql(u8, args[i], "--hub-address")) &hub_address else if (std.mem.eql(u8, args[i], "--hub-node")) &node else if (std.mem.eql(u8, args[i], "--hub-user")) &user else if (std.mem.eql(u8, args[i], "--client")) &client else if (std.mem.eql(u8, args[i], "--mcp")) &mcp_path else return error.InvalidArguments;
        if (slot.* != null) return error.InvalidArguments;
        slot.* = args[i + 1];
        i += 1;
    }
    if (launcher and (!std.mem.eql(u8, args[0], "init") or client == null)) return error.InvalidArguments;
    if (std.mem.eql(u8, args[0], "peer")) {
        if (directory != null or hub_id != null or hub_address != null or node != null or user != null or client != null or mcp_path != null) return error.InvalidArguments;
        const identity = try tailscale.localPeer(native, a, executable orelse return error.InvalidArguments);
        defer identity.deinit();
        const bytes = try std.json.Stringify.valueAlloc(a, identity.value, .{});
        defer a.free(bytes);
        try std.Io.File.stdout().writeStreamingAll(native.io, bytes);
        try std.Io.File.stdout().writeStreamingAll(native.io, "\n");
        return;
    }
    const path = directory orelse return error.InvalidArguments;
    if (!std.fs.path.isAbsolute(path)) return error.InvalidArguments;
    const initializing = std.mem.eql(u8, args[0], "init");
    if (!initializing and !std.mem.eql(u8, args[0], "identity") and !std.mem.eql(u8, args[0], "run")) return error.InvalidArguments;
    const client_socket = try std.fs.path.join(a, &.{ path, "client.sock" });
    defer a.free(client_socket);
    var initial: ?[]u8 = null;
    defer if (initial) |bytes| a.free(bytes);
    if (initializing) {
        if (executable != null or hub_id == null or hub_address == null or node == null or user == null) return error.InvalidArguments;
        var random: [16]u8 = undefined;
        native.io.random(&random);
        const machine = std.fmt.bytesToHex(random, .lower);
        const config: wire.RemoteWorkerConfig = .{ .version = 1, .machineId = &machine, .hubId = hub_id.?, .hubAddress = hub_address.?, .hubPeer = .{ .nodeId = node.?, .userId = user.? }, .rexClient = if (client) |c| .{ .executable = c, .socket = client_socket } else null, .mcp = mcp_path, .launcher = if (launcher) true else null };
        if (mcp_path) |p| if (!@import("mcp_profiles.zig").absolute(p)) return error.InvalidArguments;
        if (client) |c| {
            try tailscale.validateExecutable(native, c);
            if (client_socket.len > 100 or std.mem.indexOfAny(u8, c, "\x00\r\n") != null) return error.InvalidArguments;
        }
        const bytes = try std.json.Stringify.valueAlloc(a, config, .{});
        initial = bytes;
        if (bytes.len > 4096) return error.InvalidWorkerConfig;
        const parsed = try wire.parseRemoteWorkerConfig(a, bytes);
        defer parsed.deinit();
        const peer_json = try std.json.Stringify.valueAlloc(a, config.hubPeer, .{});
        defer a.free(peer_json);
        const checked = try std.json.parseFromSlice(std.json.Value, a, peer_json, .{});
        defer checked.deinit();
        if (!trust.validPeer(checked.value)) return error.InvalidPeer;
        _ = try tailscale.endpoint(config.hubAddress);
        try std.Io.Dir.cwd().createDir(native.io, path, .fromMode(0o700));
    } else if (executable == null or hub_id != null or hub_address != null or node != null or user != null or client != null or mcp_path != null) return error.InvalidArguments;
    const stat = try std.Io.Dir.cwd().statFile(native.io, path, .{ .follow_symlinks = false });
    if (stat.kind != .directory or stat.permissions.toMode() & 0o077 != 0) return error.UnsafeWorkerDirectory;
    var dir = try std.Io.Dir.cwd().openDir(native.io, path, .{});
    defer dir.close(native.io);
    const held = try state.lock(native.io, dir);
    defer held.close(native.io);
    if (initial) |bytes| {
        const file = try dir.createFile(native.io, "worker.json.tmp", .{ .exclusive = true, .permissions = .fromMode(0o600) });
        defer file.close(native.io);
        try file.writeStreamingAll(native.io, bytes);
        try file.sync(native.io);
        try dir.rename("worker.json.tmp", dir, "worker.json", native.io);
        try std.Io.File.stdout().writeStreamingAll(native.io, "Worker initialized; not enrolled or connected. Review and approve its identity on the hub.\n");
        return;
    }
    const config_path = try std.fs.path.join(a, &.{ path, "worker.json" });
    defer a.free(config_path);
    const config = try load(native, config_path);
    defer config.deinit();
    if (config.value.rexClient) |c| {
        if (!std.mem.eql(u8, c.socket, client_socket)) return error.UnsafeClientSocket;
        try tailscale.validateExecutable(native, c.executable);
    }
    var mcp = if (config.value.mcp) |p| try @import("mcp_profiles.zig").Profiles.load(native, p) else null;
    defer if (mcp) |*p| p.deinit();
    if (mcp) |p| if (!std.mem.eql(u8, p.config.machineId, config.value.machineId)) return error.McpHostMismatch;
    const cli = executable orelse return error.InvalidArguments;
    try tailscale.validateExecutable(native, cli);
    const implementation = try digest(native);
    if (std.mem.eql(u8, args[0], "identity")) {
        const peer = try tailscale.localPeer(native, a, cli);
        defer peer.deinit();
        const output = try std.json.Stringify.valueAlloc(a, wire.RemoteHost{ .machineId = config.value.machineId, .peer = peer.value, .client = false, .implementation = &implementation, .capabilities = configuredCapabilities(config.value.rexClient, mcp != null, config.value.launcher orelse false), .rexClient = config.value.rexClient }, .{});
        defer a.free(output);
        try std.Io.File.stdout().writeStreamingAll(native.io, output);
        try std.Io.File.stdout().writeStreamingAll(native.io, "\n");
        return;
    }
    tcp.ignorePipe();
    stopping.store(false, .release);
    const signals = [_]std.posix.SIG{ .TERM, .INT, .HUP };
    var previous: [signals.len]std.posix.Sigaction = undefined;
    const action: std.posix.Sigaction = .{ .handler = .{ .handler = stop }, .mask = std.posix.sigemptyset(), .flags = 0 };
    for (signals, 0..) |sig, n| std.posix.sigaction(sig, &action, &previous[n]);
    defer for (signals, 0..) |sig, n| std.posix.sigaction(sig, &previous[n], null);
    const journal = try std.fs.path.join(a, &.{ path, "operations" });
    defer a.free(journal);
    try std.Io.Dir.cwd().createDirPath(native.io, journal);
    var delay: usize = 10;
    while (!stopping.load(.acquire)) {
        sessionConfigured(native, config.value, &implementation, cli, journal, try tailscale.endpoint(config.value.hubAddress), tailscale.verify, &stopping, if (mcp) |*p| p else null) catch {};
        if (stopping.load(.acquire)) break;
        try std.Io.File.stderr().writeStreamingAll(native.io, "deck: worker disconnected/unconfirmed; effects are not replayed; reconnecting with backoff\n");
        for (0..delay) |_| {
            if (stopping.load(.acquire)) break;
            try native.io.sleep(.fromMilliseconds(100), .awake);
        }
        delay = @min(delay * 2, 300);
    }
}
