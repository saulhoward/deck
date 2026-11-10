import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { DeckRuntime } from "./deck.js";
import { RexDoc, type RexPlan, type RexResult } from "./rex-allocation.js";
import { validOpenArgs, validRexReply } from "./rex-open-contracts.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";
import { serveIpc } from "./ipc.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { responseFrame, responseResult } from "./responses.js";
const uuid = "12345678-1234-1234-1234-123456789abc";
const target = { executable: "/tools/rex", server: "unix:///tmp/rex.sock", hostId: uuid, instanceId: uuid };
const binding = { machineId: "worker", cwd: "/saved" };
const fixtures = JSON.parse(await readFile(new URL("../../src/rex_open.test.json", import.meta.url), "utf8")) as { name: string; command: string; args: unknown; hubId?: string; result: unknown; valid: boolean }[];

test("shared Rex open/read contracts reject malformed replies at serialized egress and ingress", () => {
  for (const fixture of fixtures) {
    assert.equal(validRexReply(fixture, fixture.result), fixture.valid, fixture.name);
    const frame = responseFrame({ version: 1, id: "test", ok: true, result: fixture.result }, fixture);
    const reply = JSON.parse(frame.subarray(4).toString());
    assert.equal(reply.ok, fixture.valid, fixture.name);
    if (fixture.valid) assert.deepEqual(responseResult(reply, "test", fixture), fixture.result);
    else { assert.equal(reply.error.code, "invalid_response"); assert.doesNotMatch(JSON.stringify(reply), /PRIVATE/); assert.throws(() => responseResult({ version: 1, id: "test", ok: true, result: fixture.result }, "test", fixture)); }
  }
  const args = { chatId: "2", requestId: uuid, port: 52800, target };
  assert.ok(validOpenArgs(args));
  for (const change of [{ chatId: "9007199254740992" }, { port: 0 }, { port: "52800" }, { requestId: "new" }, { target: { ...target, client: "/arbitrary" } }, { target: { ...target, executable: "rex" } }, { target: { ...target, server: "unix:///tmp/secret?x" } }, { target: { ...target, server: "unix:///" + "🌍".repeat(30) } }]) assert.equal(validOpenArgs({ ...args, ...change }), false);
});

