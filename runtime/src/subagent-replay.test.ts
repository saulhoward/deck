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
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Recovery timed out")), 5000); })]); }
  finally { clearTimeout(timer); }
}
for (const step of ["created", "answered"] as const) test(`foreground delegation recovers after SIGKILL at ${step} checkpoint without a second child/input`, { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-subagent-replay-")); const path = join(directory, "pi.sqlite");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./subagent.test.fixture.js", import.meta.url)), step, path]);
  const closed = once(child, "close"); let errors = ""; child.stdout.resume(); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  let runtime: DeckRuntime | undefined;
  try {
    const checkpoint = await within((async () => {
      for (;;) {
        try { return JSON.parse(await readFile(`${path}.checkpoint`, "utf8")) as { chatId: string; ownerTaskId: string }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })());
    child.kill("SIGKILL"); await closed;
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 3 }, () => (request) => request.messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Foreground delegation")) ? fauxAssistantMessage("CHILD_ANSWER") : fauxAssistantMessage("Parent recovered")));
    runtime = await DeckRuntime.open(path, { models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: "ignored-new-default", cwd: "/different" }, environment: () => undefined, hostFiles: { call: async () => { throw new Error("No effects expected"); } } });
    await within(runtime.main.waitForIdle(context));
    const chats = (await runtime.listChats()).items; assert.equal(chats.length, 2);
    const recovered = chats.find((item) => item.kind === "subagent")!;
    assert.equal(recovered.chatId, checkpoint.chatId); assert.equal(recovered.ownerTaskId, checkpoint.ownerTaskId);
    assert.equal(recovered.machineId, "host"); assert.equal(recovered.cwd, "/saved");
    assert.deepEqual((await (await runtime.chat(checkpoint.chatId)).agent(context)).tools.map((tool) => tool.name), ["read", "write", "edit", "bash"]);
    const inputs = (await runtime.history(checkpoint.chatId)).items.filter((entry) => entry.kind === "deck.input");
    assert.equal(inputs.length, 1); assert.equal((inputs[0]!.data as { requestId: string }).requestId, `deck-subagent:${checkpoint.ownerTaskId}`);
    const result = (await runtime.history(String(runtime.main.id))).items.flatMap((entry) => entry.model ?? []).find((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, false);
    const receipt = JSON.parse(result.content.map((part) => part.type === "text" ? part.text : "").join("")) as { chatId: string; status: string; answer: string };
    assert.equal(receipt.chatId, checkpoint.chatId); assert.equal(receipt.status, "done"); assert.equal(receipt.answer, "CHILD_ANSWER");
    assert.equal(faux.state.callCount, step === "created" ? 2 : 1); // A committed child answer is not generated again.
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    await runtime?.close(); await rm(directory, { recursive: true, force: true });
  }
});
