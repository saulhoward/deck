import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import { DeckRuntime } from "./deck.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";

for (const busy of ["background", "queued", "placed"] as const) test(`worker handoff fences only its machine and checks canonical ${busy} work`, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-live-drain-"));
  const { models } = provider();
  const runtime = await DeckRuntime.open(join(root, "session.sqlite"), { models, model, implementation: IMPLEMENTATION, binding: { machineId: "local", cwd: root }, environment: () => undefined });
  try {
    const worker = await runtime.createTask("Worker", { machineId: "worker", cwd: root });
    const other = await runtime.createTask("Other machine", { machineId: "other", cwd: root });
    const task = defineTask<{}, { phase: "parked" }, null>({ name: "test.live-upgrade-parked", version: 1, initial: () => ({ phase: "parked" }), phases: { parked: async () => {} }, abort: async () => {} });
    await other.commit(tx => tx.createTask(task, {}, { ownership: { kind: "conversation" }, background: true }), context);
    await runtime.pauseWorker("worker", "transition");
    assert.equal(await runtime.workerDrained("worker", "transition"), true, "another machine's unfinished work is not a global drain requirement");
    await assert.rejects(runtime.createTask("Fenced", { machineId: "worker", cwd: root }), { code: "busy" });
    await assert.rejects(runtime.admit(String(worker.id), { requestId: "not-admitted", text: "No effects", mode: "followUp" }), { code: "busy" });
    await assert.rejects(runtime.pauseWorker("worker", "different"), { code: "busy" });
    await assert.rejects(runtime.resumeWorker("worker", "different"), { code: "conflict" });
    await runtime.createTask("Unaffected", { machineId: "other", cwd: root });
    // Hidden canonical records, not activity panel samples, decide drainage.
    await worker.commit(async tx => {
      if (busy === "background") await tx.createTask(task, {}, { ownership: { kind: "conversation" }, background: true });
      else if (busy === "queued") await tx.createSubmission({ conversationId: worker.id, type: "input", status: "queued" });
      else {
        const entry = await tx.appendEntry(worker.id, { kind: "test.input", model: [{ role: "user", content: "pending", timestamp: 0 }] });
        await tx.createSubmission({ conversationId: worker.id, type: "input", status: "placed", entry: entry.id });
      }
    }, context);
    assert.equal((await runtime.activity(String(worker.id))).busy, false);
    assert.equal(await runtime.workerDrained("worker", "transition"), false);
    await runtime.resumeWorker("worker", "transition");
    await runtime.createTask("Allowed again", { machineId: "worker", cwd: root });
    assert.equal((await runtime.history(String(worker.id))).items.some(item => item.kind === "deck.input"), false);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
