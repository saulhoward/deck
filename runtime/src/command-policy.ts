import type { FailurePolicy, FailureSource } from "./generated/contracts.js";

// Guidance only. Neither a named remote error nor an HTTP/network failure proves
// rollback. Reads can be repeated; mutations require the indicated explicit act.
export function failurePolicy(command: string, code = "", source: FailureSource = "transport"): FailurePolicy {
  let outcome: FailurePolicy["outcome"] = "unconfirmed";
  let action: FailurePolicy["action"] = "inspect_outcome";
  if (source === "local") { outcome = "not_sent"; action = "fix_request"; }
  else if (["mcp_catalog", "tool_profiles", "model_settings", "status", "list_chats", "list_hosts", "history", "activity", "progress", "instruction_status", "rex_status", "rex_inspect", "login_status"].includes(command)) {
    outcome = "read_only";
    action = command === "history" && source === "remote" && code === "too_large" ? "reduce_page" : "retry_read";
  } else if (["admit", "create_task", "create_task_brief", "import_instructions"].includes(command)) {
    action = source === "remote" && ["conflict", "invalid", "settings_changed"].includes(code) ? "review_saved" : "retry_saved";
  } else if (command === "rex_open") action = "inspect_terminal";
  else if (["login_start", "login_reply", "login_cancel"].includes(command)) action = command === "login_reply" && source === "remote" && code === "conflict" ? "poll_login" : "observe_login";
  else if (["set_tool_profiles", "set_model_settings", "stop", "rex_startup"].includes(command)) action = "explicit_action";
  return { outcome, action, preserveDrafts: true, automaticMutationRetry: false };
}
