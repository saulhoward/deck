//! Display-only inventory validation, matching runtime/tool-inventory-contracts.
//! No catalog lookup, host probing, or tool authority is inferred here.
const std = @import("std");
const wire = @import("generated/contracts.zig");
const V = std.json.Value;
const byte_cap = 64 * 1024;

fn field(value: V, key: []const u8) V {
    return value.object.get(key).?;
}
fn same(a: V, b: V) bool {
    return a == .string and b == .string and std.mem.eql(u8, a.string, b.string);
}
fn tag(value: V, text: []const u8) bool {
    return same(value, .{ .string = text });
}
fn uniqueName(names: [][]const u8, count: *usize, name: []const u8) bool {
    for (names[0..count.*]) |prior| if (std.mem.eql(u8, prior, name)) return false;
    names[count.*] = name;
    count.* += 1;
    return true;
}

pub fn validToolInventory(value: V, chat_id: ?[]const u8) bool {
    if (!wire.validToolInventory(value)) return false;
    const chat = field(value, "chatId").string;
    if ((std.fmt.parseInt(u64, chat, 10) catch return false) > 9007199254740991) return false;
    if (chat_id) |expected| if (!std.mem.eql(u8, chat, expected)) return false;

    // The closed schema contains only ASCII strings, arrays and objects, so
    // compact JSON has the same byte length as TS JSON.stringify. Bound the
    // writer itself rather than allocating an oversized serialization first.
    var buffer: [byte_cap]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buffer);
    std.json.Stringify.value(value, .{}, &writer) catch return false;

    // Schema bounds: at most 128 builtins and 16 profiles of 16 tools each.
    // Aliases share the builtin namespace, including not-granted profiles.
    var names: [128 + 16 * 16][]const u8 = undefined;
    var count: usize = 0;
    for (field(value, "builtins").array.items) |tool| {
        if (!uniqueName(&names, &count, field(tool, "name").string)) return false;
    }
    const profiles = field(value, "mcp").array.items;
    for (profiles, 0..) |profile, i| {
        for (profiles[0..i]) |prior| {
            if (same(field(profile, "machineId"), field(prior, "machineId")) and
                same(field(profile, "profileId"), field(prior, "profileId")) and
                same(field(profile, "revision"), field(prior, "revision"))) return false;
        }
        if (tag(field(profile, "location"), "hub")) {
            if (value.object.get("hubMachineId")) |hub| if (!same(field(profile, "machineId"), hub)) return false;
        }
        const tools = field(profile, "tools").array.items;
        if (tag(field(profile, "state"), "unavailable")) {
            if (tools.len != 0) return false;
        } else if (!profile.object.contains("workspace") or tools.len == 0) return false;
        for (tools, 0..) |tool, j| {
            if (!uniqueName(&names, &count, field(tool, "alias").string)) return false;
            for (tools[0..j]) |prior| if (same(field(tool, "name"), field(prior, "name"))) return false;
        }
    }
    return true;
}

// Legacy snapshots may omit both fields, or omit just the convenience status.
// Explicit ready requires a payload; unsupported/unavailable forbid one.
pub fn validInventoryFields(value: V) bool {
    if (value != .object) return false;
    const inventory = value.object.get("toolInventory");
    if (inventory) |payload| {
        const chat = value.object.get("chatId") orelse return false;
        if (chat != .string or !validToolInventory(payload, chat.string)) return false;
    }
    if (value.object.get("toolInventoryStatus")) |status| {
        if (!wire.validToolInventoryStatus(status) or tag(status, "ready") != (inventory != null)) return false;
    }
    return true;
}

fn testValue(a: std.mem.Allocator, value: anytype) !V {
    return (try std.json.parseFromSlice(V, a, try std.json.Stringify.valueAlloc(a, value, .{}), .{})).value;
}
fn testInventory(a: std.mem.Allocator) !V {
    return testValue(a, wire.ToolInventory{
        .chatId = "1",
        .hubMachineId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .workerMachineId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        .builtins = &.{.{ .name = "read", .location = .worker }},
        .mcp = &.{.{
            .profileId = "local",
            .machineId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            .location = .hub,
            .workspace = .task,
            .revision = "1111111111111111111111111111111111111111111111111111111111111111",
            .state = .enabled,
            .tools = &.{.{ .name = "lookup", .alias = "mcp_local_lookup" }},
        }},
    });
}

