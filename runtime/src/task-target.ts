import { validForm } from "./task-brief.js";
import { isAbsolute } from "node:path";
import { validTaskCreationTarget, type TaskCreationTarget } from "./generated/contracts.js";
export function validTaskTarget(value: unknown): value is TaskCreationTarget {
  return validTaskCreationTarget(value) && validForm(value) && isAbsolute(value.cwd) && !value.cwd.includes("\0") && Buffer.byteLength(value.cwd) <= 4096 && Buffer.byteLength(value.title) <= 200 && value.title.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").length > 0;
}
export function parseTaskTarget(text: string): TaskCreationTarget {
  try { const value: unknown = JSON.parse(text); if (validTaskTarget(value)) return value; } catch { /* No private payload in parse errors. */ }
  throw new Error('Use /task-at {"machineId":"32 hex ID","cwd":"/absolute/path","title":"Task title"}');
}
