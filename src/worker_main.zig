//! Standalone native worker CLI. No hub, renderer, Node runtime or Pi store.
const std = @import("std");
pub fn main(init: std.process.Init) void {
    const args = init.minimal.args.toSlice(init.arena.allocator()) catch std.process.exit(1);
    if (args.len > 1 and std.mem.eql(u8, args[1], "mcp")) {
        @import("mcp_cli.zig").run(.{ .io = init.io, .environ = init.minimal.environ }, args[2..]) catch |err| {
            std.debug.print("deck: MCP diagnostic refused ({s})\n", .{@errorName(err)});
            std.process.exit(1);
        };
        return;
    }
    @import("remote_worker.zig").run(.{ .io = init.io, .environ = init.minimal.environ }, args[1..]) catch |err| {
        std.debug.print("deck: worker unavailable ({s}); no Pi runtime started\n", .{@errorName(err)});
        std.process.exit(1);
    };
}
