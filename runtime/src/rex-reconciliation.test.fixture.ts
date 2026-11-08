import assert from "node:assert/strict";
import { readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { IMPLEMENTATION, model, provider, checkpoint } from "./instructions.test.support.js";
import { REX_UUID } from "./rex-allocation.test.support.js";
import { allocationRequest } from "./rex-reconciliation.js";
import type { RexInput } from "./rex-allocation.js";
const args = process.argv.slice(2), root = dirname(args[0]!); const point = process.env.DECK_RECONCILE_POINT, mode = process.env.DECK_RECONCILE_MODE;
const files = new PipeFiles(Number(args[6]), Number(args[7]), Number(args[8]));
const binding = { machineId: args[1]!, cwd: args[2]! }; const { models } = provider(); let reads = 0;
async function pause(taskId: string) { await checkpoint(join(root, "checkpoint"), { pid: process.pid, taskId }); await new Promise<never>(() => {}); }
const runtime = await DeckRuntime.open(args[0]!, { models, model, binding, implementation: IMPLEMENTATION, environment: () => undefined, hostFiles: { call: async (...request) => {
  if (request[2] === "rex_allocation_receipt") { reads++; if (point === "admitted") await pause(request[1]); }
  const result = await files.call(...request);
  if (request[2] === "rex_allocate") {
    assert.equal(result.code, "allocated"); // Native retained success; simulate a lost reply to Pi.
    const plan = JSON.parse(String(request[3].plan)); const creation = JSON.parse(result.output);
    await runtime.registerTerminalStartup(plan.chatId, plan.allocationId, creation.blockId);
    await writeFile(join(root, "mode"), "inspect-running"); await writeFile(join(root, "views"), "0");
    return { ok: false, code: "effect_uncertain", output: "Simulated lost allocation reply" };
  }
  if (request[2] === "rex_allocation_receipt" && point === "read") await pause(request[1]);
  return result;
} } });
try {
  const chat = await runtime.createTask("Native proof recovery", binding, "chat"), id = String(chat.id);
  const allocation = await runtime.allocateTerminal(id, "allocate", { executable: join(root, "fake-rex"), server: "unix:///tmp/deck-rex-fake.sock", hostId: REX_UUID, instanceId: REX_UUID, client: await realpath(process.env.DECK_TEST_BINARY!), port: 52800 });
  const original = await runtime.harness.waitForTask(allocation, context);
  assert.deepEqual(original.state.outcome, { status: "completed", result: { status: "uncertain" } });
  const path = join(root, "worker/operations", `${allocation}.json`);
  if (mode) {
    const raw = await readFile(path, "utf8"), receipt = JSON.parse(raw);
    if (mode === "missing") await rm(path);
    else if (mode === "symlink") { await writeFile(join(root, "private-receipt"), raw); await rm(path); await symlink(join(root, "private-receipt"), path); }
    else if (mode === "malformed") await writeFile(path, "PRIVATE_MALFORMED");
    else if (mode === "flood") await writeFile(path, "PRIVATE_FLOOD".repeat(100000));
    else { if (mode === "accepted") receipt.result = null; else if (mode === "conflict") receipt.hash = "0".repeat(64); else if (mode === "wrong-scope") receipt.result.output = JSON.stringify({ ...JSON.parse(receipt.result.output), blockId: "block:bad" }); await writeFile(path, JSON.stringify(receipt)); }
  }
  const receipt = await readFile(path, "utf8").catch(() => null), journal = await readdir(join(root, "worker/operations"));
  const calls = await readFile(join(root, "calls"), "utf8");
  if (!mode && !point) {
    const body = JSON.parse(allocationRequest(Number(allocation), original.input as RexInput));
    for (const patch of [{ operation: "write", args: { path: "MUTATION", content: "BAD" } }, { machineId: "other-worker" }, { cwd: "/other" }, { id: "9999" }, { version: 2 }]) {
      const query = { operationId: String(allocation), request: JSON.stringify({ ...body, ...patch }) };
      const rejected = await files.call(binding, "8001", "rex_allocation_receipt", { plan: JSON.stringify(query) });
      assert.equal(rejected.ok, false); assert.doesNotMatch(rejected.output, /PRIVATE_/);
    }
    assert.equal(await readFile(join(root, "MUTATION"), "utf8").catch(() => null), null);
  }
  const taskId = await runtime.reconcileTerminal(id, "repair"); const task = await runtime.harness.waitForTask(taskId, context);
  assert.equal(task.state.outcome.status, "completed"); const result = task.state.outcome.result;
  assert.equal(result.status, mode ? "unresolved" : "reconciled"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.equal(await runtime.reconcileTerminal(id, "repair"), taskId);
  assert.deepEqual((await runtime.harness.getTask(allocation, context))?.state, original.state);
  assert.equal(await readFile(path, "utf8").catch(() => null), receipt); assert.deepEqual(await readdir(join(root, "worker/operations")), journal);
  assert.equal(await readFile(join(root, "calls"), "utf8"), calls); // Receipt repair never calls Rex, even for a missing record.
  assert.equal((await readFile(join(root, "created"), "utf8")).trim(), "create");
  if (point === "applied") await pause(String(taskId));
  if (!mode) { assert.equal((await runtime.inspectTerminal(id)).observation?.state, "running"); assert.equal((await runtime.terminalStartup(id)).observation, "matched"); }
  else { assert.equal(await runtime.terminalBinding(id), undefined); assert.equal((await runtime.terminalStartup(id)).observation, "unbound"); }
  assert.deepEqual((await runtime.history(id)).items, []); assert.equal((await runtime.harness.inspect(context)).tasks.length, 0);
  console.log(JSON.stringify({ taskId: String(taskId), allocation: String(allocation), result, reads }));
} finally { await runtime.close(); await files.close(); }
