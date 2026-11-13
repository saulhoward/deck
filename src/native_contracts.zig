const std = @import("std");
const wire = @import("generated/contracts.zig");
const V = std.json.Value;
fn field(v: V, name: []const u8) V {
    return if (v == .object) v.object.get(name) orelse .null else .null;
}
fn text(v: V) []const u8 {
    return if (v == .string) v.string else "";
}
fn eq(v: V, s: []const u8) bool {
    return v == .string and std.mem.eql(u8, v.string, s);
}
fn path(v: V) bool {
    return v == .string and v.string.len <= 4096 and std.mem.indexOfScalar(u8, v.string, 0) == null;
}
fn id(v: V) ?u64 {
    if (v != .string or v.string.len == 0 or v.string.len > 20 or v.string[0] == '0') return null;
    for (v.string) |b| if (!std.ascii.isDigit(b)) return null;
    return std.fmt.parseInt(u64, v.string, 10) catch null;
}
fn safe(v: V) bool {
    const n = id(v) orelse return false;
    return n <= 9007199254740991;
}
pub fn validCancellationId(n: u64) bool {
    return n > 0 and (n <= 9007199254740991 or n >= (@as(u64, 1) << 63));
}
pub fn validRequest(allocator: std.mem.Allocator, v: V) bool {
    if (!wire.validNativeRequest(v)) return false;
    const cwd = field(v, "cwd");
    if (!path(cwd) or !std.mem.startsWith(u8, cwd.string, "/")) return false;
    var units: usize = 0;
    var iter = (std.unicode.Utf8View.init(text(field(v, "machineId"))) catch return false).iterator();
    while (iter.nextCodepoint()) |cp| {
        units += if (cp > 0xffff) @as(usize, 2) else 1;
        if (units > 200000) return false;
    }
    const operation = field(v, "operation");
    const args = field(v, "args");
    const request_id = field(v, "id");
    if (eq(operation, "bash_progress")) {
        const target = field(args, "target");
        return wire.validNativeProgressArgs(args) and safe(target) and std.mem.startsWith(u8, request_id.string, "progress:") and std.mem.eql(u8, request_id.string[9..], target.string);
    }
    const n = id(request_id) orelse return false;
    if (!validCancellationId(n)) return false;
    const ephemeral = eq(operation, "rex_inspect") or eq(operation, "rex_resolve") or eq(operation, "link_status");
    if (ephemeral != (n >= (@as(u64, 1) << 63))) return false;
    if (eq(operation, "link_status")) return args == .object and args.object.count() == 0;
    if (eq(operation, "read")) return wire.validNativeReadArgs(args) and path(field(args, "path"));
    if (eq(operation, "write")) return wire.validNativeWriteArgs(args) and path(field(args, "path")) and text(field(args, "content")).len <= 128 * 1024;
    if (eq(operation, "edit")) return wire.validNativeEditArgs(args) and path(field(args, "path")) and text(field(args, "oldText")).len > 0 and text(field(args, "oldText")).len <= 128 * 1024 and text(field(args, "newText")).len <= 128 * 1024;
    if (eq(operation, "bash")) return wire.validNativeBashArgs(args) and std.mem.indexOfScalar(u8, text(field(args, "command")), 0) == null;
    const limit: usize = if (eq(operation, "rex_allocation_receipt") or eq(operation, "mcp_call")) 256 * 1024 else 16 * 1024;
    if (!wire.validNativePlanArgs(args) or text(field(args, "plan")).len > limit) return false;
    const parsed = std.json.parseFromSlice(V, allocator, text(field(args, "plan")), .{}) catch return false;
    defer parsed.deinit();
    const plan = parsed.value;
    if (eq(operation, "mcp_call")) {
        if (!wire.validMachineIdentity(field(v, "machineId")) or !wire.validMcpCallPlan(plan) or !safe(field(plan, "conversationId")) or text(field(plan, "argumentsJSON")).len > 32768 or std.mem.indexOfAny(u8, text(field(plan, "argumentsJSON")), "\r\n") != null) return false;
        const args_json = std.json.parseFromSlice(V, allocator, text(field(plan, "argumentsJSON")), .{}) catch return false;
        defer args_json.deinit();
        return args_json.value == .object and @import("mcp_schema.zig").boundedJson(args_json.value);
    }
    if (eq(operation, "rex_allocate")) return wire.validRexAllocationPlan(plan) and safe(field(plan, "chatId"));
    if (eq(operation, "rex_inspect")) return wire.validRexInspectionQuery(plan);
    if (eq(operation, "rex_resolve")) return wire.validRexTargetOptions(plan);
    return wire.validRexAllocationReceiptQuery(plan) and safe(field(plan, "operationId")) and text(field(plan, "request")).len <= 128 * 1024;
}
pub fn parseRequest(allocator: std.mem.Allocator, body: []const u8) !std.json.Parsed(wire.NativeRequest) {
    if (body.len == 0 or body.len > 1024 * 1024 or !std.unicode.utf8ValidateSlice(body)) return error.InvalidContract;
    const raw = try std.json.parseFromSlice(V, allocator, body, .{});
    defer raw.deinit();
    if (!validRequest(allocator, raw.value)) return error.InvalidContract;
    return wire.parseNativeRequest(allocator, body);
}
pub fn validReply(request_id: []const u8, operation: wire.NativeOperation, v: V) bool {
    if (!wire.validNativeResponse(v) or !eq(field(v, "id"), request_id)) return false;
    const result = field(v, "result");
    const progress = field(v, "progress");
    if (operation == .bash_progress) return result == .null and progress != .null and text(field(progress, "output")).len <= 2048;
    if (operation == .mcp_call and mcpPayload(result)) {
        const raw = std.json.parseFromSlice(V, std.heap.page_allocator, text(field(result, "output")), .{}) catch return false;
        defer raw.deinit();
        const rid = text(field(raw.value, "id"));
        if (!std.mem.startsWith(u8, rid, "call:") or !std.mem.eql(u8, rid[5..], request_id)) return false;
    }
    return progress == .null and validResult(operation, result);
}
fn mcpPayload(v: V) bool {
    return eq(field(v, "code"), "mcp_result") or eq(field(v, "code"), "mcp_tool_error") or eq(field(v, "code"), "mcp_rpc_error");
}
pub fn validResult(operation: wire.NativeOperation, v: V) bool {
    if (!wire.validNativeResult(v) or operation == .bash_progress) return false;
    if (operation == .link_status and field(v, "ok").bool) return eq(field(v, "code"), "link_status") and (eq(field(v, "output"), "connected") or eq(field(v, "output"), "offline")) and field(v, "exitCode") == .null and !(field(v, "truncated") == .bool and field(v, "truncated").bool);
    if (operation == .mcp_call) {
        if (text(field(v, "output")).len > 65536 or field(v, "exitCode") != .null or (field(v, "truncated") == .bool and field(v, "truncated").bool)) return false;
        if (mcpPayload(v)) {
            const raw = std.json.parseFromSlice(V, std.heap.page_allocator, text(field(v, "output")), .{}) catch return false;
            defer raw.deinit();
            const rid = field(raw.value, "id");
            if (rid != .string or !std.mem.startsWith(u8, rid.string, "call:") or !safe(.{ .string = rid.string[5..] }) or !@import("mcp_stdio.zig").validRpcReply(raw.value, rid.string)) return false;
            const r = field(raw.value, "result");
            const failed = field(r, "isError") == .bool and field(r, "isError").bool;
            if (eq(field(v, "code"), "mcp_rpc_error")) return !field(v, "ok").bool and field(raw.value, "error") == .object;
            if (eq(field(v, "code"), "mcp_tool_error")) return !field(v, "ok").bool and r == .object and failed;
            return field(v, "ok").bool and r == .object and !failed;
        }
        if (field(v, "ok").bool) return false;
    }
    const shell = operation == .bash;
    const rex = switch (operation) {
        .rex_allocate, .rex_inspect, .rex_resolve, .rex_allocation_receipt => true,
        else => false,
    };
    const cap: usize = if (shell) 64 * 1024 + 256 else if (rex) 16 * 1024 else 128 * 1024;
    if (text(field(v, "output")).len > cap) return false;
    const exit = field(v, "exitCode");
    const truncated = field(v, "truncated");
    if (!shell and (exit != .null or (truncated == .bool and truncated.bool))) return false;
    const code = field(v, "code");
    const success: []const u8 = switch (operation) {
        .rex_allocate => "allocated",
        .rex_inspect => "rex_inspected",
        .rex_resolve => "rex_resolved",
        .rex_allocation_receipt => "rex_receipt",
        else => "ok",
    };
    const zero = switch (exit) {
        .integer => exit.integer == 0,
        .float => exit.float == 0,
        else => false,
    };
    if (field(v, "ok").bool) return (eq(code, success) or (!rex and code == .null)) and (!shell or zero);
    for ([_][]const u8{ "ok", "allocated", "rex_inspected", "rex_resolved", "rex_receipt", "link_status" }) |s| if (eq(code, s)) return false;
    return !shell or !zero or !eq(code, "exit_nonzero");
}
// Validate the actual serialized bytes at egress. Retained hashes and results are
// not re-encoded through generated codecs, and invalid evidence is never repaired.
pub fn checkReply(allocator: std.mem.Allocator, request: wire.NativeRequest, body: []const u8) !void {
    if (body.len == 0 or body.len > 1024 * 1024 or !std.unicode.utf8ValidateSlice(body)) return error.InvalidContract;
    const raw = try std.json.parseFromSlice(V, allocator, body, .{});
    defer raw.deinit();
    if (!validReply(request.id, request.operation, raw.value)) return error.InvalidContract;
}
