// Client-only transport into the worker's private Unix socket. No store, model
// runtime, credentials or retry loop. Network authority comes from the verified
// worker link; the hub separately checks this exact saved allocation/task.
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createConnection } from "node:net";
import { validTaskClientScope, type TaskClientScope } from "./generated/contracts.js";
import { validClientRequest } from "./command-contracts.js";
import { validSafePiId } from "./mutation-contracts.js";
import { HubCallError } from "./hub-client.js";
import { HubError, responseResult } from "./responses.js";
import { failurePolicy } from "./command-policy.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
export function taskScope(hubId: unknown, chatId: unknown, allocationId: unknown, blockId: unknown): TaskClientScope {
  const scope = { hubId, chatId, allocationId, blockId };
  if (!validTaskClientScope(scope) || !validSafePiId(scope.chatId)) throw new Error("Worker task clients require a pinned hub/task/allocation and full REX_BLOCK");
  return scope;
}
export async function taskCommand(path: string, scope: TaskClientScope, command: string, args: Record<string, unknown>, expectedHubId?: string, signal?: AbortSignal): Promise<unknown> {
  const id = randomUUID(); let request: unknown; let frame: Buffer;
  try {
    signal?.throwIfAborted(); taskScope(scope.hubId, scope.chatId, scope.allocationId, scope.blockId);
    if (expectedHubId !== scope.hubId || args.chatId !== scope.chatId || !isAbsolute(path) || Buffer.byteLength(path) > 100 || /[\0\r\n]/.test(path)) throw new Error();
    const body = encodeFrame({ version: 1, id, command, args, hubId: scope.hubId }).subarray(4).toString("utf8");
    request = JSON.parse(body); if (!validClientRequest(request)) throw new Error();
    frame = encodeFrame({ scope, body });
    // Reserve the bounded outer link envelope before opening the socket.
    encodeFrame({ connectionId: "a".repeat(64), id: "b".repeat(64), scope, body });
    const [parent, socket] = await Promise.all([lstat(dirname(path)), lstat(path)]);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0 || !socket.isSocket() || socket.uid !== parent.uid) throw new Error();
  } catch { throw new HubCallError("Invalid or unavailable worker client socket/scope; this attempt was not sent; earlier attempts may have applied", failurePolicy(command, "", "local")); }
  let value: unknown;
  const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
  const socket = createConnection({ path }); const decoder = new FrameDecoder();
  const cancel = () => socket.destroy(new Error("Client detached"));
  abort.addEventListener("abort", cancel, { once: true });
  socket.on("error", error => decoder.destroy(error)); socket.pipe(decoder);
  try {
    if (abort.aborted) cancel();
    socket.once("connect", () => { if (!abort.aborted) socket.write(frame); });
    let count = 0;
    for await (const reply of decoder) { if (++count !== 1) throw new Error(); value = reply; }
    if (count !== 1) throw new Error();
  } catch { throw new HubCallError("Worker link lost or cancelled; request outcome unconfirmed; not replayed", failurePolicy(command)); }
  finally { abort.removeEventListener("abort", cancel); socket.destroy(); decoder.destroy(); }
  try { return responseResult(value, id, request); }
  catch (error) { if (error instanceof HubError) throw error; throw new HubCallError(error instanceof Error ? error.message : "Invalid task response; outcome unconfirmed", failurePolicy(command)); }
}
