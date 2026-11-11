//! Standalone native worker CLI. No hub, renderer, Node runtime or Pi store.
const std = @import("std");
pub fn main(init: std.process.Init) void {
    const args = init.minimal.args.toSlice(init.arena.allocator()) catch std.process.exit(1);
    @import("remote_worker.zig").run(.{ .io = init.io, .environ = init.minimal.environ }, args[1..]) catch |err| {
        std.debug.print("deck: worker unavailable ({s}); no Pi runtime started\n", .{@errorName(err)});
        std.process.exit(1);
    };
}
