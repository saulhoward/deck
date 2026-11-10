import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { serveIpc } from "./ipc.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import type { DeckRuntime } from "./deck.js";
import { validHistoryArgs, validHistoryPage } from "./history-contracts.js";
import { responseResult } from "./responses.js";

const entry = (id: number) => ({ id, kind: "deck.input", data: { text: "Retained 🤖" } });
test("history semantic fixtures agree with Zig and preserve original records", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../../src/history.test.json", import.meta.url), "utf8")) as { name: string; args: unknown; page: unknown; valid: boolean }[];
  for (const { name, args, page, valid } of fixtures) {
    const before = JSON.stringify(page);
    assert.equal(validHistoryPage(page, args), valid, name);
    const reply = { version: 1, id: "read", ok: true, result: page };
    if (valid) assert.equal(responseResult(reply, "read", { command: "history", args }), page);
    else assert.throws(() => responseResult(reply, "read", { command: "history", args }), /Invalid history response; cursor unchanged/);
    assert.equal(JSON.stringify(page), before);
  }
  for (const args of [null, {}, { chatId: "1", limit: "2" }, { chatId: "1", after: "1\n" }]) assert.equal(validHistoryArgs(args), false);
  assert.equal(validHistoryPage({ items: new Array(2) }, { chatId: "1" }), false);
  for (const text of ["\ud800", "\udfff"]) assert.equal(validHistoryPage({ items: [{ ...entry(1), data: { text } }] }, { chatId: "1" }), false);
});

test("history IPC guards args before scan and serialized results before egress, with no replay or private diagnostic", async () => {
  const input = new PassThrough(), output = new PassThrough(), decoder = new FrameDecoder();
  const waiting = new Map<string, (value: Record<string, unknown>) => void>();
  const calls: unknown[] = [];
  let page: unknown = { items: [entry(4)], next: "4" };
  output.pipe(decoder); decoder.on("data", (reply: Record<string, unknown>) => waiting.get(String(reply.id))!(reply));
  const runtime = { history: async (chat: string, args: unknown) => { calls.push([chat, args]); return page; } } as unknown as DeckRuntime;
  const serving = serveIpc(runtime, input, output);
  let id = 0;
  const call = async (args: unknown) => {
    const key = `read-${++id}`;
    const reply = new Promise<Record<string, unknown>>((resolve) => waiting.set(key, resolve));
    input.write(encodeFrame({ version: 1, id: key, command: "history", args })); return reply;
  };
  try {
    for (const args of [null, {}, { chatId: "1", limit: 0 }, { chatId: "1", after: "00" }, { chatId: "1", before: "3", after: "0" }, { chatId: "1", includeActivity: "true" }]) {
      const reply = await call(args); assert.equal(reply.ok, false); assert.equal((reply.error as { code: string }).code, "invalid");
    }
    assert.equal(calls.length, 0);
    const request = { chatId: "1", after: "3", limit: 1, extension: "ignored" };
    assert.equal((await call(request)).ok, true);
    assert.deepEqual(calls, [["1", { after: "3", limit: 1 }]]);
    for (const invalid of [
      { items: [entry(3)] }, { items: [entry(4), entry(5)] }, { items: [], next: "9" },
      { items: [entry(4)], next: "9" }, { items: [{ ...entry(4), data: { text: null } }] },
      { items: [entry(4)], toJSON() { return { items: [{ ...entry(4), id: "4" }], private: "PRIVATE-OUTPUT" }; } },
    ]) {
      page = invalid;
      const before: number = calls.length;
      const reply = await call(request);
      assert.equal(reply.ok, false); assert.equal((reply.error as { code: string }).code, "invalid_response");
      assert.equal(calls.length, before + 1); assert.doesNotMatch(JSON.stringify(reply), /PRIVATE-OUTPUT/);
    }
    page = { items: [] }; assert.equal((await call(request)).ok, true);
  } finally { input.end(); await serving; }
});
