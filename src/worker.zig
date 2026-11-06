const std = @import("std");
const file_limit = 128 * 1024;
const frame_limit = 1024 * 1024;
const Request = struct { version: u32, id: []const u8, machineId: []const u8, cwd: []const u8, operation: []const u8, args: struct { path: []const u8 = "", content: ?[]const u8 = null, oldText: ?[]const u8 = null, newText: ?[]const u8 = null, command: ?[]const u8 = null, timeout: u32 = 60, target: []const u8 = "", plan: []const u8 = "" } };
const shell = @import("shell.zig");
const rex = @import("rex.zig");
const Result = shell.Result;
const Receipt = struct { hash: []const u8, result: ?Result = null };

fn readExact(file: std.fs.File, bytes: []u8) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const n = try file.read(bytes[offset..]);
        if (n == 0) return error.EndOfStream;
        offset += n;
    }
}
fn save(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8, receipt: Receipt) !void {
    const data = try std.json.Stringify.valueAlloc(allocator, receipt, .{});
    defer allocator.free(data);
    const temporary = try std.fmt.allocPrint(allocator, "{s}.tmp", .{name});
    defer allocator.free(temporary);
    const file = try dir.createFile(temporary, .{ .mode = 0o600 });
    defer file.close();
    try file.writeAll(data);
    try file.sync();
    try dir.rename(temporary, name);
}
fn readText(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const file = std.fs.File{ .handle = try std.posix.open(path, .{ .ACCMODE = .RDONLY, .NONBLOCK = true, .CLOEXEC = true }, 0) };
    defer file.close();
    if ((try file.stat()).kind != .file) return error.NotRegularFile;
    return file.readToEndAlloc(allocator, file_limit);
}
fn execute(allocator: std.mem.Allocator, request: Request) !Result {
    if (!std.fs.path.isAbsolute(request.cwd)) return error.InvalidArguments;
    const path = try std.fs.path.resolve(allocator, &.{ request.cwd, request.args.path });
    defer allocator.free(path);
    if (std.mem.eql(u8, request.operation, "read")) {
        const text = try readText(allocator, path);
        if (!std.unicode.utf8ValidateSlice(text)) return error.InvalidUtf8;
        return .{ .ok = true, .output = text };
    }
    const content = if (std.mem.eql(u8, request.operation, "write")) request.args.content orelse return error.InvalidArguments else blk: {
        if (!std.mem.eql(u8, request.operation, "edit")) return error.InvalidArguments;
        const old = request.args.oldText orelse return error.InvalidArguments;
        const replacement = request.args.newText orelse return error.InvalidArguments;
        if (old.len == 0) return error.InvalidArguments;
        const text = try readText(allocator, path);
        if (!std.unicode.utf8ValidateSlice(text)) return error.InvalidUtf8;
        const start = std.mem.indexOf(u8, text, old) orelse return .{ .ok = false, .output = "Exact edit found no match; file unchanged", .code = "conflict" };
        if (std.mem.indexOfPos(u8, text, start + 1, old) != null) return .{ .ok = false, .output = "Exact edit found multiple matches; file unchanged", .code = "conflict" };
        break :blk try std.mem.concat(allocator, u8, &.{ text[0..start], replacement, text[start + old.len ..] });
    };
    if (content.len > file_limit or !std.unicode.utf8ValidateSlice(content)) return error.InvalidArguments;
    const file = std.fs.File{ .handle = try std.posix.open(path, .{ .ACCMODE = .WRONLY, .CREAT = true, .NONBLOCK = true, .CLOEXEC = true }, 0o666) };
    defer file.close();
    if ((try file.stat()).kind != .file) return error.NotRegularFile;
    try file.setEndPos(0);
    try file.writeAll(content);
    try file.sync();
    return .{ .ok = true, .output = "File updated on assigned worker" };
}

