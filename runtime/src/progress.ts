import type { LiveState } from "@earendil-works/pi-durable";

import type { ProgressSnapshot, ProgressTool } from "./generated/contracts.js";
import { PREVIEW_UNITS, TOOL_PREVIEW_UNITS, TOOL_PREVIEW_LIMIT, validProgress } from "./view-contracts.js";
import { validSafePiId as id } from "./mutation-contracts.js";
import { tailUnits } from "./view-text.js";
export { PREVIEW_UNITS, TOOL_PREVIEW_UNITS, TOOL_PREVIEW_LIMIT } from "./view-contracts.js";
export type { ProgressSnapshot } from "./generated/contracts.js";

function toolProgress(live: Readonly<LiveState>) {
  const tools: ProgressTool[] = [];
  // Only our explicitly marked native-bash details, never generic output/details
  // (which may contain arguments, diagnostics or private extension state).
  const primary = live.tools ?? []; const nested = live.nestedTools ?? [];
  for (const slot of [...primary.slice(-32), ...nested.slice(-32)]) {
    const value = record(slot.details); const taskId = String(slot.taskId);
    if (slot.status !== "running" || slot.name !== "bash" || !id(taskId) || value?.kind !== "deck.bash-progress" || value.version !== 1 || value.provisional !== true || value.operationId !== taskId || typeof value.output !== "string" || typeof value.truncated !== "boolean" || typeof value.lossyUtf8 !== "boolean" || !value.output) continue;
    tools.push({ taskId, name: "bash", text: tailUnits(value.output, TOOL_PREVIEW_UNITS),
      ...(value.truncated || value.output.length > TOOL_PREVIEW_UNITS ? { textClipped: true as const } : {}), ...(value.lossyUtf8 ? { lossyUtf8: true as const } : {}),
    });
  }
  return { ...(tools.length ? { tools: tools.slice(-TOOL_PREVIEW_LIMIT) } : {}),
    ...(primary.length > 32 || nested.length > 32 || tools.length > TOOL_PREVIEW_LIMIT ? { toolSlotsOmitted: true as const } : {}),
  };
}
// A sampled projection, not an event cursor, answer receipt or execution tracker.
export function projectProgress(chatId: string, live: Readonly<LiveState> | undefined): ProgressSnapshot {
  const base = { version: 1 as const, chatId, provisional: true as const };
  if (!live?.run) return base;
  const run = { ...base, runTaskId: String(live.run.taskId), ...toolProgress(live) };
  if (!live.generation) return run;
  const generation = live.generation;
  let text = ""; let units = 0; let nonTextOmitted = false;
  const message = generation.message;
  // Provider error/abort metadata and hidden reasoning never enter this view.
  const parts = message && message.stopReason !== "error" && message.stopReason !== "aborted" ? message.content : [];
  const blocksOmitted = Math.max(0, parts.length - 128);
  for (let index = blocksOmitted; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.type !== "text") { nonTextOmitted = true; continue; }
    const separator = units ? "\n" : "";
    units += separator.length + part.text.length;
    text = tailUnits(text + separator + tailUnits(part.text, PREVIEW_UNITS), PREVIEW_UNITS);
  }
  return { ...run, generation: {
    attempt: generation.attempt, phase: generation.retry ? "retrying" : generation.deferred ? "deferred" : "generating",
    text, ...(units > text.length ? { textClipped: true } : {}),
    ...(blocksOmitted ? { blocksOmitted } : {}), ...(nonTextOmitted ? { nonTextOmitted: true } : {}),
  } };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Plain mode prints self-contained, one-line snapshots. Never infer append-only
// deltas from a clipped/replaced partial or hide the later canonical answer.
export class ProgressDisplay {
  private last: string | undefined;
  private lastTools: string | undefined;
  constructor(private readonly sanitize: (text: string) => string) {}
  reset() { this.last = undefined; this.lastTools = undefined; }
  render(value: unknown, chatId: string): string | undefined {
    if (!validProgress(value, chatId)) return; // Invalid samples never clear display state.
    const progress = value, generation = progress.generation;
    const text = generation ? this.sanitize(generation.text) : "";
    const lines: string[] = [];
    if (!text) {
      if (this.last) { this.last = undefined; lines.push("assistant preview cleared; retained history remains authoritative.\n"); }
    } else {
      const snapshot = JSON.stringify({ runTaskId: progress.runTaskId, attempt: generation!.attempt, phase: generation!.phase, text,
        ...(generation!.textClipped === true ? { textClipped: true } : {}),
        ...(generation!.nonTextOmitted === true ? { nonTextOmitted: true } : {}),
        ...(Number.isSafeInteger(generation!.blocksOmitted) && Number(generation!.blocksOmitted) > 0 ? { blocksOmitted: generation!.blocksOmitted } : {}),
      });
      if (snapshot !== this.last) { this.last = snapshot; lines.push(`assistant preview (provisional snapshot): ${snapshot}\n`); }
    }
    const tools = progress.tools;
    {
      const projected = tools?.map((tool) => ({ taskId: tool.taskId, name: "bash", text: this.sanitize(tool.text),
        ...(tool.textClipped === true ? { textClipped: true } : {}), ...(tool.lossyUtf8 === true ? { lossyUtf8: true } : {}),
      })).filter((tool) => tool.text);
      const snapshot = projected?.length ? JSON.stringify({ runTaskId: progress.runTaskId, tools: projected, ...(progress.toolSlotsOmitted === true ? { toolSlotsOmitted: true } : {}) }) : undefined;
      if (snapshot !== this.lastTools) {
        if (snapshot) lines.push(`bash output preview (provisional snapshot): ${snapshot}\n`);
        else if (this.lastTools) lines.push("bash output preview cleared; retained tool results remain authoritative.\n");
        this.lastTools = snapshot;
      }
    }
    return lines.length ? lines.join("") : undefined;
  }
}
