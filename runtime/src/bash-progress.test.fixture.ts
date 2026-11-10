import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { encodeFrame } from "./protocol.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";

const args = process.argv.slice(2); const directory = dirname(args[0]!);
const binding = { machineId: args[1]!, cwd: args[2]! };
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 800; i++) { const value = await read(); if (check(value)) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Expected native bash progress not observed");
}
if (process.env.DECK_BASH_PROGRESS_FAULT) {
  // Intentionally do not consume the result pipe: progress replies fill it.
  // This must not stop shell draining, timeout checks or the independent control reader.
  const requests = createWriteStream("", { fd: Number(args[7]) });
  const control = createWriteStream("", { fd: Number(args[8]) });
  const reader = createReadStream("", { fd: Number(args[6]) }); reader.pause();
  const receipts = join(directory, "worker", "operations");
  requests.write(encodeFrame({ version: 1, id: "5001", ...binding, operation: "bash", args: { command: 'echo $$ > child.pid; trap "" TERM; while :; do printf flood-output; done', timeout: 30 } }));
  await until(() => readFile(join(receipts, "5001.json"), "utf8").catch(() => ""), (text) => !!text);
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (let i = 0; i < 256; i++) requests.write(encodeFrame({ version: 1, id: "progress:5001", ...binding, operation: "bash_progress", args: { target: "5001" } }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const started = Date.now(); const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(5001n); control.write(bytes);
  const settled = await until(() => readFile(join(receipts, "5001.json"), "utf8").then(JSON.parse), (receipt) => receipt.result?.code === "cancelled");
  assert.equal(settled.result.ok, false); assert.ok(Date.now() - started < 4000);
  const pid = Number((await readFile(join(binding.cwd, "child.pid"), "utf8")).trim());
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(await readdir(receipts), ["5001.json"]);
  reader.resume(); requests.end(); control.end();
  await new Promise<void>((resolve) => reader.on("end", resolve));
  console.log("backpressured progress did not block native cancellation");
} else {
  const files = new PipeFiles(Number(args[6]), Number(args[7]), Number(args[8]));
  const { faux, models } = provider(); let recoveredEffects = 0;
  const recovering = !!process.env.DECK_BASH_PROGRESS_RECOVER;
  if (recovering) faux.setResponses([fauxAssistantMessage("RECOVERED_WITHOUT_REPLAY")]);
  const runtime = await DeckRuntime.open(args[0]!, { models, model, implementation: IMPLEMENTATION, binding, environment: () => undefined, hostFiles: { call: (...request) => {
    if (recovering) { recoveredEffects++; throw new Error("Interrupted bash must not be replayed"); }
    return files.call(...request);
  } } });
  try {
    const id = String(runtime.main.id);
    if (recovering) {
      const submission = await runtime.admit(id, { requestId: "bash", text: "Run", mode: "followUp" });
      await submission.wait(context);
      assert.equal((await runtime.progress(id)).tools, undefined); assert.equal(recoveredEffects, 0);
      const history = JSON.stringify((await runtime.history(id)).items);
      assert.match(history, /interrupted/); assert.match(history, /RECOVERED_WITHOUT_REPLAY/);
      assert.equal(await readFile(join(binding.cwd, "executions"), "utf8"), "once");
      console.log("interrupted preview did not replay native bash");
    } else {
    const other = await runtime.createTask("Other", binding);
    const command = 'printf once >> executions; printf EARLY_OUTPUT; while test ! -f release; do sleep .05; done; printf FINAL_OUTPUT';
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command, timeout: 15 })], { stopReason: "toolUse" }), fauxAssistantMessage("DONE")]);
    const submission = await runtime.admit(id, { requestId: "bash", text: "Run", mode: "followUp" });
    const preview = await until(() => runtime.progress(id), (value) => !!value.tools?.some((tool) => tool.text.includes("EARLY_OUTPUT")));
    const taskId = preview.tools![0]!.taskId;
    if (process.env.DECK_BASH_PROGRESS_CRASH) {
      await writeFile(process.env.DECK_BASH_PROGRESS_CRASH, JSON.stringify({ pid: process.pid, taskId }));
      await new Promise<never>(() => {});
    }
    assert.equal((await submission.status(context)).status, "placed");
    assert.equal((await runtime.progress(String(other.id))).tools, undefined);
    const entries = (await runtime.history(id)).items.map((entry) => entry.id);
    assert.doesNotMatch(JSON.stringify((await runtime.history(id)).items), /pi.tool-result/);
    for (let i = 0; i < 10; i++) await runtime.progress(id);
    assert.deepEqual((await runtime.history(id)).items.map((entry) => entry.id), entries);
    assert.deepEqual(await readdir(join(directory, "worker", "operations")), [`${taskId}.json`]);
    await writeFile(join(binding.cwd, "release"), "");
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal((await runtime.progress(id)).tools, undefined);
    const history = JSON.stringify((await runtime.history(id)).items);
    assert.match(history, /EARLY_OUTPUTFINAL_OUTPUT/); assert.doesNotMatch(history, /"kind":"deck\.bash-progress"/);
    let replays = 0;
    const result = await files.call(binding, taskId, "bash", { command, timeout: 15 }, undefined, () => { replays++; });
    assert.equal(result.ok, true); assert.equal(replays, 0); assert.equal(await readFile(join(binding.cwd, "executions"), "utf8"), "once");

    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: 'printf STOP_OUTPUT; trap "" TERM; while :; do sleep .05; done', timeout: 30 })], { stopReason: "toolUse" })]);
    const stopped = await runtime.admit(id, { requestId: "stop", text: "Run and stop", mode: "followUp" });
    await until(() => runtime.progress(id), (value) => !!value.tools?.some((tool) => tool.text.includes("STOP_OUTPUT")));
    const start = Date.now(); await runtime.stop(id);
    assert.ok(Date.now() - start < 4000); assert.equal((await stopped.status(context)).status, "unanswered");
    assert.equal((await runtime.progress(id)).tools, undefined);

    let snapshots = 0;
    const lossy = await files.call(binding, "6001", "bash", { command: "printf '\\377'; sleep 1.2", timeout: 5 }, undefined, (sample) => { snapshots++; assert.equal(sample.lossyUtf8, true); assert.equal(sample.output, "?"); throw new Error("Display failed"); });
    assert.equal(lossy.ok, true); assert.ok(snapshots > 0); assert.match(lossy.output, /lossyUtf8=true/);
    assert.equal((await files.call(binding, "6002", "read", { path: "executions" })).output, "once");
    console.log("native Pi bash progress, final result, stop and replay verified");
    }
  } finally { await runtime.close(); await files.close(); }
}
