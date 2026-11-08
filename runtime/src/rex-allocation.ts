import { isAbsolute } from "node:path";
import { AgentDoc, defineDoc, defineDocFamily, defineExtension, defineTask, type TaskId, type Tx, type ConversationId } from "@earendil-works/pi-durable";
import { ChatDoc, type Binding } from "./deck.js";
import type { HostFiles } from "./host-files.js";
import { validRexUuid, validRexBlockId, validRexCreation, type RexAllocationPlan } from "./generated/contracts.js";

export const REX_KIND = "deck.rex-allocation";
export type RexTarget = Pick<RexAllocationPlan, "executable" | "server" | "hostId" | "instanceId" | "client" | "port">;
// Domain intent never generates a null UUID; the native wire also accepts legacy null.
export type RexPlan = Omit<RexAllocationPlan, "allocationId"> & { allocationId?: string };
export type RexBinding = Binding & { server: string; hostId: string; instanceId: string; sessionId: string; windowId: string; blockId: string; chatId: string; hubId: string; taskId: string; readiness: "not_checked" };
export type RexResult = { status: "allocated"; binding: RexBinding } | { status: "not_allocated"; reason: "invalid" | "offline" | "unavailable" | "cancelled" } | { status: "uncertain" } | { status: "aborted" };
export type RexInput = { binding: Binding; plan: RexPlan };
type Input = RexInput;
export type RexMetadata = { taskId: number; binding?: RexBinding; allocationId?: string; startup?: { blockId: string }; reconciliationTaskId?: number };
export type RexStartup = { version: 1; chatId: string; taskId?: string; observation: "not_observed" | "unbound" | "matched" | "conflict"; historical: true; live: "not_checked" };
export function rexStartup(chatId: string, doc?: RexMetadata): RexStartup {
  return { version: 1, chatId, ...(doc?.taskId ? { taskId: String(doc.taskId) } : {}), observation: !doc?.startup ? "not_observed" : !doc.binding ? "unbound" : doc.binding.blockId === doc.startup.blockId ? "matched" : "conflict", historical: true, live: "not_checked" };
}
export const rexUuid = validRexUuid;
export const rexBlock = validRexBlockId;
// Binding + identity of its sole allocation attempt, NOT an execution tracker.
// No reset/replacement/adoption API yet: even an aborted/uncertain attempt pins
// the chat, preventing a new request ID from silently making another session.
export const RexDoc = defineDoc<RexMetadata>({ kind: "deck.rex", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ taskId: 0 }), checkpointWhen: () => true });
export const RexRequest = defineDocFamily<{ hash: string; taskId: number }, string>({ kind: "deck.rex-request", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: (hash) => ({ hash, taskId: 0 }), checkpointWhen: () => true });
const uuid = rexUuid;
const absolute = (value: unknown): value is string => typeof value === "string" && Buffer.byteLength(value) <= 4096 && isAbsolute(value) && !value.includes("\0");
export function rexTarget(value: RexTarget): RexTarget {
  if (!value || !absolute(value.executable) || !absolute(value.client) || typeof value.server !== "string" || !value.server.startsWith("unix:///") || Buffer.byteLength(value.server.slice(7)) > 100 || /[?#%\0\r\n]/.test(value.server) || !uuid(value.hostId) || !uuid(value.instanceId) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("Invalid explicit local Rex target");
  return { executable: value.executable, server: value.server, hostId: value.hostId, instanceId: value.instanceId, client: value.client, port: value.port };
}
export async function rexCoherent(tx: Tx, id: ConversationId, expected?: Binding): Promise<boolean> {
  const chat = await tx.doc(ChatDoc, id); const agent = await tx.doc(AgentDoc, id);
  return !!chat && chat.kind === "task" && !(await tx.conversation(id))?.owner && !!chat.machineId && absolute(chat.cwd) && agent?.cwd === chat.cwd && (!expected || (chat.machineId === expected.machineId && chat.cwd === expected.cwd));
}
function completed(result: RexResult) { return { status: "terminal" as const, outcome: { status: "completed" as const, result } }; }
export function rexCreationBinding(output: string, input: Input, taskId: TaskId): RexBinding | undefined {
  if (Buffer.byteLength(output) > 16 * 1024) return;
  let value: unknown;
  try { value = JSON.parse(output); } catch { return; }
  if (!validRexCreation(value)) return;
  if (input.plan.allocationId !== undefined && value.allocationId !== input.plan.allocationId) return;
  // Structural validation is not authority: still compare every saved launch identity.
  if (value.server !== input.plan.server || value.hostId !== input.plan.hostId || value.instanceId !== input.plan.instanceId || value.chatId !== input.plan.chatId || value.hubId !== input.plan.hubId) return;
  return { ...input.binding, server: input.plan.server, hostId: input.plan.hostId, instanceId: input.plan.instanceId, chatId: input.plan.chatId, hubId: input.plan.hubId,
    sessionId: value.sessionId, windowId: value.windowId, blockId: value.blockId, taskId: String(taskId), readiness: "not_checked" };
}
export function sameRexBinding(left: unknown, right: RexBinding): boolean {
  return !!left && typeof left === "object" && ["machineId", "cwd", "server", "hostId", "instanceId", "sessionId", "windowId", "blockId", "chatId", "hubId", "taskId", "readiness"].every((key) => (left as RexBinding)[key as keyof RexBinding] === right[key as keyof RexBinding]);
}
export function rexAllocation(host?: HostFiles) {
  const task = defineTask<Input, { phase: "allocate" }, RexResult>({
    name: REX_KIND, version: 1, initial: () => ({ phase: "allocate" }),
    phases: { allocate: async (task, api, context) => {
      let allowed = false;
      await api.commit(async (tx) => {
        if (!await rexCoherent(tx, api.conversationId, task.input.binding) || (await tx.doc(RexDoc, api.conversationId)).taskId !== api.taskId) return completed({ status: "uncertain" });
        allowed = true; return undefined;
      }, context);
      if (!allowed) return;
      if (!host) { await api.commit(() => completed({ status: "not_allocated", reason: "offline" }), context); return; }
      api.signal.throwIfAborted();
      let result;
      try { result = await host.call(task.input.binding, String(api.taskId), "rex_allocate", { plan: JSON.stringify(task.input.plan) }, api.signal); }
      catch { api.signal.throwIfAborted(); await api.commit(() => completed({ status: "uncertain" }), context); return; }
      api.signal.throwIfAborted(); // Drain issued CLI work; stop cannot undo Rex creation.
      if (!result.ok) {
        const reason = result.code === "server_unavailable" ? "unavailable" : result.code;
        await api.commit(() => completed(reason === "invalid" || reason === "offline" || reason === "cancelled" || reason === "unavailable" ? { status: "not_allocated", reason } : { status: "uncertain" }), context); return;
      }
      const binding = result.code === "allocated" && !result.truncated ? rexCreationBinding(result.output, task.input, api.taskId) : undefined;
      if (!binding) { await api.commit(() => completed({ status: "uncertain" }), context); return; }
      await api.commit(async (tx) => {
        if (!await rexCoherent(tx, api.conversationId, task.input.binding) || (await tx.doc(RexDoc, api.conversationId)).taskId !== api.taskId) return completed({ status: "uncertain" });
        (await tx.doc(RexDoc, api.conversationId)).binding = binding;
        return completed({ status: "allocated", binding });
      }, context);
    } },
    abort: async (_task, api, context) => { await api.commit(() => completed({ status: "aborted" }), context); },
  });
  return { task, extension: defineExtension({ name: "deck.rex-allocation", tasks: [task] }) };
}
