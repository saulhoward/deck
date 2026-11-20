//! User-owned context on THIS machine. No caller-supplied home, workspace
//! fallback, shell expansion, or symlink traversal inside the resource roots.
const std = @import("std");
const Native = @import("native.zig");
const Operation = @import("generated/contracts.zig").NativeOperation;
const Result = @import("shell.zig").Result;
const Dir = std.Io.Dir;
const Allocator = std.mem.Allocator;
const max_text = 32 * 1024;
const max_header = 4096;

pub fn skillName(name: []const u8) bool {
    if (name.len == 0 or name.len > 64 or name[0] == '-' or name[name.len - 1] == '-' or std.mem.indexOf(u8, name, "--") != null) return false;
    for (name) |c| if (!std.ascii.isLower(c) and !std.ascii.isDigit(c) and c != '-') return false;
    return true;
}

pub fn skillPath(path: []const u8) bool {
    if (path.len > 512) return false;
    var it = std.mem.splitScalar(u8, path, '/');
    if (!skillName(it.next().?)) return false;
    while (it.next()) |part| {
        if (part.len == 0 or part.len > 255 or part[0] == '.') return false;
        for (part) |c| if (std.ascii.isControl(c) or c == '\\') return false;
    }
    return true;
}

fn readText(io: std.Io, a: Allocator, dir: Dir, name: []const u8, cap: usize, prefix: bool) ![]const u8 {
    const fd = try std.posix.openat(dir.handle, name, .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .NONBLOCK = true, .CLOEXEC = true }, 0);
    const file = std.Io.File{ .handle = fd, .flags = .{ .nonblocking = true } };
    defer file.close(io);
    const stat = try file.stat(io);
    if (stat.kind != .file or stat.size > max_text) return error.InvalidResource;
    if (prefix) {
        const buf = try a.alloc(u8, @intCast(@min(cap, stat.size)));
        return buf[0..try file.readPositionalAll(io, buf, 0)];
    }
    // Check through EOF even if the file grew after stat. Never publish a
    // silently truncated instruction or reference as a successful receipt.
    const text = try Native.readAll(io, file, a, cap);
    if (!std.unicode.utf8ValidateSlice(text) or std.mem.indexOfScalar(u8, text, 0) != null) return error.InvalidResource;
    return text;
}

fn frontmatter(text: []const u8) !struct { header: []const u8, body: []const u8 } {
    var lines = std.mem.splitScalar(u8, text, '\n');
    if (!std.mem.eql(u8, std.mem.trimEnd(u8, lines.next().?, "\r"), "---")) return error.InvalidSkill;
    const start = lines.index orelse return error.InvalidSkill;
    var pos = start;
    while (lines.next()) |line| {
        if (pos - start > max_header) break;
        if (std.mem.eql(u8, std.mem.trimEnd(u8, line, "\r"), "---")) {
            const header = text[start..pos];
            if (!std.unicode.utf8ValidateSlice(header)) return error.InvalidSkill;
            return .{ .header = header, .body = lines.rest() };
        }
        pos = lines.index orelse break;
    }
    return error.InvalidSkill;
}

const Metadata = struct { name: []const u8, header: []const u8 };
fn catalog(io: std.Io, a: Allocator, skills: Dir) ![]const u8 {
    var found: std.ArrayList(Metadata) = .empty;
    var it = skills.iterate();
    var seen: usize = 0;
    var bytes: usize = 0;
    while (try it.next(io)) |entry| {
        seen += 1;
        if (seen > 256) return error.CatalogTooLarge;
        if (entry.kind != .directory or !skillName(entry.name)) continue;
        var dir = skills.openDir(io, entry.name, .{ .follow_symlinks = false }) catch continue;
        defer dir.close(io);
        const prefix = readText(io, a, dir, "SKILL.md", max_header + 2 * "---\r\n".len, true) catch continue;
        const meta = frontmatter(prefix) catch continue;
        bytes += entry.name.len + meta.header.len;
        if (bytes > 64 * 1024) return error.CatalogTooLarge;
        try found.append(a, .{ .name = try a.dupe(u8, entry.name), .header = meta.header });
    }
    return std.json.Stringify.valueAlloc(a, found.items, .{});
}

