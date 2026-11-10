const std = @import("std");
const contracts = @import("generated/contracts.zig");

fn check(comptime name: []const u8, value: std.json.Value, expected: bool, allocator: std.mem.Allocator) !void {
    const valid = @field(contracts, "valid" ++ name);
    try std.testing.expectEqual(expected, valid(value));
    const encoded = try std.json.Stringify.valueAlloc(allocator, value, .{});
    const parse = @field(contracts, "parse" ++ name);
    if (expected) {
        const decoded = try parse(allocator, encoded);
        defer decoded.deinit();
        const roundtrip = try std.json.Stringify.valueAlloc(allocator, decoded.value, .{});
        const raw = try std.json.parseFromSlice(std.json.Value, allocator, roundtrip, .{});
        defer raw.deinit();
        try std.testing.expect(valid(raw.value));
    } else {
        if (parse(allocator, encoded)) |parsed| {
            parsed.deinit();
            return error.AcceptedInvalidContract;
        } else |_| {}
    }
}

test "schema-derived Zig validators/codecs consume the shared positive and negative corpus" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixtures = (try std.json.parseFromSlice(std.json.Value, allocator, @embedFile("contracts.test.json"), .{})).value;
    for (fixtures.object.get("cases").?.array.items) |fixture| {
        const name = fixture.object.get("schema").?.string;
        const base = fixture.object.get("value") orelse fixtures.object.get("bases").?.object.get(name).?;
        const encoded = try std.json.Stringify.valueAlloc(allocator, base, .{});
        var value = (try std.json.parseFromSlice(std.json.Value, allocator, encoded, .{})).value;
        if (fixture.object.get("set")) |set| {
            var it = set.object.iterator();
            while (it.next()) |entry| try value.object.put(allocator, entry.key_ptr.*, entry.value_ptr.*);
        }
        if (fixture.object.get("remove")) |remove| for (remove.array.items) |key| {
            _ = value.object.swapRemove(key.string);
        };
        if (fixture.object.get("repeat")) |repeat| {
            const text = repeat.object.get("text").?.string;
            const count: usize = @intCast(repeat.object.get("count").?.integer);
            const repeated = try allocator.alloc(u8, text.len * count);
            for (0..count) |i| @memcpy(repeated[i * text.len ..][0..text.len], text);
            try value.object.put(allocator, repeat.object.get("field").?.string, .{ .string = repeated });
        }
        if (fixture.object.get("repeatItems")) |repeat| {
            const count: usize = @intCast(repeat.integer);
            const field = if (fixture.object.get("repeatField")) |field_name| field_name.string else "items";
            const item = value.object.get(field).?.array.items[0];
            var items = std.array_list.Managed(std.json.Value).init(allocator);
            for (0..count) |_| try items.append(item);
            try value.object.put(allocator, field, .{ .array = items });
        }
        var found = false;
        inline for (.{ "HubCommand", "KnownCommandErrorCode", "FailureSource", "FailurePolicy", "NativeOperation", "NativeCorrelationId", "NativePath", "NativeText", "NativeArguments", "NativeReadArgs", "NativeWriteArgs", "NativeEditArgs", "NativeBashArgs", "NativeProgressArgs", "NativePlanArgs", "NativeRequest", "NativeResult", "NativeProgress", "NativeResponse", "NativeReceipt", "StatusArgs", "StatusSnapshot", "StatusBinding", "StatusInspection", "LoginStartArgs", "LoginStatusArgs", "LoginCancelArgs", "LoginReplyArgs", "LoginReplyAck", "LoginCancelAck", "LoginSnapshot", "LoginEvent", "LoginPrompt", "RexTargetOptions", "RexServer", "RexOpenTarget", "RexOpenArgs", "RexReadArgs", "RexOpenAck", "RexPublicBinding", "RexStatusSnapshot", "RequestEnvelope", "RexUuid", "RexSessionId", "RexWindowId", "RexBlockId", "ChatId", "NullableRexUuid", "RexAllocationPlan", "RexCreation", "RexInspectionScope", "RexInspectionQuery", "RexPresenceState", "RexInspectionObservation", "RexInspectionStatus", "RexInspectionSnapshot", "Sha256", "RexAllocationReceiptQuery", "RexAllocationReceiptState", "RexAllocationReceipt", "TransportId", "CommandError", "SuccessResponse", "ErrorResponse", "ResponseEnvelope", "PiId", "DurableRequestId", "CommandString", "AdmissionMode", "AdmitArgs", "CreateTaskArgs", "InstructionImportArgs", "AdmitAck", "CreateTaskAck", "InstructionImportAck", "StopArgs", "StopAck", "RexStartupArgs", "RexRegistrationObservation", "RexStartupAck", "ListChatsArgs", "ChatListKind", "ChatListLabel", "ChatListItem", "ChatListItems", "ChatListPage", "HistoryArgs", "HistoryEntry", "HistoryInputData", "HistoryAgentOrigin", "HistoryContentPart", "HistoryMessage", "HistoryMessages", "HistoryPage", "LiveViewArgs", "InstructionStatusArgs", "ActivitySnapshot", "ProgressGeneration", "ProgressTool", "ProgressSnapshot", "InstructionSourceView", "InstructionResultView", "InstructionTaskView", "InstructionSnapshot" }) |schema| {
            if (std.mem.eql(u8, name, schema)) {
                check(schema, value, fixture.object.get("valid").?.bool, allocator) catch |err| {
                    std.debug.print("contract fixture failed: {s}\n", .{fixture.object.get("name").?.string});
                    return err;
                };
                found = true;
            }
        }
        try std.testing.expect(found);
    }
}

