const std = @import("std");
const Native = @import("native.zig");
const state = @import("state.zig");
const hub = @import("hub.zig");
const worker = @import("worker.zig");
const runtime_paths = @import("runtime_paths.zig");
const tui = @import("tui.zig");
pub const panic = @import("vaxis").Panic;
pub const std_options: std.Options = .{ .log_scope_levels = &.{
    .{ .scope = .vaxis, .level = .err },
    .{ .scope = .vaxis_parser, .level = .err },
} };

const help =
    \\deck — prototype
    \\
    \\Usage:
    \\  deck init [--directory PATH]
    \\  deck backup --output NEW_DIRECTORY [--directory STATE] [--include-credentials]
    \\  deck restore --from BACKUP_DIRECTORY --directory NEW_STATE
    \\  deck serve [--mock] [--model ID] [--port 52800] [--directory PATH]
    \\    [--workers /private/registry.json --tailscale /absolute/path/to/tailscale]
    \\    [--mcp /private/host-profiles.json] [--mcp-catalog /private/catalog.json]
    \\  deck mcp export --config /private/host-profiles.json
    \\  deck mcp probe --config /private/host-profiles.json --profile ID [--workspace ABS]
    \\  deck worker peer|init|identity|run ... (deck worker --help for registration)
    \\  deck login openai [--directory PATH] [--port 52800]
    \\  deck rex open|reopen|status|inspect --task CHAT_ID [--port 52800]
    \\    [--rex /path/to/rex] [--server unix:///path/to/socket] [--host-id UUID] [--instance-id UUID]
    \\  deck serve --stdio --mock [--directory PATH] [--runtime PATH]
    \\  deck hub [--tui | --no-tui] [--port 52800] [--task CHAT_ID] [--message TEXT]
    \\  deck agent [--tui | --no-tui] [--port 52800] [--task CHAT_ID] [--message TEXT]
    \\    TTYs default to the Zig TUI; --message and redirected input use the plain client.
    \\    TUI: i insert, Esc normal, Enter send, Shift-Enter newline, :help, :q detach.
    \\    :sidebar-toggle overrides the responsive sidebar; Ctrl-S also sends.
    \\  deck remote-check --registry /private/registry.json --machine MACHINE_ID
    \\    --tailscale /absolute/path/to/tailscale --peer TAILSCALE_IP:PORT
    \\    Read-only peer/registration diagnostic; does not connect a worker or expose the hub.
    \\  deck --help | --version
    \\
    \\The chat API binds only 127.0.0.1. --stdio selects private framed IPC instead.
    \\--workers enables pinned Tailscale links; Rex/task relay needs explicit worker opt-in.
    \\--workspace PATH sets the initial hub workspace (saved chats keep their binding).
    \\Native read/write/exact-edit/bash tools run as your user, without a sandbox.
    \\MCP uses explicitly approved stdio profiles; --mcp requires --mcp-catalog.
    \\Grant profiles through the trusted-local hub API while idle; no implicit grants.
    \\Probe initializes/lists tools only, but server startup itself may have effects.
    \\The mock provider does not perform inference.
    \\Nix installs the runtime and Node privately. Checkout builds need npm run build.
    \\The plain hub client supports /tasks, /select CHAT_ID, /hub, /task TITLE,
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
    \\Default provider: OPENAI_API_KEY, otherwise stored ChatGPT OAuth.
    \\serve resolves private ~/.config/deck/.env references using op before locking state.
    \\Missing credentials refuse startup; run deck login openai (also works offline).
    \\--api-key is a deprecated alias for default authentication selection.
    \\API-key authentication may incur charges. No failure-driven auth fallback.
    \\Backup requires the writer to be stopped; it never stops or resumes work.
    \\Restore preserves identity/bindings and refuses existing destinations.
    \\Restoring old state can repeat later external effects; reconcile before serving.
    \\Backups exclude credentials unless explicitly requested; treat all as sensitive.
    \\Rex first open defaults to rex on the hub's PATH and its local Unix server.
    \\Target overrides are optional; later opens reuse the saved target. No autostart.
    \\Rex open/reopen is best-effort, ownerless-task-only, with no automatic retry.
    \\Duplicates after races/lost replies need manual cleanup. No GUI focus/attach.
    \\Plain /rex open|reopen|status|inspect uses the selected task and defaults/saved target.
    \\Hub TUI /tasks and /select CHAT_ID inspect read-only; /hub returns to hub.
    \\Hub /task TITLE uses its saved workspace; /task-at JSON selects {machineId,cwd,title}.
    \\Both save creation before requesting Rex; no non-Rex task participation.
    \\TUI /rex shows selected-task status; i inspects, o explicitly opens/reopens.
    \\Rex task clients are allocation-verified and locked to one task.
    \\Direct --task launches are read-only, including plain and one-shot paths.
    \\Remote task clients reuse the verified worker link; no extra login or exposed HTTP.
    \\Approved remote launcher: deck agent --launch-from ABS_WORKER_DIRECTORY [--help].
    \\Launcher list/create/open/inspect is separate from task input and hub authority.
    \\Rex uses worker-local Unix endpoints (API 8/10 only). Jobs/child terminals remain future.
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
    credentials_resolved: bool = false,
    model: []const u8 = "",
    mcp: ?[]const u8 = null,
    mcp_catalog: ?[]const u8 = null,
    workspace: ?[]const u8 = null,
    output: ?[]const u8 = null,
    from: ?[]const u8 = null,
    include_credentials: bool = false,
    workers: ?[]const u8 = null,
    tailscale: ?[]const u8 = null,
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
        } else if (std.mem.eql(u8, arg, "--workers") or std.mem.eql(u8, arg, "--tailscale")) {
            i += 1;
            if (i == args.len or !std.fs.path.isAbsolute(args[i])) return error.InvalidArguments;
            const slot = if (std.mem.eql(u8, arg, "--workers")) &result.workers else &result.tailscale;
            if (slot.* != null) return error.InvalidArguments;
            slot.* = args[i];
        } else if (std.mem.eql(u8, arg, "--mcp") or std.mem.eql(u8, arg, "--mcp-catalog")) {
            i += 1;
            if (i == args.len or !@import("mcp_profiles.zig").absolute(args[i])) return error.InvalidArguments;
            const slot = if (std.mem.eql(u8, arg, "--mcp")) &result.mcp else &result.mcp_catalog;
            if (slot.* != null) return error.InvalidArguments;
            slot.* = args[i];
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
        } else if (std.mem.eql(u8, arg, "--credentials-resolved")) {
            result.credentials_resolved = true;
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
    if ((result.mcp != null or result.mcp_catalog != null) and (!std.mem.eql(u8, result.command, "serve") or (result.mcp != null and result.mcp_catalog == null))) return error.InvalidArguments;
    if (result.credentials_resolved and (!std.mem.eql(u8, result.command, "serve") or result.mock)) return error.InvalidArguments;
    if (result.mock and (result.api_key or result.model.len != 0)) return error.InvalidArguments;
    if ((result.workers == null) != (result.tailscale == null) or (result.workers != null and (!std.mem.eql(u8, result.command, "serve") or result.stdio or result.runtime != null))) return error.InvalidArguments;
    return result;
}

