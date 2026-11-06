import { createHash } from "node:crypto";
import { AgentDoc, configure, defineDoc, defineDocFamily, defineExtension, defineTask, InboxDoc, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { ChatDoc, type Binding } from "./deck.js";
import type { HostFiles } from "./host-files.js";

export const INSTRUCTION_BYTES = 32 * 1024;
export const IMPORT_KIND = "deck.import-instructions";
const unfinished = ["pending", "running", "waiting", "sleeping", "completing"] as const;
export type InstructionSource = { machineId: string; cwd: string; path: "AGENTS.md"; sha256: string; bytes: number; taskId: string };
type Rejection = "offline" | "unavailable" | "read_failed" | "effect_uncertain" | "invalid" | "too_large" | "settings_changed" | "busy";
export type InstructionImportResult = { status: "applied"; source: InstructionSource } | { status: "rejected"; reason: Rejection } | { status: "aborted" };
type ImportInput = { binding: Binding; previousHash: string | null };
export const InstructionSourceDoc = defineDoc<{ source?: InstructionSource }>({
  kind: "deck.instruction-source", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", initial: () => ({}), checkpointWhen: () => true,
});
// Identity receipt only. Pi's task record owns all execution state and the terminal result.
export const InstructionRequest = defineDocFamily<{ taskId: number }, null>({
  kind: "deck.instruction-request", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  initial: () => ({ taskId: 0 }), checkpointWhen: () => true,
});
export const instructionHash = (text: string | undefined): string | null => text === undefined ? null : createHash("sha256").update(text).digest("hex");

export async function configurationIdle(tx: Tx, id: ConversationId, except?: TaskId): Promise<boolean> {
  for (const status of unfinished) {
    // At most the importer itself can be excluded; two rows suffice to find another.
    if ((await tx.scanTasks({ conversationId: id, status }, except === undefined ? 1 : 2)).items.some((task) => task.id !== except)) return false;
  }
  if ((await tx.doc(InboxDoc, id)).items.length) return false;
  return true;
}
export async function importingInstructions(tx: Tx, id: ConversationId): Promise<boolean> {
  for (const status of unfinished) if ((await tx.scanTasks({ conversationId: id, kind: IMPORT_KIND, status }, 1)).items.length) return true;
  return false;
}
async function refusal(tx: Tx, id: ConversationId, taskId: TaskId, input: ImportInput): Promise<Rejection | undefined> {
  const binding = await tx.doc(ChatDoc, id); const agent = await tx.doc(AgentDoc, id);
  if (!binding || !["main", "task"].includes(binding.kind) || binding.machineId !== input.binding.machineId || binding.cwd !== input.binding.cwd || agent?.cwd !== binding.cwd || instructionHash(agent.instructions) !== input.previousHash) return "settings_changed";
  if (!await configurationIdle(tx, id, taskId)) return "busy";
  return undefined;
}
function completed(result: InstructionImportResult) { return { status: "terminal" as const, outcome: { status: "completed" as const, result } }; }

export function instructionImport(host?: HostFiles) {
  const task = defineTask<ImportInput, { phase: "read" }, InstructionImportResult>({
    name: IMPORT_KIND, version: 1, initial: () => ({ phase: "read" }),
    phases: { read: async (task, api, context) => {
      let allowed = false;
      await api.commit(async (tx) => {
        const reason = await refusal(tx, api.conversationId, api.taskId, task.input);
        if (reason) return completed({ status: "rejected", reason });
        allowed = true; return undefined;
      }, context);
      if (!allowed) return;
      if (!host) { await api.commit(() => completed({ status: "rejected", reason: "offline" }), context); return; }
      api.signal.throwIfAborted();
      let result;
      try {
        // Same Pi task ID and exact request on recovery. The worker retains the bytes
        // or reports uncertainty; never reread on the hub or invent a new operation ID.
        result = await host.call(task.input.binding, String(api.taskId), "read", { path: "AGENTS.md" }, api.signal);
      } catch {
        api.signal.throwIfAborted();
        await api.commit(() => completed({ status: "rejected", reason: "unavailable" }), context); return;
      }
      api.signal.throwIfAborted(); // Issued files drain, but cancellation must never apply them.
      let reason: Rejection | undefined;
      if (!result.ok) reason = result.code === "offline" || result.code === "effect_uncertain" ? result.code : "read_failed";
      else if (Buffer.byteLength(result.output, "utf8") > INSTRUCTION_BYTES) reason = "too_large";
      else if (result.truncated || result.output.includes("\0") || Buffer.from(result.output, "utf8").toString("utf8") !== result.output) reason = "invalid";
      if (reason) { await api.commit(() => completed({ status: "rejected", reason }), context); return; }
      const source: InstructionSource = { ...task.input.binding, path: "AGENTS.md", sha256: instructionHash(result.output)!, bytes: Buffer.byteLength(result.output, "utf8"), taskId: String(api.taskId) };
      await api.commit(async (tx) => {
        const reason = await refusal(tx, api.conversationId, api.taskId, task.input);
        if (reason) return completed({ status: "rejected", reason });
        // Settings, source provenance and task outcome share this one Pi commit.
        await configure(tx, api.conversationId, { instructions: result.output });
        (await tx.doc(InstructionSourceDoc, api.conversationId)).source = source;
        return completed({ status: "applied", source });
      }, context);
    } },
    abort: async (_task, api, context) => { await api.commit(() => completed({ status: "aborted" }), context); },
  });
  return { task, extension: defineExtension({ name: "deck.instruction-import", tasks: [task] }) };
}
