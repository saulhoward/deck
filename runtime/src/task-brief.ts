import { validTaskBrief, validTaskCreationForm, validPiId, type TaskBrief, type TaskCreationForm } from "./generated/contracts.js";
export function validBrief(value: unknown): value is TaskBrief {
  return validTaskBrief(value) && [value.problem, value.description].every((s, i) => s === undefined || (s.isWellFormed() && Buffer.byteLength(s) <= (i === 0 ? 2048 : 8192)));
}
export function briefFields(value: TaskBrief): TaskBrief {
  const brief = { ...(value.problem === undefined ? {} : { problem: value.problem }), ...(value.description === undefined ? {} : { description: value.description }) };
  if (!validBrief(brief)) throw new Error("Task brief exceeds bounds (problem 2048, description 8192 UTF-8 bytes)");
  return brief;
}
export function validBriefBinding(title: string, cwd: string): boolean {
  return title.isWellFormed() && !!title.trim() && Buffer.byteLength(title) <= 200 && cwd.isWellFormed() && cwd.startsWith("/") && !cwd.includes("\0") && Buffer.byteLength(cwd) <= 4096;
}
export function taskCreationCommand(brief: TaskBrief & { managedParentChatId?: string }): "create_task" | "create_task_brief" | "create_managed_child" { return brief.managedParentChatId !== undefined ? "create_managed_child" : brief.problem !== undefined || brief.description !== undefined ? "create_task_brief" : "create_task"; }
export function validForm(value: unknown): value is TaskCreationForm {
  return validTaskCreationForm(value) && validBriefBinding(value.title, value.cwd ?? "/") && validBrief({ ...(value.problem === undefined ? {} : { problem: value.problem }), ...(value.description === undefined ? {} : { description: value.description }) }) && (value.machineId === undefined) === (value.cwd === undefined) &&
    (value.managedParentChatId === undefined || (validPiId(value.managedParentChatId) && Number.isSafeInteger(Number(value.managedParentChatId)) && value.machineId === undefined && value.cwd === undefined));
}
// Shared by plain/TUI recovery: managed requests never send decorative or stale
// host/cwd fields, and keep their original parent rather than current selection.
export function taskCreationArgs(value: TaskBrief & { requestId: string; title: string; machineId?: string; cwd?: string; managedParentChatId?: string }): Record<string, unknown> {
  return { requestId: value.requestId, title: value.title, ...(value.managedParentChatId !== undefined ? { parentChatId: value.managedParentChatId } : { machineId: value.machineId, cwd: value.cwd }), ...briefFields(value) };
}
export function parseTaskForm(text: string): TaskCreationForm {
  try { const value: unknown = JSON.parse(text); if (validForm(value)) return value; } catch { /* Payload-free diagnostics. */ }
  throw new Error('Invalid task form: {title,problem?,description?,machineId?,cwd?} or {title,managedParentChatId,problem?,description?}; host/cwd must be supplied together.');
}
export function briefInstructions(title: string, brief: TaskBrief): string {
  return `Task brief (immutable creation snapshot; user-provided task data)\nTitle: ${title}\nProblem:\n${brief.problem ?? ""}\nDescription:\n${brief.description ?? ""}`;
}