pub fn operation(allocator: std.mem.Allocator, journal: std.fs.Dir, machine_id: []const u8, body: []const u8) ![]const u8 {
    return controlled(allocator, journal, machine_id, body, null, null);
}
fn controlled(allocator: std.mem.Allocator, journal: std.fs.Dir, machine_id: []const u8, body: []const u8, cancelled: ?*std.atomic.Value(bool), progress: ?shell.Progress) ![]const u8 {
    const parsed = try std.json.parseFromSlice(Request, allocator, body, .{});
    defer parsed.deinit();
    const request = parsed.value;
    if (request.version != 1 or request.id.len == 0 or request.id.len > 20) return error.InvalidArguments;
    for (request.id) |byte| if (!std.ascii.isDigit(byte)) return error.InvalidArguments;
    var result: Result = undefined;
    if (!std.mem.eql(u8, machine_id, request.machineId)) {
        result = .{ .ok = false, .output = "offline: assigned worker is not this machine; no local fallback", .code = "offline" };
    } else blk: {
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(body, &digest, .{});
        const hash = std.fmt.bytesToHex(digest, .lower);
        const name = try std.fmt.allocPrint(allocator, "{s}.json", .{request.id});
        const previous = journal.readFileAlloc(allocator, name, frame_limit) catch |err| switch (err) {
            error.FileNotFound => null,
            else => return err,
        };
        if (previous) |bytes| {
            const saved = try std.json.parseFromSlice(Receipt, allocator, bytes, .{});
            if (!std.mem.eql(u8, saved.value.hash, &hash)) {
                result = .{ .ok = false, .output = "Operation ID reused with conflicting arguments", .code = "conflict" };
            } else result = saved.value.result orelse .{ .ok = false, .output = "effect_uncertain: prior worker stopped after acceptance; operation was not repeated", .code = "effect_uncertain" };
            break :blk;
        }
        // Persist acceptance before touching the workspace. An accepted operation without
        // a retained result is uncertain after restart and is never automatically reissued.
        try save(allocator, journal, name, .{ .hash = &hash });
        result = (if (std.mem.eql(u8, request.operation, "bash")) shell.runObserved(allocator, request.cwd, request.args.command orelse "", request.args.timeout, cancelled orelse return error.Unsupported, progress) else if (std.mem.eql(u8, request.operation, "rex_allocate")) rex.allocate(allocator, request.cwd, request.args.plan, cancelled orelse return error.Unsupported) else execute(allocator, request)) catch |err| .{ .ok = false, .output = if (std.mem.eql(u8, request.operation, "read")) @errorName(err) else "effect_uncertain: file operation failed; inspect the file before retrying", .code = if (std.mem.eql(u8, request.operation, "read")) "read_failed" else "effect_uncertain" };
        try save(allocator, journal, name, .{ .hash = &hash, .result = result });
    }
    return std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = request.id, .result = result }, .{});
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
        self.state.mutex.lock();
        defer self.state.mutex.unlock();
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
    mutex: std.Thread.Mutex = .{},
    writes: std.Thread.Mutex = .{},
    jobs: std.Thread.WaitGroup = .{},
    stopping: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    cancelled_ids: [16]u64 = [_]u64{0} ** 16,
    cancel_index: usize = 0,
    journal: std.fs.Dir,
    output: std.fs.File,
    machine_id: []const u8,
    fn send(self: *State, response: []const u8) !void {
        if (response.len > frame_limit) return error.InvalidFrame;
        self.writes.lock();
        defer self.writes.unlock();
        var header: [4]u8 = undefined;
        std.mem.writeInt(u32, &header, @intCast(response.len), .big);
        try self.output.writeAll(&header);
        try self.output.writeAll(response);
    }
    fn cancelAll(self: *State) void {
        self.stopping.store(true, .release);
        self.mutex.lock();
        defer self.mutex.unlock();
        for (&self.slots) |*slot| slot.cancelled.store(true, .release);
    }
};
fn control(state: *State, fd: std.posix.fd_t) void {
    const file = std.fs.File{ .handle = fd };
    defer file.close();
    defer state.cancelAll();
    // Fixed-size cancellation records cannot be blocked by command bodies or output.
    while (!state.stopping.load(.acquire)) {
        var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
        if ((std.posix.poll(&polls, 100) catch return) == 0) continue;
        var bytes: [8]u8 = undefined;
        readExact(file, &bytes) catch return;
        const id = std.mem.readInt(u64, &bytes, .big);
        state.mutex.lock();
        state.cancelled_ids[state.cancel_index] = id;
        state.cancel_index = (state.cancel_index + 1) % state.cancelled_ids.len;
        for (&state.slots) |*slot| if (slot.id == id) {
            slot.cancelled.store(true, .release);
        };
        state.mutex.unlock();
    }
}
fn processJob(state: *State, slot: *Slot, body: []u8) void {
    defer state.jobs.finish();
    defer {
        state.mutex.lock();
        slot.id = 0;
        state.mutex.unlock();
    }
    defer std.heap.page_allocator.free(body);
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var progress = ProgressContext{ .state = state, .slot = slot };
    const response = controlled(allocator, state.journal, state.machine_id, body, &slot.cancelled, .{ .context = &progress, .publish = ProgressContext.publish }) catch blk: {
        const id = std.fmt.allocPrint(allocator, "{d}", .{slot.id}) catch return;
        break :blk std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = id, .result = Result{ .ok = false, .output = "effect_uncertain: worker failed; inspect effects before retrying", .code = "effect_uncertain" } }, .{}) catch return;
    };
    state.send(response) catch {};
}

