import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, defineTask, type TaskId } from "@earendil-works/pi-durable";
import { ChatDoc, DeckRuntime } from "./deck.js";
import type { HostFiles } from "./host-files.js";
import { RexDoc, REX_KIND, type RexPlan, type RexResult, type RexTarget } from "./rex-allocation.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";
const uuid = "12345678-1234-1234-1234-123456789abc";
const target: RexTarget = { executable: "/tools/rex", server: "unix:///tmp/rex.sock", hostId: uuid, instanceId: uuid, client: "/tools/deck", port: 52800 };
const binding = { machineId: "worker", cwd: "/saved" };
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
function allocated(plan: RexPlan) { return { ok: true, code: "allocated", output: JSON.stringify({ version: 1, allocationId: plan.allocationId, server: plan.server, hostId: plan.hostId, instanceId: plan.instanceId, chatId: plan.chatId, hubId: plan.hubId, sessionId: `session:${uuid}`, windowId: `window:${uuid}`, blockId: `block:${uuid}`, readiness: "not_checked", private: "PRIVATE_NATIVE_DETAILS" }) }; }
async function result(runtime: DeckRuntime, id: TaskId<RexResult>) {
  const task = await runtime.harness.waitForTask(id, context); assert.equal(task.state.outcome.status, "completed");
  if (task.state.outcome.status !== "completed") throw new Error("Expected normal result"); return task.state.outcome.result;
}
async function setup(host?: HostFiles) {
  const directory = await mkdtemp(join(tmpdir(), "deck-rex-pi-")); const { models } = provider();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), { models, model, binding, implementation: IMPLEMENTATION, environment: () => undefined, ...(host ? { hostFiles: host } : {}) });
  return { runtime, close: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}
test("Rex admission/task/result/binding are Pi-owned and retries do not allocate again, infer, or claim readiness", async () => {
  let calls = 0; let operationId = "";
  const local = await setup({ call: async (saved, id, op, args) => { calls++; operationId = id; assert.deepEqual(saved, binding); assert.equal(op, "rex_allocate"); return allocated(JSON.parse(String(args.plan)) as RexPlan); } });
  const { runtime } = local;
  try {
    const chat = await runtime.createTask("Task", binding); const id = String(chat.id);
    const task = await runtime.allocateTerminal(id, "open", target); const applied = await result(runtime, task);
    assert.equal(applied.status, "allocated"); assert.equal(operationId, String(task)); assert.equal(calls, 1);
    if (applied.status !== "allocated") throw new Error("Expected allocation");
    assert.equal(applied.binding.readiness, "not_checked"); assert.equal(applied.binding.chatId, id); assert.equal(applied.binding.hubId, runtime.hubId);
    assert.deepEqual(await runtime.terminalBinding(id), applied.binding); assert.doesNotMatch(JSON.stringify(applied), /PRIVATE_/);
    assert.equal((await runtime.history(id)).items.length, 0);
    assert.equal(await runtime.allocateTerminal(id, "open", target), task); assert.equal(calls, 1);
    await assert.rejects(runtime.allocateTerminal(id, "open", { ...target, port: 52801 }), { code: "conflict" });
    await assert.rejects(runtime.allocateTerminal(id, "another", target), { code: "conflict" });
    await assert.rejects(runtime.allocateTerminal(id, "open", target, undefined, { ...binding, cwd: "/other" }), { code: "conflict" });
    assert.equal((await runtime.harness.commit((tx) => tx.scanTasks({ kind: REX_KIND }, 10), context)).items.length, 1);
    // Existing receipts survive raw settings drift; a binding is creation provenance,
    // not a current health check. Forks/independent tasks do not acquire it.
    await chat.commit(async (tx) => { (await tx.doc(ChatDoc, chat.id)).cwd = "/drift"; }, context);
    assert.equal(await runtime.allocateTerminal(id, "open", target), task);
    const other = await runtime.createTask("Other", binding); assert.equal(await runtime.terminalBinding(String(other.id)), undefined);
  } finally { await local.close(); }
});

