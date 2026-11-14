// Hub-only worker-link endpoint. Uses the existing Harness/dispatch and durable
// admission identities; never a second command store, executor or retry queue.
import { Socket } from "node:net";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type TaskId } from "@earendil-works/pi-durable";
import { ChatDoc, DeckError, type DeckRuntime } from "./deck.js";
import { RexDoc, REX_KIND, type RexInput } from "./rex-allocation.js";
import { dispatch } from "./ipc.js";
import { launcherResponse } from "./launcher-hub.js";
import { validWorkerFrame, validRexRegistration } from "./remote-contracts.js";
import { validRexRegistrationFrame, type RexWorkerRegistration } from "./generated/contracts.js";
import { validClientRequest } from "./command-contracts.js";
import { validSafePiId } from "./mutation-contracts.js";
import { validRexAllocationPlan, type TaskRelayFrame, type WorkerRexClient, type ResponseEnvelope } from "./generated/contracts.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { responseFrame } from "./responses.js";
const allowed = new Set(["status", "history", "activity", "progress", "instruction_status", "model_settings", "set_model_settings", "rex_status", "rex_inspect", "rex_startup", "admit", "stop", "import_instructions"]);
// rex_open is deliberately hub-controlled: replacement revokes the old client's
// allocation. A terminal cannot manufacture another terminal's authority.
export async function taskClientResponse(runtime: DeckRuntime, machineId: string, client: WorkerRexClient, frame: TaskRelayFrame): Promise<string> {
  if (!validWorkerFrame(frame) || !frame.scope || frame.launcher) throw new Error("Invalid task authority");
  const request: unknown = JSON.parse(frame.body);
  if (!validClientRequest(request)) throw new Error("Invalid task command");
  const scope = frame.scope, args = request.args as Record<string, unknown>;
  const guard = async () => {
    const refuse = () => { throw new DeckError("conflict", "Remote task scope unavailable; earlier requests may have applied"); };
    try {
      if (!allowed.has(request.command) || scope.hubId !== runtime.hubId || request.hubId !== scope.hubId || args?.chatId !== scope.chatId || !validSafePiId(scope.chatId) || scope.chatId === String(runtime.main.id)) refuse();
      const chat = await runtime.chat(scope.chatId);
      const record = await runtime.harness.commit(tx => tx.conversation(chat.id), context);
      const [binding, agent, doc] = await Promise.all([runtime.harness.snapshot(ChatDoc, chat.id, context), runtime.harness.snapshot(AgentDoc, chat.id, context), runtime.harness.snapshot(RexDoc, chat.id, context)]);
      const task = doc?.taskId ? await runtime.harness.getTask(doc.taskId as TaskId, context) : undefined;
      const input = task?.input as RexInput | undefined;
      if (!record || record.owner || binding?.kind !== "task" || binding.machineId !== machineId || agent?.cwd !== binding.cwd ||
          !doc || doc.allocationId !== scope.allocationId || task?.kind !== REX_KIND || task.conversationId !== chat.id ||
          input?.binding.machineId !== machineId || input.binding.cwd !== binding.cwd || !validRexAllocationPlan(input.plan) ||
          input.plan.hubId !== scope.hubId || input.plan.chatId !== scope.chatId || input.plan.allocationId !== scope.allocationId ||
          input.plan.client !== client.executable || input.plan.workerSocket !== client.socket ||
          (doc.binding && doc.binding.blockId !== scope.blockId) || (doc.startup && doc.startup.blockId !== scope.blockId)) refuse();
      if (request.command === "rex_startup" && (args.allocationId !== scope.allocationId || args.blockId !== scope.blockId)) refuse();
      if (!["status", "history", "rex_startup"].includes(request.command) && doc?.startup?.blockId !== scope.blockId) refuse();
    } catch { refuse(); } // No cross-task existence/ownership oracle or private lookup diagnostics.
  };
  let response: ResponseEnvelope;
  try { response = { version: 1, id: request.id, ok: true, result: await runtime.guardedCommand(guard, () => dispatch(runtime, request, undefined, true)) }; }
  catch (error) { response = { version: 1, id: request.id, ok: false, error: { code: error instanceof DeckError ? error.code : "runtime_failed", message: error instanceof DeckError ? error.message : "Task command failed; outcome unconfirmed" } }; }
  return responseFrame(response, request).subarray(4).toString("utf8");
}
type ClientTarget = { machineId: string; client: WorkerRexClient; launcher: boolean };
export function serveWorkerClients(runtime: DeckRuntime, machineId: string, client: WorkerRexClient, readFd: number, writeFd: number, launcher = false) {
  return serveClients(runtime, readFd, writeFd, { machineId, client, launcher });
}
export function serveAutomaticWorkerClients(runtime: DeckRuntime, readFd: number, writeFd: number, register: (registration: RexWorkerRegistration) => void) {
  return serveClients(runtime, readFd, writeFd, undefined, register);
}
function serveClients(runtime: DeckRuntime, readFd: number, writeFd: number, target?: ClientTarget, register?: (registration: RexWorkerRegistration) => void) {
  const reader = new Socket({ fd: readFd, readable: true, writable: false });
  let writer: Socket;
  try { writer = new Socket({ fd: writeFd, readable: false, writable: true }); }
  catch (error) { reader.destroy(); throw error; }
  const decoder = reader.pipe(new FrameDecoder()); let closed = false;
  const pending = new Set<string>(); let writes = Promise.resolve();
  const close = () => { if (!closed) { closed = true; reader.destroy(); writer.destroy(); decoder.destroy(); } };
  reader.on("error", close); writer.on("error", close); decoder.on("error", close);
  void (async () => {
    try {
      for await (const raw of decoder) {
        if (!target) {
          if (!register || !validRexRegistrationFrame(raw) || !validRexRegistration(raw.registration) || raw.registration.hubId !== undefined && raw.registration.hubId !== runtime.hubId) throw new Error("Invalid native registration");
          register({ ...raw.registration, hubId: runtime.hubId });
          target = { machineId: raw.registration.machineId, client: raw.registration.rexClient, launcher: true };
          await new Promise<void>((resolve, reject) => writer.write(encodeFrame({ kind: "registered", hubId: runtime.hubId }), error => error ? reject(error) : resolve()));
          continue;
        }
        const { machineId, client, launcher } = target;
        if (!validWorkerFrame(raw) || pending.size >= 8) throw new Error();
        const key = `${raw.connectionId}:${raw.id}`; if (pending.has(key)) throw new Error(); pending.add(key);
        void (async () => {
          try {
            const body = raw.launcher ? await launcherResponse(runtime, machineId, launcher, raw) : await taskClientResponse(runtime, machineId, client, raw);
            if (closed) return;
            let frame: Buffer;
            try { frame = encodeFrame({ ...raw, body }); }
            catch { const request = JSON.parse(raw.body); frame = encodeFrame({ ...raw, body: JSON.stringify({ version: 1, id: request.id, ok: false, error: { code: "too_large", message: "Task response exceeds relay limit; outcome unconfirmed" } }) }); }
            const encoded = frame;
            writes = writes.then(() => new Promise<void>((resolve, reject) => writer.write(encoded, error => error ? reject(error) : resolve())));
            await writes;
          } catch { close(); }
          finally { pending.delete(key); }
        })();
      }
    } catch { /* Payload-free fail-closed handling. No request replay or stop. */ }
    finally { close(); }
  })();
  return { close };
}