// Exercise the actual renderer and status admission hooks, not just the helper.
// These snapshots intentionally keep the legacy tools summary independent.
fn expectFields(a: std.mem.Allocator, expected: bool, value: V) !void {
    try std.testing.expectEqual(expected, validInventoryFields(value));
    var response = (try std.json.parseFromSlice(V, a,
        \\{"version":1,"id":"1","ok":true,"snapshot":{"clientMode":"hub","hubChatId":"1","hubId":"hub","chatId":"1","title":"Task","model":"mock","tools":"offline","activityKnown":false,"busy":false,"queued":0,"entries":[],"hasOlder":false,"historical":false,"preview":"","notice":"","draft":null}}
    , .{})).value;
    var status = (try std.json.parseFromSlice(V, a,
        \\{"hubId":"hub","mainChatId":"1","chatId":"1","tools":"offline"}
    , .{})).value;
    for ([_][]const u8{ "chatId", "toolInventory", "toolInventoryStatus" }) |key| {
        if (value.object.get(key)) |item| {
            try response.object.getPtr("snapshot").?.object.put(a, key, item);
            try status.object.put(a, key, item);
        }
    }
    try std.testing.expectEqual(expected, @import("tui_bridge.zig").validReply(response, "1", "hub", field(value, "chatId").string));
    const args = try testValue(a, .{ .chatId = field(value, "chatId").string });
    try std.testing.expectEqual(expected, @import("status_login.zig").validReply("status", args, .{ .string = "hub" }, status));
}
fn expectInventory(a: std.mem.Allocator, expected: bool, inventory: V) !void {
    var value = try testValue(a, .{ .chatId = "1", .toolInventoryStatus = "ready" });
    try value.object.put(a, "toolInventory", inventory);
    try expectFields(a, expected, value);
}

test "inventory legacy fields and explicit statuses agree at TUI and status boundaries" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_]?[]const u8{ null, "ready", "unsupported", "unavailable", "unknown" }) |status| {
        for ([_]bool{ false, true }) |payload| {
            var value = try testValue(a, .{ .chatId = "1" });
            if (status) |s| try value.object.put(a, "toolInventoryStatus", .{ .string = s });
            if (payload) try value.object.put(a, "toolInventory", try testInventory(a));
            const expected = if (status) |s| if (std.mem.eql(u8, s, "ready")) payload else (std.mem.eql(u8, s, "unsupported") or std.mem.eql(u8, s, "unavailable")) and !payload else true;
            try expectFields(a, expected, value);
        }
    }
    for ([_][]const u8{ "toolInventory", "toolInventoryStatus" }) |key| {
        var value = try testValue(a, .{ .chatId = "1" });
        try value.object.put(a, key, .null);
        try expectFields(a, false, value);
    }
    try std.testing.expect(!validInventoryFields(.null));
    try expectInventory(a, true, try testValue(a, wire.ToolInventory{ .chatId = "1", .builtins = &.{}, .mcp = &.{} }));
}

test "inventory correlates exact safe Pi IDs before display" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_][]const u8{ "1", "2", "9007199254740991", "9007199254740992", "0", "01", "-1" }) |id| {
        var inventory = try testInventory(a);
        try inventory.object.put(a, "chatId", .{ .string = id });
        try expectInventory(a, std.mem.eql(u8, id, "1"), inventory);
        var value = try testValue(a, .{ .chatId = id });
        try value.object.put(a, "toolInventory", inventory);
        const safe = std.mem.eql(u8, id, "1") or std.mem.eql(u8, id, "2") or std.mem.eql(u8, id, "9007199254740991");
        try std.testing.expectEqual(safe, validToolInventory(inventory, null));
        try expectFields(a, safe, value);
    }
}

