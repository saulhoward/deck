import * as wire from "./generated/contracts.js";
import { validSafePiId, type ReplyContext } from "./mutation-contracts.js";

export const thinkingLevels: readonly wire.ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function sameSelection(a: wire.ModelSelection, b: wire.ModelSelection): boolean {
  return a.provider === b.provider && a.modelId === b.modelId && a.thinkingLevel === b.thinkingLevel;
}
export function validModelSettingsArgs(command: string, value: unknown): boolean {
  if (command === "model_settings") return wire.validModelSettingsArgs(value) && validSafePiId(value.chatId);
  if (command === "set_model_settings") return wire.validSetModelSettingsArgs(value) && validSafePiId(value.chatId);
  return true;
}
export function validModelSettingsSnapshot(value: unknown): value is wire.ModelSettingsSnapshot {
  if (!wire.validModelSettingsSnapshot(value) || !validSafePiId(value.chatId)) return false;
  const ids = new Set<string>();
  return value.models.every((m) => {
    const id = JSON.stringify([m.provider, m.modelId]);
    if (ids.has(id) || !m.thinkingLevels.includes(m.defaultThinkingLevel)) return false;
    ids.add(id);
    return m.thinkingLevels.every((level, i) => i === 0 || thinkingLevels.indexOf(level) > thinkingLevels.indexOf(m.thinkingLevels[i - 1]!));
  });
}
export function validModelSettingsReply(request: ReplyContext, value: unknown): boolean {
  if (!["model_settings", "set_model_settings"].includes(request.command)) return true;
  if (!validModelSettingsArgs(request.command, request.args) || request.hubId === undefined) return false;
  const args = request.args as wire.SetModelSettingsArgs;
  if (request.command === "model_settings") return validModelSettingsSnapshot(value) && value.hubId === request.hubId && value.chatId === args.chatId;
  return wire.validModelSettingsAck(value) && value.hubId === request.hubId && value.chatId === args.chatId && sameSelection(value.selection, args.selection);
}
