const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const schema = @import("mcp_schema.zig");
pub fn absolute(s: []const u8) bool {
    return s.len > 0 and s.len <= 4096 and s[0] == '/' and std.mem.indexOfScalar(u8, s, 0) == null;
}
pub fn hash(bytes: []const u8) [64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}
pub fn toolHash(tool: wire.McpTool) [64]u8 {
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    h.update(tool.inputSchema);
    h.update("\n");
    h.update(tool.outputSchema orelse "");
    return std.fmt.bytesToHex(h.finalResult(), .lower);
}
pub fn openFile(native: Native, path: []const u8, private: bool, max: usize) !std.Io.File {
    if (!absolute(path)) return error.InvalidMcpPath;
    const fd = try std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NOFOLLOW = true, .NONBLOCK = true }, 0);
    const file: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = true } };
    errdefer file.close(native.io);
    const stat = try file.stat(native.io);
    if (stat.kind != .file or stat.size > max) return error.InvalidMcpFile;
    if (private) {
        const uid = if (@import("builtin").os.tag == .linux) blk: {
            const linux = std.os.linux;
            var info: linux.Statx = undefined;
            while (true) switch (linux.errno(linux.statx(fd, "", linux.AT.EMPTY_PATH, .{ .UID = true }, &info))) {
                .SUCCESS => break,
                .INTR => continue,
                else => return error.UnsafeMcpFile,
            };
            if (!info.mask.UID) return error.UnsafeMcpFile;
            break :blk info.uid;
        } else blk: {
            var info: std.c.Stat = undefined;
            if (std.c.fstat(fd, &info) != 0) return error.UnsafeMcpFile;
            break :blk info.uid;
        };
        if (uid != std.c.geteuid() or stat.permissions.toMode() & 0o077 != 0) return error.UnsafeMcpFile;
    }
    return file;
}
pub fn readPrivate(native: Native, a: std.mem.Allocator, path: []const u8, max: usize) ![]u8 {
    const f = try openFile(native, path, true, max);
    defer f.close(native.io);
    return Native.readAll(native.io, f, a, max);
}
pub fn verifyPin(native: Native, pin: wire.McpFilePin, cancelled: *std.atomic.Value(bool), deadline: i64) !void {
    const f = try openFile(native, pin.path, false, 256 * 1024 * 1024);
    defer f.close(native.io);
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    var buffer: [65536]u8 = undefined;
    var total: usize = 0;
    while (true) {
        if (cancelled.load(.acquire) or @import("remote_io.zig").now(native.io) >= deadline) return error.Cancelled;
        const n = try std.posix.read(f.handle, &buffer);
        if (n == 0) break;
        total += n;
        if (total > 256 * 1024 * 1024) return error.McpBuildTooLarge;
        h.update(buffer[0..n]);
    }
    const actual = std.fmt.bytesToHex(h.finalResult(), .lower);
    if (!std.mem.eql(u8, &actual, pin.sha256)) return error.McpBuildChanged;
}
fn allowedEnv(name: []const u8) bool {
    for ([_][]const u8{ "LD_", "DYLD_", "DECK_", "PI_" }) |prefix| if (std.mem.startsWith(u8, name, prefix)) return false;
    for ([_][]const u8{ "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "BASH_ENV", "ENV", "OPENAI_API_KEY" }) |bad| if (std.mem.eql(u8, name, bad)) return false;
    return true;
}
pub const Profiles = struct {
    arena: std.heap.ArenaAllocator,
    config: wire.McpHostConfig,
    public: wire.McpCatalog,
    pub fn load(native: Native, path: []const u8) !Profiles {
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const bytes = try readPrivate(native, a, path, 1024 * 1024);
        const parsed = try wire.parseMcpHostConfig(a, bytes);
        const raw = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
        const profiles = try a.alloc(wire.McpProfile, parsed.value.profiles.len);
        for (parsed.value.profiles, 0..) |p, i| {
            if (p.approval) |label| if (label.len > 64) return error.InvalidMcpProfile;
            if (!absolute(p.executable) or (!absolute(p.cwd) and !std.mem.eql(u8, p.cwd, "$TASK"))) return error.InvalidMcpProfile;
            for (parsed.value.profiles[0..i]) |other| if (std.mem.eql(u8, other.id, p.id)) return error.DuplicateMcpProfile;
            for (p.argv) |arg| if (arg.len > 4096 or std.mem.indexOfScalar(u8, arg, 0) != null) return error.InvalidMcpProfile;
            for (p.files) |pin| if (!absolute(pin.path)) return error.InvalidMcpProfile;
            for (p.env, 0..) |env, j| {
                if (!allowedEnv(env.name) or (env.value == null) == (env.file == null) or (env.file == null) != (env.sha256 == null)) return error.InvalidMcpEnvironment;
                if (env.file) |file| if (!absolute(file)) return error.InvalidMcpEnvironment;
                if (env.value) |value| if (value.len > 4096 or std.mem.indexOfScalar(u8, value, 0) != null) return error.InvalidMcpEnvironment;
                for (p.env[0..j]) |prior| if (std.mem.eql(u8, prior.name, env.name)) return error.InvalidMcpEnvironment;
            }
            for (p.tools, 0..) |tool, j| {
                if (tool.description.len > 2048) return error.InvalidMcpTool;
                const input = try schema.parse(a, tool.inputSchema);
                input.deinit();
                if (tool.outputSchema) |output| {
                    const checked = try schema.parse(a, output);
                    checked.deinit();
                }
                for (p.tools[0..j]) |prior| if (std.mem.eql(u8, prior.name, tool.name)) return error.DuplicateMcpTool;
            }
            const encoded = try std.json.Stringify.valueAlloc(a, raw.value.object.get("profiles").?.array.items[i], .{});
            const revision = hash(encoded);
            profiles[i] = .{ .id = p.id, .machineId = parsed.value.machineId, .revision = try a.dupe(u8, &revision), .workspace = if (std.mem.eql(u8, p.cwd, "$TASK")) .task else .fixed, .tools = p.tools };
        }
        return .{ .arena = arena, .config = parsed.value, .public = .{ .version = 1, .profiles = profiles } };
    }
    pub fn deinit(self: *Profiles) void {
        self.arena.deinit();
    }
    pub fn index(self: *const Profiles, id: []const u8, revision: []const u8) ?usize {
        for (self.public.profiles, 0..) |p, i| if (std.mem.eql(u8, p.id, id) and std.mem.eql(u8, p.revision, revision)) return i;
        return null;
    }
};
