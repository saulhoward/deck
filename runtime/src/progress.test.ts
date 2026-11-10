import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { serveIpc } from "./ipc.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { PREVIEW_UNITS, ProgressDisplay, projectProgress } from "./progress.js";
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 500; index++) { const value = await read(); if (check(value)) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Expected progress not observed");
}
function live(message = fauxAssistantMessage("Preview")): LiveState {
  const stored = JSON.parse(JSON.stringify(message)) as NonNullable<NonNullable<LiveState["generation"]>["message"]>;
  return { run: { taskId: 1 as NonNullable<LiveState["run"]>["taskId"], inputs: [] }, generation: { attempt: 1, message: stored } };
}

test("progress projection bounds text/blocks and omits reasoning, call arguments, signatures, tool output and provider errors", () => {
  const state = live(fauxAssistantMessage([
    fauxThinking("HIDDEN_REASONING"), fauxToolCall("bash", { command: "PRIVATE_ARGUMENTS" }),
    { type: "text", text: "HEAD" + "\u0000".repeat(3000) + "TAIL" },
  ]));
  const textPart = state.generation!.message!.content.find((part) => part.type === "text")!;
  if (textPart.type === "text") textPart.textSignature = "PRIVATE_TEXT_SIGNATURE";
  state.generation!.retry = { at: 123, error: "PRIVATE_RETRY" };
  state.tools = [{ callId: "private-call", name: "bash", status: "running", output: "PRIVATE_TOOL_OUTPUT", details: { private: "PRIVATE_DETAILS" } }];
  const before = JSON.stringify(state); const projected = projectProgress("1", state);
  assert.ok("generation" in projected && projected.generation);
  assert.equal(projected.generation.phase, "retrying"); assert.equal(projected.generation.text.length, PREVIEW_UNITS);
  assert.equal(projected.generation.textClipped, true); assert.equal(projected.generation.nonTextOmitted, true);
  assert.match(projected.generation.text, /TAIL$/); assert.doesNotMatch(JSON.stringify(projected), /HEAD|PRIVATE_|HIDDEN_/);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 16 * 1024); assert.equal(JSON.stringify(state), before);
  const many = live(fauxAssistantMessage(Array.from({ length: 140 }, (_, index) => ({ type: "text" as const, text: `block-${index}` }))));
  const bounded = projectProgress("1", many); assert.ok("generation" in bounded && bounded.generation);
  assert.equal(bounded.generation.blocksOmitted, 12); assert.doesNotMatch(bounded.generation.text, /block-0\n/);
  for (const stopReason of ["error", "aborted"] as const) {
    const result = projectProgress("1", live(fauxAssistantMessage("PRIVATE_ERROR_BODY", { stopReason, errorMessage: "PRIVATE_PROVIDER_ERROR" })));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
  assert.deepEqual(projectProgress("1", undefined), { version: 1, chatId: "1", provisional: true });
});

test("preview display prints self-contained snapshots, deduplicates, resets and whitelists bounded fields", () => {
  const display = new ProgressDisplay((text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));
  const snapshot = { version: 1, chatId: "1", provisional: true, runTaskId: "2", generation: { attempt: 1, phase: "generating", text: "Hello\n\x1b[31mworld" } };
  const first = display.render(snapshot, "1")!;
  assert.match(first, /provisional snapshot/); assert.match(first, /Hello\\nworld/); assert.equal(first.split("\n").length, 2);
  assert.doesNotMatch(first, /PRIVATE_|HIDDEN_|\x1b/); assert.equal(display.render(snapshot, "1"), undefined);
  for (const bad of [{ ...snapshot, private: "PRIVATE" }, { ...snapshot, generation: { ...snapshot.generation, arguments: "PRIVATE" } }, { ...snapshot, chatId: "2" }, { ...snapshot, version: 2 }, { ...snapshot, provisional: false }, { ...snapshot, generation: { ...snapshot.generation, phase: ["generating"] } }, { ...snapshot, runTaskId: "bad" }]) assert.equal(display.render(bad, "1"), undefined);
  const replacement = { ...snapshot, generation: { ...snapshot.generation, text: "Replacement" } };
  assert.match(display.render(replacement, "1")!, /Replacement/);
  assert.match(display.render({ ...replacement, generation: { ...replacement.generation, attempt: 2 } }, "1")!, /"attempt":2/);
  assert.equal(display.render({ ...snapshot, generation: { ...snapshot.generation, text: "x".repeat(5000) } }, "1"), undefined);
  const tail = display.render(projectProgress("1", live(fauxAssistantMessage("HEAD_MUST_CLIP" + "x".repeat(5000) + "TAIL"))), "1")!;
  assert.match(tail, /"textClipped":true/); assert.doesNotMatch(tail, /HEAD_MUST_CLIP/); assert.ok(tail.length < 16 * 1024);
  assert.match(display.render({ version: 1, chatId: "1", provisional: true }, "1")!, /preview cleared/);
  assert.equal(display.render({ version: 1, chatId: "1", provisional: true }, "1"), undefined);
  assert.ok(display.render(snapshot, "1")); display.reset(); assert.ok(display.render(snapshot, "1"));
});

