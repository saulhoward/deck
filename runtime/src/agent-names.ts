import { defineDoc, defineDocFamily, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { validAgentName, validAgentRune, type AgentRune } from "./generated/contracts.js";

export type AgentNameMetadata = { agentName?: string; agentNameAlgorithm?: string; agentRune?: AgentRune };
export type AgentNameAlgorithm = { readonly id: string; readonly candidate: (ordinal: number) => string };

// Immutable v1 vocabulary/order/permutation. Change naming by adding a NEW
// algorithm and selecting it below, never by editing a released algorithm.
const firstV1 = Object.freeze(["winter", "frost", "ash", "glass", "iron", "pale", "midnight", "static", "dust", "hollow"]);
const secondV1 = Object.freeze(["mute", "blind", "lock", "watch", "drift", "born", "spill", "cut", "fold", "wire"]);
const wintermuteV1: AgentNameAlgorithm = Object.freeze({
  id: "wintermute-v1",
  candidate(ordinal: number): string {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("Invalid agent-name ordinal");
    const pairs = firstV1.length * secondV1.length;
    // 37 is coprime to 100: visit every pair once, mixing both word banks.
    const pair = ((ordinal % pairs) * 37) % pairs;
    const cycle = Math.floor(ordinal / pairs);
    return firstV1[Math.floor(pair / secondV1.length)]! + secondV1[pair % secondV1.length]! + (cycle ? `-${cycle + 1}` : "");
  },
});
export const agentNameAlgorithms: Readonly<Record<string, AgentNameAlgorithm>> = Object.freeze({ [wintermuteV1.id]: wintermuteV1 });
export const currentAgentNameAlgorithm = agentNameAlgorithms["wintermute-v1"]!;

// One central Pi store, not a worker/client registry. Claims are permanent and
// shared by ALL algorithm versions; failed creation rolls back claim + cursor.
// Keep the ordinal global too: selecting v2 does not restart a populated bank.
const NameCursor = defineDoc<{ next: number }>({
  kind: "deck.agent-name-cursor", version: 1, scope: "session",
  initial: () => ({ next: 0 }), checkpointWhen: () => true,
});
const NameClaim = defineDocFamily<{ chatId: number }, number>({
  kind: "deck.agent-name-claim", version: 1, scope: "session", family: true,
  initial: (chatId) => ({ chatId }), checkpointWhen: () => true,
});

// Frozen runic-v1 bank: assigned letters/numerals, no punctuation or blanks.
// Delta belongs exclusively to canonical main; other chats cycle after 86 births.
export const agentRunes = Object.freeze([...Array.from({ length: 75 }, (_, i) => String.fromCodePoint(0x16a0 + i)), ...Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x16ee + i))] as AgentRune[]);
const RuneCursor = defineDoc<{ next: number }>({ kind: "deck.agent-rune-cursor", version: 1, scope: "session", initial: () => ({ next: 0 }), checkpointWhen: () => true });
async function assignRune(tx: Tx, metadata: AgentNameMetadata, hub: boolean) {
  if (metadata.agentRune !== undefined) {
    if (!validAgentRune(metadata.agentRune) || (metadata.agentRune === "Δ") !== hub) throw new Error("Invalid saved agent rune");
    return;
  }
  if (hub) { metadata.agentRune = "Δ"; return; }
  const cursor = await tx.doc(RuneCursor);
  if (!Number.isSafeInteger(cursor.next) || cursor.next < 0 || cursor.next >= Number.MAX_SAFE_INTEGER) throw new Error("Agent-rune sequence exhausted");
  metadata.agentRune = agentRunes[cursor.next++ % agentRunes.length]!;
}

export function agentNameFields(metadata: AgentNameMetadata): AgentNameMetadata {
  return metadata.agentName === undefined ? {} : { agentName: metadata.agentName, agentNameAlgorithm: metadata.agentNameAlgorithm!, ...(metadata.agentRune === undefined ? {} : { agentRune: metadata.agentRune }) };
}

// Call inside the SAME transaction that creates Deck metadata. Existing names
// are never recomputed, including when their algorithm is no longer selected.
export async function assignAgentName(tx: Tx, chatId: ConversationId, metadata: AgentNameMetadata, algorithm = currentAgentNameAlgorithm, hub = false): Promise<void> {
  await assignRune(tx, metadata, hub);
  if (metadata.agentName !== undefined || metadata.agentNameAlgorithm !== undefined) {
    if (!validAgentName(metadata.agentName) || !validAgentName(metadata.agentNameAlgorithm)) throw new Error("Invalid saved agent name/version");
    if ((await tx.doc(NameClaim, metadata.agentName, chatId)).chatId !== chatId) throw new Error("Agent name already belongs to another conversation");
    return;
  }
  if (!validAgentName(algorithm.id)) throw new Error("Invalid agent-name algorithm ID");
  const cursor = await tx.doc(NameCursor);
  for (let attempt = 0; attempt < 1024; attempt++) {
    if (!Number.isSafeInteger(cursor.next) || cursor.next < 0 || cursor.next >= Number.MAX_SAFE_INTEGER) throw new Error("Agent-name sequence exhausted");
    const name = algorithm.candidate(cursor.next++);
    if (!validAgentName(name)) throw new Error("Invalid generated agent name");
    const claim = await tx.doc(NameClaim, name, chatId);
    if (claim.chatId !== chatId) continue;
    metadata.agentName = name;
    metadata.agentNameAlgorithm = algorithm.id;
    return;
  }
  throw new Error("Agent-name collision budget exhausted");
}
