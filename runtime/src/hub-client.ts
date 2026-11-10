import { randomUUID } from "node:crypto";
import type { FailurePolicy } from "./generated/contracts.js";
import { validClientRequest } from "./command-contracts.js";
export { validClientRequest, validCommandArgs } from "./command-contracts.js";
import { encodeFrame, MAX_FRAME_BYTES } from "./protocol.js";
import { HubError, responseResult } from "./responses.js";
import { failurePolicy } from "./command-policy.js";

export class HubCallError extends Error {
  constructor(message: string, readonly policy: FailurePolicy) { super(message); }
}
async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_FRAME_BYTES)) {
    void response.body?.cancel().catch(() => {}); throw new Error("Invalid hub response size");
  }
  if (!response.body) throw new Error("Missing hub response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_FRAME_BYTES) throw new Error("Invalid hub response size");
      chunks.push(value);
    }
    if (!size) throw new Error("Missing hub response");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
// Client-only transport: one bounded request, one correlated reply, no retries,
// redirects, identity changes, draft mutations, execution or transcript storage.
export async function hubCommand(port: number, command: string, args: Record<string, unknown> = {}, hubId?: string, signal?: AbortSignal): Promise<unknown> {
  const id = randomUUID(); let body: string; let request: unknown;
  try {
    signal?.throwIfAborted();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    body = encodeFrame({ version: 1, id, command, args, ...(hubId !== undefined ? { hubId } : {}) }).subarray(4).toString("utf8");
    request = JSON.parse(body);
    if (!validClientRequest(request) || request.id !== id || request.command !== command || request.hubId !== hubId) throw new Error();
  } catch {
    const kind = command === "status" || command.startsWith("login_") ? "status/login" : command === "list_chats" ? "chat discovery" : command === "history" ? "history" : ["rex_open", "rex_status", "rex_inspect"].includes(command) ? "Rex" : ["activity", "progress", "instruction_status"].includes(command) ? "live view" : ["admit", "create_task", "import_instructions", "stop", "rex_startup"].includes(command) ? "mutation" : "command";
    throw new HubCallError(`Invalid ${kind} arguments; no request sent`, failurePolicy(command, "", "local"));
  }
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/v1/command`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
      redirect: "error", credentials: "omit",
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
    });
  } catch { throw new HubCallError("Hub connection lost or cancelled; request outcome unconfirmed", failurePolicy(command)); }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new HubCallError(`Hub HTTP ${response.status}; request outcome unconfirmed`, failurePolicy(command));
  }
  let value: unknown;
  try { value = await boundedJson(response); }
  catch { throw new HubCallError("Invalid or incomplete hub response; request outcome unconfirmed", failurePolicy(command)); }
  try { return responseResult(value, id, request); }
  catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubCallError(error instanceof Error ? error.message : "Invalid hub response; request outcome unconfirmed", failurePolicy(command));
  }
}
