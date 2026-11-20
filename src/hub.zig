const std = @import("std");
const Native = @import("native.zig");
const contracts = @import("generated/contracts.zig");
const views = @import("views.zig");
const model_settings = @import("model_settings.zig");
const status_login = @import("status_login.zig");
const rex_open = @import("rex_open.zig");
const managed_child = @import("managed_child.zig");
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

const pipe_io = @import("remote_io.zig");
const exchange_budget_ms = 60_000; // Includes cold startup when the first request arrives early.
const Direction = enum { read, write };

// Both pipe ends used by the supervisor are nonblocking. A single absolute
// budget covers the request and reply, even if a writer stops mid-frame.
fn transfer(io: std.Io, child: *std.process.Child, comptime direction: Direction, bytes: if (direction == .read) []u8 else []const u8, deadline: i64) !void {
    const fd = if (direction == .read) child.stdout.?.handle else child.stdin.?.handle;
    var offset: usize = 0;
    while (offset < bytes.len) {
        if (try runtimeExited(child)) return error.RuntimeFailed;
        const left = deadline - pipe_io.now(io);
        if (left <= 0) return error.RuntimeTimeout;
        var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = if (direction == .read) std.posix.POLL.IN else std.posix.POLL.OUT, .revents = 0 }};
        if (try std.posix.poll(&polls, @intCast(@min(100, left))) == 0) continue;
        const rest = bytes[offset..];
        const n = if (direction == .read) std.c.read(fd, rest.ptr, rest.len) else std.c.write(fd, rest.ptr, rest.len);
        switch (std.c.errno(n)) {
            .SUCCESS => if (n == 0) return error.RuntimeClosed else {
                offset += @intCast(n);
            },
            .INTR, .AGAIN => continue,
            else => return error.RuntimeClosed,
        }
    }
}

fn exchange(io: std.Io, allocator: std.mem.Allocator, child: *std.process.Child, payload: []const u8, deadline: i64) ![]u8 {
    if (payload.len == 0 or payload.len > max_frame) return error.InvalidFrame;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(payload.len), .big);
    try transfer(io, child, .write, &header, deadline);
    try transfer(io, child, .write, payload, deadline);
    try transfer(io, child, .read, &header, deadline);
    const length = std.mem.readInt(u32, &header, .big);
    if (length == 0 or length > max_frame) return error.InvalidFrame;
    const response = try allocator.alloc(u8, length);
    errdefer allocator.free(response);
    try transfer(io, child, .read, response, deadline);
    return response;
}

