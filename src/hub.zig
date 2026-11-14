const std = @import("std");
const Native = @import("native.zig");
const contracts = @import("generated/contracts.zig");
const views = @import("views.zig");
const model_settings = @import("model_settings.zig");
const status_login = @import("status_login.zig");
const rex_open = @import("rex_open.zig");
const max_frame = 1024 * 1024;

// This thread is the sole child waiter until serve returns. Clearing the reaped
// pid prevents main's cleanup from waiting on it twice (or on a reused pid).
fn runtimeExited(child: *std.process.Child) !bool {
    const pid = child.id orelse return true;
    const result = try Native.waitNoHang(pid);
    if (result.pid == 0) return false;
    child.id = null;
    return true;
}

fn readAll(child: *std.process.Child, bytes: []u8) !void {
    const file = child.stdout.?;
    var offset: usize = 0;
    while (offset < bytes.len) {
        if (try runtimeExited(child)) return error.RuntimeFailed;
        var polls = [_]std.posix.pollfd{.{ .fd = file.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&polls, 100) == 0) continue;
        const n = try std.posix.read(file.handle, bytes[offset..]);
        if (n == 0) return error.RuntimeClosed;
        offset += n;
    }
}

fn exchange(io: std.Io, allocator: std.mem.Allocator, child: *std.process.Child, payload: []const u8) ![]u8 {
    if (payload.len == 0 or payload.len > max_frame) return error.InvalidFrame;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(payload.len), .big);
    try child.stdin.?.writeStreamingAll(io, &header);
    try child.stdin.?.writeStreamingAll(io, payload);
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
fn units(value: std.json.Value, maximum: usize) bool {
    if (value != .string) return false;
    var iter = (std.unicode.Utf8View.init(value.string) catch return false).iterator();
    var count: usize = 0;
    while (iter.nextCodepoint()) |cp| {
        count += if (cp > 0xffff) @as(usize, 2) else 1;
        if (count > maximum) return false;
    }
    return true;
}
// Pure client-facing validation. Importing this does not start a listener or own
// a Pi session; a Zig TUI can use the same semantics as native forwarding.
pub fn validCommandArgs(command: []const u8, raw: std.json.Value) bool {
    if (!contracts.validHubCommand(.{ .string = command })) return false;
    const args: std.json.Value = if (raw == .null) .{ .object = .empty } else raw;
    if (!@import("mcp_api.zig").validArgs(command, args) or !model_settings.validArgs(command, args) or !status_login.validArgs(command, args) or !rex_open.validArgs(command, args) or !views.validArgs(command, args)) return false;
    if (std.mem.eql(u8, command, "list_hosts")) return args == .object and args.object.count() == 0;
    if (std.mem.eql(u8, command, "list_chats")) {
        if (!contracts.validListChatsArgs(args)) return false;
        return if (args.object.get("after")) |after| safePiId(after) else true;
    }
    if (std.mem.eql(u8, command, "history")) {
        if (!contracts.validHistoryArgs(args) or !safePiId(args.object.get("chatId").?)) return false;
        const before = args.object.get("before");
        const after = args.object.get("after");
        if (before != null and after != null) return false;
        if (before) |value| if (!safePiId(value)) return false;
        if (after) |value| if (!std.mem.eql(u8, value.string, "0") and !safePiId(value)) return false;
    }
    if (std.mem.eql(u8, command, "admit")) return contracts.validAdmitArgs(args) and safePiId(args.object.get("chatId").?) and units(args.object.get("requestId").?, 200) and units(args.object.get("text").?, 200000);
    if (std.mem.eql(u8, command, "create_task_brief")) {
        if (!contracts.validCreateTaskBriefArgs(args)) return false;
        return units(args.object.get("requestId").?, 200) and units(args.object.get("machineId").?, 200000) and @import("task_brief.zig").title(args.object.get("title").?.string) and @import("task_brief.zig").cwd(args.object.get("cwd").?.string) and @import("task_brief.zig").fields(args) and (args.object.contains("problem") or args.object.contains("description"));
    }
    if (std.mem.eql(u8, command, "create_task") or std.mem.eql(u8, command, "import_instructions")) {
        if (std.mem.eql(u8, command, "create_task")) {
            if (!contracts.validCreateTaskArgs(args) or !units(args.object.get("title").?, 200000)) return false;
        } else if (!contracts.validInstructionImportArgs(args) or !safePiId(args.object.get("chatId").?)) return false;
        return units(args.object.get("requestId").?, 200) and units(args.object.get("machineId").?, 200000) and units(args.object.get("cwd").?, 200000);
    }
    if (std.mem.eql(u8, command, "stop")) return contracts.validStopArgs(args) and safePiId(args.object.get("chatId").?);
    if (std.mem.eql(u8, command, "rex_startup")) return contracts.validRexStartupArgs(args) and safePiId(args.object.get("chatId").?);
    return true;
}
pub fn validClientRequest(request: std.json.Value) bool {
    if (!contracts.validRequestEnvelope(request)) return false;
    const command = request.object.get("command").?.string;
    if ((std.mem.eql(u8, command, "rex_adopt") or std.mem.eql(u8, command, "mcp_catalog") or std.mem.eql(u8, command, "tool_profiles") or std.mem.eql(u8, command, "set_tool_profiles") or std.mem.eql(u8, command, "model_settings") or std.mem.eql(u8, command, "set_model_settings")) and !request.object.contains("hubId")) return false;
    if (request.object.get("hubId")) |hub_id| if (!contracts.validTransportId(hub_id) or !units(hub_id, 200)) return false;
    return validCommandArgs(request.object.get("command").?.string, request.object.get("args") orelse .null);
}
pub fn validCreationAck(args: std.json.Value, result: std.json.Value, with_brief: bool) bool {
    if (!validCommandArgs(if (with_brief) "create_task_brief" else "create_task", args) or !contracts.validCreateTaskAck(result) or !safePiId(result.object.get("chatId").?)) return false;
    const brief = result.object.get("brief");
    if (!with_brief) return brief == null;
    if (brief == null or !@import("task_brief.zig").valid(brief.?)) return false;
    for ([_][]const u8{ "problem", "description" }) |key| {
        const original = args.object.get(key);
        const echoed = brief.?.object.get(key);
        if ((original == null) != (echoed == null)) return false;
        if (original) |text| if (!std.mem.eql(u8, text.string, echoed.?.string)) return false;
    }
    return true;
}
pub fn validHosts(value: std.json.Value) bool {
    if (!contracts.validHostInventory(value)) return false;
    const items = value.object.get("items").?.array.items;
    var local = false;
    for (items, 0..) |item, i| {
        const is_local = std.mem.eql(u8, item.object.get("kind").?.string, "local");
        if (is_local != std.mem.eql(u8, item.object.get("connection").?.string, "local") or (is_local and local)) return false;
        local = local or is_local;
        for (items[0..i]) |prior| if (std.mem.eql(u8, prior.object.get("machineId").?.string, item.object.get("machineId").?.string)) return false;
    }
    return true;
}
fn validDiscoveryReply(args: std.json.Value, result: std.json.Value) bool {
    if (!validCommandArgs("list_chats", args) or !contracts.validChatListPage(result)) return false;
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
        if (item.object.get("brief")) |brief| if (!@import("task_brief.zig").valid(brief)) return false;
    }
    if (result.object.get("next")) |value| {
        if (!safePiId(value)) return false;
        const next = std.fmt.parseInt(u64, value.string, 10) catch return false;
        if (next <= after or next < previous) return false;
    }
    return true;
}
// Generated guards establish numeric type/range before this conversion. JSON
// integral float/exponent spellings retain the same semantics as TypeScript.
fn historyNumber(value: std.json.Value) u64 {
    return switch (value) {
        .integer => |n| @intCast(n),
        .float => |n| @intFromFloat(n),
        else => unreachable,
    };
}
fn validHistoryReply(args: std.json.Value, result: std.json.Value) bool {
    if (!validCommandArgs("history", args) or !contracts.validHistoryPage(result) or !views.validAttachments(args, result)) return false;
    if (!safePiId(args.object.get("chatId").?)) return false;
    const before = args.object.get("before");
    const after = args.object.get("after");
    if (before != null and after != null) return false;
    if (before) |value| if (!safePiId(value)) return false;
    if (after) |value| if (!std.mem.eql(u8, value.string, "0") and !safePiId(value)) return false;
    const items = result.object.get("items").?.array.items;
    const limit = if (args.object.get("limit")) |value| historyNumber(value) else 100;
    if (items.len > limit) return false;
    var previous: u64 = if (after orelse before) |value| std.fmt.parseInt(u64, value.string, 10) catch return false else std.math.maxInt(u64);
    for (items) |entry| {
        const current = historyNumber(entry.object.get("id").?);
        if (if (after != null) current <= previous else current >= previous) return false;
        previous = current;
        const kind = entry.object.get("kind").?.string;
        if (std.mem.eql(u8, kind, "deck.input")) {
            const data = entry.object.get("data") orelse return false;
            if (!contracts.validHistoryInputData(data)) return false;
            if (data.object.get("origin")) |origin| {
                if (origin == .object) {
                    if (origin.object.get("kind")) |tag| {
                        if (tag == .string and std.mem.eql(u8, tag.string, "task-tool")) {
                            if (!contracts.validHistoryAgentOrigin(origin) or !safePiId(origin.object.get("chatId").?) or !safePiId(origin.object.get("taskId").?)) return false;
                            if (origin.object.get("chain")) |chain| if (!safePiId(chain.object.get("rootChatId").?) or !safePiId(chain.object.get("replyToChatId").?)) return false;
                        }
                    }
                }
            }
        } else if (std.mem.eql(u8, kind, "pi.assistant") or std.mem.eql(u8, kind, "pi.tool-result")) {
            const model = entry.object.get("model") orelse return false;
            if (!contracts.validHistoryMessages(model)) return false;
            for (model.array.items) |message| {
                if (std.mem.eql(u8, kind, "pi.tool-result") and (!message.object.contains("toolName") or !message.object.contains("isError"))) return false;
                if (message.object.get("content")) |content| {
                    for (content.array.items) |part| {
                        const tag = part.object.get("type").?.string;
                        if (std.mem.eql(u8, tag, "text") and !part.object.contains("text")) return false;
                        if (std.mem.eql(u8, tag, "toolCall") and !part.object.contains("name")) return false;
                    }
                }
            }
        }
    }
    if (result.object.get("next")) |value| {
        if (!safePiId(value) or items.len == 0) return false;
        const next = std.fmt.parseInt(u64, value.string, 10) catch return false;
        if (next != previous) return false;
    }
    return true;
}
test "history semantic fixtures agree with TypeScript without rewriting Pi records" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const fixtures = try std.json.parseFromSlice(std.json.Value, arena.allocator(), @embedFile("history.test.json"), .{});
    for (fixtures.value.array.items) |fixture| {
        const actual = validHistoryReply(fixture.object.get("args").?, fixture.object.get("page").?);
        if (actual != fixture.object.get("valid").?.bool) {
            std.debug.print("history fixture failed: {s}\n", .{fixture.object.get("name").?.string});
            return error.InvalidHistoryContract;
        }
    }
}
// Complete envelope/correlation/command guard, reusable by a client. Unknown
// errors remain displayable; unknown successful commands are not permission.
pub fn validReply(request: std.json.Value, reply: std.json.Value) bool {
    if (!contracts.validRequestEnvelope(request) or !contracts.validResponseEnvelope(reply) or !std.mem.eql(u8, request.object.get("id").?.string, reply.object.get("id").?.string)) return false;
    if (!reply.object.get("ok").?.bool) return true;
    const command = request.object.get("command").?.string;
    const args = request.object.get("args") orelse .null;
    if (!validClientRequest(request)) return false;
    const result = reply.object.get("result").?;
    if (!@import("mcp_api.zig").validReply(command, args, result)) return false;
    if (!model_settings.validReply(command, args, request.object.get("hubId"), result)) return false;
    if (!status_login.validReply(command, args, request.object.get("hubId"), result)) return false;
    if (!views.validReply(command, args, result) or !rex_open.validReply(command, args, request.object.get("hubId") orelse .null, result)) return false;
    if (std.mem.eql(u8, command, "list_hosts")) return validHosts(result);
    if (std.mem.eql(u8, command, "list_chats")) return validDiscoveryReply(args, result);
    if (std.mem.eql(u8, command, "history")) return validHistoryReply(args, result);
    if (std.mem.eql(u8, command, "admit")) return contracts.validAdmitArgs(args) and safePiId(args.object.get("chatId").?) and contracts.validAdmitAck(result) and safePiId(result.object.get("submissionId").?);
    if (std.mem.eql(u8, command, "create_task")) return validCreationAck(args, result, false);
    if (std.mem.eql(u8, command, "create_task_brief")) return validCreationAck(args, result, true);
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

fn handle(io: std.Io, allocator: std.mem.Allocator, connection: std.Io.net.Stream, child: *std.process.Child, port: u16) !void {
    defer connection.close(io);
    // Bound stalled headers/bodies on the trusted local listener.
    const timeout = std.posix.timeval{ .sec = 3, .usec = 0 };
    try std.posix.setsockopt(connection.socket.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&timeout));
    try std.posix.setsockopt(connection.socket.handle, std.posix.SOL.SOCKET, std.posix.SO.SNDTIMEO, std.mem.asBytes(&timeout));
    var read_buffer: [8192]u8 = undefined;
    var write_buffer: [8192]u8 = undefined;
    var reader = connection.reader(io, &read_buffer);
    var writer = connection.writer(io, &write_buffer);
    var server = std.http.Server.init(&reader.interface, &writer.interface);
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
    const response = try exchange(io, allocator, child, body);
    defer allocator.free(response);
    // A bad/mis-correlated private reply cannot be forwarded as a mutation ACK.
    // Stop this transport rather than leaving an out-of-sync writer available.
    // Dispatch may already have executed; never retry or report no effect.
    if (!std.unicode.utf8ValidateSlice(response)) return error.InvalidFrame;
    const reply = std.json.parseFromSlice(std.json.Value, allocator, response, .{}) catch return error.InvalidFrame;
    defer reply.deinit();
    if (!validReply(parsed.value, reply.value)) return error.InvalidFrame;
    try request.respond(response, .{ .keep_alive = false, .extra_headers = &.{.{ .name = "content-type", .value = "application/json" }} });
}

pub fn serve(io: std.Io, allocator: std.mem.Allocator, child: *std.process.Child, port: u16) !void {
    const address = try std.Io.net.IpAddress.parseIp4("127.0.0.1", port);
    var listener = try address.listen(io, .{ .reuse_address = true });
    defer listener.deinit(io);
    try std.Io.File.stderr().writeStreamingAll(io, "deck: hub listening on loopback (native file and bash tools enabled)\n");
    while (true) {
        // Poll rather than blocking forever in accept: a dead writer must not leave
        // an apparently healthy listener behind when no client is connected.
        if (try runtimeExited(child)) return error.RuntimeFailed;
        var polls = [_]std.posix.pollfd{.{ .fd = listener.socket.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&polls, 100) == 0) continue;
        if (polls[0].revents & (std.posix.POLL.ERR | std.posix.POLL.HUP | std.posix.POLL.NVAL) != 0) return error.ListenerFailed;
        const connection = try listener.accept(io);
        handle(io, allocator, connection, child, port) catch |err| switch (err) {
            error.RuntimeFailed, error.RuntimeClosed, error.InvalidFrame, error.BrokenPipe => return err,
            else => {}, // A malformed/disconnected client must not stop the writer.
        };
    }
}
