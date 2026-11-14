//! Bounded transport buffers, never an execution/retry queue.
const std = @import("std");
const Native = @import("native.zig");
pub const a = std.heap.page_allocator;
pub const cap = 1024 * 1024;
pub const fd_t = std.posix.fd_t;
pub fn now(io: std.Io) i64 {
    return std.Io.Clock.awake.now(io).toMilliseconds();
}
pub fn nonblock(fd: fd_t, enabled: bool) !void {
    const flags = try Native.fcntl(fd, std.posix.F.GETFL, 0);
    const bit: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
    _ = try Native.fcntl(fd, std.posix.F.SETFL, if (enabled) flags | bit else flags & ~bit);
}
pub fn ignorePipe() void {
    const action: std.posix.Sigaction = .{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(.PIPE, &action, null);
}
pub fn shutdown(fd: fd_t) void {
    _ = std.c.shutdown(fd, std.c.SHUT.RDWR);
}
pub fn duplicate(fd: fd_t) !fd_t {
    return @intCast(try Native.fcntl(fd, std.posix.F.DUPFD_CLOEXEC, 0));
}
pub fn timeout(fd: fd_t) !void {
    const duration = std.posix.timeval{ .sec = 5, .usec = 0 };
    try std.posix.setsockopt(fd, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&duration));
    try std.posix.setsockopt(fd, std.posix.SOL.SOCKET, std.posix.SO.SNDTIMEO, std.mem.asBytes(&duration));
}
pub fn peer(fd: fd_t) !std.Io.net.IpAddress {
    var address: std.Io.Threaded.PosixAddress = undefined;
    var length: std.posix.socklen_t = @sizeOf(@TypeOf(address));
    try std.posix.getpeername(fd, &address.any, &length);
    if (address.any.family != std.posix.AF.INET and address.any.family != std.posix.AF.INET6) return error.InvalidPeerAddress;
    return std.Io.Threaded.addressFromPosix(&address);
}
pub fn requireLoopback(fd: fd_t) !void {
    const address = try peer(fd);
    if (address != .ip4 or !std.mem.eql(u8, &address.ip4.bytes, &.{ 127, 0, 0, 1 })) return error.PeerIdentityMismatch;
}
pub fn accept(listener: fd_t) !fd_t {
    var address: std.Io.Threaded.PosixAddress = undefined;
    var length: std.posix.socklen_t = @sizeOf(@TypeOf(address));
    const rc = if (@import("builtin").os.tag == .linux) std.c.accept4(listener, &address.any, &length, std.posix.SOCK.CLOEXEC) else std.c.accept(listener, &address.any, &length);
    switch (std.c.errno(rc)) {
        .SUCCESS => {},
        .AGAIN, .INTR, .CONNABORTED => return error.WouldBlock,
        else => return error.AcceptUnavailable,
    }
    const fd: fd_t = @intCast(rc);
    errdefer Native.close(fd);
    _ = try Native.fcntl(fd, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
    try nonblock(fd, false);
    return fd;
}
pub fn connect(address: std.Io.net.IpAddress) !fd_t {
    const fd = std.c.socket(std.Io.Threaded.posixAddressFamily(&address), std.posix.SOCK.STREAM | (if (@import("builtin").os.tag == .linux) std.posix.SOCK.CLOEXEC else 0), 0);
    if (fd < 0) return error.ConnectionUnavailable;
    errdefer Native.close(fd);
    _ = try Native.fcntl(fd, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
    try nonblock(fd, true);
    var raw: std.Io.Threaded.PosixAddress = undefined;
    const length = std.Io.Threaded.addressToPosix(&address, &raw);
    const rc = std.c.connect(fd, &raw.any, length);
    switch (std.c.errno(rc)) {
        .SUCCESS => {},
        .INPROGRESS => {
            var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.OUT, .revents = 0 }};
            if (try std.posix.poll(&polls, 4000) == 0) return error.ConnectionTimeout;
            var failure: c_int = 0;
            var size: std.posix.socklen_t = @sizeOf(c_int);
            if (std.c.getsockopt(fd, std.posix.SOL.SOCKET, std.posix.SO.ERROR, &failure, &size) != 0 or failure != 0) return error.ConnectionUnavailable;
        },
        else => return error.ConnectionUnavailable,
    }
    try nonblock(fd, false);
    try timeout(fd);
    return fd;
}
fn ready(io: std.Io, fd: fd_t, event: i16, deadline: i64) !void {
    while (true) {
        const remaining = deadline - now(io);
        if (remaining <= 0) return error.FrameTimeout;
        var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = event, .revents = 0 }};
        if (try std.posix.poll(&polls, @intCast(@min(remaining, 100))) != 0) return;
    }
}
// MSG_DONTWAIT avoids changing shared descriptor flags and prevents a
// slow-progress sender/reader from resetting a per-syscall socket timeout.
// These functions are for sockets, never anonymous native pipes.
pub fn readUntil(io: std.Io, fd: fd_t, bytes: []u8, deadline: i64) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        try ready(io, fd, std.posix.POLL.IN, deadline);
        const n = std.c.recv(fd, bytes[offset..].ptr, bytes.len - offset, std.posix.MSG.DONTWAIT);
        switch (std.c.errno(n)) {
            .SUCCESS => {
                if (n == 0) return error.EndOfStream;
                offset += @intCast(n);
            },
            .AGAIN, .INTR => {},
            else => return error.TransportReadFailed,
        }
    }
}
pub fn writeUntil(io: std.Io, fd: fd_t, bytes: []const u8, deadline: i64) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        try ready(io, fd, std.posix.POLL.OUT, deadline);
        const n = std.c.send(fd, bytes[offset..].ptr, bytes.len - offset, std.posix.MSG.DONTWAIT);
        switch (std.c.errno(n)) {
            .SUCCESS => {
                if (n == 0) return error.EndOfStream;
                offset += @intCast(n);
            },
            .AGAIN, .INTR => {},
            else => return error.TransportWriteFailed,
        }
    }
}
pub fn writeAll(io: std.Io, fd: fd_t, bytes: []const u8) !void {
    const file: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = false } };
    try file.writeStreamingAll(io, bytes);
}
pub fn send(io: std.Io, fd: fd_t, value: anytype) !void {
    const bytes = try std.json.Stringify.valueAlloc(a, value, .{});
    defer a.free(bytes);
    if (bytes.len > 4096) return error.InvalidHandshake;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(bytes.len), .big);
    const deadline = now(io) + 5000;
    try writeUntil(io, fd, &header, deadline);
    try writeUntil(io, fd, bytes, deadline);
}
pub fn receive(io: std.Io, fd: fd_t) ![]u8 {
    const deadline = now(io) + 5000;
    var header: [4]u8 = undefined;
    try readUntil(io, fd, &header, deadline);
    const n = std.mem.readInt(u32, &header, .big);
    if (n == 0 or n > 4096) return error.InvalidHandshake;
    const bytes = try a.alloc(u8, n);
    errdefer a.free(bytes);
    try readUntil(io, fd, bytes, deadline);
    if (!std.unicode.utf8ValidateSlice(bytes)) return error.InvalidHandshake;
    return bytes;
}
pub const Reader = struct {
    buffer: std.ArrayList(u8) = .empty,
    began: ?i64 = null,
    pub fn deinit(self: *@This()) void {
        self.buffer.deinit(a);
    }
    pub fn reset(self: *@This()) void {
        self.buffer.clearRetainingCapacity();
        self.began = null;
    }
    pub fn read(self: *@This(), io: std.Io, fd: fd_t) !?[]const u8 {
        if (self.began) |time| if (now(io) - time > 5000) return error.FrameTimeout;
        const expected: usize = if (self.buffer.items.len < 4) 4 else blk: {
            const n = std.mem.readInt(u32, self.buffer.items[0..4], .big);
            if (n == 0 or n > cap) return error.InvalidFrame;
            break :blk n + 4;
        };
        var buf: [65536]u8 = undefined;
        const n = std.posix.read(fd, buf[0..@min(buf.len, expected - self.buffer.items.len)]) catch |err| switch (err) {
            error.WouldBlock => return null,
            else => return err,
        };
        if (n == 0) return error.EndOfStream;
        if (self.began == null) self.began = now(io);
        try self.buffer.appendSlice(a, buf[0..n]);
        if (expected > 4 and self.buffer.items.len == expected) return self.buffer.items[4..];
        return null;
    }
};
pub const Queue = struct {
    items: std.ArrayList([]u8) = .empty,
    offset: usize = 0,
    started: ?i64 = null,
    pub fn clear(self: *@This()) void {
        for (self.items.items) |item| a.free(item);
        self.items.clearRetainingCapacity();
        self.offset = 0;
        self.started = null;
    }
    pub fn deinit(self: *@This()) void {
        self.clear();
        self.items.deinit(a);
    }
    pub fn append(self: *@This(), body: []const u8) !void {
        if (self.items.items.len >= 20 or body.len == 0 or body.len > cap) return error.TransportCapacity;
        const bytes = try a.alloc(u8, body.len + 4);
        errdefer a.free(bytes);
        std.mem.writeInt(u32, bytes[0..4], @intCast(body.len), .big);
        @memcpy(bytes[4..], body);
        try self.items.append(a, bytes);
    }
    pub fn flush(self: *@This(), fd: fd_t, clock: ?std.Io) !void {
        if (self.items.items.len == 0) return;
        if (clock) |io| {
            if (self.started == null) self.started = now(io);
            if (now(io) - self.started.? >= 5000) return error.FrameTimeout;
        }
        const first = self.items.items[0];
        const bytes = first[self.offset..];
        const n = std.c.write(fd, bytes.ptr, bytes.len);
        switch (std.c.errno(n)) {
            .SUCCESS => self.offset += @intCast(n),
            .AGAIN, .INTR => return,
            else => return error.TransportWriteFailed,
        }
        if (self.offset == first.len) {
            a.free(self.items.orderedRemove(0));
            self.offset = 0;
            self.started = null;
        }
    }
};
