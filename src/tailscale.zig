//! Bounded, read-only local-daemon verification. Never enrolls, starts or logs in
//! to Tailscale. A whois snapshot is not a worker connection or effect receipt.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const boundary = @import("remote_contracts.zig");
const Ip = std.Io.net.IpAddress;

pub fn direct(address: Ip) bool {
    return switch (address) {
        .ip4 => |ip| ip.bytes[0] == 100 and ip.bytes[1] >= 64 and ip.bytes[1] <= 127,
        .ip6 => |ip| ip.interface.index == 0 and ip.flow == 0 and std.mem.eql(u8, ip.bytes[0..6], &.{ 0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0 }),
    };
}
pub fn endpoint(raw: []const u8) !Ip {
    const address = Ip.parseLiteral(raw) catch return error.InvalidPeerAddress;
    if (!direct(address) or address.getPort() == 0) return error.InvalidPeerAddress;
    return address;
}
fn sameIp(a: Ip, b: Ip) bool {
    return switch (a) {
        .ip4 => |ip| b == .ip4 and std.mem.eql(u8, &ip.bytes, &b.ip4.bytes),
        .ip6 => |ip| b == .ip6 and std.mem.eql(u8, &ip.bytes, &b.ip6.bytes),
    };
}
fn field(value: std.json.Value, key: []const u8) !std.json.Value {
    if (value != .object) return error.InvalidPeerEvidence;
    return value.object.get(key) orelse error.InvalidPeerEvidence;
}
fn text(value: std.json.Value) ![]const u8 {
    if (value != .string) return error.InvalidPeerEvidence;
    return value.string;
}
fn digits(bytes: []const u8) !u64 {
    for (bytes) |c| if (!std.ascii.isDigit(c)) return error.InvalidPeerEvidence;
    return std.fmt.parseInt(u64, bytes, 10) catch error.InvalidPeerEvidence;
}
fn leap(year: u64) bool {
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0);
}
fn expiry(value: []const u8, now: i64) !void {
    if (std.mem.eql(u8, value, "0001-01-01T00:00:00Z")) return; // Go zero time: no expiry.
    if (value.len < 20 or value.len > 30 or value[4] != '-' or value[7] != '-' or value[10] != 'T' or value[13] != ':' or value[16] != ':' or value[value.len - 1] != 'Z') return error.InvalidPeerEvidence;
    if (value.len != 20) {
        if (value.len < 22 or value[19] != '.') return error.InvalidPeerEvidence;
        _ = try digits(value[20 .. value.len - 1]);
    }
    const year = try digits(value[0..4]);
    const month = try digits(value[5..7]);
    const day = try digits(value[8..10]);
    const hour = try digits(value[11..13]);
    const minute = try digits(value[14..16]);
    const second = try digits(value[17..19]);
    const months = [_]u64{ 31, if (leap(year)) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (year < 1970 or month == 0 or month > 12 or day == 0 or day > months[month - 1] or hour > 23 or minute > 59 or second > 59 or now < 0) return error.InvalidPeerEvidence;
    var days: u64 = day - 1;
    for (1970..@intCast(year)) |y| days += if (leap(y)) @as(u64, 366) else 365;
    for (months[0 .. month - 1]) |count| days += count;
    if (days * 86400 + hour * 3600 + minute * 60 + second <= @as(u64, @intCast(now))) return error.ExpiredPeer;
}

// A cached peer record alone is insufficient when the local backend is stopped,
// logged out, or waiting for machine approval. Check the local daemon first.
pub fn checkLocalStatus(allocator: std.mem.Allocator, bytes: []const u8) !void {
    if (bytes.len > 64 * 1024 or !std.unicode.utf8ValidateSlice(bytes)) return error.InvalidPeerEvidence;
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{ .parse_numbers = false });
    defer parsed.deinit();
    if (!std.mem.eql(u8, try text(try field(parsed.value, "BackendState")), "Running")) return error.PeerVerificationUnavailable;
    const self = try field(parsed.value, "Self");
    if (!wire.validTailNodeId(try field(self, "ID"))) return error.InvalidPeerEvidence;
    const user = try field(self, "UserID");
    if (user != .number_string or !wire.validTailUserId(.{ .string = user.number_string }) or (user.number_string.len > 1 and user.number_string[0] == '0')) return error.InvalidPeerEvidence;
    _ = std.fmt.parseInt(u64, user.number_string, 10) catch return error.InvalidPeerEvidence;
    const addresses = try field(self, "TailscaleIPs");
    if (addresses != .array or addresses.array.items.len == 0 or addresses.array.items.len > 16) return error.InvalidPeerEvidence;
    for (addresses.array.items) |entry| {
        const address = Ip.parse(try text(entry), 0) catch return error.InvalidPeerEvidence;
        if (!direct(address)) return error.InvalidPeerEvidence;
    }
}

