import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { defineTask, type TaskId } from "@earendil-works/pi-durable";
import { ChatDoc, DeckError, DeckRuntime, type RuntimeOptions } from "./deck.js";
import { IMPORT_KIND, INSTRUCTION_BYTES, InstructionRequest, type InstructionImportResult } from "./instruction-import.js";
import type { FileResult, HostFiles } from "./host-files.js";
import { gate, IMPLEMENTATION, model, ORIGINAL, CHANGED, provider, within } from "./instructions.test.support.js";

const input = (requestId: string) => ({ requestId, text: requestId, mode: "followUp" as const });
async function fixture(host: HostFiles, run: (runtime: DeckRuntime, faux: ReturnType<typeof provider>["faux"], options: RuntimeOptions) => Promise<void>, cleanup: () => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "deck-import-")); const { faux, models } = provider();
  const options: RuntimeOptions = { models, model, implementation: IMPLEMENTATION, binding: { machineId: "saved-worker", cwd: "/saved/work" }, hostFiles: host, environment: () => { throw new Error("No hub-local fallback"); } };
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  try { await run(runtime, faux, options); } finally { cleanup(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
}
async function result(runtime: DeckRuntime, id: TaskId<InstructionImportResult>) {
  const settled = await within(runtime.harness.waitForTask(id, context));
  assert.equal(settled.state.outcome.status, "completed");
  if (settled.state.outcome.status !== "completed") throw new Error("Import did not complete");
  return settled.state.outcome.result;
}

test("idle import fixes assigned-worker bytes in Pi; stable task receipt, prompt, child provenance, scope and manual invalidation", async () => {
  let reads = 0;
  await fixture({ call: async (binding, id, operation, args) => {
    reads++; assert.deepEqual(binding, { machineId: "saved-worker", cwd: "/saved/work" }); assert.match(id, /^[1-9]\d*$/);
    assert.equal(operation, "read"); assert.deepEqual(args, { path: "AGENTS.md" }); return { ok: true, output: ORIGINAL };
  } }, async (runtime, faux, options) => {
    const id = String(runtime.main.id);
    await runtime.configure(id, { instructions: "REPLACE_THIS", thinkingLevel: "high" });
    const imported = await runtime.importInstructions(id, "load");
    const applied = await result(runtime, imported); assert.equal(applied.status, "applied");
    assert.equal(await runtime.importInstructions(id, "load"), imported); assert.equal(reads, 1); assert.equal(faux.state.callCount, 0);
    const source = await runtime.instructionSource(id);
    assert.deepEqual(source, { ...options.binding, path: "AGENTS.md", sha256: createHash("sha256").update(ORIGINAL).digest("hex"), bytes: Buffer.byteLength(ORIGINAL), taskId: String(imported) });
    assert.equal((await runtime.main.agent(context)).thinkingLevel, "high");
    faux.setResponses([
      (request) => { assert.ok(getCurrentSystemPrompt(request.messages).includes(ORIGINAL)); assert.ok(!getCurrentSystemPrompt(request.messages).includes("REPLACE_THIS")); return fauxAssistantMessage(fauxToolCall("subagent", { task: "Help" }), { stopReason: "toolUse" }); },
      (request) => { assert.ok(getCurrentSystemPrompt(request.messages).includes(ORIGINAL)); return fauxAssistantMessage("Child done"); },
      fauxAssistantMessage("Parent done"),
    ]);
    assert.equal((await within((await runtime.admit(id, input("delegate"))).wait(context))).status, "done");
    const child = (await runtime.listChats()).items.find((chat) => chat.kind === "subagent")!;
    assert.deepEqual(await runtime.instructionSource(child.chatId), source);
    await assert.rejects(runtime.importInstructions(child.chatId, "not-allowed"), { code: "invalid" });
    const independent = await runtime.createTask("Independent", options.binding);
    assert.equal((await independent.agent(context)).instructions, undefined); assert.equal(await runtime.instructionSource(String(independent.id)), undefined);
    await runtime.configure(id, { instructions: ORIGINAL }); // Even a manual identical value clears the imported source label.
    assert.equal(await runtime.instructionSource(id), undefined); assert.deepEqual(await runtime.instructionSource(child.chatId), source);
    assert.equal(await runtime.importInstructions(id, "load"), imported); assert.equal(await runtime.instructionSource(id), undefined);
  });
});

test("pending import excludes new input/configuration, preserves admitted receipts, and does not block unrelated work", async () => {
  const entered = gate(); const release = gate();
  try {
    await fixture({ call: async () => { entered.release(); await release.promise; return { ok: true, output: ORIGINAL }; } }, async (runtime, faux, options) => {
      const id = String(runtime.main.id); faux.setResponses([fauxAssistantMessage("Old"), fauxAssistantMessage("Other")]);
      const old = await runtime.admit(id, input("old")); await old.wait(context);
      const other = await runtime.createTask("Other", options.binding);
      const load = await runtime.importInstructions(id, "load"); await within(entered.promise);
      assert.equal(await runtime.importInstructions(id, "load"), load);
      const chat = await runtime.chat(id); const agent = chat.agent.bind(chat); const lookup = runtime.chat.bind(runtime); let resolutions = 0;
      chat.agent = async (context) => { resolutions++; return agent(context); };
      runtime.chat = async (target) => target === id ? chat : lookup(target);
      try {
        await assert.rejects(runtime.admit(id, input("new")), { code: "busy" });
        assert.equal(resolutions, 0); // Block before agent resolution, not only after a possibly concurrent apply.
      } finally { chat.agent = agent; runtime.chat = lookup; }
      await assert.rejects(runtime.configure(id, { instructions: CHANGED }), { code: "busy" });
      await assert.rejects(runtime.importInstructions(id, "different"), { code: "busy" });
      assert.equal((await runtime.admit(id, input("old"))).id, old.id);
      assert.equal((await within((await runtime.admit(String(other.id), input("other"))).wait(context))).status, "done");
      release.release(); assert.equal((await result(runtime, load)).status, "applied");
      assert.equal((await runtime.history(id)).items.filter((entry) => entry.kind === "deck.input").length, 1);
    }, release.release);
  } finally { release.release(); }
});

test("read/offline/uncertainty/format/size failures retain previous instructions and source without inference or error-detail leakage", async () => {
  let response: FileResult | "throw" = { ok: true, output: ORIGINAL }; let reads = 0;
  await fixture({ call: async () => { reads++; if (response === "throw") throw new Error("PRIVATE_TRANSPORT_DETAILS"); return response; } }, async (runtime, faux) => {
    const id = String(runtime.main.id); await result(runtime, await runtime.importInstructions(id, "baseline"));
    const source = await runtime.instructionSource(id);
    const cases: [FileResult | "throw", string][] = [
      [{ ok: false, output: "PRIVATE_PATH", code: "offline" }, "offline"],
      [{ ok: false, output: "PRIVATE_PATH", code: "read_failed" }, "read_failed"],
      [{ ok: false, output: "PRIVATE_PATH", code: "effect_uncertain" }, "effect_uncertain"],
      [{ ok: true, output: "🌍".repeat(INSTRUCTION_BYTES / 4 + 1) }, "too_large"],
      [{ ok: true, output: "bad\ud800" }, "invalid"], [{ ok: true, output: "bad\0text" }, "invalid"],
      [{ ok: true, output: "partial", truncated: true }, "invalid"], ["throw", "unavailable"],
    ];
    for (const [index, [value, reason]] of cases.entries()) {
      response = value; const task = await runtime.importInstructions(id, `error-${index}`);
      assert.deepEqual(await result(runtime, task), { status: "rejected", reason });
      assert.equal(await runtime.importInstructions(id, `error-${index}`), task);
      assert.equal((await runtime.main.agent(context)).instructions, ORIGINAL); assert.deepEqual(await runtime.instructionSource(id), source);
    }
    assert.equal(reads, 1 + cases.length); assert.equal(faux.state.callCount, 0);
    response = { ok: true, output: "🌍".repeat(INSTRUCTION_BYTES / 4) };
    assert.equal((await result(runtime, await runtime.importInstructions(id, "exact-limit"))).status, "applied");
    response = { ok: true, output: "" }; assert.equal((await result(runtime, await runtime.importInstructions(id, "empty"))).status, "applied");
    assert.equal((await runtime.main.agent(context)).instructions, ""); assert.equal((await runtime.instructionSource(id))!.bytes, 0);
  });
});

test("stop drains the issued read before releasing configuration authority and never applies its result", async () => {
  const entered = gate(); const release = gate(); const aborted = gate();
  try {
    await fixture({ call: async (_binding, _id, _operation, _args, signal) => {
      signal!.addEventListener("abort", aborted.release, { once: true }); entered.release(); await release.promise; return { ok: true, output: ORIGINAL };
    } }, async (runtime, faux) => {
      const id = String(runtime.main.id); await runtime.configure(id, { instructions: "BEFORE" });
      const load = await runtime.importInstructions(id, "load"); await within(entered.promise);
      let stopped = false; const stopping = runtime.stop(id).then(() => { stopped = true; }); await within(aborted.promise);
      assert.equal(stopped, false); await assert.rejects(runtime.configure(id, { instructions: CHANGED }), { code: "busy" });
      release.release(); await within(stopping);
      assert.deepEqual(await result(runtime, load), { status: "aborted" }); assert.equal(await runtime.importInstructions(id, "load"), load);
      assert.equal((await runtime.main.agent(context)).instructions, "BEFORE"); assert.equal(await runtime.instructionSource(id), undefined); assert.equal(faux.state.callCount, 0);
    }, release.release);
  } finally { release.release(); }
});

for (const drift of ["instructions", "binding"] as const) test(`import refuses ${drift} drift introduced outside Deck while its read is pending`, async () => {
  const entered = gate(); const release = gate();
  try {
    await fixture({ call: async () => { entered.release(); await release.promise; return { ok: true, output: ORIGINAL }; } }, async (runtime) => {
      const id = String(runtime.main.id); const load = await runtime.importInstructions(id, "load"); await within(entered.promise);
      if (drift === "instructions") await runtime.main.configure({ instructions: CHANGED }, context);
      else await runtime.main.commit(async (tx) => { (await tx.doc(ChatDoc, runtime.main.id)).machineId = "different-worker"; }, context);
      release.release(); assert.deepEqual(await result(runtime, load), { status: "rejected", reason: "settings_changed" });
      assert.notEqual((await runtime.main.agent(context)).instructions, ORIGINAL); assert.equal(await runtime.instructionSource(id), undefined);
    }, release.release);
  } finally { release.release(); }
});

test("completed import receipt survives an idle capability/auth change; unavailable native capability cannot start a new import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-import-receipt-")); const path = join(directory, "pi.sqlite"); const { faux, models } = provider();
  const options: RuntimeOptions = { models, model, implementation: IMPLEMENTATION, binding: { machineId: "saved", cwd: "/saved" }, environment: () => { throw new Error("No fallback"); }, admissionGuard: async () => { throw new DeckError("auth_required", "Unavailable auth"); } };
  let runtime = await DeckRuntime.open(path, { ...options, hostFiles: { call: async () => ({ ok: true, output: ORIGINAL }) } });
  try {
    const id = String(runtime.main.id); const task = await runtime.importInstructions(id, "old"); assert.equal((await result(runtime, task)).status, "applied");
    await runtime.close(); runtime = await DeckRuntime.open(path, options);
    assert.equal(await runtime.importInstructions(id, "old"), task);
    await assert.rejects(runtime.importInstructions(id, "new"), { code: "offline" });
    assert.equal((await runtime.main.agent(context)).instructions, ORIGINAL); assert.equal(faux.state.callCount, 0);
    for (const requestId of ["", "x".repeat(201)]) await assert.rejects(runtime.importInstructions(id, requestId), { code: "invalid" });
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await assert.rejects(runtime.importInstructions(String(unmanaged.id), "unmanaged"), { code: "invalid" });
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("import refuses active inference without issuing a read", async () => {
  const entered = gate(); const release = gate(); let reads = 0;
  await fixture({ call: async () => { reads++; return { ok: true, output: ORIGINAL }; } }, async (runtime, faux) => {
    faux.setResponses([async () => { entered.release(); await release.promise; return fauxAssistantMessage("Done"); }]);
    const id = String(runtime.main.id); const receipt = await runtime.admit(id, input("running")); await within(entered.promise);
    await assert.rejects(runtime.importInstructions(id, "blocked"), { code: "busy" });
    assert.equal(reads, 0); release.release(); await within(receipt.wait(context));
  }, release.release);
});

test("import uses authoritative parked/background work rather than idle activity; pre-admission cancellation creates no task", async () => {
  await fixture({ call: async () => { throw new Error("No read expected"); } }, async (runtime) => {
    const id = String(runtime.main.id); const controller = new AbortController(); controller.abort();
    await assert.rejects(runtime.importInstructions(id, "cancelled", controller.signal), { name: "AbortError" });
    assert.equal(await runtime.harness.snapshot(InstructionRequest, runtime.main.id, "cancelled", context), undefined);
    assert.equal((await runtime.harness.commit((tx) => tx.scanTasks({ kind: IMPORT_KIND }, 1), context)).items.length, 0);
    const pending = defineTask<{}, { phase: "parked" }, null>({ name: "test.uninstalled", version: 1, initial: () => ({ phase: "parked" }), phases: { parked: async () => {} }, abort: async () => {} });
    await runtime.main.commit((tx) => tx.createTask(pending, {}, { ownership: { kind: "conversation" }, background: true }), context);
    assert.equal((await runtime.activity(id)).busy, false);
    await assert.rejects(runtime.importInstructions(id, "blocked"), { code: "busy" });
  });
});
