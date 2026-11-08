const std = @import("std");
const state = @import("state.zig");
const hub = @import("hub.zig");
const worker = @import("worker.zig");
const runtime_paths = @import("runtime_paths.zig");

const help =
    \\deck — local prototype
    \\
    \\Usage:
    \\  deck init [--directory PATH]
    \\  deck backup --output NEW_DIRECTORY [--directory STATE] [--include-credentials]
    \\  deck restore --from BACKUP_DIRECTORY --directory NEW_STATE
    \\  deck serve [--mock | --api-key] [--model ID] [--port 52800] [--directory PATH]
    \\  deck login [--port 52800]
    \\  deck serve --stdio --mock [--directory PATH] [--runtime PATH]
    \\  deck agent --no-tui [--port 52800] [--task CHAT_ID] [--message TEXT]
    \\  deck --help | --version
    \\
    \\serve binds only 127.0.0.1. --stdio selects private framed IPC instead.
    \\--workspace PATH sets the initial main workspace (saved chats keep their binding).
    \\Native read/write/exact-edit/bash tools run as your user, without a sandbox.
    \\The mock provider does not perform inference.
    \\Nix installs the runtime and Node privately. Checkout builds need npm run build.
    \\The plain client supports /tasks, /select CHAT_ID, /main, /task TITLE,
    \\/older, /activity, /stop, /status and /exit.
    \\/instructions load imports saved-worker AGENTS.md only while idle, replacing
    \\explicit instructions. /instructions [TASK_ID] reads source/import status.
    \\Import admission is not application; no automatic project-file loading.
    \\Sampled answer previews are provisional; retained history is authoritative.
    \\Native bash shows sampled provisional output tails; final results are separate.
    \\Drafts save before sending. /draft, /drafts, /recover REQUEST_ID,
    \\/retry and /discard [REQUEST_ID] manage unresolved requests; no auto replay.
    \\Models can inspect existing chats with task_list/task_history/task_activity.
    \\task_create/task_message create ownerless tasks and acknowledge admission only.
    \\These are ownerless: stopping the caller does not stop target work.
    \\subagent waits for a Pi-owned child answer; caller stop drains ordinary owned work.
    \\Owned child chats can be inspected/stopped, but do not accept direct input.
    \\Default provider: OpenAI with ChatGPT OAuth; use deck login after serving.
    \\--api-key explicitly opts into ambient OPENAI_API_KEY (may incur charges).
    \\Backup requires the writer to be stopped; it never stops or resumes work.
    \\Restore preserves identity/bindings and refuses existing destinations.
    \\Restoring old state can repeat later external effects; reconcile before serving.
    \\Backups exclude credentials unless explicitly requested; treat all as sensitive.
    \\Public Rex allocation/reopen, remote workers and TUI are not yet available.
    \\
;

const Options = struct {
    command: []const u8 = "help",
    directory: ?[]const u8 = null,
    runtime: ?[]const u8 = null,
    stdio: bool = false,
    mock: bool = false,
    port: u16 = 52800,
    api_key: bool = false,
    model: []const u8 = "",
    workspace: ?[]const u8 = null,
    output: ?[]const u8 = null,
    from: ?[]const u8 = null,
    include_credentials: bool = false,
};

