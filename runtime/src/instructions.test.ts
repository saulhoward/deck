import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, MemoryStorage, section, type HookApi } from "@earendil-works/pi-durable";
import { DeckRuntime } from "./deck.js";
import { CHANGED, gate, IMPLEMENTATION, model, ORIGINAL, provider, within } from "./instructions.test.support.js";

const input = (requestId: string, mode: "followUp" | "steer" = "followUp") => ({ requestId, text: requestId, mode });
function promptIs(messages: Parameters<typeof getCurrentSystemPrompt>[0], present: string, absent: string) {
  const prompt = getCurrentSystemPrompt(messages);
  assert.ok(prompt.includes(present), `Expected instruction ${present}`);
  assert.ok(!prompt.includes(absent), `Unexpected instruction ${absent}`);
}

test("stored instructions govern queued input, steering and post-tool requests despite workspace changes; idle update takes effect", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-instructions-")); const projectPath = join(directory, "AGENTS.md");
  const entered = gate(); const release = gate(); const { faux, models } = provider(); let reads = 0;
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), {
    models, model, implementation: IMPLEMENTATION, binding: { machineId: "saved-worker", cwd: directory },
    environment: () => { throw new Error("No hub-local environment fallback"); },
    hostFiles: { call: async (binding, _id, operation, args) => {
      reads++; assert.deepEqual(binding, { machineId: "saved-worker", cwd: directory });
      assert.equal(operation, "read"); assert.deepEqual(args, { path: "AGENTS.md" });
      entered.release(); await release.promise;
      return { ok: true, output: await readFile(projectPath, "utf8") };
    } },
  });
  try {
    await writeFile(projectPath, ORIGINAL);
    // Seed explicit Pi instructions, not a production file-loading feature.
    await runtime.configure(String(runtime.main.id), { instructions: ORIGINAL });
    const prompts: string[] = [];
    faux.setResponses([
      (request) => { prompts.push(getCurrentSystemPrompt(request.messages)); promptIs(request.messages, ORIGINAL, CHANGED); return fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md" }), { stopReason: "toolUse" }); },
      (request) => {
        prompts.push(getCurrentSystemPrompt(request.messages)); promptIs(request.messages, ORIGINAL, CHANGED);
        const result = request.messages.filter((message) => message.role === "toolResult").at(-1)!;
        assert.ok(JSON.stringify(result.content).includes(CHANGED));
        assert.ok(request.messages.some((message) => message.role === "user" && message.content === "steer"));
        return fauxAssistantMessage("First and steer answered");
      },
      (request) => { prompts.push(getCurrentSystemPrompt(request.messages)); promptIs(request.messages, ORIGINAL, CHANGED); return fauxAssistantMessage("Queued one answered"); },
      (request) => { prompts.push(getCurrentSystemPrompt(request.messages)); promptIs(request.messages, ORIGINAL, CHANGED); return fauxAssistantMessage("Queued two answered"); },
    ]);
    const id = String(runtime.main.id); const first = await runtime.admit(id, input("first"));
    await within(entered.promise);
    await writeFile(projectPath, CHANGED);
    const steer = await runtime.admit(id, input("steer", "steer"));
    const queued1 = await runtime.admit(id, input("queued-one")); const queued2 = await runtime.admit(id, input("queued-two"));
    await assert.rejects(runtime.configure(id, { instructions: CHANGED }), { code: "busy" });
    release.release();
    for (const receipt of [first, steer, queued1, queued2]) assert.equal((await within(receipt.wait(context))).status, "done");
    assert.equal(prompts.length, 4); assert.equal(reads, 1);
    const entries = (await runtime.history(id)).items.filter((entry) => entry.kind === "deck.input");
    assert.deepEqual(entries.map((entry) => JSON.parse((entry.data as { capture: string }).capture).instructionsHash), Array(4).fill(createHash("sha256").update(ORIGINAL).digest("hex")));
    const originalReceipt = first.id;
    await runtime.configure(id, { instructions: CHANGED });
    assert.equal((await runtime.admit(id, input("first"))).id, originalReceipt);
    faux.setResponses([(request) => { promptIs(request.messages, CHANGED, ORIGINAL); return fauxAssistantMessage("New idle instructions applied"); }]);
    assert.equal((await within((await runtime.admit(id, input("later"))).wait(context))).status, "done");
    assert.equal(reads, 1); // No automatic AGENTS.md discovery on any generation boundary.
  } finally { release.release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("foreground child uses stored parent instructions, not changed project bytes or later idle parent settings", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-child-instructions-")); const { faux, models } = provider();
  const entered = gate(); const release = gate();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), {
    models, model, implementation: IMPLEMENTATION, binding: { machineId: "saved-worker", cwd: directory },
    environment: () => { throw new Error("No local fallback expected"); }, hostFiles: { call: async () => { throw new Error("No effects expected"); } },
  });
  try {
    const id = String(runtime.main.id);
    await runtime.configure(id, { instructions: ORIGINAL });
    await writeFile(join(directory, "AGENTS.md"), CHANGED);
    // Explicit factories distinguish child input from the parent's transcript and tool result.
    faux.setResponses([
      (request) => { promptIs(request.messages, ORIGINAL, CHANGED); return fauxAssistantMessage(fauxToolCall("subagent", { task: "Help" }), { stopReason: "toolUse" }); },
      async (request) => { promptIs(request.messages, ORIGINAL, CHANGED); assert.ok(request.messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Foreground delegation"))); entered.release(); await release.promise; return fauxAssistantMessage("Child answer"); },
      (request) => { promptIs(request.messages, ORIGINAL, CHANGED); return fauxAssistantMessage("Parent answer"); },
    ]);
    const receipt = await runtime.admit(id, input("delegate")); await within(entered.promise);
    const child = (await runtime.listChats()).items.find((chat) => chat.kind === "subagent")!; assert.ok(child);
    await assert.rejects(runtime.configure(id, { instructions: CHANGED }), { code: "busy" });
    release.release(); assert.equal((await within(receipt.wait(context))).status, "done");
    await runtime.configure(id, { instructions: CHANGED });
    assert.equal((await (await runtime.chat(child.chatId)).agent(context)).instructions, ORIGINAL);
    assert.equal((await runtime.main.agent(context)).instructions, CHANGED); assert.equal(faux.state.callCount, 3);
  } finally { release.release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Pi retries reprepare dynamic sections rather than freezing the first attempt's file choices", async () => {
  const { faux, models } = provider(); const registry = createRegistry(); let source = ORIGINAL; let reads = 0;
  registry.install(defineExtension({ name: "test.retry-source", sections: [section("project", () => { reads++; return source; })] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { baseDelayMs: 1 }, compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model } });
    faux.setResponses([
      (request) => { promptIs(request.messages, ORIGINAL, CHANGED); source = CHANGED; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 Internal server error" }); },
      (request) => { promptIs(request.messages, CHANGED, ORIGINAL); return fauxAssistantMessage("Retried"); },
    ]);
    const receipt = await root.submit({ requestId: "retry", type: "input", content: "One input" }, context);
    assert.equal((await within(receipt.wait(context))).status, "done"); assert.equal(reads, 2); assert.equal(faux.state.callCount, 2);
  } finally { await harness.close(context); }
});

test("Pi fixes a prepared request, not the whole input: raw configuration changes reach the next post-tool request", { timeout: 15_000 }, async () => {
  const { faux, models } = provider(); const registry = createRegistry();
  const prepared = gate(); const send = gate(); const toolEntered = gate(); const finishTool = gate(); let hooks = 0;
  registry.install(defineExtension({ name: "test.prepared", hooks: [hook(GenerationTask, { beforeRequest: async () => {
    if (++hooks === 1) { prepared.release(); await send.promise; }
    return undefined;
  } })], tools: [defineTool({ name: "pause", description: "Pause in the test", parameters: Type.Object({}), execute: async () => {
    toolEntered.release(); await finishTool.promise; return { output: [{ type: "text", text: "Done" }] };
  } })] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { compaction: { enabled: false } } }, context);
  try {
    const root = await harness.root(context, { agent: { model, instructions: ORIGINAL } });
    faux.setResponses([
      (request) => { promptIs(request.messages, ORIGINAL, CHANGED); return fauxAssistantMessage(fauxToolCall("pause", {}), { stopReason: "toolUse" }); },
      (request) => { promptIs(request.messages, CHANGED, ORIGINAL); return fauxAssistantMessage("Done"); },
    ]);
    const receipt = await root.submit({ requestId: "raw-change", type: "input", content: "One logical input" }, context);
    await within(prepared.promise);
    // This deliberately bypasses DeckRuntime.configure(), which correctly rejects busy changes.
    await root.configure({ instructions: CHANGED }, context);
    send.release(); await within(toolEntered.promise); finishTool.release();
    assert.equal((await within(receipt.wait(context))).status, "done"); assert.equal(faux.state.callCount, 2);
  } finally { send.release(); finishTool.release(); await harness.close(context); }
});

test("Pi section and beforeRequest errors fail open; a failed section refresh retains its previously shown text", async () => {
  const { faux, models } = provider(); const registry = createRegistry(); let available = false; let reads = 0; let hooks = 0; const reports: string[] = [];
  registry.install(defineExtension({ name: "test.fail-open", sections: [section("project", () => {
    reads++; if (!available) throw new Error("Required assigned worker/file unavailable"); return ORIGINAL;
  })], hooks: [hook(GenerationTask, { beforeRequest: () => { hooks++; throw new Error("Required capture could not be fixed"); } })] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: (_error, info) => { reports.push(info.type); } }, context);
  try {
    const root = await harness.root(context, { agent: { model } });
    const send = async (id: string, expected?: string) => {
      faux.setResponses([(request) => { assert.equal(getCurrentSystemPrompt(request.messages).includes(ORIGINAL), expected !== undefined); return fauxAssistantMessage("Inference still ran"); }]);
      assert.equal((await within((await root.submit({ requestId: id, type: "input", content: id }, context)).wait(context))).status, "done");
    };
    await send("missing-initial-section");
    available = true; await send("loaded", ORIGINAL);
    available = false; await send("failed-refresh", ORIGINAL);
    assert.equal(reads, 3); assert.equal(hooks, 3); assert.equal(faux.state.callCount, 3);
    assert.equal(reports.length, 5); // Two render failures plus three request-hook failures.
  } finally { await harness.close(context); }
});

test("beforeRequest replacements are provider-only and task memos do not retain settled instruction provenance", { timeout: 15_000 }, async () => {
  const { faux, models } = provider(); const registry = createRegistry(); const entered = gate(); const release = gate();
  let taskId: HookApi["taskId"] | undefined;
  registry.install(defineExtension({ name: "test.memo", hooks: [hook(GenerationTask, { beforeRequest: async (request, api, ctx) => {
    taskId = api.taskId;
    const snapshot = await api.memo("project", { text: ORIGINAL }, ctx);
    return { messages: [...request.messages, { role: "system" as const, content: "", sections: { project: snapshot.text }, timestamp: 0 }] };
  } })] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const root = await harness.root(context, { agent: { model } });
    faux.setResponses([async (request) => { promptIs(request.messages, ORIGINAL, CHANGED); entered.release(); await release.promise; return fauxAssistantMessage("Done"); }]);
    const receipt = await root.submit({ requestId: "memo", type: "input", content: "Go" }, context);
    await within(entered.promise); assert.ok(taskId);
    assert.deepEqual((await root.commit((tx) => tx.task(taskId!), context))!.memos?.project, { text: ORIGINAL });
    release.release(); assert.equal((await within(receipt.wait(context))).status, "done");
    const record = await root.commit((tx) => tx.task(taskId!), context);
    assert.equal(record!.state.status, "terminal"); assert.equal(record!.memos, undefined);
    const entries = await root.entries({ order: "ascending" }, 100, undefined, context);
    assert.ok(!JSON.stringify(entries.items).includes(ORIGINAL));
  } finally { release.release(); await harness.close(context); }
});

test("generation request hooks do not cover Pi's separate compaction model request", async () => {
  const { faux, models } = provider(); const registry = createRegistry(); let hooks = 0;
  registry.install(defineExtension({ name: "test.generation-only", hooks: [hook(GenerationTask, { beforeRequest: () => { hooks++; return undefined; } })] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { compaction: { keepRecentTokens: 32, reserveTokens: 128 } } }, context);
  try {
    const root = await harness.root(context, { agent: { model, instructions: ORIGINAL } });
    await root.commit(async (tx) => {
      for (let i = 0; i < 12; i++) {
        await tx.appendEntry(root.id, { kind: "test.user", model: [{ role: "user", content: `Entry ${i} ` + "old conversation ".repeat(100), timestamp: i }] });
        await tx.appendEntry(root.id, { kind: "test.answer", model: [fauxAssistantMessage(`Answer ${i}`)] });
      }
    }, context);
    faux.setResponses([(request) => { assert.ok(getCurrentSystemPrompt(request.messages).includes("context summarization assistant")); return fauxAssistantMessage("A compact summary"); }]);
    const task = await root.compact(undefined, context);
    const result = await within(harness.waitForTask(task, context));
    assert.equal(result.state.outcome.status, "completed"); assert.equal(faux.state.callCount, 1); assert.equal(hooks, 0);
  } finally { await harness.close(context); }
});
