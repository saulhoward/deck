const std = @import("std");
const contracts = @import("generated/contracts.zig");
const max_frame = 1024 * 1024;

// This thread is the sole child waiter until serve returns. Cache a reaped status
// so main's deferred Child.wait only cleans streams and never waits/reaps twice.
fn runtimeExited(child: *std.process.Child) !bool {
    try child.waitForSpawn();
    if (child.term != null) return true;
    const result = std.posix.waitpid(child.id, std.posix.W.NOHANG);
    if (result.pid == 0) return false;
    const status = result.status;
    const term: std.process.Child.Term = if (std.posix.W.IFEXITED(status))
        .{ .Exited = std.posix.W.EXITSTATUS(status) }
    else if (std.posix.W.IFSIGNALED(status))
        .{ .Signal = std.posix.W.TERMSIG(status) }
    else if (std.posix.W.IFSTOPPED(status))
        .{ .Stopped = std.posix.W.STOPSIG(status) }
    else
        .{ .Unknown = status };
    child.term = term;
    return true;
}

fn readAll(child: *std.process.Child, bytes: []u8) !void {
    const file = child.stdout.?;
    var offset: usize = 0;
    while (offset < bytes.len) {
        if (try runtimeExited(child)) return error.RuntimeFailed;
        var polls = [_]std.posix.pollfd{.{ .fd = file.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&polls, 100) == 0) continue;
        const n = try file.read(bytes[offset..]);
        if (n == 0) return error.RuntimeClosed;
        offset += n;
    }
}

fn exchange(allocator: std.mem.Allocator, child: *std.process.Child, payload: []const u8) ![]u8 {
    if (payload.len == 0 or payload.len > max_frame) return error.InvalidFrame;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(payload.len), .big);
    try child.stdin.?.writeAll(&header);
    try child.stdin.?.writeAll(payload);
    try readAll(child, &header);
    const length = std.mem.readInt(u32, &header, .big);
    if (length == 0 or length > max_frame) return error.InvalidFrame;
    const response = try allocator.alloc(u8, length);
    errdefer allocator.free(response);
    try readAll(child, response);
    return response;
}

fn safePiId(value: std.json.Value) bool {
    if (!contracts.validPiId(value)) return false;
    return (std.fmt.parseInt(u64, value.string, 10) catch return false) <= 9007199254740991;
}
fn validDiscoveryReply(args: std.json.Value, result: std.json.Value) bool {
    if ((args != .null and !contracts.validListChatsArgs(args)) or !contracts.validChatListPage(result)) return false;
    var limit: u64 = 50;
    var after: u64 = 0;
    if (args != .null) {
        if (args.object.get("limit")) |value| limit = switch (value) {
            .integer => |n| @intCast(n),
            .float => |n| @intFromFloat(n),
            else => unreachable, // Generated integer guard ran above.
        };
        if (args.object.get("after")) |value| {
            if (!safePiId(value)) return false;
            after = std.fmt.parseInt(u64, value.string, 10) catch return false;
        }
    }
    const items = result.object.get("items").?.array.items;
    if (items.len > limit) return false;
    var previous = after;
    for (items) |item| {
        const id = item.object.get("chatId").?;
        if (!safePiId(id)) return false;
        const current = std.fmt.parseInt(u64, id.string, 10) catch return false;
        if (current <= previous) return false;
        previous = current;
        const parent = item.object.get("parentChatId");
        const owner = item.object.get("ownerTaskId");
        if ((parent == null) != (owner == null)) return false;
        if (parent) |value| if (!safePiId(value) or !safePiId(owner.?)) return false;
    }
    if (result.object.get("next")) |value| {
        if (!safePiId(value)) return false;
        const next = std.fmt.parseInt(u64, value.string, 10) catch return false;
        if (next <= after or next < previous) return false;
    }
    return true;
}
// Called only after generated envelope validation. Unknown commands still use
// their existing runtime/client checks; this is not permission to dispatch them.
fn validCommandReply(request: std.json.Value, reply: std.json.Value) bool {
    if (!reply.object.get("ok").?.bool) return true;
    const command = request.object.get("command").?.string;
    const args = request.object.get("args") orelse .null;
    const result = reply.object.get("result").?;
    if (std.mem.eql(u8, command, "list_chats")) return validDiscoveryReply(args, result);
    if (std.mem.eql(u8, command, "admit")) return contracts.validAdmitArgs(args) and safePiId(args.object.get("chatId").?) and contracts.validAdmitAck(result) and safePiId(result.object.get("submissionId").?);
    if (std.mem.eql(u8, command, "create_task")) return contracts.validCreateTaskArgs(args) and contracts.validCreateTaskAck(result) and safePiId(result.object.get("chatId").?);
    if (std.mem.eql(u8, command, "import_instructions")) return contracts.validInstructionImportArgs(args) and safePiId(args.object.get("chatId").?) and contracts.validInstructionImportAck(result) and safePiId(result.object.get("chatId").?) and safePiId(result.object.get("taskId").?) and std.mem.eql(u8, args.object.get("chatId").?.string, result.object.get("chatId").?.string) and std.mem.eql(u8, args.object.get("requestId").?.string, result.object.get("requestId").?.string);
    if (std.mem.eql(u8, command, "stop")) return contracts.validStopArgs(args) and safePiId(args.object.get("chatId").?) and contracts.validStopAck(result);
    if (std.mem.eql(u8, command, "rex_startup")) {
        const hub_id = request.object.get("hubId") orelse return false;
        if (!contracts.validTransportId(hub_id) or !contracts.validRexStartupArgs(args) or !safePiId(args.object.get("chatId").?) or !contracts.validRexStartupAck(result) or !safePiId(result.object.get("chatId").?) or !safePiId(result.object.get("taskId").?)) return false;
        return std.mem.eql(u8, args.object.get("chatId").?.string, result.object.get("chatId").?.string) and
            std.mem.eql(u8, args.object.get("allocationId").?.string, result.object.get("allocationId").?.string) and
            std.mem.eql(u8, args.object.get("blockId").?.string, result.object.get("blockId").?.string);
    }
    return true;
}

