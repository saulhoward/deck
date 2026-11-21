import { once } from "node:events";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { taskCommand, taskScope } from "./task-client.js";
import { displayText, TuiSession, TuiRequestNotSent, localSession, validRequest, validReply } from "./tui-session.js";
import { validRexUuid, validMachineIdentity, type TuiResponse } from "./generated/contracts.js";
import { attachedCommand } from "./attached-client.js";
import { validMutationArgs } from "./mutation-contracts.js";
import { bootstrapRecord, hereRecord, bootstrapPath, StartupFiles, finishStartup } from "./agent-storage.js";
import { startupDraft } from "./agent-wizard.js";

const args = process.argv.slice(2); let attachMachine: string | undefined, hereStartup: string | undefined;
let port = 52800, chatId: string | undefined, hubId: string | undefined, allocationId: string | undefined, workerSocket: string | undefined, bootstrapId: string | undefined, clientState: string | undefined;
try {
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!value) throw new Error();
    if (key === "--port" && /^\d+$/.test(value)) port = Number(value);
    else if (key === "--task" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) chatId = value;
    else if (key === "--hub-id" && value.length <= 200) hubId = value;
    else if (key === "--rex-allocation" && validRexUuid(value)) allocationId = value;
    else if (key === "--worker-socket") workerSocket = value;
    else if (key === "--here-startup" && validRexUuid(value)) hereStartup = value;
    else if (key === "--attach-machine" && validMachineIdentity(value)) attachMachine = value;
    else if (key === "--agent-bootstrap" && validRexUuid(value)) bootstrapId = value;
    else if (key === "--client-state" && value.startsWith("/") && !value.includes("\0") && Buffer.byteLength(value) <= 4096) clientState = value;
    else throw new Error();
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  if (bootstrapId && (!allocationId || !clientState)) throw new Error();
  if (hereStartup && ((!attachMachine && !allocationId) || !clientState || bootstrapId)) throw new Error();
  if (attachMachine && (allocationId || bootstrapId || !validRexUuid(hubId) || !chatId)) throw new Error();
  if (workerSocket && !attachMachine) taskScope(hubId, chatId, allocationId, process.env.REX_BLOCK);
  if (allocationId && (!hubId || !validMutationArgs("rex_startup", { chatId, allocationId, blockId: process.env.REX_BLOCK }))) throw new Error();
} catch { process.exit(2); }
const abort = new AbortController();
const decoder = process.stdin.pipe(new FrameDecoder());
const stop = () => { abort.abort(); decoder.destroy(); };
process.stdin.on("end", stop); process.stdin.on("error", stop); process.stdout.on("error", stop);
const scope = workerSocket && !attachMachine ? taskScope(hubId, chatId, allocationId, process.env.REX_BLOCK) : undefined;
const bootstrap = bootstrapId ? await bootstrapRecord(clientState!, bootstrapId).catch(() => undefined) : undefined;
if (bootstrapId && (!bootstrap || bootstrap.here || bootstrap.hubId !== hubId || bootstrap.claim?.chatId !== chatId || bootstrap.claim?.allocationId !== allocationId || bootstrap.workerSocket !== workerSocket || bootstrap.port !== port)) process.exit(2);
const here = hereStartup ? await hereRecord(clientState!, hereStartup).catch(() => undefined) : undefined;
if (hereStartup && (!here || here.hubId !== hubId || (attachMachine !== undefined && here.machineId !== attachMachine) || here.workerSocket !== workerSocket || here.port !== port)) process.exit(2);
// Transport authority never follows the renderer selection into a child.
const attachedChatId = chatId;
const session = attachMachine && workerSocket
  ? new TuiSession((name, args, expected) => attachedCommand({ hubId: hubId!, machineId: attachMachine!, socket: workerSocket! }, attachedChatId!, name, args, expected, abort.signal), chatId, hubId, clientState, port)
  : scope ? new TuiSession((name, args, expected) => taskCommand(workerSocket!, scope, name, args, expected, abort.signal), chatId, hubId, clientState, port) : localSession(port, chatId, hubId, abort.signal, clientState);
const mode = allocationId || attachMachine ? "task" : "hub";
let hubChatId: string | undefined, inspectParentChatId: string | undefined;
try {
  // Before any renderer snapshot or input: exact allocation-bound historical
  // registration. Failure closes this helper; there is no startup retry loop.
  if (allocationId) await session.registerStartup(allocationId, process.env.REX_BLOCK, here ? { machineId: here.machineId, cwd: here.cwd } : undefined);
  if (attachMachine) await session.registerAttachment(attachMachine, here?.cwd);
  const startup = bootstrap ?? here;
  if (startup) {
    const files = new StartupFiles(bootstrapPath(startup.draftRoot, startup.id));
    const draft = await startupDraft(startup, files);
    if (!draft) throw new Error("Startup form missing");
    if (here) {
      const created = await files.read("created.json") as { requestId?: unknown; chatId?: unknown } | undefined;
      if (!created || created.requestId !== draft.creationId || created.chatId !== chatId || JSON.stringify(created) !== JSON.stringify({ requestId: created.requestId, chatId: created.chatId })) throw new Error("Current-terminal creation receipt changed");
    }
    // Opening a task is not input admission. In particular, never replay an
    // older client's saved problem draft; it remains for explicit user handling.
    if (await files.read("discarded.json") === undefined) {
      try {
        if (await files.read("completed.json") === undefined) await files.publish("completed.json", { version: 1 });
        await finishStartup(startup);
      } catch { /* Startup was verified; retain cleanup metadata without replaying or stopping work. */ }
    }
  }
  for await (const request of decoder) {
    if (abort.signal.aborted || !validRequest(request)) break;
    let response: TuiResponse;
    try { response = { version: 1, id: request.id, ok: true, snapshot: await session.handle(request) }; }
    catch (error) { response = { version: 1, id: request.id, ok: false, ...(error instanceof TuiRequestNotSent ? { notSent: true as const } : {}), error: displayText(error instanceof Error ? error.message : "Client request failed; outcome unconfirmed", 1024) || "Client request failed" }; }
    if (abort.signal.aborted) break;
    const frame = encodeFrame(response);
    if (!validReply(JSON.parse(frame.subarray(4).toString("utf8")), request.id, hubId, chatId, request.action, request.chatId, request.after, mode, hubChatId, inspectParentChatId, request.entryId, request.offset)) break;
    if (response.ok) { hubId = response.snapshot!.hubId; chatId = response.snapshot!.chatId; hubChatId = response.snapshot!.hubChatId; inspectParentChatId = response.snapshot!.inspectParentChatId; }
    if (!process.stdout.write(frame)) await once(process.stdout, "drain", { signal: abort.signal });
  }
} catch { /* No payload diagnostics or mutation replay on renderer loss. */ }
finally { stop(); process.stdin.destroy(); }
