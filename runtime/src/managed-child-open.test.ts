import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type TaskId } from "@earendil-works/pi-durable";
import { ChatDoc } from "./chat-doc.js";
import { RexDoc, type RexPlan } from "./rex-allocation.js";
import { ManagedChildOpenRequest } from "./managed-child.js";
import { setup } from "./managed-child.test.support.js";
import { namedChildren } from "./subagent-view.test.support.js";
import { gate, within } from "./instructions.test.support.js";
import { dispatch } from "./ipc.js";
import { responseResult } from "./responses.js";
import type { RexInspectionObservation } from "./generated/contracts.js";

const machine = "b".repeat(32), target = { executable: "/saved/rex", server: "unix:///tmp/parent-rex.sock", hostId: randomUUID(), instanceId: randomUUID() };
async function fixture(remote = false) {
  const root = await mkdtemp(join(tmpdir(), "managed-open-"));
  const binding = { machineId: machine, cwd: "/exact saved 日本語 workspace" };
  let client = { executable: "/current/deck", socket: "/private/worker.sock" }, failed = false, wait: Promise<void> | undefined;
  const states = new Map<string, RexInspectionObservation["state"]>(), plans: RexPlan[] = [], reads: string[] = [];
  const f = setup({ binding: remote ? { machineId: "a".repeat(32), cwd: "/hub" } : binding, rexClient: "/local/deck", hostFiles: {
    rexClientFor: id => remote && id === machine ? client : undefined,
    call: async (saved, _id, operation, args) => {
      assert.deepEqual(saved, binding);
      if (operation === "rex_inspect") {
        const query = JSON.parse(args.plan!); reads.push(query.scope.blockId);
        const state = states.get(query.scope.blockId) ?? "running";
        return { ok: true, code: "rex_inspected", output: JSON.stringify({ version: 1, scope: query.scope, state, exitCode: state === "exited" ? 0 : null, revision: 1 }) };
      }
      assert.equal(operation, "rex_allocate"); const plan = JSON.parse(args.plan!) as RexPlan; plans.push(plan); await wait;
      if (failed) return { ok: false, code: "effect_uncertain", output: "" };
      return { ok: true, code: "allocated", output: JSON.stringify({ version: 1, ...plan, sessionId: plan.sessionId ?? `session:${randomUUID()}`, windowId: `window:${randomUUID()}`, blockId: `block:${randomUUID()}`, readiness: "not_checked" }) };
    },
  } });
  const path = join(root, "pi.sqlite"); let runtime = await f.open(path);
  const parent = await runtime.createTask("Parent", binding), parentId = String(parent.id);
  const initial = await runtime.openTerminal({ chatId: parentId, requestId: randomUUID(), port: 52800, target });
  await runtime.harness.waitForTask(Number(initial.taskId) as TaskId, context);
  const child = await runtime.createManagedChild(parentId, "Child", randomUUID()), childId = String(child.id);
  const args = { chatId: parentId, childId, requestId: randomUUID(), port: 52800 };
  return { get runtime() { return runtime; }, parent, parentId, child, childId, args, plans, reads, states, faux: f.faux,
    setClient: (next: typeof client) => { client = next; }, fail: (next: boolean) => { failed = next; }, hold: (next?: Promise<void>) => { wait = next; },
    settle: (id: string) => runtime.harness.waitForTask(Number(id) as TaskId, context),
    reopen: async () => { await runtime.close(); runtime = await f.open(path); },
    close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); },
  };
}

