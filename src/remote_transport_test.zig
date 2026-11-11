const std = @import("std");
const wire = @import("generated/contracts.zig");
const Native = @import("native.zig");
const tcp = @import("remote_io.zig");
const Link = @import("remote_link.zig").Link;
const worker = @import("remote_worker.zig");
const io = std.testing.io;
const peer = wire.TailPeer{ .nodeId = "nRegistered", .userId = "1" };
const machine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const implementation = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
var checks = std.atomic.Value(usize).init(0);
fn verified(_: Native, a: std.mem.Allocator, _: []const u8, address: std.Io.net.IpAddress, _: *std.atomic.Value(bool)) !std.json.Parsed(wire.TailPeer) {
    // The real transport must pass the kernel socket peer, never header data.
    try std.testing.expect(address == .ip4);
    try std.testing.expectEqualSlices(u8, &.{ 127, 0, 0, 1 }, &address.ip4.bytes);
    try std.testing.expect(address.getPort() != 0);
    _ = checks.fetchAdd(1, .monotonic);
    return std.json.parseFromSlice(wire.TailPeer, a, "{\"nodeId\":\"nRegistered\",\"userId\":\"1\"}", .{ .allocate = .alloc_always });
}
fn wrongPeer(_: Native, a: std.mem.Allocator, _: []const u8, _: std.Io.net.IpAddress, _: *std.atomic.Value(bool)) !std.json.Parsed(wire.TailPeer) {
    return std.json.parseFromSlice(wire.TailPeer, a, "{\"nodeId\":\"nWrong\",\"userId\":\"1\"}", .{ .allocate = .alloc_always });
}
const Fixture = struct {
    link: *Link,
    address: std.Io.net.IpAddress,
    thread: std.Thread,
    input: tcp.fd_t,
    output: tcp.fd_t,
    control: tcp.fd_t,
    a: std.mem.Allocator,
    fn init(a: std.mem.Allocator) !Fixture {
        tcp.ignorePipe();
        const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
        const listener = try address.listen(io, .{ .reuse_address = true });
        const requests = try Native.pipe();
        const response = try Native.pipe();
        const control = try Native.pipe();
        const hosts = try a.alloc(wire.RemoteHost, 1);
        hosts[0] = .{ .machineId = machine, .peer = peer, .client = false, .implementation = implementation, .capabilities = &worker.capabilities };
        const link = try a.create(Link);
        link.* = .{ .native = Native.testing(), .registry = .{ .version = 1, .hubId = "hub", .hosts = hosts }, .index = 0, .tailscale = "test-only", .listener = listener, .verify = verified, .input = requests[0], .output = response[1], .control = control[0] };
        const thread = try std.Thread.spawn(.{}, Link.serve, .{link});
        try tcp.nonblock(response[0], true);
        return .{ .a = a, .link = link, .address = listener.socket.address, .thread = thread, .input = requests[1], .output = response[0], .control = control[1] };
    }
    fn deinit(self: *Fixture) void {
        Native.close(self.control);
        Native.close(self.input);
        self.thread.join();
        Native.close(self.output);
    }
    fn send(self: *Fixture, bytes: []const u8) !void {
        var header: [4]u8 = undefined;
        std.mem.writeInt(u32, &header, @intCast(bytes.len), .big);
        try tcp.writeAll(io, self.input, &header);
        try tcp.writeAll(io, self.input, bytes);
    }
    fn request(self: *Fixture, id: []const u8, cwd: []const u8, op: []const u8, args: anytype) ![]const u8 {
        return std.json.Stringify.valueAlloc(self.a, .{ .version = 1, .id = id, .machineId = machine, .cwd = cwd, .operation = op, .args = args }, .{});
    }
    fn reply(self: *Fixture) !std.json.Value {
        var reader: tcp.Reader = .{};
        defer reader.deinit();
        const start = tcp.now(io);
        while (tcp.now(io) - start < 5000) {
            if (try reader.read(io, self.output)) |body| {
                const parsed = try std.json.parseFromSlice(std.json.Value, self.a, body, .{ .allocate = .alloc_always });
                return parsed.value.object.get("result").?;
            }
            try io.sleep(.fromMilliseconds(10), .awake);
        }
        return error.TestTimeout;
    }
    fn cancel(self: *Fixture, id: u64) !void {
        var bytes: [8]u8 = undefined;
        std.mem.writeInt(u64, &bytes, id, .big);
        try tcp.writeAll(io, self.control, &bytes);
    }
};
const Runner = struct {
    address: std.Io.net.IpAddress,
    journal: []const u8,
    stop: std.atomic.Value(bool) = .init(false),
    thread: ?std.Thread = null,
    error_seen: ?anyerror = null,
    fn run(self: *Runner) void {
        worker.session(Native.testing(), .{ .version = 1, .hubId = "hub", .machineId = machine, .hubPeer = peer, .hubAddress = "test-injected-address" }, implementation, "test-only", self.journal, self.address, verified, &self.stop) catch |err| {
            self.error_seen = err;
        };
    }
    fn start(self: *Runner) !void {
        const previous = checks.load(.monotonic);
        self.thread = try std.Thread.spawn(.{}, run, .{self});
        const start_time = tcp.now(io);
        while (checks.load(.monotonic) < previous + 4) {
            if (tcp.now(io) - start_time > 5000) return error.TestTimeout;
            try io.sleep(.fromMilliseconds(10), .awake);
        }
    }
    fn end(self: *Runner) void {
        self.stop.store(true, .release);
        if (self.thread) |thread| {
            thread.join();
            self.thread = null;
        }
    }
};
fn waitFile(dir: std.Io.Dir, name: []const u8) !void {
    const start = tcp.now(io);
    while (tcp.now(io) - start < 5000) {
        dir.access(io, name, .{}) catch {
            try io.sleep(.fromMilliseconds(10), .awake);
            continue;
        };
        return;
    }
    return error.TestTimeout;
}
const Fake = struct {
    data: tcp.fd_t,
    control: tcp.fd_t,
    fn connect(fixture: *Fixture) !Fake {
        const data = try tcp.connect(fixture.address);
        errdefer Native.close(data);
        try tcp.send(io, data, wire.RemoteLinkHeader{ .version = 1, .channel = .data, .hubId = "hub", .machineId = machine });
        const challenge_bytes = try tcp.receive(io, data);
        defer tcp.a.free(challenge_bytes);
        const challenge = try wire.parseRemoteWorkerHello(fixture.a, challenge_bytes);
        try tcp.send(io, data, challenge.value);
        const ack = try tcp.receive(io, data);
        defer tcp.a.free(ack);
        const control = try tcp.connect(fixture.address);
        errdefer Native.close(control);
        try tcp.send(io, control, wire.RemoteLinkHeader{ .version = 1, .channel = .control, .hubId = "hub", .machineId = machine, .connectionId = challenge.value.connectionId });
        const control_ack = try tcp.receive(io, control);
        defer tcp.a.free(control_ack);
        return .{ .data = data, .control = control };
    }
    fn close(self: Fake) void {
        tcp.shutdown(self.data);
        tcp.shutdown(self.control);
        Native.close(self.data);
        Native.close(self.control);
    }
};