fn run(native: Native, allocator: std.mem.Allocator, options: Options) !void {
    const io = native.io;
    const command = options.command;
    if (std.mem.eql(u8, command, "help") or std.mem.eql(u8, command, "--help")) return std.Io.File.stdout().writeStreamingAll(io, help);
    if (std.mem.eql(u8, command, "--version")) return std.Io.File.stdout().writeStreamingAll(io, "deck 0.1.0-dev\n");
    if (std.mem.eql(u8, command, "backup") or std.mem.eql(u8, command, "restore")) return maintenance(native, allocator, options);
    if (options.output != null or options.from != null or options.include_credentials) return error.InvalidArguments;
    if (!std.mem.eql(u8, command, "init") and !std.mem.eql(u8, command, "serve")) return error.InvalidArguments;
    const path = try state.directory(native, allocator, options.directory);
    defer allocator.free(path);
    if (std.mem.eql(u8, command, "init")) {
        if (options.stdio or options.mock or options.api_key or options.model.len != 0 or options.workspace != null) return error.InvalidArguments;
        try state.initialize(io, allocator, path);
        try std.Io.File.stdout().writeStreamingAll(io, "Deck initialized (existing identity preserved).\n");
        return;
    }
    var dir = try std.Io.Dir.cwd().openDir(io, path, .{});
    defer dir.close(io);
    const held = try state.lock(io, dir);
    defer held.close(io);
    const config = try state.load(io, allocator, dir);
    defer config.deinit();
    const database = try std.fs.path.join(allocator, &.{ path, "session.sqlite" });
    defer allocator.free(database);
    const cwd = if (options.workspace) |workspace| try std.Io.Dir.cwd().realPathFileAlloc(io, workspace, allocator) else try std.process.currentPathAlloc(io, allocator);
    defer allocator.free(cwd);
    var workspace_dir = try std.Io.Dir.cwd().openDir(io, cwd, .{});
    workspace_dir.close(io);
    const runtime = try runtime_paths.entry(native, allocator, options.runtime, "main.js");
    defer allocator.free(runtime);
    const node_path = try runtime_paths.node(native, allocator);
    defer allocator.free(node_path);
    const descriptor = try std.fmt.allocPrint(allocator, "{d}", .{held.handle});
    defer allocator.free(descriptor);
    // Explicit inherit_files below passes the shared flock description only to Pi.
    // The parent's descriptors stay CLOEXEC, including during concurrent tool spawns.
    const requests = try Native.pipe();
    const results = Native.pipe() catch |err| {
        for (requests) |fd| Native.close(fd);
        return err;
    };
    const controls = Native.pipe() catch |err| {
        for (requests) |fd| Native.close(fd);
        for (results) |fd| Native.close(fd);
        return err;
    };
    var child_ends_open = true;
    defer if (child_ends_open) {
        Native.close(requests[1]);
        Native.close(results[0]);
        Native.close(controls[1]);
    };
    var worker_started = false;
    defer if (!worker_started) {
        Native.close(requests[0]);
        Native.close(results[1]);
        Native.close(controls[0]);
    };
    const control_fd = try std.fmt.allocPrint(allocator, "{d}", .{controls[1]});
    defer allocator.free(control_fd);
    const request_fd = try std.fmt.allocPrint(allocator, "{d}", .{requests[1]});
    defer allocator.free(request_fd);
    const result_fd = try std.fmt.allocPrint(allocator, "{d}", .{results[0]});
    defer allocator.free(result_fd);
    const journal = try std.fs.path.join(allocator, &.{ path, "worker", "operations" });
    defer allocator.free(journal);
    try std.Io.Dir.cwd().createDirPath(io, journal);
    const native_executable = try std.process.executablePathAlloc(io, allocator);
    defer allocator.free(native_executable);
    var mcp = if (options.mcp) |path_mcp| try @import("mcp_profiles.zig").Profiles.load(native, path_mcp) else null;
    defer if (mcp) |*p| p.deinit();
    if (mcp) |p| if (!std.mem.eql(u8, p.config.machineId, config.value.machine_id)) return error.McpHostMismatch;
    var remote: ?@import("remote_hub.zig").Hub = if (options.workers) |registry| try @import("remote_hub.zig").Hub.init(native, registry, options.tailscale.?, config.value.machine_id) else null;
    defer if (remote) |*manager| manager.deinit();
    const routes = if (remote) |*manager| try manager.json() else null;
    defer if (routes) |bytes| std.heap.page_allocator.free(bytes);
    var inherited: std.ArrayList(std.Io.File) = .empty;
    defer inherited.deinit(allocator);
    try inherited.appendSlice(allocator, &.{ held, .{ .handle = requests[1], .flags = .{ .nonblocking = false } }, .{ .handle = results[0], .flags = .{ .nonblocking = false } }, .{ .handle = controls[1], .flags = .{ .nonblocking = false } } });
    if (remote) |manager| try inherited.appendSlice(allocator, manager.inherit.items);
    const child_argv = [_][]const u8{ node_path, runtime, database, config.value.machine_id, cwd, descriptor, if (options.mock) "--mock" else "--auto", options.model, result_fd, request_fd, control_fd, native_executable, routes orelse "", options.mcp_catalog orelse "" };
    var child = try std.process.spawn(io, .{
        .argv = if (options.mcp_catalog != null) &child_argv else child_argv[0 .. child_argv.len - 1],
        .stdin = if (options.stdio) .inherit else .pipe,
        .stdout = if (options.stdio) .inherit else .pipe,
        .inherit_files = inherited.items,
    });
    Native.close(requests[1]);
    Native.close(results[0]);
    Native.close(controls[1]);
    child_ends_open = false;
    const thread = std.Thread.spawn(.{}, worker.serveMcp, .{ native, requests[0], results[1], controls[0], journal, config.value.machine_id, if (mcp) |*p| p else null }) catch |err| {
        child.kill(io);
        return err;
    };
    worker_started = true;
    defer thread.join();
    if (remote) |*manager| {
        manager.closeChildEnds();
        manager.start() catch |err| {
            child.kill(io);
            return err;
        };
    }
    if (!options.stdio) {
        defer {
            if (child.stdin) |file| file.close(io);
            child.stdin = null;
            if (child.id != null) _ = child.wait(io) catch {};
            Native.closeStreams(io, &child);
        }
        return hub.serve(io, allocator, &child, options.port);
    }
    const term = try child.wait(io);
    switch (term) {
        .exited => |code| if (code != 0) return error.RuntimeFailed,
        else => return error.RuntimeFailed,
    }
}