fn parse(args: []const []const u8) !Options {
    var result: Options = .{};
    if (args.len == 0) return result;
    result.command = args[0];
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--directory") or std.mem.eql(u8, arg, "--runtime")) {
            i += 1;
            if (i == args.len) return error.InvalidArguments;
            if (std.mem.eql(u8, arg, "--directory")) result.directory = args[i] else result.runtime = args[i];
        } else if (std.mem.eql(u8, arg, "--output") or std.mem.eql(u8, arg, "--from")) {
            i += 1;
            if (i == args.len or args[i].len == 0) return error.InvalidArguments;
            if (std.mem.eql(u8, arg, "--output")) result.output = args[i] else result.from = args[i];
        } else if (std.mem.eql(u8, arg, "--include-credentials")) {
            result.include_credentials = true;
        } else if (std.mem.eql(u8, arg, "--workspace")) {
            i += 1;
            if (i == args.len) return error.InvalidArguments;
            result.workspace = args[i];
        } else if (std.mem.eql(u8, arg, "--model")) {
            i += 1;
            if (i == args.len or args[i].len == 0) return error.InvalidArguments;
            result.model = args[i];
        } else if (std.mem.eql(u8, arg, "--api-key")) {
            result.api_key = true;
        } else if (std.mem.eql(u8, arg, "--port")) {
            i += 1;
            if (i == args.len) return error.InvalidArguments;
            result.port = try std.fmt.parseInt(u16, args[i], 10);
            if (result.port == 0) return error.InvalidArguments;
        } else if (std.mem.eql(u8, arg, "--stdio")) {
            result.stdio = true;
        } else if (std.mem.eql(u8, arg, "--mock")) {
            result.mock = true;
        } else return error.InvalidArguments;
    }
    if (result.mock and (result.api_key or result.model.len != 0)) return error.InvalidArguments;
    return result;
}

