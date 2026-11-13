const std = @import("std");
const Native = @import("native.zig");
const profiles = @import("mcp_profiles.zig");
pub fn run(native: Native, args: []const [:0]const u8) !void {
    if (args.len < 3) return error.InvalidArguments;
    const exporting = std.mem.eql(u8, args[0], "export");
    if (!exporting and !std.mem.eql(u8, args[0], "probe")) return error.InvalidArguments;
    var config_path: ?[]const u8 = null;
    var profile_id: ?[]const u8 = null;
    var cwd: ?[]const u8 = null;
    var i: usize = 1;
    while (i < args.len) : (i += 2) {
        if (i + 1 >= args.len) return error.InvalidArguments;
        const dest = if (std.mem.eql(u8, args[i], "--config")) &config_path else if (std.mem.eql(u8, args[i], "--profile")) &profile_id else if (std.mem.eql(u8, args[i], "--workspace")) &cwd else return error.InvalidArguments;
        if (dest.* != null) return error.InvalidArguments;
        dest.* = args[i + 1];
    }
    var config = try profiles.Profiles.load(native, config_path orelse return error.InvalidArguments);
    defer config.deinit();
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    if (exporting) {
        if (profile_id != null or cwd != null) return error.InvalidArguments;
        const public = try std.json.Stringify.valueAlloc(a, config.public, .{});
        if (public.len > 256 * 1024) return error.McpCatalogTooLarge;
        try std.Io.File.stdout().writeStreamingAll(native.io, public);
        try std.Io.File.stdout().writeStreamingAll(native.io, "\n");
    } else {
        const id = profile_id orelse return error.InvalidArguments;
        const profile = blk: {
            for (config.config.profiles) |p| if (std.mem.eql(u8, p.id, id)) break :blk p;
            return error.UnknownMcpProfile;
        };
        const workspace = cwd orelse if (std.mem.eql(u8, profile.cwd, "$TASK")) return error.ExplicitWorkspaceRequired else profile.cwd;
        if (!profiles.absolute(workspace)) return error.InvalidArguments;
        var cancelled = std.atomic.Value(bool).init(false);
        try @import("mcp_stdio.zig").probe(native, a, profile, workspace, &cancelled);
        try std.Io.File.stdout().writeStreamingAll(native.io, "Approved MCP schemas matched. No tools/call sent; server startup itself may have effects.\n");
    }
}