fn maintenance(native: Native, allocator: std.mem.Allocator, options: Options) !void {
    const io = native.io;
    const restoring = std.mem.eql(u8, options.command, "restore");
    if (options.stdio or options.mock or options.api_key or options.model.len != 0 or options.workspace != null or options.runtime != null or options.port != 52800) return error.InvalidArguments;
    const artifact = if (restoring) options.from orelse return error.InvalidArguments else options.output orelse return error.InvalidArguments;
    if (restoring) {
        if (options.directory == null or options.output != null or options.include_credentials) return error.InvalidArguments;
    } else if (options.from != null) return error.InvalidArguments;
    const path = try state.directory(native, allocator, options.directory);
    defer allocator.free(path);
    if (restoring) try state.restoreDirectory(io, allocator, artifact, path);
    var dir = try std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true });
    defer dir.close(io);
    const held = try state.lock(io, dir);
    defer held.close(io);
    if (restoring) try state.markRestore(io, dir) else {
        const config = try state.load(io, allocator, dir);
        config.deinit();
    }
    const node_path = try runtime_paths.node(native, allocator);
    defer allocator.free(node_path);
    const entry = try runtime_paths.entry(native, allocator, null, "backup-main.js");
    defer allocator.free(entry);
    const descriptor = try std.fmt.allocPrint(allocator, "{d}", .{held.handle});
    defer allocator.free(descriptor);
    var child = try std.process.spawn(io, .{
        .argv = &.{ node_path, entry, options.command, path, artifact, descriptor, if (options.include_credentials) "include" else "exclude" },
        .stdin = .ignore,
        .inherit_files = &.{held},
    });
    const term = try child.wait(io);
    switch (term) {
        .exited => |code| if (code != 0) return error.BackupFailed,
        else => return error.BackupFailed,
    }
}

