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
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { ChatDoc, DeckRuntime } from "./deck.js";
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Operation timed out")), 5000); })]); }
  finally { clearTimeout(timer); }
}
function setup() {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  return { faux, options: { models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: "host", cwd: "/saved" }, environment: () => undefined, hostFiles: { call: async () => { throw new Error("No native effects expected"); } } } };
}

test("model creates on caller binding and messages without waiting; caller stop does not cancel ownerless target", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-control-")); const { faux, options } = setup();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options); const entered = gate(); const release = gate();
  const receiptReady = gate(); const senderRelease = gate();
  let targetId = "";
  try {
    const caller = await runtime.createTask("Caller", { machineId: "offline-caller", cwd: "/caller" });
    const route: FauxResponseFactory = async (request) => {
      if (request.messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.endsWith("\nTarget work"))) {
        entered.release(); await release.promise; return fauxAssistantMessage("Target done");
      }
      const last = request.messages.filter((message) => message.role === "toolResult").at(-1);
      if (!last) return fauxAssistantMessage(fauxToolCall("task_create", { title: "Model-created task" }), { stopReason: "toolUse" });
      assert.equal(last.isError, false);
      const receipt = JSON.parse(last.content.map((part) => part.type === "text" ? part.text : "").join("")) as Record<string, unknown>;
      if (last.toolName === "task_create") {
        assert.equal(receipt.started, false); targetId = String(receipt.chatId);
        return fauxAssistantMessage(fauxToolCall("task_message", { chatId: targetId, text: "Target work" }), { stopReason: "toolUse" });
      }
      assert.equal(last.toolName, "task_message"); assert.equal(receipt.admitted, true);
      assert.equal(receipt.mode, "followUp"); assert.equal(receipt.completion, "not_waited");
      receiptReady.release(); await senderRelease.promise;
      return fauxAssistantMessage("Admission acknowledged, not completed");
    };
    faux.setResponses(Array.from({ length: 6 }, () => route));
    const source = await runtime.admit(String(caller.id), { requestId: "control", text: "Start", mode: "followUp" });
    await within(receiptReady.promise); await within(entered.promise);
    const target = await runtime.chat(targetId);
    const binding = await runtime.harness.snapshot(ChatDoc, target.id, context);
    assert.equal(binding?.machineId, "offline-caller"); assert.equal(binding?.cwd, "/caller");
    assert.deepEqual((await target.agent(context)).model, options.model);
    const stopping = runtime.stop(String(caller.id)); senderRelease.release(); await within(stopping);
    assert.equal((await within(source.wait(context))).status, "unanswered");
    assert.equal((await runtime.activity(targetId)).busy, true);
    release.release(); await within(target.waitForIdle(context));
    const inputs = (await runtime.history(targetId)).items.filter((entry) => entry.kind === "deck.input");
    assert.equal(inputs.length, 1); assert.equal((inputs[0]!.data as { mode: string }).mode, "followUp");
    const origin = (inputs[0]!.data as { origin: { kind: string; chatId: string; taskId: string } }).origin;
    assert.equal(origin.kind, "task-tool"); assert.equal(origin.chatId, String(caller.id)); assert.match(origin.taskId, /^\d+$/);
  } finally { senderRelease.release(); release.release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const kind of ["create", "message"] as const) test(`SIGKILL after ${kind} commit replays the same Pi tool task without duplicate mutation`, { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-control-replay-")); const path = join(directory, "pi.sqlite");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./task-control.test.fixture.js", import.meta.url)), kind, path]);
  const closed = once(child, "close"); let errors = ""; child.stdout.resume(); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  let runtime: DeckRuntime | undefined;
  try {
    const checkpoint = await within((async () => {
      for (;;) {
        try { return JSON.parse(await readFile(`${path}.checkpoint`, "utf8")) as { chatId: string; submissionId?: string }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })());
    child.kill("SIGKILL"); await closed;
    const { faux, options } = setup();
    faux.setResponses([() => fauxAssistantMessage("Recovered"), () => fauxAssistantMessage("Recovered")]);
    runtime = await DeckRuntime.open(path, { ...options, admissionGuard: async () => { throw new Error("Auth now unavailable; existing receipts must still be readable"); } });
    await within(runtime.main.waitForIdle(context));
    const target = await runtime.chat(checkpoint.chatId); await within(target.waitForIdle(context));
    assert.equal((await runtime.listChats()).items.length, 2);
    const result = (await runtime.history(String(runtime.main.id))).items.flatMap((entry) => entry.model ?? []).find((message) => message.role === "toolResult" && message.toolName === `task_${kind}`);
    assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, false);
    const receipt = JSON.parse(result.content.map((part) => part.type === "text" ? part.text : "").join("")) as { chatId: string; submissionId?: string; requestId: string };
    assert.equal(receipt.chatId, checkpoint.chatId); assert.match(receipt.requestId, /^deck-tool:\d+:(create|message)$/);
    const inputs = (await runtime.history(checkpoint.chatId)).items.filter((entry) => entry.kind === "deck.input");
    if (kind === "create") assert.equal(inputs.length, 0);
    else {
      assert.equal(receipt.submissionId, checkpoint.submissionId); assert.equal(inputs.length, 1);
      const input = inputs[0]!.data as { requestId: string; origin: { kind: "task-tool"; chatId: string; taskId: string } };
      assert.equal(input.requestId, receipt.requestId);
      await assert.rejects(runtime.admit(checkpoint.chatId, { requestId: receipt.requestId, text: "TARGET", mode: "steer", origin: { ...input.origin, chatId: checkpoint.chatId } }), { code: "conflict" });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    await runtime?.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("model mutation rejects self/main/unmanaged targets and invalid payloads without target admissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-control-invalid-")); const { faux, options } = setup();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  try {
    const caller = await runtime.createTask("Caller", options.binding);
    const target = await runtime.createTask("Target", { machineId: "offline", cwd: "/remote" });
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const calls: { name: string; args: Record<string, string> }[] = [
      ...[caller.id, runtime.main.id, unmanaged.id, 999999999].map((chatId) => ({ name: "task_message", args: { chatId: String(chatId), text: "Reject this" } })),
      { name: "task_message", args: { chatId: String(target.id), text: "   " } },
      { name: "task_message", args: { chatId: String(target.id), text: "Too long".repeat(1200) } },
      { name: "task_message", args: { chatId: String(target.id), text: "Invalid mode", mode: "reject" } },
      { name: "task_create", args: { title: "   " } },
      { name: "task_create", args: { title: "x".repeat(201) } },
    ];
    const response = (index: number) => index < calls.length ? fauxAssistantMessage(fauxToolCall(calls[index]!.name, calls[index]!.args), { stopReason: "toolUse" }) : fauxAssistantMessage("Rejected safely");
    faux.setResponses([response(0), ...calls.map((_, index): FauxResponseFactory => (request) => {
      const last = request.messages.filter((message) => message.role === "toolResult").at(-1);
      assert.equal(last?.isError, true); return response(index + 1);
    })]);
    assert.equal((await (await runtime.admit(String(caller.id), { requestId: "invalid", text: "Try invalid mutations", mode: "followUp" })).wait(context)).status, "done");
    assert.equal((await runtime.listChats()).items.length, 3);
    for (const id of [runtime.main.id, target.id, unmanaged.id]) assert.equal((await runtime.history(String(id))).items.length, 0);
    assert.equal(await runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cancelled serialized mutations do not create or admit work after an admission guard drains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-control-cancel-")); const { faux, options } = setup();
  const entered = gate(); const release = gate();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), { ...options, admissionGuard: async () => { entered.release(); await release.promise; } });
  try {
    const admissionSignal = new AbortController(); const creationSignal = new AbortController();
    const admission = runtime.admit(String(runtime.main.id), { requestId: "cancelled", text: "Never admit", mode: "followUp" }, admissionSignal.signal);
    await entered.promise;
    const creation = runtime.createTask("Never create", options.binding, "cancelled-create", creationSignal.signal);
    admissionSignal.abort(); creationSignal.abort();
    const rejected = [assert.rejects(admission, { name: "AbortError" }), assert.rejects(creation, { name: "AbortError" })];
    release.release(); await Promise.all(rejected);
    assert.equal((await runtime.listChats()).items.length, 1); assert.equal((await runtime.history(String(runtime.main.id))).items.length, 0); assert.equal(faux.state.callCount, 0);
  } finally { release.release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
