import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DeckRuntime, type RuntimeOptions } from "./deck.js";
import { delegationAnswer } from "./subagent.js";
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Delegation timed out")), 5000); })]); }
  finally { clearTimeout(timer); }
}
function setup(hostFiles: RuntimeOptions["hostFiles"] = { call: async () => { throw new Error("No native effects expected"); } }) {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  return { faux, options: { models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: "offline-host", cwd: "/saved" }, environment: () => undefined, hostFiles } };
}
const isChild = (messages: readonly { role: string; content?: unknown }[]) => messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Foreground delegation"));

test("foreground child inherits agent/binding without widening selections, returns answer, and is inspection-only externally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-subagent-")); const { faux, options } = setup();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  try {
    const original = await runtime.main.agent(context);
    await runtime.configure(String(runtime.main.id), { extensions: original.extensions.filter((extension) => extension.name !== "deck.task-inspection"), instructions: "PARENT_INSTRUCTIONS" });
    const selected = await runtime.main.agent(context);
    await runtime.configure(String(runtime.main.id), { tools: selected.tools.filter((tool) => tool.name !== "write") });
    const route: FauxResponseFactory = (request) => {
      if (isChild(request.messages)) {
        assert.doesNotMatch(JSON.stringify(request.messages), /PARENT_TRANSCRIPT_SECRET/);
        assert.match(JSON.stringify(request.messages), /PARENT_INSTRUCTIONS/);
        return fauxAssistantMessage([fauxThinking("HIDDEN_CHILD_REASONING"), { type: "text", text: "CHILD_FINAL" }]);
      }
      const result = request.messages.filter((message) => message.role === "toolResult").at(-1);
      if (!result) return fauxAssistantMessage(fauxToolCall("subagent", { task: "CHILD_TASK", title: "Foreground helper" }), { stopReason: "toolUse" });
      assert.equal(result.isError, false);
      const receipt = JSON.parse(result.content.map((part) => part.type === "text" ? part.text : "").join("")) as Record<string, unknown>;
      assert.equal(receipt.status, "done"); assert.equal(receipt.answer, "CHILD_FINAL"); assert.equal(receipt.nonTextOmitted, true);
      assert.doesNotMatch(JSON.stringify(receipt), /HIDDEN_CHILD_REASONING/);
      return fauxAssistantMessage("Parent received final answer");
    };
    faux.setResponses(Array.from({ length: 4 }, () => route));
    const parent = await runtime.admit(String(runtime.main.id), { requestId: "delegate", text: "PARENT_TRANSCRIPT_SECRET", mode: "followUp" });
    assert.equal((await within(parent.wait(context))).status, "done");
    const chats = (await runtime.listChats()).items; assert.equal(chats.length, 2);
    const item = chats.find((chat) => chat.kind === "subagent")!; assert.ok(item);
    assert.equal(item.parentChatId, String(runtime.main.id)); assert.match(item.ownerTaskId!, /^\d+$/);
    assert.equal(item.machineId, "offline-host"); assert.equal(item.cwd, "/saved");
    assert.match(item.agentName!, /^[a-z]+$/); assert.equal(item.agentNameAlgorithm, "wintermute-v1");
    assert.notEqual(item.agentName, chats.find(chat => chat.kind === "main")!.agentName);
    const child = await runtime.chat(item.chatId); const agent = await child.agent(context);
    assert.deepEqual(agent.model, options.model); assert.equal(agent.instructions, "PARENT_INSTRUCTIONS");
    assert.deepEqual(agent.tools.map((tool) => tool.name), ["read", "edit", "bash"]);
    const record = await runtime.harness.commit(async (tx) => (await tx.scanConversations({}, 10)).items.find((chat) => chat.id === child.id), context);
    assert.equal(String(record!.owner!.taskId), item.ownerTaskId); assert.equal(record!.owner!.conversationId, runtime.main.id);
    await assert.rejects(runtime.admit(item.chatId, { requestId: "external", text: "Do not enqueue this", mode: "followUp" }), /owning tool/);
    const inputs = (await runtime.history(item.chatId)).items.filter((entry) => entry.kind === "deck.input");
    assert.equal(inputs.length, 1); assert.equal((inputs[0]!.data as { delegation: boolean }).delegation, true);
    await runtime.configure(String(runtime.main.id), { extensions: original.extensions, tools: null });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("task_list", { query: "Foreground helper" }), { stopReason: "toolUse" }),
      (request) => {
        const result = request.messages.filter((message) => message.role === "toolResult").at(-1)!;
        const page = JSON.parse(result.content.map((part) => part.type === "text" ? part.text : "").join("")) as { items: { kind: string; parentChatId: string; ownerTaskId: string }[] };
        assert.equal(page.items[0]!.kind, "subagent"); assert.equal(page.items[0]!.parentChatId, String(runtime.main.id)); assert.equal(page.items[0]!.ownerTaskId, item.ownerTaskId);
        return fauxAssistantMessage(fauxToolCall("task_message", { chatId: item.chatId, text: "Do not enqueue" }), { stopReason: "toolUse" });
      },
      (request) => { assert.equal(request.messages.filter((message) => message.role === "toolResult").at(-1)!.isError, true); return fauxAssistantMessage("Owned child remained read-only"); },
    ]);
    assert.equal((await (await runtime.admit(String(runtime.main.id), { requestId: "inspect-owned", text: "Inspect helper", mode: "followUp" })).wait(context)).status, "done");
    assert.equal((await runtime.history(item.chatId)).items.filter((entry) => entry.kind === "deck.input").length, 1);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("parent stop aborts the owned child and remains draining until its issued native file effect settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-subagent-stop-")); const entered = gate(); const release = gate(); const aborted = gate();
  const { faux, options } = setup({ call: async (_binding, _id, operation, _args, signal) => {
    assert.equal(operation, "write"); assert.ok(signal);
    if (signal.aborted) aborted.release(); else signal.addEventListener("abort", aborted.release, { once: true });
    entered.release(); await release.promise; return { ok: true, output: "File work drained" };
  } });
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  try {
    const route: FauxResponseFactory = (request) => isChild(request.messages)
      ? fauxAssistantMessage(fauxToolCall("write", { path: "file.txt", content: "issued" }), { stopReason: "toolUse" })
      : fauxAssistantMessage(fauxToolCall("subagent", { task: "CHILD_TASK" }), { stopReason: "toolUse" });
    faux.setResponses(Array.from({ length: 3 }, () => route));
    const parent = await runtime.admit(String(runtime.main.id), { requestId: "stop-child", text: "Start", mode: "followUp" });
    await within(entered.promise);
    const item = (await runtime.listChats()).items.find((chat) => chat.kind === "subagent")!; assert.ok(item);
    let stopped = false; const stopping = runtime.stop(String(runtime.main.id)).then(() => { stopped = true; });
    await within(aborted.promise); assert.equal(stopped, false);
    assert.equal((await runtime.activity(String(runtime.main.id))).busy, true);
    release.release(); await within(stopping);
    assert.equal((await within(parent.wait(context))).status, "unanswered");
    assert.equal((await runtime.activity(item.chatId)).busy, false);
    assert.equal((await runtime.activity(String(runtime.main.id))).busy, false);
  } finally { release.release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("invalid delegation creates no child; model failure returns status without provider error details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-subagent-error-")); const { faux, options } = setup();
  let invalidChecked = false;
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  try {
    const route: FauxResponseFactory = (request) => {
      if (isChild(request.messages)) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE_PROVIDER_SENTINEL" });
      const result = request.messages.filter((message) => message.role === "toolResult").at(-1);
      if (!result) return fauxAssistantMessage(fauxToolCall("subagent", { task: "   " }), { stopReason: "toolUse" });
      if (!invalidChecked) { assert.equal(result.isError, true); invalidChecked = true; return fauxAssistantMessage(fauxToolCall("subagent", { task: "CHILD_TASK" }), { stopReason: "toolUse" }); }
      assert.equal(result.isError, true); const output = result.content.map((part) => part.type === "text" ? part.text : "").join("");
      assert.match(output, /model_error/); assert.doesNotMatch(output, /PRIVATE_PROVIDER_SENTINEL/);
      return fauxAssistantMessage("Child failed; not claiming success");
    };
    faux.setResponses(Array.from({ length: 4 }, () => route));
    assert.equal((await within((await runtime.admit(String(runtime.main.id), { requestId: "failure", text: "Start", mode: "followUp" })).wait(context))).status, "done");
    assert.equal((await runtime.listChats()).items.length, 2); assert.equal(invalidChecked, true);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("delegation answer keeps bounded text only, marking clipping and non-text omission", () => {
  const value = delegationAnswer({ model: [fauxAssistantMessage([fauxThinking("HIDDEN"), { type: "text", text: "a".repeat(9000) }, { type: "text", text: "TAIL" }])] });
  assert.equal(value.answer.length, 8192); assert.equal(value.answerClipped, true); assert.equal(value.nonTextOmitted, true);
  assert.doesNotMatch(JSON.stringify(value), /HIDDEN|TAIL/); assert.ok(Buffer.byteLength(JSON.stringify(value)) < 64 * 1024);
});