fn credentialBootstrap(native: Native, allocator: std.mem.Allocator, args: []const []const u8) !void {
    const node = try runtime_paths.node(native, allocator);
    defer allocator.free(node);
    const entry = try runtime_paths.entry(native, allocator, null, "auth-bootstrap-main.js");
    defer allocator.free(entry);
    const executable = try std.process.executablePathAlloc(native.io, allocator);
    defer allocator.free(executable);
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.appendSlice(allocator, &.{ node, entry, "resolve", executable });
    try argv.appendSlice(allocator, args);
    return std.process.replace(native.io, .{ .argv = argv.items });
}

// Login never opens Pi. Taking the same writer lock decides offline versus
// online; a busy/unreachable hub never authorizes a second credential writer.
fn login(native: Native, allocator: std.mem.Allocator, args: []const []const u8) !void {
    var directory: ?[]const u8 = null;
    var port: []const u8 = "52800";
    var seen_port = false;
    var i: usize = if (args.len > 0 and std.mem.eql(u8, args[0], "openai")) 1 else 0;
    while (i < args.len) : (i += 2) {
        if (i + 1 >= args.len) return error.InvalidArguments;
        if (std.mem.eql(u8, args[i], "--directory") and directory == null) {
            directory = args[i + 1];
        } else if (std.mem.eql(u8, args[i], "--port") and !seen_port) {
            if ((try std.fmt.parseInt(u16, args[i + 1], 10)) == 0) return error.InvalidArguments;
            port = args[i + 1];
            seen_port = true;
        } else return error.InvalidArguments;
    }
    const path = try state.directory(native, allocator, directory);
    defer allocator.free(path);
    var dir = try std.Io.Dir.cwd().openDir(native.io, path, .{});
    defer dir.close(native.io);
    const held: ?std.Io.File = state.lock(native.io, dir) catch |err| switch (err) {
        error.WouldBlock => null,
        else => return err,
    };
    defer if (held) |file| file.close(native.io);
    const config = try state.load(native.io, allocator, dir);
    defer config.deinit();
    const node = try runtime_paths.node(native, allocator);
    defer allocator.free(node);
    const entry = try runtime_paths.entry(native, allocator, null, "login-main.js");
    defer allocator.free(entry);
    const descriptor = try std.fmt.allocPrint(allocator, "{d}", .{if (held) |file| file.handle else -1});
    defer allocator.free(descriptor);
    const inherited: [1]std.Io.File = .{held orelse .{ .handle = -1, .flags = .{ .nonblocking = false } }};
    // Darwin SETEXEC applies CLOEXEC before addinherit_np. Clear it only at
    // this quiescent handoff (no worker/tool threads exist); Node alone keeps
    // the lock, and its subprocess launcher closes non-stdio descriptors.
    if (held) |file| _ = try Native.fcntl(file.handle, std.posix.F.SETFD, 0);
    return std.process.replace(native.io, .{
        .argv = &.{ node, entry, if (held != null) "offline" else "online", path, config.value.machine_id, descriptor, port },
        .inherit_files = if (held != null) &inherited else &.{},
    });
}