test "private exchange budget includes partial replies and blocked request writes" {
    const io = std.testing.io;
    const a = std.testing.allocator;
    var child = try std.process.spawn(io, .{ .argv = &.{ "sh", "-c", "printf '\\000\\000\\000\\005x'; kill -STOP $$" }, .stdin = .pipe, .stdout = .pipe });
    defer {
        if (child.id) |pid| {
            std.posix.kill(pid, .KILL) catch {};
            _ = child.wait(io) catch {};
        }
        Native.closeStreams(io, &child);
    }
    try pipe_io.nonblock(child.stdin.?.handle, true);
    try pipe_io.nonblock(child.stdout.?.handle, true);
    try std.testing.expectError(error.RuntimeTimeout, exchange(io, a, &child, "request", pipe_io.now(io) + 100));
    const large = try a.alloc(u8, max_frame);
    defer a.free(large);
    @memset(large, ' ');
    try std.testing.expectError(error.RuntimeTimeout, transfer(io, &child, .write, large, pipe_io.now(io) + 100));
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
    if (std.mem.eql(u8, command, "subagent_view")) return validSubagentViewArgs(args);
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
    if (std.mem.eql(u8, command, "create_managed_child")) {
        if (!contracts.validCreateManagedChildArgs(args)) return false;
        return safePiId(args.object.get("parentChatId").?) and units(args.object.get("requestId").?, 200) and @import("task_brief.zig").title(args.object.get("title").?.string) and @import("task_brief.zig").fields(args);
    }
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
    if ((std.mem.eql(u8, command, "create_managed_child") or std.mem.eql(u8, command, "subagent_view") or std.mem.eql(u8, command, "rex_adopt") or std.mem.eql(u8, command, "mcp_catalog") or std.mem.eql(u8, command, "tool_profiles") or std.mem.eql(u8, command, "set_tool_profiles") or std.mem.eql(u8, command, "model_settings") or std.mem.eql(u8, command, "set_model_settings")) and !request.object.contains("hubId")) return false;
    if (request.object.get("hubId")) |hub_id| if (!contracts.validTransportId(hub_id) or !units(hub_id, 200)) return false;
    return validCommandArgs(request.object.get("command").?.string, request.object.get("args") orelse .null);
}
// The selector is only a parent-scoped read adapter, never a general command
// tunnel. Build nested arguments in bounded scratch memory after checking the
// closed per-operation options; do not mutate the caller's JSON object.
fn subagentReadArgs(allocator: std.mem.Allocator, args: std.json.Value, child: std.json.Value) !std.json.Value {
    var nested: std.json.Value = .{ .object = .empty };
    try nested.object.ensureTotalCapacity(allocator, 9); // chatId + eight history options
    if (args.object.get("options")) |options| {
        var it = options.object.iterator();
        while (it.next()) |entry| nested.object.putAssumeCapacity(entry.key_ptr.*, entry.value_ptr.*);
    }
    nested.object.putAssumeCapacity("chatId", child);
    return nested;
}
fn subagentChild(parent: std.json.Value, child: std.json.Value) bool {
    if (!safePiId(parent) or !safePiId(child)) return false;
    return (std.fmt.parseInt(u64, child.string, 10) catch return false) > (std.fmt.parseInt(u64, parent.string, 10) catch return false);
}
fn validSubagentViewArgs(args: std.json.Value) bool {
    if (!contracts.validSubagentViewArgs(args) or !safePiId(args.object.get("chatId").?)) return false;
    const name = args.object.get("name");
    const child = args.object.get("childId");
    if ((name == null) == (child == null)) return false;
    if (child) |id| if (!subagentChild(args.object.get("chatId").?, id)) return false;
    const operation = args.object.get("operation").?.string;
    const keys: []const []const u8 = if (std.mem.eql(u8, operation, "history"))
        &.{ "limit", "before", "after", "includeActivity", "includeAgentStatus", "includeSubagents", "includeProgress", "includeInstructions" }
    else if (std.mem.eql(u8, operation, "activity"))
        &.{ "includeAgentStatus", "includeSubagents" }
    else
        &.{};
    if (args.object.get("options")) |options| {
        if (options != .object) return false;
        for (options.object.keys()) |key| {
            var allowed = false;
            for (keys) |candidate| if (std.mem.eql(u8, key, candidate)) {
                allowed = true;
                break;
            };
            if (!allowed) return false;
        }
    }
    var buffer: [2048]u8 = undefined;
    var scratch = std.heap.FixedBufferAllocator.init(&buffer);
    const nested = subagentReadArgs(scratch.allocator(), args, child orelse .{ .string = "1" }) catch return false;
    // The generated operation enum excludes subagent_view itself and all effects.
    return validCommandArgs(operation, nested);
}
fn validSubagentViewReply(args: std.json.Value, expected_hub: ?std.json.Value, value: std.json.Value) bool {
    if (!validSubagentViewArgs(args) or !contracts.validSubagentViewReply(value)) return false;
    const hub = expected_hub orelse return false;
    if (!contracts.validTransportId(hub) or !std.mem.eql(u8, hub.string, value.object.get("hubId").?.string) or
        !std.mem.eql(u8, args.object.get("chatId").?.string, value.object.get("parentChatId").?.string) or
        !std.mem.eql(u8, args.object.get("operation").?.string, value.object.get("operation").?.string)) return false;
    const child = value.object.get("childId").?;
    if (!subagentChild(args.object.get("chatId").?, child)) return false;
    if (args.object.get("childId")) |id| if (!std.mem.eql(u8, child.string, id.string)) return false;
    const query = args.object.get("name");
    const echoed = value.object.get("name");
    if ((query == null) != (echoed == null)) return false;
    if (query) |name| if (!std.mem.eql(u8, name.string, echoed.?.string)) return false;
    // Match the TS adapter's compact-result cap even for in-process callers.
    var size = std.Io.Writer.Discarding.init(&.{});
    std.json.Stringify.value(value, .{}, &size.writer) catch return false;
    if (size.fullCount() >= max_frame) return false;
    var buffer: [2048]u8 = undefined;
    var scratch = std.heap.FixedBufferAllocator.init(&buffer);
    const nested = subagentReadArgs(scratch.allocator(), args, child) catch return false;
    const operation = args.object.get("operation").?.string;
    const result = value.object.get("result").?;
    if (std.mem.eql(u8, operation, "status")) {
        if (!contracts.validStatusSnapshot(result) or result.object.contains("activity")) return false;
        const binding = result.object.get("binding") orelse return false;
        const kind = binding.object.get("kind") orelse return false;
        if (!std.mem.eql(u8, kind.string, "subagent")) return false;
        const parent = binding.object.get("parentChatId") orelse return false;
        if (!std.mem.eql(u8, parent.string, args.object.get("chatId").?.string) or !safePiId(binding.object.get("ownerTaskId") orelse return false)) return false;
    }
    return (!std.mem.eql(u8, operation, "history") or validHistoryReply(nested, result)) and
        status_login.validReply(operation, nested, hub, result) and
        views.validReply(operation, nested, result) and
        model_settings.validReply(operation, nested, hub, result);
}
test {
    _ = @import("subagent_view_test.zig");
    _ = @import("managed_children_test.zig");
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
pub fn validManagedChildAck(args: std.json.Value, result: std.json.Value) bool {
    if (!validCommandArgs("create_managed_child", args) or !contracts.validCreateManagedChildAck(result)) return false;
    const parent = result.object.get("parentChatId").?;
    const brief = result.object.get("brief").?;
    if (!managed_child.precedes(parent, result.object.get("chatId").?) or !std.mem.eql(u8, parent.string, args.object.get("parentChatId").?.string) or !@import("task_brief.zig").valid(brief)) return false;
    for ([_][]const u8{ "problem", "description" }) |key| {
        const original = args.object.get(key);
        const echoed = brief.object.get(key);
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
        if (!managed_child.validLink(id, item)) return false;
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
    if (std.mem.eql(u8, command, "subagent_view")) return validSubagentViewReply(args, request.object.get("hubId"), result);
    if (!@import("mcp_api.zig").validReply(command, args, result)) return false;
    if (!model_settings.validReply(command, args, request.object.get("hubId"), result)) return false;
    if (!status_login.validReply(command, args, request.object.get("hubId"), result)) return false;
    if (!views.validReply(command, args, result) or !rex_open.validReply(command, args, request.object.get("hubId") orelse .null, result)) return false;
    if (std.mem.eql(u8, command, "list_hosts")) return validHosts(result);
    if (std.mem.eql(u8, command, "list_chats")) return validDiscoveryReply(args, result);
    if (std.mem.eql(u8, command, "history")) return validHistoryReply(args, result);
    if (std.mem.eql(u8, command, "admit")) return contracts.validAdmitArgs(args) and safePiId(args.object.get("chatId").?) and contracts.validAdmitAck(result) and safePiId(result.object.get("submissionId").?);
    if (std.mem.eql(u8, command, "create_managed_child")) return validManagedChildAck(args, result);
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
    // Derived reads require their explicit hub/parent scope and closed read-only
    // operation before reaching the private runtime. Preserve correlated command
    // errors (rather than turning invalid args into fatal transport failures).
    if (std.mem.eql(u8, parsed.value.object.get("command").?.string, "subagent_view") and !validClientRequest(parsed.value)) {
        const invalid = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = parsed.value.object.get("id").?.string, .ok = false, .@"error" = .{ .code = "invalid", .message = "Invalid subagent view request" } }, .{});
        defer allocator.free(invalid);
        try request.respond(invalid, .{ .keep_alive = false, .extra_headers = &.{.{ .name = "content-type", .value = "application/json" }} });
        return;
    }
    const response = exchange(io, allocator, child, body, pipe_io.now(io) + exchange_budget_ms) catch |err| switch (err) {
        error.RuntimeTimeout => return error.RuntimeTimeout,
        else => return error.RuntimeFailed, // Never reuse a partially exchanged stream.
    };
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
    pipe_io.ignorePipe();
    try pipe_io.nonblock(child.stdin.?.handle, true);
    try pipe_io.nonblock(child.stdout.?.handle, true);
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
            error.RuntimeFailed, error.RuntimeTimeout, error.InvalidFrame => return err,
            else => {}, // A malformed/disconnected client must not stop the writer.
        };
    }
}

