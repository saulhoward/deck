import { once } from "node:events";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { taskCommand, taskScope } from "./task-client.js";
import { displayText, TuiSession, localSession, validRequest, validReply } from "./tui-session.js";
import { validRexUuid } from "./generated/contracts.js";
import { validMutationArgs } from "./mutation-contracts.js";
import { bootstrapRecord, bootstrapPath, StartupFiles, finishStartup } from "./agent-storage.js";
import { startupDraft } from "./agent-wizard.js";

const args = process.argv.slice(2); let port = 52800, chatId: string | undefined, hubId: string | undefined, allocationId: string | undefined, workerSocket: string | undefined, bootstrapId: string | undefined, clientState: string | undefined;
try {
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!value) throw new Error();
    if (key === "--port" && /^\d+$/.test(value)) port = Number(value);
    else if (key === "--task" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) chatId = value;
    else if (key === "--hub-id" && value.length <= 200) hubId = value;
    else if (key === "--rex-allocation" && validRexUuid(value)) allocationId = value;
    else if (key === "--worker-socket") workerSocket = value;
    else if (key === "--agent-bootstrap" && validRexUuid(value)) bootstrapId = value;
    else if (key === "--client-state" && value.startsWith("/") && !value.includes("\0") && Buffer.byteLength(value) <= 4096) clientState = value;
    else throw new Error();
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  if (bootstrapId && (!allocationId || !clientState)) throw new Error();
  if (workerSocket) taskScope(hubId, chatId, allocationId, process.env.REX_BLOCK);
  if (allocationId && (!hubId || !validMutationArgs("rex_startup", { chatId, allocationId, blockId: process.env.REX_BLOCK }))) throw new Error();
} catch { process.exit(2); }
const abort = new AbortController();
const decoder = process.stdin.pipe(new FrameDecoder());
const stop = () => { abort.abort(); decoder.destroy(); };
process.stdin.on("end", stop); process.stdin.on("error", stop); process.stdout.on("error", stop);
const scope = workerSocket ? taskScope(hubId, chatId, allocationId, process.env.REX_BLOCK) : undefined;
const bootstrap = bootstrapId ? await bootstrapRecord(clientState!, bootstrapId).catch(() => undefined) : undefined;
if (bootstrapId && (!bootstrap || bootstrap.hubId !== hubId || bootstrap.claim?.chatId !== chatId || bootstrap.claim?.allocationId !== allocationId || bootstrap.workerSocket !== workerSocket || bootstrap.port !== port)) process.exit(2);
const session = scope ? new TuiSession((name, args, expected) => taskCommand(workerSocket!, scope, name, args, expected, abort.signal), chatId, hubId, clientState, port) : localSession(port, chatId, hubId, abort.signal, clientState);
const mode = allocationId ? "task" : "hub";
let hubChatId: string | undefined;
try {
  // Before any renderer snapshot or input: exact allocation-bound historical
  // registration. Failure closes this helper; there is no startup retry loop.
  if (allocationId) await session.registerStartup(allocationId, process.env.REX_BLOCK);
  if (bootstrap) {
    const files = new StartupFiles(bootstrapPath(bootstrap.draftRoot, bootstrap.id));
    const draft = await startupDraft(bootstrap, files);
    if (!draft) throw new Error("Initial input draft missing");
    if (await files.read("discarded.json") === undefined && await files.claim("input-attempt.json") && await session.startInitial(draft.inputId)) {
      try { await files.publish("completed.json", { version: 1, inputId: draft.inputId }); await finishStartup(bootstrap); }
      catch { /* ACK was already validated; retain cleanup metadata without resubmitting or stopping work. */ }
    }
  }
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
