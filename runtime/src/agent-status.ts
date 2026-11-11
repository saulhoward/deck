// Bounded read-only projection of existing Pi records, not another scheduler,
// completion log, health cache or effect receipt.
import type { ConversationId, EntryId, Tx } from "@earendil-works/pi-durable";
import type { AgentStatus } from "./generated/contracts.js";
import { unfinished } from "./instruction-import.js";

export async function agentStatus(tx: Tx, id: ConversationId, queued: boolean): Promise<AgentStatus> {
  // Reuse the inbox sample; never acquire/create Pi documents just for display.
  // Task scans and the latest generation are read on one Pi transaction line.
  // Like any activity observation this can be superseded by a concurrent input.
  let working = queued;
  for (const status of unfinished) {
    if ((await tx.scanTasks({ conversationId: id, status }, 1)).items.length) { working = true; break; }
  }
  const resting: AgentStatus = { state: working ? "working" : "idle" };
  const latest = (await tx.scanTasks({ conversationId: id, kind: "pi.generation", order: "descending" }, 1)).items[0];
  if (!latest) return resting;
  if (latest.state.status !== "terminal") return { state: "working" };
  const outcome = latest.state.outcome;
  const settled = (state: "done" | "error"): AgentStatus => working ? { state: "working", ...(state === "done" ? { settledTaskId: String(latest.id) } : {}) } : { state, taskId: String(latest.id) };
  if (outcome.status === "failed" || outcome.status === "faulted" || outcome.status === "orphaned") return settled("error");
  if (outcome.status === "completed") {
    const result = outcome.result;
    const entryId = result && typeof result === "object" && !Array.isArray(result) ? result.entryId : undefined;
    // A completed task without a canonical assistant result isn't a ready answer.
    if (typeof entryId === "number" && Number.isSafeInteger(entryId) && entryId > 0) {
      const entry = await tx.entry(entryId as EntryId);
      if (entry?.conversationId === id && entry.kind === "pi.assistant") return settled("done");
    }
  }
  // Explicit cancellation is idle, never success or failure.
  return resting;
}
