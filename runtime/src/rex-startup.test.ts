import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, defineTask } from "@earendil-works/pi-durable";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { RexDoc, type RexPlan, type RexTarget } from "./rex-allocation.js";
import { IMPLEMENTATION, model, provider, gate, within } from "./instructions.test.support.js";
const uuid = "12345678-1234-1234-1234-123456789abc";
const block = `block:${uuid}`; const other = "block:00000000-0000-0000-0000-000000000000";
const binding = { machineId: "worker", cwd: "/saved" };
const target: RexTarget = { executable: "/tools/rex", client: "/tools/deck", server: "unix:///tmp/rex.sock", hostId: uuid, instanceId: uuid, port: 52800 };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "deck-rex-startup-")); const { models } = provider(); const entered = gate(); const release = gate();
  let plan!: RexPlan; let calls = 0; let uncertain = false;
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), { models, model, binding, implementation: IMPLEMENTATION, environment: () => undefined,
    hostFiles: { call: async (_binding, _id, operation, args) => {
      assert.equal(operation, "rex_allocate"); plan = JSON.parse(String(args.plan)) as RexPlan; calls++; entered.release(); await release.promise;
      return uncertain ? { ok: false, code: "effect_uncertain", output: "PRIVATE_ERROR" } : { ok: true, code: "allocated", output: JSON.stringify({ version: 1, allocationId: plan.allocationId, server: plan.server, hostId: plan.hostId, instanceId: plan.instanceId, hubId: plan.hubId, chatId: plan.chatId, sessionId: `session:${uuid}`, windowId: `window:${uuid}`, blockId: block, readiness: "not_checked" }) };
    } },
  });
  const chat = await runtime.createTask("Rex startup", binding); const id = String(chat.id);
  const task = await runtime.allocateTerminal(id, "start", target); await within(entered.promise);
  return { runtime, chat, id, task, allocation: plan.allocationId!, release: release.release, calls: () => calls, uncertain: () => { uncertain = true; }, close: async () => { release.release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("startup before or after native binding joins by saved intent + native block, without inference or another task", async () => {
  for (const early of [true, false]) {
    const local = await setup(); const { runtime, id, allocation, task } = local;
    try {
      assert.equal((await runtime.terminalStartup(id)).observation, "not_observed");
      if (!early) { local.release(); await runtime.harness.waitForTask(task, context); }
      const ack = await runtime.registerTerminalStartup(id, allocation, block);
      assert.equal(ack.registered, true); assert.equal(ack.observation, early ? "unbound" : "matched"); assert.equal(ack.taskId, String(task)); assert.equal(ack.historical, true); assert.equal(ack.live, "not_checked");
      if (early) { assert.equal(await runtime.terminalBinding(id), undefined); local.release(); await runtime.harness.waitForTask(task, context); }
      assert.equal((await runtime.terminalStartup(id)).observation, "matched");
      assert.equal((await runtime.registerTerminalStartup(id, allocation, block)).observation, "matched");
      assert.equal((await runtime.terminalBinding(id))?.readiness, "not_checked"); // Immutable creation outcome is not rewritten to "healthy".
      assert.deepEqual((await runtime.history(id)).items, []); assert.equal(local.calls(), 1);
      await assert.rejects(runtime.allocateTerminal(id, "another", target), { code: "conflict" });
      const tasks = await runtime.harness.commit((tx) => tx.scanTasks({ conversationId: local.chat.id }, 100), context); assert.equal(tasks.items.length, 1);
    } finally { await local.close(); }
  }
});

test("unbound/late-after-stop startup observations never reconcile uncertainty, revive execution, or allow recreation", async () => {
  for (const stop of [false, true]) {
    const local = await setup(); const { runtime, id, task, allocation } = local;
    try {
      local.uncertain();
      let stopping: Promise<void> | undefined;
      if (stop) stopping = runtime.stop(id);
      local.release(); await stopping; const settled = await runtime.harness.waitForTask(task, context);
      assert.equal(settled.state.outcome.status, "completed");
      const ack = await runtime.registerTerminalStartup(id, allocation, block); assert.equal(ack.observation, "unbound");
      assert.equal(await runtime.terminalBinding(id), undefined); assert.equal(local.calls(), 1);
      assert.deepEqual(await runtime.harness.getTask(task, context), settled);
      await assert.rejects(runtime.allocateTerminal(id, "replacement", target), { code: "conflict" });
      assert.deepEqual((await runtime.history(id)).items, []);
    } finally { await local.close(); }
  }
});

test("conflicting blocks and absent/wrong/legacy intent refuse; early conflicts cannot poison native binding evidence", async () => {
  const local = await setup(); const { runtime, id, allocation, task } = local;
  try {
    for (const value of ["", "short", "x".repeat(300)]) await assert.rejects(runtime.registerTerminalStartup(id, value, block), { code: "invalid" });
    await assert.rejects(runtime.registerTerminalStartup(id, uuid, block), { code: "conflict" });
    await assert.rejects(runtime.registerTerminalStartup(id, allocation, "block:short"), { code: "invalid" });
    const otherChat = await runtime.createTask("Other", binding);
    await assert.rejects(runtime.registerTerminalStartup(String(otherChat.id), allocation, block), { code: "conflict" });
    assert.equal(await runtime.harness.snapshot(RexDoc, otherChat.id, context), undefined);
    await runtime.registerTerminalStartup(id, allocation, other); // Arrives before authoritative native result.
    local.release(); await runtime.harness.waitForTask(task, context);
    assert.equal((await runtime.terminalBinding(id))?.blockId, block); assert.equal((await runtime.terminalStartup(id)).observation, "conflict");
    await assert.rejects(runtime.registerTerminalStartup(id, allocation, block), { code: "conflict" });
    await assert.rejects(runtime.registerTerminalStartup(id, allocation, other), { code: "conflict" });
    await local.chat.commit(async (tx) => { const doc = await tx.doc(RexDoc, local.chat.id); delete doc.allocationId; delete doc.startup; }, context);
    assert.equal((await runtime.terminalStartup(id)).observation, "not_observed");
    await assert.rejects(runtime.registerTerminalStartup(id, allocation, block), { code: "conflict" });
    assert.equal(await runtime.allocateTerminal(id, "start", target), task); assert.equal(local.calls(), 1);
  } finally { await local.close(); }
});

test("startup refuses authoritative ownership and worker/cwd drift despite plausible metadata", async () => {
  for (const change of ["worker", "cwd", "owner"]) {
    const local = await setup(); const { runtime, id, allocation, chat } = local;
    try {
      if (change === "owner") {
        const parked = defineTask<{}, { phase: "hold" }, null>({ name: "test.rex-startup-owner", version: 1, initial: () => ({ phase: "hold" }), phases: { hold: async () => {} }, abort: async () => {} });
        const child = await chat.commit(async (tx) => {
          const owner = await tx.createTask(parked, {}, { ownership: { kind: "conversation" }, background: true });
          const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
          Object.assign(await tx.doc(ChatDoc, child.id), { kind: "task", ...binding }); (await tx.doc(AgentDoc, child.id)).cwd = binding.cwd;
          Object.assign(await tx.doc(RexDoc, child.id), { taskId: local.task, allocationId: allocation }); return child;
        }, context);
        await assert.rejects(runtime.registerTerminalStartup(String(child.id), allocation, block), { code: "conflict" });
      } else {
        await chat.commit(async (tx) => { if (change === "worker") (await tx.doc(ChatDoc, chat.id)).machineId = "other"; else (await tx.doc(AgentDoc, chat.id)).cwd = "/other"; }, context);
        await assert.rejects(runtime.registerTerminalStartup(id, allocation, block), { code: "settings_changed" });
      }
      assert.equal((await runtime.terminalStartup(id)).observation, "not_observed");
    } finally { await local.close(); }
  }
});
