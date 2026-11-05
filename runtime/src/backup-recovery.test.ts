import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { makeBackup, RESTORE_MARKER, restoreBackup } from "./backup.js";
import { DeckRuntime } from "./deck.js";
import { bindImplementation, checkCompatibility, ImplementationDoc } from "./compatibility.js";
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Backup recovery timed out")), 5000); })]); }
  finally { clearTimeout(timer); }
}

test("backing up crashed Pi work runs no tasks/migrations; restore preserves implementation gate, bindings, captures and receipt identity", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-backup-recovery-")); const state = join(root, "state"); await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, "config.json"), JSON.stringify({ version: 1, machine_id: "a".repeat(32) }), { mode: 0o600 });
  const path = join(state, "session.sqlite");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./compatibility.test.fixture.js", import.meta.url)), path]);
  const closed = once(child, "close"); let errors = ""; child.stdout.resume(); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  let runtime: DeckRuntime | undefined;
  try {
    await within((async () => {
      for (;;) {
        try { await readFile(`${path}.checkpoint`); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })());
    child.kill("SIGKILL"); await closed; await rm(`${path}.checkpoint`);
    const before = await openNodeSqliteStorage(path);
    const tasks = await before.scanTasks({ status: "running" }, 100, undefined, context);
    assert.ok(tasks.items.length); await before.close(context);
    const backup = join(root, "backup"); await makeBackup(state, backup);
    const restored = join(root, "restored"); await mkdir(restored, { mode: 0o700 });
    await writeFile(join(restored, "writer.lock"), "", { mode: 0o600 }); await writeFile(join(restored, RESTORE_MARKER), "incomplete", { mode: 0o600 });
    await restoreBackup(backup, restored);
    const storage = await openNodeSqliteStorage(join(restored, "session.sqlite"));
    try {
      assert.deepEqual((await storage.scanTasks({ status: "running" }, 100, undefined, context)).items, tasks.items);
      await assert.rejects(checkCompatibility(storage, bindImplementation("b".repeat(64), true)), /original Deck implementation/);
      assert.deepEqual((await storage.scanTasks({ status: "running" }, 100, undefined, context)).items, tasks.items);
    } finally { await storage.close(context); }
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider); faux.setResponses([fauxAssistantMessage("RECOVERED_BACKUP")]);
    runtime = await DeckRuntime.open(join(restored, "session.sqlite"), { models, model: { provider: "faux", modelId: "faux-1" }, implementation: "a".repeat(64), binding: { machineId: "wrong-default", cwd: "/other" }, environment: () => undefined, hostFiles: { call: async () => { throw new Error("No effects expected"); } } });
    await within(runtime.main.waitForIdle(context));
    const receipt = await runtime.admit(String(runtime.main.id), { requestId: "original", text: "PRIVATE_WORK_SENTINEL", mode: "followUp" }); assert.equal((await receipt.status(context)).status, "done");
    const history = await runtime.history(String(runtime.main.id)); assert.equal(history.items.filter((entry) => entry.kind === "deck.input").length, 1);
    const input = history.items.find((entry) => entry.kind === "deck.input")!;
    const capture = JSON.parse((input.data as { capture: string }).capture);
    assert.equal(capture.binding.machineId, "saved-host"); assert.equal(capture.binding.cwd, "/saved"); assert.equal(capture.implementation, runtime.implementation);
    assert.equal((await runtime.harness.snapshot(ImplementationDoc, context))?.digest, runtime.implementation);
    assert.match(JSON.stringify(history), /RECOVERED_BACKUP/); assert.equal(faux.state.callCount, 1);
    assert.equal((await readdir(restored)).includes(RESTORE_MARKER), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    await runtime?.close(); await rm(root, { recursive: true, force: true });
  }
});
