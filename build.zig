const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true, // POSIX descriptor supervision on supported Unix hosts.
    });
    const unicode = b.dependency("uucode", .{
        .target = target,
        .optimize = optimize,
        .fields = @as([]const []const u8, &.{ "east_asian_width", "grapheme_break", "general_category", "is_emoji_presentation" }),
    });
    const terminal = b.dependency("vaxis", .{ .target = target, .optimize = optimize, .external_uucode = true });
    terminal.module("vaxis").addImport("uucode", unicode.module("uucode"));
    module.addImport("vaxis", terminal.module("vaxis"));
    const exe = b.addExecutable(.{ .name = "deck", .root_module = module });
    b.installArtifact(exe);
    b.installDirectory(.{ .source_dir = b.path("licenses"), .install_dir = .prefix, .install_subdir = "share/licenses/deck" });
    const run = b.addRunArtifact(exe);
    run.addPassthruArgs();
    b.step("run", "Run the bootstrap CLI").dependOn(&run.step);
    const tests = b.addTest(.{ .root_module = module });
    const run_tests = b.addRunArtifact(tests);
    b.step("test", "Run Zig tests").dependOn(&run_tests.step);
}