test "remote sockets preserve exact receipts across lost replies and explicit reconnect retry" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const cwd = try tmp.dir.realPathFileAlloc(io, ".", a);
    try tmp.dir.createDir(io, "ops", .default_dir);
    const journal_path = try std.fs.path.join(a, &.{ cwd, "ops" });
    var journal = try tmp.dir.openDir(io, "ops", .{});
    defer journal.close(io);
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const write = try fixture.request("1", cwd, "write", .{ .path = "file", .content = "once" });
    const exact = try std.mem.concat(a, u8, &.{ "\n ", write, "\n" });
    try fixture.send(exact);
    try std.testing.expectEqualStrings("offline", (try fixture.reply()).object.get("code").?.string);
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "file", .{}));
    const fake = try Fake.connect(&fixture);
    try fixture.send(exact);
    const received = try tcp.receive(io, fake.data);
    defer tcp.a.free(received);
    try std.testing.expectEqualStrings(exact, received);
    _ = try @import("worker.zig").operation(Native.testing(), a, journal, machine, received);
    // Accepted effect and retained receipt, but no result sent across the link.
    fake.close();
    try std.testing.expectEqualStrings("effect_uncertain", (try fixture.reply()).object.get("code").?.string);
    const receipt = try journal.readFileAlloc(io, "1.json", a, .limited(4096));
    try tmp.dir.writeFile(io, .{ .sub_path = "file", .data = "external" });
    var runner: Runner = .{ .address = fixture.address, .journal = journal_path };
    defer runner.end();
    try runner.start();
    // Reconnection alone does not replay any accepted request.
    try io.sleep(.fromMilliseconds(1200), .awake);
    try std.testing.expectEqualStrings("external", try tmp.dir.readFileAlloc(io, "file", a, .limited(1024)));
    try fixture.send(exact);
    try std.testing.expect((try fixture.reply()).object.get("ok").?.bool);
    try std.testing.expectEqualStrings(receipt, try journal.readFileAlloc(io, "1.json", a, .limited(4096)));
    try std.testing.expectEqualStrings("external", try tmp.dir.readFileAlloc(io, "file", a, .limited(1024)));
    try fixture.send(write);
    try std.testing.expectEqualStrings("conflict", (try fixture.reply()).object.get("code").?.string);
    try fixture.send(try fixture.request("2", cwd, "edit", .{ .path = "file", .oldText = "external", .newText = "edited" }));
    try std.testing.expect((try fixture.reply()).object.get("ok").?.bool);
    try fixture.send(try fixture.request("3", cwd, "read", .{ .path = "file" }));
    try std.testing.expectEqualStrings("edited", (try fixture.reply()).object.get("output").?.string);
    const uncertain = try fixture.request("4", cwd, "write", .{ .path = "file", .content = "must not repeat" });
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(uncertain, &hash, .{});
    const hex = std.fmt.bytesToHex(hash, .lower);
    const accepted = try std.fmt.allocPrint(a, "{{\"hash\":\"{s}\",\"result\":null}}", .{hex});
    try journal.writeFile(io, .{ .sub_path = "4.json", .data = accepted });
    try fixture.send(uncertain);
    try std.testing.expectEqualStrings("effect_uncertain", (try fixture.reply()).object.get("code").?.string);
    try std.testing.expectEqualStrings(accepted, try journal.readFileAlloc(io, "4.json", a, .limited(4096)));
    try std.testing.expectEqualStrings("edited", try tmp.dir.readFileAlloc(io, "file", a, .limited(1024)));
    runner.end();
    try std.testing.expect(runner.error_seen == null);
}

