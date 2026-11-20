import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";
import { HubError } from "./responses.js";
import { TuiSession, validReply, validRequest } from "./tui-session.js";
import type { HistoryEntry, TuiRequest } from "./generated/contracts.js";

const message = (id: number, text = `Message ${id}`): HistoryEntry => ({ id, kind: "deck.input", data: { text } });
const hidden = (id: number): HistoryEntry => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "private" }] }] });
async function fixture(retained: HistoryEntry[], pageSize = 80) {
  const local = await clientEnv(), calls: { name: string, args: Record<string, any> }[] = [];
  const flags = { maximum: 80, fail: false };
  const activity = { chatId: "1", busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false };
  const session = new TuiSession(async (name, args) => {
    calls.push({ name, args });
    if (name === "status") return { hubId: "newer-test", hubGuard: 1, mainChatId: "1", chatId: "1", model: { provider: "mock", modelId: "echo" }, tools: "offline" };
    if (name === "activity") return activity;
    if (name === "progress") return { version: 1, chatId: "1", provisional: true };
    assert.equal(name, "history");
    if (args.after !== undefined && flags.fail) throw new Error("forward unavailable");
    if (args.after !== undefined && Number(args.limit) > flags.maximum) throw new HubError("too_large", "reduce page", "history");
    const eligible = retained.filter(e => (args.before === undefined || e.id < Number(args.before)) && (args.after === undefined || e.id > Number(args.after)));
    if (args.after === undefined) eligible.reverse();
    const items = eligible.slice(0, Math.min(pageSize, Number(args.limit)));
    return { items, ...(items.length < eligible.length ? { next: String(items.at(-1)!.id) } : {}), activity };
  }, undefined, undefined, local.env.DECK_CLIENT_STATE_DIRECTORY);
  const act = (action: TuiRequest["action"], args: Partial<TuiRequest> = {}) => session.handle({ version: 1, id: randomUUID(), action, ...args });
  return { local, calls, flags, session, act };
}

test("forward reads are oldest-first, transient and nonmutating across sparse pages, saved drafts, errors and live appends", async () => {
  const retained = [message(7), hidden(14), hidden(21), message(28), message(35)];
  const f = await fixture(retained, 2);
  try {
    const store = new DraftStore("newer-test", f.local.env.DECK_CLIENT_STATE_DIRECTORY);
    const draft = { kind: "input" as const, chatId: "1", requestId: randomUUID(), text: " exact saved 🧪\n ", mode: "steer" as const };
    await store.save(draft);
    const path = join(store.directory, `${draft.requestId}.json`), bytes = await readFile(path);
    await f.act("poll");
    const old = await f.act("older");
    const sparse = await f.act("newer", { after: "7" });
    const { newerAfter, newerFound, newerNext, ...unchanged } = sparse;
    assert.deepEqual(unchanged, old); assert.equal(newerAfter, "7"); assert.equal(newerFound, false); assert.equal(newerNext, "21");
    const found = await f.act("newer", { after: newerNext });
    assert.equal(found.newerFound, true); assert.deepEqual(found.entries.map(e => e.id), [28, 35]);
    assert.equal(found.hasOlder, true); assert.equal(found.historical, false); assert.equal(found.newerNext, undefined);
    assert.deepEqual(await f.act("poll", { hold: true }), old, "Even a found reply can be cancelled without helper state divergence");
    const priorBefore = f.calls.filter(c => c.name === "history").find(c => c.args.before !== undefined)!.args.before;
    await f.act("older");
    assert.notEqual(f.calls.at(-1)!.args.before, priorBefore);
    assert.equal(f.calls.at(-1)!.args.before, "14", "Forward reads cannot advance the older cursor");
    const latest = await f.act("latest");
    retained.push(message(42));
    assert.deepEqual((await f.act("poll", { hold: true })).entries, latest.entries);
    const appended = await f.act("newer", { after: "35" });
    assert.deepEqual(appended.entries.map(e => e.id), [42]);
    f.flags.fail = true;
    await assert.rejects(f.act("newer", { after: "42" }), /forward unavailable/);
    assert.deepEqual(await f.act("poll", { hold: true }), latest);
    f.flags.fail = false;
    assert.equal((await f.act("newer", { after: "42" })).newerFound, false);
    await f.act("older", { before: "42" });
    assert.equal(f.calls.at(-1)!.args.before, "42", "Locally adopted pages can reload their previous page explicitly");
    assert.deepEqual(await readFile(path), bytes);
  } finally { await f.local.close(); }
});