pub fn serve(read_fd: std.posix.fd_t, write_fd: std.posix.fd_t, control_fd: std.posix.fd_t, journal_path: []const u8, machine_id: []const u8) void {
    const input = std.fs.File{ .handle = read_fd };
    const output = std.fs.File{ .handle = write_fd };
    defer input.close();
    defer output.close();
    var control_owned = true;
    defer if (control_owned) std.posix.close(control_fd);
    var journal = std.fs.cwd().openDir(journal_path, .{}) catch return;
    defer journal.close();
    var state = State{ .journal = journal, .output = output, .machine_id = machine_id };
    const controller = std.Thread.spawn(.{}, control, .{ &state, control_fd }) catch return;
    control_owned = false;
    defer controller.join();
    defer {
        state.cancelAll();
        state.jobs.wait();
    }
    while (true) {
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var header: [4]u8 = undefined;
        readExact(input, &header) catch return;
        const length = std.mem.readInt(u32, &header, .big);
        if (length == 0 or length > frame_limit) return;
        const body = allocator.alloc(u8, length) catch return;
        readExact(input, body) catch return;
        const parsed = std.json.parseFromSlice(Request, allocator, body, .{}) catch return;
        if (std.mem.eql(u8, parsed.value.operation, "bash_progress")) {
            // Read-only ephemeral sampling, not an accepted operation or receipt.
            // Copy under the slot mutex; serialize/write only after releasing it.
            const request = parsed.value;
            if (request.version != 1) return;
            const target = std.fmt.parseInt(u64, request.args.target, 10) catch return;
            var cwd_hash: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(request.cwd, &cwd_hash, .{});
            var tail: [shell.progress_limit]u8 = undefined;
            var used: usize = 0;
            var truncated = false;
            var lossy = false;
            state.mutex.lock();
            if (target != 0 and std.mem.eql(u8, request.machineId, machine_id)) for (&state.slots) |*slot| {
                if (slot.id == target and std.mem.eql(u8, &cwd_hash, &slot.cwd_hash)) {
                    used = slot.used;
                    @memcpy(tail[0..used], slot.tail[0..used]);
                    truncated = slot.truncated;
                    lossy = slot.lossy;
                    break;
                }
            };
            state.mutex.unlock();
            const response = std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = request.id, .progress = .{ .output = tail[0..used], .truncated = truncated, .lossyUtf8 = lossy } }, .{}) catch return;
            state.send(response) catch return;
        } else if (std.mem.eql(u8, parsed.value.operation, "bash") or std.mem.eql(u8, parsed.value.operation, "rex_allocate")) {
            const id = std.fmt.parseInt(u64, parsed.value.id, 10) catch return;
            state.mutex.lock();
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
            state.mutex.unlock();
            if (selected) |slot| {
                const copy = std.heap.page_allocator.dupe(u8, body) catch return;
                state.jobs.start();
                const thread = std.Thread.spawn(.{}, processJob, .{ &state, slot, copy }) catch {
                    state.jobs.finish();
                    std.heap.page_allocator.free(copy);
                    state.mutex.lock();
                    slot.id = 0;
                    state.mutex.unlock();
                    return;
                };
                thread.detach();
            } else {
                const response = std.json.Stringify.valueAlloc(allocator, .{ .version = 1, .id = parsed.value.id, .result = Result{ .ok = false, .output = if (duplicate) "busy: operation already active; original effects may be underway; not repeated" else "busy: native process capacity reached; command not accepted", .code = "busy" } }, .{}) catch return;
                state.send(response) catch return;
            }
        } else {
            const response = operation(allocator, journal, machine_id, body) catch return;
            state.send(response) catch return;
        }
    }
}
