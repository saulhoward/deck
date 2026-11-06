import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { LiveState, ToolExecutionApi } from "@earendil-works/pi-durable";
import { nativeFiles, type HostFiles, type ShellProgress } from "./host-files.js";
import { ProgressDisplay, projectProgress, TOOL_PREVIEW_UNITS } from "./progress.js";

function slot(taskId: number, output: string) {
  return { taskId: taskId as NonNullable<LiveState["run"]>["taskId"], callId: "PRIVATE_CALL_ID", name: "bash", status: "running", output: "PRIVATE_GENERIC_OUTPUT", details: { kind: "deck.bash-progress", version: 1, provisional: true, operationId: String(taskId), output, truncated: true, lossyUtf8: true, private: "PRIVATE_DETAILS" } } satisfies NonNullable<LiveState["tools"]>[number];
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

test("bash progress whitelists only running native snapshots, bounds nested scans/text and stays below 32 KiB with assistant escaping", () => {
  const state: LiveState = { run: { taskId: 1 as NonNullable<LiveState["run"]>["taskId"], inputs: [] }, tools: Array.from({ length: 40 }, (_, i) => slot(i + 2, "HEAD" + "\u0000".repeat(3000))) };
  state.generation = { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "\u0000".repeat(3000) }] } as NonNullable<NonNullable<LiveState["generation"]>["message"]> };
  const before = JSON.stringify(state); const projected = projectProgress("1", state);
  assert.equal(projected.tools!.length, 4); assert.equal(projected.toolSlotsOmitted, true);
  assert.ok(projected.tools!.every((tool) => tool.text.length === TOOL_PREVIEW_UNITS && tool.textClipped && tool.lossyUtf8));
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|HEAD/); assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 32 * 1024);
  assert.equal(JSON.stringify(state), before);
  for (const change of [{ name: "read" }, { status: "done" }, { taskId: undefined }, { details: { kind: "other", output: "PRIVATE_DETAILS" } }, { details: { ...slot(2, "x").details as object, operationId: "999" } }]) {
    const result = projectProgress("1", { ...state, tools: [{ ...slot(2, "PUBLIC"), ...change } as NonNullable<LiveState["tools"]>[number]] });
    assert.equal(result.tools, undefined);
  }
  state.nestedTools = Array.from({ length: 100 }, (_, i) => ({ ...slot(i + 100, "nested"), parentCallId: "PRIVATE_PARENT", parentTaskId: 2 as NonNullable<LiveState["run"]>["taskId"], arguments: { secret: "PRIVATE_ARGUMENTS" } }));
  assert.ok(projectProgress("1", state).tools!.every((tool) => tool.text === "nested"));
  assert.doesNotMatch(JSON.stringify(projectProgress("1", state)), /PRIVATE_/);
});

test("bash display validates, sanitizes, deduplicates and clears independently from assistant snapshots", () => {
  const display = new ProgressDisplay((text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));
  const value = { version: 1, chatId: "1", provisional: true, runTaskId: "2", tools: [{ taskId: "3", name: "bash", text: "hello\n\x1b[31mworld", private: "PRIVATE_ARGUMENTS" }] };
  const rendered = display.render(value, "1")!;
  assert.match(rendered, /bash output preview \(provisional snapshot\)/); assert.match(rendered, /hello\\nworld/); assert.equal(rendered.split("\n").length, 2); assert.doesNotMatch(rendered, /PRIVATE_|\x1b/);
  assert.equal(display.render(value, "1"), undefined);
  for (const bad of [{ ...value, chatId: "2" }, { ...value, runTaskId: "bad" }, { ...value, tools: [{ ...value.tools[0], taskId: "bad" }] }, { ...value, tools: Array(5).fill(value.tools[0]) }]) assert.equal(display.render(bad, "1"), undefined);
  assert.equal(display.render(value, "1"), undefined);
  assert.match(display.render({ ...value, tools: [{ taskId: "3", name: "bash", text: "HEAD" + "x".repeat(3000) + "TAIL" }] }, "1")!, /"textClipped":true/);
  const assistant = { ...value, generation: { attempt: 1, phase: "generating", text: "Assistant" } };
  assert.match(display.render(assistant, "1")!, /assistant preview/);
  const cleared = display.render({ version: 1, chatId: "1", provisional: true }, "1")!;
  assert.match(cleared, /assistant preview cleared/); assert.match(cleared, /bash output preview cleared/);
  assert.equal(display.render({ version: 1, chatId: "1", provisional: true }, "1"), undefined);
  display.reset(); assert.ok(display.render(value, "1"));
});

test("native tool publication coalesces to one in-flight commit and one replacement; late samples and presentation failure cannot change the final result", async () => {
  for (const failure of [false, true]) {
    const commit = gate(); const settle = gate(); const values: unknown[] = []; let callback: ((value: ShellProgress) => void) | undefined;
    const host: HostFiles = { call: async (_binding, _id, _operation, _args, _signal, onProgress) => {
      callback = onProgress;
      for (let i = 0; i < 1000; i++) onProgress!({ output: `sample-${i}`, truncated: true, lossyUtf8: false });
      await settle.promise; return { ok: true, output: "FINAL" };
    } };
    const api = { taskId: 3, conversationId: 1, snapshot: async () => ({ machineId: "local", cwd: "/saved" }), details: async (value: unknown) => { values.push(value); if (failure) throw new Error("Presentation unavailable"); await commit.promise; } } as unknown as ToolExecutionApi;
    const bash = nativeFiles(host).tools!.find((tool) => tool.name === "bash")!;
    const result = bash.execute({ command: "unused", path: "unused" }, api, context);
    // Let the fake binding lookup and the first publication enter.
    await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(values.length, 1);
    commit.release(); await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(values.length, failure ? 1 : 2);
    if (!failure) assert.match(JSON.stringify(values[1]), /sample-999/);
    settle.release(); const final = await result;
    assert.deepEqual(final.output, [{ type: "text", text: "FINAL" }]); assert.equal(final.isError, false);
    callback!({ output: "LATE", truncated: false, lossyUtf8: false }); await Promise.resolve();
    assert.equal(values.length, failure ? 1 : 2);
  }
});

test("a sample arriving between publisher loop exit and finally is not stranded behind deduplication", async () => {
  const commit = gate(); const settle = gate(); const values: unknown[] = [];
  let callback!: (value: ShellProgress) => void;
  const host: HostFiles = { call: async (_binding, _id, _operation, _args, _signal, onProgress) => {
    callback = onProgress!; callback({ output: "first", truncated: false, lossyUtf8: false });
    await settle.promise; return { ok: true, output: "FINAL" };
  } };
  const api = { taskId: 3, conversationId: 1, snapshot: async () => ({ machineId: "local", cwd: "/saved" }), details: (value: unknown) => {
    values.push(value);
    return values.length === 1 ? commit.promise.then(() => {
      queueMicrotask(() => queueMicrotask(() => callback({ output: "racing replacement", truncated: false, lossyUtf8: false })));
    }) : Promise.resolve();
  } } as unknown as ToolExecutionApi;
  const result = nativeFiles(host).tools![0]!.execute({ command: "unused", path: "unused" }, api, context);
  await new Promise((resolve) => setTimeout(resolve, 10)); commit.release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(values.length, 2); assert.match(JSON.stringify(values[1]), /racing replacement/);
  settle.release(); await result;
});