for (const remote of [false, true]) test(`managed child open uses parent's exact session/cwd with its OWN allocation and ${remote ? "current worker" : "local"} client, never parent input or mutation`, async () => {
  const f = await fixture(remote);
  try {
    const before = await f.runtime.harness.snapshot(RexDoc, f.parent.id, context);
    const parentMeta = await f.runtime.harness.snapshot(ChatDoc, f.parent.id, context), parentAgent = await f.runtime.harness.snapshot(AgentDoc, f.parent.id, context);
    f.setClient({ executable: "/upgraded/deck", socket: "/private/new-worker.sock" });
    const request = { version: 1, id: randomUUID(), command: "open_managed_child", args: f.args, hubId: f.runtime.hubId };
    const opened = await dispatch(f.runtime, request, undefined, true, f.parentId) as Awaited<ReturnType<typeof f.runtime.openManagedChild>>;
    responseResult({ version: 1, id: request.id, ok: true, result: opened }, request.id, request);
    assert.equal(opened.parentChatId, f.parentId); assert.equal(opened.childId, f.childId); assert.equal(opened.ack.chatId, f.childId);
    await f.settle(opened.ack.taskId);
    const plan = f.plans[1]!; assert.equal(f.plans.length, 2);
    assert.equal(plan.sessionId, before!.binding!.sessionId); assert.equal(plan.chatId, f.childId); assert.notEqual(plan.allocationId, before!.allocationId);
    for (const key of ["executable", "server", "hostId", "instanceId"] as const) assert.equal(plan[key], target[key]);
    assert.equal(plan.client, remote ? "/upgraded/deck" : "/local/deck"); assert.equal(plan.workerSocket, remote ? "/private/new-worker.sock" : undefined); assert.equal(plan.bootstrap, undefined);
    assert.equal((await f.runtime.terminalBinding(f.childId))!.cwd, parentMeta!.cwd);
    assert.deepEqual(await f.runtime.harness.snapshot(RexDoc, f.parent.id, context), before);
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, f.parent.id, context), parentMeta);
    assert.deepEqual(await f.runtime.harness.snapshot(AgentDoc, f.parent.id, context), parentAgent);
    assert.deepEqual((await f.runtime.history(f.childId)).items, []); assert.deepEqual((await f.runtime.history(f.parentId)).items, []); assert.equal(f.faux.state.callCount, 0);
    // A managed child can itself parent/open a nested child in the same session.
    const nested = await f.runtime.createManagedChild(f.childId, "Nested", randomUUID());
    const next = await f.runtime.openManagedChild({ ...f.args, chatId: f.childId, childId: String(nested.id), requestId: randomUUID() }); await f.settle(next.ack.taskId);
    assert.equal(f.plans[2]!.sessionId, plan.sessionId); assert.notEqual(f.plans[2]!.allocationId, plan.allocationId);
  } finally { await f.close(); }
});

test("lost/replayed managed open ACK deduplicates across restart and cannot retarget parent, child, session or port", async () => {
  const f = await fixture();
  try {
    const first = await f.runtime.openManagedChild(f.args); await f.settle(first.ack.taskId);
    const reads = f.reads.length;
    assert.deepEqual(await f.runtime.openManagedChild(f.args), first); assert.equal(f.reads.length, reads);
    await f.reopen(); assert.deepEqual(await f.runtime.openManagedChild(f.args), first); assert.equal(f.plans.length, 2);
    await assert.rejects(f.runtime.openManagedChild({ ...f.args, port: 52801 }), { code: "conflict" });
    const sibling = await f.runtime.createManagedChild(f.parentId, "Sibling", randomUUID());
    await assert.rejects(f.runtime.openManagedChild({ ...f.args, childId: String(sibling.id) }), { code: "conflict" });
    const parent = await f.runtime.chat(f.parentId);
    const saved = (await f.runtime.harness.snapshot(RexDoc, parent.id, context))!;
    await parent.commit(async tx => { (await tx.doc(RexDoc, parent.id)).binding!.sessionId = `session:${randomUUID()}`; }, context);
    await assert.rejects(f.runtime.openManagedChild(f.args), { code: "conflict" });
    await parent.commit(async tx => { Object.assign(await tx.doc(RexDoc, parent.id), saved); }, context);
    const other = await f.runtime.createTask("Other", { machineId: machine, cwd: "/exact saved 日本語 workspace" });
    const open = await f.runtime.openTerminal({ chatId: String(other.id), requestId: randomUUID(), port: 52800, target }); await f.settle(open.taskId);
    const otherChild = await f.runtime.createManagedChild(String(other.id), "Other child", randomUUID());
    await assert.rejects(f.runtime.openManagedChild({ ...f.args, chatId: String(other.id), childId: String(otherChild.id) }), /already names another/);
    assert.equal(f.plans.length, 3);
  } finally { await f.close(); }
});