test("actual Pi/faux streaming exposes provisional text, then clears during tools and retains the full canonical answer", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-progress-")); const release = gate(); const entered = gate();
  const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } }); const models = createModels(); models.setProvider(faux.provider);
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), {
    models, model: { provider: "faux", modelId: "faux-1" }, implementation: "a".repeat(64), binding: { machineId: "offline-host", cwd: "/saved" }, environment: () => undefined,
    hostFiles: { call: async () => { entered.release(); await release.promise; return { ok: true, output: "PRIVATE_TOOL_OUTPUT" }; } },
  });
  try {
    const id = String(runtime.main.id); const other = await runtime.createTask("Other", { machineId: "offline", cwd: "/other" });
    const text = "PUBLIC_ANSWER ".repeat(25);
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("HIDDEN_REASONING"), { type: "text", text }, fauxToolCall("read", { path: "PRIVATE_ARGUMENTS" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("FINAL_ANSWER"),
    ]);
    const submission = await runtime.admit(id, { requestId: "progress", text: "Start", mode: "followUp" });
    const partial = await until(() => runtime.progress(id), (value) => "generation" in value && !!value.generation?.text);
    assert.ok("generation" in partial && partial.generation); assert.equal(partial.provisional, true);
    assert.ok(partial.generation.text.length < text.length); assert.doesNotMatch(JSON.stringify(partial), /HIDDEN_|PRIVATE_/);
    assert.equal((await runtime.progress(String(other.id))).provisional, true);
    assert.equal("generation" in await runtime.progress(String(other.id)), false);
    assert.equal((await submission.status(context)).status, "placed");
    await entered.promise;
    assert.equal("generation" in await runtime.progress(id), false); assert.equal((await runtime.activity(id)).busy, true);
    const entries = (await runtime.history(id)).items.map((entry) => entry.id);
    for (let index = 0; index < 10; index++) assert.doesNotMatch(JSON.stringify(await runtime.progress(id)), /PRIVATE_/);
    assert.deepEqual((await runtime.history(id)).items.map((entry) => entry.id), entries);
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await runtime.progress(String(unmanaged.id)); assert.equal(await runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
    release.release(); assert.equal((await submission.wait(context)).status, "done");
    assert.equal("generation" in await runtime.progress(id), false);
    const history = JSON.stringify((await runtime.history(id)).items); assert.ok(history.includes(text)); assert.match(history, /FINAL_ANSWER/);
    await assert.rejects(runtime.progress("bad"), { code: "invalid" }); await assert.rejects(runtime.progress("999999999"), { code: "not_found" });
  } finally { release.release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("frame pressure omits optional progress rather than blocking a fitting canonical history page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-progress-budget-")); const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), { models, model: { provider: "faux", modelId: "faux-1" }, implementation: "a".repeat(64), binding: { machineId: "host", cwd: "/saved" }, environment: () => undefined });
  const input = new PassThrough(); const output = new PassThrough(); const decoder = output.pipe(new FrameDecoder()); const frames = decoder[Symbol.asyncIterator]();
  const serving = serveIpc(runtime, input, output);
  try {
    await runtime.main.commit(async (tx) => {
      await tx.appendEntry(runtime.main.id, { kind: "test.budget", data: "x".repeat(1_040_000) });
      const state = live(fauxAssistantMessage("\u0000".repeat(3000))); const doc = await tx.doc(LiveDoc, runtime.main.id);
      Object.assign(doc, state);
    }, context);
    const chatId = String(runtime.main.id);
    input.write(encodeFrame({ version: 1, id: "budget", command: "history", args: { chatId, limit: 1, includeProgress: true } }));
    const page = (await frames.next()).value;
    assert.equal(page.ok, true); assert.equal(page.result.items.length, 1); assert.equal(page.result.progress, undefined);
    assert.equal(page.result.items[0].data.length, 1_040_000);
    input.write(encodeFrame({ version: 1, id: "progress", command: "progress", args: { chatId } }));
    const preview = (await frames.next()).value; assert.equal(preview.ok, true); assert.equal(preview.result.generation.text.length, PREVIEW_UNITS);
  } finally { input.end(); await serving; decoder.destroy(); output.destroy(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("stopping a streamed response clears the preview without pretending the partial was a completed answer", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-progress-stop-")); const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } }); const models = createModels(); models.setProvider(faux.provider);
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), { models, model: { provider: "faux", modelId: "faux-1" }, implementation: "a".repeat(64), binding: { machineId: "host", cwd: "/saved" }, environment: () => undefined, hostFiles: { call: async () => { throw new Error("No effects expected"); } } });
  try {
    faux.setResponses([fauxAssistantMessage("PARTIAL_TEXT ".repeat(1000))]); const id = String(runtime.main.id);
    const submission = await runtime.admit(id, { requestId: "stop", text: "Start", mode: "followUp" });
    await until(() => runtime.progress(id), (value) => "generation" in value && !!value.generation?.text);
    await runtime.stop(id); assert.equal((await submission.status(context)).status, "unanswered");
    assert.equal("generation" in await runtime.progress(id), false);
    assert.match(JSON.stringify((await runtime.history(id)).items), /"stopReason":"aborted"/);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