test("public open reuses running clients, replaces exited/missing ones, and explicitly retries uncertainty without input replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-rex-open-")); const { models } = provider();
  let state = "running", failed = false; let inspectCalls = 0;
  const plans: RexPlan[] = [];
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, binding, implementation: IMPLEMENTATION, rexClient: "/tools/deck", environment: () => undefined, hostFiles: { call: async (saved, _id, operation, args) => {
    assert.deepEqual(saved, binding);
    if (operation === "rex_inspect") {
      inspectCalls++; const query = JSON.parse(String(args.plan));
      return { ok: true, code: "rex_inspected", output: JSON.stringify({ version: 1, scope: query.scope, state, exitCode: state === "exited" ? 0 : null, revision: 1 }) };
    }
    assert.equal(operation, "rex_allocate"); const plan = JSON.parse(String(args.plan)) as RexPlan; plans.push(plan);
    if (failed) return { ok: false, code: "effect_uncertain", output: "PRIVATE" };
    return { ok: true, code: "allocated", output: JSON.stringify({ version: 1, ...plan, sessionId: plan.sessionId ?? `session:${randomUUID()}`, windowId: `window:${randomUUID()}`, blockId: `block:${randomUUID()}`, readiness: "not_checked" }) };
  } } });
  const settled = async (taskId: string) => runtime.harness.waitForTask(Number(taskId) as TaskId<RexResult>, context);
  try {
    const chat = await runtime.createTask("Rex", binding); const chatId = String(chat.id);
    const openArgs = (first = false) => ({ chatId, requestId: randomUUID(), port: 52800, ...(first ? { target } : {}) });
    assert.equal((await runtime.terminalStatus(chatId)).status, "unallocated");
    assert.equal(await runtime.harness.snapshot(RexDoc, chat.id, context), undefined);
    await assert.rejects(runtime.openTerminal(openArgs()), { code: "invalid" });
    await assert.rejects(runtime.openTerminal({ ...openArgs(true), chatId: String(runtime.main.id) }), { code: "invalid" });
    const request = openArgs(true), first = await runtime.openTerminal(request); await settled(first.taskId);
    assert.equal(first.status, "admitted"); assert.equal(plans.length, 1);
    assert.deepEqual(await runtime.openTerminal(request), first); assert.equal(inspectCalls, 0);
    let status = await runtime.terminalStatus(chatId); assert.equal(status.status, "allocated"); const original = status.binding!;
    assert.ok(validRexReply({ command: "rex_status", args: { chatId }, hubId: runtime.hubId }, status));
    assert.equal((await runtime.openTerminal(openArgs())).status, "reused"); assert.equal(plans.length, 1);
    for (const observation of ["pending", "unavailable", "identity_changed", "inconclusive", "conflict"]) { state = observation; await assert.rejects(runtime.openTerminal(openArgs()), { code: "conflict" }); }
    for (const observation of ["exited", "missing_terminal", "missing_session"]) {
      state = observation; const next = await runtime.openTerminal(openArgs()); await settled(next.taskId);
      const previous = status.binding!; status = await runtime.terminalStatus(chatId);
      assert.notEqual(status.binding!.blockId, previous.blockId); assert.deepEqual(status.previousBinding, previous);
      assert.equal(plans.at(-1)!.sessionId, observation === "missing_session" ? undefined : previous.sessionId);
    }
    const known = status.binding!; state = "exited"; failed = true;
    const lost = await runtime.openTerminal(openArgs()); await settled(lost.taskId);
    status = await runtime.terminalStatus(chatId); assert.equal(status.status, "uncertain"); assert.equal(status.binding, null); assert.deepEqual(status.previousBinding, known);
    const oldTask = await runtime.harness.getTask(Number(lost.taskId) as TaskId, context);
    failed = false; const retry = await runtime.openTerminal(openArgs()); await settled(retry.taskId);
    assert.notEqual(retry.taskId, lost.taskId); assert.equal(plans.at(-1)!.sessionId, undefined); // Do not adopt unknown creation or destroy any old object.
    assert.deepEqual(await runtime.harness.getTask(Number(lost.taskId) as TaskId, context), oldTask);
    assert.deepEqual((await settled(first.taskId)).state.outcome, { status: "completed", result: { status: "allocated", binding: original } });
    await assert.rejects(runtime.openTerminal({ ...openArgs(true), target: { ...target, instanceId: randomUUID() } }), { code: "conflict" });
    assert.deepEqual((await runtime.history(chatId)).items, []);
    assert.equal((await runtime.listChats()).items.length, 2);
    // Wire validation happens before dispatch, and a lost/invalid response never
    // dispatches twice or emits arbitrary/private fields.
    const input = new PassThrough(), output = new PassThrough(), decoded = output.pipe(new FrameDecoder());
    const replies: Record<string, any>[] = []; decoded.on("data", (value) => replies.push(value));
    let dispatched = 0; const open = runtime.openTerminal.bind(runtime);
    runtime.openTerminal = async (args) => { dispatched++; return { ...await open(args), private: "PRIVATE" }; };
    state = "running";
    input.end(Buffer.concat([
      encodeFrame({ version: 1, id: "bad", hubId: runtime.hubId, command: "rex_open", args: { ...openArgs(true), extra: "PRIVATE" } }),
      encodeFrame({ version: 1, id: "hub", hubId: randomUUID(), command: "rex_open", args: openArgs() }),
      encodeFrame({ version: 1, id: "egress", hubId: runtime.hubId, command: "rex_open", args: openArgs() }),
    ]));
    await serveIpc(runtime, input, output);
    assert.equal(dispatched, 1); assert.equal(replies.length, 3); assert.ok(replies.every((r) => !r.ok));
    assert.equal(replies.find((r) => r.id === "egress")!.error.code, "invalid_response"); assert.doesNotMatch(JSON.stringify(replies), /PRIVATE/);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
