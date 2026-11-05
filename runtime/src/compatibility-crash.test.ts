import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CompatibilityError } from "./compatibility.js";
import { DeckRuntime } from "./deck.js";
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Compatibility recovery timed out")), 5000); })]); }
  finally { clearTimeout(timer); }
}
test("SIGKILL: changed implementation refuses before Pi restart normalization; original implementation recovers the same input", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-compat-crash-")); const path = join(directory, "pi.sqlite");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./compatibility.test.fixture.js", import.meta.url)), path]);
  const closed = once(child, "close"); let errors = ""; child.stdout.resume(); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  let runtime: DeckRuntime | undefined;
  const snapshot = async () => {
    const storage = await openNodeSqliteStorage(path);
    try {
      const running = (await storage.scanTasks({ status: "running" }, 100, undefined, context)).items;
      const pending = (await storage.scanTasks({ status: "pending" }, 100, undefined, context)).items;
      return { running, pending, inputs: (await storage.scanSubmissions({}, 100, undefined, context)).items };
    } finally { await storage.close(context); }
  };
  try {
    await within((async () => {
      for (;;) {
        try { await readFile(`${path}.checkpoint`, "utf8"); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })());
    child.kill("SIGKILL"); await closed;
    const before = await snapshot(); assert.ok(before.running.length); assert.equal(before.inputs.length, 1);
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider); let effects = 0;
    const options = { models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: "wrong-default", cwd: "/other" }, environment: () => undefined, hostFiles: { call: async () => { effects++; throw new Error("Unexpected effect"); } } };
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(DeckRuntime.open(path, { ...options, implementation: "b".repeat(64) }), (error: unknown) => error instanceof CompatibilityError && !error.message.includes("PRIVATE_WORK_SENTINEL"));
      assert.deepEqual(await snapshot(), before); // Includes restart counters/checkpoints; no Harness.open ran.
      assert.equal(faux.state.callCount, 0); assert.equal(effects, 0);
    }
    faux.setResponses([fauxAssistantMessage("Recovered under original implementation")]);
    runtime = await DeckRuntime.open(path, { ...options, implementation: "a".repeat(64) });
    await within(runtime.main.waitForIdle(context));
    const receipt = await runtime.admit(String(runtime.main.id), { requestId: "original", text: "PRIVATE_WORK_SENTINEL", mode: "followUp" });
    assert.equal(receipt.id, before.inputs[0]!.id); assert.equal((await receipt.status(context)).status, "done");
    assert.equal((await runtime.history(String(runtime.main.id))).items.filter((entry) => entry.kind === "deck.input").length, 1);
    assert.equal(effects, 0); assert.equal(faux.state.callCount, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    await runtime?.close(); await rm(directory, { recursive: true, force: true });
  }
});