fn launchClient(native: Native, allocator: std.mem.Allocator, args: []const []const u8) !std.process.Child.Term {
    const node_path = try runtime_paths.node(native, allocator);
    defer allocator.free(node_path);
    const launcher = args.len > 2 and std.mem.eql(u8, args[1], "agent") and std.mem.eql(u8, args[2], "--launch-from");
    const path = try runtime_paths.entry(native, allocator, null, if (launcher) "launcher-main.js" else "client.js");
    defer allocator.free(path);
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.appendSlice(allocator, &.{ node_path, path });
    if (std.mem.eql(u8, args[1], "login")) try argv.append(allocator, "--login");
    if (std.mem.eql(u8, args[1], "rex")) {
        if (args.len < 3) return error.InvalidArguments;
        try argv.appendSlice(allocator, &.{ "--rex-command", args[2] });
        try argv.appendSlice(allocator, args[3..]);
    } else try argv.appendSlice(allocator, args[2..]);
    var client = try std.process.spawn(native.io, .{ .argv = argv.items });
    return client.wait(native.io);
}

pub fn main(init: std.process.Init) void {
    const allocator = init.gpa;
    const native: Native = .{ .io = init.io, .environ = init.minimal.environ };
    const args = init.minimal.args.toSlice(init.arena.allocator()) catch std.process.exit(1);
    if (args.len > 1 and std.mem.eql(u8, args[1], "login")) {
        login(native, allocator, args[2..]) catch |err| {
            std.debug.print("deck: login unavailable ({s}); check initialized --directory and hub --port\n", .{@errorName(err)});
            std.process.exit(1);
        };
        return;
    }
    if (args.len > 1 and std.mem.eql(u8, args[1], "worker")) {
        @import("remote_worker.zig").run(native, args[2..]) catch |err| {
            std.debug.print("deck: worker unavailable ({s}); no Pi runtime started\n", .{@errorName(err)});
            std.process.exit(1);
        };
        return;
    }
    if (args.len > 1 and std.mem.eql(u8, args[1], "mcp")) {
        @import("mcp_cli.zig").run(native, args[2..]) catch |err| {
            std.debug.print("deck: MCP diagnostic refused ({s})\n", .{@errorName(err)});
            std.process.exit(1);
        };
        return;
    }
    if (args.len > 1 and std.mem.eql(u8, args[1], "remote-check")) {
        @import("remote_check.zig").run(native, allocator, args[2..]) catch |err| {
            std.debug.print("deck: remote peer unconfirmed ({s}); no connection enabled\n", .{@errorName(err)});
            std.process.exit(1);
        };
        return;
    }
    if (args.len > 1 and std.mem.eql(u8, args[1], "hub")) {
        var i: usize = 2;
        while (i < args.len) : (i += 1) {
            const arg = args[i];
            if (std.mem.eql(u8, arg, "--rex-allocation") or std.mem.eql(u8, arg, "--worker-socket")) {
                std.debug.print("deck hub cannot launch an allocation-scoped task client\n", .{});
                std.process.exit(2);
            }
            if (!std.mem.eql(u8, arg, "--tui") and !std.mem.eql(u8, arg, "--no-tui") and !std.mem.eql(u8, arg, "--login")) i += 1;
        }
    }
    const launcher = args.len > 2 and std.mem.eql(u8, args[1], "agent") and std.mem.eql(u8, args[2], "--launch-from");
    if (!launcher and args.len > 1 and (std.mem.eql(u8, args[1], "agent") or std.mem.eql(u8, args[1], "hub"))) {
        const interactive = tui.selected(args[2..], std.c.isatty(0) == 1 and std.c.isatty(1) == 1) catch {
            std.debug.print("--tui cannot be combined with --no-tui or --message\n", .{});
            std.process.exit(2);
        };
        if (interactive) {
            tui.run(init, args[2..]) catch |err| {
                std.debug.print("Deck TUI: {s}; use --no-tui for the plain client\n", .{@errorName(err)});
                std.process.exit(1);
            };
            return;
        }
    }
    if (args.len > 1 and (std.mem.eql(u8, args[1], "agent") or std.mem.eql(u8, args[1], "hub") or std.mem.eql(u8, args[1], "login") or std.mem.eql(u8, args[1], "rex"))) {
        const term = launchClient(native, allocator, args) catch {
            std.Io.File.stderr().writeStreamingAll(init.io, "deck: client runtime unavailable; rebuild or check the installation\n") catch {};
            std.process.exit(1);
        };
        switch (term) {
            .exited => |code| std.process.exit(code),
            else => std.process.exit(1),
        }
    }
    const options = parse(args[1..]) catch {
        std.Io.File.stderr().writeStreamingAll(init.io, "deck: invalid arguments; use --help\n") catch {};
        std.process.exit(2);
    };
    if (std.mem.eql(u8, options.command, "serve") and !options.mock and !options.credentials_resolved) {
        credentialBootstrap(native, allocator, args[1..]) catch {
            std.debug.print("deck: credential bootstrap unavailable; check installation\n", .{});
            std.process.exit(1);
        };
        return;
    }
    run(native, allocator, options) catch |err| {
        const message = switch (err) {
            error.RestoreIncomplete => "deck: incomplete restore; leave it offline and restore into a new directory\n",
            error.PathAlreadyExists => "deck: destination already exists; use a new backup/restore directory\n",
            error.BackupFailed => "deck: backup/restore did not complete; originals were not replaced\n",
            error.WouldBlock => "deck: this state directory already has a running writer\n",
            error.FileNotFound => "deck: missing state, backup or runtime; check paths, init and installation\n",
            error.RuntimeFailed, error.RuntimeClosed, error.InvalidFrame, error.BrokenPipe => "deck: runtime unavailable; hub stopped; inspect pending work before restarting serve\n",
            else => "deck: command failed; check arguments, config and runtime\n",
        };
        std.Io.File.stderr().writeStreamingAll(init.io, message) catch {};
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
    _ = Native;
    _ = runtime_paths;
    _ = state;
    _ = worker;
    _ = hub;
    _ = @import("views.zig");
    _ = @import("status_login.zig");
    _ = @import("rex_open.zig");
    _ = @import("rex_endpoint.zig");
    _ = @import("rex.zig");
    _ = @import("worker_test.zig");
    _ = @import("worker_limits_test.zig");
    _ = @import("shell_test.zig");
    _ = @import("contracts_test.zig");
    _ = @import("phase1_test.zig");
    _ = @import("mcp_test.zig");
    _ = @import("native_contracts_test.zig");
    _ = @import("command_policy_test.zig");
    _ = @import("model_settings.zig");
    _ = tui;
    _ = @import("tui_editor.zig");
    _ = @import("tui_bridge.zig");
    _ = @import("remote_test.zig");
    _ = @import("remote_transport_test.zig");
}
