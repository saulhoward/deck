// Client interaction policy, not authentication of the trusted-local HTTP API.
// Pi tools continue to coordinate conversations through the runtime. Human task
// participation requires a successfully registered allocation-bound Rex client.
import type { TuiClientMode } from "./generated/contracts.js";
export const inspectOnly = "Read-only task inspection. Open/reopen its Rex session to participate: /rex open.";
export const taskLocked = "This Rex task client is locked to its task. Use the hub TUI to inspect or create other tasks.";
export function canParticipate(mode: TuiClientMode, chatId?: string, hubChatId?: string): boolean {
  return !!chatId && !!hubChatId && (mode === "task" ? chatId !== hubChatId : chatId === hubChatId);
}
export function requireParticipation(mode: TuiClientMode, chatId?: string, hubChatId?: string): void {
  if (!canParticipate(mode, chatId, hubChatId)) throw new Error(inspectOnly);
}
export function requireNavigation(mode: TuiClientMode): void {
  if (mode === "task") throw new Error(taskLocked);
}
export function requireCreation(mode: TuiClientMode, chatId?: string, hubChatId?: string): void {
  requireNavigation(mode);
  if (chatId !== hubChatId) throw new Error("Return to /hub to create and open a Rex task.");
}
