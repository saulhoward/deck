// Bounded, text-free public projection. No Pi/worker runtime is loaded by the client.
import { validSafePiId } from "./mutation-contracts.js";
import type { InstructionSource } from "./instruction-import.js";
import type { JsonValue } from "@earendil-works/chord";
import type { TaskRecord } from "@earendil-works/pi-durable";
const states = ["pending", "running", "waiting", "sleeping", "completing", "terminal"];
const outcomes = ["completed", "failed", "aborted", "orphaned"];
const reasons = ["offline", "unavailable", "read_failed", "effect_uncertain", "invalid", "too_large", "settings_changed", "busy"];
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
export const validInstructionId = validSafePiId;
type SourceView = InstructionSource & { labelsClipped?: true };
function sourceView(value: unknown): SourceView | undefined {
  const source = object(value);
  if (!source || typeof source.machineId !== "string" || !source.machineId || typeof source.cwd !== "string" || !source.cwd.startsWith("/") || source.path !== "AGENTS.md" || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isInteger(source.bytes) || Number(source.bytes) < 0 || Number(source.bytes) > 32768 || !validInstructionId(source.taskId)) return;
  return { machineId: source.machineId.slice(0, 80), cwd: source.cwd.slice(0, 256), path: "AGENTS.md", sha256: source.sha256, bytes: Number(source.bytes), taskId: source.taskId, ...(source.machineId.length > 80 || source.cwd.length > 256 || source.labelsClipped === true ? { labelsClipped: true } : {}) };
}
function resultView(value: unknown) {
  const result = object(value); if (!result) return;
  if (result.status === "applied") { const source = sourceView(result.source); if (source) return { status: "applied" as const, source }; }
  if (result.status === "aborted") return { status: "aborted" as const };
  if (result.status === "rejected" && typeof result.reason === "string" && reasons.includes(result.reason)) return { status: "rejected" as const, reason: result.reason };
}
function importView(value: unknown) {
  const task = object(value);
  if (!task || !validInstructionId(task.taskId) || typeof task.state !== "string" || !states.includes(task.state)) return;
  const outcome = task.state === "terminal" && typeof task.outcome === "string" && outcomes.includes(task.outcome) ? task.outcome : undefined;
  const projected = outcome === "completed" ? resultView(task.result) : undefined;
  const result = projected?.status === "applied" && projected.source.taskId !== task.taskId ? undefined : projected;
  return { taskId: task.taskId, state: task.state, ...(task.abortRequested === true ? { abortRequested: true } : {}), ...(outcome ? { outcome } : {}), ...(result ? { result } : {}), ...(task.resultOmitted === true || (outcome === "completed" && !result) ? { resultOmitted: true } : {}) };
}
export function projectInstructionTask(task: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined) {
  if (!task) return null;
  return importView({ taskId: String(task.id), state: task.state.status, abortRequested: task.abortRequested, ...(task.state.status === "terminal" ? { outcome: task.state.outcome.status, ...(task.state.outcome.status === "completed" ? { result: task.state.outcome.result } : {}) } : {}) })!;
}
export function instructionSnapshot(chatId: string, source: unknown, task: ReturnType<typeof projectInstructionTask>) {
  const projected = sourceView(source);
  return { version: 1 as const, chatId, source: projected ?? null, import: task, ...(source && !projected ? { sourceOmitted: true } : {}) };
}
export class InstructionsDisplay {
  private last: string | undefined;
  reset() { this.last = undefined; }
  render(raw: unknown, chatId: string, force = false): string {
    const value = object(raw);
    if (!value || value.version !== 1 || value.chatId !== chatId || !validInstructionId(chatId)) return "";
    const source = value.source === null ? null : sourceView(value.source);
    const task = value.import === null ? null : importView(value.import);
    if (source === undefined || task === undefined) return "";
    const snapshot = { version: 1, chatId, source, import: task, ...(value.sourceOmitted === true ? { sourceOmitted: true } : {}) };
    const key = JSON.stringify(snapshot); const initial = this.last === undefined;
    if (!force && key === this.last) return "";
    this.last = key;
    if (!force && initial && !source && !task && !snapshot.sourceOmitted) return "";
    return `instructions (current source + import task): ${key}\n`;
  }
}
