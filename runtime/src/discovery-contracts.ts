// Read-only semantic checks, not a conversation/ownership/health catalog.
import { validListChatsArgs, validChatListPage, type ListChatsArgs, type ChatListPage } from "./generated/contracts.js";
import { validSafePiId } from "./mutation-contracts.js";

export function validDiscoveryArgs(value: unknown): value is ListChatsArgs {
  return validListChatsArgs(value) && (value.after === undefined || validSafePiId(value.after));
}
export function validDiscoveryPage(value: unknown, args: unknown = {}): value is ChatListPage {
  // The existing IPC envelope treats omitted/null args as an empty object. This
  // does not default malformed command fields or normalize an opaque cursor.
  const request = args ?? {};
  if (!validDiscoveryArgs(request) || !validChatListPage(value) || value.items.length > (request.limit ?? 50)) return false;
  let previous = request.after === undefined ? 0 : Number(request.after);
  for (const item of value.items) {
    if (!validSafePiId(item.chatId) || Number(item.chatId) <= previous) return false;
    previous = Number(item.chatId);
    if ((item.parentChatId === undefined) !== (item.ownerTaskId === undefined)) return false;
    if (item.parentChatId !== undefined && (!validSafePiId(item.parentChatId) || !validSafePiId(item.ownerTaskId))) return false;
  }
  // next is the last *scanned* ID, not necessarily the last visible metadata row.
  // Sparse/empty filtered pages are valid, but no cursor may go backwards/stall.
  return value.next === undefined || (validSafePiId(value.next) && Number(value.next) > Number(request.after ?? 0) && Number(value.next) >= previous);
}
