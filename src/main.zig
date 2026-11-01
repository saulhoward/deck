const std = @import("std");

const help =
    \\deck — agent harness (bootstrap)
    \\
    \\Usage: deck --help | --version
    \\
    \\Planned: init [--hub URL], serve, agent [--no-tui]
    \\The coordinator, TUI, and worker transport are not implemented yet.
    \\See docs/architecture.md for the proposal.
    \\
;

const Command = enum { help, version, unsupported };

fn parse(arg: ?[]const u8) Command {
    const value = arg orelse return .help;
    if (std.mem.eql(u8, value, "--help") or std.mem.eql(u8, value, "help")) return .help;
    if (std.mem.eql(u8, value, "--version")) return .version;
    return .unsupported;
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    switch (parse(if (args.len > 1) args[1] else null)) {
        .help => try std.fs.File.stdout().writeAll(help),
        .version => try std.fs.File.stdout().writeAll("deck 0.1.0-dev\n"),
        .unsupported => {
            try std.fs.File.stderr().writeAll("deck: command not implemented; use --help\n");
            std.process.exit(2);
        },
    }
}

test "bootstrap commands never pretend to start a service" {
    try std.testing.expectEqual(Command.help, parse(null));
    try std.testing.expectEqual(Command.help, parse("--help"));
    try std.testing.expectEqual(Command.version, parse("--version"));
    try std.testing.expectEqual(Command.unsupported, parse("serve"));
    try std.testing.expectEqual(Command.unsupported, parse("init"));
}
