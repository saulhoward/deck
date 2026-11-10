import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { LiveState } from "@earendil-works/pi-durable";
import { DeckRuntime } from "./deck.js";
import { validViewArgs, validViewReply, validActivity, validProgress, validInstructions } from "./view-contracts.js";
import { validHistoryPage } from "./history-contracts.js";
import { responseResult } from "./responses.js";
import { serveIpc } from "./ipc.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { projectProgress, ProgressDisplay } from "./progress.js";
import { instructionSnapshot, InstructionsDisplay } from "./instructions-view.js";
import { prefixUnits, tailUnits } from "./view-text.js";

const activity = { chatId: "1", busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false };
const progress = { version: 1, chatId: "1", provisional: true };
const instructions = { version: 1, chatId: "1", source: null, import: { taskId: "9", state: "running" } };

test("shared live view fixtures agree with native scope/state/UTF-16 semantics without rewriting samples", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../../src/views.test.json", import.meta.url), "utf8"));
  for (const fixture of fixtures) {
    const { command, args, result } = fixture;
    if (fixture.repeat) {
      const { path, text, count } = fixture.repeat;
      let target = result; for (const key of path.slice(0, -1)) target = target[key];
      target[path.at(-1)] = text.repeat(count);
    }
    const before = JSON.stringify(result);
    assert.equal(command === "history" ? validHistoryPage(result, args) : validViewReply(command, result, args), fixture.valid, fixture.name);
    const response = { version: 1, id: "read", ok: true, result };
    if (fixture.valid) assert.equal(responseResult(response, "read", { command, args }), result);
    else assert.throws(() => responseResult(response, "read", { command, args }), /Invalid (live view|history) response/);
    assert.equal(JSON.stringify(result), before);
  }
  assert.equal(validViewArgs("instruction_status", { taskId: "9", ignored: true }), false);
  for (const value of ["\ud800", "\udfff"]) assert.equal(validProgress({ ...progress, runTaskId: "9", generation: { attempt: 1, phase: "generating", text: value } }), false);
  assert.equal(validActivity({ ...activity, tools: new Array(2) }), false);
  const many = { ...progress, runTaskId: "9", tools: Array(5).fill({ taskId: "10", name: "bash", text: "x" }) };
  assert.equal(validProgress(many), false);
});

test("Unicode clipping preserves well-formed pairs and original UTF-16 budgets without changing stored data", async () => {
  assert.equal(prefixUnits("a🤖b", 2), "a"); assert.equal(tailUnits("a🤖b", 2), "b");
  assert.equal(prefixUnits("a🤖b", 3), "a🤖"); assert.equal(tailUnits("a🤖b", 3), "🤖b");
  const long = "x🤖" + "x".repeat(2047);
  const live = { run: { taskId: 1, inputs: [] }, generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: long }] } }, tools: [{ name: "bash", taskId: 2, status: "running", details: { kind: "deck.bash-progress", version: 1, provisional: true, operationId: "2", output: "🤖" + "x".repeat(511), truncated: false, lossyUtf8: false } }] } as unknown as LiveState;
  const original = JSON.stringify(live), sample = projectProgress("1", live);
  assert.equal(validProgress(sample), true); assert.equal(sample.generation!.text.length, 2047); assert.equal(sample.tools![0]!.text.length, 511);
  assert.equal(JSON.stringify(live), original); assert.equal(sample.generation!.textClipped, true); assert.equal(sample.tools![0]!.textClipped, true);
  const source = { machineId: "x".repeat(79) + "🤖", cwd: "/" + "x".repeat(254) + "🤖", path: "AGENTS.md", sha256: "a".repeat(64), bytes: 1, taskId: "9" };
  const snapshot = instructionSnapshot("1", source, null);
  assert.equal(validInstructions(snapshot), true); assert.equal(snapshot.source!.machineId.length, 79); assert.equal(snapshot.source!.cwd.length, 255); assert.equal(snapshot.source!.labelsClipped, true);
  const state = { items: [], tools: [{ callId: "x".repeat(127) + "🤖", name: "x".repeat(79) + "🤖", status: "running" }] };
  const fake = { chat: async () => ({ id: 1 }), harness: { snapshot: async () => state } } as unknown as DeckRuntime;
  const projected = await DeckRuntime.prototype.activity.call(fake, "1");
  assert.equal(validActivity(projected), true); assert.equal(projected.tools[0]!.callId.length, 127); assert.equal(projected.tools[0]!.name.length, 79);
  const display = new ProgressDisplay((text) => text); assert.ok(display.render(sample, "1"));
  assert.equal(display.render({ ...sample, generation: { ...sample.generation, text: "\ud800" } }, "1"), undefined);
  assert.equal(display.render(sample, "1"), undefined);
  const sourceDisplay = new InstructionsDisplay(); assert.ok(sourceDisplay.render(snapshot, "1"));
  assert.equal(sourceDisplay.render({ ...snapshot, import: {} }, "1"), ""); assert.equal(sourceDisplay.render(snapshot, "1"), "");
});

