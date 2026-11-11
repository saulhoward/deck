import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, defineTask } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { serveIpc } from "./ipc.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { responseFrame, responseResult } from "./responses.js";
import { validModelSettingsReply, validModelSettingsSnapshot } from "./model-settings-contracts.js";
import { failurePolicy } from "./command-policy.js";

async function fixture(initialModel = "alpha") {
  const directory = await mkdtemp(join(tmpdir(), "deck-model-settings-"));
  const faux = fauxProvider({ models: [{ id: "alpha", reasoning: true }, { id: "beta", reasoning: true }, { id: "plain", reasoning: false }] });
  const models = createModels(); models.setProvider(faux.provider);
  const options = { models, model: { provider: "faux", modelId: initialModel }, implementation: "a".repeat(64), binding: { machineId: "worker", cwd: directory }, environment: () => undefined };
  const path = join(directory, "pi.sqlite");
  let runtime = await DeckRuntime.open(path, options);
  return { get runtime() { return runtime; }, faux, options,
    reopen: async () => { await runtime.close(); runtime = await DeckRuntime.open(path, { ...options, model: { provider: "faux", modelId: "plain" } }); },
    close: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("hub model catalog defaults to medium, changes are chat-scoped and Pi uses/persists the selection", async () => {
  const f = await fixture();
  try {
    const r = f.runtime, id = String(r.main.id), initial = await r.modelSettings(id);
    assert.ok(validModelSettingsSnapshot(initial)); assert.equal(initial.selection.thinkingLevel, "medium");
    assert.deepEqual(initial.models.find((m) => m.modelId === "plain")!.thinkingLevels, ["off"]);
    assert.deepEqual(initial.defaultModel, f.options.model);
    const task = await r.createTask("Other", f.options.binding); const child = String(task.id);
    const chosen = { provider: "faux", modelId: "beta", thinkingLevel: "high" as const };
    await r.setModelSettings({ chatId: child, expected: initial.selection, selection: chosen });
    assert.deepEqual((await r.modelSettings(id)).selection, initial.selection);
    assert.deepEqual(await r.harness.snapshot(ChatDoc, task.id, context), { kind: "task", title: "Other", ...f.options.binding });
    f.faux.setResponses([(ctx, options, state, model) => { assert.equal(model.id, "beta"); assert.equal(options?.reasoning, "high"); return fauxAssistantMessage("selected model answered"); }]);
    const receipt = await r.admit(child, { requestId: "input", text: "hello", mode: "steer" }); await receipt.wait(context);
    await task.waitForIdle(context);
    const retained = (await r.history(child)).items.find((e) => e.kind === "deck.input")!.data;
    const source = await r.modelSettings(child);
    await r.setModelSettings({ chatId: child, expected: source.selection, selection: { ...chosen, thinkingLevel: "low" } });
    assert.equal((await r.admit(child, { requestId: "input", text: "hello", mode: "steer" })).id, receipt.id);
    assert.deepEqual((await r.history(child)).items.find((e) => e.kind === "deck.input")!.data, retained);
    await f.reopen();
    assert.equal((await f.runtime.modelSettings(child)).selection.thinkingLevel, "low");
    assert.deepEqual((await f.runtime.modelSettings(id)).selection, initial.selection); // New launcher defaults do not migrate saved choices.
  } finally { await f.close(); }
});

test("non-reasoning defaults to off and thinking-only updates preserve stored model extensions", async () => {
  const f = await fixture("plain");
  try {
    const r = f.runtime, chatId = String(r.main.id);
    const initial = (await r.modelSettings(chatId)).selection; assert.equal(initial.thinkingLevel, "off");
    await r.main.commit(async (tx) => { (await tx.doc(AgentDoc, r.main.id)).model = { ...initial, privateExtension: "RETAIN" } as any; }, context);
    await r.setModelSettings({ chatId, expected: initial, selection: initial });
    const agent = await r.harness.snapshot(AgentDoc, r.main.id, context);
    assert.equal((agent!.model as any).privateExtension, "RETAIN");
    assert.doesNotMatch(JSON.stringify(await r.modelSettings(chatId)), /privateExtension|RETAIN/);
  } finally { await f.close(); }
});

test("model settings cannot change active or queued inputs and never stop them", { timeout: 10_000 }, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    const r = f.runtime, chatId = String(r.main.id), expected = (await r.modelSettings(chatId)).selection;
    f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("first"); }, fauxAssistantMessage("second")]);
    const first = await r.admit(chatId, { requestId: "first", text: "first", mode: "steer" }); await entered.promise;
    const args = { chatId, expected, selection: { ...expected, thinkingLevel: "high" as const } };
    await assert.rejects(r.setModelSettings(args), { code: "busy" });
    const second = await r.admit(chatId, { requestId: "second", text: "second", mode: "followUp" });
    await assert.rejects(r.setModelSettings(args), { code: "busy" });
    release.resolve(); await first.wait(context); await second.wait(context); await r.main.waitForIdle(context);
    await r.setModelSettings(args); assert.equal(f.faux.state.callCount, 2);
  } finally { release.resolve(); await f.close(); }
});

