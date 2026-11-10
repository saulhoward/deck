//! Explicit process I/O and immutable environment, shared by native worker threads.
//! POSIX helpers below cover descriptor/process supervision not exposed by std.Io.
const std = @import("std");
const Native = @This();
io: std.Io,
environ: std.process.Environ,

// Joins the existing detached OS worker threads; this is not an execution queue.
pub const WaitGroup = struct {
    count: usize = 0,
    mutex: std.Io.Mutex = .init,
    drained: std.Io.Condition = .init,
    pub fn start(self: *@This(), io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.count += 1;
    }
    pub fn finish(self: *@This(), io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        std.debug.assert(self.count > 0);
        self.count -= 1;
        if (self.count == 0) self.drained.broadcast(io);
    }
    pub fn wait(self: *@This(), io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        while (self.count != 0) self.drained.waitUncancelable(io, &self.mutex);
    }
};

pub fn testing() Native {
    return .{ .io = std.testing.io, .environ = std.testing.environ };
}

pub fn close(fd: std.posix.fd_t) void {
    // Do not retry close on EINTR: the descriptor may already have been released.
    _ = std.c.close(fd);
}

pub fn fcntl(fd: std.posix.fd_t, command: i32, argument: u32) !u32 {
    while (true) {
        const rc = std.c.fcntl(fd, command, argument);
        switch (std.c.errno(rc)) {
            .SUCCESS => return @intCast(rc),
            .INTR => continue,
            else => return error.DescriptorFailed,
        }
    }
}

pub fn pipe() ![2]std.posix.fd_t {
    var fds: [2]std.posix.fd_t = undefined;
    if (@import("builtin").os.tag == .linux) {
        // Atomic CLOEXEC matters when native process slots spawn concurrently.
        if (std.c.pipe2(&fds, .{ .CLOEXEC = true }) != 0) return error.PipeFailed;
    } else {
        // Darwin has no pipe2. These supervisor pipes are created before workers.
        if (std.c.pipe(&fds) != 0) return error.PipeFailed;
        errdefer for (fds) |fd| close(fd);
        for (fds) |fd| _ = try fcntl(fd, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
    }
    return fds;
}

pub const WaitResult = struct { pid: std.posix.pid_t, status: u32 };
pub fn waitNoHang(pid: std.posix.pid_t) !WaitResult {
    while (true) {
        var status: c_int = 0;
        const rc = std.c.waitpid(pid, &status, std.posix.W.NOHANG);
        switch (std.c.errno(rc)) {
            .SUCCESS => return .{ .pid = rc, .status = @bitCast(status) },
            .INTR => continue,
            else => return error.WaitFailed,
        }
    }
}

pub fn readAll(io: std.Io, file: std.Io.File, allocator: std.mem.Allocator, limit: usize) ![]u8 {
    var reader = file.readerStreaming(io, &.{});
    return reader.interface.allocRemaining(allocator, .limited(limit));
}

/// A manually reaped child must not be passed to Child.wait/kill a second time.
pub fn closeStreams(io: std.Io, child: *std.process.Child) void {
    if (child.stdin) |file| file.close(io);
    if (child.stdout) |file| file.close(io);
    if (child.stderr) |file| file.close(io);
    child.stdin = null;
    child.stdout = null;
    child.stderr = null;
}

test "supervisor pipes start close-on-exec and preserve bounded raw transfer" {
    const fds = try pipe();
    defer for (fds) |fd| close(fd);
    for (fds) |fd| try std.testing.expect((try fcntl(fd, std.posix.F.GETFD, 0)) & std.posix.FD_CLOEXEC != 0);
    const writer: std.Io.File = .{ .handle = fds[1], .flags = .{ .nonblocking = false } };
    try writer.writeStreamingAll(std.testing.io, "frame");
    var bytes: [5]u8 = undefined;
    try std.testing.expectEqual(5, try std.posix.read(fds[0], &bytes));
    try std.testing.expectEqualStrings("frame", &bytes);
}

test "worker drain joins completed and pending OS thread jobs" {
    const Job = struct {
        fn run(group: *WaitGroup, done: *std.atomic.Value(u32), delayed: bool) void {
            defer group.finish(std.testing.io);
            if (delayed) std.testing.io.sleep(.fromMilliseconds(10), .awake) catch unreachable;
            _ = done.fetchAdd(1, .release);
        }
    };
    var group: WaitGroup = .{};
    var done: std.atomic.Value(u32) = .init(0);
    var threads: [4]std.Thread = undefined;
    var started: usize = 0;
    defer for (threads[0..started]) |thread| thread.join();
    for (&threads, 0..) |*thread, i| {
        group.start(std.testing.io);
        thread.* = std.Thread.spawn(.{}, Job.run, .{ &group, &done, i % 2 == 0 }) catch |err| {
            group.finish(std.testing.io);
            return err;
        };
        started += 1;
    }
    group.wait(std.testing.io);
    try std.testing.expectEqual(4, done.load(.acquire));
    group.wait(std.testing.io); // Already drained is also safe.
}