fn run(allocator: std.mem.Allocator, options: Options) !void {
    const command = options.command;
    if (std.mem.eql(u8, command, "help") or std.mem.eql(u8, command, "--help")) return std.fs.File.stdout().writeAll(help);
    if (std.mem.eql(u8, command, "--version")) return std.fs.File.stdout().writeAll("deck 0.1.0-dev\n");
    if (std.mem.eql(u8, command, "backup") or std.mem.eql(u8, command, "restore")) return maintenance(allocator, options);
    if (options.output != null or options.from != null or options.include_credentials) return error.InvalidArguments;
    if (!std.mem.eql(u8, command, "init") and !std.mem.eql(u8, command, "serve")) return error.InvalidArguments;
    const path = try state.directory(allocator, options.directory);
    defer allocator.free(path);
    if (std.mem.eql(u8, command, "init")) {
        if (options.stdio or options.mock or options.api_key or options.model.len != 0 or options.workspace != null) return error.InvalidArguments;
        try state.initialize(allocator, path);
        try std.fs.File.stdout().writeAll("Deck initialized (existing identity preserved).\n");
        return;
    }
    var dir = try std.fs.cwd().openDir(path, .{});
    defer dir.close();
    const held = try state.lock(dir);
    defer held.close();
    const config = try state.load(allocator, dir);
    defer config.deinit();
    const database = try std.fs.path.join(allocator, &.{ path, "session.sqlite" });
    defer allocator.free(database);
    const cwd = if (options.workspace) |workspace| try std.fs.cwd().realpathAlloc(allocator, workspace) else try std.process.getCwdAlloc(allocator);
    defer allocator.free(cwd);
    var workspace_dir = try std.fs.cwd().openDir(cwd, .{});
    workspace_dir.close();
    const runtime = try runtime_paths.entry(allocator, options.runtime, "main.js");
    defer allocator.free(runtime);
    const node_path = try runtime_paths.node(allocator);
    defer allocator.free(node_path);
    const descriptor = try std.fmt.allocPrint(allocator, "{d}", .{held.handle});
    defer allocator.free(descriptor);
    // flock belongs to the shared open file description. Keeping this descriptor across
    // exec retains the lock even if the Zig supervisor dies before its writer child.
    _ = try std.posix.fcntl(held.handle, std.posix.F.SETFD, 0);
    const requests = try std.posix.pipe2(.{ .CLOEXEC = true });
    const results = std.posix.pipe2(.{ .CLOEXEC = true }) catch |err| {
        std.posix.close(requests[0]);
        std.posix.close(requests[1]);
        return err;
    };
    const controls = std.posix.pipe2(.{ .CLOEXEC = true }) catch |err| {
        for (requests) |fd| std.posix.close(fd);
        for (results) |fd| std.posix.close(fd);
        return err;
    };
    var child_ends_open = true;
    defer if (child_ends_open) {
        std.posix.close(requests[1]);
        std.posix.close(results[0]);
        std.posix.close(controls[1]);
    };
    var worker_started = false;
    defer if (!worker_started) {
        std.posix.close(requests[0]);
        std.posix.close(results[1]);
        std.posix.close(controls[0]);
    };
    _ = try std.posix.fcntl(requests[1], std.posix.F.SETFD, 0);
    _ = try std.posix.fcntl(results[0], std.posix.F.SETFD, 0);
    _ = try std.posix.fcntl(controls[1], std.posix.F.SETFD, 0);
    const control_fd = try std.fmt.allocPrint(allocator, "{d}", .{controls[1]});
    defer allocator.free(control_fd);
    const request_fd = try std.fmt.allocPrint(allocator, "{d}", .{requests[1]});
    defer allocator.free(request_fd);
    const result_fd = try std.fmt.allocPrint(allocator, "{d}", .{results[0]});
    defer allocator.free(result_fd);
    const journal = try std.fs.path.join(allocator, &.{ path, "worker", "operations" });
    defer allocator.free(journal);
    try std.fs.cwd().makePath(journal);
    const native_executable = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(native_executable);
    var child = std.process.Child.init(&.{ node_path, runtime, database, config.value.machine_id, cwd, descriptor, if (options.mock) "--mock" else if (options.api_key) "--api-key" else "--chatgpt", options.model, result_fd, request_fd, control_fd, native_executable }, allocator);
    child.stdin_behavior = if (options.stdio) .Inherit else .Pipe;
    child.stdout_behavior = if (options.stdio) .Inherit else .Pipe;
    child.stderr_behavior = .Inherit;
    try child.spawn();
    // Only the Pi child inherits the writer lock, never shell tool descendants.
    _ = std.posix.fcntl(held.handle, std.posix.F.SETFD, std.posix.FD_CLOEXEC) catch |err| {
        _ = child.kill() catch {};
        return err;
    };
    std.posix.close(requests[1]);
    std.posix.close(results[0]);
    std.posix.close(controls[1]);
    child_ends_open = false;
    const thread = std.Thread.spawn(.{}, worker.serve, .{ requests[0], results[1], controls[0], journal, config.value.machine_id }) catch |err| {
        _ = child.kill() catch {};
        return err;
    };
    worker_started = true;
    defer thread.join();
    if (!options.stdio) {
        defer {
            if (child.stdin) |file| file.close();
            child.stdin = null;
            _ = child.wait() catch {};
        }
        return hub.serve(allocator, &child, options.port);
    }
    const term = try child.wait();
    switch (term) {
        .Exited => |code| if (code != 0) return error.RuntimeFailed,
        else => return error.RuntimeFailed,
    }
}

