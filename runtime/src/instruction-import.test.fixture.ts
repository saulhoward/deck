import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { IMPORT_KIND, InstructionRequest } from "./instruction-import.js";
import { checkpoint, IMPLEMENTATION, model, provider } from "./instructions.test.support.js";

const args = process.argv.slice(2); const path = args[0]!; const point = process.env.DECK_IMPORT_TEST_POINT;
const files = new PipeFiles(Number(args[6]), Number(args[7]), Number(args[8]));
const { faux, models } = provider(); let reads = 0;
async function pause(taskId: string) {
  await checkpoint(process.env.DECK_IMPORT_TEST_CHECKPOINT!, { taskId, pid: process.pid });
  setInterval(() => {}, 1000); await new Promise<never>(() => {});
}
const runtime = await DeckRuntime.open(path, {
  models, model, implementation: IMPLEMENTATION,
  binding: { machineId: process.env.DECK_IMPORT_TEST_OFFLINE ? "offline-assignment" : args[1]!, cwd: args[2]! },
  environment: () => { throw new Error("No hub-local fallback"); },
  hostFiles: { call: async (binding, id, operation, request, signal) => {
    reads++;
    if (point === "admitted") await pause(id);
    if (process.env.DECK_IMPORT_TEST_UNCERTAIN) {
      const body = JSON.stringify({ version: 1, id, ...binding, operation, args: request });
      await writeFile(join(dirname(path), "worker", "operations", `${id}.json`), JSON.stringify({ hash: createHash("sha256").update(body).digest("hex"), result: null }), { mode: 0o600 });
    }
    const result = await files.call(binding, id, operation, request, signal);
    if (point === "read") await pause(id);
    return result;
  } },
});
try {
  const id = String(runtime.main.id);
  if (!await runtime.harness.snapshot(InstructionRequest, runtime.main.id, "load", context)) await runtime.configure(id, { instructions: "BEFORE" });
  const taskId = await runtime.importInstructions(id, "load");
  const settled = await runtime.harness.waitForTask(taskId, context);
  assert.equal(settled.state.outcome.status, "completed");
  if (settled.state.outcome.status !== "completed") throw new Error("Import did not complete");
  const result = settled.state.outcome.result;
  if (point === "applied") { assert.equal(result.status, "applied"); await pause(String(taskId)); }
  if (process.env.DECK_IMPORT_TEST_FAILURE) {
    assert.deepEqual(result, { status: "rejected", reason: process.env.DECK_IMPORT_TEST_FAILURE });
    assert.equal((await runtime.main.agent(context)).instructions, "BEFORE"); assert.equal(await runtime.instructionSource(id), undefined);
  } else {
    assert.equal(result.status, "applied");
    const expected = process.env.DECK_IMPORT_TEST_EXPECTED!;
    assert.equal((await runtime.main.agent(context)).instructions, expected);
    faux.setResponses([(request) => { assert.ok(getCurrentSystemPrompt(request.messages).includes(expected)); return fauxAssistantMessage("Applied instructions used"); }]);
    assert.equal((await (await runtime.admit(id, { requestId: "after-import", text: "Hello", mode: "followUp" })).wait(context)).status, "done");
  }
  assert.equal(await runtime.importInstructions(id, "load"), taskId);
  assert.equal((await runtime.harness.commit((tx) => tx.scanTasks({ kind: IMPORT_KIND }, 10), context)).items.length, 1);
  console.log(JSON.stringify({ taskId: String(taskId), reads, calls: faux.state.callCount, result }));
} finally { await runtime.close(); await files.close(); }
