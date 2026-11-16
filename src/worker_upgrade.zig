//! Explicit offline transition for automatic workers, including legacy daemons.
//! Never signals a metadata PID or starts a service. The actual writer lock is
//! held by both the native parent and administrative helper until it exits.
const std = @import("std");
const Native = @import("native.zig");
const storage = @import("private_store.zig");
const help =
    \\deck worker upgrade prepare --directory ABS_WORKER --output ABS_PLAN
    \\deck worker upgrade approve --directory ABS_HUB --from ABS_PLAN --output ABS_APPROVAL --confirm
    \\deck worker upgrade apply --directory ABS_WORKER --from ABS_APPROVAL --confirm
    \\
    \\Offline maintenance only. Drain hub work, stop the hub and this worker using
    \\their service owners, and back up both stores first. No process is stopped here.
    \\Prepare/apply use the replacement package on the worker; approve runs on the hub.
    \\Transfer the private plan/approval between machines through your trusted channel.
    \\Keep both services stopped throughout. Restart with the approved packages only
    \\after apply succeeds. Retry the same artifact after a lost acknowledgement;
    \\never remove locks, edit pins, discard receipts, or replay uncertain work.
    \\
;
pub fn run(native: Native, args: []const []const u8) !void {
    if (args.len == 0 or (args.len == 1 and std.mem.eql(u8, args[0], "--help"))) return std.Io.File.stdout().writeStreamingAll(native.io, help);
    const mode = args[0];
    const prepare = std.mem.eql(u8, mode, "prepare");
    const approve = std.mem.eql(u8, mode, "approve");
    if (!prepare and !approve and !std.mem.eql(u8, mode, "apply")) return error.InvalidArguments;
    var directory: ?[]const u8 = null;
    var from: ?[]const u8 = null;
    var output: ?[]const u8 = null;
    var confirm = false;
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--confirm") and !confirm) {
            confirm = true;
            continue;
        }
        const slot = if (std.mem.eql(u8, args[i], "--directory")) &directory else if (std.mem.eql(u8, args[i], "--from")) &from else if (std.mem.eql(u8, args[i], "--output")) &output else return error.InvalidArguments;
        i += 1;
        if (i >= args.len or slot.* != null or !@import("mcp_profiles.zig").absolute(args[i])) return error.InvalidArguments;
        slot.* = args[i];
    }
    if (directory == null or confirm == prepare or (from == null) != prepare or (output != null) != (prepare or approve)) return error.InvalidArguments;
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = try storage.openDirectory(native, directory.?, false);
    defer dir.close(native.io);
    const held = storage.lock(native, dir, "writer.lock") catch |err| switch (err) {
        error.ClientAlreadyStarting => return error.WorkerUpgradeRequiresOffline,
        else => return err,
    };
    defer held.close(native.io);
    const config = try @import("state.zig").load(native.io, a, dir);
    defer config.deinit();
    const implementation = try @import("remote_worker.zig").digest(native);
    const client = try @import("rex.zig").clientPath(native, a);
    var cancelled = std.atomic.Value(bool).init(false);
    if (!approve) @import("worker_client.zig").verify(native, a, client, &implementation, &implementation, &cancelled) catch return error.WorkerUpgradeUnsafeReplacement;
    var child = try std.process.spawn(native.io, .{
        .argv = &.{ try @import("runtime_paths.zig").node(native, a), try @import("runtime_paths.zig").entry(native, a, null, "worker-upgrade-main.js"), mode, directory.?, from orelse "", output orelse "", try std.fmt.allocPrint(a, "{d}", .{held.handle}), client, &implementation },
        .stdin = .ignore,
        .inherit_files = &.{held},
    });
    const term = try child.wait(native.io);
    switch (term) {
        .exited => |code| if (code != 0) return error.WorkerUpgradeUnconfirmed,
        else => return error.WorkerUpgradeUnconfirmed,
    }
}