test("all read commands validate before dispatch and serialized egress, preserve defaults, and reject malformed history attachments", async () => {
  const input = new PassThrough(), output = new PassThrough(), decoder = output.pipe(new FrameDecoder()), frames = decoder[Symbol.asyncIterator]();
  const calls: unknown[] = [];
  const values: Record<string, unknown> = { activity, progress, instruction_status: instructions };
  const runtime = { main: { id: 1 }, activity: async (id: string) => { calls.push(["activity", id]); return values.activity; }, progress: async (id: string) => { calls.push(["progress", id]); return values.progress; }, instructionsStatus: async (id: string, task?: string) => { calls.push(["instruction_status", id, task]); return values.instruction_status; }, history: async () => ({ items: [{ id: 1, kind: "deck.input", data: { text: "PRIVATE_PAGE" } }] }) } as unknown as DeckRuntime;
  const serving = serveIpc(runtime, input, output);
  let serial = 0;
  const call = async (command: string, args?: unknown) => {
    const id = String(++serial); input.write(encodeFrame({ version: 1, id, command, ...(args === undefined ? {} : { args }) }));
    const reply = (await frames.next()).value; assert.equal(reply.id, id); return reply;
  };
  try {
    for (const command of ["activity", "progress", "instruction_status"]) {
      for (const args of [{ chatId: null }, { chatId: 1 }, { chatId: "9007199254740992" }, []]) assert.equal((await call(command, args)).error.code, "invalid");
    }
    assert.equal((await call("instruction_status", { taskId: "0" })).error.code, "invalid");
    assert.equal((await call("instruction_status", { text: "PRIVATE" })).error.code, "invalid");
    assert.equal(calls.length, 0);
    for (const command of ["activity", "progress", "instruction_status"]) {
      assert.equal((await call(command)).ok, true); assert.equal((await call(command, null)).ok, true);
      const original = values[command];
      const args = { chatId: "1", ...(command === "instruction_status" ? { taskId: "9" } : { ignored: true }) };
      assert.equal((await call(command, args)).ok, true);
      for (const result of [{ ...original as object, chatId: "2" }, { ...original as object, private: "PRIVATE" }, { toJSON: () => ({ ...original as object, private: "PRIVATE" }) }, { toJSON() { throw new Error("PRIVATE"); } }]) {
        values[command] = result;
        const count: number = calls.length, reply = await call(command, args);
        assert.equal(reply.error.code, "invalid_response"); assert.equal(calls.length, count + 1); assert.doesNotMatch(JSON.stringify(reply), /PRIVATE/);
        const history = await call("history", { chatId: "1", includeActivity: true, includeProgress: true, includeInstructions: true });
        assert.equal(history.error.code, "invalid_response"); assert.doesNotMatch(JSON.stringify(history), /PRIVATE/);
      }
      values[command] = original;
    }
    assert.equal((await call("instruction_status", { chatId: "1", taskId: "10" })).error.code, "invalid_response");
    assert.ok(calls.every((call) => Array.isArray(call) && call[1] === "1"));
    assert.equal((await call("history", { chatId: "1", includeActivity: true, includeProgress: true, includeInstructions: true })).ok, true);
  } finally { input.end(); await serving; decoder.destroy(); output.destroy(); }
});
