const std = @import("std");
const Native = @import("native.zig");
const tcp = @import("remote_io.zig");
const worker = @import("worker.zig");
const storage = @import("private_store.zig");
const io = std.testing.io;
test "handoff scopes preserve historical allocation clients and bind retries to the entire plan" {
    const wire = @import("generated/contracts.zig");
    const handoff = @import("handoff_contracts.zig");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const before: wire.WorkerRexClient = .{ .executable = "/tools/old", .socket = "/private/worker.sock" };
    var plan: wire.WorkerHandoffPlan = .{ .version = 1, .id = "00000000-0000-4000-8000-000000000001", .hubId = "00000000-0000-4000-8000-000000000002", .machineId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .beforeImplementation = &@as([64]u8, @splat('a')), .implementation = &@as([64]u8, @splat('b')), .beforeClient = before, .client = .{ .executable = "/tools/new", .socket = before.socket } };
    const old: wire.RexWorkerRegistration = .{ .version = 1, .hubId = plan.hubId, .machineId = plan.machineId, .implementation = plan.beforeImplementation, .rexClient = before, .capabilities = &.{ .files, .bash, .rex, .launcher } };
    const next = try handoff.replacement(a, old, plan);
    try std.testing.expect(handoff.matches(old, plan, false));
    try std.testing.expect(!handoff.matches(old, plan, true));
    try std.testing.expect(handoff.matches(next, plan, true));
    try std.testing.expectEqualStrings(before.executable, next.previousClients.?[0].executable);
    const hash = try handoff.hash(a, plan);
    plan.client.executable = "/tools/changed";
    try std.testing.expect(!std.mem.eql(u8, &hash, &try handoff.hash(a, plan)));
    var full = old;
    var previous: [8]wire.WorkerRexClient = undefined;
    for (&previous, 0..) |*p, index| p.* = .{ .executable = try std.fmt.allocPrint(a, "/tools/previous-{d}", .{index}), .socket = before.socket };
    full.previousClients = &previous;
    try std.testing.expectError(error.HandoffHistoryFull, handoff.replacement(a, full, plan));
    plan.client.socket = "/different.sock";
    try std.testing.expectError(error.InvalidHandoff, handoff.replacement(a, old, plan));
}
test "live worker quiescence waits for accepted effects without cancelling or accepting new frames" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const path = try tmp.dir.realPathFileAlloc(io, ".", a);
    try tmp.dir.createDir(io, "ops", .fromMode(0o700));
    const journal = try std.fs.path.join(a, &.{ path, "ops" });
    var sockets: [2]std.posix.fd_t = undefined;
    if (std.c.socketpair(std.posix.AF.UNIX, std.posix.SOCK.STREAM, 0, &sockets) != 0) return error.SocketPair;
    defer Native.close(sockets[0]);
    const output = try tcp.duplicate(sockets[1]);
    const control = try Native.pipe();
    var drain: worker.Drain = .{};
    const thread = try std.Thread.spawn(.{}, worker.serveRemoteMcpTracked, .{ Native.testing(), sockets[1], output, control[0], journal, "local", null, null, &drain });
    var stopped = false;
    defer if (!stopped) {
        Native.close(control[1]);
        thread.join();
    };
    try tcp.send(io, sockets[0], .{ .version = 1, .id = "1", .machineId = "local", .cwd = path, .operation = "bash", .args = .{ .command = "printf started > started; while [ ! -e release ]; do sleep 0.02; done; printf done >> effects", .timeout = 5 } });
    const start = tcp.now(io);
    while (true) {
        if (tmp.dir.access(io, "started", .{})) |_| break else |_| {}
        if (tcp.now(io) - start > 3000) return error.StartTimeout;
        try io.sleep(.fromMilliseconds(10), .awake);
    }
    try std.testing.expect(drain.ready.load(.acquire));
    drain.requested.store(true, .release);
    try io.sleep(.fromMilliseconds(150), .awake);
    try std.testing.expect(!drain.idle.load(.acquire));
    try tcp.send(io, sockets[0], .{ .version = 1, .id = "2", .machineId = "local", .cwd = path, .operation = "write", .args = .{ .path = "must-not-exist", .content = "bad" } });
    try tmp.dir.writeFile(io, .{ .sub_path = "release", .data = "" });
    const reply = try tcp.receive(io, sockets[0]);
    defer tcp.a.free(reply);
    const value = (try std.json.parseFromSlice(std.json.Value, a, reply, .{})).value;
    try std.testing.expect(value.object.get("result").?.object.get("ok").?.bool);
    const end = tcp.now(io) + 2000;
    while (!drain.idle.load(.acquire) and tcp.now(io) < end) try io.sleep(.fromMilliseconds(10), .awake);
    try std.testing.expect(drain.idle.load(.acquire));
    try std.testing.expectEqualStrings("done", try tmp.dir.readFileAlloc(io, "effects", a, .limited(32)));
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "must-not-exist", .{}));
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "ops/2.json", .{}));
    Native.close(control[1]);
    thread.join();
    stopped = true;
    try std.testing.expect(!drain.ready.load(.acquire));
}
test "a deferred live offer holds no custody after an explicit offline transition" {
    const wire = @import("generated/contracts.zig");
    const live = @import("worker_handoff.zig");
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const path = try tmp.dir.realPathFileAlloc(io, ".", a);
    try tmp.dir.setPermissions(io, .fromMode(0o700));
    var dir = try storage.openDirectory(Native.testing(), path, false);
    defer dir.close(io);
    const socket = try std.fs.path.join(a, &.{ path, "client.sock" });
    const old: wire.WorkerRexClient = .{ .executable = "/tools/old", .socket = socket };
    const plan: wire.WorkerHandoffPlan = .{ .version = 1, .id = "00000000-0000-4000-8000-000000000001", .hubId = "00000000-0000-4000-8000-000000000002", .machineId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .beforeImplementation = &@as([64]u8, @splat('a')), .implementation = &@as([64]u8, @splat('b')), .beforeClient = old, .client = .{ .executable = "/tools/proposed", .socket = socket } };
    const before: wire.RexWorkerConnection = .{ .version = 1, .pid = 42, .server = "https://example.test", .hostId = plan.hubId, .account = "test", .executable = "/tools/rex", .hubId = plan.hubId, .hubPort = 52800, .sessionId = "session:00000000-0000-4000-8000-000000000001", .pendingSession = false, .implementation = plan.beforeImplementation, .rexClient = old };
    const record: wire.WorkerHandoffLocal = .{ .plan = plan, .before = before, .phase = .deferred };
    try storage.save(Native.testing(), a, dir, live.filename, record);
    const retained = try tmp.dir.readFileAlloc(io, live.filename, a, .limited(16384));
    var interrupt = std.atomic.Value(bool).init(false);
    var shutdown = std.atomic.Value(bool).init(false);
    const manager = try live.Manager.init(Native.testing(), dir, path, plan.machineId, &@as([64]u8, @splat('c')), .{ .executable = "/tools/offline-approved", .socket = socket }, &interrupt, &shutdown);
    defer manager.deinit();
    try std.testing.expect(manager.intent == null);
    try std.testing.expect(!manager.drain.requested.load(.acquire));
    try std.testing.expectEqualStrings(retained, try tmp.dir.readFileAlloc(io, live.filename, a, .limited(16384)));
}
test "handoff inherits actual writer exclusion and rejects unrelated descriptors" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const native = Native.testing();
    const held = try storage.lock(native, tmp.dir, "writer.lock");
    defer held.close(io);
    const other = try storage.lock(native, tmp.dir, "other.lock");
    defer other.close(io);
    try std.testing.expectError(error.InvalidHandoffLock, storage.inheritedLock(native, tmp.dir, other.handle));
    const inherited = try tcp.duplicate(held.handle);
    defer Native.close(inherited);
    _ = try storage.inheritedLock(native, tmp.dir, inherited);
    try std.testing.expectError(error.ClientAlreadyStarting, storage.lock(native, tmp.dir, "writer.lock"));
}
