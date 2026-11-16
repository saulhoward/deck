//! Contact an existing worker through its original client, not by changing its
//! registration. This is client reuse, NOT a worker upgrade/handoff protocol.
const std = @import("std");
const Native = @import("native.zig");
const files = @import("mcp_profiles.zig");
pub const guard = "DECK_WORKER_CLIENT_REUSE";

fn executable(native: Native, allocator: std.mem.Allocator, path: []const u8) !std.Io.File {
    const canonical = try std.Io.Dir.cwd().realPathFileAlloc(native.io, path, allocator);
    defer allocator.free(canonical);
    if (!std.mem.eql(u8, path, canonical)) return error.WorkerClientUnavailable;
    const file = try files.openFile(native, path, false, 256 * 1024 * 1024);
    errdefer file.close(native.io);
    const mode = (try file.stat(native.io)).permissions.toMode();
    if (mode & 0o022 != 0 or mode & 0o111 == 0) return error.WorkerClientUnavailable;
    return file;
}
fn nativeImage(bytes: []const u8) bool {
    if (bytes.len < 4) return false;
    for ([_][]const u8{ "\x7fELF", "\xcf\xfa\xed\xfe", "\xfe\xed\xfa\xcf" }) |magic| if (std.mem.eql(u8, bytes[0..4], magic)) return true;
    return false;
}
// Legacy records pin the native image, not arbitrary shell scripts. Only the
// known full Deck Nix layout supplies an independently packaged old runtime.
fn nixPackage(client: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, client, "/nix/store/") or !std.mem.endsWith(u8, client, "/bin/deck")) return null;
    const package = client[0 .. client.len - "/bin/deck".len];
    const name = package["/nix/store/".len..];
    if (name.len <= 38 or !std.mem.startsWith(u8, name[32..], "-deck-")) return null;
    for (name[0..32]) |byte| if (std.mem.indexOfScalar(u8, "0123456789abcdfghijklmnpqrsvwxyz", byte) == null) return null;
    for (name[33..]) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.indexOfScalar(u8, "+-._", byte) == null) return null;
    return package;
}

fn sameImage(native: Native, allocator: std.mem.Allocator, candidate: std.Io.File, cancelled: *std.atomic.Value(bool)) !void {
    const path = try std.process.executablePathAlloc(native.io, allocator);
    defer allocator.free(path);
    const current = try files.openFile(native, path, false, 256 * 1024 * 1024);
    defer current.close(native.io);
    const size = (try current.stat(native.io)).size;
    if ((try candidate.stat(native.io)).size != size) return error.WorkerClientUnavailable;
    const deadline = @import("remote_io.zig").now(native.io) + 5000;
    var left: [65536]u8 = undefined;
    var right: [65536]u8 = undefined;
    var offset: u64 = 0;
    while (offset < size) {
        if (cancelled.load(.acquire) or @import("remote_io.zig").now(native.io) >= deadline) return error.Cancelled;
        const length: usize = @intCast(@min(left.len, size - offset));
        if (try current.readPositionalAll(native.io, left[0..length], offset) != length or try candidate.readPositionalAll(native.io, right[0..length], offset) != length or !std.mem.eql(u8, left[0..length], right[0..length])) return error.WorkerClientUnavailable;
        offset += length;
    }
}

pub fn verify(native: Native, allocator: std.mem.Allocator, client: []const u8, expected: []const u8, current: []const u8, cancelled: *std.atomic.Value(bool)) !void {
    const entry = try executable(native, allocator, client);
    defer entry.close(native.io);
    var header: [4]u8 = undefined;
    const n = try std.posix.read(entry.handle, &header);
    var image = client;
    defer if (image.ptr != client.ptr) allocator.free(image);
    if (nativeImage(header[0..n])) {
        // Raw development executables have no saved runtime environment. Reuse
        // a relocated identical image only, never pair unknown old native code
        // with the new invocation's DECK_RUNTIME_ROOT/DECK_NODE overrides.
        if (!std.mem.eql(u8, expected, current)) return error.WorkerClientUnavailable;
        // The caller already hashed the current image. Compare every byte,
        // rather than hashing an identical relocated image a second time.
        return sameImage(native, allocator, entry, cancelled);
    } else {
        const package = nixPackage(client) orelse return error.WorkerClientUnavailable;
        image = try std.fs.path.join(allocator, &.{ package, "bin", ".deck-wrapped" });
        const file = try executable(native, allocator, image);
        defer file.close(native.io);
        const image_header = try std.posix.read(file.handle, &header);
        if (!nativeImage(header[0..image_header])) return error.WorkerClientUnavailable;
        // Layout checks, not arbitrary shell attestation: this uses the saved,
        // approved immutable Nix package path and its original packaged runtime.
        const wrapper_file = try files.openFile(native, client, false, 64 * 1024);
        defer wrapper_file.close(native.io);
        const wrapper = try Native.readAll(native.io, wrapper_file, allocator, 64 * 1024);
        defer allocator.free(wrapper);
        const root = try std.fmt.allocPrint(allocator, "export DECK_RUNTIME_ROOT='{s}/libexec/deck'\n", .{package});
        defer allocator.free(root);
        const exec = try std.fmt.allocPrint(allocator, "exec -a \"$0\" \"{s}\"  \"$@\"", .{image});
        defer allocator.free(exec);
        if (!std.mem.startsWith(u8, wrapper, "#! /nix/store/") or std.mem.indexOf(u8, wrapper, root) == null or !std.mem.endsWith(u8, std.mem.trimEnd(u8, wrapper, " \r\n"), exec)) return error.WorkerClientUnavailable;
    }
    try files.verifyPin(native, .{ .path = image, .sha256 = expected }, cancelled, @import("remote_io.zig").now(native.io) + 5000);
}

