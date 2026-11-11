const std = @import("std");
const Native = @import("native.zig");
const Io = std.Io;
const file_limit = 128 * 1024;
const frame_limit = 1024 * 1024;
const boundary = @import("native_contracts.zig");
const Request = contracts.NativeRequest;
// Historical decoding only, for read-only receipt evidence. Do not tighten old
// request defaults or re-encode the bytes whose hash was retained.
const RetainedRequest = struct { version: u32, id: []const u8, machineId: []const u8, cwd: []const u8, operation: []const u8, args: struct { path: []const u8 = "", content: ?[]const u8 = null, oldText: ?[]const u8 = null, newText: ?[]const u8 = null, command: ?[]const u8 = null, timeout: u32 = 60, target: []const u8 = "", plan: []const u8 = "" } };
const shell = @import("shell.zig");
const rex = @import("rex.zig");
const rex_inspect = @import("rex_inspect.zig");
const rex_resolve = @import("rex_resolve.zig");
const contracts = @import("generated/contracts.zig");
const Result = shell.Result;
const Receipt = struct { hash: []const u8, result: ?Result = null };

fn readExact(file: Io.File, bytes: []u8) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const n = try std.posix.read(file.handle, bytes[offset..]);
        if (n == 0) return error.EndOfStream;
        offset += n;
    }
}
fn save(io: Io, allocator: std.mem.Allocator, dir: Io.Dir, name: []const u8, receipt: Receipt) !void {
    const data = try std.json.Stringify.valueAlloc(allocator, receipt, .{});
    defer allocator.free(data);
    const temporary = try std.fmt.allocPrint(allocator, "{s}.tmp", .{name});
    defer allocator.free(temporary);
    const file = try dir.createFile(io, temporary, .{ .permissions = .fromMode(0o600) });
    defer file.close(io);
    try file.writeStreamingAll(io, data);
    try file.sync(io);
    try dir.rename(temporary, dir, name, io);
}
fn readText(io: Io, allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const file = Io.File{ .handle = try std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY, .NONBLOCK = true, .CLOEXEC = true }, 0), .flags = .{ .nonblocking = true } };
    defer file.close(io);
    if ((try file.stat(io)).kind != .file) return error.NotRegularFile;
    return Native.readAll(io, file, allocator, file_limit);
}
fn execute(io: Io, allocator: std.mem.Allocator, request: Request) !Result {
    if (!std.fs.path.isAbsolute(request.cwd)) return error.InvalidArguments;
    const path = try std.fs.path.resolve(allocator, &.{ request.cwd, request.args.path.? });
    defer allocator.free(path);
    if (request.operation == .read) {
        const text = try readText(io, allocator, path);
        if (!std.unicode.utf8ValidateSlice(text)) return error.InvalidUtf8;
        return .{ .ok = true, .output = text };
    }
    const content = if (request.operation == .write) request.args.content orelse return error.InvalidArguments else blk: {
        if (request.operation != .edit) return error.InvalidArguments;
        const old = request.args.oldText orelse return error.InvalidArguments;
        const replacement = request.args.newText orelse return error.InvalidArguments;
        if (old.len == 0) return error.InvalidArguments;
        const text = try readText(io, allocator, path);
        if (!std.unicode.utf8ValidateSlice(text)) return error.InvalidUtf8;
        const start = std.mem.indexOf(u8, text, old) orelse return .{ .ok = false, .output = "Exact edit found no match; file unchanged", .code = "conflict" };
        if (std.mem.indexOfPos(u8, text, start + 1, old) != null) return .{ .ok = false, .output = "Exact edit found multiple matches; file unchanged", .code = "conflict" };
        break :blk try std.mem.concat(allocator, u8, &.{ text[0..start], replacement, text[start + old.len ..] });
    };
    if (content.len > file_limit or !std.unicode.utf8ValidateSlice(content)) return error.InvalidArguments;
    const file = Io.File{ .handle = try std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .WRONLY, .CREAT = true, .NONBLOCK = true, .CLOEXEC = true }, 0o666), .flags = .{ .nonblocking = true } };
    defer file.close(io);
    if ((try file.stat(io)).kind != .file) return error.NotRegularFile;
    try file.setLength(io, 0);
    try file.writeStreamingAll(io, content);
    try file.sync(io);
    return .{ .ok = true, .output = "File updated on assigned worker" };
}

