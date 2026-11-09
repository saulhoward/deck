import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { serveIpc } from "./ipc.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import type { DeckRuntime } from "./deck.js";
import { validChatListPage } from "./generated/contracts.js";
import { validDiscoveryArgs, validDiscoveryPage } from "./discovery-contracts.js";
import { responseResult } from "./responses.js";

const row = (chatId: string) => ({ chatId, kind: "task", title: "Saved", machineId: "offline-worker", cwd: "/saved/cwd" });

test("discovery requires bounded, safe, ordered and request-scoped pages, not health/ownership evidence", () => {
  for (const args of [{}, { limit: 1, ignored: true }, { after: "9007199254740991" }]) assert.equal(validDiscoveryArgs(args), true);
  for (const args of [{ limit: 0 }, { limit: null }, { limit: "1" }, { after: "1\n" }, { after: "9007199254740992" }]) assert.equal(validDiscoveryArgs(args), false);
  for (const page of [{ items: [] }, { items: [], next: "8" }, { items: [row("4")], next: "9" }, { items: [row("4")], next: "4" }]) {
    assert.equal(validDiscoveryPage(page, { limit: 1, after: "3" }), true);
    assert.deepEqual(responseResult({ version: 1, id: "read", ok: true, result: page }, "read", { command: "list_chats", args: { limit: 1, after: "3" } }), page);
  }
  const invalid: unknown[] = [
    { items: [], next: "3" }, { items: [], next: "2" }, { items: [row("3")] },
    { items: [row("5"), row("4")] }, { items: [row("4"), row("4")] },
    { items: [row("4"), row("5")], next: "4" }, { items: [row("9007199254740992")] },
    { items: [row("4")], next: "9007199254740992" }, { items: [row("4")], next: null },
    { items: [{ ...row("4"), parentChatId: "1" }] },
    { items: [{ ...row("4"), parentChatId: "1", ownerTaskId: "9007199254740992" }] },
    { items: [{ ...row("4"), kind: "other" }] }, { items: [{ ...row("4"), private: "PRIVATE" }] },
    { items: [row("4")], private: "PRIVATE" }, { items: [row("4"), row("5"), row("6")] },
    { items: new Array(2) },
  ];
  for (const page of invalid) {
    assert.equal(validDiscoveryPage(page, { limit: 2, after: "3" }), false, JSON.stringify(page));
    assert.throws(() => responseResult({ version: 1, id: "read", ok: true, result: page }, "read", { command: "list_chats", args: { limit: 2, after: "3" } }), /^Error: Invalid chat discovery response; cursor unchanged$/);
  }
  // These constraints are semantic, not secretly authored in a language type.
  assert.equal(validChatListPage({ items: [row("5"), row("4")] }), true);
  assert.equal(validChatListPage({ items: [row("9007199254740992")] }), true);
  assert.equal(validDiscoveryPage({ items: [row("4")] }, { after: "9007199254740992" }), false);
  assert.equal(validDiscoveryPage({ items: [row("4")] }, { limit: 1 }), true);
  assert.equal(validDiscoveryPage({ items: [row("4"), row("5")] }, { limit: 1 }), false);
  assert.equal(validDiscoveryPage({ items: [{ ...row("4"), kind: "subagent", parentChatId: "1", ownerTaskId: "9" }] }), true);
  assert.equal(validDiscoveryPage({ items: [] }, null), true); // Legacy envelope default.
});

test("IPC rejects invalid discovery args before reading and invalid serialized pages without replay/private output", async () => {
  const input = new PassThrough(), output = new PassThrough(), decoder = new FrameDecoder();
  const waiting = new Map<string, (value: Record<string, unknown>) => void>();
  const calls: unknown[] = [];
  let page: unknown = { items: [row("2")], next: "3" };
  output.pipe(decoder); decoder.on("data", (reply: Record<string, unknown>) => { waiting.get(String(reply.id))!(reply); });
  const runtime = { listChats: async (args: unknown) => { calls.push(args); return page; } } as unknown as DeckRuntime;
  const serving = serveIpc(runtime, input, output);
  let id = 0;
  const call = async (args?: unknown) => {
    const key = `read-${++id}`;
    const reply = new Promise<Record<string, unknown>>((resolve) => waiting.set(key, resolve));
    input.write(encodeFrame({ version: 1, id: key, command: "list_chats", ...(args === undefined ? {} : { args }) })); return reply;
  };
  try {
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "2" }, { after: "01" }, { after: "9007199254740992" }, { after: null }, []]) {
      const reply = await call(args); assert.equal(reply.ok, false); assert.equal((reply.error as { code: string }).code, "invalid");
    }
    assert.equal(calls.length, 0);
    assert.equal((await call({ limit: 1, extension: "ignored" })).ok, true);
    assert.deepEqual(calls, [{ limit: 1 }]); // Extensions are not forwarded.
    assert.equal((await call()).ok, true); assert.equal((await call(null)).ok, true);
    for (const invalid of [
      { items: [row("4"), row("5")] }, // Too many for original request limit.
      { items: [row("3")] }, { items: [], next: "3" },
      { items: [{ ...row("4"), private: "PRIVATE-OUTPUT" }] },
      { items: [row("4")], toJSON() { return { items: [row("4")], next: null, private: "PRIVATE-OUTPUT" }; } },
    ]) {
      page = invalid;
      const before: number = calls.length;
      const reply = await call({ after: "3", limit: 1 });
      assert.equal(reply.ok, false); assert.equal((reply.error as { code: string }).code, "invalid_response");
      assert.equal(calls.length, before + 1); assert.doesNotMatch(JSON.stringify(reply), /PRIVATE-OUTPUT/);
    }
    page = { items: [], next: "9" };
    assert.equal((await call({ after: "3", limit: 1 })).ok, true); // Bad output did not poison later reads.
  } finally { input.end(); await serving; }
});
