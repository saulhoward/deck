const std = @import("std");
const wire = @import("generated/contracts.zig");
fn oneOf(s: []const u8, options: []const []const u8) bool {
    for (options) |option| if (std.mem.eql(u8, s, option)) return true;
    return false;
}
// Local client guidance, not a wire acknowledgement or replay mechanism. Keep
// parity with command-policy.ts via shared fixtures, including unknown errors.
pub fn failure(command: []const u8, code: []const u8, source: wire.FailureSource) wire.FailurePolicy {
    var policy: wire.FailurePolicy = .{ .outcome = .unconfirmed, .action = .inspect_outcome, .preserveDrafts = true, .automaticMutationRetry = false };
    if (source == .local) {
        policy.outcome = .not_sent;
        policy.action = .fix_request;
    } else if (oneOf(command, &.{ "subagent_view", "mcp_catalog", "tool_profiles", "model_settings", "status", "list_chats", "list_hosts", "history", "activity", "progress", "instruction_status", "rex_status", "rex_inspect", "login_status" })) {
        policy.outcome = .read_only;
        policy.action = if (oneOf(command, &.{ "history", "subagent_view" }) and source == .remote and std.mem.eql(u8, code, "too_large")) .reduce_page else .retry_read;
    } else if (oneOf(command, &.{ "admit", "create_task", "create_task_brief", "create_managed_child", "import_instructions" })) {
        policy.action = if (source == .remote and oneOf(code, &.{ "conflict", "invalid", "settings_changed" })) .review_saved else .retry_saved;
    } else if (std.mem.eql(u8, command, "rex_open")) {
        policy.action = .inspect_terminal;
    } else if (oneOf(command, &.{ "login_start", "login_reply", "login_cancel" })) {
        policy.action = if (std.mem.eql(u8, command, "login_reply") and source == .remote and std.mem.eql(u8, code, "conflict")) .poll_login else .observe_login;
    } else if (oneOf(command, &.{ "set_tool_profiles", "set_model_settings", "stop", "rex_startup" })) {
        policy.action = .explicit_action;
    }
    return policy;
}

test "subagent reads are repeatable, oversized pages require explicit reduction" {
    for ([_]wire.FailureSource{ .local, .remote, .transport }) |source| {
        for ([_][]const u8{ "too_large", "invalid_response", "future_error" }) |code| {
            const policy = failure("subagent_view", code, source);
            try std.testing.expectEqual(@as(@TypeOf(policy.outcome), if (source == .local) .not_sent else .read_only), policy.outcome);
            const action: @TypeOf(policy.action) = if (source == .local) .fix_request else if (source == .remote and std.mem.eql(u8, code, "too_large")) .reduce_page else .retry_read;
            try std.testing.expectEqual(action, policy.action);
            try std.testing.expect(policy.preserveDrafts and !policy.automaticMutationRetry);
        }
    }
}
