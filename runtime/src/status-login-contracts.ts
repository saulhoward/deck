import { validBrief } from "./task-brief.js";
import * as wire from "./generated/contracts.js";
import { validSafePiId, type ReplyContext } from "./mutation-contracts.js";

export function validStatusArgs(value: unknown): value is wire.StatusArgs {
  return wire.validStatusArgs(value) && (value.chatId === undefined || validSafePiId(value.chatId));
}
export function validLoginArgs(command: string, value: unknown): boolean {
  switch (command) {
    case "login_start": return wire.validLoginStartArgs(value) && value.requestId.length <= 200_000;
    case "login_status": return wire.validLoginStatusArgs(value);
    case "login_cancel": return wire.validLoginCancelArgs(value) && value.loginId.length <= 200_000;
    case "login_reply": return wire.validLoginReplyArgs(value) && [value.loginId, value.promptId, value.answer].every((text) => text.length <= 200_000);
    default: return true;
  }
}
export function validStatusLoginArgs(command: string, value: unknown): boolean {
  return command === "status" ? validStatusArgs(value) : validLoginArgs(command, value);
}
export function validLoginSnapshot(value: unknown): value is wire.LoginSnapshot {
  if (!wire.validLoginSnapshot(value)) return false;
  if ("id" in value && value.id.length > 200_000) return false;
  if (value.status === "pending" && value.prompt) {
    if (value.prompt.id.length > 200_000) return false;
    if (value.prompt.type === "select" && (new Set(value.prompt.options.map((option) => option.id)).size !== value.prompt.options.length || value.prompt.options.some((option) => option.id.length > 200_000))) return false;
  }
  return true;
}
export function validStatusLoginReply(request: ReplyContext, value: unknown): boolean {
  const { command } = request, args = request.args ?? {};
  if (!validStatusLoginArgs(command, args)) return false;
  switch (command) {
    case "status": {
      if (!wire.validStatusSnapshot(value) || !validSafePiId(value.mainChatId) || !validSafePiId(value.chatId) || value.hubId.length > 200) return false;
      if (value.chatId !== ((args as wire.StatusArgs).chatId ?? value.mainChatId) || (request.hubId !== undefined && request.hubId !== value.hubId)) return false;
      if (!["offline", "native-files + bash"].includes(value.tools)) return false;
      if (value.provider !== undefined && value.model?.provider !== undefined && value.provider !== value.model.provider) return false;
      const binding = value.binding;
      return !binding || ((binding.brief === undefined || validBrief(binding.brief)) && (binding.parentChatId === undefined) === (binding.ownerTaskId === undefined) && (binding.parentChatId === undefined || (validSafePiId(binding.parentChatId) && validSafePiId(binding.ownerTaskId))));
    }
    case "login_start": return validLoginSnapshot(value) && "id" in value && value.id === (args as wire.LoginStartArgs).requestId;
    case "login_status": return validLoginSnapshot(value);
    case "login_reply": return wire.validLoginReplyAck(value);
    case "login_cancel": return wire.validLoginCancelAck(value);
    default: return true;
  }
}
