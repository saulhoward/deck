//! Test-only executable for scripts/rex-here-pty-test.py. Not linked or installed
//! by build.zig. Its PTYs, private records, fake Rex and processes are test-owned.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
extern "c" fn tcgetpgrp(c_int) std.posix.pid_t;
extern "c" fn tcsetpgrp(c_int, std.posix.pid_t) c_int;
fn run(init: std.process.Init) !void {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    if (args.len < 4) return error.InvalidArguments;
    const native: Native = .{ .io = init.io, .environ = init.minimal.environ };
    const input = try std.Io.Dir.cwd().openFile(native.io, args[2], .{});
    defer input.close(native.io);
    const bytes = try Native.readAll(native.io, input, a, 16384);
    var cancelled = std.atomic.Value(bool).init(false);
    var hold = false;
    var previous_group: ?std.posix.pid_t = null;
    defer if (previous_group) |pgid| {
        _ = tcsetpgrp(0, pgid);
    };
    const result: []const u8 = if (std.mem.startsWith(u8, args[1], "capture")) blk: {
        // Expose the test child's PID to fake Rex independently of its proof.
        const pidfile = try std.Io.Dir.cwd().createFile(native.io, try std.fmt.allocPrint(a, "{s}.pid", .{args[3]}), .{});
        try pidfile.writeStreamingAll(native.io, try std.fmt.allocPrint(a, "{d}", .{std.c.getpid()}));
        pidfile.close(native.io);
        if (std.mem.eql(u8, args[1], "capture_background") and std.c.setpgid(0, 0) != 0) return error.BackgroundFailed;
        if (std.mem.eql(u8, args[1], "capture_job")) {
            const pgid = tcgetpgrp(0);
            if (pgid < 1) return error.ForegroundFailed;
            // Fixture-only interactive job-control setup, NEVER capture itself.
            const ignore: std.posix.Sigaction = .{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
            std.posix.sigaction(.TTOU, &ignore, null);
            if (std.c.setpgid(0, 0) != 0 or tcsetpgrp(0, std.c.getpid()) != 0) return error.ForegroundFailed;
            previous_group = pgid;
        }
        const base = (try wire.parseRexBootstrapRecord(a, bytes)).value;
        const record = try @import("rex_here.zig").capture(native, a, base, "42", &cancelled);
        hold = true;
        break :blk try std.json.Stringify.valueAlloc(a, record, .{});
    } else if (std.mem.eql(u8, args[1], "verify")) blk: {
        const record = (try wire.parseRexBootstrapRecord(a, bytes)).value;
        break :blk @tagName(try @import("rex_here.zig").verify(native, a, record, &cancelled));
    } else if (std.mem.eql(u8, args[1], "inspect")) blk: {
        const result = try @import("rex_inspect.zig").inspect(native, a, "/", bytes, &cancelled);
        if (!result.ok) return error.InspectionFailed;
        break :blk result.output;
    } else if (std.mem.eql(u8, args[1], "adopt")) blk: {
        const plan = (try wire.parseRexAllocationPlan(a, bytes)).value;
        const record = try @import("rex_bootstrap.zig").load(native, a, plan.bootstrap.?.root, plan.bootstrap.?.id);
        const result = try @import("rex_bootstrap.zig").adopt(native, a, record.cwd, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", plan, &cancelled);
        if (!result.ok) return error.AdoptionFailed;
        break :blk result.output;
    } else return error.InvalidArguments;
    const output = try std.Io.Dir.cwd().createFile(native.io, args[3], .{ .permissions = .fromMode(0o600) });
    try output.writeStreamingAll(native.io, result);
    output.close(native.io);
    if (hold) {
        var buffer: [1]u8 = undefined;
        _ = try std.posix.read(0, &buffer); // Keep the actual adopted PID alive.
    }
}
pub fn main(init: std.process.Init) void {
    run(init) catch |err| {
        std.debug.print("here-fixture: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
}
