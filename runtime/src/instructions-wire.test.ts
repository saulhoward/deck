import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { InstructionSourceDoc } from "./instruction-import.js";
import { InstructionsDisplay, instructionSnapshot, projectInstructionTask } from "./instructions-view.js";
import { serveIpc } from "./ipc.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { gate, IMPLEMENTATION, model, ORIGINAL, provider, within } from "./instructions.test.support.js";

async function wireFixture(run: (runtime: DeckRuntime, command: (command: string, args?: Record<string, unknown>) => Promise<any>, release: () => void, entered: Promise<void>, reads: () => number) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "deck-instructions-wire-")); const { models } = provider(); const entered = gate(); const release = gate(); let reads = 0;
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), { models, model, implementation: IMPLEMENTATION, binding: { machineId: "saved-worker", cwd: directory }, environment: () => { throw new Error("No local fallback"); }, hostFiles: { call: async () => { reads++; entered.release(); await release.promise; return { ok: true, output: ORIGINAL }; } } });
  const input = new PassThrough(); const output = new PassThrough(); const decoder = output.pipe(new FrameDecoder()); const frames = decoder[Symbol.asyncIterator]();
  const serving = serveIpc(runtime, input, output);
  let counter = 0;
  const command = async (command: string, args = {}) => {
    const id = String(++counter); input.write(encodeFrame({ version: 1, id, command, args }));
    const response = (await within(frames.next())).value; assert.equal(response.id, id); return response;
  };
  try { await run(runtime, command, release.release, entered.promise, () => reads); }
  finally { release.release(); input.end(); await serving; decoder.destroy(); output.destroy(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
}

test("public instruction admission/status preserve frozen binding, task identity and privacy without turning ACK into application", async () => {
  await wireFixture(async (runtime, command, release, entered, reads) => {
    const chatId = String(runtime.main.id); const binding = (await command("status")).result.binding;
    const args = { chatId, requestId: "wire-import", machineId: binding.machineId, cwd: binding.cwd };
    assert.deepEqual((await command("instruction_status")).result, { version: 1, chatId, source: null, import: null });
    assert.equal(await runtime.harness.snapshot(InstructionSourceDoc, runtime.main.id, context), undefined);
    assert.equal((await command("import_instructions", { ...args, cwd: "/changed" })).error.code, "settings_changed");
    assert.equal((await command("import_instructions", { ...args, path: "other.md" })).error.code, "invalid");
    const ack = (await command("import_instructions", args)).result;
    assert.equal(ack.admitted, true); assert.equal(ack.completion, "not_waited"); assert.equal(ack.requestId, args.requestId); assert.equal(ack.chatId, chatId);
    await within(entered);
    const pending = (await command("instruction_status", { chatId, taskId: ack.taskId })).result;
    assert.equal(pending.source, null); assert.equal(pending.import.taskId, ack.taskId); assert.notEqual(pending.import.state, "terminal"); assert.equal(pending.import.result, undefined);
    assert.doesNotMatch(JSON.stringify(pending), /checkpoint|previousHash|PROJECT_INSTRUCTIONS_ORIGINAL/);
    assert.equal((await command("admit", { chatId, requestId: "blocked", text: "Hello", mode: "steer" })).error.code, "busy");
    const sampled = (await command("history", { chatId, includeInstructions: true })).result.instructions;
    assert.equal(sampled.import.taskId, ack.taskId);
    release(); await within(runtime.main.waitForIdle(context));
    const applied = (await command("instruction_status", { chatId })).result;
    assert.equal(applied.import.state, "terminal"); assert.equal(applied.import.outcome, "completed"); assert.equal(applied.import.result.status, "applied");
    assert.doesNotMatch(JSON.stringify(applied), /PROJECT_INSTRUCTIONS_ORIGINAL/); assert.equal(applied.source.taskId, ack.taskId);
    assert.deepEqual((await command("import_instructions", args)).result, ack); assert.equal(reads(), 1);
    const other = await runtime.createTask("Other", binding);
    assert.equal((await command("instruction_status", { chatId: String(other.id), taskId: ack.taskId })).error.code, "not_found");
    for (const taskId of ["0", "bad", "999999999"]) assert.ok((await command("instruction_status", { chatId, taskId })).error);
    await runtime.main.commit(async (tx) => { (await tx.doc(ChatDoc, runtime.main.id)).machineId = "changed-default"; }, context);
    assert.deepEqual((await command("import_instructions", args)).result, ack);
    assert.equal((await command("import_instructions", { ...args, machineId: "changed-default" })).error.code, "conflict");
    assert.equal((await command("import_instructions", { ...args, requestId: "not-yet-admitted" })).error.code, "settings_changed");
    assert.equal(reads(), 1);
  });
});

test("optional instruction samples cannot overflow fitting history or advance its cursor", async () => {
  await wireFixture(async (runtime, command, release) => {
    const chatId = String(runtime.main.id); const binding = (await command("status")).result.binding;
    await command("import_instructions", { chatId, requestId: "budget", machineId: binding.machineId, cwd: binding.cwd });
    release(); await within(runtime.main.waitForIdle(context));
    await runtime.main.commit((tx) => tx.appendEntry(runtime.main.id, { kind: "test.budget", data: "x".repeat(1_048_000) }), context);
    const history = await command("history", { chatId, limit: 1, includeInstructions: true });
    assert.equal(history.ok, true); assert.equal(history.result.items[0].data.length, 1_048_000); assert.equal(history.result.instructions, undefined);
    assert.equal((await command("instruction_status", { chatId })).result.import.result.status, "applied");
  });
});

test("instruction domain projection omits private fields; wire display refuses invalid samples without normalizing or changing observations", () => {
  const source = { machineId: "\x1b[2J\x9b2J" + "x".repeat(400), cwd: "/" + "\0".repeat(400), path: "AGENTS.md", sha256: "a".repeat(64), bytes: 32000, taskId: "2", secret: "PRIVATE" };
  const task = (result: unknown) => projectInstructionTask({ id: 2, state: { status: "terminal", outcome: { status: "completed", result } }, error: "PRIVATE" } as unknown as Parameters<typeof projectInstructionTask>[0]);
  const value = instructionSnapshot("1", source, task({ status: "applied", source, secret: "PRIVATE" }));
  const display = new InstructionsDisplay(); const rendered = display.render(value, "1");
  assert.ok(Buffer.byteLength(rendered) < 8192); assert.doesNotMatch(rendered, /PRIVATE|\x1b|\x9b|\0/); assert.match(rendered, /labelsClipped/); assert.ok(rendered.includes("\\u009b"));
  const reordered = (input: unknown): unknown => Array.isArray(input) ? input.map(reordered) : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).reverse().map(([key, item]) => [key, reordered(item)])) : input;
  assert.equal(display.render(reordered(value), "1"), "");
  assert.equal(display.render(value, "1"), ""); assert.equal(display.render(value, "3"), "");
  for (const bad of [{ ...value, private: "PRIVATE" }, { ...value, source }, { ...value, version: 2 }, { ...value, import: { ...value.import, state: "running" } }]) assert.equal(display.render(bad, "1"), "");
  assert.equal(display.render(value, "1"), ""); // Invalid samples never clear/dedup a different observation.
  const cleared = display.render({ ...value, source: null }, "1"); assert.match(cleared, /"source":null/); assert.match(cleared, /"status":"applied"/);
  const pending = display.render({ ...value, import: { taskId: "2", state: "running" } }, "1"); assert.doesNotMatch(pending, /"result"|"status":"applied"/);
  const malformed = display.render(instructionSnapshot("1", source, task({ status: "rejected", reason: "PRIVATE" })), "1"); assert.match(malformed, /resultOmitted/); assert.doesNotMatch(malformed, /PRIVATE/);
  const mismatch = display.render(instructionSnapshot("1", source, task({ status: "applied", source: { ...source, taskId: "99" } })), "1", true); assert.match(mismatch, /resultOmitted/); assert.doesNotMatch(mismatch, /"status":"applied"/);
  display.reset(); assert.equal(display.render({ version: 1, chatId: "1", source: null, import: null }, "1"), "");
  assert.ok(display.render({ version: 1, chatId: "1", source: null, import: null }, "1", true));
});
