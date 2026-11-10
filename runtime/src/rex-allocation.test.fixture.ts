import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { type RexResult, type RexTarget } from "./rex-allocation.js";
import { IMPLEMENTATION, model, provider, checkpoint } from "./instructions.test.support.js";
import { REX_UUID } from "./rex-allocation.test.support.js";
const args = process.argv.slice(2); const directory = dirname(args[0]!); const mode = process.env.DECK_REX_MODE;
const point = process.env.DECK_REX_POINT;
const files = new PipeFiles(Number(args[6]), Number(args[7]), Number(args[8]));
const target: RexTarget = { executable: join(directory, "fake-rex"), server: "unix:///tmp/deck-rex-fake.sock", hostId: REX_UUID, instanceId: REX_UUID, client: mode === "bad_client" ? "/usr/bin/false" : await realpath(process.env.DECK_TEST_BINARY!), port: 52800 };
const binding = { machineId: mode === "offline" ? "offline-worker" : args[1]!, cwd: args[2]! };
const { models } = provider(); let calls = 0;
async function pause(taskId: string) { await checkpoint(join(directory, "checkpoint"), { pid: process.pid, taskId }); await new Promise<never>(() => {}); }
const runtime = await DeckRuntime.open(args[0]!, { models, model, binding, implementation: IMPLEMENTATION, environment: () => undefined, hostFiles: { call: async (saved, id, operation, request, signal) => {
  calls++; assert.equal(operation, "rex_allocate"); if (point === "admitted") await pause(id);
  if (point === "creating") await checkpoint(join(directory, "checkpoint"), { pid: process.pid, taskId: id });
  if (mode === "uncertain") {
    const body = JSON.stringify({ version: 1, id, ...saved, operation, args: request });
    await writeFile(join(directory, "worker", "operations", `${id}.json`), JSON.stringify({ hash: createHash("sha256").update(body).digest("hex"), result: null }));
  }
  const result = await files.call(saved, id, operation, request, signal);
  if (point === "startup") {
    const plan = JSON.parse(String(request.plan)) as { chatId: string; allocationId: string };
    const created = JSON.parse(result.output) as { blockId: string };
    assert.equal((await runtime.registerTerminalStartup(plan.chatId, plan.allocationId, created.blockId)).observation, "unbound");
    await pause(id); // Pi observation committed, binding/apply and client ACK lost.
  }
  if (point === "result") await pause(id);
  return result;
} } });
try {
  const chat = await runtime.createTask("Native Rex", binding, "rex-chat"); const id = String(chat.id);
  const task = await runtime.allocateTerminal(id, "open", target);
  if (mode === "cancel") {
    for (let i = 0; i < 500; i++) { if (await readFile(join(directory, "created"), "utf8").catch(() => "")) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    const other = await runtime.createTask("Unrelated", { machineId: "offline", cwd: "/other" }); assert.ok(other.id);
    assert.equal((await files.call(binding, "9001", "write", { path: "fair.txt", content: "file I/O proceeds" })).ok, true);
    const before = Date.now(); await runtime.stop(id); assert.ok(Date.now() - before < 4000);
  }
  const settled = await runtime.harness.waitForTask(task, context);
  assert.equal(settled.state.outcome.status, "completed"); if (settled.state.outcome.status !== "completed") throw new Error("No result");
  const result: RexResult = settled.state.outcome.result;
  const expected = mode === "cancel" ? "aborted" : ["offline", "api_mismatch", "wrong_server", "bad_client"].includes(mode ?? "") ? "not_allocated" : mode && mode !== "api10" ? "uncertain" : "allocated";
  assert.equal(result.status, expected); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  if (result.status === "allocated") { assert.equal(result.binding.readiness, "not_checked"); assert.deepEqual(await runtime.terminalBinding(id), result.binding); }
  else assert.equal(await runtime.terminalBinding(id), undefined);
  if (point === "applied") await pause(String(task));
  assert.equal(await runtime.allocateTerminal(id, "open", target), task);
  await assert.rejects(runtime.allocateTerminal(id, "new", target), { code: "conflict" });
  console.log(JSON.stringify({ taskId: String(task), calls, result, startup: await runtime.terminalStartup(id) }));
} finally { await runtime.close(); await files.close(); }