test "inventory rejects duplicate builtin names, profile rows, aliases and per-profile tool names" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const Case = enum { builtin, profile, alias_builtin, alias_local, alias_global, tool_name };
    for (std.enums.values(Case)) |case| {
        var inventory = try testInventory(a);
        const profiles = &inventory.object.getPtr("mcp").?.array;
        const profile = &profiles.items[0];
        const tools = &profile.object.getPtr("tools").?.array;
        switch (case) {
            .builtin => {
                const builtins = &inventory.object.getPtr("builtins").?.array;
                try builtins.append(builtins.items[0]);
            },
            .profile => {
                // No duplicate aliases: the row key alone must be rejected.
                var other = try testValue(a, profile.*);
                try other.object.put(a, "state", .{ .string = "unavailable" });
                try other.object.put(a, "tools", .{ .array = .init(a) });
                try profiles.append(other);
            },
            .alias_builtin => try tools.items[0].object.put(a, "alias", .{ .string = "read" }),
            .alias_local, .tool_name => {
                var other = try testValue(a, tools.items[0]);
                try other.object.put(a, if (case == .alias_local) "name" else "alias", .{ .string = "different" });
                try tools.append(other);
            },
            .alias_global => {
                var other = try testValue(a, profile.*);
                try other.object.put(a, "profileId", .{ .string = "other" });
                try other.object.put(a, "state", .{ .string = "not_granted" });
                try profiles.append(other);
            },
        }
        try std.testing.expect(wire.validToolInventory(inventory));
        try expectInventory(a, false, inventory);
    }
    // Revisions/machines distinguish rows; source tool names may repeat across
    // profiles, provided their public aliases are distinct.
    for ([_][]const u8{ "revision", "machineId", "profileId" }) |key| {
        var inventory = try testInventory(a);
        const profiles = &inventory.object.getPtr("mcp").?.array;
        var other = try testValue(a, profiles.items[0]);
        try other.object.put(a, key, .{ .string = if (std.mem.eql(u8, key, "revision")) "2222222222222222222222222222222222222222222222222222222222222222" else if (std.mem.eql(u8, key, "machineId")) "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" else "other" });
        try other.object.put(a, "location", .{ .string = "worker" });
        try other.object.getPtr("tools").?.array.items[0].object.put(a, "alias", .{ .string = "different" });
        try profiles.append(other);
        try expectInventory(a, true, inventory);
    }
}

test "inventory states require tools and workspace; hub location is correlated only when known" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_][]const u8{ "enabled", "not_granted", "unavailable" }) |state| {
        for ([_]bool{ false, true }) |workspace| {
            for ([_]bool{ false, true }) |tools| {
                var inventory = try testInventory(a);
                const profile = &inventory.object.getPtr("mcp").?.array.items[0];
                try profile.object.put(a, "state", .{ .string = state });
                if (!workspace) _ = profile.object.swapRemove("workspace");
                if (!tools) try profile.object.put(a, "tools", .{ .array = .init(a) });
                const expected = if (std.mem.eql(u8, state, "unavailable")) !tools else workspace and tools;
                try std.testing.expect(wire.validToolInventory(inventory));
                try expectInventory(a, expected, inventory);
            }
        }
    }
    var inventory = try testInventory(a);
    try inventory.object.put(a, "hubMachineId", .{ .string = "cccccccccccccccccccccccccccccccc" });
    try expectInventory(a, false, inventory);
    _ = inventory.object.swapRemove("hubMachineId");
    try expectInventory(a, true, inventory);
    try inventory.object.put(a, "hubMachineId", .{ .string = "hub-label" });
    try inventory.object.getPtr("mcp").?.array.items[0].object.put(a, "location", .{ .string = "worker" });
    try expectInventory(a, true, inventory); // Worker location has no identity constraint in TS.
}

fn testName(a: std.mem.Allocator, prefix: []const u8, index: usize, len: usize) ![]const u8 {
    const name = try a.alloc(u8, len);
    @memset(name, 'x');
    _ = try std.fmt.bufPrint(name, "{s}{d}", .{ prefix, index });
    return name;
}

