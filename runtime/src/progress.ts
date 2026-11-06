import type { LiveState } from "@earendil-works/pi-durable";

export const PREVIEW_UNITS = 2048;
export const TOOL_PREVIEW_UNITS = 512;
export const TOOL_PREVIEW_LIMIT = 4;

function toolProgress(live: Readonly<LiveState>) {
  const tools: { taskId: string; name: "bash"; text: string; textClipped?: true; lossyUtf8?: true }[] = [];
  // Only our explicitly marked native-bash details, never generic output/details
  // (which may contain arguments, diagnostics or private extension state).
  const primary = live.tools ?? []; const nested = live.nestedTools ?? [];
  for (const slot of [...primary.slice(-32), ...nested.slice(-32)]) {
    const value = record(slot.details); const taskId = String(slot.taskId);
    if (slot.status !== "running" || slot.name !== "bash" || !id(taskId) || value?.kind !== "deck.bash-progress" || value.version !== 1 || value.provisional !== true || value.operationId !== taskId || typeof value.output !== "string" || typeof value.truncated !== "boolean" || typeof value.lossyUtf8 !== "boolean" || !value.output) continue;
    tools.push({ taskId, name: "bash", text: value.output.slice(-TOOL_PREVIEW_UNITS),
      ...(value.truncated || value.output.length > TOOL_PREVIEW_UNITS ? { textClipped: true as const } : {}), ...(value.lossyUtf8 ? { lossyUtf8: true as const } : {}),
    });
  }
  return { ...(tools.length ? { tools: tools.slice(-TOOL_PREVIEW_LIMIT) } : {}),
    ...(primary.length > 32 || nested.length > 32 || tools.length > TOOL_PREVIEW_LIMIT ? { toolSlotsOmitted: true as const } : {}),
  };
}
export type ProgressSnapshot = {
  version: 1; chatId: string; provisional: true; runTaskId?: string;
  tools?: { taskId: string; name: "bash"; text: string; textClipped?: true; lossyUtf8?: true }[]; toolSlotsOmitted?: true;
  generation?: { attempt: number; phase: string; text: string; textClipped?: true; blocksOmitted?: number; nonTextOmitted?: true };
};
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
    text = (text + separator + part.text.slice(-PREVIEW_UNITS)).slice(-PREVIEW_UNITS);
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
function id(value: unknown): value is string { return typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value)); }

// Plain mode prints self-contained, one-line snapshots. Never infer append-only
// deltas from a clipped/replaced partial or hide the later canonical answer.
export class ProgressDisplay {
  private last: string | undefined;
  private lastTools: string | undefined;
  constructor(private readonly sanitize: (text: string) => string) {}
  reset() { this.last = undefined; this.lastTools = undefined; }
  render(value: unknown, chatId: string): string | undefined {
    const progress = record(value);
    if (!progress || progress.version !== 1 || progress.chatId !== chatId || progress.provisional !== true) return;
    const generation = record(progress.generation);
    if (progress.generation !== undefined && (!generation || !id(progress.runTaskId) || !Number.isSafeInteger(generation.attempt) || Number(generation.attempt) < 1 || typeof generation.phase !== "string" || !["generating", "retrying", "deferred"].includes(generation.phase) || typeof generation.text !== "string")) return;
    const text = generation ? this.sanitize((generation.text as string).slice(-PREVIEW_UNITS)) : "";
    const lines: string[] = [];
    if (!text) {
      if (this.last) { this.last = undefined; lines.push("assistant preview cleared; retained history remains authoritative.\n"); }
    } else {
      const snapshot = JSON.stringify({ runTaskId: progress.runTaskId, attempt: generation!.attempt, phase: generation!.phase, text,
        ...((generation!.textClipped === true || (generation!.text as string).length > PREVIEW_UNITS) ? { textClipped: true } : {}),
        ...(generation!.nonTextOmitted === true ? { nonTextOmitted: true } : {}),
        ...(Number.isSafeInteger(generation!.blocksOmitted) && Number(generation!.blocksOmitted) > 0 ? { blocksOmitted: generation!.blocksOmitted } : {}),
      });
      if (snapshot !== this.last) { this.last = snapshot; lines.push(`assistant preview (provisional snapshot): ${snapshot}\n`); }
    }
    const tools = progress.tools;
    // Ignore malformed additions rather than turning them into a clearing claim.
    if (tools === undefined || (id(progress.runTaskId) && Array.isArray(tools) && tools.length <= TOOL_PREVIEW_LIMIT && tools.every((raw) => {
      const tool = record(raw); return tool && id(tool.taskId) && tool.name === "bash" && typeof tool.text === "string";
    }))) {
      const projected = (tools as Record<string, unknown>[] | undefined)?.map((tool) => ({ taskId: tool.taskId, name: "bash", text: this.sanitize((tool.text as string).slice(-TOOL_PREVIEW_UNITS)),
        ...(tool.textClipped === true || (tool.text as string).length > TOOL_PREVIEW_UNITS ? { textClipped: true } : {}), ...(tool.lossyUtf8 === true ? { lossyUtf8: true } : {}),
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