// Owns only the bounded projected identity; no daemon body/private metadata escapes.
pub fn parseWhois(allocator: std.mem.Allocator, bytes: []const u8, address: Ip, now: i64) !std.json.Parsed(wire.TailPeer) {
    if (!direct(address) or bytes.len > 64 * 1024 or !std.unicode.utf8ValidateSlice(bytes)) return error.InvalidPeerEvidence;
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{ .parse_numbers = false });
    defer parsed.deinit();
    const node = try field(parsed.value, "Node");
    const profile = try field(parsed.value, "UserProfile");
    if (node != .object) return error.InvalidPeerEvidence;
    // tailcfg.Node marks this legacy field omitempty. Real peer whois responses
    // omit it; absence is not machine approval. Access still requires a running
    // local daemon and exact operator-registered node/user pins. Explicit denial
    // or a malformed value remains a refusal.
    if (node.object.get("MachineAuthorized")) |authorized| if (authorized != .bool or !authorized.bool) return error.UnauthorizedPeer;
    if (node.object.get("Expired")) |expired| if (expired != .bool or expired.bool) return error.ExpiredPeer;
    try expiry(try text(try field(node, "KeyExpiry")), now);
    const user = try field(node, "User");
    const owner = try field(profile, "ID");
    if (user != .number_string or owner != .number_string or !std.mem.eql(u8, user.number_string, owner.number_string)) return error.InvalidPeerEvidence;
    const addresses = try field(node, "Addresses");
    if (addresses != .array or addresses.array.items.len == 0 or addresses.array.items.len > 16) return error.InvalidPeerEvidence;
    var matched = false;
    for (addresses.array.items) |entry| {
        const raw = try text(entry);
        const slash = std.mem.indexOfScalar(u8, raw, '/') orelse return error.InvalidPeerEvidence;
        const ip = Ip.parse(raw[0..slash], 0) catch return error.InvalidPeerEvidence;
        const width: []const u8 = if (ip == .ip4) "32" else "128";
        if (!direct(ip) or !std.mem.eql(u8, raw[slash + 1 ..], width)) return error.InvalidPeerEvidence;
        matched = matched or sameIp(address, ip);
    }
    if (!matched) return error.PeerAddressMismatch;
    const output = try std.json.Stringify.valueAlloc(allocator, .{ .nodeId = try text(try field(node, "StableID")), .userId = user.number_string }, .{});
    defer allocator.free(output);
    const checked = try std.json.parseFromSlice(std.json.Value, allocator, output, .{});
    defer checked.deinit();
    if (!boundary.validPeer(checked.value)) return error.InvalidPeerEvidence;
    return std.json.parseFromSlice(wire.TailPeer, allocator, output, .{ .allocate = .alloc_always });
}

fn capture(native: Native, allocator: std.mem.Allocator, argv: []const []const u8, cancelled: *std.atomic.Value(bool)) ![]const u8 {
    const captured = try @import("shell.zig").runArgvCaptured(native, allocator, "/", argv, 4, cancelled);
    defer allocator.free(captured.result.output);
    defer allocator.free(captured.stderr);
    errdefer allocator.free(captured.stdout);
    if (!captured.result.ok or captured.result.truncated or cancelled.load(.acquire)) return error.PeerVerificationUnavailable;
    return captured.stdout;
}

pub fn validateExecutable(native: Native, executable: []const u8) !void {
    if (!std.fs.path.isAbsolute(executable) or executable.len > 4096 or std.mem.indexOfScalar(u8, executable, 0) != null) return error.InvalidPeerVerifier;
    try std.Io.Dir.cwd().access(native.io, executable, .{ .execute = true });
    if ((try std.Io.Dir.cwd().statFile(native.io, executable, .{})).kind != .file) return error.InvalidPeerVerifier;
}
pub fn localPeer(native: Native, allocator: std.mem.Allocator, executable: []const u8) !std.json.Parsed(wire.TailPeer) {
    try validateExecutable(native, executable);
    var cancelled = std.atomic.Value(bool).init(false);
    const bytes = try capture(native, allocator, &.{ executable, "status", "--json", "--peers=false" }, &cancelled);
    defer allocator.free(bytes);
    try checkLocalStatus(allocator, bytes);
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{ .parse_numbers = false });
    defer parsed.deinit();
    const self = try field(parsed.value, "Self");
    const output = try std.json.Stringify.valueAlloc(allocator, .{ .nodeId = (try field(self, "ID")).string, .userId = (try field(self, "UserID")).number_string }, .{});
    defer allocator.free(output);
    return std.json.parseFromSlice(wire.TailPeer, allocator, output, .{ .allocate = .alloc_always });
}

pub fn verify(native: Native, allocator: std.mem.Allocator, executable: []const u8, address: Ip, cancelled: *std.atomic.Value(bool)) !std.json.Parsed(wire.TailPeer) {
    if (!direct(address) or address.getPort() == 0) return error.InvalidPeerVerifier;
    try validateExecutable(native, executable);
    const remote = try std.fmt.allocPrint(allocator, "{f}", .{address});
    defer allocator.free(remote);
    // Explicit executable and literal address, no PATH/DNS, headers, shell text,
    // ambient TS_* auth/socket overrides, or inherited model credentials.
    const status = try capture(native, allocator, &.{ executable, "status", "--json", "--peers=false" }, cancelled);
    defer allocator.free(status);
    try checkLocalStatus(allocator, status);
    const whois = try capture(native, allocator, &.{ executable, "whois", "--json", remote }, cancelled);
    defer allocator.free(whois);
    return parseWhois(allocator, whois, address, std.Io.Clock.real.now(native.io).toSeconds());
}