test "HTTP subagent reads validate scope before forwarding and fence corrupt nested replies" {
    const io = std.testing.io;
    const a = std.testing.allocator;
    const fixtures = try std.json.parseFromSlice(std.json.Value, a, @embedFile("subagent_view.test.json"), .{});
    defer fixtures.deinit();
    const names = [_][]const u8{
        "status reply",                          "history reply",                           "activity reply",                     "progress reply",                                "model_settings reply",
        "status query preserves exact spelling", "status name must echo exact query",       "status binding ownerTaskId",         "status binding requires kind",                  "nested history duplicate entry",
        "activity nested agentStatus",           "progress generation requires run",        "nested models duplicate model keys", "wrong child history activity",                  "explicit hub required",
        "not a read operation stop",             "not a read operation set_model_settings", "not a read operation subagent_view", "status forbidden options {\"chatId\": \"11\"}",
    };
    var checked: usize = 0;
    for (fixtures.value.array.items) |fixture| {
        const name = fixture.object.get("name").?.string;
        var selected = false;
        for (names) |candidate| if (std.mem.eql(u8, name, candidate)) {
            selected = true;
            break;
        };
        if (!selected) continue;
        checked += 1;
        const value = fixture.object.get("request").?;
        const payload = try std.json.Stringify.valueAlloc(a, value, .{});
        defer a.free(payload);
        // This deliberately untrusted writer responds even to malformed requests
        // if forwarded. A correlated invalid error therefore proves the
        // native guard refused the request before sending any private frame.
        const reply = try std.json.Stringify.valueAlloc(a, fixture.object.get("reply") orelse .null, .{});
        defer a.free(reply);
        var bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &bytes, @intCast(reply.len), .big);
        const header = try std.fmt.allocPrint(a, "\\0{o:0>3}\\0{o:0>3}\\0{o:0>3}\\0{o:0>3}", .{ bytes[0], bytes[1], bytes[2], bytes[3] });
        defer a.free(header);
        var child = try std.process.spawn(io, .{ .argv = &.{ "sh", "-c", "dd bs=1 count=4 of=/dev/null 2>/dev/null; printf 'read\\n' >&2; printf '%b' \"$1\"; printf '%s' \"$2\"; kill -STOP $$", "fixture", header, reply }, .stdin = .pipe, .stdout = .pipe, .stderr = .pipe });
        defer {
            if (child.id) |pid| {
                std.posix.kill(pid, .KILL) catch {};
                _ = child.wait(io) catch {};
            }
            Native.closeStreams(io, &child);
        }
        try pipe_io.nonblock(child.stdin.?.handle, true);
        try pipe_io.nonblock(child.stdout.?.handle, true);
        try pipe_io.nonblock(child.stderr.?.handle, true);
        var listener = try (try std.Io.net.IpAddress.parseIp4("127.0.0.1", 0)).listen(io, .{});
        defer listener.deinit(io);
        const port = listener.socket.address.getPort();
        const client = try listener.socket.address.connect(io, .{ .mode = .stream });
        defer client.close(io);
        const accepted = try listener.accept(io);
        var write_buffer: [4096]u8 = undefined;
        var writer = client.writer(io, &write_buffer);
        try writer.interface.print("POST /v1/command HTTP/1.1\r\nHost: 127.0.0.1:{d}\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n{s}", .{ port, payload.len, payload });
        try writer.interface.flush();
        const args_valid = validClientRequest(value);
        if (args_valid and !fixture.object.get("valid").?.bool) {
            try std.testing.expectError(error.InvalidFrame, handle(io, a, accepted, &child, port));
        } else try handle(io, a, accepted, &child, port);
        var read_buffer: [4096]u8 = undefined;
        var reader = client.reader(io, &read_buffer);
        const response = try reader.interface.allocRemaining(a, .limited(8192));
        defer a.free(response);
        if (args_valid and !fixture.object.get("valid").?.bool) {
            try std.testing.expectEqual(@as(usize, 0), response.len);
        } else {
            try std.testing.expect(std.mem.startsWith(u8, response, "HTTP/1.1 200"));
            const start = (std.mem.indexOf(u8, response, "\r\n\r\n") orelse return error.NoHttpBody) + 4;
            const parsed = try std.json.parseFromSlice(std.json.Value, a, response[start..], .{});
            defer parsed.deinit();
            try std.testing.expect(validReply(value, parsed.value));
            try std.testing.expectEqual(args_valid, parsed.value.object.get("ok").?.bool);
        }
        var log: [64]u8 = undefined;
        const count = std.c.read(child.stderr.?.handle, &log, log.len);
        if (args_valid) {
            try std.testing.expectEqual(@as(isize, 5), count);
            try std.testing.expectEqualStrings("read\n", log[0..5]);
        } else {
            try std.testing.expectEqual(@as(isize, -1), count);
            try std.testing.expectEqual(std.posix.E.AGAIN, std.c.errno(count));
        }
    }
    try std.testing.expectEqual(names.len, checked);
}
