// Native-only maintenance channel. No public command, package installer or
// second executor. Pi remains the only admission/task owner.
import { Socket } from "node:net";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, Storage } from "@earendil-works/pi-durable";
import { unfinishedTasks, unfinishedSubmissions } from "./compatibility.js";
import type { DeckRuntime } from "./deck.js";
import type { RexRoutedFiles } from "./rex-routes.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { validWorkerHandoffAdmin, type WorkerHandoffReply } from "./generated/contracts.js";

// Called inside Harness.commit, so committed tasks/submissions/bindings are a
// coherent read while admission for this machine is fenced. No creating docs.
export async function workerIdle(storage: Storage, machine: string): Promise<boolean> {
  let count = 0;
  const bindings = new Map<number, string | undefined>();
  const assigned = async (id: ConversationId) => {
    if (!bindings.has(id)) {
      const record = await storage.findDocument({ kind: "deck.chat", scope: { kind: "conversation", conversationId: id } }, "current", context);
      const doc = record ? await storage.document(record.id, "current", context) : undefined;
      bindings.set(id, doc?.version === 1 && typeof doc.value.machineId === "string" ? doc.value.machineId : undefined);
    }
    const host = bindings.get(id); return host === undefined || host === machine;
  };
  for (const status of unfinishedTasks) {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanTasks({ status }, 100, cursor, context);
      for (const task of page.items) if (++count > 10_000 || await assigned(task.conversationId)) return false;
      cursor = page.next;
    } while (cursor);
  }
  for (const status of unfinishedSubmissions) {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanSubmissions({ status }, 100, cursor, context);
      for (const submission of page.items) if (++count > 10_000 || await assigned(submission.conversationId)) return false;
      cursor = page.next;
    } while (cursor);
  }
  return true;
}
export function serveWorkerHandoffs(runtime: DeckRuntime, routes: RexRoutedFiles, readFd: number, writeFd: number) {
  const reader = new Socket({ fd: readFd, readable: true, writable: false });
  let writer: Socket;
  try { writer = new Socket({ fd: writeFd, readable: false, writable: true }); }
  catch (error) { reader.destroy(); throw error; }
  const decoder = reader.pipe(new FrameDecoder());
  const close = () => { reader.destroy(); writer.destroy(); decoder.destroy(); };
  reader.on("error", close); writer.on("error", close); decoder.on("error", close);
  void (async () => {
    try {
      for await (const value of decoder) {
        if (!validWorkerHandoffAdmin(value) || value.plan.hubId !== runtime.hubId) throw new Error("Invalid native handoff");
        const { action, plan } = value;
        let status: WorkerHandoffReply["status"] = "deferred";
        if (action === "prepare") {
          const retained = routes.hasHandoff(plan);
          routes.checkHandoff(plan);
          await runtime.pauseWorker(plan.machineId, plan.id);
          const deadline = Date.now() + 2000;
          do {
            if (await runtime.workerDrained(plan.machineId, plan.id)) {
              if (routes.pauseHandoff(plan)) { status = "prepared"; break; }
            }
            await new Promise(resolve => setTimeout(resolve, 25));
          } while (Date.now() < deadline);
          if (status === "deferred") {
            if (retained) throw new Error("Retained handoff is not drained");
            routes.cancelHandoff(plan); await runtime.resumeWorker(plan.machineId, plan.id);
          }
        } else if (action === "commit") {
          if (!value.registration) throw new Error("Missing committed registration");
          routes.commitHandoff(plan, value.registration); status = "committed";
        } else {
          if (action === "cancel") routes.cancelHandoff(plan); else routes.finishHandoff(plan);
          await runtime.resumeWorker(plan.machineId, plan.id); status = "finished";
        }
        await new Promise<void>((resolve, reject) => writer.write(encodeFrame({ kind: "worker_upgrade", hubId: runtime.hubId, id: plan.id, status } satisfies WorkerHandoffReply), error => error ? reject(error) : resolve()));
      }
    } catch { /* Fail closed: a lost maintenance channel never clears a fence. */ }
    finally { close(); }
  })();
  return { close };
}
