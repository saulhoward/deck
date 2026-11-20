import { randomInt } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, type ConversationId, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
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

// Randomize allocation, not the frozen vocabulary/candidate function. Each
// block still visits all 100 unsuffixed (then -2, -3, ...) combinations once.
const nameBlockSize = firstV1.length * secondV1.length;
export function shuffledNameOrder(pick: (max: number) => number = randomInt): number[] {
  const order = Array.from({ length: nameBlockSize }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

// One central Pi store, not a worker/client registry. Claims are permanent and
// shared by ALL algorithm versions; failed creation rolls back claim + cursor.
// Keep the ordinal global too: selecting v2 does not restart a populated bank.
const NameCursor = defineDoc<{ next: number; order?: number[] }>({
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

// Call inside the SAME transaction that creates Deck metadata. Task names are
// never recomputed. Canonical main has the fixed hub-v1 identity; its one-time
// rename preserves any previous claim and does not rewind either cursor.
export async function assignAgentName(tx: Tx, chatId: ConversationId, metadata: AgentNameMetadata, algorithm = currentAgentNameAlgorithm, hub = false): Promise<void> {
  await assignRune(tx, metadata, hub);
  if (metadata.agentName !== undefined || metadata.agentNameAlgorithm !== undefined) {
    if (!validAgentName(metadata.agentName) || !validAgentName(metadata.agentNameAlgorithm)) throw new Error("Invalid saved agent name/version");
    if ((await tx.doc(NameClaim, metadata.agentName.toLowerCase(), chatId)).chatId !== chatId) throw new Error("Agent name already belongs to another conversation");
    if (!hub) return;
  }
  if (hub) {
    if ((await tx.doc(NameClaim, "hub", chatId)).chatId !== chatId) throw new Error("Agent name already belongs to another conversation");
    metadata.agentName = "hub";
    metadata.agentNameAlgorithm = "hub-v1";
    return;
  }
  if (!validAgentName(algorithm.id)) throw new Error("Invalid agent-name algorithm ID");
  const cursor = await tx.doc(NameCursor);
  if (cursor.order !== undefined && (cursor.order.length !== nameBlockSize || new Set(cursor.order).size !== nameBlockSize || cursor.order.some(n => !Number.isInteger(n) || n < 0 || n >= nameBlockSize))) throw new Error("Invalid saved agent-name order");
  for (let attempt = 0; attempt < 1024; attempt++) {
    if (!Number.isSafeInteger(cursor.next) || cursor.next < 0 || cursor.next >= Number.MAX_SAFE_INTEGER) throw new Error("Agent-name sequence exhausted");
    // Persist the shuffle with the cursor/claim. Existing cursors acquire an
    // order lazily; permanent claims skip any names allocated before upgrade.
    const index = cursor.next % nameBlockSize;
    if (cursor.order === undefined || index === 0) cursor.order = shuffledNameOrder();
    const ordinal = cursor.next - index + cursor.order[index]!;
    if (!Number.isSafeInteger(ordinal)) throw new Error("Agent-name sequence exhausted");
    cursor.next++;
    const name = algorithm.candidate(ordinal);
    if (!validAgentName(name)) throw new Error("Invalid generated agent name");
    const claim = await tx.doc(NameClaim, name.toLowerCase(), chatId);
    if (claim.chatId !== chatId) continue;
    metadata.agentName = name;
    metadata.agentNameAlgorithm = algorithm.id;
    return;
  }
  throw new Error("Agent-name collision budget exhausted");
}

// Frozen child-v1 prefix rule. Recognize the two wintermute-v1 components,
// including cycle suffixes. Hub is HU. Unknown/legacy names use their first two
// ASCII letters (one letter is padded with X; missing/no letters becomes XX).
// This fallback is deterministic, not a claim of knowing legacy word boundaries.
export function subagentNamePrefix(parentName?: string): string {
  const name = (parentName ?? "").toLowerCase();
  if (name === "hub") return "HU";
  const base = name.replace(/-[0-9]+$/, "");
  for (const first of firstV1) for (const second of secondV1) {
    if (base === first + second) return (first[0]! + second[0]!).toUpperCase();
  }
  return name.replace(/[^a-z]/g, "").slice(0, 2).toUpperCase().padEnd(2, "X");
}

export const subagentNameAlgorithm = "parent-initials-v1";
const SubagentNameCursor = defineDocFamily<{ next: number }, null>({
  kind: "deck.subagent-name-cursor", version: 1, scope: "session", family: true,
  initial: () => ({ next: 1 }), checkpointWhen: () => true,
});

// Prefix-wide, NOT per-parent: winterwatch and winterwire share WW001, WW002,
// etc. All algorithms share the permanent, case-folded NameClaim namespace.
// The separate cursor never consumes compound names or runes. Minimum width is
// three digits, not a modulus: XX999 is followed by XX1000. Creation/migration
// and all reservations must be committed atomically with the child metadata.
// Callers must establish canonical Pi ownership, never trust Deck display hints.
export async function assignSubagentName(tx: Tx, chatId: ConversationId, metadata: AgentNameMetadata, parent: AgentNameMetadata): Promise<void> {
  if (metadata.agentName !== undefined || metadata.agentNameAlgorithm !== undefined) {
    const childIdentity = metadata.agentNameAlgorithm === subagentNameAlgorithm;
    if (typeof metadata.agentName !== "string" || !validAgentName(metadata.agentNameAlgorithm)
      || (childIdentity ? !/^[A-Z]{2}(?:00[1-9]|0[1-9][0-9]|[1-9][0-9]{2,})$/.test(metadata.agentName) : !validAgentName(metadata.agentName))) throw new Error("Invalid saved agent name/version");
    if ((await tx.doc(NameClaim, metadata.agentName.toLowerCase(), chatId)).chatId !== chatId) throw new Error("Agent name already belongs to another conversation");
    if (childIdentity) {
      delete metadata.agentRune;
      return; // Never recompute a saved name, even if its parent was renamed.
    }
  }
  const prefix = subagentNamePrefix(parent.agentName);
  const cursor = await tx.doc(SubagentNameCursor, prefix, null);
  for (let attempt = 0; attempt < 1024; attempt++) {
    if (!Number.isSafeInteger(cursor.next) || cursor.next < 1 || cursor.next >= Number.MAX_SAFE_INTEGER) throw new Error("Subagent-name sequence exhausted");
    const name = prefix + String(cursor.next++).padStart(3, "0");
    const claim = await tx.doc(NameClaim, name.toLowerCase(), chatId);
    if (claim.chatId !== chatId) continue;
    metadata.agentName = name;
    metadata.agentNameAlgorithm = subagentNameAlgorithm;
    delete metadata.agentRune;
    return;
  }
  throw new Error("Subagent-name collision budget exhausted");
}

// Read-only global lookup, including permanent historical aliases. Call outside
// a commit (snapshot must not nest commits). No cursor/claim/doc is initialized
// on a miss, and no conversation is created. The caller can inspect the returned
// conversation's current metadata/ownership before exposing or acting on it.
export async function lookupAgentName(read: Pick<DocumentReader, "snapshot">, name: string, context: Context): Promise<ConversationId | undefined> {
  const key = name.toLowerCase();
  if (!validAgentName(key)) return undefined;
  const claim = await read.snapshot(NameClaim, key, context);
  return claim?.chatId as ConversationId | undefined;
}
