const std = @import("std");
const Native = @import("native.zig");
const forward = @import("rex_forward.zig");
const tcp = @import("remote_io.zig");

test "opt-in API 14 Rex forwarding preserves binary TCP and owns only its tunnel" {
    const source = Native.testing();
    const executable = source.environ.getPosix("DECK_TEST_REX_FORWARD") orelse return error.SkipZigTest;
    const io = source.io;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var random: [8]u8 = undefined;
    io.random(&random);
    const root = try std.fmt.allocPrint(a, "/tmp/deck-fwd-{s}", .{std.fmt.bytesToHex(random, .lower)});
    try std.Io.Dir.cwd().createDir(io, root, .fromMode(0o700));
    defer std.Io.Dir.cwd().deleteTree(io, root) catch {};
    const config = try std.fs.path.join(a, &.{ root, "empty.lua" });
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = config, .data = "" });
    const server = try std.fmt.allocPrint(a, "unix://{s}/rex.sock", .{root});
    var env = std.process.Environ.Map.init(a);
    try env.put("HOME", root);
    try env.put("PATH", "/usr/bin:/bin");
    try env.put("TMPDIR", root);
    const native: Native = .{ .io = io, .environ = .{ .block = try env.createPosixBlock(a, .{}) } };
    var child = try std.process.spawn(io, .{ .argv = &.{ executable, "server", "run", "--listen", server, "--state-dir", root, "--config", config, "--restore=false" }, .environ_map = &env, .stdin = .ignore, .stdout = .ignore, .stderr = .ignore });
    defer {
        if (child.id != null) child.kill(io);
        Native.closeStreams(io, &child);
    }
    var cancelled = std.atomic.Value(bool).init(false);
    const deadline = tcp.now(io) + 5000;
    while (true) {
        if (forward.identity(native, a, executable, server, &cancelled)) |value| {
            value.deinit();
            break;
        } else |_| {
            if (tcp.now(io) >= deadline) return error.TestRexUnavailable;
            try io.sleep(.fromMilliseconds(25), .awake);
        }
    }
    const created = try @import("shell.zig").runArgvCaptured(native, a, root, &.{ executable, "--autostart=false", "--server", server, "new", "owned-forward-test", "--json", "--shell=none", "--keep-open", "--", "/bin/sleep", "60" }, 4, &cancelled);
    try std.testing.expect(created.result.ok);
    const session = try std.json.parseFromSlice(struct { session_id: []const u8 }, a, created.stdout, .{ .ignore_unknown_fields = true });
    var listener = try (try std.Io.net.IpAddress.parse("127.0.0.1", 0)).listen(io, .{});
    defer listener.deinit(io);
    var tunnel = try forward.Tunnel.open(native, a, executable, server, session.value.session_id, listener.socket.address.getPort(), &cancelled);
    defer tunnel.close();
    const client = try tcp.connect(try std.Io.net.IpAddress.parse("127.0.0.1", tunnel.port));
    defer Native.close(client);
    var polls = [_]std.posix.pollfd{.{ .fd = listener.socket.handle, .events = std.posix.POLL.IN, .revents = 0 }};
    try std.testing.expect(try std.posix.poll(&polls, 4000) != 0);
    const accepted = try tcp.accept(listener.socket.handle);
    defer Native.close(accepted);
    var bytes: [4096]u8 = undefined;
    for (&bytes, 0..) |*byte, index| byte.* = @truncate(index);
    try tcp.writeUntil(io, client, &bytes, tcp.now(io) + 4000);
    var received: [4096]u8 = undefined;
    try tcp.readUntil(io, accepted, &received, tcp.now(io) + 4000);
    try std.testing.expectEqualSlices(u8, &bytes, &received);
    std.mem.reverse(u8, &bytes);
    try tcp.writeUntil(io, accepted, &bytes, tcp.now(io) + 4000);
    try tcp.readUntil(io, client, &received, tcp.now(io) + 4000);
    try std.testing.expectEqualSlices(u8, &bytes, &received);
    tunnel.close();
    try std.testing.expect(!try tunnel.alive());
    var end: [1]u8 = undefined;
    if (tcp.readUntil(io, accepted, &end, tcp.now(io) + 4000)) |_| return error.TestUnexpectedBytes else |err| switch (err) {
        error.EndOfStream, error.TransportReadFailed => {}, // API 14 may reset, rather than FIN, an active stream.
        else => return err,
    }
    const listed = try @import("shell.zig").runArgvCaptured(native, a, root, &.{ executable, "--autostart=false", "--server", server, "block", "ls", "--session", session.value.session_id, "--json", "--short=false" }, 4, &cancelled);
    try std.testing.expect(listed.result.ok);
    const blocks = try std.json.parseFromSlice(struct { blocks: []struct { flavor: []const u8 } }, a, listed.stdout, .{ .ignore_unknown_fields = true });
    try std.testing.expectEqual(1, blocks.value.blocks.len);
    try std.testing.expectEqualStrings("com.superlogical.terminal.shell", blocks.value.blocks[0].flavor);
}
