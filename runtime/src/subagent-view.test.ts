import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DeckRuntime, ChatDoc } from "./deck.js";
import { dispatch } from "./ipc.js";
import { responseFrame, responseResult } from "./responses.js";
import { validClientRequest } from "./command-contracts.js";
import { validSubagentViewArgs, validSubagentViewReply } from "./subagent-view-contracts.js";
import { TuiSession, validReply, validRequest } from "./tui-session.js";
import { DraftStore } from "./drafts.js";
import { namedChildren } from "./subagent-view.test.support.js";
import { IMPLEMENTATION, provider, model } from "./instructions.test.support.js";
import type { TuiRequest } from "./generated/contracts.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deck-subagent-view-")), path = join(root, "pi.sqlite");
  const runtime = await DeckRuntime.open(path, { models: provider().models, model, implementation: IMPLEMENTATION, environment: () => undefined, binding: { machineId: "a".repeat(32), cwd: root } });
  const parent = String(runtime.main.id), children = await namedChildren(runtime, parent, 18);
  const request = (args: object) => ({ version: 1, id: "read", command: "subagent_view", args, hubId: runtime.hubId });
  const read = async (args: object) => {
    const req = request(args), result = await dispatch(runtime, req);
    const encoded = JSON.parse(responseFrame({ version: 1, id: "read", ok: true, result }, req).subarray(4).toString());
    return responseResult(encoded, "read", req) as any;
  };
  return { root, path, runtime, parent, children, read, request, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
function stored(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => ({ name: row.name, rows: db.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all() })); }
  finally { db.close(); }
}
test("subagent_view resolves all global case-insensitive claims but exposes only coherent direct children, without writes", async () => {
  const f = await fixture();
  try {
    const first = f.children[0]!;
    const sidebar = (await f.runtime.activity(f.parent, false, true)).subagents!;
    assert.equal(sidebar.items.length, 16); assert.equal(sidebar.items.some(c => c.chatId === first.chatId), false);
    const other = await f.runtime.createTask("Other", { machineId: "a".repeat(32), cwd: f.root });
    const outside = (await namedChildren(f.runtime, String(other.id)))[0]!;
    const before = stored(f.path);
    for (const name of [first.name, first.name.toLowerCase(), first.name[0] + first.name.slice(1).toLowerCase()]) {
      const view = await f.read({ chatId: f.parent, name, operation: "status" });
      assert.equal(view.childId, first.chatId); assert.equal(view.result.binding.kind, "subagent"); assert.equal(view.result.activity, undefined);
    }
    for (const operation of ["history", "activity", "progress", "model_settings"]) {
      const view = await f.read({ chatId: f.parent, childId: first.chatId, operation });
      assert.equal(view.operation, operation);
    }
    for (const name of ["missing", "hub", outside.name]) await assert.rejects(f.read({ chatId: f.parent, name, operation: "status" }));
    await assert.rejects(f.read({ chatId: f.parent, childId: String(other.id), operation: "status" }));
    assert.deepEqual(stored(f.path), before);
    const child = await f.runtime.chat(first.chatId);
    await child.commit(async tx => { (await tx.doc(ChatDoc, child.id)).ownerTaskId = "1"; }, context);
    // A resolved child ID is not a reusable grant: every subsequent read checks metadata/ownership.
    for (const operation of ["status", "history", "activity", "progress", "model_settings"]) await assert.rejects(f.read({ chatId: f.parent, childId: first.chatId, operation }));
  } finally { await f.close(); }
});
test("subagent wrapper validates both operation result and parent/child correlation on ingress and egress", async () => {
  const f = await fixture();
  try {
    const child = f.children[0]!, args = { chatId: f.parent, childId: child.chatId, operation: "activity" };
    assert.ok(validClientRequest(f.request(args)));
    for (const bad of [{ ...args, operation: "stop" }, { ...args, options: { chatId: "1" } }, { ...args, name: child.name }, { ...args, childId: undefined }, { ...args, options: { unknown: true } }, { ...args, childId: f.parent }]) assert.equal(validSubagentViewArgs(bad), false);
    const value = await f.read(args), request = f.request(args);
    for (const bad of [{ ...value, childId: f.children[1]!.chatId }, { ...value, parentChatId: child.chatId }, { ...value, operation: "progress" }, { ...value, result: { ...value.result, chatId: f.parent } }, { ...value, result: { ...value.result, busy: "yes" } }, { ...value, result: { ...value.result, subagents: { chatId: f.parent, items: [], hasMore: false } } }]) {
      assert.equal(validSubagentViewReply(request, bad), false);
      assert.throws(() => responseResult({ version: 1, id: "read", ok: true, result: bad }, "read", request));
      assert.equal(JSON.parse(responseFrame({ version: 1, id: "read", ok: true, result: bad }, request).subarray(4).toString()).ok, false);
    }
    for (const text of [child.name, child.name.toLowerCase()]) assert.ok(validRequest({ version: 1, id: "a", action: "subagent", text }));
    for (const text of ["", " bad", "x\n", "x".repeat(65), "é", "1abc"]) assert.equal(validRequest({ version: 1, id: "a", action: "subagent", text }), false);
    assert.equal(validRequest({ version: 1, id: "a", action: "parent", text: "x" }), false);
  } finally { await f.close(); }
});
for (const task of [false, true]) test(`TUI child inspection keeps ${task ? "attached task" : "hub"} parent scope, blocks effects and returns without child drafts`, async () => {
  const f = await fixture();
  try {
    const parent = task ? String((await f.runtime.createTask("Attached", { machineId: "a".repeat(32), cwd: f.root })).id) : f.parent;
    const children = task ? await namedChildren(f.runtime, parent, 2) : f.children;
    const first = children[0]!, sibling = children[1]!;
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const draftRoot = join(f.root, "drafts"), store = new DraftStore(f.runtime.hubId, draftRoot);
    await store.save({ kind: "input", chatId: first.chatId, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: "NEVER LOAD CHILD", mode: "steer" });
    const session = new TuiSession(async (command, args, hubId) => { calls.push({ command, args }); return dispatch(f.runtime, { command, args, hubId, id: "read" }); }, parent, f.runtime.hubId, draftRoot);
    if (task) await session.registerAttachment("a".repeat(32));
    const act = (action: TuiRequest["action"], fields = {}) => session.handle({ version: 1, id: "a", action, ...fields });
    await act("poll");
    const selected = await act("subagent", { text: first.name.toLowerCase() });
    assert.equal(selected.chatId, first.chatId); assert.equal(selected.inspectParentChatId, parent); assert.equal(selected.clientMode, task ? "task" : "hub"); assert.equal(selected.draft, null);
    assert.ok(validReply({ version: 1, id: "a", ok: true, snapshot: selected }, "a", f.runtime.hubId, parent, "subagent", undefined, undefined, selected.clientMode, f.parent));
    const selection = (await f.runtime.modelSettings(first.chatId)).selection;
    const n = calls.length;
    await assert.rejects(act("configure", { configuration: { expected: selection, selection } }), /Read-only/);
    for (const action of ["send", "retry", "discard", "stop", "agentsmd", "rexOpen", "create"] as const) await assert.rejects(act(action, action === "send" || action === "create" ? { text: "forbidden" } : {}), /Read-only/);
    assert.equal(calls.length, n);
    await act("poll"); await act("poll", { hold: true }); await act("models"); await act("older"); await act("latest");
    assert.ok(calls.slice(n).every(c => c.command === "subagent_view" && c.args.chatId === parent && c.args.childId === first.chatId));
    await assert.rejects(act("subagent", { text: "missing" }));
    assert.equal((await act("poll")).chatId, first.chatId);
    const next = await act("subagent", { text: sibling.name }); assert.equal(next.inspectParentChatId, parent); assert.equal(next.chatId, sibling.chatId);
    const restored = await act("parent"); assert.equal(restored.chatId, parent); assert.equal(restored.inspectParentChatId, undefined);
    assert.ok(validReply({ version: 1, id: "a", ok: true, snapshot: restored }, "a", f.runtime.hubId, sibling.chatId, "parent", undefined, undefined, restored.clientMode, f.parent, parent));
    assert.equal((await store.load("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).request.chatId, first.chatId);
    if (task) await assert.rejects(act("select", { chatId: first.chatId }), /locked/);
    await assert.rejects(act("parent"), /Not inspecting/);
  } finally { await f.close(); }
});

test("subagent reads suppress results if child metadata changes while sampling", async () => {
  const f = await fixture();
  try {
    const child = await f.runtime.chat(f.children[0]!.chatId), original = f.runtime.history.bind(f.runtime);
    f.runtime.history = async (...args) => {
      const page = await original(...args);
      await child.commit(async tx => { (await tx.doc(ChatDoc, child.id)).parentChatId = "99999"; }, context);
      return page;
    };
    await assert.rejects(f.read({ chatId: f.parent, childId: String(child.id), operation: "history" }), /coherent direct subagent/);
  } finally { await f.close(); }
});
test("subagent navigation never loses unresolved parent drafts or uncertain settings", async () => {
  const f = await fixture();
  try {
    const draftRoot = join(f.root, "drafts"), store = new DraftStore(f.runtime.hubId, draftRoot), id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await store.save({ kind: "input", chatId: f.parent, requestId: id, text: "saved parent input", mode: "steer" });
    let subagentCalls = 0, settingsFail = true;
    const session = new TuiSession(async (command, args, hubId) => {
      if (command === "subagent_view") subagentCalls++;
      if (command === "model_settings" && settingsFail) throw new Error("Settings unavailable");
      return dispatch(f.runtime, { command, args, hubId });
    }, f.parent, f.runtime.hubId, draftRoot);
    const action = (action: TuiRequest["action"], fields = {}) => session.handle({ version: 1, id: "a", action, ...fields });
    await assert.rejects(action("poll"), /Settings unavailable/);
    await assert.rejects(action("subagent", { text: f.children[0]!.name }), /saved requests\/settings/);
    assert.equal(subagentCalls, 0); assert.equal((await store.load(id)).request.chatId, f.parent);
    await action("discard"); // Explicit resolution only; unconfirmed settings still gate navigation.
    await assert.rejects(action("subagent", { text: f.children[0]!.name }), /saved requests\/settings/);
    settingsFail = false; await action("poll");
    assert.equal((await action("subagent", { text: f.children[0]!.name })).inspectParentChatId, f.parent);
  } finally { await f.close(); }
});

test("failed first child or return history leaves the previous renderer selection intact", async () => {
  const f = await fixture();
  try {
    let failChild = false, failParent = false;
    const session = new TuiSession(async (command, args, hubId) => {
      if ((failChild && command === "subagent_view" && args.operation === "history") || (failParent && command === "history")) throw new Error("History read failed");
      return dispatch(f.runtime, { command, args, hubId });
    }, f.parent, f.runtime.hubId, join(f.root, "drafts"));
    const act = (action: TuiRequest["action"], fields = {}) => session.handle({ version: 1, id: "a", action, ...fields });
    await act("poll"); failChild = true;
    await assert.rejects(act("subagent", { text: f.children[0]!.name }), /History read failed/);
    assert.equal((await act("poll")).chatId, f.parent);
    failChild = false; await act("subagent", { text: f.children[0]!.name }); failParent = true;
    await assert.rejects(act("parent"), /History read failed/);
    assert.equal((await act("poll")).chatId, f.children[0]!.chatId);
    failParent = false; assert.equal((await act("parent")).chatId, f.parent);
  } finally { await f.close(); }
});