test("settings reject stale clients, unsupported levels, ownership and authoritative pending work", async () => {
  const f = await fixture();
  try {
    const r = f.runtime, id = String(r.main.id), initial = (await r.modelSettings(id)).selection;
    const next = { ...initial, thinkingLevel: "high" as const };
    await r.setModelSettings({ chatId: id, expected: initial, selection: next });
    await assert.rejects(r.setModelSettings({ chatId: id, expected: initial, selection: { ...initial, thinkingLevel: "low" } }), { code: "conflict" });
    await assert.rejects(r.setModelSettings({ chatId: id, expected: next, selection: { ...next, modelId: "plain" } }), { code: "invalid" });
    await assert.rejects(r.setModelSettings({ chatId: id, expected: next, selection: { ...next, modelId: "missing" } }), { code: "invalid" });
    const task = await r.createTask("Owned metadata", f.options.binding);
    await task.commit(async (tx) => { (await tx.doc(ChatDoc, task.id)).kind = "subagent"; }, context);
    await assert.rejects(r.setModelSettings({ chatId: String(task.id), expected: next, selection: initial }), { code: "invalid" });
    const pending = defineTask<{}, { phase: "blocked" }, null>({ name: "test.model-settings-pending", version: 1, initial: () => ({ phase: "blocked" }), phases: { blocked: async () => {} }, abort: async () => {} });
    const owned = await r.main.commit(async (tx) => {
      const taskId = await tx.createTask(pending, {}, { ownership: { kind: "conversation" } });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId } });
      // Display metadata cannot confer authority over a canonically Pi-owned chat.
      Object.assign(await tx.doc(ChatDoc, child.id), { kind: "task", title: "Mislabelled", ...f.options.binding });
      Object.assign(await tx.doc(AgentDoc, child.id), { model: f.options.model, thinkingLevel: "high", cwd: f.options.binding.cwd });
      return child.id;
    }, context);
    await assert.rejects(r.setModelSettings({ chatId: String(owned), expected: next, selection: initial }), { code: "invalid", message: "Owned subagents inherit their owner's settings" });
    assert.equal((await r.activity(id)).busy, false);
    await assert.rejects(r.setModelSettings({ chatId: id, expected: next, selection: initial }), { code: "busy" });
    assert.deepEqual((await r.modelSettings(id)).selection, next);
  } finally { await f.close(); }
});

test("public model settings are pinned, closed and committed through the existing Pi configuration path", async () => {
  const f = await fixture(), input = new PassThrough(), output = new PassThrough();
  const decoder = output.pipe(new FrameDecoder()), frames = decoder[Symbol.asyncIterator]();
  const serving = serveIpc(f.runtime, input, output); let seq = 0;
  const command = async (command: string, args = {}, hubId: string | undefined = f.runtime.hubId) => {
    const request = { version: 1, id: String(++seq), hubId, command, args }; input.write(encodeFrame(request));
    const result = (await frames.next()).value;
    if (result.ok) responseResult(result, request.id, request);
    return result;
  };
  try {
    const chatId = String(f.runtime.main.id);
    assert.equal((await command("status")).result.modelSettings, 1);
    const settings = (await command("model_settings", { chatId })).result;
    assert.equal((await command("model_settings", { chatId }, "wrong")).error.code, "conflict");
    const args = { chatId, expected: settings.selection, selection: { ...settings.selection, thinkingLevel: "low" } };
    assert.equal((await command("set_model_settings", { ...args, cwd: "/other" })).error.code, "invalid");
    assert.equal((await command("set_model_settings", args)).result.selection.thinkingLevel, "low");
    assert.equal((await command("set_model_settings", args)).error.code, "conflict"); // No blind replay after an ACK is lost.
    assert.equal((await f.runtime.main.agent(context)).thinkingLevel, "low");
    assert.equal((await f.runtime.history(chatId)).items.length, 0);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(failurePolicy("model_settings", "future_error", "remote").action, "retry_read");
    assert.equal(failurePolicy("set_model_settings", "future_error", "remote").action, "explicit_action");
  } finally { input.end(); await serving; decoder.destroy(); output.destroy(); await f.close(); }
});

test("shared model settings reply fixtures validate whole catalogs, scope and exact ACKs in both languages", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../../src/model_settings.test.json", import.meta.url), "utf8"));
  for (const fixture of fixtures.cases) {
    const base = structuredClone(fixtures[fixture.base]);
    Object.assign(base, fixture.set ?? {});
    Object.assign(base.result, fixture.result ?? {});
    const request = { version: 1, id: "1", command: base.command, hubId: base.hubId, args: base.args };
    assert.equal(validModelSettingsReply(request, base.result), fixture.valid, fixture.name);
    const frame = responseFrame({ version: 1, id: "1", ok: true, result: base.result }, request);
    const encoded = JSON.parse(frame.subarray(4).toString()); assert.equal(encoded.ok, fixture.valid, fixture.name);
  }
});
