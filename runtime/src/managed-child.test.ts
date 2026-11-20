import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, defineExtension, defineTool, type Agent } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChatDoc } from "./chat-doc.js";
import { managedAgentSnapshot, ManagedChildRequest } from "./managed-child.js";
import { briefInstructions } from "./task-brief.js";
import { profileGrant, toolAlias } from "./mcp-tools.js";
import { counterTool, hash } from "./mcp.test.support.js";
import { namedChildren } from "./subagent-view.test.support.js";
import { gate, within } from "./instructions.test.support.js";
import { groupedTasks } from "./task-groups.js";
import { setup } from "./managed-child.test.support.js";
import type { McpProfile } from "./generated/contracts.js";

test("managed children atomically create ownerless idle task snapshots, deduplicate across restart and keep settings independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-")); const f = setup(); const path = join(root, "pi.sqlite");
  let runtime = await f.open(path);
  try {
    const parent = await runtime.createTask("Parent", { machineId: "offline", cwd: "/parent exact 🧪" }); const parentId = String(parent.id);
    await runtime.configure(parentId, { model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "high", instructions: "PERSONAL_PARENT_INSTRUCTIONS" });
    await parent.commit(async tx => { const metadata = await tx.doc(ChatDoc, parent.id); metadata.userAgentsMdHash = "b".repeat(64); metadata.loadedSkills = [{ name: "private", scope: "local" }]; }, context);
    f.faux.setResponses([fauxAssistantMessage("parent transcript")]);
    await (await runtime.admit(parentId, { requestId: "parent-input", text: "SECRET_TRANSCRIPT", mode: "followUp" })).wait(context);
    const calls = f.faux.state.callCount;
    const brief = { problem: "own problem", description: "own description" }, title = "Own child";
    const children = await Promise.all(Array.from({ length: 3 }, () => runtime.createManagedChild(parentId, title, "same", brief)));
    const child = children[0]!, id = String(child.id); assert.ok(children.every(c => c.id === child.id));
    const metadata = (await runtime.harness.snapshot(ChatDoc, child.id, context))!;
    assert.equal(metadata.kind, "task"); assert.equal(metadata.managedParentChatId, parentId);
    assert.equal(metadata.parentChatId, undefined); assert.equal(metadata.ownerTaskId, undefined);
    assert.equal(metadata.machineId, "offline"); assert.equal(metadata.cwd, "/parent exact 🧪");
    assert.equal(metadata.userAgentsMdHash, undefined); assert.equal(metadata.loadedSkills, undefined);
    assert.equal(metadata.agentNameAlgorithm, "wintermute-v1"); assert.ok(metadata.agentRune); assert.notEqual(metadata.agentRune, "Δ");
    assert.equal((await runtime.harness.commit(tx => tx.conversation(child.id), context))!.owner, undefined);
    assert.equal((await runtime.history(id)).items.length, 0); assert.equal((await runtime.activity(id)).busy, false);
    assert.equal((await runtime.terminalStatus(id)).status, "unallocated"); assert.equal(f.faux.state.callCount, calls);
    const snapshot = await child.agent(context), original = await parent.agent(context);
    assert.deepEqual(snapshot.model, original.model); assert.equal(snapshot.thinkingLevel, "high");
    assert.deepEqual(snapshot.tools.map(t => t.name), original.tools.map(t => t.name));
    assert.ok(snapshot.tools.some(t => t.name === "subagent")); assert.ok(snapshot.tools.some(t => t.name === "parent_message"));
    assert.equal(snapshot.instructions, briefInstructions(title, brief)); assert.doesNotMatch(snapshot.instructions!, /PERSONAL|SECRET/);
    assert.deepEqual(metadata.brief, brief);
    const listed = (await runtime.listChats()).items.find(item => item.chatId === id)!;
    assert.equal(listed.managedParentChatId, parentId); assert.equal(listed.parentChatId, undefined);
    assert.deepEqual(groupedTasks([{ chatId: "8" }, { chatId: "9", managedParentChatId: "2" }, { chatId: "2" }]).map(c => c.chatId), ["2", "9", "8"]);
    const mainChild = await runtime.createManagedChild(String(runtime.main.id), "Main helper", "main-child");
    assert.equal((await runtime.harness.snapshot(ChatDoc, mainChild.id, context))!.managedParentChatId, String(runtime.main.id));
    for (const args of [[parentId, "Changed", brief], [String(runtime.main.id), title, brief], [parentId, title, { problem: "changed" }]] as const) await assert.rejects(runtime.createManagedChild(args[0], args[1], "same", args[2]), { code: "conflict" });
    // The ordinary create namespace may reuse the exact request ID.
    assert.notEqual((await runtime.createTask(title, f.options.binding, "same")).id, child.id);
    await runtime.configure(parentId, { model: f.options.model, thinkingLevel: "off", tools: [] });
    const selection = (await runtime.modelSettings(id)).selection;
    await runtime.setModelSettings({ chatId: id, expected: selection, selection: { ...selection, thinkingLevel: "low" } });
    assert.equal((await parent.agent(context)).thinkingLevel, "off"); assert.equal((await child.agent(context)).thinkingLevel, "low");
    assert.deepEqual((await child.agent(context)).tools.map(t => t.name), snapshot.tools.map(t => t.name));
    assert.equal((await runtime.createManagedChild(parentId, title, "same", brief)).id, child.id);
    await runtime.close(); runtime = await f.open(path);
    assert.equal((await runtime.createManagedChild(parentId, title, "same", brief)).id, child.id);
    assert.equal((await runtime.harness.snapshot(ChatDoc, child.id, context))!.agentName, metadata.agentName);
    assert.equal((await (await runtime.chat(id)).agent(context)).thinkingLevel, "low");
    assert.equal((await runtime.history(id)).items.length, 0);
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("task_list", { query: title }), { stopReason: "toolUse" }), request => {
      const result = request.messages.filter(m => m.role === "toolResult").at(-1)!;
      const items = JSON.parse(result.content.map(p => p.type === "text" ? p.text : "").join("")).items;
      const row = items.find((item: { chatId: string }) => item.chatId === id);
      assert.equal(row.managedParentChatId, parentId); assert.equal(row.ownerTaskId, undefined); return fauxAssistantMessage("inspected");
    }]);
    await (await runtime.admit(String(runtime.main.id), { requestId: "inspect", text: "inspect", mode: "followUp" })).wait(context);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("managed inheritance freezes explicit enabled and offered restrictions plus MCP grants without widening them", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-tools-"));
  const profile: McpProfile = { id: "counter", machineId: "a".repeat(32), revision: hash("managed"), workspace: "task", tools: [counterTool] };
  const effects: { binding: unknown; plan: any }[] = [];
  const f = setup({ mcpCatalog: { version: 1, profiles: [profile] }, hostFiles: { call: async (binding, operationId, operation, args) => {
    assert.equal(operation, "mcp_call"); effects.push({ binding, plan: JSON.parse(args.plan!) });
    return { ok: true, code: "mcp_result", output: JSON.stringify({ jsonrpc: "2.0", id: `call:${operationId}`, result: { content: [{ type: "text", text: "approved snapshot effect" }], structuredContent: { count: 1 } } }) };
  } } }); const runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const parentId = String(runtime.main.id);
    await runtime.setToolProfiles({ chatId: parentId, expectedRevision: 0, profiles: [profileGrant(profile)] });
    const full = await runtime.main.agent(context), alias = toolAlias(profile, counterTool.name);
    await runtime.configure(parentId, { tools: full.tools.filter(t => ["read", "task_message", "parent_message", "subagent", alias].includes(t.name)), modelTools: full.tools.filter(t => ["read", "subagent", alias].includes(t.name)) });
    const parent = await runtime.main.agent(context), child = await runtime.createManagedChild(parentId, "Restricted", "restricted");
    const inherited = await child.agent(context);
    assert.deepEqual(inherited.tools.map(t => t.name), parent.tools.map(t => t.name));
    assert.deepEqual(inherited.callable.map(t => t.name), parent.callable.map(t => t.name));
    assert.deepEqual(inherited.deferred.map(t => t.name), parent.deferred.map(t => t.name));
    assert.deepEqual((await runtime.harness.snapshot(AgentDoc, child.id, context))!.tools, ["read", "task_message", "parent_message", "subagent", alias]);
    assert.deepEqual((await runtime.toolProfiles(String(child.id))).profiles, [profileGrant(profile)]);
    await runtime.setToolProfiles({ chatId: parentId, expectedRevision: 1, profiles: [] });
    assert.deepEqual((await runtime.toolProfiles(String(child.id))).profiles, [profileGrant(profile)]);
    assert.ok((await child.agent(context)).tools.some(t => t.name === alias));
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall(alias, { mode: "normal" }), { stopReason: "toolUse" }), request => {
      assert.equal((request.messages.at(-1)! as { isError: boolean }).isError, false); return fauxAssistantMessage("Approved child effect complete");
    }]);
    assert.equal((await (await runtime.admit(String(child.id), { requestId: "mcp-child", text: "Use approved snapshot", mode: "followUp" })).wait(context)).status, "done");
    assert.equal(effects.length, 1); assert.deepEqual(effects[0]!.binding, f.options.binding);
    assert.equal(effects[0]!.plan.conversationId, String(child.id)); assert.equal(effects[0]!.plan.grantRevision, 1);
    await runtime.setToolProfiles({ chatId: String(child.id), expectedRevision: 1, profiles: [] });
    assert.equal((await runtime.toolProfiles(String(child.id))).revision, 2);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("snapshot preserves callable-only, deferred and hidden enabled model-only tools, including remove filters", () => {
  const tool = (name: string, callers: ("model" | "tools")[], deferred = false) => defineTool({ name, callers, ...(deferred ? { deferred: true } : {}), replay: "safe", description: name, parameters: Type.Object({}), execute: async () => ({ output: [] }) });
  const offered = tool("offered", ["model"]), nested = tool("nested", ["tools"]), deferred = tool("deferred", ["model"], true), hidden = tool("hidden", ["model"]), disabled = tool("disabled", ["model", "tools"]);
  const extension = defineExtension({ name: "test", tools: [offered, nested, deferred, hidden, disabled] });
  const agent: Agent = { extensions: [extension], thinkingLevel: "off", tools: [offered], callable: [nested], deferred: [deferred], sections: [] };
  for (const tools of [["nested", "hidden", "deferred", "offered"], { remove: ["disabled"] }]) {
    const snapshot = managedAgentSnapshot(agent, { tools }, "child", {}, "/saved");
    assert.deepEqual(new Set(snapshot.tools as string[]), new Set(["offered", "nested", "deferred", "hidden"]));
    assert.deepEqual(snapshot.modelTools, ["offered"]);
  }
});