test "remote cancellation drains bash independently and another host survives disconnect" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const cwd = try tmp.dir.realPathFileAlloc(io, ".", a);
    try tmp.dir.createDir(io, "ops1", .default_dir);
    try tmp.dir.createDir(io, "ops2", .default_dir);
    var first = try Fixture.init(a);
    defer first.deinit();
    var second = try Fixture.init(a);
    defer second.deinit();
    var one: Runner = .{ .address = first.address, .journal = try std.fs.path.join(a, &.{ cwd, "ops1" }) };
    defer one.end();
    try one.start();
    var two: Runner = .{ .address = second.address, .journal = try std.fs.path.join(a, &.{ cwd, "ops2" }) };
    defer two.end();
    try two.start();
    try first.send(try first.request("10", cwd, "bash", .{ .command = "touch started; sleep 30; touch escaped", .timeout = 60 }));
    try waitFile(tmp.dir, "started");
    try first.cancel(10);
    try std.testing.expectEqualStrings("cancelled", (try first.reply()).object.get("code").?.string);
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "escaped", .{}));
    try first.send(try first.request("11", cwd, "bash", .{ .command = "touch started2; sleep 30; touch escaped2", .timeout = 60 }));
    try waitFile(tmp.dir, "started2");
    one.end();
    try std.testing.expectEqualStrings("effect_uncertain", (try first.reply()).object.get("code").?.string);
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "escaped2", .{}));
    try second.send(try second.request("1", cwd, "write", .{ .path = "second", .content = "still connected" }));
    try std.testing.expect((try second.reply()).object.get("ok").?.bool);
    try std.testing.expectEqualStrings("still connected", try tmp.dir.readFileAlloc(io, "second", a, .limited(1024)));
    try first.send(try first.request("12", cwd, "write", .{ .path = "offline", .content = "no" }));
    try std.testing.expectEqualStrings("offline", (try first.reply()).object.get("code").?.string);
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "offline", .{}));
}

