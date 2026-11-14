import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { DeckRuntime } from "./deck.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";
import { type RexPlan, type RexResult } from "./rex-allocation.js";
import { validAdoptArgs, validRexReply } from "./rex-open-contracts.js";
import { validClientRequest } from "./command-contracts.js";
const binding = { machineId: "a".repeat(32), cwd: "/saved" };
test("bootstrap allocation is a canonical Pi task: exact retries, conflict fences, startup before input, ordinary reopen drops adoption", async () => {
  const root = await mkdtemp("/tmp/deck-adopt-"); const { models } = provider();
  const target = { executable: "/tools/rex", server: "unix:///tmp/private.sock", hostId: randomUUID(), instanceId: randomUUID() };
  const bootstrap = { id: randomUUID(), root: "/private/client", blockId: `block:${randomUUID()}` };
  const sid = `session:${randomUUID()}`, wid = `window:${randomUUID()}`;
  let presence = "running", wrongBlock = false;
  const plans: RexPlan[] = [];
  const runtime = await DeckRuntime.open(`${root}/pi.sqlite`, { models, model, implementation: IMPLEMENTATION, binding, rexClient: "/tools/deck", environment: () => undefined, hostFiles: { call: async (actual, _id, operation, args) => {
    assert.deepEqual(actual, binding);
    if (operation === "rex_inspect") {
      const query = JSON.parse(String(args.plan));
      return { ok: true, code: "rex_inspected", output: JSON.stringify({ version: 1, scope: query.scope, state: presence, exitCode: presence === "exited" ? 0 : null, revision: 1 }) };
    }
    assert.equal(operation, "rex_allocate");
    const plan: RexPlan = JSON.parse(String(args.plan)); plans.push(plan);
    return { ok: true, code: "allocated", output: JSON.stringify({ version: 1, server: plan.server, hostId: plan.hostId, instanceId: plan.instanceId, sessionId: plan.sessionId ?? sid, windowId: wid, blockId: !wrongBlock && plan.bootstrap ? plan.bootstrap.blockId : `block:${randomUUID()}`, hubId: plan.hubId, chatId: plan.chatId, allocationId: plan.allocationId, readiness: "not_checked" }) };
  } } });
  const settled = async (id: string) => runtime.harness.waitForTask(Number(id) as TaskId<RexResult>, context);
  try {
    const chatId = String((await runtime.createTask("Exact", binding)).id);
    const args = { chatId, requestId: randomUUID(), port: 52800, target, bootstrap };
    assert.ok(validAdoptArgs(args));
    assert.equal(validClientRequest({ version: 1, id: "x", command: "rex_adopt", args }), false, "explicit hub identity is mandatory");
    for (const invalid of [{ ...args, bootstrap: { ...bootstrap, root: "relative" } }, { ...args, bootstrap: { ...bootstrap, blockId: "short" } }, { ...args, target: { ...target, server: "https://host" } }, { ...args, client: "/arbitrary" }]) assert.equal(validAdoptArgs(invalid), false);
    const ack = await runtime.adoptTerminal(args); await settled(ack.taskId);
    assert.ok(validRexReply({ command: "rex_adopt", args, hubId: runtime.hubId }, ack));
    assert.deepEqual(await runtime.adoptTerminal(args), ack); assert.equal(plans.length, 1);
    assert.equal(plans[0]!.clientState, bootstrap.root); assert.deepEqual(plans[0]!.bootstrap, bootstrap);
    assert.equal((await runtime.terminalStatus(chatId)).binding!.blockId, bootstrap.blockId);
    assert.deepEqual((await runtime.history(chatId)).items, [], "allocation is not problem admission");
    await runtime.registerTerminalStartup(chatId, ack.allocationId, bootstrap.blockId);
    for (const changed of [{ ...args, bootstrap: { ...bootstrap, root: "/other" } }, { ...args, bootstrap: { ...bootstrap, id: randomUUID() } }, { ...args, bootstrap: { ...bootstrap, blockId: `block:${randomUUID()}` } }]) await assert.rejects(runtime.adoptTerminal(changed), { code: "conflict" });
    await assert.rejects(runtime.adoptTerminal({ ...args, chatId: String(runtime.main.id) }), { code: "invalid" });
    const foreign = String((await runtime.createTask("Foreign", { machineId: "b".repeat(32), cwd: binding.cwd })).id);
    await assert.rejects(runtime.adoptTerminal({ ...args, chatId: foreign, requestId: randomUUID() }), { code: "offline" }); assert.equal(plans.length, 1);
    presence = "exited";
    const reopened = await runtime.openTerminal({ chatId, requestId: randomUUID(), port: 52800, confirmedOnly: true }); await settled(reopened.taskId);
    assert.equal(plans.length, 2); assert.equal(plans[1]!.bootstrap, undefined); assert.equal(plans[1]!.clientState, bootstrap.root);
    assert.equal(plans[1]!.sessionId, sid);
    // An apparently successful native result for another block cannot bless
    // the wizard. Conservative resume never starts another uncertain attempt.
    wrongBlock = true;
    const other = String((await runtime.createTask("Wrong block", binding)).id);
    const wrong = { ...args, chatId: other, requestId: randomUUID() };
    const uncertain = await runtime.adoptTerminal(wrong); await settled(uncertain.taskId);
    assert.equal((await runtime.terminalStatus(other)).status, "uncertain");
    assert.deepEqual(await runtime.adoptTerminal(wrong), uncertain); assert.equal(plans.length, 3);
    await assert.rejects(runtime.openTerminal({ chatId: other, requestId: randomUUID(), port: 52800, confirmedOnly: true }), { code: "conflict" }); assert.equal(plans.length, 3);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
