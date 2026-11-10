// Compatible read adapter, not a Pi archive schema or another history store.
import { validHistoryArgs as shapeArgs, validHistoryPage as shapePage, validHistoryInputData, validHistoryAgentOrigin, validHistoryMessages, type HistoryArgs, type HistoryPage, type HistoryEntry } from "./generated/contracts.js";
import { validSafePiId } from "./mutation-contracts.js";
import { validHistoryViews } from "./view-contracts.js";

export function validHistoryArgs(value: unknown): value is HistoryArgs {
  return shapeArgs(value) && validSafePiId(value.chatId)
    && (value.before === undefined || validSafePiId(value.before))
    && (value.after === undefined || value.after === "0" || validSafePiId(value.after))
    && !(value.before !== undefined && value.after !== undefined);
}
function validRenderedEntry(entry: HistoryEntry): boolean {
  if (entry.kind === "deck.input") {
    if (!validHistoryInputData(entry.data)) return false;
    const origin = entry.data.origin;
    if (origin && typeof origin === "object" && "kind" in origin && origin.kind === "task-tool") {
      return validHistoryAgentOrigin(origin) && validSafePiId(origin.chatId) && validSafePiId(origin.taskId);
    }
  } else if (entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") {
    if (!validHistoryMessages(entry.model)) return false;
    for (const message of entry.model) {
      if (entry.kind === "pi.tool-result" && (message.toolName === undefined || message.isError === undefined)) return false;
      for (const part of message.content ?? []) {
        if (part.type === "text" && part.text === undefined) return false;
        if (part.type === "toolCall" && part.name === undefined) return false;
      }
    }
  }
  return true; // Unrendered/unknown Pi kinds still advance the canonical cursor.
}
export function validHistoryPage(value: unknown, args: unknown): value is HistoryPage {
  if (!validHistoryArgs(args) || !shapePage(value) || !validHistoryViews(value, args) || value.items.length > (args.limit ?? 100)) return false;
  let previous = args.after !== undefined ? Number(args.after) : args.before === undefined ? Infinity : Number(args.before);
  for (const entry of value.items) {
    if ((args.after !== undefined ? entry.id <= previous : entry.id >= previous) || !validRenderedEntry(entry)) return false;
    previous = entry.id;
  }
  // Unlike discovery, history has no filtered rows: next is the last entry,
  // not an arbitrary last-scanned ID. Never normalize or skip a bad cursor.
  return value.next === undefined || (validSafePiId(value.next) && value.items.length > 0 && Number(value.next) === previous);
}
