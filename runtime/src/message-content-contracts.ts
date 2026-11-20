import { createHash } from "node:crypto";
import * as wire from "./generated/contracts.js";
import { validSafePiId } from "./mutation-contracts.js";

export const messageContentChunkBytes = 32768;
export const messageContentMaxBytes = 16777216;
export function validMessageContentArgs(value: unknown): value is wire.MessageContentArgs {
  return wire.validMessageContentArgs(value) && validSafePiId(value.chatId) && validSafePiId(value.entryId);
}
// Shape alone cannot bound UTF-8 bytes or correlate the reply. Across pages the
// consumer must also pin totalBytes/sha256 and verify the assembled full digest.
export function validMessageContentPage(value: unknown, args: unknown): value is wire.MessageContentPage {
  if (!validMessageContentArgs(args) || !wire.validMessageContentPage(value) || value.chatId !== args.chatId || value.entryId !== args.entryId || value.offset !== args.offset || !value.text.isWellFormed()) return false;
  const bytes = Buffer.byteLength(value.text), end = value.offset + bytes;
  if (bytes > messageContentChunkBytes || end > value.totalBytes) return false;
  if (end < value.totalBytes) {
    // A fixed-size chunk may lose at most three bytes to a UTF-8 boundary.
    if (bytes < messageContentChunkBytes - 3 || value.next !== end) return false;
  } else if (value.next !== undefined) return false;
  return value.offset !== 0 || end !== value.totalBytes || value.sha256 === createHash("sha256").update(value.text).digest("hex");
}
