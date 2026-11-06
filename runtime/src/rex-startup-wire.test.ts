import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DeckRuntime } from "./deck.js";
import { serveIpc } from "./ipc.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { IMPLEMENTATION, model, provider, gate, within } from "./instructions.test.support.js";
import type { RexPlan } from "./rex-allocation.js";
const uuid = "12345678-1234-1234-1234-123456789abc";
test("Rex startup wire requires explicit hub and exact intent/block arguments; no admission, execution, or adoption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-rex-wire-")); const { models } = provider(); const entered = gate(); const release = gate(); let plan!: RexPlan;
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), { models, model, binding: { machineId: "host", cwd: "/saved" }, implementation: IMPLEMENTATION, environment: () => undefined, hostFiles: { call: async (_binding, _id, _operation, args) => { plan = JSON.parse(String(args.plan)) as RexPlan; entered.release(); await release.promise; return { ok: false, code: "effect_uncertain", output: "PRIVATE" }; } } });
  const input = new PassThrough(); const output = new PassThrough(); const decoder = output.pipe(new FrameDecoder()); const frames = decoder[Symbol.asyncIterator](); const serving = serveIpc(runtime, input, output);
  const send = async (command: string, args = {}, hubId?: string) => { input.write(encodeFrame({ version: 1, id: "startup-wire", command, args, ...(hubId ? { hubId } : {}) })); return (await frames.next()).value as { ok: boolean; result: Record<string, unknown>; error: { code: string } }; };
  try {
    assert.equal((await send("status")).result.rexStartup, 1);
    const chat = await runtime.createTask("Rex", { machineId: "host", cwd: "/saved" }); const id = String(chat.id);
    const task = await runtime.allocateTerminal(id, "allocate", { executable: "/tools/rex", client: "/tools/deck", server: "unix:///tmp/rex.sock", hostId: uuid, instanceId: uuid, port: 52800 }); await within(entered.promise);
    const args = { chatId: id, allocationId: plan.allocationId, blockId: `block:${uuid}` };
    assert.equal((await send("rex_startup", args)).error.code, "invalid");
    assert.equal((await send("rex_startup", args, "other-hub")).error.code, "conflict");
    assert.equal((await send("rex_startup", { ...args, label: "not-provenance" }, runtime.hubId)).error.code, "invalid");
    assert.equal((await send("rex_startup", { ...args, allocationId: uuid }, runtime.hubId)).error.code, "conflict");
    assert.equal((await runtime.terminalStartup(id)).observation, "not_observed");
    const ack = await send("rex_startup", args, runtime.hubId); assert.equal(ack.ok, true); assert.equal(ack.result.observation, "unbound"); assert.equal(ack.result.live, "not_checked");
    assert.deepEqual(await send("rex_startup", args, runtime.hubId), ack);
    release.release(); await runtime.harness.waitForTask(task, context);
    assert.equal((await runtime.terminalStartup(id)).observation, "unbound"); assert.equal(await runtime.terminalBinding(id), undefined); assert.deepEqual((await runtime.history(id)).items, []);
    const tasks = await runtime.harness.commit((tx) => tx.scanTasks({ conversationId: chat.id }, 100), context); assert.equal(tasks.items.length, 1);
  } finally { release.release(); input.end(); await serving; decoder.destroy(); output.destroy(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
