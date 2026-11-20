// Read-only, parent-scoped adapter. Nested reads retain their normal validators;
// the outer selector never becomes general child mutation/navigation authority.
import * as wire from "./generated/contracts.js";
import { validSafePiId, type ReplyContext } from "./mutation-contracts.js";
import { validHistoryArgs, validHistoryPage } from "./history-contracts.js";
import { validViewArgs, validViewReply } from "./view-contracts.js";
import { validStatusLoginArgs, validStatusLoginReply } from "./status-login-contracts.js";
import { validModelSettingsArgs, validModelSettingsReply } from "./model-settings-contracts.js";
export function subagentReadArgs(args: wire.SubagentViewArgs, childId: string): Record<string, unknown> {
  return { ...(args.options as Record<string, unknown> | undefined), chatId: childId };
}
export function validSubagentViewArgs(value: unknown): value is wire.SubagentViewArgs {
  if (!wire.validSubagentViewArgs(value) || !validSafePiId(value.chatId) || (value.name === undefined) === (value.childId === undefined)) return false;
  if (value.childId !== undefined && (!validSafePiId(value.childId) || Number(value.childId) <= Number(value.chatId))) return false;
  const options = value.options;
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options) || Object.hasOwn(options, "chatId"))) return false;
  const keys = value.operation === "history" ? ["limit", "before", "after", "includeActivity", "includeProgress", "includeInstructions", "includeAgentStatus", "includeSubagents"] : value.operation === "activity" ? ["includeAgentStatus", "includeSubagents"] : [];
  if (options !== undefined && Object.keys(options).some(key => !keys.includes(key))) return false;
  const args = subagentReadArgs(value, value.childId ?? "1");
  return (value.operation !== "history" || validHistoryArgs(args)) && validViewArgs(value.operation, args) && validStatusLoginArgs(value.operation, args) && validModelSettingsArgs(value.operation, args);
}
export function validSubagentViewReply(request: ReplyContext, value: unknown): boolean {
  if (request.command !== "subagent_view") return true;
  const args = request.args;
  if (!validSubagentViewArgs(args) || !wire.validSubagentViewReply(value) || !request.hubId || value.hubId !== request.hubId || value.parentChatId !== args.chatId || value.operation !== args.operation || value.name !== args.name || !validSafePiId(value.childId) || Number(value.childId) <= Number(args.chatId) || (args.childId !== undefined && value.childId !== args.childId)) return false;
  if (Buffer.byteLength(JSON.stringify(value)) >= 1024 * 1024) return false;
  const nested = { command: args.operation, args: subagentReadArgs(args, value.childId), hubId: value.hubId };
  if (args.operation === "status" && (!wire.validStatusSnapshot(value.result) || value.result.binding?.kind !== "subagent" || value.result.binding.parentChatId !== args.chatId || !validSafePiId(value.result.binding.ownerTaskId) || value.result.activity !== undefined)) return false;
  return (args.operation !== "history" || validHistoryPage(value.result, nested.args)) && validStatusLoginReply(nested, value.result) && validViewReply(nested.command, value.result, nested.args) && validModelSettingsReply(nested, value.result);
}
