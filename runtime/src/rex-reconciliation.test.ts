import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import { DeckRuntime } from "./deck.js";
import { RexDoc, type RexPlan, type RexTarget } from "./rex-allocation.js";
import { rexRequestHash } from "./rex-reconciliation.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";
import { REX_UUID as uuid } from "./rex-allocation.test.support.js";
const binding = { machineId: "saved-worker", cwd: "/saved" };
const target: RexTarget = { executable: "/rex", client: "/deck", server: "unix:///tmp/rex.sock", hostId: uuid, instanceId: uuid, port: 52800 };
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function setup(abortOriginal = false) {
  const originalEntered = deferred(), originalRelease = deferred();
  const root = await mkdtemp(join(tmpdir(), "deck-reconcile-")); const { models } = provider();
  let mode = "allocated"; let original = ""; let plan!: RexPlan; const calls: string[] = []; let gate: (() => Promise<void>) | undefined;
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, binding, implementation: IMPLEMENTATION, environment: () => undefined, hostFiles: { call: async (saved, id, operation, args) => {
    assert.deepEqual(saved, binding); calls.push(operation);
    if (operation === "rex_allocate") { original = JSON.stringify({ version: 1, id, ...saved, operation, args }); plan = JSON.parse(String(args.plan)); if (abortOriginal) { originalEntered.release(); await originalRelease.promise; } return { ok: false, code: "effect_uncertain", output: "PRIVATE_LOST_REPLY" }; }
    if (operation === "rex_inspect") { const query = JSON.parse(String(args.plan)); return { ok: true, code: "rex_inspected", output: JSON.stringify({ version: 1, scope: query.scope, state: "running", exitCode: null, revision: 1 }) }; }
    assert.equal(operation, "rex_allocation_receipt"); const query = JSON.parse(String(args.plan)); assert.equal(query.request, original); assert.notEqual(query.operationId, id);
    if (gate) await gate();
    if (mode === "throw") throw new Error("PRIVATE_LOOKUP");
    if (mode === "offline") return { ok: false, code: "offline", output: "PRIVATE_WORKER" };
    const creation = { version: 1, server: plan.server, hostId: plan.hostId, instanceId: plan.instanceId, chatId: plan.chatId, hubId: plan.hubId, allocationId: plan.allocationId, sessionId: `session:${uuid}`, windowId: `window:${uuid}`, blockId: `block:${uuid}`, readiness: "not_checked" };
    return { ok: true, code: "rex_receipt", output: mode === "malformed" ? "PRIVATE_BAD_JSON" : JSON.stringify({ version: 1, operationId: query.operationId, requestHash: mode === "hash" ? "0".repeat(64) : rexRequestHash(original), state: ["missing", "accepted", "not_allocated", "conflict", "inconclusive"].includes(mode) ? mode : "allocated", creation: ["missing", "accepted", "not_allocated", "conflict", "inconclusive"].includes(mode) ? null : { ...creation, ...(mode === "scope" ? { instanceId: "00000000-0000-0000-0000-000000000000" } : {}) }, ...(mode === "private" ? { stderr: "PRIVATE_ERROR" } : {}) }) };
  } } });
  const chat = await runtime.createTask("Unknown allocation", binding, "chat"); const id = String(chat.id);
  const allocation = await runtime.allocateTerminal(id, "allocation", target);
  if (abortOriginal) { await originalEntered.promise; const stopping = runtime.stop(id); await new Promise((resolve) => setTimeout(resolve, 20)); originalRelease.release(); await stopping; }
  const originalTask = await runtime.harness.waitForTask(allocation, context);
  assert.deepEqual(originalTask.state.outcome, { status: "completed", result: { status: abortOriginal ? "aborted" : "uncertain" } });
  return { runtime, chat, id, allocation, originalTask, calls, plan: () => plan, mode: (value: string) => { mode = value; }, gate: (value: () => Promise<void>) => { gate = value; }, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

test("explicit reconciliation saves stable Pi intent, repairs only retained creation proof and preserves history/outcomes", async () => {
  const local = await setup();
  try {
    assert.equal((await local.runtime.inspectTerminal(local.id)).status, "unbound");
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(local.runtime.reconcileTerminal(local.id, "not-admitted", cancelled.signal), { name: "AbortError" });
    assert.deepEqual(local.calls, ["rex_allocate"]);
    const startup = await local.runtime.registerTerminalStartup(local.id, local.plan().allocationId!, `block:${uuid}`); assert.equal(startup.observation, "unbound");
    const taskId = await local.runtime.reconcileTerminal(local.id, "recover", undefined, binding);
    const task = await local.runtime.harness.waitForTask(taskId, context);
    assert.equal(task.state.outcome.status, "completed"); const result = task.state.outcome.result;
    assert.equal(result.status, "reconciled"); if (result.status !== "reconciled") throw Error("No binding");
    assert.equal(result.binding.taskId, String(local.allocation)); assert.equal(result.evidence.operationId, String(local.allocation)); assert.equal(result.binding.readiness, "not_checked");
    assert.deepEqual(await local.runtime.terminalBinding(local.id), result.binding);
    assert.deepEqual((await local.runtime.harness.getTask(local.allocation, context))?.state, local.originalTask.state);
    assert.equal((await local.runtime.terminalStartup(local.id)).observation, "matched");
    assert.equal((await local.runtime.inspectTerminal(local.id)).observation?.state, "running");
    assert.deepEqual((await local.runtime.history(local.id)).items, []); assert.equal((await local.runtime.harness.inspect(context)).tasks.length, 0);
    assert.deepEqual(local.calls, ["rex_allocate", "rex_allocation_receipt", "rex_inspect"]);
    assert.equal(await local.runtime.reconcileTerminal(local.id, "recover"), taskId);
    await assert.rejects(local.runtime.reconcileTerminal(local.id, "recover", undefined, { ...binding, cwd: "/other" }), { code: "conflict" });
    await assert.rejects(local.runtime.reconcileTerminal(local.id, "new"), { code: "conflict" });
    await assert.rejects(local.runtime.allocateTerminal(local.id, "new", target), { code: "conflict" });
    await local.chat.commit(async (tx) => { (await tx.doc(AgentDoc, local.chat.id)).cwd = "/drift"; }, context);
    assert.equal(await local.runtime.reconcileTerminal(local.id, "recover"), taskId); // Receipt before later coherence/capability checks.
    assert.equal(local.calls.length, 3);
  } finally { await local.close(); }
});

test("reconciling retained creation after original stop never revives that task or overwrites its aborted outcome", async () => {
  const local = await setup(true);
  try {
    const task = await local.runtime.reconcileTerminal(local.id, "after-stop"); const settled = await local.runtime.harness.waitForTask(task, context);
    assert.equal(settled.state.outcome.status, "completed"); assert.equal(settled.state.outcome.result.status, "reconciled");
    assert.deepEqual((await local.runtime.harness.getTask(local.allocation, context))?.state, local.originalTask.state);
    assert.equal((await local.runtime.inspectTerminal(local.id)).observation?.state, "running"); assert.deepEqual((await local.runtime.history(local.id)).items, []);
    assert.equal((await local.runtime.harness.inspect(context)).tasks.length, 0); assert.equal(local.calls.filter((name) => name === "rex_allocate").length, 1);
  } finally { await local.close(); }
});

test("missing/accepted/conflicting/malformed evidence stays unresolved; startup claims cannot authorize adoption or replay", async () => {
  const local = await setup();
  try {
    await local.runtime.registerTerminalStartup(local.id, local.plan().allocationId!, `block:${uuid}`);
    for (const mode of ["missing", "accepted", "not_allocated", "conflict", "inconclusive", "malformed", "hash", "scope", "private", "throw", "offline"]) {
      local.mode(mode); const id = await local.runtime.reconcileTerminal(local.id, mode); const task = await local.runtime.harness.waitForTask(id, context);
      assert.equal(task.state.outcome.status, "completed"); const result = task.state.outcome.result;
      assert.equal(result.status, "unresolved"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
      if (result.status === "unresolved") assert.equal(result.reason, ["missing", "accepted", "not_allocated", "conflict", "inconclusive"].includes(mode) ? mode : mode === "scope" ? "conflict" : mode === "offline" ? "unavailable" : "inconclusive");
      assert.equal(await local.runtime.terminalBinding(local.id), undefined); assert.equal((await local.runtime.terminalStartup(local.id)).observation, "unbound");
      assert.equal((await local.runtime.inspectTerminal(local.id)).status, "unbound");
    }
    assert.equal(local.calls.filter((op) => op === "rex_allocate").length, 1);
    await assert.rejects(local.runtime.reconcileTerminal(String(local.runtime.main.id), "main"), { code: "invalid" });
    assert.deepEqual((await local.runtime.history(local.id)).items, []);
  } finally { await local.close(); }
});

test("reconciliation serializes competing intents, rechecks authority after I/O and drains stop without applying late evidence", async () => {
  const local = await setup(); const entered = deferred(), release = deferred(); local.gate(async () => { entered.release(); await release.promise; });
  try {
    const taskId = await local.runtime.reconcileTerminal(local.id, "pending"); await entered.promise;
    assert.equal(await local.runtime.reconcileTerminal(local.id, "pending"), taskId);
    await assert.rejects(local.runtime.reconcileTerminal(local.id, "competing"), { code: "busy" });
    await assert.rejects(local.runtime.configure(local.id, { instructions: "busy" }), { code: "busy" });
    await local.runtime.createTask("Unrelated", binding, "unrelated");
    await local.chat.commit(async (tx) => { (await tx.doc(AgentDoc, local.chat.id)).cwd = "/drift"; }, context);
    release.release(); const task = await local.runtime.harness.waitForTask(taskId, context);
    assert.deepEqual(task.state.outcome, { status: "completed", result: { status: "unresolved", reason: "authority_changed" } }); assert.equal(await local.runtime.terminalBinding(local.id), undefined);
    await local.chat.commit(async (tx) => { (await tx.doc(AgentDoc, local.chat.id)).cwd = binding.cwd; }, context);
    const secondEntered = deferred(), secondRelease = deferred(); local.gate(async () => { secondEntered.release(); await secondRelease.promise; });
    const second = await local.runtime.reconcileTerminal(local.id, "stop"); await secondEntered.promise;
    const stopping = local.runtime.stop(local.id); await new Promise((resolve) => setTimeout(resolve, 20)); secondRelease.release(); await stopping;
    assert.deepEqual((await local.runtime.harness.waitForTask(second, context)).state.outcome, { status: "completed", result: { status: "aborted" } }); assert.equal(await local.runtime.terminalBinding(local.id), undefined);
    assert.deepEqual((await local.runtime.harness.getTask(local.allocation, context))?.state, local.originalTask.state);
  } finally { release.release(); await local.close(); }
});

test("reconciliation preserves conflicting historical startup and inspection refuses a broken provenance link", async () => {
  const local = await setup();
  try {
    await local.runtime.registerTerminalStartup(local.id, local.plan().allocationId!, "block:00000000-0000-0000-0000-000000000000");
    const task = await local.runtime.reconcileTerminal(local.id, "repair"); await local.runtime.harness.waitForTask(task, context);
    assert.equal((await local.runtime.terminalStartup(local.id)).observation, "conflict");
    assert.equal((await local.runtime.inspectTerminal(local.id)).observation?.state, "running");
    await local.chat.commit(async (tx) => { (await tx.doc(RexDoc, local.chat.id)).reconciliationTaskId = Number(local.allocation); }, context);
    const calls = local.calls.length; assert.equal((await local.runtime.inspectTerminal(local.id)).status, "conflict"); assert.equal(local.calls.length, calls);
  } finally { await local.close(); }
});
