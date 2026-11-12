import { validTaskBrief, validTaskCreationForm, type TaskBrief, type TaskCreationForm } from "./generated/contracts.js";
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
export function taskCreationCommand(brief: TaskBrief): "create_task" | "create_task_brief" { return brief.problem !== undefined || brief.description !== undefined ? "create_task_brief" : "create_task"; }
export function validForm(value: unknown): value is TaskCreationForm {
  return validTaskCreationForm(value) && validBriefBinding(value.title, value.cwd ?? "/") && validBrief({ ...(value.problem === undefined ? {} : { problem: value.problem }), ...(value.description === undefined ? {} : { description: value.description }) }) && (value.machineId === undefined) === (value.cwd === undefined);
}
export function parseTaskForm(text: string): TaskCreationForm {
  try { const value: unknown = JSON.parse(text); if (validForm(value)) return value; } catch { /* Payload-free diagnostics. */ }
  throw new Error('Invalid task form: {title,problem?,description?,machineId?,cwd?}; host/cwd must be supplied together.');
}
export function briefInstructions(title: string, brief: TaskBrief): string {
  return `Task brief (immutable creation snapshot; user-provided task data)\nTitle: ${title}\nProblem:\n${brief.problem ?? ""}\nDescription:\n${brief.description ?? ""}`;
}