pub fn replace(native: Native, allocator: std.mem.Allocator, client: []const u8, args: []const []const u8) !void {
    if (native.environ.getPosix(guard) != null) return error.WorkerClientUnavailable;
    var environment = try native.environ.createMap(allocator);
    defer environment.deinit();
    try environment.put(guard, "1");
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.appendSlice(allocator, &.{ client, "agent" });
    try argv.appendSlice(allocator, args);
    try std.Io.File.stderr().writeStreamingAll(native.io, "deck: reusing the existing worker's verified client (including its UI version); no worker upgrade, pin change or effect replay\n");
    // Called only after workerDirectory has released its launcher lock. Replace
    // only this foreground client, preserving cwd, arguments, terminal and exit
    // status. The saved client applies the original exact worker/session guards.
    std.process.replace(native.io, .{ .argv = argv.items, .environ_map = &environment }) catch return error.WorkerClientUnavailable;
}

test "worker client reuse verifies native bytes and refuses mutable aliases and scripts" {
    const native = Native.testing();
    const a = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const source = try std.process.executablePathAlloc(native.io, a);
    defer a.free(source);
    const image = try files.openFile(native, source, false, 256 * 1024 * 1024);
    defer image.close(native.io);
    const data = try Native.readAll(native.io, image, a, 256 * 1024 * 1024);
    defer a.free(data);
    try tmp.dir.writeFile(native.io, .{ .sub_path = "client", .data = data });
    try tmp.dir.setFilePermissions(native.io, "client", .fromMode(0o700), .{});
    const path = try tmp.dir.realPathFileAlloc(native.io, "client", a);
    defer a.free(path);
    const hash = files.hash(data);
    var cancelled = std.atomic.Value(bool).init(false);
    try verify(native, a, path, &hash, &hash, &cancelled);
    cancelled.store(true, .release);
    try std.testing.expectError(error.Cancelled, verify(native, a, path, &hash, &hash, &cancelled));
    cancelled.store(false, .release);
    try tmp.dir.symLink(native.io, "client", "alias", .{});
    const alias = try std.fs.path.join(a, &.{ std.fs.path.dirname(path).?, "alias" });
    defer a.free(alias);
    try std.testing.expectError(error.WorkerClientUnavailable, verify(native, a, alias, &hash, &hash, &cancelled));
    const other: [64]u8 = @splat('a');
    try std.testing.expectError(error.WorkerClientUnavailable, verify(native, a, path, &hash, &other, &cancelled));
    try tmp.dir.writeFile(native.io, .{ .sub_path = "client", .data = "\x7fELFchanged-image" });
    try std.testing.expectError(error.WorkerClientUnavailable, verify(native, a, path, &hash, &hash, &cancelled));
    try tmp.dir.writeFile(native.io, .{ .sub_path = "client", .data = "#!/bin/sh\necho must-not-run\n" });
    try std.testing.expectError(error.WorkerClientUnavailable, verify(native, a, path, &hash, &hash, &cancelled));
    try tmp.dir.writeFile(native.io, .{ .sub_path = "client", .data = data });
    try tmp.dir.setFilePermissions(native.io, "client", .fromMode(0o777), .{});
    try std.testing.expectError(error.WorkerClientUnavailable, verify(native, a, path, &hash, &hash, &cancelled));
}

test "legacy reuse recognizes only canonical full Deck Nix packages" {
    const root = "/nix/store/pfrdiggpjc32wwa5iiiv4gpajnkwk8xw-deck-0.1.0-dev";
    try std.testing.expectEqualStrings(root, nixPackage(root ++ "/bin/deck").?);
    for ([_][]const u8{ "/tmp/deck", root ++ "/bin/deck-worker", root ++ "/../bin/deck", "/nix/store/bad-deck-1/bin/deck", "/nix/store/pfrdiggpjc32wwa5iiiv4gpajnkwk8xw-deck-1\n/bin/deck" }) |path| try std.testing.expect(nixPackage(path) == null);
}
