import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type Conversation, type Storage, type Tx } from "@earendil-works/pi-durable";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { REX_KIND, RexDoc, RexHereBlock, RexRequest, rexHereBlockConflict, type RexPlan, type RexTarget } from "./rex-allocation.js";
import { RECONCILE_KIND, rexRequestHash } from "./rex-reconciliation.js";
import { rexSocketPath } from "./rex-endpoint.js";
import { IMPLEMENTATION, gate, model, provider, within } from "./instructions.test.support.js";

const uuid = "12345678-1234-1234-1234-123456789abc";
const blockId = `block:${uuid}`;
const binding = { machineId: "a".repeat(32), cwd: "/saved/workspace" };
const target: RexTarget = { executable: "/mock/rex", client: "/mock/deck", server: "unix:///tmp/mock-rex.sock", hostId: uuid, instanceId: uuid, port: 52800 };
const here = (patch: Partial<RexTarget> = {}): RexTarget => ({ ...target, bootstrap: { id: randomUUID(), root: "/another/deck-root", blockId, kind: "here" }, ...patch });
const blockKey = (machineId: string, saved: RexTarget) => createHash("sha256").update(JSON.stringify([machineId, rexSocketPath(saved.server), saved.hostId, saved.instanceId, saved.bootstrap!.blockId])).digest("hex");
async function fixture() {
  const root = await mkdtemp("/tmp/deck-here-conflict-");
  const { models } = provider();
  const calls: string[] = [], plans = new Map<string, RexPlan>();
  let uncertain = false, nextBlock = blockId, hold: (() => Promise<void>) | undefined;
  const creation = (plan: RexPlan) => ({ version: 1, allocationId: plan.allocationId, server: plan.server, hostId: plan.hostId, instanceId: plan.instanceId, chatId: plan.chatId, hubId: plan.hubId, sessionId: plan.sessionId ?? `session:${uuid}`, windowId: `window:${uuid}`, blockId: plan.bootstrap?.blockId ?? nextBlock, readiness: "not_checked" });
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, binding, implementation: IMPLEMENTATION, environment: () => undefined, hostFiles: { call: async (_saved, id, operation, args) => {
    calls.push(operation);
    if (operation === "rex_allocate") {
      const plan = JSON.parse(args.plan!) as RexPlan; plans.set(id, plan);
      if (hold) await hold();
      return uncertain ? { ok: false, code: "effect_uncertain", output: "" } : { ok: true, code: "allocated", output: JSON.stringify(creation(plan)) };
    }
    assert.equal(operation, "rex_allocation_receipt", "mock native effects only; never send chat input or invoke Rex");
    const query = JSON.parse(args.plan!);
    return { ok: true, code: "rex_receipt", output: JSON.stringify({ version: 1, operationId: query.operationId, requestHash: rexRequestHash(query.request), state: "allocated", creation: creation(plans.get(query.operationId)!) }) };
  } } });
  const original = await runtime.createTask("Existing ordinary allocation", binding);
  const selected = await runtime.createTask("Nested HERE task", binding);
  const unrelated = await runtime.createTask("No Rex allocation", binding);
  const allocate = async (saved = target, chat = original, replacement?: { priorTaskId: number }) => {
    const id = await runtime.allocateTerminal(String(chat.id), randomUUID(), saved, undefined, undefined, replacement);
    await runtime.harness.waitForTask(id, context); return id;
  };
  const capture = async () => JSON.stringify({
    tasks: await runtime.harness.commit(tx => tx.scanTasks({ kind: REX_KIND }, 100), context),
    chats: await Promise.all([original, selected, unrelated].map(async chat => ({
      chat: await runtime.harness.snapshot(ChatDoc, chat.id, context), agent: await runtime.harness.snapshot(AgentDoc, chat.id, context), rex: await runtime.harness.snapshot(RexDoc, chat.id, context), history: await runtime.history(String(chat.id)),
    }))),
  });
  const refuse = async (saved = here()) => {
    const requestId = randomUUID(), before = await capture(), count = calls.length;
    await assert.rejects(runtime.allocateTerminal(String(selected.id), requestId, saved), { code: "conflict" });
    assert.equal(await capture(), before, "original metadata and outcomes remain byte-for-byte unchanged; no task or chat input added");
    assert.equal(calls.length, count);
    assert.equal(await runtime.harness.snapshot(RexDoc, selected.id, context), undefined);
    assert.equal(await runtime.harness.snapshot(RexRequest, selected.id, requestId, context), undefined);
    assert.equal(await runtime.harness.snapshot(RexHereBlock, blockKey(binding.machineId, saved), context), undefined, "failed admission rolls back the staged global reservation");
    assert.equal(await runtime.harness.snapshot(RexDoc, unrelated.id, context), undefined);
  };
  return { runtime, original, selected, unrelated, allocate, capture, refuse, calls,
    uncertain: (value: boolean) => { uncertain = value; }, block: (value: string) => { nextBlock = value; }, hold: (value: () => Promise<void>) => { hold = value; },
    close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("HERE refuses confirmed ordinary allocations without a HERE index, including equivalent endpoint spellings", async () => {
  const f = await fixture();
  try {
    await f.allocate();
    const saved = here({ server: "unix:///tmp/mock%2Drex.sock" });
    assert.equal(await f.runtime.harness.snapshot(RexHereBlock, blockKey(binding.machineId, saved), context), undefined);
    // Current cwd is not physical block identity; use the retained allocation scope.
    await f.original.commit(async tx => { (await tx.doc(ChatDoc, f.original.id)).cwd = "/later/workspace"; }, context);
    await f.refuse(saved);
  } finally { await f.close(); }
});

for (const state of ["pending", "uncertain"] as const) test(`HERE refuses a legacy wizard ${state} bootstrap block before a binding exists`, async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try {
    f.uncertain(true);
    if (state === "pending") f.hold(async () => { entered.release(); await release.promise; });
    const id = await f.runtime.allocateTerminal(String(f.original.id), "legacy-wizard", { ...target, bootstrap: { id: randomUUID(), root: "/old/deck-root", blockId } });
    if (state === "pending") await within(entered.promise); else await f.runtime.harness.waitForTask(id, context);
    assert.equal((await f.runtime.harness.snapshot(RexDoc, f.original.id, context))?.binding, undefined);
    await f.refuse();
    release.release(); await f.runtime.harness.waitForTask(id, context);
  } finally { release.release(); await f.close(); }
});