test("Rex allocation refuses main/owned/unmanaged/incoherent/no-native targets before effects, with no default server", async () => {
  let calls = 0; const local = await setup({ call: async () => { calls++; throw new Error("No effects"); } }); const { runtime } = local;
  try {
    await assert.rejects(runtime.allocateTerminal(String(runtime.main.id), "main", target), { code: "invalid" });
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await assert.rejects(runtime.allocateTerminal(String(unmanaged.id), "unmanaged", target), { code: "invalid" });
    const parked = defineTask<{}, { phase: "hold" }, null>({ name: "test.rex-owner", version: 1, initial: () => ({ phase: "hold" }), phases: { hold: async () => {} }, abort: async () => {} });
    const owned = await runtime.main.commit(async (tx) => {
      const owner = await tx.createTask(parked, {}, { ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
      Object.assign(await tx.doc(ChatDoc, child.id), { kind: "task", title: "Misleading task metadata", ...binding });
      (await tx.doc(AgentDoc, child.id)).cwd = binding.cwd;
      return child.id;
    }, context);
    await assert.rejects(runtime.allocateTerminal(String(owned), "owned", target), { code: "invalid" });
    const chat = await runtime.createTask("Bad cwd", binding);
    await chat.commit(async (tx) => { (await tx.doc(AgentDoc, chat.id)).cwd = "/other"; }, context);
    await assert.rejects(runtime.allocateTerminal(String(chat.id), "bad", target), { code: "invalid" });
    const valid = await runtime.createTask("Valid", binding);
    for (const change of [{ server: "http://127.0.0.1:1" }, { server: "unix:///tmp/a?secret" }, { client: "deck" }, { port: 0 }, { hostId: "short" }]) await assert.rejects(runtime.allocateTerminal(String(valid.id), "invalid", { ...target, ...change }), { code: "invalid" });
    await assert.rejects(runtime.allocateTerminal(String(valid.id), "binding", target, undefined, { ...binding, machineId: "other" }), { code: "settings_changed" });
    const abort = new AbortController(); abort.abort(); await assert.rejects(runtime.allocateTerminal(String(valid.id), "abort", target, abort.signal), { name: "AbortError" });
    assert.equal(calls, 0); assert.equal(await runtime.harness.snapshot(RexDoc, valid.id, context), undefined);
  } finally { await local.close(); }
  const offline = await setup();
  try { const chat = await offline.runtime.createTask("Offline", binding); await assert.rejects(offline.runtime.allocateTerminal(String(chat.id), "offline", target), { code: "offline" }); }
  finally { await offline.close(); }
});

test("Rex worker uncertainty, malformed results and refusals never apply a binding or permit a fresh allocation", async () => {
  for (const code of ["effect_uncertain", "busy", "conflict", "server_unavailable", "invalid", "offline", "cancelled", "malformed", "wrong_scope", "throws"]) {
    let calls = 0;
    const local = await setup({ call: async (_saved, _id, _op, args) => {
      calls++; const plan = JSON.parse(String(args.plan)) as RexPlan;
      if (code === "throws") throw new Error("PRIVATE_ERROR");
      if (code === "malformed") return { ok: true, code: "allocated", output: "PRIVATE_INVALID" };
      if (code === "wrong_scope") return allocated({ ...plan, chatId: "999" });
      return { ok: false, code, output: "PRIVATE_WORKER_DETAILS" };
    } });
    try {
      const chat = await local.runtime.createTask(code, binding); const task = await local.runtime.allocateTerminal(String(chat.id), "open", target);
      const outcome = await result(local.runtime, task);
      assert.equal(outcome.status, ["server_unavailable", "invalid", "offline", "cancelled"].includes(code) ? "not_allocated" : "uncertain", code);
      assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_/); assert.equal(await local.runtime.terminalBinding(String(chat.id)), undefined);
      assert.equal(await local.runtime.allocateTerminal(String(chat.id), "open", target), task);
      await assert.rejects(local.runtime.allocateTerminal(String(chat.id), "new", target), { code: "conflict" }); assert.equal(calls, 1);
    } finally { await local.close(); }
  }
});

test("Rex I/O does not hold admission; raw binding drift refuses apply and stop drains without claiming creation was undone", async () => {
  for (const stop of [false, true]) {
    const entered = gate(); const drain = gate(); let cancelled = false;
    const local = await setup({ call: async (_saved, _id, _op, args, signal) => {
      entered.release(); signal?.addEventListener("abort", () => { cancelled = true; }, { once: true }); await drain.promise;
      return allocated(JSON.parse(String(args.plan)) as RexPlan);
    } });
    try {
      const chat = await local.runtime.createTask("Waiting", binding); const id = String(chat.id);
      const task = await local.runtime.allocateTerminal(id, "open", target); await entered.promise;
      const other = await local.runtime.createTask("Unrelated", { machineId: "other", cwd: "/other" }); assert.ok(other.id);
      await assert.rejects(local.runtime.configure(id, { instructions: "changed" }), { code: "busy" });
      let stopping: Promise<void> | undefined;
      if (stop) {
        stopping = local.runtime.stop(id); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(cancelled, true);
      } else await chat.commit(async (tx) => { (await tx.doc(ChatDoc, chat.id)).machineId = "drift"; }, context);
      assert.equal(await local.runtime.terminalBinding(id), undefined); drain.release(); await stopping;
      assert.equal((await result(local.runtime, task)).status, stop ? "aborted" : "uncertain");
      assert.equal(await local.runtime.terminalBinding(id), undefined);
      await assert.rejects(local.runtime.allocateTerminal(id, "new", target), { code: "conflict" });
      assert.equal(await local.runtime.allocateTerminal(id, "open", target), task);
    } finally { drain.release(); await local.close(); }
  }
});