test "inventory schema bounds and private metadata are fenced by the semantic entry point" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_][]const u8{ "builtins", "mcp", "tools" }) |key| {
        var inventory = try testInventory(a);
        var list: std.array_list.Managed(V) = .init(a);
        const max: usize = if (std.mem.eql(u8, key, "builtins")) 128 else 16;
        for (0..max + 1) |i| {
            if (std.mem.eql(u8, key, "builtins")) {
                try list.append(try testValue(a, wire.InventoryBuiltin{ .name = try testName(a, "tool", i, 128), .location = .environment }));
                try inventory.object.put(a, key, .{ .array = list });
            } else if (std.mem.eql(u8, key, "mcp")) {
                var profile = try testValue(a, field(inventory, "mcp").array.items[0]);
                try profile.object.put(a, "profileId", .{ .string = try testName(a, "p", i, 32) });
                try profile.object.put(a, "state", .{ .string = "unavailable" });
                try profile.object.put(a, "tools", .{ .array = .init(a) });
                try list.append(profile);
                try inventory.object.put(a, key, .{ .array = list });
            } else {
                try list.append(try testValue(a, wire.InventoryMcpTool{ .name = try testName(a, "tool", i, 64), .alias = try testName(a, "alias", i, 128) }));
                try inventory.object.getPtr("mcp").?.array.items[0].object.put(a, key, .{ .array = list });
            }
            if (i + 1 >= max) try expectInventory(a, i + 1 == max, inventory);
        }
    }
    for ([_][]const u8{ "env", "description", "inputSchema", "executable" }) |key| {
        var inventory = try testInventory(a);
        try inventory.object.put(a, key, .{ .string = "PRIVATE" });
        try expectInventory(a, false, inventory);
    }
    for ([_][]const u8{ "hubMachineId", "workerMachineId" }) |key| {
        var inventory = try testInventory(a);
        try inventory.object.put(a, key, .{ .string = try testName(a, "host", 0, 200) });
        // This is a worker profile, so a display hub label need not match it.
        try inventory.object.getPtr("mcp").?.array.items[0].object.put(a, "location", .{ .string = "worker" });
        try expectInventory(a, true, inventory);
        try inventory.object.put(a, key, .{ .string = try testName(a, "host", 0, 201) });
        try expectInventory(a, false, inventory);
        try inventory.object.put(a, key, .{ .string = "\x1b]bad" });
        try expectInventory(a, false, inventory);
    }
}

test "inventory aggregate compact JSON cap accepts exactly 64 KiB at real reply boundaries" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var builtins: [128]wire.InventoryBuiltin = undefined;
    var profiles: [16]wire.InventoryMcpProfile = undefined;
    var tools: [16][16]wire.InventoryMcpTool = undefined;
    for (&builtins, 0..) |*builtin, i| builtin.* = .{ .name = try testName(a, "builtin", i, 128), .location = .hub };
    for (&profiles, 0..) |*profile, i| {
        for (&tools[i], 0..) |*tool, j| tool.* = .{ .name = try testName(a, "tool", j, 64), .alias = try testName(a, "alias", i * 16 + j, 128) };
        profile.* = .{ .profileId = try testName(a, "p", i, 32), .machineId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .location = .hub, .workspace = .fixed, .revision = "1111111111111111111111111111111111111111111111111111111111111111", .state = .enabled, .tools = &tools[i] };
    }
    const inventory: wire.ToolInventory = .{ .chatId = "1", .builtins = &builtins, .mcp = &profiles };
    const large = try testValue(a, inventory);
    try std.testing.expect(wire.validToolInventory(large));
    try expectInventory(a, false, large);
    const length = (try std.json.Stringify.valueAlloc(a, inventory, .{})).len;
    var excess = length - (byte_cap - 1);
    const first_alias = tools[0][0].alias;
    for (&tools) |*row| {
        for (row) |*tool| {
            const remove = @min(excess, tool.alias.len - 16);
            tool.alias = tool.alias[0 .. tool.alias.len - remove];
            excess -= remove;
        }
    }
    try std.testing.expectEqual(0, excess);
    const first_length = tools[0][0].alias.len;
    for (0..3) |extra| {
        tools[0][0].alias = first_alias[0 .. first_length + extra];
        const encoded = try std.json.Stringify.valueAlloc(a, inventory, .{});
        try std.testing.expectEqual(byte_cap - 1 + extra, encoded.len);
        const raw = (try std.json.parseFromSlice(V, a, encoded, .{})).value;
        try std.testing.expect(wire.validToolInventory(raw));
        try expectInventory(a, extra < 2, raw);
        if (extra == 1) {
            const pretty = try std.json.Stringify.valueAlloc(a, raw, .{ .whitespace = .indent_2 });
            try std.testing.expect(pretty.len > byte_cap);
            try expectInventory(a, true, (try std.json.parseFromSlice(V, a, pretty, .{})).value);
        }
    }
}