pub fn operation(native: Native, allocator: std.mem.Allocator, journal: Io.Dir, machine_id: []const u8, body: []const u8) ![]const u8 {
    return controlled(native, allocator, journal, machine_id, body, null, null);
}
fn controlled(native: Native, allocator: std.mem.Allocator, journal: Io.Dir, machine_id: []const u8, body: []const u8, cancelled: ?*std.atomic.Value(bool), progress: ?shell.Progress) ![]const u8 {
    const io = native.io;
    const parsed = try boundary.parseRequest(allocator, body);
    defer parsed.deinit();
    const request = parsed.value;
    if (request.operation == .bash_progress) return error.InvalidArguments;
    var result: Result = undefined;
    if (!std.mem.eql(u8, machine_id, request.machineId)) {
        result = .{ .ok = false, .output = "offline: assigned worker is not this machine; no local fallback", .code = "offline" };
    } else if (request.operation == .rex_allocation_receipt) {
        // Historical evidence only: never accept/dispatch the embedded request or
        // publish a receipt under either the lookup ID or original allocation ID.
        result = allocationReceipt(io, allocator, journal, machine_id, request.cwd, request.args.plan.?) catch .{ .ok = false, .code = "receipt_unavailable", .output = "Receipt inconclusive" };
    } else if (request.operation == .rex_resolve) {
        result = rex_resolve.resolve(native, allocator, request.cwd, request.args.plan.?, cancelled orelse return error.Unsupported) catch .{ .ok = false, .code = "rex_unavailable", .output = "Rex target unavailable" };
    } else if (request.operation == .rex_inspect) {
        // Ephemeral read namespace, disjoint from Pi's safe-integer task IDs.
        // Never consult/publish acceptance or result receipts for fresh inspection.
        result = rex_inspect.inspect(native, allocator, request.cwd, request.args.plan.?, cancelled orelse return error.Unsupported) catch .{ .ok = false, .code = "inspection_failed", .output = "Inspection inconclusive" };
    } else blk: {
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(body, &digest, .{});
        const hash = std.fmt.bytesToHex(digest, .lower);
        const name = try std.fmt.allocPrint(allocator, "{s}.json", .{request.id});
        const previous = journal.readFileAlloc(io, name, allocator, .limited(frame_limit)) catch |err| switch (err) {
            error.FileNotFound => null,
            else => return err,
        };
        if (previous) |bytes| {
            const checked = try contracts.parseNativeReceipt(allocator, bytes);
            checked.deinit();
            const saved = try std.json.parseFromSlice(Receipt, allocator, bytes, .{});
            if (!std.mem.eql(u8, saved.value.hash, &hash)) {
                result = .{ .ok = false, .output = "Operation ID reused with conflicting arguments", .code = "conflict" };
            } else result = saved.value.result orelse .{ .ok = false, .output = "effect_uncertain: prior worker stopped after acceptance; operation was not repeated", .code = "effect_uncertain" };
            break :blk;
        }
        // Persist acceptance before touching the workspace. An accepted operation without
        // a retained result is uncertain after restart and is never automatically reissued.
        try save(io, allocator, journal, name, .{ .hash = &hash });
        result = (if (request.operation == .bash) shell.runObserved(native, allocator, request.cwd, request.args.command.?, @intCast(request.args.timeout orelse 60), cancelled orelse return error.Unsupported, progress) else if (request.operation == .rex_allocate) rex.allocate(native, allocator, request.cwd, request.args.plan.?, cancelled orelse return error.Unsupported) else execute(io, allocator, request)) catch |err| .{ .ok = false, .output = if (request.operation == .read) @errorName(err) else "effect_uncertain: file operation failed; inspect the file before retrying", .code = if (request.operation == .read) "read_failed" else "effect_uncertain" };
        const checked = try resultFrame(allocator, request, result);
        allocator.free(checked);
        try save(io, allocator, journal, name, .{ .hash = &hash, .result = result });
    }
    return resultFrame(allocator, request, result);
}