test("same-session managed open conservatively handles running, exited, pending and lost native allocation ACKs", async () => {
  const f = await fixture(), release = gate();
  try {
    f.hold(release.promise);
    const first = await f.runtime.openManagedChild(f.args);
    assert.deepEqual(await f.runtime.openManagedChild(f.args), first);
    await assert.rejects(f.runtime.openManagedChild({ ...f.args, requestId: randomUUID() }), { code: "busy" });
    release.release(); f.hold(); await f.settle(first.ack.taskId);
    const reusedArgs = { ...f.args, requestId: randomUUID() }, reused = await f.runtime.openManagedChild(reusedArgs);
    assert.equal(reused.ack.status, "reused"); assert.equal(reused.ack.taskId, first.ack.taskId); assert.equal(f.plans.length, 2);
    const childBinding = (await f.runtime.terminalBinding(f.childId))!; f.states.set(childBinding.blockId, "exited");
    // Replaying even a "reused" receipt must not create a new terminal later.
    assert.deepEqual(await f.runtime.openManagedChild(reusedArgs), reused); assert.equal(f.plans.length, 2);
    f.fail(true);
    const lostArgs = { ...f.args, requestId: randomUUID() }, lost = await f.runtime.openManagedChild(lostArgs); await f.settle(lost.ack.taskId);
    assert.equal((await f.runtime.terminalStatus(f.childId)).status, "uncertain");
    assert.deepEqual(await f.runtime.openManagedChild(lostArgs), lost);
    await assert.rejects(f.runtime.openManagedChild({ ...f.args, requestId: randomUUID() }), /unconfirmed/);
    assert.equal(f.plans.length, 3); assert.ok(f.plans.slice(1).every(p => p.sessionId === (f.plans[1]!).sessionId));
  } finally { release.release(); await f.close(); }
});

test("unbound --here parents, unavailable sessions, foreign/forged/captured children and mismatched cwd cannot open elsewhere", async () => {
  const f = await fixture();
  try {
    const parentBinding = (await f.runtime.terminalBinding(f.parentId))!;
    for (const state of ["pending", "unavailable", "identity_changed", "inconclusive", "missing_session"] as const) {
      f.states.set(parentBinding.blockId, state);
      await assert.rejects(f.runtime.openManagedChild(f.args), /unavailable or unconfirmed/);
      assert.equal(await f.runtime.harness.snapshot(ManagedChildOpenRequest, f.args.requestId, context), undefined);
    }
    f.states.clear();
    const unbound = await f.runtime.createTask("Here", { machineId: machine, cwd: "/exact saved 日本語 workspace" }), unboundId = String(unbound.id);
    const child = await f.runtime.createManagedChild(unboundId, "Here child", randomUUID());
    await assert.rejects(f.runtime.openManagedChild({ ...f.args, chatId: unboundId, childId: String(child.id) }), /--here without Rex/);
    await assert.rejects(f.runtime.openManagedChild({ ...f.args, childId: String(child.id) }), /direct managed child/);
    const captured = (await namedChildren(f.runtime, f.parentId))[0]!, owned = await f.runtime.chat(captured.chatId);
    await owned.commit(async tx => { Object.assign(await tx.doc(ChatDoc, owned.id), { kind: "task", managedParentChatId: f.parentId }); }, context);
    await assert.rejects(f.runtime.openManagedChild({ ...f.args, childId: captured.chatId }), /direct managed child/);
    await f.child.commit(async tx => { (await tx.doc(ChatDoc, f.child.id)).cwd = "/elsewhere"; (await tx.doc(AgentDoc, f.child.id)).cwd = "/elsewhere"; }, context);
    await assert.rejects(f.runtime.openManagedChild(f.args), /matching saved host\/cwd/);
    assert.equal(f.plans.length, 1);
  } finally { await f.close(); }
});