fn maintenance(allocator: std.mem.Allocator, options: Options) !void {
    const restoring = std.mem.eql(u8, options.command, "restore");
    if (options.stdio or options.mock or options.api_key or options.model.len != 0 or options.workspace != null or options.runtime != null or options.port != 52800) return error.InvalidArguments;
    const artifact = if (restoring) options.from orelse return error.InvalidArguments else options.output orelse return error.InvalidArguments;
    if (restoring) {
        if (options.directory == null or options.output != null or options.include_credentials) return error.InvalidArguments;
    } else if (options.from != null) return error.InvalidArguments;
    const path = try state.directory(allocator, options.directory);
    defer allocator.free(path);
    if (restoring) try state.restoreDirectory(allocator, artifact, path);
    var dir = try std.fs.cwd().openDir(path, .{ .iterate = true });
    defer dir.close();
    const held = try state.lock(dir);
    defer held.close();
    if (restoring) try state.markRestore(dir) else {
        const config = try state.load(allocator, dir);
        config.deinit();
    }
    const node_path = try runtime_paths.node(allocator);
    defer allocator.free(node_path);
    const entry = try runtime_paths.entry(allocator, null, "backup-main.js");
    defer allocator.free(entry);
    const descriptor = try std.fmt.allocPrint(allocator, "{d}", .{held.handle});
    defer allocator.free(descriptor);
    _ = try std.posix.fcntl(held.handle, std.posix.F.SETFD, 0);
    defer _ = std.posix.fcntl(held.handle, std.posix.F.SETFD, std.posix.FD_CLOEXEC) catch {};
    var child = std.process.Child.init(&.{ node_path, entry, options.command, path, artifact, descriptor, if (options.include_credentials) "include" else "exclude" }, allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Inherit;
    child.stderr_behavior = .Inherit;
    const term = try child.spawnAndWait();
    switch (term) {
        .Exited => |code| if (code != 0) return error.BackupFailed,
        else => return error.BackupFailed,
    }
}

fn launchClient(allocator: std.mem.Allocator, args: []const []const u8) !std.process.Child.Term {
    const node_path = try runtime_paths.node(allocator);
    defer allocator.free(node_path);
    const path = try runtime_paths.entry(allocator, null, "client.js");
    defer allocator.free(path);
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.appendSlice(allocator, &.{ node_path, path });
    if (std.mem.eql(u8, args[1], "login")) try argv.append(allocator, "--login");
    try argv.appendSlice(allocator, args[2..]);
    var client = std.process.Child.init(argv.items, allocator);
    return client.spawnAndWait();
}

pub fn main() void {
    const allocator = std.heap.page_allocator;
    const args = std.process.argsAlloc(allocator) catch std.process.exit(1);
    defer std.process.argsFree(allocator, args);
    if (args.len > 1 and (std.mem.eql(u8, args[1], "agent") or std.mem.eql(u8, args[1], "login"))) {
        const term = launchClient(allocator, args) catch {
            std.fs.File.stderr().writeAll("deck: client runtime unavailable; rebuild or check the installation\n") catch {};
            std.process.exit(1);
        };
        switch (term) {
            .Exited => |code| std.process.exit(code),
            else => std.process.exit(1),
        }
    }
    const options = parse(args[1..]) catch {
        std.fs.File.stderr().writeAll("deck: invalid arguments; use --help\n") catch {};
        std.process.exit(2);
    };
    run(allocator, options) catch |err| {
        const message = switch (err) {
            error.RestoreIncomplete => "deck: incomplete restore; leave it offline and restore into a new directory\n",
            error.PathAlreadyExists => "deck: destination already exists; use a new backup/restore directory\n",
            error.BackupFailed => "deck: backup/restore did not complete; originals were not replaced\n",
            error.WouldBlock => "deck: this state directory already has a running writer\n",
            error.FileNotFound => "deck: missing state, backup or runtime; check paths, init and installation\n",
            error.RuntimeFailed, error.RuntimeClosed, error.InvalidFrame, error.BrokenPipe => "deck: runtime unavailable; hub stopped; inspect pending work before restarting serve\n",
            else => "deck: command failed; check arguments, config and runtime\n",
        };
        std.fs.File.stderr().writeAll(message) catch {};
        std.process.exit(1);
    };
}

test "parse explicit prototype flags and reject malformed options" {
    const options = try parse(&.{ "serve", "--stdio", "--mock", "--directory", "/tmp/deck" });
    try std.testing.expect(options.stdio and options.mock);
    try std.testing.expectEqualStrings("/tmp/deck", options.directory.?);
    try std.testing.expectError(error.InvalidArguments, parse(&.{ "init", "--directory" }));
    try std.testing.expectError(error.InvalidArguments, parse(&.{ "serve", "--hub", "http://remote" }));
}

test {
    _ = state;
    _ = worker;
    _ = @import("worker_test.zig");
    _ = @import("worker_limits_test.zig");
    _ = @import("shell_test.zig");
    _ = @import("contracts_test.zig");
}