fn resultFrame(allocator: std.mem.Allocator, request: Request, result: Result) ![]const u8 {
    const body = try std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = request.id, .result = result }, .{});
    errdefer allocator.free(body);
    try boundary.checkReply(allocator, request, body);
    return body;
}

fn receiptProjection(allocator: std.mem.Allocator, query: contracts.RexAllocationReceiptQuery, hash: []const u8, state: contracts.RexAllocationReceiptState, creation: ?contracts.RexCreation) !Result {
    const projection: contracts.RexAllocationReceipt = .{ .version = 1, .operationId = query.operationId, .requestHash = hash, .state = state, .creation = creation };
    const output = try std.json.Stringify.valueAlloc(allocator, projection, .{});
    if (output.len > 16 * 1024) return error.InvalidArguments;
    const checked = try contracts.parseRexAllocationReceipt(allocator, output);
    checked.deinit();
    return .{ .ok = true, .code = "rex_receipt", .output = output };
}
fn allocationReceipt(io: Io, allocator: std.mem.Allocator, journal: Io.Dir, machine_id: []const u8, cwd: []const u8, encoded: []const u8) !Result {
    if (encoded.len > 256 * 1024) return error.InvalidArguments;
    const parsed = try contracts.parseRexAllocationReceiptQuery(allocator, encoded);
    defer parsed.deinit();
    const query = parsed.value;
    if (query.request.len > 128 * 1024) return error.InvalidArguments;
    const original = try std.json.parseFromSlice(RetainedRequest, allocator, query.request, .{});
    defer original.deinit();
    const request = original.value;
    if (request.version != 1 or !std.mem.eql(u8, request.id, query.operationId) or (try std.fmt.parseInt(u64, request.id, 10)) > 9007199254740991 or !std.mem.eql(u8, request.machineId, machine_id) or !std.mem.eql(u8, request.cwd, cwd) or !std.fs.path.isAbsolute(cwd) or !std.mem.eql(u8, request.operation, "rex_allocate")) return error.InvalidArguments;
    const plan = try contracts.parseRexAllocationPlan(allocator, request.args.plan);
    plan.deinit();
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(query.request, &digest, .{});
    const hash = std.fmt.bytesToHex(digest, .lower);
    const name = try std.fmt.allocPrint(allocator, "{s}.json", .{query.operationId});
    defer allocator.free(name);
    const fd = std.posix.openat(journal.handle, name, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NONBLOCK = true, .NOFOLLOW = true }, 0) catch |err| return receiptProjection(allocator, query, &hash, if (err == error.FileNotFound) .missing else .inconclusive, null);
    const file = Io.File{ .handle = fd, .flags = .{ .nonblocking = true } };
    defer file.close(io);
    const stat = try file.stat(io);
    if (stat.kind != .file or stat.size > frame_limit) return receiptProjection(allocator, query, &hash, .inconclusive, null);
    const bytes = try Native.readAll(io, file, allocator, frame_limit);
    defer allocator.free(bytes);
    const checked = std.json.parseFromSlice(std.json.Value, allocator, bytes, .{}) catch return receiptProjection(allocator, query, &hash, .inconclusive, null);
    defer checked.deinit();
    if (!contracts.validNativeReceipt(checked.value)) return receiptProjection(allocator, query, &hash, .inconclusive, null);
    if (checked.value.object.get("result")) |saved_result| {
        if (saved_result != .null and !boundary.validResult(.rex_allocate, saved_result)) return receiptProjection(allocator, query, &hash, .inconclusive, null);
    }
    const receipt = std.json.parseFromSlice(Receipt, allocator, bytes, .{}) catch return receiptProjection(allocator, query, &hash, .inconclusive, null);
    defer receipt.deinit();
    if (!std.mem.eql(u8, receipt.value.hash, &hash)) return receiptProjection(allocator, query, &hash, .conflict, null);
    const result = receipt.value.result orelse return receiptProjection(allocator, query, &hash, .accepted, null);
    if (!result.ok) {
        const code = result.code;
        const refused = std.mem.eql(u8, code, "invalid") or std.mem.eql(u8, code, "offline") or std.mem.eql(u8, code, "cancelled") or std.mem.eql(u8, code, "server_unavailable");
        return receiptProjection(allocator, query, &hash, if (refused) .not_allocated else .inconclusive, null);
    }
    if (!std.mem.eql(u8, result.code, "allocated") or result.truncated or result.output.len > 16 * 1024) return receiptProjection(allocator, query, &hash, .inconclusive, null);
    const creation = contracts.parseRexCreation(allocator, result.output) catch return receiptProjection(allocator, query, &hash, .inconclusive, null);
    defer creation.deinit();
    return receiptProjection(allocator, query, &hash, .allocated, creation.value);
}

