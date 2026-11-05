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
import { DeckRuntime } from "./deck.js";
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Progress recovery timed out")), 5000); })]); }
  finally { clearTimeout(timer); }
}
test("SIGKILL during visible partial: Pi retains interrupted text, recovers the original input and exposes only the new final answer as completed", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-progress-recovery-")); const path = join(directory, "pi.sqlite");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./progress.test.fixture.js", import.meta.url)), path]);
  const closed = once(child, "close"); let errors = ""; child.stdout.resume(); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  let runtime: DeckRuntime | undefined;
  try {
    const checkpoint = await within((async () => {
      for (;;) {
        try { return JSON.parse(await readFile(`${path}.checkpoint`, "utf8")) as { submissionId: string; text: string }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })());
    child.kill("SIGKILL"); await closed;
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("RECOVERED_FINAL")]);
    runtime = await DeckRuntime.open(path, { models, model: { provider: "faux", modelId: "faux-1" }, implementation: "a".repeat(64), binding: { machineId: "wrong-default", cwd: "/other" }, environment: () => undefined, hostFiles: { call: async () => { throw new Error("No effects expected"); } } });
    await within(runtime.main.waitForIdle(context));
    const receipt = await runtime.admit(String(runtime.main.id), { requestId: "original", text: "Start", mode: "followUp" });
    assert.equal(String(receipt.id), checkpoint.submissionId); assert.equal((await receipt.status(context)).status, "done");
    const entries = (await runtime.history(String(runtime.main.id))).items;
    assert.equal(entries.filter((entry) => entry.kind === "deck.input").length, 1);
    const answers = entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "assistant");
    assert.ok(answers.some((message) => message.stopReason === "aborted" && JSON.stringify(message.content).includes(checkpoint.text)));
    const completed = answers.filter((message) => message.stopReason === "stop");
    assert.equal(completed.length, 1); assert.match(JSON.stringify(completed), /RECOVERED_FINAL/); assert.doesNotMatch(JSON.stringify(completed), /OLD_PARTIAL_/);
    assert.equal("generation" in await runtime.progress(String(runtime.main.id)), false); assert.equal(faux.state.callCount, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    await runtime?.close(); await rm(directory, { recursive: true, force: true });
  }
});