test("creation rejects leaf/owned/unmanaged/forged-main parents, paused workers and cancelled admission without partial receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-invalid-")); const f = setup(); const runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const mainId = String(runtime.main.id), child = await runtime.createManagedChild(mainId, "Leaf", "leaf");
    const captured = (await namedChildren(runtime, mainId))[0]!;
    // Even forged metadata cannot override canonical Pi ownership.
    await (await runtime.chat(captured.chatId)).commit(async tx => { (await tx.doc(ChatDoc, Number(captured.chatId) as typeof child.id)).kind = "task"; }, context);
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const forgedMain = await runtime.createTask("Forged main", f.options.binding);
    await forgedMain.commit(async tx => { (await tx.doc(ChatDoc, forgedMain.id)).kind = "main"; }, context);
    for (const parent of [String(child.id), captured.chatId, String(unmanaged.id), String(forgedMain.id)]) await assert.rejects(runtime.createManagedChild(parent, "Rejected", `invalid-${parent}`), { code: "invalid" });
    assert.equal(await runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
    await runtime.pauseWorker(f.options.binding.machineId, "maintenance");
    await assert.rejects(runtime.createManagedChild(mainId, "Paused", "paused"), { code: "busy" });
    await runtime.resumeWorker(f.options.binding.machineId, "maintenance");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runtime.createManagedChild(mainId, "Cancelled", "cancelled", {}, controller.signal), { name: "AbortError" });
    for (const key of ["paused", "cancelled"]) assert.equal(await runtime.harness.snapshot(ManagedChildRequest, key, context), undefined);
    const count = (await runtime.listChats()).items.length;
    const commit = runtime.harness.commit.bind(runtime.harness);
    runtime.harness.commit = (fn, ctx) => commit(tx => fn(new Proxy(tx, { get(target, property) {
      if (property === "createConversation") return async (...args: Parameters<typeof tx.createConversation>) => { await tx.createConversation(...args); throw new Error("Injected creation failure"); };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } })), ctx);
    try { await assert.rejects(runtime.createManagedChild(mainId, "Rollback", "rollback"), /Injected/); } finally { runtime.harness.commit = commit; }
    assert.equal((await runtime.listChats()).items.length, count); assert.equal(await runtime.harness.snapshot(ManagedChildRequest, "rollback", context), undefined);
    assert.ok(await runtime.createManagedChild(mainId, "Rollback", "rollback"));
    assert.equal(f.faux.state.callCount, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("human input starts managed child work; stopping its parent does not cancel it or its native effect", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-stop-")); const entered = gate(), release = gate(); let aborted = false;
  const f = setup({ hostFiles: { call: async (_binding, _id, operation, _args, signal) => {
    assert.equal(operation, "write"); signal?.addEventListener("abort", () => { aborted = true; }); entered.release(); await release.promise; return { ok: true, output: "finished" };
  } } }); const runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const child = await runtime.createManagedChild(String(runtime.main.id), "Working", "working");
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "test", content: "work" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const submission = await runtime.admit(String(child.id), { requestId: "human", text: "Human input accepted", mode: "followUp" });
    await within(entered.promise); await within(runtime.stop(String(runtime.main.id)));
    assert.equal(aborted, false); assert.equal((await runtime.activity(String(child.id))).busy, true);
    release.release(); assert.equal((await within(submission.wait(context))).status, "done");
  } finally { release.release(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
