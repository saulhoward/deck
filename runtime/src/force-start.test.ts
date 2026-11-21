import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc, defineTask, InboxDoc, LiveDoc, type StorageWrite, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { requireIdleStorage } from "./compatibility.js";
import { DeckRuntime } from "./deck.js";
import { discardUnfinished } from "./force-start.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";

const parked = defineTask<{}, { phase: "parked" }, null>({ name: "test.missing-definition", version: 1, initial: () => ({ phase: "parked" }), phases: { parked: async () => {} }, abort: async () => {} });
const Scratch = defineDoc<{ value: string }>({ kind: "test.task-scratch", version: 1, scope: "task", initial: () => ({ value: "scratch" }), checkpointWhen: () => true });

test("force atomically abandons all task phases, owned/background work and inboxes without running them or forgetting request IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-force-")), path = join(root, "session.sqlite");
  const { faux, models } = provider();
  const options = { models, model, implementation: IMPLEMENTATION, binding: { machineId: "hub", cwd: root }, environment: () => undefined };
  let runtime = await DeckRuntime.open(path, options);
  try {
    const hub = runtime.hubId, main = String(runtime.main.id);
    const settled = { requestId: "done", mode: "followUp" as const, text: "settled" };
    faux.setResponses([fauxAssistantMessage("done")]);
    const done = await (await runtime.admit(main, settled)).wait(ctx), history = await runtime.history(main);
    const worker = await runtime.createTask("Worker chat", { machineId: "offline", cwd: root }, "creation");
    const saved = await worker.commit(async tx => {
      const parent = await tx.createTask(parked, {}, { ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: parent } });
      const task = await tx.createTask(parked, {}, { ownership: { kind: "conversation" }, conversationId: child.id });
      await tx.doc(Scratch, task);
      const ids: TaskId[] = [];
      for (let i = 0; i < 105; i++) ids.push(await tx.createTask(parked, {}, { ownership: { kind: "task", taskId: parent } }));
      const entry = await tx.appendEntry(worker.id, { kind: "test.placed", data: "retain placed entry" });
      const placed = await tx.createSubmission({ conversationId: worker.id, requestId: "placed", type: "input", status: "placed", entry: entry.id });
      const live = await tx.doc(LiveDoc, worker.id);
      live.run = { taskId: parent, inputs: [placed.id] }; live.generation = { attempt: 1 };
      live.tools = [{ callId: "uncertain", name: "bash", status: "running", taskId: task }];
      const q = await tx.createSubmission({ conversationId: worker.id, requestId: "queued", type: "input", status: "queued" });
      const w = await tx.createSubmission({ conversationId: worker.id, type: "write", status: "queued" });
      (await tx.doc(InboxDoc, worker.id)).items = [{ id: q.id, mode: "followUp", content: "never place" }, { id: w.id, mode: "write", entry: { kind: "never.place" } }];
      return { parent, child, task, ids, placed, q, w, entry };
    }, ctx);
    await runtime.close();
    const storage = await openNodeSqliteStorage(path);
    try {
      // Persist precise crash states on this offline fixture. Harness.open would
      // normalize 'running' and cannot be used as a destructive reset mechanism.
      const writes: StorageWrite[] = [];
      for (const [i, status] of (["running", "waiting", "sleeping", "completing"] as const).entries()) {
        const r = (await storage.task(saved.ids[i]!, ctx))!;
        const checkpoint = { phase: "parked" };
        if (status === "completing") {
          const { memos, ...base } = r;
          writes.push({ type: "task", value: { ...base, state: { status, outcome: { status: "failed", error: { message: "already decided" } } } } });
          continue;
        }
        const state = status === "waiting" ? { status, checkpoint, on: [saved.task], policy: "allSettled" as const }
          : status === "sleeping" ? { status, checkpoint, until: Date.now() + 60000 } : { status, checkpoint };
        writes.push({ type: "task", value: { ...r, state } });
      }
      await storage.commit(writes, ctx);
      await assert.rejects(discardUnfinished(storage, "wrong hub"), /Hub identity/);
      const commit = storage.commit.bind(storage);
      storage.commit = async () => { throw new Error("injected before commit"); };
      await assert.rejects(discardUnfinished(storage, hub), /injected before commit/);
      storage.commit = commit;
      assert.equal((await storage.task(saved.ids[0]!, ctx))!.state.status, "running");
      assert.equal((await storage.submission(saved.placed.id, ctx))!.status, "placed");
      await assert.rejects(requireIdleStorage(storage));
      assert.deepEqual(await discardUnfinished(storage, hub), { tasks: 107, submissions: 3 });
      await requireIdleStorage(storage);
      assert.deepEqual(await discardUnfinished(storage, hub), { tasks: 0, submissions: 0 });
      assert.equal((await storage.task(saved.task, ctx))!.state.outcome?.status, "aborted");
      assert.equal((await storage.task(saved.ids[3]!, ctx))!.state.outcome?.status, "failed");
      assert.equal((await storage.scanDocuments({ scope: { kind: "task", taskId: saved.task }, at: "current" }, 1, undefined, ctx)).items.length, 0);
      assert.deepEqual(await storage.conversation(saved.child.id, ctx), saved.child);
      for (const s of [saved.q, saved.w, saved.placed]) assert.deepEqual(await storage.submission(s.id, ctx), { ...s, status: "unanswered", reason: "discarded_by_force_start" });
      assert.deepEqual(await storage.submission(done.id, ctx), done);
    } finally { await storage.close(ctx); }
    runtime = await DeckRuntime.open(path, { ...options, implementation: "c".repeat(64) });
    assert.equal(runtime.hubId, hub);
    assert.deepEqual(await runtime.history(main), history);
    assert.deepEqual(await (await runtime.admit(main, settled)).wait(ctx), done);
    const id = String(worker.id), activity = await runtime.activity(id);
    assert.equal(activity.busy, false); assert.deepEqual(activity.tools, []); assert.equal(activity.queued, 0);
    assert.equal((await (await runtime.admit(id, { requestId: "queued", mode: "followUp", text: "never place" })).wait(ctx)).id, saved.q.id);
    assert.equal(faux.state.callCount, 1);
    faux.setResponses([fauxAssistantMessage("new answer")]);
    await (await runtime.admit(id, { requestId: "new", mode: "followUp", text: "new input" })).wait(ctx);
    assert.equal(faux.state.callCount, 2);
    const visible = (await runtime.history(id)).items.filter(e => e.kind !== "pi.system").reverse();
    assert.deepEqual(visible.map(e => e.kind), ["test.placed", "deck.input", "pi.assistant"]);
    assert.equal((visible[1]!.data as { text: string }).text, "new input");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
