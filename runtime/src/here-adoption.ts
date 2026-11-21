// Existing-terminal adoption is one fenced send, then bounded read-only
// verification. It never creates a terminal, task conversation or chat input.
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { attachedCommand } from "./attached-client.js";
import { hubCommand } from "./hub-client.js";
import { launcherCommand } from "./launcher-client.js";
import { bootstrapRecord, StartupFiles, finishStartup } from "./agent-storage.js";
import { validSafePiId } from "./mutation-contracts.js";
import { validRexReply, validAdoptArgs } from "./rex-open-contracts.js";
import { validStatusSnapshot, validRexHereContext, type RexHereContext, type RexBootstrapRecord, type RexAdoptArgs, type RexAdoptAck, type RexStatusSnapshot, type AgentWizardReady } from "./generated/contracts.js";

export type HereEndpoint = { hubId: string; machineId: string; port: number; workerSocket?: string };
export type HereTransport = {
  status(chatId: string): Promise<unknown>;
  rexStatus(chatId: string): Promise<unknown>;
  adopt(args: RexAdoptArgs): Promise<unknown>;
};
export function hereTransport(endpoint: HereEndpoint, signal: AbortSignal): HereTransport {
  const remote = endpoint.workerSocket ? { hubId: endpoint.hubId, machineId: endpoint.machineId, socket: endpoint.workerSocket } : undefined;
  // Closed older status decoders must never receive an unsolicited new field.
  // Old hubs ignore this optional read flag and omit the capability: refuse.
  const read = (command: string, chatId: string) => {
    const args = { chatId, ...(command === "status" ? { rexHereAdopt: 1 } : {}) };
    return remote ? attachedCommand(remote, chatId, command, args, endpoint.hubId, signal)
      : hubCommand(endpoint.port, command, args, endpoint.hubId, signal);
  };
  return {
    status: chatId => read("status", chatId),
    rexStatus: chatId => read("rex_status", chatId),
    adopt: async args => remote
      ? ((await launcherCommand(remote, { version: 1, id: randomUUID(), command: "launch_adopt", args }, signal)) as { ack: unknown }).ack
      : hubCommand(endpoint.port, "rex_adopt", args, endpoint.hubId, signal),
  };
}
async function taskContext(endpoint: HereEndpoint, chatId: string, transport: HereTransport): Promise<RexHereContext> {
  if (!validSafePiId(chatId)) throw new Error("Invalid HERE task");
  const status = await transport.status(chatId);
  if (!validStatusSnapshot(status) || status.hubGuard !== 1 || status.rexHereAdopt !== 1 || status.hubId !== endpoint.hubId || status.chatId !== chatId || chatId === status.mainChatId || status.binding?.kind !== "task" || status.binding.machineId !== endpoint.machineId) throw new Error("HERE task scope unavailable");
  const value = { hubId: endpoint.hubId, machineId: endpoint.machineId, chatId, cwd: status.binding.cwd };
  if (!validRexHereContext(value) || !value.cwd.startsWith("/") || value.cwd.includes("\0") || Buffer.byteLength(value.cwd) > 4096) throw new Error("Invalid HERE task workspace");
  return value;
}
async function rexStatus(endpoint: HereEndpoint, chatId: string, transport: HereTransport): Promise<RexStatusSnapshot> {
  const value = await transport.rexStatus(chatId);
  if (!validRexReply({ command: "rex_status", args: { chatId }, hubId: endpoint.hubId }, value)) throw new Error("HERE allocation observation unavailable");
  return value as RexStatusSnapshot;
}
export async function hereContext(endpoint: HereEndpoint, chatId: string, transport: HereTransport): Promise<RexHereContext> {
  const context = await taskContext(endpoint, chatId, transport);
  const status = await rexStatus(endpoint, chatId, transport);
  if (status.status !== "unallocated" || status.taskId !== null || status.binding !== null || status.previousBinding !== null) throw new Error("HERE refuses any prior Rex allocation attempt; nothing replaced. Use --resume NAME --here --force to attach without changing the allocation.");
  return context;
}
function matchesAllocation(record: RexBootstrapRecord, status: RexStatusSnapshot): boolean {
  const b = status.binding, n = record.binding, t = record.target;
  return !!b && !!n && status.status === "allocated" && b.machineId === record.machineId && b.cwd === record.cwd
    && b.sessionId === n.sessionId && b.windowId === n.windowId && b.blockId === n.blockId
    && b.server === t.server && b.hostId === t.hostId && b.instanceId === t.instanceId;
}
// Explicit recovery can inspect an old process's outcome; it never re-adopts
// that process, repairs a receipt, or enables a new renderer's allocation scope.
export async function inspectHereRegistration(record: RexBootstrapRecord, transport: HereTransport): Promise<RexStatusSnapshot> {
  if (!record.here || !record.binding) throw new Error("Missing HERE proof");
  const context = await taskContext(record, record.here.chatId, transport);
  if (context.cwd !== record.cwd) throw new Error("HERE saved workspace changed");
  const status = await rexStatus(record, record.here.chatId, transport);
  if (status.status === "allocated" && (!matchesAllocation(record, status) || record.claim?.chatId !== record.here.chatId)) throw new Error("HERE allocation no longer matches the saved registration");
  return status;
}
export async function currentHereRecord(root: string, id: string, endpoint: HereEndpoint): Promise<RexBootstrapRecord> {
  const record = await bootstrapRecord(root, id);
  if (!record.here || !record.binding || record.hubId !== endpoint.hubId || record.machineId !== endpoint.machineId || record.port !== endpoint.port || record.workerSocket !== endpoint.workerSocket || record.binding.pid !== process.ppid || record.here.process.pid !== process.ppid || record.binding.sessionId !== process.env.REX_SESSION || record.binding.blockId !== process.env.REX_BLOCK) throw new Error("HERE record is not this native process/endpoint/terminal");
  return record;
}
export async function adoptHere(record: RexBootstrapRecord, files: StartupFiles, transport: HereTransport, options: { polls?: number; pauseMs?: number; signal?: AbortSignal } = {}): Promise<AgentWizardReady> {
  if (!record.here || !record.binding || !validSafePiId(record.here.chatId)) throw new Error("Missing HERE proof");
  const chatId = record.here.chatId;
  const args: RexAdoptArgs = { chatId, requestId: record.id, port: record.port, target: record.target, bootstrap: { id: record.id, root: record.draftRoot, blockId: record.binding.blockId, kind: "here" } };
  if (!validAdoptArgs(args)) throw new Error("Invalid HERE adoption intent");
  const intent = { version: 1, args };
  const savedIntent = await files.read("adoption-intent.json");
  let ack = await files.read("adopted.json");
  if (savedIntent !== undefined && JSON.stringify(savedIntent) !== JSON.stringify(intent)) throw new Error("HERE adoption intent changed; original retained");
  if (await files.read("discarded.json") !== undefined) throw new Error("HERE adoption was discarded; nothing replayed");
  if (ack === undefined) {
    if (savedIntent !== undefined || record.claim || await files.read("completed.json") !== undefined) throw new Error("HERE adoption outcome unconfirmed; no automatic resend");
    const context = await hereContext(record, chatId, transport);
    if (context.cwd !== record.cwd) throw new Error("HERE task workspace changed; no request sent");
    options.signal?.throwIfAborted();
    // Exclusive link + fsync: even concurrent helpers can send only once. The
    // fence survives lost/bad ACKs, cancellation and process/transport failure.
    await files.publish("adoption-intent.json", intent, true);
    ack = await transport.adopt(args);
    if (!validRexReply({ command: "rex_adopt", args, hubId: record.hubId }, ack)) throw new Error("Invalid HERE adoption acknowledgement; no automatic resend");
    await files.publish("adopted.json", ack);
  } else if (savedIntent === undefined) throw new Error("HERE adoption receipt lacks its intent");
  if (!validRexReply({ command: "rex_adopt", args, hubId: record.hubId }, ack)) throw new Error("Invalid HERE adoption receipt");
  const adopted = ack as RexAdoptAck;
  const polls = Math.min(40, Math.max(1, options.polls ?? 40));
  for (let i = 0; i < polls; i++) {
    options.signal?.throwIfAborted();
    const status = await rexStatus(record, chatId, transport);
    if (status.taskId !== adopted.taskId) throw new Error("HERE allocation identity changed; nothing replaced");
    if (status.status === "pending") {
      if (i + 1 < polls) await delay(options.pauseMs ?? 250, undefined, options.signal ? { signal: options.signal } : {});
      continue;
    }
    if (!matchesAllocation(record, status) || status.binding?.taskId !== adopted.taskId) throw new Error("HERE allocation is unconfirmed; no replacement or input");
    const context = await taskContext(record, chatId, transport);
    if (context.cwd !== record.cwd) throw new Error("HERE task workspace changed; no input enabled");
    // Native claim pins the ACK's allocation ID as well as its canonical task
    // and full terminal binding. Re-read only; never write/repair native proof.
    const current = await currentHereRecord(record.draftRoot, record.id, record);
    if (!isDeepStrictEqual({ ...current, claim: undefined }, { ...record, claim: undefined }) || current.claim?.chatId !== chatId || current.claim.allocationId !== adopted.allocationId) throw new Error("HERE native allocation claim unconfirmed");
    await files.publish("completed.json", { version: 1 });
    await finishStartup(record);
    return { chatId, allocationId: adopted.allocationId };
  }
  throw new Error("HERE allocation still pending; no automatic resend or replacement");
}