const Slot = struct {
    id: u64 = 0,
    cancelled: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    cwd_hash: [32]u8 = undefined,
    tail: [shell.progress_limit]u8 = undefined,
    used: usize = 0,
    truncated: bool = false,
    lossy: bool = false,
};
const ProgressContext = struct {
    state: *State,
    slot: *Slot,
    fn publish(raw: *anyopaque, bytes: []const u8, truncated: bool) void {
        const self: *@This() = @ptrCast(@alignCast(raw));
        // No pipe/disk I/O under this mutex: draining and cancellation never wait
        // for a progress reader. Only the latest bounded sample lives here.
        self.state.mutex.lockUncancelable(self.state.native.io);
        defer self.state.mutex.unlock(self.state.native.io);
        const slot = self.slot;
        @memcpy(slot.tail[0..bytes.len], bytes);
        slot.used = bytes.len;
        slot.truncated = truncated;
        slot.lossy = !std.unicode.utf8ValidateSlice(bytes);
        if (slot.lossy) for (slot.tail[0..slot.used]) |*byte| {
            if (byte.* >= 128) byte.* = '?';
        };
    }
};
const State = struct {
    slots: [4]Slot = .{ .{}, .{}, .{}, .{} },
    native: Native,
    mutex: Io.Mutex = .init,
    writes: Io.Mutex = .init,
    jobs: Native.WaitGroup = .{},
    stopping: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    cancelled_ids: [16]u64 = @splat(0),
    cancel_index: usize = 0,
    journal: Io.Dir,
    output: Io.File,
    machine_id: []const u8,
    network: bool = false,
    fn send(self: *State, response: []const u8) !void {
        errdefer if (self.network) {
            @import("remote_io.zig").shutdown(self.output.handle);
            self.cancelAll();
        };
        if (response.len > frame_limit) return error.InvalidFrame;
        const checked = try contracts.parseNativeResponse(std.heap.page_allocator, response);
        defer checked.deinit();
        if ((checked.value.result == null) == (checked.value.progress == null)) return error.InvalidFrame;
        const io = self.native.io;
        self.writes.lockUncancelable(io);
        defer self.writes.unlock(io);
        var header: [4]u8 = undefined;
        std.mem.writeInt(u32, &header, @intCast(response.len), .big);
        if (self.network) {
            const tcp = @import("remote_io.zig");
            const deadline = tcp.now(io) + 5000;
            try tcp.writeUntil(io, self.output.handle, &header, deadline);
            try tcp.writeUntil(io, self.output.handle, response, deadline);
        } else {
            try self.output.writeStreamingAll(io, &header);
            try self.output.writeStreamingAll(io, response);
        }
    }
    fn cancelAll(self: *State) void {
        self.stopping.store(true, .release);
        self.mutex.lockUncancelable(self.native.io);
        defer self.mutex.unlock(self.native.io);
        for (&self.slots) |*slot| slot.cancelled.store(true, .release);
    }
};
fn control(state: *State, fd: std.posix.fd_t) void {
    const io = state.native.io;
    const file = Io.File{ .handle = fd, .flags = .{ .nonblocking = false } };
    defer file.close(io);
    defer state.cancelAll();
    // Fixed-size cancellation records cannot be blocked by command bodies or output.
    while (!state.stopping.load(.acquire)) {
        var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
        if ((std.posix.poll(&polls, 100) catch return) == 0) continue;
        var bytes: [8]u8 = undefined;
        readExact(file, &bytes) catch return;
        const id = std.mem.readInt(u64, &bytes, .big);
        if (!boundary.validCancellationId(id)) return;
        state.mutex.lockUncancelable(io);
        state.cancelled_ids[state.cancel_index] = id;
        state.cancel_index = (state.cancel_index + 1) % state.cancelled_ids.len;
        for (&state.slots) |*slot| if (slot.id == id) {
            slot.cancelled.store(true, .release);
        };
        state.mutex.unlock(io);
    }
}
fn processJob(state: *State, slot: *Slot, body: []u8) void {
    const io = state.native.io;
    defer state.jobs.finish(io);
    defer {
        state.mutex.lockUncancelable(io);
        slot.id = 0;
        state.mutex.unlock(io);
    }
    defer std.heap.page_allocator.free(body);
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var progress = ProgressContext{ .state = state, .slot = slot };
    const response = controlled(state.native, allocator, state.journal, state.machine_id, body, &slot.cancelled, .{ .context = &progress, .publish = ProgressContext.publish }) catch blk: {
        const id = std.fmt.allocPrint(allocator, "{d}", .{slot.id}) catch return;
        break :blk std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = id, .result = Result{ .ok = false, .output = if (slot.id >= (@as(u64, 1) << 63)) "Inspection inconclusive" else "effect_uncertain: worker failed; inspect effects before retrying", .code = if (slot.id >= (@as(u64, 1) << 63)) "inspection_failed" else "effect_uncertain" } }, .{}) catch return;
    };
    state.send(response) catch {};
}

