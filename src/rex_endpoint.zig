const std = @import("std");

// No host aliases, TCP routing or URI query/fragment. Raw paths remain accepted
// for legacy records; percent encoding changes spelling, not socket identity.
pub fn socketPath(server: []const u8, buffer: *[100]u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, server, "unix:///") or server.len > 307 or std.mem.indexOfAny(u8, server, "?#\x00\r\n") != null) return null;
    var i: usize = 7;
    var n: usize = 0;
    while (i < server.len) : (i += 1) {
        var byte = server[i];
        if (byte == '%') {
            if (i + 2 >= server.len or !std.ascii.isHex(server[i + 1]) or !std.ascii.isHex(server[i + 2])) return null;
            byte = std.fmt.parseInt(u8, server[i + 1 ..][0..2], 16) catch return null;
            i += 2;
        }
        if (n == buffer.len or byte == 0 or byte == '\r' or byte == '\n') return null;
        buffer[n] = byte;
        n += 1;
    }
    return if (std.unicode.utf8ValidateSlice(buffer[0..n])) buffer[0..n] else null;
}
pub fn valid(server: []const u8) bool {
    var buffer: [100]u8 = undefined;
    return socketPath(server, &buffer) != null;
}
pub fn same(a: []const u8, b: []const u8) bool {
    var left: [100]u8 = undefined;
    var right: [100]u8 = undefined;
    return std.mem.eql(u8, socketPath(a, &left) orelse return false, socketPath(b, &right) orelse return false);
}
test "local Rex endpoint fixtures" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, @embedFile("rex_endpoint.test.json"), .{});
    defer parsed.deinit();
    for (parsed.value.array.items) |fixture| {
        const server = fixture.object.get("server").?.string;
        try std.testing.expectEqual(fixture.object.get("valid").?.bool, valid(server));
        if (fixture.object.get("same")) |other| try std.testing.expect(same(server, other.string));
    }
}
