import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { DeckRuntime, Input } from "./deck.js";
import { setup } from "./managed-child.test.support.js";
import { within } from "./instructions.test.support.js";

for (const kind of ["create", "message"]) test(`SIGKILL after managed ${kind} commit recovers the original receipt without duplicate creation/input or generation on create`, { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-replay-")), path = join(root, "pi.sqlite");
  const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL("./managed-child-replay.test.fixture.js", import.meta.url)), kind, path]);
  const closed = once(process, "close"); let errors = ""; process.stdout.resume(); process.stderr.on("data", chunk => { errors += String(chunk); });
  let runtime: DeckRuntime | undefined;
  try {
    const checkpoint = await within((async () => {
      for (;;) {
        try { return JSON.parse(await readFile(`${path}.checkpoint`, "utf8")) as { parentId: string; childId: string; submissionId?: string; input?: Input }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (process.exitCode !== null || process.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })());
    process.kill("SIGKILL"); await closed;
    const f = setup({ admissionGuard: async () => { throw new Error("No new admission after restart"); } });
    f.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("Recovered")));
    runtime = await f.open(path);
    const child = await runtime.chat(checkpoint.childId), parent = await runtime.chat(checkpoint.parentId);
    await within(child.waitForIdle(context)); await within(parent.waitForIdle(context));
    assert.equal((await runtime.listChats()).items.length, 3);
    assert.equal((await runtime.createManagedChild(checkpoint.parentId, "Managed", "create-managed", { problem: "Own problem", description: "Own immutable task" })).id, child.id);
    if (kind === "create") {
      assert.equal((await runtime.history(checkpoint.childId)).items.length, 0); assert.equal((await runtime.history(checkpoint.parentId)).items.length, 0); assert.equal(f.faux.state.callCount, 0);
    } else {
      const results = (await runtime.history(checkpoint.childId)).items.flatMap(e => e.model ?? []);
      const result = results.find(m => m.role === "toolResult" && m.toolName === "parent_message");
      assert.ok(result?.role === "toolResult"); assert.equal(result.isError, false);
      const receipt = JSON.parse(result.content.map(p => p.type === "text" ? p.text : "").join(""));
      assert.equal(receipt.chatId, checkpoint.parentId); assert.equal(receipt.submissionId, checkpoint.submissionId); assert.equal(receipt.requestId, checkpoint.input!.requestId); assert.deepEqual(receipt.origin, checkpoint.input!.origin);
      assert.equal(receipt.origin.chain.hop, 1); assert.equal(receipt.origin.chain.rootRequestId, "human-start"); assert.equal(receipt.origin.chain.replyToChatId, checkpoint.childId);
      assert.equal((await runtime.history(checkpoint.parentId)).items.filter(e => e.kind === "deck.input").length, 1);
      assert.equal(String((await runtime.admit(checkpoint.parentId, checkpoint.input!)).id), checkpoint.submissionId);
    }
  } finally {
    if (process.exitCode === null && process.signalCode === null) { process.kill("SIGKILL"); await closed; }
    await runtime?.close(); await rm(root, { recursive: true, force: true });
  }
});
