// Causality is captured at the generation's committed cutoff, never inferred from
// model text or the conversation's later inputs. Missing legacy provenance fails closed.
import { defineDoc, GenerationTask, hook, type ToolExecutionApi, type EntryId, type Cursor } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { DeckRuntime } from "./deck.js";
import { validMessageChain, type MessageChain } from "./generated/contracts.js";
export type { MessageChain } from "./generated/contracts.js";
export const MAX_MESSAGE_HOPS = 8;
type Cause = { cutoff: number | null; chain: MessageChain | null };
export const MessageCause = defineDoc<Cause>({ kind: "deck.message-cause", version: 1, scope: "task", initial: () => ({ cutoff: null, chain: null }), checkpointWhen: () => true });
function object(x: unknown): Record<string, any> { return x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : {}; }
const id = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v));
const request = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
export function validChain(c: unknown): c is MessageChain {
  const v = object(c); return validMessageChain(c) && id(v.rootChatId) && request(v.rootRequestId) && id(v.replyToChatId) && request(v.replyToRequestId) && Number.isInteger(v.hop) && v.hop >= 0 && v.hop <= MAX_MESSAGE_HOPS;
}
export function messageCausality(runtime: () => DeckRuntime) {
  return hook(GenerationTask, { beforeRequest: async (_request, api, context) => {
    await runtime().harness.commit(async tx => {
      // Null is also durable: unknown origin cannot become a fresh human chain on retry.
      const record = await tx.task(api.taskId); const state = object(record?.state); const checkpoint = object(state.checkpoint);
      if (record?.kind !== GenerationTask.definition.name || checkpoint.phase !== "request" || !Number.isSafeInteger(checkpoint.cutoff)) return;
      const doc = await tx.doc(MessageCause, api.taskId);
      if (doc.cutoff === checkpoint.cutoff) return;
      doc.cutoff = checkpoint.cutoff; doc.chain = null;
      let candidate: MessageChain | undefined;
      let cursor: Cursor | undefined;
      for (let pages = 0; pages < 100; pages++) {
        const page = await tx.scanEntries({ conversationId: api.conversationId, maxEntryId: checkpoint.cutoff as EntryId, order: "descending" }, 100, cursor);
        for (const entry of page.items) {
          if (entry.kind !== "deck.input") {
            if (entry.model?.some(message => message.role === "user")) return; // Unprovenanced input is not a human reset.
            continue;
          }
          const data = object(entry.data); if (!request(data.requestId)) return;
          if (data.origin === undefined) {
            doc.chain = candidate ?? { rootChatId: String(api.conversationId), rootRequestId: data.requestId, hop: 0, replyToChatId: String(api.conversationId), replyToRequestId: data.requestId };
            return;
          }
          const origin = object(data.origin);
          if (origin.kind !== "task-tool" || !validChain(origin.chain)) return;
          // Merge conservatively since the last human input. A lower-hop agent
          // message cannot reset a higher-hop chain already in model context.
          if (!candidate || origin.chain.hop > candidate.hop) candidate = { ...origin.chain, replyToChatId: String(api.conversationId), replyToRequestId: data.requestId };
        }
        if (!page.next) { doc.chain = candidate ?? null; return; } cursor = page.next;
      }
    }, context);
    return undefined;
  } });
}
export async function toolMessageOrigin(api: ToolExecutionApi, context: Context) {
  // A replay-safe call keeps its original causal envelope even after new input.
  const prior = await api.memo<MessageChain>("deck.message-chain", context);
  const chain = prior ?? await api.commit(async tx => {
    const tool = await tx.task(api.taskId);
    if (!tool?.owner) throw new Error("Messaging requires a model generation owner");
    const generation = await tx.task(tool.owner);
    if (generation?.kind !== GenerationTask.definition.name || generation.conversationId !== api.conversationId) throw new Error("Messaging requires a direct model tool call");
    const cause = await tx.doc(MessageCause, generation.id);
    if (!cause?.chain || !validChain(cause.chain)) throw new Error("Message provenance unavailable; fresh human input required");
    if (cause.chain.hop >= MAX_MESSAGE_HOPS) throw new Error("Agent message hop limit reached; fresh human input required");
    return { ...cause.chain, hop: cause.chain.hop + 1 };
  }, context);
  const saved = prior ?? await api.memo("deck.message-chain", chain, context);
  if (!validChain(saved) || saved.hop < 1) throw new Error("Invalid retained message provenance");
  return { kind: "task-tool" as const, chatId: String(api.conversationId), taskId: String(api.taskId), chain: saved };
}
