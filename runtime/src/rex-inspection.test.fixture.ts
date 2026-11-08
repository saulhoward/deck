import assert from "node:assert/strict";
import { readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";
import { REX_UUID } from "./rex-allocation.test.support.js";
const args = process.argv.slice(2); const root = dirname(args[0]!);
const files = new PipeFiles(Number(args[6]), Number(args[7]), Number(args[8]));
const binding = { machineId: args[1]!, cwd: args[2]! }; const { models } = provider();
const runtime = await DeckRuntime.open(args[0]!, { models, model, binding, implementation: IMPLEMENTATION, environment: () => undefined, hostFiles: files });
try {
  const chat = await runtime.createTask("Inspection", binding, "chat"); const id = String(chat.id);
  const taskId = await runtime.allocateTerminal(id, "allocate", { executable: join(root, "fake-rex"), server: "unix:///tmp/deck-rex-fake.sock", hostId: REX_UUID, instanceId: REX_UUID, client: await realpath(process.env.DECK_TEST_BINARY!), port: 52800 });
  const task = await runtime.harness.waitForTask(taskId, context); assert.equal(task.state.outcome.status, "completed");
  const saved = await runtime.terminalBinding(id); assert.ok(saved);
  const receipts = await readdir(join(root, "worker/operations")); const receipt = await readFile(join(root, "worker/operations", `${taskId}.json`), "utf8");
  const states: Record<string, string> = {};
  const modes = ["running", "pending", "pending-omitted", "exited", "missing-session", "missing-terminal", "detached", "detached-omitted", "duplicate", "host-conflict", "wrong-window", "partial", "inconsistent", "mixed-404", "process-malformed", "api-mismatch", "identity", "identity-after", "revision", "malformed", "flood", "spoof-stdout", "forbidden", "timeout", "cancel"];
  for (const mode of modes) {
    await writeFile(join(root, "mode"), `inspect-${mode}`); await writeFile(join(root, "views"), "0");
    await rm(join(root, "inspected"), { force: true }); await rm(join(root, "read-started"), { force: true });
    const abort = new AbortController(); const read = runtime.inspectTerminal(id, abort.signal);
    if (mode === "cancel") {
      let started = false;
      for (let i = 0; i < 500; i++) { if (await readFile(join(root, "read-started"), "utf8").catch(() => "")) { started = true; break; } await new Promise((resolve) => setTimeout(resolve, 10)); }
      assert.ok(started);
      assert.equal((await files.call(binding, "9001", "write", { path: "independent.txt", content: "independent" })).ok, true);
      const at = Date.now(); abort.abort(); await read; assert.ok(Date.now() - at < 2000);
    }
    const result = await read; assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|argv|pid/);
    assert.equal(result.chatId, id); assert.equal(result.taskId, String(taskId)); assert.ok(result.finishedAtMs >= result.startedAtMs);
    states[mode] = result.status === "sampled" ? result.observation!.state : result.status;
    if (mode === "exited") assert.equal(result.observation?.exitCode, 7, JSON.stringify(result));
    else assert.equal(result.observation?.exitCode ?? null, null);
    assert.deepEqual(await runtime.terminalBinding(id), saved);
    assert.equal(await readFile(join(root, "worker/operations", `${taskId}.json`), "utf8"), receipt);
    assert.deepEqual(await runtime.history(id), { items: [] });
  }
  const after = await readdir(join(root, "worker/operations"));
  assert.deepEqual(after.sort(), [...receipts, "9001.json"].sort()); // Read IDs never enter the native journal.
  assert.equal((await readFile(join(root, "created"), "utf8")).trim(), "create");
  assert.equal((await runtime.harness.inspect(context)).tasks.length, 0);
  console.log(JSON.stringify(states));
} finally { await runtime.close(); await files.close(); }
