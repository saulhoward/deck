import { createHash } from "node:crypto";
import { defineDocFamily, defineExtension, defineTask, type ConversationId, type TaskId, type TaskRecord, type Tx } from "@earendil-works/pi-durable";
import type { Binding } from "./deck.js";
import { RexDoc, REX_KIND, rexCoherent, rexCreationBinding, sameRexBinding, type RexBinding, type RexInput } from "./rex-allocation.js";
import { validRexAllocationPlan, validRexAllocationReceipt, type RexAllocationReceiptQuery } from "./generated/contracts.js";
import type { HostFiles } from "./host-files.js";

export const RECONCILE_KIND = "deck.rex-reconciliation";
export type ReconcileInput = { allocationTaskId: number; binding: Binding; request: string };
export type ReconcileResult = { status: "reconciled"; binding: RexBinding; evidence: { source: "native_retained_creation"; operationId: string; requestHash: string } } | { status: "unresolved"; reason: "missing" | "accepted" | "not_allocated" | "conflict" | "inconclusive" | "unavailable" | "authority_changed" } | { status: "aborted" };
export const RexReconcileRequest = defineDocFamily<{ hash: string; taskId: number }, string>({ kind: "deck.rex-reconcile-request", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: (hash) => ({ hash, taskId: 0 }), checkpointWhen: () => true });
export const rexRequestHash = (request: string) => createHash("sha256").update(request).digest("hex");
// Reconstruct the existing native envelope from the immutable Pi input, without
// ever dispatching it. Hash mismatch fails closed if historical encoding differs.
export function allocationRequest(taskId: number, input: RexInput): string {
  return JSON.stringify({ version: 1, id: String(taskId), ...input.binding, operation: "rex_allocate", args: { plan: JSON.stringify(input.plan) } });
}
export async function reconciliationAuthority(tx: Tx, id: ConversationId, input: ReconcileInput, taskId: TaskId): Promise<RexInput | undefined> {
  const doc = await tx.doc(RexDoc, id);
  const original = await tx.task(input.allocationTaskId as TaskId);
  const source = original?.input as RexInput | undefined;
  if (doc.taskId !== input.allocationTaskId || doc.reconciliationTaskId !== taskId || doc.binding || !original || original.kind !== REX_KIND || original.conversationId !== id || original.state.status !== "terminal" || !source?.binding || !validRexAllocationPlan(source.plan)) return;
  if (source.binding.machineId !== input.binding.machineId || source.binding.cwd !== input.binding.cwd || allocationRequest(input.allocationTaskId, source) !== input.request || (source.plan.allocationId ?? undefined) !== doc.allocationId || source.plan.chatId !== String(id) || !await rexCoherent(tx, id, input.binding)) return;
  return source;
}
function completed(result: ReconcileResult) { return { status: "terminal" as const, outcome: { status: "completed" as const, result } }; }
function unresolved(reason: Extract<ReconcileResult, { status: "unresolved" }>["reason"]) { return completed({ status: "unresolved", reason }); }
export function rexReconciliation(host?: HostFiles) {
  const task = defineTask<ReconcileInput, { phase: "read" }, ReconcileResult>({
    name: RECONCILE_KIND, version: 1, initial: () => ({ phase: "read" }),
    phases: { read: async (task, api, context) => {
      let source: RexInput | undefined;
      await api.commit(async (tx) => {
        source = await reconciliationAuthority(tx, api.conversationId, task.input, api.taskId);
        return source ? undefined : unresolved("authority_changed");
      }, context);
      if (!source) return;
      if (!host) { await api.commit(() => unresolved("unavailable"), context); return; }
      api.signal.throwIfAborted();
      const query: RexAllocationReceiptQuery = { operationId: String(task.input.allocationTaskId), request: task.input.request };
      let result;
      try { result = await host.call(task.input.binding, String(api.taskId), "rex_allocation_receipt", { plan: JSON.stringify(query) }, api.signal); }
      catch { api.signal.throwIfAborted(); await api.commit(() => unresolved("inconclusive"), context); return; }
      api.signal.throwIfAborted(); // Issued read drains; stop cannot apply its late evidence.
      if (!result.ok) { await api.commit(() => unresolved(result.code === "offline" ? "unavailable" : "inconclusive"), context); return; }
      let value: unknown;
      try { if (result.code === "rex_receipt" && !result.truncated && Buffer.byteLength(result.output) <= 16 * 1024) value = JSON.parse(result.output); } catch { /* Payload-free refusal. */ }
      if (!validRexAllocationReceipt(value) || value.operationId !== query.operationId || value.requestHash !== rexRequestHash(query.request) || ((value.state === "allocated") !== (value.creation !== null))) { await api.commit(() => unresolved("inconclusive"), context); return; }
      if (value.state !== "allocated") { const reason = value.state; await api.commit(() => unresolved(reason), context); return; }
      const binding = rexCreationBinding(JSON.stringify(value.creation), source, task.input.allocationTaskId as TaskId);
      if (!binding) { await api.commit(() => unresolved("conflict"), context); return; }
      const evidence = { source: "native_retained_creation" as const, operationId: query.operationId, requestHash: value.requestHash };
      await api.commit(async (tx) => {
        if (!await reconciliationAuthority(tx, api.conversationId, task.input, api.taskId)) return unresolved("authority_changed");
        (await tx.doc(RexDoc, api.conversationId)).binding = binding;
        // Original task/outcome, attempt, startup and native receipt are unchanged.
        return completed({ status: "reconciled", binding, evidence });
      }, context);
    } },
    abort: async (_task, api, context) => { await api.commit(() => completed({ status: "aborted" }), context); },
  });
  return { task, extension: defineExtension({ name: RECONCILE_KIND, tasks: [task] }) };
}

// Inspection accepts either the original completed creation or this separately
// linked Pi proof. Neither is current liveness. Never rewrite the old outcome.
export function reconciledBinding(task: TaskRecord<unknown, unknown, unknown> | undefined, conversationId: ConversationId, allocationTaskId: number, original: RexInput, binding: RexBinding): boolean {
  if (!task || task.kind !== RECONCILE_KIND || task.conversationId !== conversationId || task.state.status !== "terminal" || task.state.outcome.status !== "completed") return false;
  const input = task.input as ReconcileInput | undefined; const result = task.state.outcome.result as ReconcileResult | undefined;
  const request = allocationRequest(allocationTaskId, original);
  return !!input && input.allocationTaskId === allocationTaskId && input.request === request && input.binding?.machineId === original.binding.machineId && input.binding.cwd === original.binding.cwd && result?.status === "reconciled" && sameRexBinding(result.binding, binding) && result.evidence?.source === "native_retained_creation" && result.evidence.operationId === String(allocationTaskId) && result.evidence.requestHash === rexRequestHash(request);
}
