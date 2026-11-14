//! Rex API 14 TCP transport. Rex, not Deck, authenticates remote access. Never
//! forward a public bind, autostart a server, select a default session, or replay
//! a broken TCP stream. The caller supplies an explicitly owned tunnel session.
const std = @import("std");
const Native = @import("native.zig");
const tcp = @import("remote_io.zig");
const wire = @import("generated/contracts.zig");

pub fn remoteEndpoint(value: []const u8) bool {
    // The normal workflow accepts a host URL, not an arbitrary Rex alias,
    // credential-bearing URL, path, query, shell fragment or plain HTTP server.
    if (value.len <= 8 or value.len > 4096 or !std.mem.startsWith(u8, value, "https://")) return false;
    const host = value[8 .. value.len - @intFromBool(std.mem.endsWith(u8, value, "/"))];
    if (host.len == 0 or host.len > 253 or std.mem.indexOfAny(u8, host, "/@?#%\\\x00\r\n\t ") != null) return false;
    var name = host;
    if (std.mem.indexOfScalar(u8, host, ':')) |at| {
        name = host[0..at];
        for (host[at + 1 ..]) |c| if (!std.ascii.isDigit(c)) return false;
        const port = std.fmt.parseInt(u16, host[at + 1 ..], 10) catch return false;
        if (port == 0) return false;
    }
    if (name.len == 0) return false;
    var labels = std.mem.splitScalar(u8, name, '.');
    while (labels.next()) |label| {
        if (label.len == 0 or label.len > 63 or label[0] == '-' or label[label.len - 1] == '-') return false;
        for (label) |c| if (!std.ascii.isAlphanumeric(c) and c != '-') return false;
    }
    return true;
}
fn endpoint(value: []const u8) bool {
    return remoteEndpoint(value) or @import("rex_endpoint.zig").valid(value);
}
pub const Identity = struct { host_id: []const u8, instance_id: []const u8, account: []const u8, api_revision: u32 };
pub fn identity(native: Native, allocator: std.mem.Allocator, executable: []const u8, server: []const u8, cancelled: *std.atomic.Value(bool)) !std.json.Parsed(Identity) {
    if (!@import("mcp_profiles.zig").absolute(executable) or !endpoint(server)) return error.InvalidRexForward;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const cwd = try std.process.currentPathAlloc(native.io, arena.allocator());
    const result = try @import("shell.zig").runArgvCaptured(native, arena.allocator(), cwd, &.{ executable, "--autostart=false", "--timeout", "2s", "--server", server, "whoami", "--json" }, 4, cancelled);
    if (!result.result.ok or result.stderr.len != 0 or cancelled.load(.acquire)) return error.RexUnavailable;
    const parsed = try std.json.parseFromSlice(Identity, allocator, result.stdout, .{ .allocate = .alloc_always, .ignore_unknown_fields = true });
    errdefer parsed.deinit();
    if (!wire.validRexUuid(.{ .string = parsed.value.host_id }) or !wire.validRexUuid(.{ .string = parsed.value.instance_id }) or parsed.value.account.len == 0 or parsed.value.account.len > 200 or std.mem.indexOfAny(u8, parsed.value.account, "\x00\r\n") != null) return error.InvalidRexIdentity;
    // Explicit revision, not a minimum. Older/newer contracts must be tested.
    if (parsed.value.api_revision != 14) return error.RexForwardRequiresApi14;
    return parsed;
}
fn forwardedPort(line: []const u8) !u16 {
    // API 14 prints localhost even when explicitly bound to 127.0.0.1.
    // Only take the numeric port; callers always connect to literal IPv4 loopback.
    const prefix: []const u8 = if (std.mem.startsWith(u8, line, "tcp://localhost:")) "tcp://localhost:" else "tcp://127.0.0.1:";
    if (!std.mem.startsWith(u8, line, prefix) or line.len > prefix.len + 6 or line.len <= prefix.len + 1 or line[line.len - 1] != '\n') return error.InvalidRexForward;
    const digits = line[prefix.len .. line.len - 1];
    for (digits) |c| if (!std.ascii.isDigit(c)) return error.InvalidRexForward;
    const port = std.fmt.parseInt(u16, digits, 10) catch return error.InvalidRexForward;
    return if (port > 0) port else error.InvalidRexForward;
}
pub const Tunnel = struct {
    native: Native,
    child: std.process.Child,
    port: u16,
    pub fn open(native: Native, allocator: std.mem.Allocator, executable: []const u8, server: []const u8, session: []const u8, target: u16, cancelled: *std.atomic.Value(bool)) !Tunnel {
        if (target == 0 or !wire.validRexSessionId(.{ .string = session })) return error.InvalidRexForward;
        const before = try identity(native, allocator, executable, server, cancelled);
        defer before.deinit();
        const destination = try std.fmt.allocPrint(allocator, "tcp://127.0.0.1:{d}", .{target});
        defer allocator.free(destination);
        var environment = try native.environ.createMap(allocator);
        defer environment.deinit();
        var clean = std.process.Environ.Map.init(allocator);
        defer clean.deinit();
        for ([_][]const u8{ "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "REX_RUNTIME_DIR" }) |key| if (environment.get(key)) |value| try clean.put(key, value);
        var self: Tunnel = .{ .native = native, .port = 0, .child = try std.process.spawn(native.io, .{
            .environ_map = &clean,
            .argv = &.{ executable, "--autostart=false", "--timeout", "2s", "--server", server, "forward", "open", "--session", session, "--bind", "127.0.0.1", "--port", "0", "--no-open", destination },
            .stdin = .ignore,
            .stdout = .pipe,
            .stderr = .ignore,
            .pgid = 0,
        }) };
        errdefer self.close();
        const deadline = tcp.now(native.io) + 5000;
        var buffer: [64]u8 = undefined;
        var used: usize = 0;
        while (true) {
            if (cancelled.load(.acquire)) return error.Cancelled;
            if (tcp.now(native.io) >= deadline) return error.RexForwardTimeout;
            if (used == buffer.len) return error.InvalidRexForward;
            var polls = [_]std.posix.pollfd{.{ .fd = self.child.stdout.?.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&polls, 50) == 0) continue;
            const n = try std.posix.read(self.child.stdout.?.handle, buffer[used..]);
            if (n == 0) return error.RexForwardUnavailable;
            used += n;
            if (std.mem.indexOfScalar(u8, buffer[0..used], '\n') != null) break;
        }
        self.port = try forwardedPort(buffer[0..used]);
        const after = try identity(native, allocator, executable, server, cancelled);
        defer after.deinit();
        if (!std.mem.eql(u8, before.value.host_id, after.value.host_id) or !std.mem.eql(u8, before.value.account, after.value.account) or !std.mem.eql(u8, before.value.instance_id, after.value.instance_id)) return error.RexIdentityChanged;
        if (!try self.alive()) return error.RexForwardUnavailable;
        return self;
    }
    pub fn alive(self: *Tunnel) !bool {
        const pid = self.child.id orelse return false;
        const result = try Native.waitNoHang(pid);
        if (result.pid == 0) return true;
        self.child.id = null;
        return false;
    }
    pub fn close(self: *Tunnel) void {
        if (self.child.id) |pid| {
            // TERM lets Rex close only this process's tunnel blocks. Never kill
            // the session/server, and never signal a PID already reaped by us.
            std.posix.kill(-pid, .TERM) catch {};
            const deadline = tcp.now(self.native.io) + 5000;
            while (tcp.now(self.native.io) < deadline) {
                if (!(self.alive() catch true)) break;
                self.native.io.sleep(.fromMilliseconds(25), .awake) catch {};
            }
            if (self.child.id != null) {
                std.posix.kill(-pid, .KILL) catch {};
                _ = self.child.wait(self.native.io) catch {};
            }
        }
        Native.closeStreams(self.native.io, &self.child);
    }
};

test "Rex forwarding accepts HTTPS hosts, not credentials/aliases/insecure or arbitrary URLs" {
    for ([_][]const u8{ "https://rex.example.test", "https://rex.example.test/", "https://rex.example.test:443", "https://localhost" }) |value| try std.testing.expect(remoteEndpoint(value));
    for ([_][]const u8{ "", "rex", "http://rex.example.test", "https://", "https://user@host", "https://host/path", "https://host?token=x", "https://host#fragment", "https://host%2f", "https://host\n", "https://-host", "https://host..test", "https://host:0", "https://host:65536", "https://host:+443" }) |value| try std.testing.expect(!remoteEndpoint(value));
}
test "Rex forward readiness is an exact private-loopback TCP URL, never CLI success alone" {
    try std.testing.expectEqual(12345, try forwardedPort("tcp://127.0.0.1:12345\n"));
    try std.testing.expectEqual(12345, try forwardedPort("tcp://localhost:12345\n"));
    for ([_][]const u8{ "", "tcp://127.0.0.1:0\n", "tcp://0.0.0.0:12345\n", "tcp://127.0.0.1:12345", "http://127.0.0.1:12345\n", "tcp://127.0.0.1:12345\nextra", "tcp://127.0.0.1:+1234\n" }) |value| try std.testing.expectError(error.InvalidRexForward, forwardedPort(value));
}
