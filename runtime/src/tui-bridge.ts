import { once } from "node:events";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { displayText, localSession, validRequest, validReply } from "./tui-session.js";
import { validRexUuid } from "./generated/contracts.js";
import { validMutationArgs } from "./mutation-contracts.js";

const args = process.argv.slice(2); let port = 52800, chatId: string | undefined, hubId: string | undefined, allocationId: string | undefined;
try {
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!value) throw new Error();
    if (key === "--port" && /^\d+$/.test(value)) port = Number(value);
    else if (key === "--task" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) chatId = value;
    else if (key === "--hub-id" && value.length <= 200) hubId = value;
    else if (key === "--rex-allocation" && validRexUuid(value)) allocationId = value;
    else throw new Error();
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  if (allocationId && (!hubId || !validMutationArgs("rex_startup", { chatId, allocationId, blockId: process.env.REX_BLOCK }))) throw new Error();
} catch { process.exit(2); }
const abort = new AbortController();
const decoder = process.stdin.pipe(new FrameDecoder());
const stop = () => { abort.abort(); decoder.destroy(); };
process.stdin.on("end", stop); process.stdin.on("error", stop); process.stdout.on("error", stop);
const session = localSession(port, chatId, hubId, abort.signal);
const mode = allocationId ? "task" : "hub";
let hubChatId: string | undefined;
try {
  // Before any renderer snapshot or input: exact allocation-bound historical
  // registration. Failure closes this helper; there is no startup retry loop.
  if (allocationId) await session.registerStartup(allocationId, process.env.REX_BLOCK);
  for await (const request of decoder) {
    if (abort.signal.aborted || !validRequest(request)) break;
    let response;
    try { response = { version: 1, id: request.id, ok: true, snapshot: await session.handle(request) }; }
    catch (error) { response = { version: 1, id: request.id, ok: false, error: displayText(error instanceof Error ? error.message : "Client request failed; outcome unconfirmed", 1024) || "Client request failed" }; }
    if (abort.signal.aborted) break;
    const frame = encodeFrame(response);
    if (!validReply(JSON.parse(frame.subarray(4).toString("utf8")), request.id, hubId, chatId, request.action, request.chatId, request.after, mode, hubChatId)) break;
    if (response.ok) { hubId = response.snapshot!.hubId; chatId = response.snapshot!.chatId; hubChatId = response.snapshot!.hubChatId; }
    if (!process.stdout.write(frame)) await once(process.stdout, "drain", { signal: abort.signal });
  }
} catch { /* No payload diagnostics or mutation replay on renderer loss. */ }
finally { stop(); process.stdin.destroy(); }
