import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { inspectionEntry } from "./task-tools.js";

function lastResult(request: { messages: readonly unknown[] }): { isError?: boolean; content: { type: string; text?: string }[] } {
  const messages = request.messages as { role: string; isError?: boolean; content: { type: string; text?: string }[] }[];
  return messages.filter((message) => message.role === "toolResult").at(-1)!;
}
function data(request: { messages: readonly unknown[] }): Record<string, unknown> {
  const message = lastResult(request); assert.equal(message.isError, false);
  return JSON.parse(message.content.map((part) => part.text ?? "").join("")) as Record<string, unknown>;
}

test("model task inspection pages canonical chats, reads offline history/activity and never issues effects or creates work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-task-tools-"));
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel(); let effects = 0;
  const options = { models, model: { provider: model.provider, modelId: model.id }, binding: { machineId: "host", cwd: directory }, environment: () => undefined, hostFiles: { call: async () => { effects++; throw new Error("Inspection must not issue an effect"); } } };
  let runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  try {
    let task = await runtime.createTask("Parser work", { machineId: "offline", cwd: "/saved" });
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await task.commit(async (tx) => {
      for (let i = 0; i < 7; i++) await tx.appendEntry(task.id, { kind: "deck.input", data: { text: `retained-${i}`, capture: "CAPTURE_MUST_NOT_LEAK" } });
    }, context);
    // Reopen before calling: the extension must bind to the new runtime, not a stale closure.
    await runtime.close(); runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
    task = await runtime.chat(String(task.id));
    let before: string | undefined;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("task_list", { query: "parser", limit: 1 }), { stopReason: "toolUse" }),
      (request) => {
        const page = data(request); assert.deepEqual(page.items, []); assert.equal(page.next, String(runtime.main.id));
        return fauxAssistantMessage(fauxToolCall("task_list", { query: "PARSER", limit: 1, after: page.next }), { stopReason: "toolUse" });
      },
      (request) => {
        const page = data(request); const items = page.items as { chatId: string; machineId: { text: string } }[];
        assert.equal(items[0]!.chatId, String(task.id)); assert.equal(items[0]!.machineId.text, "offline");
        return fauxAssistantMessage(fauxToolCall("task_history", { chatId: String(task.id), limit: 3 }), { stopReason: "toolUse" });
      },
      (request) => {
        const page = data(request); assert.equal(page.order, "descending");
        assert.deepEqual((page.items as { text: string }[]).map((entry) => entry.text), ["retained-6", "retained-5", "retained-4"]);
        assert.doesNotMatch(JSON.stringify(page), /CAPTURE_MUST_NOT_LEAK/); before = String(page.next);
        return fauxAssistantMessage(fauxToolCall("task_history", { chatId: String(task.id), limit: 3, before }), { stopReason: "toolUse" });
      },
      (request) => {
        const page = data(request); const items = page.items as { id: string; text: string }[];
        assert.ok(Number(items[0]!.id) < Number(before));
        assert.deepEqual(items.map((entry) => entry.text), ["retained-3", "retained-2", "retained-1"]);
        return fauxAssistantMessage(fauxToolCall("task_activity", { chatId: String(task.id) }), { stopReason: "toolUse" });
      },
      (request) => {
        const activity = data(request); assert.equal(activity.busy, false); assert.equal(activity.queued, 0);
        return fauxAssistantMessage("Inspected existing task");
      },
    ]);
    const submission = await runtime.admit(String(runtime.main.id), { requestId: "inspect", text: "Inspect Parser work", mode: "followUp" });
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(faux.state.callCount, 6); assert.equal(effects, 0);
    assert.equal((await runtime.listChats()).items.length, 2);
    assert.equal((await runtime.history(String(task.id))).items.length, 7);
    assert.equal(await runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
    // Explicit unmanaged IDs and malformed IDs produce tool errors, not new metadata/work.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("task_history", { chatId: String(unmanaged.id) }), { stopReason: "toolUse" }),
      (request) => { assert.equal(lastResult(request).isError, true); return fauxAssistantMessage(fauxToolCall("task_activity", { chatId: "oops" }), { stopReason: "toolUse" }); },
      (request) => { assert.equal(lastResult(request).isError, true); return fauxAssistantMessage("Errors handled"); },
    ]);
    await (await runtime.admit(String(runtime.main.id), { requestId: "invalid", text: "Invalid reads", mode: "followUp" })).wait(context);
    assert.equal(effects, 0); assert.equal(await runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
    await task.commit(async (tx) => {
      for (let i = 0; i < 20; i++) await tx.appendEntry(task.id, { kind: "deck.input", data: { text: "\u0001".repeat(3000) } });
    }, context);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("task_history", { chatId: String(task.id), limit: 20 }), { stopReason: "toolUse" }),
      (request) => {
        const message = lastResult(request); assert.equal(message.isError, true);
        assert.match(JSON.stringify(message.content), /smaller limit/);
        return fauxAssistantMessage(fauxToolCall("task_history", { chatId: String(task.id), limit: 1 }), { stopReason: "toolUse" });
      },
      (request) => {
        const page = data(request); assert.equal((page.items as { textClipped: boolean }[])[0]!.textClipped, true);
        assert.equal(typeof page.next, "string"); return fauxAssistantMessage("Reduced page safely");
      },
    ]);
    await (await runtime.admit(String(runtime.main.id), { requestId: "budget", text: "Read bounded page", mode: "followUp" })).wait(context);
    assert.equal((await runtime.history(String(task.id))).items.length, 27); assert.equal(effects, 0);
    const large = await runtime.createTask("X".repeat(2000), { machineId: "z".repeat(500), cwd: "/" + "y".repeat(2000) });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("task_list", { query: "XXX", after: String(task.id) }), { stopReason: "toolUse" }),
      (request) => {
        const item = (data(request).items as { chatId: string; title: { text: string; clipped: boolean }; machineId: { text: string }; cwd: { text: string } }[])[0]!;
        assert.equal(item.chatId, String(large.id)); assert.equal(item.title.clipped, true);
        assert.equal(item.title.text.length, 160); assert.equal(item.machineId.text.length, 80); assert.equal(item.cwd.text.length, 256);
        return fauxAssistantMessage("Clipping is explicit");
      },
    ]);
    await (await runtime.admit(String(runtime.main.id), { requestId: "display", text: "Inspect metadata", mode: "followUp" })).wait(context);
    assert.equal(effects, 0);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("history inspection bounds text/names and omits arguments, hidden reasoning, system/custom data and provider errors", () => {
  const entry = { id: 1, kind: "pi.assistant", model: [fauxAssistantMessage([
    fauxThinking("HIDDEN_REASONING"),
    ...Array.from({ length: 20 }, (_, i) => fauxToolCall(`tool-${i}`, { secret: "ARGUMENT_SECRET" })),
    { type: "text" as const, text: "x".repeat(10_000) + "TAIL" },
  ], { errorMessage: "PROVIDER_SECRET", stopReason: "error" })] };
  const projected = inspectionEntry(entry); assert.ok("text" in projected);
  assert.equal(projected.text?.length, 1024); assert.ok(projected.text?.endsWith("TAIL")); assert.equal(projected.textClipped, true);
  assert.equal(projected.toolNames?.length, 16); assert.equal(projected.omittedToolNames, 4);
  assert.doesNotMatch(JSON.stringify(projected), /HIDDEN_REASONING|ARGUMENT_SECRET|PROVIDER_SECRET/);
  const sent = inspectionEntry({ id: 4, kind: "deck.input", data: { text: "Agent note", origin: { kind: "task-tool", chatId: "9", taskId: "10" }, capture: "HIDDEN" } });
  assert.ok("text" in sent); assert.deepEqual(sent.source, { kind: "task-tool", chatId: "9" }); assert.doesNotMatch(JSON.stringify(sent), /HIDDEN/);
  const tool = inspectionEntry({ id: 3, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "q".repeat(4000) + "END" }], details: { private: "OMIT_DETAILS" } }] });
  assert.ok("text" in tool); assert.equal(tool.isError, true); assert.ok(tool.text.endsWith("END")); assert.equal(tool.textClipped, true);
  assert.doesNotMatch(JSON.stringify(tool), /OMIT_DETAILS/);
  for (const kind of ["pi.system", "custom.private"]) assert.deepEqual(inspectionEntry({ id: 2, kind, data: { secret: "PRIVATE" }, model: [{ role: "user", content: "PRIVATE" }] }), { id: "2", kind, omitted: true });
});
