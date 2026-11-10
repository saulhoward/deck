// Bounded, text-free public projection. No Pi/worker runtime is loaded by the client.
import { validSafePiId } from "./mutation-contracts.js";
import { validInstructionTaskState, validInstructionOutcome, validInstructionRejection, type InstructionSourceView, type InstructionResultView, type InstructionTaskView, type InstructionSnapshot } from "./generated/contracts.js";
import { validSource, validInstructionTask, validInstructions } from "./view-contracts.js";
import { prefixUnits } from "./view-text.js";
import type { JsonValue } from "@earendil-works/chord";
import type { TaskRecord } from "@earendil-works/pi-durable";
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
export const validInstructionId = validSafePiId;
// Domain projection may omit invalid/private stored data; wire ingress below
// never normalizes a malformed sample into a valid one.
function sourceView(value: unknown): InstructionSourceView | undefined {
  const source = object(value);
  if (!source || typeof source.machineId !== "string" || typeof source.cwd !== "string") return;
  const projected = { machineId: prefixUnits(source.machineId, 80), cwd: prefixUnits(source.cwd, 256), path: source.path, sha256: source.sha256, bytes: source.bytes, taskId: source.taskId, ...(source.machineId.length > 80 || source.cwd.length > 256 || source.labelsClipped === true ? { labelsClipped: true } : {}) };
  return validSource(projected) ? projected : undefined;
}
function resultView(value: unknown): InstructionResultView | undefined {
  const result = object(value); if (!result) return;
  if (result.status === "applied") { const source = sourceView(result.source); if (source) return { status: "applied" as const, source }; }
  if (result.status === "aborted") return { status: "aborted" as const };
  if (result.status === "rejected" && validInstructionRejection(result.reason)) return { status: "rejected" as const, reason: result.reason };
}
function importView(value: unknown): InstructionTaskView | undefined {
  const task = object(value);
  if (!task || !validInstructionId(task.taskId) || !validInstructionTaskState(task.state)) return;
  const outcome = task.state === "terminal" && validInstructionOutcome(task.outcome) ? task.outcome : undefined;
  const projected = outcome === "completed" ? resultView(task.result) : undefined;
  const result = projected?.status === "applied" && projected.source.taskId !== task.taskId ? undefined : projected;
  const view = { taskId: task.taskId, state: task.state, ...(task.abortRequested === true ? { abortRequested: true } : {}), ...(outcome ? { outcome } : {}), ...(result ? { result } : {}), ...(outcome === "completed" && !result ? { resultOmitted: true } : {}) };
  return validInstructionTask(view) ? view : undefined;
}
export function projectInstructionTask(task: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined): InstructionTaskView | null {
  if (!task) return null;
  const view = importView({ taskId: String(task.id), state: task.state.status, abortRequested: task.abortRequested, ...(task.state.status === "terminal" ? { outcome: task.state.outcome.status, ...(task.state.outcome.status === "completed" ? { result: task.state.outcome.result } : {}) } : {}) });
  if (!view) throw new Error("Invalid instruction task projection");
  return view;
}
export function instructionSnapshot(chatId: string, source: unknown, task: ReturnType<typeof projectInstructionTask>): InstructionSnapshot {
  const projected = sourceView(source);
  return { version: 1 as const, chatId, source: projected ?? null, import: task, ...(source && !projected ? { sourceOmitted: true } : {}) };
}
export class InstructionsDisplay {
  private last: string | undefined;
  reset() { this.last = undefined; }
  render(raw: unknown, chatId: string, force = false): string {
    if (!validInstructions(raw, chatId)) return "";
    // Canonical display ordering preserves deduplication across JSON key order
    // changes. Validation ran first; this never repairs an invalid wire sample.
    const source = raw.source === null ? null : sourceView(raw.source)!;
    const task = raw.import === null ? null : importView(raw.import)!;
    const snapshot = { version: 1, chatId, source, import: task, ...(raw.sourceOmitted === true ? { sourceOmitted: true } : {}) };
    const key = JSON.stringify(snapshot); const initial = this.last === undefined;
    if (!force && key === this.last) return "";
    this.last = key;
    if (!force && initial && !source && !task && !snapshot.sourceOmitted) return "";
    // JSON escapes C0 controls, but not DEL/C1 terminal controls in labels.
    const printable = key.replace(/[\x7f-\x9f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return `instructions (current source + import task): ${printable}\n`;
  }
}