test "remote invalid and duplicate connection traffic cannot replace a live generation" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    // A wrong implementation closes only the attempted connection.
    const invalid = try tcp.connect(fixture.address);
    defer Native.close(invalid);
    try tcp.send(io, invalid, wire.RemoteLinkHeader{ .version = 1, .channel = .data, .hubId = "hub", .machineId = machine });
    const bytes = try tcp.receive(io, invalid);
    defer tcp.a.free(bytes);
    const hello = try wire.parseRemoteWorkerHello(a, bytes);
    var changed = hello.value;
    changed.implementation = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    try tcp.send(io, invalid, changed);
    try std.testing.expectError(error.EndOfStream, tcp.receive(io, invalid));
    const fake = try Fake.connect(&fixture);
    defer fake.close();
    const duplicate = try tcp.connect(fixture.address);
    defer Native.close(duplicate);
    // Do not replace the active generation, even for the registered peer.
    try std.testing.expectError(error.EndOfStream, tcp.receive(io, duplicate));
    try fixture.send(try fixture.request("1", "/tmp", "read", .{ .path = "never-read" }));
    const request = try tcp.receive(io, fake.data);
    defer tcp.a.free(request);
    // A wrong-id result is not passed to Pi and permanently fences this socket.
    try tcp.send(io, fake.data, .{ .version = 1, .id = "999", .result = .{ .ok = true, .output = "PRIVATE_BAD_REPLY" } });
    const outcome = try fixture.reply();
    try std.testing.expectEqualStrings("effect_uncertain", outcome.object.get("code").?.string);
    try std.testing.expect(std.mem.indexOf(u8, outcome.object.get("output").?.string, "PRIVATE") == null);
    try fixture.send(try fixture.request("2", "/tmp", "read", .{ .path = "never-read" }));
    try std.testing.expectEqualStrings("offline", (try fixture.reply()).object.get("code").?.string);
}

test "remote cancellation remains live while result pipes are saturated" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const cwd = try tmp.dir.realPathFileAlloc(io, ".", a);
    try tmp.dir.createDir(io, "ops", .default_dir);
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    var runner: Runner = .{ .address = fixture.address, .journal = try std.fs.path.join(a, &.{ cwd, "ops" }) };
    defer runner.end();
    try runner.start();
    const large = try a.alloc(u8, 64000);
    @memset(large, 'x');
    try tmp.dir.writeFile(io, .{ .sub_path = "large", .data = large });
    try fixture.send(try fixture.request("40", cwd, "bash", .{ .command = "touch saturated-start; sleep 30; touch saturated-escaped", .timeout = 60 }));
    try waitFile(tmp.dir, "saturated-start");
    for (41..60) |id| try fixture.send(try fixture.request(try std.fmt.allocPrint(a, "{d}", .{id}), cwd, "read", .{ .path = "large" }));
    // Deliberately never read Pi's result pipe until cancellation is durably
    // observed at the worker. Neither data nor result backpressure may starve it.
    try io.sleep(.fromMilliseconds(200), .awake);
    try fixture.cancel(40);
    const start = tcp.now(io);
    while (true) {
        const bytes = try tmp.dir.readFileAlloc(io, "ops/40.json", a, .limited(4096));
        const receipt = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
        if (receipt.value.object.get("result")) |result| if (result == .object) {
            try std.testing.expectEqualStrings("cancelled", result.object.get("code").?.string);
            break;
        };
        if (tcp.now(io) - start > 5000) return error.TestTimeout;
        try io.sleep(.fromMilliseconds(10), .awake);
    }
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "saturated-escaped", .{}));
    for (0..20) |_| _ = try fixture.reply();
}