test("forward projection truncates only its ascending tail under text, wire and entry budgets", async () => {
  for (const text of ["x".repeat(8192), '"'.repeat(8192), "short"]) {
    const f = await fixture(Array.from({ length: 100 }, (_, i) => message(i + 1, text)));
    try {
      await f.act("poll");
      const next = await f.act("newer", { after: "1" });
      assert.equal(next.entries[0]!.id, 2);
      assert.ok(next.entries.length <= 80);
      assert.ok(next.entries.reduce((n, e) => n + Buffer.byteLength(e.text), 0) <= 128 * 1024);
      assert.ok(next.entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0) <= 512 * 1024);
      assert.equal(next.newerNext, String(next.entries.at(-1)!.id));
      const following = await f.act("newer", { after: next.newerNext });
      assert.equal(following.entries[0]!.id, next.entries.at(-1)!.id + 1, "Never skip intermediate messages to keep a latest suffix");
    } finally { await f.local.close(); }
  }
});

test("forward history reduces oversized pages and correlates safe cursors only to newer replies", async () => {
  const f = await fixture(Array.from({ length: 10 }, (_, i) => message(i + 1)));
  try {
    await f.act("poll"); f.flags.maximum = 1;
    const snapshot = await f.act("newer", { after: "1" });
    assert.deepEqual(f.calls.filter(c => c.args.after !== undefined).map(c => c.args.limit), [80, 40, 20, 10, 5, 2, 1]);
    const response = { version: 1, id: "reply", ok: true, snapshot };
    assert.equal(validReply(response, "reply", "newer-test", "1", "newer", undefined, "1"), true);
    assert.equal(validReply(response, "reply", "newer-test", "1", "newer", undefined, "2"), false);
    assert.equal(validReply(response, "reply", "newer-test", "1", "poll"), false);
    for (const patch of [{ newerAfter: undefined }, { newerFound: undefined }, { newerNext: "1" }, { newerNext: "9007199254740992" }, { entries: [] }]) {
      assert.equal(validReply({ ...response, snapshot: { ...snapshot, ...patch } }, "reply", "newer-test", "1", "newer", undefined, "1"), false);
    }
    const request = { version: 1, id: "request", action: "newer", after: "1" };
    assert.equal(validRequest(request), true);
    for (const patch of [{ after: undefined }, { after: "0" }, { after: "9007199254740992" }, { hold: true }, { before: "2" }, { action: "poll" }]) assert.equal(validRequest({ ...request, ...patch }), false);
    assert.equal(validRequest({ version: 1, id: "request", action: "older", before: "2" }), true);
    assert.equal(validRequest({ version: 1, id: "request", action: "poll", before: "2" }), false);
  } finally { await f.local.close(); }
});

test("captured task inspection forwards after through the original parent pin and never gains navigation authority", async () => {
  const local = await clientEnv(), hubId = randomUUID(), machineId = "a".repeat(32);
  const calls: { name: string, args: Record<string, any> }[] = [];
  const status = (child = false) => ({ hubId, hubGuard: 1, mainChatId: "1", chatId: child ? "3" : "2", model: { provider: "mock", modelId: "echo" }, tools: "offline",
    binding: { machineId, cwd: "/saved", kind: child ? "subagent" : "task", title: "Read only", ...(child ? { parentChatId: "2", ownerTaskId: "1", agentName: "WM001", agentNameAlgorithm: "subagent-v1" } : {}) } });
  const session = new TuiSession(async (name, args) => {
    calls.push({ name, args });
    if (name === "status") return status();
    if (name === "history") return { items: [message(1)] };
    assert.equal(name, "subagent_view"); assert.equal(args.chatId, "2");
    const result = args.operation === "status" ? status(true) : { items: [message((args.options as any)?.after ? 14 : 7)] };
    return { hubId, parentChatId: "2", childId: "3", operation: args.operation, ...(args.name ? { name: args.name } : {}), result };
  }, "2", hubId, local.env.DECK_CLIENT_STATE_DIRECTORY);
  const act = (action: TuiRequest["action"], args: Partial<TuiRequest> = {}) => session.handle({ version: 1, id: randomUUID(), action, ...args });
  try {
    await session.registerAttachment(machineId);
    await act("subagent", { text: "wm001" });
    const next = await act("newer", { after: "7" });
    assert.equal(next.chatId, "3"); assert.equal(next.clientMode, "task"); assert.equal(next.inspectParentChatId, "2");
    assert.equal(next.newerFound, true); assert.equal(next.entries[0]!.id, 14); assert.equal(next.draft, null);
    assert.deepEqual(calls.at(-1), { name: "subagent_view", args: { chatId: "2", childId: "3", operation: "history", options: { limit: 80, after: "7", includeActivity: true, includeAgentStatus: true, includeSubagents: true, includeProgress: true } } });
    await assert.rejects(act("send", { text: "no write" }), /Read-only/);
    assert.equal(validReply({ version: 1, id: "reply", ok: true, snapshot: next }, "reply", hubId, "3", "newer", undefined, "7", "task", "1", "2"), true);
  } finally { await local.close(); }
});
