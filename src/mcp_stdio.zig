//! One owned stdio server per invocation. No shell, discovery-by-PATH, retries or shared cwd/env.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const schema = @import("mcp_schema.zig");
const profiles = @import("mcp_profiles.zig");
const Result = @import("shell.zig").Result;
const V = std.json.Value;
const get = schema.get;
const eq = schema.eq;
fn now(io: std.Io) i64 {
    return @import("remote_io.zig").now(io);
}
fn allowed(v: V, keys: []const []const u8) bool {
    if (v != .object) return false;
    var it = v.object.iterator();
    while (it.next()) |p| {
        var found = false;
        for (keys) |key| {
            if (std.mem.eql(u8, p.key_ptr.*, key)) found = true;
        }
        if (!found) return false;
    }
    return true;
}
pub fn validResult(v: V) bool {
    if (!schema.boundedJson(v) or !allowed(v, &.{ "content", "structuredContent", "isError", "_meta" })) return false;
    const content = get(v, "content");
    if (content != .array or content.array.items.len > 64) return false;
    if (v.object.get("isError")) |e| if (e != .bool) return false;
    if (v.object.get("structuredContent")) |s| if (s != .object) return false;
    if (v.object.get("_meta")) |s| if (s != .object) return false;
    for (content.array.items) |p| if (!allowed(p, &.{ "type", "text" }) or !eq(get(p, "type"), "text") or get(p, "text") != .string) return false;
    return true;
}
pub fn validRpcReply(v: V, id: []const u8) bool {
    if (!schema.boundedJson(v) or !allowed(v, &.{ "jsonrpc", "id", "result", "error" }) or !eq(get(v, "jsonrpc"), "2.0") or !eq(get(v, "id"), id)) return false;
    if (v.object.contains("result") == v.object.contains("error")) return false;
    if (v.object.get("result")) |r| return validResult(r);
    const e = get(v, "error");
    if (!allowed(e, &.{ "code", "message", "data" }) or get(e, "message") != .string) return false;
    const code = get(e, "code");
    return switch (code) {
        .integer => @abs(code.integer) <= 9007199254740991,
        .float => std.math.isFinite(code.float) and @abs(code.float) <= 9007199254740991 and @floor(code.float) == code.float,
        else => false,
    };
}
const Session = struct {
    native: Native,
    a: std.mem.Allocator,
    child: std.process.Child,
    cancelled: *std.atomic.Value(bool),
    end: i64,
    input: std.array_list.Managed(u8),
    stderr_bytes: usize = 0,
    messages: usize = 0,
    notification_bytes: usize = 0,
    call_id: ?[]const u8 = null,
    stale: bool = false,
    fn init(native: Native, a: std.mem.Allocator, p: wire.McpPrivateProfile, cwd: []const u8, cancelled: *std.atomic.Value(bool)) !Session {
        // A closed server stdin must be an EPIPE result, not a signal that kills
        // the hub. Do not rely on an invoking shell/Node process to ignore it.
        @import("remote_io.zig").ignorePipe();
        const end = now(native.io) + 25000;
        try profiles.verifyPin(native, .{ .path = p.executable, .sha256 = p.sha256 }, cancelled, end);
        for (p.files) |pin| try profiles.verifyPin(native, pin, cancelled, end);
        var env = std.process.Environ.Map.init(a);
        defer env.deinit();
        for (p.env) |e| {
            const value = if (e.value) |v| v else blk: {
                const bytes = try profiles.readPrivate(native, a, e.file.?, 4096);
                const digest = profiles.hash(bytes);
                if (!std.mem.eql(u8, &digest, e.sha256.?) or !std.unicode.utf8ValidateSlice(bytes) or std.mem.indexOfScalar(u8, bytes, 0) != null) return error.McpCredentialChanged;
                break :blk bytes;
            };
            try env.put(e.name, value);
        }
        if (cancelled.load(.acquire) or now(native.io) >= end) return error.Cancelled;
        const argv = try a.alloc([]const u8, p.argv.len + 1);
        argv[0] = p.executable;
        @memcpy(argv[1..], p.argv);
        var child = try std.process.spawn(native.io, .{ .argv = argv, .cwd = .{ .path = if (std.mem.eql(u8, p.cwd, "$TASK")) cwd else p.cwd }, .environ_map = &env, .pgid = 0, .stdin = .pipe, .stdout = .pipe, .stderr = .pipe });
        errdefer {
            std.posix.kill(-child.id.?, std.posix.SIG.KILL) catch {};
            child.kill(native.io);
        }
        for ([_]std.Io.File{ child.stdin.?, child.stdout.?, child.stderr.? }) |f| {
            const flags = try Native.fcntl(f.handle, std.posix.F.GETFL, 0);
            _ = try Native.fcntl(f.handle, std.posix.F.SETFL, flags | @as(u32, @bitCast(std.posix.O{ .NONBLOCK = true })));
        }
        return .{ .native = native, .a = a, .child = child, .cancelled = cancelled, .end = end, .input = .init(a) };
    }
    fn deinit(self: *Session) void {
        if (self.call_id) |id| {
            const cancel = std.json.Stringify.valueAlloc(self.a, .{ .jsonrpc = "2.0", .method = "notifications/cancelled", .params = .{ .requestId = id } }, .{}) catch null;
            if (cancel) |bytes| {
                const line = std.mem.concat(self.a, u8, &.{ bytes, "\n" }) catch null;
                if (line) |data| {
                    _ = std.c.write(self.child.stdin.?.handle, data.ptr, data.len);
                }
            }
        }
        self.child.stdin.?.close(self.native.io);
        self.child.stdin = null;
        // Brief stdin-close grace, then fence only this invocation's group. Keep
        // the child unreaped until signalling so its process/group ID cannot be reused.
        var none: [0]std.posix.pollfd = .{};
        _ = std.posix.poll(&none, 100) catch 0;
        std.posix.kill(-self.child.id.?, std.posix.SIG.KILL) catch {};
        self.child.kill(self.native.io);
        self.input.deinit();
    }
    fn check(self: *Session, deadline: i64) !void {
        if (self.cancelled.load(.acquire)) return error.Cancelled;
        if (now(self.native.io) >= @min(deadline, self.end)) return error.McpTimeout;
    }
    fn pump(self: *Session, deadline: i64) !void {
        try self.check(deadline);
        var polls = [_]std.posix.pollfd{ .{ .fd = self.child.stdout.?.handle, .events = std.posix.POLL.IN, .revents = 0 }, .{ .fd = self.child.stderr.?.handle, .events = std.posix.POLL.IN, .revents = 0 } };
        _ = try std.posix.poll(&polls, 10);
        for (polls, 0..) |p, i| {
            var buf: [8192]u8 = undefined;
            const n = std.posix.read(p.fd, &buf) catch |e| switch (e) {
                error.WouldBlock => continue,
                else => return e,
            };
            if (n == 0) {
                if (i == 0 and std.mem.indexOfScalar(u8, self.input.items, '\n') == null) return error.McpClosed;
                continue;
            }
            if (i == 0) {
                if (self.input.items.len + n > 256 * 1024) return error.McpOversize;
                try self.input.appendSlice(buf[0..n]);
            } else {
                self.stderr_bytes += n;
                if (self.stderr_bytes > 1024 * 1024) return error.McpDiagnosticsFlood;
            }
        }
    }
    fn send(self: *Session, value: anytype, deadline: i64) !void {
        const bytes = try std.json.Stringify.valueAlloc(self.a, value, .{});
        defer self.a.free(bytes);
        if (bytes.len > 256 * 1024) return error.McpOversize;
        const line = try std.mem.concat(self.a, u8, &.{ bytes, "\n" });
        defer self.a.free(line);
        var at: usize = 0;
        while (at < line.len) {
            try self.check(deadline);
            const n = std.c.write(self.child.stdin.?.handle, line[at..].ptr, line.len - at);
            if (n < 0) switch (std.c.errno(n)) {
                .AGAIN => {
                    try self.pump(deadline);
                    continue;
                },
                .INTR => continue,
                else => return error.McpClosed,
            };
            if (n == 0) return error.McpClosed;
            at += @intCast(n);
        }
    }
    fn readLine(self: *Session, deadline: i64) ![]u8 {
        while (true) {
            try self.check(deadline);
            if (std.mem.indexOfScalar(u8, self.input.items, '\n')) |end| {
                const bytes = try self.a.dupe(u8, self.input.items[0..end]);
                std.mem.copyForwards(u8, self.input.items, self.input.items[end + 1 ..]);
                self.input.items.len -= end + 1;
                if (bytes.len == 0 or !std.unicode.utf8ValidateSlice(bytes)) return error.McpProtocol;
                return bytes;
            }
            try self.pump(deadline);
        }
    }
    fn notification(self: *Session, v: V, bytes: usize, deadline: i64) !bool {
        if (v != .object or !eq(get(v, "jsonrpc"), "2.0")) return error.McpProtocol;
        const method = v.object.get("method") orelse return false;
        self.messages += 1;
        self.notification_bytes += bytes;
        if (self.messages > 64 or self.notification_bytes > 1024 * 1024 or !schema.boundedJson(v) or method != .string or !allowed(v, &.{ "jsonrpc", "id", "method", "params" })) return error.McpProtocol;
        if (v.object.get("id")) |server_id| {
            if (server_id != .string and server_id != .integer) return error.McpProtocol;
            if (eq(method, "ping")) try self.send(.{ .jsonrpc = "2.0", .id = server_id, .result = wire.NativeArguments{} }, deadline) else try self.send(.{ .jsonrpc = "2.0", .id = server_id, .@"error" = .{ .code = @as(i32, -32601), .message = "Unsupported client method" } }, deadline);
        } else if (eq(method, "notifications/tools/list_changed")) {
            self.stale = true;
            return error.McpCatalogChanged;
        } else if (!eq(method, "notifications/progress")) return error.McpProtocol;
        return true;
    }
    fn drain(self: *Session, deadline: i64) !void {
        while (self.input.items.len != 0) {
            const bytes = try self.readLine(deadline);
            defer self.a.free(bytes);
            const p = try std.json.parseFromSlice(V, self.a, bytes, .{});
            defer p.deinit();
            if (!try self.notification(p.value, bytes.len, deadline)) return error.McpProtocol;
        }
    }
    fn response(self: *Session, id: []const u8, deadline: i64) ![]u8 {
        while (true) {
            const bytes = try self.readLine(deadline);
            const p = try std.json.parseFromSlice(V, self.a, bytes, .{});
            defer p.deinit();
            const v = p.value;
            if (try self.notification(v, bytes.len, deadline)) {
                self.a.free(bytes);
                continue;
            }
            if (!allowed(v, &.{ "jsonrpc", "id", "result", "error" }) or !eq(get(v, "id"), id) or v.object.contains("result") == v.object.contains("error")) return error.McpProtocol;
            return bytes;
        }
    }
    fn initialize(self: *Session) !void {
        const deadline = now(self.native.io) + 3000;
        try self.send(.{ .jsonrpc = "2.0", .id = "initialize", .method = "initialize", .params = .{ .protocolVersion = "2025-06-18", .capabilities = wire.NativeArguments{}, .clientInfo = .{ .name = "deck", .version = "1" } } }, deadline);
        const bytes = try self.response("initialize", deadline);
        defer self.a.free(bytes);
        const p = try std.json.parseFromSlice(V, self.a, bytes, .{});
        defer p.deinit();
        const result = get(p.value, "result");
        const info = get(result, "serverInfo");
        const tools = get(get(result, "capabilities"), "tools");
        if (!eq(get(result, "protocolVersion"), "2025-06-18") or tools != .object or get(info, "name") != .string or get(info, "version") != .string) return error.UnsupportedMcpServer;
        if (get(info, "name").string.len == 0 or get(info, "name").string.len > 256 or get(info, "version").string.len == 0 or get(info, "version").string.len > 256) return error.UnsupportedMcpServer;
        if (tools.object.get("listChanged")) |flag| if (flag != .bool) return error.UnsupportedMcpServer;
        try self.send(.{ .jsonrpc = "2.0", .method = "notifications/initialized" }, deadline);
    }
    fn catalog(self: *Session, profile: wire.McpPrivateProfile) !void {
        const deadline = now(self.native.io) + 5000;
        var cursor: ?[]const u8 = null;
        var names = std.StringHashMap(void).init(self.a);
        defer names.deinit();
        var cursors = std.StringHashMap(void).init(self.a);
        defer cursors.deinit();
        var matched: usize = 0;
        var total: usize = 0;
        for (0..16) |page| {
            const id = try std.fmt.allocPrint(self.a, "catalog:{d}", .{page});
            if (cursor) |c| try self.send(.{ .jsonrpc = "2.0", .id = id, .method = "tools/list", .params = .{ .cursor = c } }, deadline) else try self.send(.{ .jsonrpc = "2.0", .id = id, .method = "tools/list", .params = wire.NativeArguments{} }, deadline);
            const bytes = try self.response(id, deadline);
            total += bytes.len;
            if (total > 1024 * 1024) return error.McpOversize;
            const p = try std.json.parseFromSlice(V, self.a, bytes, .{});
            const result = get(p.value, "result");
            const tools = get(result, "tools");
            if (tools != .array or tools.array.items.len > 64) return error.McpProtocol;
            for (tools.array.items) |tool| {
                const name = get(tool, "name");
                if (!wire.validMcpToolName(name) or names.contains(name.string) or names.count() >= 256) return error.McpProtocol;
                try names.put(name.string, {});
                for (profile.tools) |approved| if (std.mem.eql(u8, name.string, approved.name)) {
                    const input = try schema.parse(self.a, approved.inputSchema);
                    if (!schema.equal(input.value, get(tool, "inputSchema"))) return error.McpSchemaChanged;
                    if (approved.outputSchema) |output| {
                        const expected = try schema.parse(self.a, output);
                        if (!schema.equal(expected.value, get(tool, "outputSchema"))) return error.McpSchemaChanged;
                    } else if (tool.object.contains("outputSchema")) return error.McpSchemaChanged;
                    matched += 1;
                };
            }
            if (result.object.get("nextCursor")) |next| {
                if (next != .string or next.string.len == 0 or next.string.len > 256 or cursors.contains(next.string)) return error.McpProtocol;
                try cursors.put(next.string, {});
                cursor = next.string;
            } else {
                if (matched != profile.tools.len) return error.McpSchemaChanged;
                // Already-buffered trailing notifications must be processed before dispatch.
                try self.drain(deadline);
                return;
            }
        }
        return error.McpOversize;
    }
};
pub fn invoke(native: Native, a: std.mem.Allocator, profile: wire.McpPrivateProfile, tool: wire.McpTool, request: wire.NativeRequest, plan: wire.McpCallPlan, cancelled: *std.atomic.Value(bool), stale: *bool) Result {
    var session = Session.init(native, a, profile, request.cwd, cancelled) catch return .{ .ok = false, .code = "mcp_unavailable", .output = "MCP launch/configuration unavailable; tool not dispatched" };
    defer {
        if (session.stale) stale.* = true;
        session.deinit();
    }
    session.initialize() catch return .{ .ok = false, .code = "mcp_unavailable", .output = "MCP initialization refused; tool not dispatched" };
    session.catalog(profile) catch |err| {
        if (err == error.McpSchemaChanged or err == error.McpCatalogChanged) stale.* = true;
        return .{ .ok = false, .code = "mcp_catalog_changed", .output = "MCP catalog unavailable or changed; explicit review required; tool not dispatched" };
    };
    return call(&session, tool, request, plan) catch |err| {
        if (err == error.McpSchemaChanged) stale.* = true;
        return .{ .ok = false, .code = "effect_uncertain", .output = "effect_uncertain: MCP call interrupted or invalid response; not replayed" };
    };
}
const Arguments = struct {
    bytes: []const u8,
    pub fn jsonStringify(self: @This(), j: *std.json.Stringify) !void {
        try j.print("{s}", .{self.bytes});
    }
};
fn call(s: *Session, tool: wire.McpTool, request: wire.NativeRequest, plan: wire.McpCallPlan) !Result {
    const args = try std.json.parseFromSlice(V, s.a, plan.argumentsJSON, .{});
    if (args.value != .object or !schema.boundedJson(args.value) or plan.argumentsJSON.len > 32768 or std.mem.indexOfAny(u8, plan.argumentsJSON, "\r\n") != null) return error.McpProtocol;
    const id = try std.fmt.allocPrint(s.a, "call:{s}", .{request.id});
    s.call_id = id;
    const deadline = now(s.native.io) + 20000;
    try s.send(.{ .jsonrpc = "2.0", .id = id, .method = "tools/call", .params = .{ .name = tool.name, .arguments = Arguments{ .bytes = plan.argumentsJSON } } }, deadline);
    const bytes = try s.response(id, deadline);
    if (bytes.len > 65536) return error.McpOversize;
    const parsed = try std.json.parseFromSlice(V, s.a, bytes, .{});
    const v = parsed.value;
    if (!validRpcReply(v, id)) return error.McpProtocol;
    // Drain bounded notifications, but never let a duplicate/foreign response complete this call.
    try s.drain(deadline);
    if (v.object.contains("error")) {
        s.call_id = null;
        return .{ .ok = false, .code = "mcp_rpc_error", .output = bytes };
    }
    const result = get(v, "result");
    const failed = get(result, "isError") == .bool and get(result, "isError").bool;
    if (!failed) if (tool.outputSchema) |output| {
        const expected = try schema.parse(s.a, output);
        if (!schema.matches(expected.value, get(result, "structuredContent"))) return error.McpSchemaChanged;
    };
    s.call_id = null;
    return .{ .ok = !failed, .code = if (failed) "mcp_tool_error" else "mcp_result", .output = bytes };
}
pub fn probe(native: Native, a: std.mem.Allocator, p: wire.McpPrivateProfile, cwd: []const u8, cancelled: *std.atomic.Value(bool)) !void {
    var session = try Session.init(native, a, p, cwd, cancelled);
    defer session.deinit();
    try session.initialize();
    try session.catalog(p);
}
