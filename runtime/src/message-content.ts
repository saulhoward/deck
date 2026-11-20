import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { DeckRuntime } from "./deck.js";
import { DeckError } from "./deck-error.js";
import type { MessageContentArgs, MessageContentPage } from "./generated/contracts.js";
import { validHistoryAgentOrigin } from "./generated/contracts.js";
import { validMessageContentArgs, messageContentChunkBytes, messageContentMaxBytes } from "./message-content-contracts.js";
import { sanitizeText } from "./tui-content.js";

// This is a display-defense export, NOT a raw Pi archive. Keep all visible TEXT
// blocks (no TUI 8192-byte / 256-part clipping), but never serialize opaque model
// data, thinking, signatures, tool arguments/results, images or diagnostics.
export function retainedMessageText(entry: Pick<EntryRecord, "kind" | "data" | "model">): string {
  const parts: string[] = [];
  let bytes = 0, hasText = false;
  const append = (raw: string, visible = true) => {
    const text = sanitizeText(raw);
    hasText ||= visible && text.length > 0;
    bytes += Buffer.byteLength(text) + (parts.length ? 1 : 0);
    if (bytes > messageContentMaxBytes) throw new DeckError("too_large", "Message content exceeds the 16 MiB export limit");
    parts.push(text);
  };
  if (entry.kind === "deck.input") {
    const data = entry.data as { text?: unknown; origin?: unknown; requestId?: unknown } | undefined;
    if (typeof data?.text === "string") {
      if (validHistoryAgentOrigin(data.origin)) {
        const origin = data.origin;
        append(`[agent chat ${origin.chatId}, task ${origin.taskId}${origin.chain ? `; request ${typeof data.requestId === "string" ? data.requestId : ""}; reply ${origin.chain.replyToChatId}/${origin.chain.replyToRequestId}; hop ${origin.chain.hop}/8` : ""}]`, false);
      }
      append(data.text);
    }
  } else if (entry.kind === "pi.assistant") {
    for (const message of Array.isArray(entry.model) ? entry.model : []) {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block?.type === "text" && typeof block.text === "string") append(block.text);
      }
    }
  }
  // Same normal-message boundary as hasMessage: notices/tool requests alone
  // are not selectable messages, nor are sanitized-empty text blocks.
  if (!hasText) throw new DeckError("not_found", "Retained entry has no visible message text");
  return parts.join("\n");
}

export async function messageContent(runtime: DeckRuntime, args: MessageContentArgs): Promise<MessageContentPage> {
  if (!validMessageContentArgs(args)) throw new DeckError("invalid", "Invalid message content arguments");
  const chat = await runtime.chat(args.chatId);
  // Exact immutable ID lookup, never latest/text matching or a nearby row. A
  // global Pi entry read is scoped before any private payload is projected.
  const entry = await runtime.harness.commit(tx => tx.entry(Number(args.entryId) as EntryId), context);
  if (!entry || entry.conversationId !== chat.id || String(entry.id) !== args.entryId) throw new DeckError("not_found", "Retained message not found in this conversation");
  const bytes = Buffer.from(retainedMessageText(entry));
  if (args.offset > bytes.length || (args.offset < bytes.length && (bytes[args.offset]! & 0xc0) === 0x80)) throw new DeckError("invalid", "Message offset is outside the export or not a UTF-8 boundary");
  let end = Math.min(bytes.length, args.offset + messageContentChunkBytes);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { chatId: args.chatId, entryId: args.entryId, offset: args.offset, totalBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), text: bytes.subarray(args.offset, end).toString("utf8"),
    ...(end < bytes.length ? { next: end } : {}) };
}
