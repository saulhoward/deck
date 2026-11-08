import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type TaskId } from "@earendil-works/pi-durable";
import { ChatDoc, DeckError, type DeckRuntime } from "./deck.js";
import { REX_KIND, RexDoc, sameRexBinding, type RexInput, type RexBinding } from "./rex-allocation.js";
import { validRexAllocationPlan, validRexInspectionQuery, validRexInspectionObservation, validRexInspectionSnapshot, type RexInspectionQuery, type RexInspectionObservation, type RexInspectionSnapshot } from "./generated/contracts.js";
import type { HostFiles } from "./host-files.js";
import { RECONCILE_KIND, reconciledBinding } from "./rex-reconciliation.js";

// In-flight read bookkeeping only; no health cache, task, receipt or replay queue.
export class RexInspector {
  private readonly active = new Set<string>();
  private nextId = 1n << 63n; // Disjoint from Pi safe-integer operation/task IDs.
  constructor(private readonly runtime: DeckRuntime, private readonly host?: HostFiles) {}
  async inspect(id: string, signal?: AbortSignal): Promise<RexInspectionSnapshot> {
    const runtime = this.runtime; const chat = await runtime.chat(id);
    if (this.active.has(id) || this.active.size >= 4) throw new DeckError("busy", "Rex inspection capacity reached; retry the read later");
    this.active.add(id);
    const startedAtMs = Math.max(0, Date.now()); const requestId = randomUUID();
    let taskId: string | null = null; let changed = false;
    const unsubscribe = runtime.harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === "conversation" && change.value.id === chat.id) changed = true;
        if (change.type === "task" && change.value.conversationId === chat.id && [REX_KIND, RECONCILE_KIND].includes(change.value.kind)) changed = true;
        if ((change.type === "document" || change.type === "document.copy") && change.conversationId === chat.id && [RexDoc.definition.kind, ChatDoc.definition.kind, AgentDoc.definition.kind].includes(change.record.kind)) changed = true;
      }
    });
    const finish = (status: RexInspectionSnapshot["status"], observation: RexInspectionObservation | null = null): RexInspectionSnapshot => {
      const snapshot = { version: 1 as const, hubId: runtime.hubId, chatId: id, requestId, taskId, startedAtMs, finishedAtMs: Math.max(startedAtMs, Date.now()), status, observation };
      if (!validRexInspectionSnapshot(snapshot)) throw new DeckError("invalid", "Invalid Rex inspection projection");
      return snapshot;
    };
    // Snapshots create no absent documents. The commit reads a table record only;
    // it uses no tx.doc(), admission, task creation, model call or scheduler API.
    const capture = async () => {
      const record = await runtime.harness.commit((tx) => tx.conversation(chat.id), context);
      const metadata = await runtime.harness.snapshot(ChatDoc, chat.id, context);
      const agent = await runtime.harness.snapshot(AgentDoc, chat.id, context);
      const doc = await runtime.harness.snapshot(RexDoc, chat.id, context);
      const task = Number.isSafeInteger(doc?.taskId) && doc!.taskId > 0 ? await runtime.harness.getTask(doc!.taskId as TaskId, context) : undefined;
      const reconciliation = Number.isSafeInteger(doc?.reconciliationTaskId) && doc!.reconciliationTaskId! > 0 ? await runtime.harness.getTask(doc!.reconciliationTaskId as TaskId, context) : undefined;
      return { record, metadata, agentCwd: agent?.cwd, doc, task, reconciliation };
    };
    try {
      if (signal?.aborted) return finish("cancelled");
      const before = await capture();
      if (changed) return finish("stale");
      const { metadata, doc, task } = before;
      if (Number.isSafeInteger(doc?.taskId) && doc!.taskId > 0) taskId = String(doc!.taskId);
      if (!doc?.binding) return finish("unbound");
      const input = task?.input as RexInput | undefined; const binding: RexBinding = doc.binding;
      if (!before.record || before.record.owner || metadata?.kind !== "task" || !task || task.kind !== REX_KIND || task.conversationId !== chat.id || !input?.binding || !validRexAllocationPlan(input.plan) || !taskId || binding.taskId !== taskId || binding.chatId !== id || binding.hubId !== runtime.hubId || binding.readiness !== "not_checked") return finish("conflict");
      const outcome = task.state.status === "terminal" && task.state.outcome;
      const originalProof = outcome && outcome.status === "completed" && outcome.result && typeof outcome.result === "object" && "status" in outcome.result && outcome.result.status === "allocated" && "binding" in outcome.result && sameRexBinding(outcome.result.binding, binding);
      if (!originalProof && !reconciledBinding(before.reconciliation, chat.id, doc.taskId, input, binding)) return finish("conflict");
      if (input.plan.chatId !== id || input.plan.hubId !== runtime.hubId || (input.plan.allocationId ?? undefined) !== doc.allocationId || metadata.machineId !== input.binding.machineId || metadata.cwd !== input.binding.cwd || before.agentCwd !== metadata.cwd || binding.machineId !== metadata.machineId || binding.cwd !== metadata.cwd) return finish("conflict");
      const scope = { server: binding.server, hostId: binding.hostId, instanceId: binding.instanceId, sessionId: binding.sessionId, windowId: binding.windowId, blockId: binding.blockId };
      if (scope.server !== input.plan.server || scope.hostId !== input.plan.hostId || scope.instanceId !== input.plan.instanceId) return finish("conflict");
      const query: RexInspectionQuery = { executable: input.plan.executable, scope };
      if (!validRexInspectionQuery(query) || Buffer.byteLength(JSON.stringify(query)) > 16 * 1024) return finish("conflict");
      if (signal?.aborted) return finish("cancelled");
      if (!this.host) return finish("unavailable");
      if (this.nextId >= 1n << 64n) throw new DeckError("busy", "Rex inspection correlation exhausted; reconnect the native worker");
      let observation: RexInspectionObservation = { version: 1, scope, state: "inconclusive", exitCode: null, revision: null };
      try {
        const result = await this.host.call(input.binding, String(this.nextId++), "rex_inspect", { plan: JSON.stringify(query) }, signal);
        if (result.ok && result.code === "rex_inspected" && !result.truncated && Buffer.byteLength(result.output) <= 16 * 1024) {
          const value: unknown = JSON.parse(result.output);
          if (validRexInspectionObservation(value) && Object.entries(scope).every(([key, expected]) => value.scope[key as keyof typeof scope] === expected) && ((value.state === "exited") === (value.exitCode !== null))) observation = value;
        } else if (!result.ok && (result.code === "offline" || result.code === "busy")) observation.state = "unavailable";
      } catch { /* Read failure is inconclusive, never absence; do not expose diagnostics. */ }
      if (signal?.aborted) return finish("cancelled");
      const after = await capture();
      if (changed || JSON.stringify(before) !== JSON.stringify(after)) return finish("stale");
      // Reconstruct the whitelisted projection even if an injected adapter returns
      // objects with unexpected prototypes. No caller-supplied contents survive.
      return finish("sampled", { version: 1, scope, state: observation.state, exitCode: observation.exitCode, revision: observation.revision });
    } finally { unsubscribe(); this.active.delete(id); }
  }
}