test "native hub registration supervisor inherits only worker pipe ends into its runtime child" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const cwd = try tmp.dir.realPathFileAlloc(io, ".", a);
    try tmp.dir.createDir(io, "ops", .default_dir);
    const path = try std.fs.path.join(a, &.{ cwd, "registry.json" });
    const hosts = [_]wire.RemoteHost{.{ .machineId = machine, .peer = peer, .client = false, .implementation = implementation, .capabilities = &worker.capabilities, .listen = "100.64.0.1:52901" }};
    const registry = try std.json.Stringify.valueAlloc(a, wire.RemoteRegistry{ .version = 1, .hubId = "hub", .hosts = &hosts }, .{});
    const file = try tmp.dir.createFile(io, "registry.json", .{ .permissions = .fromMode(0o600) });
    try file.writeStreamingAll(io, registry);
    file.close(io);
    const Loopback = struct {
        fn bind(native: Native, original: std.Io.net.IpAddress) !std.Io.net.Server {
            try std.testing.expectEqual(@as(u16, 52901), original.getPort());
            return (try std.Io.net.IpAddress.parse("127.0.0.1", 0)).listen(native.io, .{});
        }
    };
    const Hub = @import("remote_hub.zig").Hub;
    try std.testing.expectError(error.InvalidWorkerRegistration, Hub.initUsing(Native.testing(), path, "test-only", machine, Loopback.bind));
    var hub = try Hub.initUsing(Native.testing(), path, "test-only", "cccccccccccccccccccccccccccccccc", Loopback.bind);
    defer hub.deinit();
    hub.links.items[0].verify = verified;
    try hub.start();
    var runner: Runner = .{ .address = hub.links.items[0].listener.socket.address, .journal = try std.fs.path.join(a, &.{ cwd, "ops" }) };
    defer runner.end();
    try runner.start();
    const config = try hub.json();
    defer tcp.a.free(config);
    const script =
        \\const fs=require('node:fs'),{Socket}=require('node:net'); const route=JSON.parse(process.argv[1]).hosts[0];
        \\for(const fd of [route.readFd,route.writeFd,route.controlFd]) { if(!fs.fstatSync(fd).isFIFO()) process.exit(2); }
        \\const input=new Socket({fd:route.readFd,readable:true,writable:false});
        \\const output=new Socket({fd:route.writeFd,readable:false,writable:true});
        \\const control=new Socket({fd:route.controlFd,readable:false,writable:true});
        \\for(const stream of [input,output,control])stream.on('error',()=>process.exit(3));
        \\let bytes=Buffer.alloc(0);input.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>=4){const n=bytes.readUInt32BE(0);if(n>1024*1024)process.exit(4);if(bytes.length===n+4){process.stdout.write(bytes.subarray(4));input.destroy();output.destroy();control.destroy();}}});
        \\const body=Buffer.from(JSON.stringify({version:1,id:'1',machineId:route.machineId,cwd:process.argv[2],operation:'write',args:{path:'inherited',content:'remote'}}));
        \\const header=Buffer.alloc(4);header.writeUInt32BE(body.length);output.write(Buffer.concat([header,body]));
    ;
    var child = try std.process.spawn(io, .{ .argv = &.{ "node", "-e", script, config, cwd }, .stdin = .ignore, .stdout = .pipe, .stderr = .pipe, .inherit_files = hub.inherit.items });
    defer {
        if (child.id != null) child.kill(io);
        Native.closeStreams(io, &child);
    }
    hub.closeChildEnds();
    const output = try Native.readAll(io, child.stdout.?, a, 4096);
    const term = try child.wait(io);
    child.id = null;
    try std.testing.expect(term == .exited and term.exited == 0);
    const reply = try wire.parseNativeResponse(a, output);
    try std.testing.expect(reply.value.result.?.ok);
    try std.testing.expectEqualStrings("remote", try tmp.dir.readFileAlloc(io, "inherited", a, .limited(1024)));
}

test "network frame deadlines are absolute despite partial progress" {
    tcp.ignorePipe();
    const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var listener = try address.listen(io, .{});
    defer listener.deinit(io);
    const client = try tcp.connect(listener.socket.address);
    defer Native.close(client);
    const server = try listener.accept(io);
    defer server.close(io);
    const Dribble = struct {
        fn run(fd: tcp.fd_t) void {
            for (0..3) |_| {
                io.sleep(.fromMilliseconds(40), .awake) catch return;
                _ = std.c.send(fd, "x", 1, std.posix.MSG.DONTWAIT);
            }
        }
    };
    const thread = try std.Thread.spawn(.{}, Dribble.run, .{server.socket.handle});
    defer thread.join();
    var bytes: [32]u8 = undefined;
    try std.testing.expectError(error.FrameTimeout, tcp.readUntil(io, client, &bytes, tcp.now(io) + 70));
}

test "remote peer mismatch refuses before any handshake authority or native effect" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    var stop_flag = std.atomic.Value(bool).init(false);
    try std.testing.expectError(error.PeerIdentityMismatch, worker.session(Native.testing(), .{ .version = 1, .hubId = "hub", .machineId = machine, .hubPeer = peer, .hubAddress = "test-only" }, implementation, "test-only", "/unused", fixture.address, wrongPeer, &stop_flag));
    try fixture.send(try fixture.request("1", "/tmp", "write", .{ .path = "must-not-run", .content = "no" }));
    try std.testing.expectEqualStrings("offline", (try fixture.reply()).object.get("code").?.string);
}