test("managed opening rechecks the outer parent guard after native inspection and before serialized allocation", async () => {
  const f = await fixture(), entered = gate(), release = gate(); let revoked = false;
  try {
    const inspect = f.runtime.inspectTerminal.bind(f.runtime);
    f.runtime.inspectTerminal = async (...args) => { const sample = await inspect(...args); entered.release(); await release.promise; return sample; };
    const opening = f.runtime.guardedCommand(async () => { if (revoked) throw new Error("revoked parent"); }, () => f.runtime.openManagedChild(f.args));
    const rejected = assert.rejects(opening, /revoked parent/);
    await within(entered.promise); revoked = true; release.release(); await rejected;
    assert.equal(f.plans.length, 1); assert.equal((await f.runtime.terminalStatus(f.childId)).status, "unallocated");
    assert.equal(await f.runtime.harness.snapshot(ManagedChildOpenRequest, f.args.requestId, context), undefined);
  } finally { release.release(); await f.close(); }
});

test("managed allocation rechecks parent session and direct relation after an inspection sample", async () => {
  for (const change of ["session", "relation"] as const) {
    const f = await fixture(), entered = gate(), release = gate();
    try {
      const inspect = f.runtime.inspectTerminal.bind(f.runtime);
      f.runtime.inspectTerminal = async (...args) => { const sample = await inspect(...args); entered.release(); await release.promise; return sample; };
      const opening = f.runtime.openManagedChild(f.args), rejected = assert.rejects(opening);
      await within(entered.promise);
      if (change === "session") await f.parent.commit(async tx => { (await tx.doc(RexDoc, f.parent.id)).binding!.sessionId = `session:${randomUUID()}`; }, context);
      else await f.child.commit(async tx => { (await tx.doc(ChatDoc, f.child.id)).managedParentChatId = String(f.runtime.main.id); }, context);
      release.release(); await rejected; assert.equal(f.plans.length, 1);
    } finally { release.release(); await f.close(); }
  }
});

test("plausible forged parent Rex binding and a child's preexisting different session never authorize same-session allocation", async () => {
  const f = await fixture();
  try {
    const saved = (await f.runtime.harness.snapshot(RexDoc, f.parent.id, context))!;
    await f.parent.commit(async tx => { (await tx.doc(RexDoc, f.parent.id)).binding!.blockId = `block:${randomUUID()}`; }, context);
    await assert.rejects(f.runtime.openManagedChild(f.args), /unavailable or unconfirmed/);
    assert.equal(f.reads.length, 0, "native reads require retained allocation provenance first");
    await f.parent.commit(async tx => { Object.assign(await tx.doc(RexDoc, f.parent.id), saved); }, context);
    for (const override of [{ target }, { sessionId: saved.binding!.sessionId }, { client: "/override/deck" }, { workerSocket: "/override.sock" }]) await assert.rejects(f.runtime.openManagedChild({ ...f.args, ...override }), /Invalid managed child open/);
    const foreign = await f.runtime.openTerminal({ chatId: f.childId, requestId: randomUUID(), port: 52800, target }); await f.settle(foreign.taskId);
    assert.notEqual((await f.runtime.terminalBinding(f.childId))!.sessionId, saved.binding!.sessionId);
    await assert.rejects(f.runtime.openManagedChild(f.args), /does not belong to the parent's saved session/);
    assert.equal(f.plans.length, 2); assert.equal(await f.runtime.harness.snapshot(ManagedChildOpenRequest, f.args.requestId, context), undefined);
  } finally { await f.close(); }
});
