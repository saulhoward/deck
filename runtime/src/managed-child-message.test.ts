import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { type DeckRuntime, type Input } from "./deck.js";
import { ChatDoc } from "./chat-doc.js";
import { namedChildren } from "./subagent-view.test.support.js";
import { gate, within } from "./instructions.test.support.js";
import { setup } from "./managed-child.test.support.js";
const text = (message: any): string => typeof message.content === "string" ? message.content : message.content.map((p: any) => p.type === "text" ? p.text : "").join("");
const inputs = async (runtime: DeckRuntime, id: string) => (await runtime.history(id, { limit: 100 })).items.filter(e => e.kind === "deck.input").map(e => e.data as Input);

for (const main of [false, true]) test(`parent_message reports only to the inferred ${main ? "main" : "task"} parent with durable correlation, not an automatic answer/ACK relay`, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-message-")); const f = setup(); const runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const parent = main ? runtime.main : await runtime.createTask("Parent", f.options.binding), parentId = String(parent.id);
    const child = await runtime.createManagedChild(parentId, "Helper", "helper"), id = String(child.id);
    const route: FauxResponseFactory = request => {
      const user = text(request.messages.filter(m => m.role === "user").at(-1));
      const result = request.messages.at(-1)!;
      if (user.endsWith("\nREPORT")) return fauxAssistantMessage("Report received; do not echo admission ACK");
      if (result.role === "toolResult") {
        assert.equal(result.isError, false, text(result)); const receipt = JSON.parse(text(result));
        assert.equal(receipt.admitted, true); assert.equal(receipt.completion, "not_waited");
        assert.match(receipt.requestId, /^deck-tool:\d+:message$/);
        if (result.toolName === "parent_message") { assert.equal(receipt.chatId, parentId); assert.equal(receipt.mode, "followUp"); }
        return fauxAssistantMessage("Explicit send admitted");
      }
      return fauxAssistantMessage(user.endsWith("\nWORK") ? fauxToolCall("parent_message", { text: "REPORT" }) : fauxToolCall("task_message", { chatId: id, text: "WORK", mode: "steer" }), { stopReason: "toolUse" });
    };
    f.faux.setResponses(Array.from({ length: 12 }, () => route));
    await (await runtime.admit(parentId, { requestId: "human", text: "START", mode: "followUp" })).wait(context);
    await child.waitForIdle(context); await parent.waitForIdle(context);
    const sent = (await inputs(runtime, id))[0]!, report = (await inputs(runtime, parentId)).find(i => i.text === "REPORT")!;
    assert.equal(sent.mode, "steer"); assert.equal(sent.origin?.chain?.hop, 1);
    assert.equal(report.mode, "followUp"); assert.equal(report.origin?.chatId, id);
    assert.deepEqual(report.origin?.chain, { rootChatId: parentId, rootRequestId: "human", hop: 2, replyToChatId: id, replyToRequestId: sent.requestId });
    await runtime.admit(parentId, report); // Exact receipt retrieval is not a new input.
    assert.equal((await inputs(runtime, parentId)).length, 2); assert.equal((await inputs(runtime, id)).length, 1);
    if (!main) assert.equal((await inputs(runtime, String(runtime.main.id))).length, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("generic task/hub messaging cannot bypass parent-only relationships; runtime admission rejects cross-parent/owned/unmanaged agent origins too", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-isolation-")); const f = setup(); const runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const parent = await runtime.createTask("Parent", f.options.binding), other = await runtime.createTask("Other", f.options.binding);
    const parentId = String(parent.id), otherId = String(other.id), mainId = String(runtime.main.id);
    const child = await runtime.createManagedChild(parentId, "Helper", "helper"), sibling = await runtime.createManagedChild(parentId, "Sibling", "sibling"), outsider = await runtime.createManagedChild(otherId, "Outsider", "outsider");
    const childId = String(child.id), siblingId = String(sibling.id), outsiderId = String(outsider.id);
    const calls = [{ name: "hub_message", args: { text: "forbidden hub" } }, ...[otherId, siblingId, outsiderId].map(chatId => ({ name: "task_message", args: { chatId, text: "forbidden task" } }))];
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall(calls[0]!.name, calls[0]!.args), { stopReason: "toolUse" }), ...calls.map((_, index): FauxResponseFactory => request => {
      const result = request.messages.at(-1)!; assert.equal(result.role, "toolResult"); assert.equal((result as any).isError, true, text(result)); assert.match(text(result), /only with their parent/);
      const next = calls[index + 1]; return next ? fauxAssistantMessage(fauxToolCall(next.name, next.args), { stopReason: "toolUse" }) : fauxAssistantMessage("Isolation respected");
    })]);
    assert.equal((await (await runtime.admit(childId, { requestId: "human-child", text: "try forbidden", mode: "followUp" })).wait(context)).status, "done");
    for (const id of [parentId, mainId, otherId, siblingId, outsiderId]) assert.equal((await inputs(runtime, id)).length, 0);
    const raw = (source: string, requestId: string): Input => ({ requestId, text: "agent input", mode: "followUp", origin: { kind: "task-tool", chatId: source, taskId: "100", chain: { rootChatId: source, rootRequestId: "human", hop: 1, replyToChatId: source, replyToRequestId: "human" } } });
    for (const [source, target] of [[otherId, childId], [mainId, childId], [childId, mainId], [childId, otherId], [childId, siblingId], [childId, outsiderId], [parentId, outsiderId]]) await assert.rejects(runtime.admit(target!, raw(source!, `${source}-${target}`)), /only with their parent/);
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context), unmanagedId = String(unmanaged.id);
    const owned = (await namedChildren(runtime, parentId))[0]!, ownedChat = await runtime.chat(owned.chatId);
    await ownedChat.commit(async tx => { (await tx.doc(ChatDoc, ownedChat.id)).kind = "task"; }, context);
    for (const source of [unmanagedId, owned.chatId, "999999999"]) await assert.rejects(runtime.admit(parentId, raw(source, `source-${source}`)), /independent Deck/);
    for (const target of [unmanagedId, owned.chatId]) await assert.rejects(runtime.admit(target, raw(parentId, `target-${target}`)));
    await assert.rejects(runtime.admit(owned.chatId, { requestId: "human-owned", text: "not permitted", mode: "followUp" }), /owning tool/);
    assert.equal(await runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
    // Normal independent-to-independent messages retain their existing behavior.
    f.faux.setResponses([fauxAssistantMessage("ordinary message accepted")]);
    assert.equal((await (await runtime.admit(otherId, raw(parentId, "ordinary"))).wait(context)).status, "done");
    // Ordinary tasks have no inferred parent, even though they inherit the tool.
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("parent_message", { text: "no inferred parent" }), { stopReason: "toolUse" }), request => {
      assert.match(text(request.messages.at(-1)), /requires a managed child/); return fauxAssistantMessage("No parent");
    }]);
    await (await runtime.admit(otherId, { requestId: "ordinary-human", text: "report", mode: "followUp" })).wait(context);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("agent relation is validated at serialized runtime admission, not just in a tool or at ingress", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-serial-")); const entered = gate(), release = gate();
  const f = setup({ admissionGuard: async () => { entered.release(); await release.promise; } }); const runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const parent = await runtime.createTask("Parent", f.options.binding), other = await runtime.createTask("Other", f.options.binding);
    const child = await runtime.createManagedChild(String(parent.id), "Helper", "helper");
    f.faux.setResponses([fauxAssistantMessage("done")]);
    const blocking = runtime.admit(String(runtime.main.id), { requestId: "blocking", text: "block", mode: "followUp" }); await entered.promise;
    const pending = runtime.admit(String(child.id), { requestId: "queued", text: "must reject", mode: "followUp", origin: { kind: "task-tool", chatId: String(parent.id), taskId: "100" } });
    await child.commit(async tx => { (await tx.doc(ChatDoc, child.id)).managedParentChatId = String(other.id); }, context);
    const rejected = assert.rejects(pending, /only with their parent/); release.release(); await blocking; await rejected;
    assert.equal((await inputs(runtime, String(child.id))).length, 0);
  } finally { release.release(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("parent_message shares the eight-hop causal budget, cannot reset it by another tool call, and resets only on human input", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-hops-")); const f = setup(); const runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const parent = await runtime.createTask("Parent", f.options.binding), parentId = String(parent.id);
    const child = await runtime.createManagedChild(parentId, "Loop", "loop"), childId = String(child.id);
    const route: FauxResponseFactory = request => {
      const last = request.messages.at(-1)!;
      if (last.role === "toolResult") return fauxAssistantMessage(last.isError ? "Budget blocked" : "Sent once");
      const user = text(request.messages.filter(m => m.role === "user").at(-1));
      return fauxAssistantMessage(user.endsWith("\nTO_CHILD") || user === "START" ? fauxToolCall("parent_message", { text: "TO_PARENT" }) : fauxToolCall("task_message", { chatId: childId, text: "TO_CHILD" }), { stopReason: "toolUse" });
    };
    f.faux.setResponses(Array.from({ length: 60 }, () => route));
    await runtime.admit(childId, { requestId: "human-loop", text: "START", mode: "followUp" });
    await within((async () => {
      for (;;) {
        const all = [...await inputs(runtime, parentId), ...await inputs(runtime, childId)];
        if (all.length === 9 && !(await runtime.activity(parentId)).busy && !(await runtime.activity(childId)).busy) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })());
    const all = [...await inputs(runtime, parentId), ...await inputs(runtime, childId)];
    assert.deepEqual(all.filter(i => i.origin).map(i => i.origin!.chain!.hop).sort((a, b) => a - b), [1,2,3,4,5,6,7,8]);
    const errors = (await runtime.history(childId, { limit: 100 })).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult" && m.isError);
    assert.ok(errors.some(m => text(m).includes("hop limit")));
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("parent_message", { text: "RESET_REPORT" }), { stopReason: "toolUse" }), fauxAssistantMessage("Human reset"), fauxAssistantMessage("Received")]);
    await (await runtime.admit(childId, { requestId: "fresh-human", text: "Human reset", mode: "followUp" })).wait(context); await parent.waitForIdle(context);
    const reset = (await inputs(runtime, parentId)).find(i => i.text === "RESET_REPORT")!;
    assert.equal(reset.origin?.chain?.hop, 1); assert.equal(reset.origin?.chain?.rootRequestId, "fresh-human");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("managed child retains foreground delegation; captured descendant still filters the entire control extension and uses Pi ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-captured-")); const f = setup(); const runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const managed = await runtime.createManagedChild(String(runtime.main.id), "Managed", "managed"), id = String(managed.id);
    const route: FauxResponseFactory = request => {
      if (request.messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Foreground delegation"))) return fauxAssistantMessage("Captured answer");
      const last = request.messages.at(-1)!;
      if (last.role === "toolResult") { assert.equal(last.isError, false, text(last)); assert.equal(JSON.parse(text(last)).answer, "Captured answer"); return fauxAssistantMessage("Done"); }
      return fauxAssistantMessage(fauxToolCall("subagent", { task: "Captured task" }), { stopReason: "toolUse" });
    };
    f.faux.setResponses(Array.from({ length: 4 }, () => route));
    assert.equal((await (await runtime.admit(id, { requestId: "delegate", text: "Delegate", mode: "followUp" })).wait(context)).status, "done");
    const row = (await runtime.listChats()).items.find(item => item.kind === "subagent")!, captured = await runtime.chat(row.chatId);
    assert.equal(row.parentChatId, id); assert.equal(row.managedParentChatId, undefined); assert.ok(row.ownerTaskId);
    assert.equal((await runtime.harness.commit(tx => tx.conversation(captured.id), context))!.owner!.conversationId, managed.id);
    const agent = await captured.agent(context);
    assert.ok(!agent.extensions.some(e => e.name === "deck.task-control"));
    for (const name of ["parent_message", "task_message", "hub_message", "task_create", "subagent"]) assert.ok(!agent.tools.some(t => t.name === name));
    await assert.rejects(runtime.admit(row.chatId, { requestId: "external", text: "no", mode: "followUp" }), /owning tool/);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("nested managed hierarchy permits only direct up/down edges, never siblings, grandparents or unrelated agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-edges-")); const f = setup(); const runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const parent = await runtime.createTask("Parent", f.options.binding), parentId = String(parent.id);
    const child = await runtime.createManagedChild(parentId, "Child", randomUUID()), childId = String(child.id);
    const nested = await runtime.createManagedChild(childId, "Nested", randomUUID()), nestedId = String(nested.id);
    const sibling = await runtime.createManagedChild(childId, "Nested sibling", randomUUID()), siblingId = String(sibling.id);
    const other = await runtime.createTask("Other", f.options.binding), otherId = String(other.id);
    const input = (source: string): Input => ({ requestId: randomUUID(), text: "edge message", mode: "followUp", origin: { kind: "task-tool", chatId: source, taskId: "100" } });
    for (const [source, target] of [[parentId, childId], [childId, parentId], [childId, nestedId], [nestedId, childId]]) {
      f.faux.setResponses([fauxAssistantMessage("Accepted direct edge")]);
      await (await runtime.admit(target!, input(source!))).wait(context);
    }
    for (const [source, target] of [[parentId, nestedId], [nestedId, parentId], [nestedId, siblingId], [siblingId, nestedId], [otherId, nestedId], [nestedId, otherId]]) await assert.rejects(runtime.admit(target!, input(source!)), /direct managed children/);
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("parent_message", { text: "Nested report" }), { stopReason: "toolUse" }), fauxAssistantMessage("Report"), fauxAssistantMessage("Done")]);
    await (await runtime.admit(nestedId, { requestId: randomUUID(), text: "Report upward", mode: "followUp" })).wait(context); await child.waitForIdle(context);
    assert.ok((await inputs(runtime, childId)).some(i => i.text === "Nested report"));
    assert.ok(!(await inputs(runtime, parentId)).some(i => i.text === "Nested report"));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