fn get(io: std.Io, a: Allocator, home: Dir, op: Operation, path: ?[]const u8) ![]const u8 {
    if (op == .user_agents_md) {
        var codex = try home.openDir(io, ".codex", .{ .follow_symlinks = false });
        defer codex.close(io);
        return readText(io, a, codex, "AGENTS.md", max_text, false);
    }
    var config = try home.openDir(io, ".config", .{ .follow_symlinks = false });
    defer config.close(io);
    var deck = try config.openDir(io, "deck", .{ .follow_symlinks = false });
    defer deck.close(io);
    var skills = try deck.openDir(io, "skills", .{ .follow_symlinks = false, .iterate = op == .skill_catalog });
    defer skills.close(io);
    if (op == .skill_catalog) return catalog(io, a, skills);
    const target = path orelse return error.InvalidSkill;
    if (!skillPath(target)) return error.InvalidSkill;
    var parts = std.mem.splitScalar(u8, target, '/');
    const name = parts.next().?;
    var dir = try skills.openDir(io, name, .{ .follow_symlinks = false });
    defer dir.close(io);
    const manifest = try frontmatter(try readText(io, a, dir, "SKILL.md", max_text, false));
    var body = manifest.body;
    while (parts.next()) |part| {
        if (parts.index == null) {
            body = try readText(io, a, dir, part, max_text, false);
        } else {
            const child = try dir.openDir(io, part, .{ .follow_symlinks = false });
            dir.close(io);
            dir = child;
        }
    }
    return std.json.Stringify.valueAlloc(a, .{ .name = name, .header = manifest.header, .text = body }, .{});
}

pub fn read(native: Native, a: Allocator, op: Operation, path: ?[]const u8) Result {
    const invalid: Result = .{ .ok = false, .code = "read_failed", .output = "User context unavailable, invalid or too large" };
    const home_path = native.environ.getPosix("HOME") orelse return invalid;
    if (!std.fs.path.isAbsolute(home_path)) return invalid;
    var home = Dir.cwd().openDir(native.io, home_path, .{}) catch return invalid;
    defer home.close(native.io);
    const text = get(native.io, a, home, op, path) catch |err| switch (err) {
        error.FileNotFound => if (op == .skill_catalog) return .{ .ok = true, .output = "[]" } else return .{ .ok = false, .code = "not_found", .output = "User context file not found" },
        else => return invalid,
    };
    if (text.len > 128 * 1024) return invalid;
    return .{ .ok = true, .output = text };
}

test "user context resolves only fixed roots and skill-relative regular files" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const root = ".config/deck/skills/demo";
    try tmp.dir.createDirPath(io, root ++ "/refs");
    try tmp.dir.writeFile(io, .{ .sub_path = root ++ "/SKILL.md", .data = "---\r\nname: demo\r\ndescription: Test\r\n---\r\nBODY" });
    try tmp.dir.writeFile(io, .{ .sub_path = root ++ "/refs/example", .data = "EXAMPLE" });
    try tmp.dir.symLink(io, "refs/example", root ++ "/link", .{});
    const listing = try get(io, a, tmp.dir, .skill_catalog, null);
    try std.testing.expect(std.mem.indexOf(u8, listing, "demo") != null and std.mem.indexOf(u8, listing, "BODY") == null);
    try std.testing.expect(std.mem.indexOf(u8, try get(io, a, tmp.dir, .skill_read, "demo"), "BODY") != null);
    try std.testing.expect(std.mem.indexOf(u8, try get(io, a, tmp.dir, .skill_read, "demo/refs/example"), "EXAMPLE") != null);
    for ([_][]const u8{ "demo/../secret", "demo//etc", "/demo", "demo/", "foo--bar", "demo/.env" }) |bad| try std.testing.expect(!skillPath(bad));
    try std.testing.expectError(error.SymLinkLoop, get(io, a, tmp.dir, .skill_read, "demo/link"));
    try tmp.dir.symLink(io, "refs", root ++ "/linked-dir", .{ .is_directory = true });
    if (get(io, a, tmp.dir, .skill_read, "demo/linked-dir/example")) |_| return error.FollowedDirectorySymlink else |_| {}
    try tmp.dir.writeFile(io, .{ .sub_path = root ++ "/binary", .data = "not\x00text" });
    try std.testing.expectError(error.InvalidResource, get(io, a, tmp.dir, .skill_read, "demo/binary"));
    try std.testing.expectError(error.FileNotFound, get(io, a, tmp.dir, .user_agents_md, null));
    try tmp.dir.createDir(io, ".codex", .default_dir);
    try tmp.dir.writeFile(io, .{ .sub_path = ".codex/AGENTS.md", .data = "my default" });
    try std.testing.expectEqualStrings("my default", try get(io, a, tmp.dir, .user_agents_md, null));
}