test("HERE retains ordinary historical block conflicts after replacement", async () => {
  const f = await fixture();
  try {
    let id = await f.allocate();
    for (let i = 0; i < 2; i++) {
      f.block(`block:${randomUUID()}`);
      id = await f.allocate(target, f.original, { priorTaskId: id });
    }
    const doc = await f.runtime.harness.snapshot(RexDoc, f.original.id, context);
    assert.notEqual(doc?.binding?.blockId, blockId); assert.notEqual(doc?.previousBinding?.blockId, blockId);
    await f.refuse(); // The immutable allocated result is still a permanent fence.
  } finally { await f.close(); }
});

test("HERE refuses reconciled allocations, previous bindings and older reconciliation proof", async () => {
  const f = await fixture();
  try {
    f.uncertain(true); let id = await f.allocate();
    const proof = await f.runtime.reconcileTerminal(String(f.original.id), "retained-native-proof");
    const settled = await f.runtime.harness.waitForTask(proof, context);
    assert.equal(settled.state.outcome.status, "completed");
    assert.equal(settled.state.outcome.result.status, "reconciled");
    await f.refuse();
    f.uncertain(false);
    for (let i = 0; i < 2; i++) {
      f.block(`block:${randomUUID()}`);
      id = await f.allocate(target, f.original, { priorTaskId: id });
      await f.refuse();
    }
    const doc = await f.runtime.harness.snapshot(RexDoc, f.original.id, context);
    assert.notEqual(doc?.binding?.blockId, blockId); assert.notEqual(doc?.previousBinding?.blockId, blockId);
    assert.deepEqual(await f.runtime.harness.getTask(proof, context), settled);
  } finally { await f.close(); }
});

for (const scope of ["block", "machine", "server", "host", "instance"] as const) test(`HERE allows a different ${scope}, not merely a different session or cwd`, async () => {
  const f = await fixture();
  try {
    await f.allocate();
    let chat: Conversation = f.selected;
    let saved = here();
    if (scope === "block") saved = { ...saved, bootstrap: { ...saved.bootstrap!, blockId: `block:${randomUUID()}` } };
    if (scope === "machine") chat = await f.runtime.createTask("Other machine", { ...binding, machineId: "b".repeat(32) });
    if (scope === "server") saved = { ...saved, server: "unix:///tmp/other-rex.sock" };
    if (scope === "host") saved = { ...saved, hostId: randomUUID() };
    if (scope === "instance") saved = { ...saved, instanceId: randomUUID() };
    const before = JSON.stringify(await f.runtime.harness.snapshot(RexDoc, f.original.id, context));
    await f.allocate(saved, chat);
    const old = await f.runtime.harness.snapshot(RexDoc, f.original.id, context), adopted = await f.runtime.harness.snapshot(RexDoc, chat.id, context);
    assert.ok(adopted?.binding); assert.equal(adopted.binding.sessionId, old?.binding?.sessionId, "a shared session is not a block conflict");
    assert.equal(JSON.stringify(old), before); assert.deepEqual((await f.runtime.history(String(chat.id))).items, []);
    for (const untouched of [f.unrelated, f.runtime.main]) assert.equal(await f.runtime.harness.snapshot(RexDoc, untouched.id, context), undefined);
  } finally { await f.close(); }
});

