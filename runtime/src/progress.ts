import type { LiveState } from "@earendil-works/pi-durable";

export const PREVIEW_UNITS = 2048;
// A sampled projection, not an event cursor, answer receipt or execution tracker.
export function projectProgress(chatId: string, live: Readonly<LiveState> | undefined) {
  const base = { version: 1 as const, chatId, provisional: true as const };
  if (!live?.run) return base;
  const run = { ...base, runTaskId: String(live.run.taskId) };
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
  constructor(private readonly sanitize: (text: string) => string) {}
  reset() { this.last = undefined; }
  render(value: unknown, chatId: string): string | undefined {
    const progress = record(value);
    if (!progress || progress.version !== 1 || progress.chatId !== chatId || progress.provisional !== true) return;
    const generation = record(progress.generation);
    if (progress.generation !== undefined && (!generation || !id(progress.runTaskId) || !Number.isSafeInteger(generation.attempt) || Number(generation.attempt) < 1 || typeof generation.phase !== "string" || !["generating", "retrying", "deferred"].includes(generation.phase) || typeof generation.text !== "string")) return;
    const text = generation ? this.sanitize((generation.text as string).slice(-PREVIEW_UNITS)) : "";
    if (!text) {
      if (!this.last) return;
      this.reset(); return "assistant preview cleared; retained history remains authoritative.\n";
    }
    const snapshot = JSON.stringify({ runTaskId: progress.runTaskId, attempt: generation!.attempt, phase: generation!.phase, text,
      ...((generation!.textClipped === true || (generation!.text as string).length > PREVIEW_UNITS) ? { textClipped: true } : {}),
      ...(generation!.nonTextOmitted === true ? { nonTextOmitted: true } : {}),
      ...(Number.isSafeInteger(generation!.blocksOmitted) && Number(generation!.blocksOmitted) > 0 ? { blocksOmitted: generation!.blocksOmitted } : {}),
    });
    if (snapshot === this.last) return;
    this.last = snapshot;
    return `assistant preview (provisional snapshot): ${snapshot}\n`;
  }
}