fn handle(allocator: std.mem.Allocator, connection: std.net.Server.Connection, child: *std.process.Child, port: u16) !void {
    defer connection.stream.close();
    // Bound stalled headers/bodies on the trusted local listener.
    const timeout = std.posix.timeval{ .sec = 3, .usec = 0 };
    try std.posix.setsockopt(connection.stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&timeout));
    try std.posix.setsockopt(connection.stream.handle, std.posix.SOL.SOCKET, std.posix.SO.SNDTIMEO, std.mem.asBytes(&timeout));
    var read_buffer: [8192]u8 = undefined;
    var write_buffer: [8192]u8 = undefined;
    var reader = connection.stream.reader(&read_buffer);
    var writer = connection.stream.writer(&write_buffer);
    var server = std.http.Server.init(reader.interface(), &writer.interface);
    var request = try server.receiveHead();
    const expected_host = try std.fmt.allocPrint(allocator, "127.0.0.1:{d}", .{port});
    defer allocator.free(expected_host);
    var host_ok = false;
    var headers = request.iterateHeaders();
    while (headers.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "origin")) {
            try request.respond("Browser requests are not supported", .{ .status = .forbidden, .keep_alive = false });
            return;
        }
        if (std.ascii.eqlIgnoreCase(header.name, "host")) {
            if (host_ok or !std.mem.eql(u8, header.value, expected_host)) {
                try request.respond("Invalid Host", .{ .status = .forbidden, .keep_alive = false });
                return;
            }
            host_ok = true;
        }
    }
    if (!host_ok) {
        try request.respond("Host required", .{ .status = .forbidden, .keep_alive = false });
        return;
    }
    if (request.head.method != .POST or !std.mem.eql(u8, request.head.target, "/v1/command")) {
        try request.respond("Use POST /v1/command", .{ .status = .not_found, .keep_alive = false });
        return;
    }
    if (request.head.content_length == null or request.head.content_length.? > max_frame) {
        try request.respond("Content-Length required, maximum 1 MiB", .{ .status = .payload_too_large, .keep_alive = false });
        return;
    }
    var body_buffer: [8192]u8 = undefined;
    const body_reader = try request.readerExpectContinue(&body_buffer);
    const body = try body_reader.allocRemaining(allocator, .limited(max_frame));
    defer allocator.free(body);
    // Validate public envelopes here, before forwarding to the private child's fatal parser.
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, body, .{}) catch {
        try request.respond("Invalid JSON", .{ .status = .bad_request, .keep_alive = false });
        return;
    };
    defer parsed.deinit();
    if (!contracts.validRequestEnvelope(parsed.value)) {
        try request.respond("Invalid command envelope", .{ .status = .bad_request, .keep_alive = false });
        return;
    }
    const response = try exchange(allocator, child, body);
    defer allocator.free(response);
    // A bad/mis-correlated private reply cannot be forwarded as a mutation ACK.
    // Stop this transport rather than leaving an out-of-sync writer available.
    // Dispatch may already have executed; never retry or report no effect.
    if (!std.unicode.utf8ValidateSlice(response)) return error.InvalidFrame;
    const reply = std.json.parseFromSlice(std.json.Value, allocator, response, .{}) catch return error.InvalidFrame;
    defer reply.deinit();
    if (!contracts.validResponseEnvelope(reply.value) or !std.mem.eql(u8, reply.value.object.get("id").?.string, parsed.value.object.get("id").?.string) or !validCommandReply(parsed.value, reply.value)) return error.InvalidFrame;
    try request.respond(response, .{ .keep_alive = false, .extra_headers = &.{.{ .name = "content-type", .value = "application/json" }} });
}

pub fn serve(allocator: std.mem.Allocator, child: *std.process.Child, port: u16) !void {
    var listener = try std.net.Address.listen(try std.net.Address.parseIp4("127.0.0.1", port), .{ .reuse_address = true });
    defer listener.deinit();
    try std.fs.File.stderr().writeAll("deck: hub listening on loopback (native file and bash tools enabled)\n");
    while (true) {
        // Poll rather than blocking forever in accept: a dead writer must not leave
        // an apparently healthy listener behind when no client is connected.
        if (try runtimeExited(child)) return error.RuntimeFailed;
        var polls = [_]std.posix.pollfd{.{ .fd = listener.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&polls, 100) == 0) continue;
        if (polls[0].revents & (std.posix.POLL.ERR | std.posix.POLL.HUP | std.posix.POLL.NVAL) != 0) return error.ListenerFailed;
        const connection = try listener.accept();
        handle(allocator, connection, child, port) catch |err| switch (err) {
            error.RuntimeFailed, error.RuntimeClosed, error.InvalidFrame, error.BrokenPipe => return err,
            else => {}, // A malformed/disconnected client must not stop the writer.
        };
    }
}