test("HERE task-only history scan never creates empty RexDocs, even for legacy task records missing their doc", async () => {
  const f = await fixture();
  try {
    await f.allocate();
    await f.original.commit(tx => tx.retireDoc(RexDoc, f.original.id), context);
    await f.refuse(); // Historical task proof works without its old current doc.
    await f.allocate(here({ bootstrap: { ...here().bootstrap!, blockId: `block:${randomUUID()}` } }), f.selected);
    for (const chat of [f.original, f.unrelated, f.runtime.main]) assert.equal(await f.runtime.harness.snapshot(RexDoc, chat.id, context), undefined);
  } finally { await f.close(); }
});

test("HERE bounded admission scan rolls back every staged fence; exact receipt replay bypasses the scan", async () => {
  const f = await fixture();
  // Inject only the storage read boundary. The actual Pi admission/rollback and
  // task registration remain real; no thousands of synthetic scheduled effects.
  const storage = (f.runtime as unknown as { storage: Storage }).storage;
  const scan = storage.scanTasks.bind(storage);
  let scans = 0;
  try {
    const saved = here(), request = randomUUID();
    const id = await f.runtime.allocateTerminal(String(f.selected.id), request, saved);
    await f.runtime.harness.waitForTask(id, context);
    storage.scanTasks = async (query, limit, cursor, ctx) => {
      if (query.kind !== REX_KIND) return scan(query, limit, cursor, ctx);
      assert.equal(limit, 100); scans++;
      // Empty pages with a cursor must not be treated as an exhausted scan.
      return { items: [], next: { page: scans } };
    };
    assert.equal(await f.runtime.allocateTerminal(String(f.selected.id), request, saved), id); assert.equal(scans, 0);
    const rejected = here({ bootstrap: { ...here().bootstrap!, blockId: `block:${randomUUID()}` } });
    const attempt = randomUUID();
    await assert.rejects(f.runtime.allocateTerminal(String(f.original.id), attempt, rejected), { code: "conflict", message: "Rex allocation history exceeds the safe adoption scan limit" });
    assert.equal(scans, 100); assert.equal(f.calls.length, 1);
    assert.equal(await f.runtime.harness.snapshot(RexDoc, f.original.id, context), undefined);
    assert.equal(await f.runtime.harness.snapshot(RexRequest, f.original.id, attempt, context), undefined);
    assert.equal(await f.runtime.harness.snapshot(RexHereBlock, blockKey(binding.machineId, rejected), context), undefined);
    storage.scanTasks = scan;
    assert.equal((await f.runtime.harness.commit(tx => tx.scanTasks({ kind: REX_KIND }, 100), context)).items.length, 1);
    // The same request can succeed when the scan completes: no poisoned receipt.
    const fresh = await f.runtime.allocateTerminal(String(f.original.id), attempt, rejected);
    await f.runtime.harness.waitForTask(fresh, context);
    assert.deepEqual((await f.runtime.history(String(f.original.id))).items, []);
  } finally { storage.scanTasks = scan; await f.close(); }
});

test("HERE canonical scan follows both kind cursors without opening any documents", async () => {
  const f = await fixture();
  try {
    await f.allocate();
    const record = (await f.runtime.harness.commit(tx => tx.scanTasks({ kind: REX_KIND }, 100), context)).items[0]!;
    const queries: string[] = [];
    const tx = { scanTasks: async (query, limit, cursor) => {
      assert.equal(limit, 100); queries.push(query.kind!);
      if (!cursor) return { items: [], next: { page: 1 } };
      return { items: query.kind === REX_KIND ? [record] : [] };
    }, doc: () => { throw Error("scan must not acquire/create documents"); } } satisfies Pick<Tx, "scanTasks" | "doc">;
    assert.equal(await rexHereBlockConflict(tx, binding.machineId, target, blockId), "allocated");
    assert.deepEqual(queries, [REX_KIND, REX_KIND]); queries.length = 0;
    assert.equal(await rexHereBlockConflict(tx, binding.machineId, target, `block:${randomUUID()}`), undefined);
    assert.deepEqual(queries, [REX_KIND, REX_KIND, RECONCILE_KIND, RECONCILE_KIND]);
    assert.equal(record.state.status, "terminal");
    if (record.state.status !== "terminal") throw Error("Expected settled allocation");
    const { memos: _memos, ...retained } = record;
    const completing = { ...retained, state: { ...record.state, status: "completing" as const } };
    assert.equal(await rexHereBlockConflict({ scanTasks: async () => ({ items: [completing] }) }, binding.machineId, target, blockId), "allocated", "completed proof also fences while Pi drains owned work");
  } finally { await f.close(); }
});

test("HERE reconciliation scan shares the bounded budget and fails closed on an unfinished cursor", async () => {
  let scans = 0;
  const tx: Pick<Tx, "scanTasks"> = { scanTasks: async (query, limit) => {
    scans++; assert.equal(limit, 100);
    return query.kind === REX_KIND ? { items: [] } : { items: [], next: { page: scans } };
  } };
  assert.equal(await rexHereBlockConflict(tx, binding.machineId, target, blockId), "limit");
  assert.equal(scans, 100);
});
