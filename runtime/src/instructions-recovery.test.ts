import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { DeckRuntime } from "./deck.js";
import { CHANGED, gate, IMPLEMENTATION, model, openProbe, ORIGINAL, provider, within, type Probe } from "./instructions.test.support.js";

async function crashed(mode: Probe | "stored", run: (path: string, projectPath: string, checkpoint: Record<string, string>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "deck-instructions-recovery-"));
  const path = join(directory, "pi.sqlite"); const projectPath = join(directory, "AGENTS.md");
  await writeFile(projectPath, ORIGINAL);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./instructions.test.fixture.js", import.meta.url)), path, projectPath, mode]);
  const closed = once(child, "close"); let errors = ""; child.stdout.resume(); child.stderr.on("data", (chunk) => { errors = (errors + String(chunk)).slice(-8192); });
  try {
    const checkpoint = await within((async () => {
      for (;;) {
        try { return JSON.parse(await readFile(`${path}.checkpoint`, "utf8")) as Record<string, string>; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })());
    child.kill("SIGKILL"); await within(closed);
    await run(path, projectPath, checkpoint);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await within(closed); }
    await rm(directory, { recursive: true, force: true });
  }
}

for (const probe of ["prepare", "request", "memo"] as const) {
  test(`SIGKILL at ${probe}: ${probe === "prepare" ? "uncommitted section rendering rereads changed source" : probe === "request" ? "prepared canonical section survives loss of its source" : "live task memo survives but provider-only text is not retained after settlement"}`, { timeout: 20_000 }, async () => {
    await crashed(probe, async (path, projectPath) => {
      if (probe === "prepare") await writeFile(projectPath, CHANGED); else await rm(projectPath);
      const { harness, root, faux, counts } = await openProbe(path, projectPath, probe);
      try {
        const expected = probe === "prepare" ? CHANGED : ORIGINAL;
        faux.setResponses([(request) => { const prompt = getCurrentSystemPrompt(request.messages); assert.ok(prompt.includes(expected)); assert.ok(!prompt.includes(probe === "prepare" ? ORIGINAL : CHANGED)); return fauxAssistantMessage("Recovered"); }]);
        const receipt = await root.submit({ requestId: "original", type: "input", content: "Start" }, context);
        assert.equal((await within(receipt.wait(context))).status, "done");
        assert.equal(faux.state.callCount, 1); assert.equal(counts.reads, probe === "prepare" ? 1 : 0);
        const entries = (await root.entries({ order: "ascending" }, 100, undefined, context)).items;
        assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 1);
        assert.equal(JSON.stringify(entries).includes(expected), probe !== "memo");
      } finally { await harness.close(context); }
    });
  });
}

test("SIGKILL with active and queued Deck input preserves stored instructions, original IDs and capture despite changed workspace/defaults", { timeout: 20_000 }, async () => {
  await crashed("stored", async (path, projectPath, checkpoint) => {
    await writeFile(projectPath, CHANGED);
    const { faux, models } = provider(); const entered = gate(); const release = gate();
    faux.setResponses([
      async (request) => { assert.ok(getCurrentSystemPrompt(request.messages).includes(ORIGINAL)); assert.ok(!getCurrentSystemPrompt(request.messages).includes(CHANGED)); entered.release(); await release.promise; return fauxAssistantMessage("Recovered first"); },
      (request) => { assert.ok(getCurrentSystemPrompt(request.messages).includes(ORIGINAL)); assert.ok(!getCurrentSystemPrompt(request.messages).includes(CHANGED)); return fauxAssistantMessage("Recovered queued"); },
    ]);
    const runtime = await DeckRuntime.open(path, {
      models, model, implementation: IMPLEMENTATION, binding: { machineId: "wrong-default", cwd: "/not-the-saved-workspace" },
      environment: () => { throw new Error("No local fallback expected"); }, hostFiles: { call: async () => { throw new Error("No effects expected"); } },
    });
    try {
      await within(entered.promise);
      const id = String(runtime.main.id);
      assert.equal((await runtime.main.agent(context)).instructions, ORIGINAL);
      await assert.rejects(runtime.configure(id, { instructions: CHANGED }), { code: "busy" });
      release.release(); await within(runtime.main.waitForIdle(context));
      for (const [requestId, text, expectedId] of [["first", "First", checkpoint.firstId], ["queued", "Queued", checkpoint.queuedId]] as const) {
        const receipt = await runtime.admit(id, { requestId, text, mode: "followUp" });
        assert.equal(String(receipt.id), expectedId); assert.equal((await receipt.status(context)).status, "done");
      }
      const inputs = (await runtime.history(id)).items.filter((entry) => entry.kind === "deck.input");
      assert.equal(inputs.length, 2); assert.equal(faux.state.callCount, 2);
      for (const entry of inputs) {
        const capture = JSON.parse((entry.data as { capture: string }).capture);
        assert.equal(capture.instructionsHash, createHash("sha256").update(ORIGINAL).digest("hex"));
        assert.equal(capture.binding.machineId, "saved-worker");
      }
    } finally { release.release(); await runtime.close(); }
  });
});