test "discriminated response codecs select/serialize payloads without wrapper tags, including nested decoding" {
    const allocator = std.testing.allocator;
    const Wrapper = struct { response: contracts.ResponseEnvelope };
    for ([_][]const u8{
        "{\"response\":{\"version\":1e0,\"id\":\"x\",\"ok\":true,\"result\":null}}",
        "{\"response\":{\"version\":1.0,\"id\":\"x\",\"ok\":false,\"error\":{\"code\":\"busy\",\"message\":\"Read later\"}}}",
    }, 0..) |encoded, index| {
        const parsed = try std.json.parseFromSlice(Wrapper, allocator, encoded, .{});
        defer parsed.deinit();
        try std.testing.expectEqual(index == 0, parsed.value.response == .case0);
        const roundtrip = try std.json.Stringify.valueAlloc(allocator, parsed.value, .{});
        defer allocator.free(roundtrip);
        try std.testing.expect(std.mem.indexOf(u8, roundtrip, "case0") == null and std.mem.indexOf(u8, roundtrip, "case1") == null);
        const raw = try std.json.parseFromSlice(std.json.Value, allocator, roundtrip, .{});
        defer raw.deinit();
        try std.testing.expect(contracts.validResponseEnvelope(raw.value.object.get("response").?));
    }
    // Even a parent decoding with ignore_unknown_fields cannot weaken a branch.
    try std.testing.expectError(error.UnexpectedToken, std.json.parseFromSlice(Wrapper, allocator, "{\"response\":{\"version\":1,\"id\":\"x\",\"ok\":true,\"result\":null,\"error\":{\"code\":\"busy\",\"message\":\"Read later\"}}}", .{ .ignore_unknown_fields = true }));
}

test "JSON integer semantics include integral float/exponent syntax; malformed text still refuses" {
    const allocator = std.testing.allocator;
    for ([_][]const u8{ "1", "1.0", "1e0" }) |number| {
        const encoded = try std.fmt.allocPrint(allocator, "{{\"version\":{s},\"id\":\"x\",\"command\":\"status\"}}", .{number});
        defer allocator.free(encoded);
        const parsed = try contracts.parseRequestEnvelope(allocator, encoded);
        defer parsed.deinit();
        try std.testing.expectEqual(@as(i64, 1), parsed.value.version);
    }
    for ([_][]const u8{ "null", "{", "{\"version\":1,\"id\":\"\\ud800\",\"command\":\"status\"}" }) |encoded| {
        if (contracts.parseRequestEnvelope(allocator, encoded)) |parsed| {
            parsed.deinit();
            return error.AcceptedInvalidContract;
        } else |_| {}
    }
}
