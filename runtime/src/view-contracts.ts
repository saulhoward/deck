// Read-view semantic guards. Generated schemas own shapes; these checks bind
// samples to requests and preserve legacy UTF-16 caps and Pi result consistency.
import * as wire from "./generated/contracts.js";
import { validSafePiId } from "./mutation-contracts.js";

export const PREVIEW_UNITS = 2048, TOOL_PREVIEW_UNITS = 512, TOOL_PREVIEW_LIMIT = 4;
export function validLiveArgs(value: unknown): value is wire.LiveViewArgs {
  return wire.validLiveViewArgs(value) && (value.chatId === undefined || validSafePiId(value.chatId));
}
export function validInstructionArgs(value: unknown): value is wire.InstructionStatusArgs {
  return wire.validInstructionStatusArgs(value) && (value.chatId === undefined || validSafePiId(value.chatId)) && (value.taskId === undefined || validSafePiId(value.taskId));
}
export function validViewArgs(command: string, args: unknown): boolean {
  if (command === "activity" || command === "progress") return validLiveArgs(args ?? {});
  if (command === "instruction_status") return validInstructionArgs(args ?? {});
  return true;
}
function scope(actual: string, expected?: string) { return validSafePiId(actual) && (expected === undefined || actual === expected); }
export function validActivity(value: unknown, chatId?: string): value is wire.ActivitySnapshot {
  return wire.validActivitySnapshot(value) && scope(value.chatId, chatId)
    && (value.runTaskId === undefined || validSafePiId(value.runTaskId))
    && value.tools.every((tool) => tool.callId.length <= 128 && tool.name.length <= 80 && (tool.taskId === undefined || validSafePiId(tool.taskId)));
}
export function validProgress(value: unknown, chatId?: string): value is wire.ProgressSnapshot {
  return wire.validProgressSnapshot(value) && scope(value.chatId, chatId)
    && (value.runTaskId === undefined || validSafePiId(value.runTaskId))
    && (!(value.generation || value.tools || value.toolSlotsOmitted) || value.runTaskId !== undefined)
    && (value.generation === undefined || value.generation.text.length <= PREVIEW_UNITS)
    && (value.tools === undefined || value.tools.every((tool) => validSafePiId(tool.taskId) && tool.text.length <= TOOL_PREVIEW_UNITS));
}
export function validSource(value: unknown): value is wire.InstructionSourceView {
  return wire.validInstructionSourceView(value) && validSafePiId(value.taskId) && value.cwd.startsWith("/") && value.cwd.length <= 256 && value.machineId.length <= 80;
}
export function validInstructionTask(value: unknown): value is wire.InstructionTaskView {
  if (!wire.validInstructionTaskView(value) || !validSafePiId(value.taskId)) return false;
  if (value.state !== "terminal") return value.outcome === undefined && value.result === undefined && value.resultOmitted === undefined;
  if (value.outcome === undefined) return false;
  if (value.outcome !== "completed") return value.result === undefined && value.resultOmitted === undefined;
  if ((value.result !== undefined) === (value.resultOmitted !== undefined)) return false;
  return value.result?.status !== "applied" || (validSource(value.result.source) && value.result.source.taskId === value.taskId);
}
export function validInstructions(value: unknown, chatId?: string, taskId?: string): value is wire.InstructionSnapshot {
  return wire.validInstructionSnapshot(value) && scope(value.chatId, chatId)
    && (value.source === null || validSource(value.source))
    && (value.sourceOmitted === undefined || value.source === null)
    && (value.import === null || validInstructionTask(value.import))
    && (taskId === undefined || (value.import !== null && value.import.taskId === taskId));
}
export function validViewReply(command: string, value: unknown, args: unknown): boolean {
  const request = args ?? {};
  if (command === "activity" || command === "progress") return validLiveArgs(request) && (command === "activity" ? validActivity(value, request.chatId) : validProgress(value, request.chatId));
  if (command === "instruction_status") return validInstructionArgs(request) && validInstructions(value, request.chatId, request.taskId);
  return true;
}
export function validHistoryViews(page: wire.HistoryPage, args: wire.HistoryArgs): boolean {
  return (page.activity === undefined || (args.includeActivity === true && validActivity(page.activity, args.chatId)))
    && (page.progress === undefined || (args.includeProgress === true && validProgress(page.progress, args.chatId)))
    && (page.instructions === undefined || (args.includeInstructions === true && validInstructions(page.instructions, args.chatId)));
}