pub fn serve(native: Native, read_fd: std.posix.fd_t, write_fd: std.posix.fd_t, control_fd: std.posix.fd_t, journal_path: []const u8, machine_id: []const u8) void {
    serveImpl(native, read_fd, write_fd, control_fd, journal_path, machine_id, true);
}
pub fn serveRemote(native: Native, read_fd: std.posix.fd_t, write_fd: std.posix.fd_t, control_fd: std.posix.fd_t, journal_path: []const u8, machine_id: []const u8) void {
    serveImpl(native, read_fd, write_fd, control_fd, journal_path, machine_id, false);
}
fn serveImpl(native: Native, read_fd: std.posix.fd_t, write_fd: std.posix.fd_t, control_fd: std.posix.fd_t, journal_path: []const u8, machine_id: []const u8, allow_rex: bool) void {
    const io = native.io;
    const input = Io.File{ .handle = read_fd, .flags = .{ .nonblocking = false } };
    const output = Io.File{ .handle = write_fd, .flags = .{ .nonblocking = false } };
    defer input.close(io);
    defer output.close(io);
    var control_owned = true;
    defer if (control_owned) Native.close(control_fd);
    var journal = Io.Dir.cwd().openDir(io, journal_path, .{}) catch return;
    defer journal.close(io);
    var state = State{ .native = native, .journal = journal, .output = output, .machine_id = machine_id, .network = !allow_rex };
    const controller = std.Thread.spawn(.{}, control, .{ &state, control_fd }) catch return;
    control_owned = false;
    defer controller.join();
    defer {
        state.cancelAll();
        state.jobs.wait(io);
    }
    while (true) {
        // Cancellation/control EOF must also wake an otherwise idle network reader.
        if (state.stopping.load(.acquire)) return;
        var polls = [_]std.posix.pollfd{.{ .fd = input.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if ((std.posix.poll(&polls, 100) catch return) == 0) continue;
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var header: [4]u8 = undefined;
        const tcp = @import("remote_io.zig");
        const deadline = tcp.now(io) + 5000;
        if (allow_rex) readExact(input, &header) catch return else tcp.readUntil(io, input.handle, &header, deadline) catch return;
        const length = std.mem.readInt(u32, &header, .big);
        if (length == 0 or length > frame_limit) return;
        const body = allocator.alloc(u8, length) catch return;
        if (allow_rex) readExact(input, body) catch return else tcp.readUntil(io, input.handle, body, deadline) catch return;
        // Observed control failure refuses subsequent requests. In-flight file
        // operations still drain; process groups are independently cancelled.
        if (state.stopping.load(.acquire)) return;
        const parsed = boundary.parseRequest(allocator, body) catch return;
        if (!allow_rex and !@import("remote_link.zig").supported(parsed.value.operation)) {
            const response = resultFrame(allocator, parsed.value, .{ .ok = false, .code = "offline", .output = "Remote Rex capability unavailable; no operation accepted" }) catch return;
            state.send(response) catch return;
            continue;
        }
        if (parsed.value.operation == .bash_progress) {
            // Read-only ephemeral sampling, not an accepted operation or receipt.
            // Copy under the slot mutex; serialize/write only after releasing it.
            const request = parsed.value;
            const target = std.fmt.parseInt(u64, request.args.target.?, 10) catch return;
            var cwd_hash: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(request.cwd, &cwd_hash, .{});
            var tail: [shell.progress_limit]u8 = undefined;
            var used: usize = 0;
            var truncated = false;
            var lossy = false;
            state.mutex.lockUncancelable(io);
            if (target != 0 and std.mem.eql(u8, request.machineId, machine_id)) for (&state.slots) |*slot| {
                if (slot.id == target and std.mem.eql(u8, &cwd_hash, &slot.cwd_hash)) {
                    used = slot.used;
                    @memcpy(tail[0..used], slot.tail[0..used]);
                    truncated = slot.truncated;
                    lossy = slot.lossy;
                    break;
                }
            };
            state.mutex.unlock(io);
            const response = std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = request.id, .progress = .{ .output = tail[0..used], .truncated = truncated, .lossyUtf8 = lossy } }, .{}) catch return;
            boundary.checkReply(allocator, request, response) catch return;
            state.send(response) catch return;
        } else if (parsed.value.operation == .bash or parsed.value.operation == .rex_allocate or parsed.value.operation == .rex_inspect or parsed.value.operation == .rex_resolve) {
            const id = std.fmt.parseInt(u64, parsed.value.id, 10) catch return;
            state.mutex.lockUncancelable(io);
            var selected: ?*Slot = null;
            var duplicate = false;
            for (&state.slots) |*slot| if (slot.id == id) {
                duplicate = true;
            };
            if (!duplicate and id != 0) for (&state.slots) |*slot| {
                if (slot.id == 0) {
                    slot.id = id;
                    slot.used = 0;
                    slot.truncated = false;
                    slot.lossy = false;
                    std.crypto.hash.sha2.Sha256.hash(parsed.value.cwd, &slot.cwd_hash, .{});
                    var cancelled = state.stopping.load(.acquire);
                    for (state.cancelled_ids) |prior| {
                        if (prior == id) cancelled = true;
                    }
                    slot.cancelled.store(cancelled, .release);
                    selected = slot;
                    break;
                }
            };
            state.mutex.unlock(io);
            if (selected) |slot| {
                const copy = std.heap.page_allocator.dupe(u8, body) catch return;
                state.jobs.start(io);
                const thread = std.Thread.spawn(.{}, processJob, .{ &state, slot, copy }) catch {
                    state.jobs.finish(io);
                    std.heap.page_allocator.free(copy);
                    state.mutex.lockUncancelable(io);
                    slot.id = 0;
                    state.mutex.unlock(io);
                    return;
                };
                thread.detach();
            } else {
                const response = std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = parsed.value.id, .result = Result{ .ok = false, .output = if (duplicate) "busy: operation already active; original effects may be underway; not repeated" else "busy: native process capacity reached; command not accepted", .code = "busy" } }, .{}) catch return;
                state.send(response) catch return;
            }
        } else {
            const response = operation(native, allocator, journal, machine_id, body) catch return;
            state.send(response) catch return;
        }
    }
}
