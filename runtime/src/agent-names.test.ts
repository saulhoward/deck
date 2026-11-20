import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc, defineDocFamily, type ConversationId } from "@earendil-works/pi-durable";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { agentNameAlgorithms, agentRunes, assignAgentName, assignSubagentName, lookupAgentName, shuffledNameOrder, subagentNameAlgorithm, subagentNamePrefix } from "./agent-names.js";
import { validAgentName, validStatusBinding, validChatListItem, validTuiSnapshot } from "./generated/contracts.js";
import { dispatch } from "./ipc.js";
import { TuiSession } from "./tui-session.js";

const v1 = agentNameAlgorithms["wintermute-v1"]!;
test("wintermute-v1 is deterministic, covers both banks, and stays unique after pair exhaustion", () => {
  assert.equal(v1.candidate(0), "wintermute");
  assert.equal(v1.candidate(1), "glasscut");
  assert.equal(v1.candidate(99), "midnightwatch");
  assert.equal(v1.candidate(100), "wintermute-2");
  const names = Array.from({ length: 10000 }, (_, i) => v1.candidate(i));
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(validAgentName));
  assert.ok(names.slice(0, 100).every(name => /^[a-z]+$/.test(name)));
  assert.ok(validAgentName(v1.candidate(Number.MAX_SAFE_INTEGER - 1)));
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => v1.candidate(n));
  for (const bad of ["", "WinterMute", "winter mute", "wintermute\n", "\x1b[31mwintermute", "a".repeat(65)]) {
    assert.equal(validAgentName(bad), false);
    assert.equal(validStatusBinding({ machineId: "host", cwd: "/cwd", kind: "task", title: "Title", agentName: bad }), false);
  }
});

test("allocation shuffles the existing bank, with no fixed first name or excluded wintermute", () => {
  const unchanged = shuffledNameOrder(max => max - 1);
  const rotated = shuffledNameOrder(() => 0);
  assert.deepEqual(unchanged, Array.from({ length: 100 }, (_, i) => i));
  assert.equal(v1.candidate(unchanged[0]!), "wintermute");
  assert.equal(v1.candidate(rotated[0]!), "glasscut");
  for (const order of [unchanged, rotated, shuffledNameOrder()]) {
    assert.equal(new Set(order).size, 100);
    assert.deepEqual([...order].sort((a, b) => a - b), unchanged);
    assert.equal(new Set(order.map(n => v1.candidate(n))).size, 100);
  }
});

async function fixture(native = false) {
  const directory = await mkdtemp(join(tmpdir(), "deck-agent-names-"));
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const options = { implementation: "a".repeat(64), models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: "host", cwd: directory }, environment: () => undefined, ...(native ? { hostFiles: { call: async () => { throw new Error("No native effects expected"); } } } : {}) };
  const path = join(directory, "pi.sqlite"); let runtime = await DeckRuntime.open(path, options);
  return { directory, options, faux, get runtime() { return runtime; },
    restart: async () => { await runtime.close(); runtime = await DeckRuntime.open(path, options); },
    close: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("names are atomic, unique across versions, stable on retry/restart, and not derived from titles", async () => {
  const f = await fixture();
  try {
    const main = await f.runtime.harness.snapshot(ChatDoc, f.runtime.main.id, context);
    assert.equal(main!.agentName, "hub"); assert.equal(main!.agentNameAlgorithm, "hub-v1"); assert.equal(main!.agentRune, "Δ");
    const bindingOnly = await f.runtime.createTask("Binding only", main!);
    assert.notEqual((await f.runtime.harness.snapshot(ChatDoc, bindingOnly.id, context))!.agentName, main!.agentName);
    await assert.rejects(f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      const metadata = await tx.doc(ChatDoc, id); Object.assign(metadata, main);
      await assignAgentName(tx, id, metadata);
    } }, context), /already belongs|Invalid saved agent rune/);
    const tasks = await Promise.all(Array.from({ length: 110 }, (_, i) => f.runtime.createTask("Same title", f.options.binding, `request-${i}`)));
    const saved = await Promise.all(tasks.map(t => f.runtime.harness.snapshot(ChatDoc, t.id, context)));
    assert.equal(new Set([main, ...saved].map(s => s!.agentName)).size, 111);
    assert.ok(saved.every(s => s!.agentNameAlgorithm === v1.id));
    const firstName = (await f.runtime.harness.snapshot(ChatDoc, bindingOnly.id, context))!.agentName!;
    assert.deepEqual(new Set([firstName, ...saved.slice(0, 99).map(s => s!.agentName!)]), new Set(Array.from({ length: 100 }, (_, i) => v1.candidate(i))));
    assert.ok(saved.slice(99).every(s => s!.agentName!.endsWith("-2")));
    assert.equal(new Set(saved.slice(0, 86).map(s => s!.agentRune)).size, 86);
    assert.ok(saved.every(s => agentRunes.includes(s!.agentRune!)));
    assert.equal(saved[0]!.agentRune, saved[86]!.agentRune);
    assert.equal((await f.runtime.createTask("Same title", f.options.binding, "request-0")).id, tasks[0]!.id);
    await assert.rejects(f.runtime.createTask("Changed request", f.options.binding, "request-0"), /different arguments/);
    let rolledBackName: string | undefined, rolledBackRune: string | undefined;
    await assert.rejects(f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      const metadata = await tx.doc(ChatDoc, id); await assignAgentName(tx, id, metadata); rolledBackName = metadata.agentName; rolledBackRune = metadata.agentRune;
      throw new Error("Roll back creation");
    } }, context), /Roll back creation/);
    const next = await f.runtime.createTask("After rollback", f.options.binding);
    assert.equal((await f.runtime.harness.snapshot(ChatDoc, next.id, context))!.agentName, rolledBackName);
    assert.equal((await f.runtime.harness.snapshot(ChatDoc, next.id, context))!.agentRune, rolledBackRune);
    // Reservations are shared across versions, regardless of shuffled order.
    let attempts = 0;
    const future = await f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      const metadata = await tx.doc(ChatDoc, id);
      await assignAgentName(tx, id, metadata, { id: "test-v2", candidate: () => ++attempts === 1 ? firstName : "future-name" });
    } }, context);
    const futureSaved = await f.runtime.harness.snapshot(ChatDoc, future.id, context);
    assert.equal(futureSaved!.agentNameAlgorithm, "test-v2");
    assert.equal(attempts, 2); assert.equal(futureSaved!.agentName, "future-name");
    const afterFuture = await f.runtime.createTask("Collision after version change", f.options.binding);
    const afterSaved = await f.runtime.harness.snapshot(ChatDoc, afterFuture.id, context);
    assert.notEqual(afterSaved!.agentName, futureSaved!.agentName);
    assert.ok(validAgentName(afterSaved!.agentName));
    await tasks[0]!.commit(async tx => { (await tx.doc(ChatDoc, tasks[0]!.id)).title = "Renamed title"; }, context);
    await f.restart();
    assert.equal((await f.runtime.harness.snapshot(ChatDoc, tasks[0]!.id, context))!.agentName, saved[0]!.agentName);
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, future.id, context), futureSaved);
    assert.equal(f.faux.state.callCount, 0);
    const page = await f.runtime.listChats({ limit: 100 });
    assert.ok(page.items.every(item => item.agentName && validChatListItem(item)));
  } finally { await f.close(); }
});

test("legacy sequential cursors acquire a persisted shuffle without renaming or duplicating claims", async () => {
  const f = await fixture();
  const Cursor = defineDoc<{ next: number; order?: number[] }>({ kind: "deck.agent-name-cursor", version: 1, scope: "session", initial: () => ({ next: 0 }), checkpointWhen: () => true });
  try {
    const old: Array<{ id: ConversationId; name: string }> = [];
    for (let i = 0; i < 7; i++) {
      const task = await f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
        const metadata = await tx.doc(ChatDoc, id);
        Object.assign(metadata, { kind: "task", title: "Legacy", ...f.options.binding });
        await assignAgentName(tx, id, metadata, { id: v1.id, candidate: () => v1.candidate(i) });
      } }, context);
      old.push({ id: task.id, name: v1.candidate(i) });
    }
    await f.runtime.main.commit(async tx => { delete (await tx.doc(Cursor)).order; }, context);
    await f.restart();
    const names = new Set(old.map(task => task.name));
    for (let i = 0; i < 103; i++) {
      const task = await f.runtime.createTask("New", f.options.binding);
      const saved = (await f.runtime.harness.snapshot(ChatDoc, task.id, context))!;
      assert.ok(!names.has(saved.agentName!)); names.add(saved.agentName!);
    }
    const cursor = await f.runtime.harness.snapshot(Cursor, context);
    assert.equal(cursor!.order!.length, 100);
    assert.ok(cursor!.next >= 110);
    await f.restart();
    assert.deepEqual(await f.runtime.harness.snapshot(Cursor, context), cursor);
    for (const task of old) assert.equal((await f.runtime.harness.snapshot(ChatDoc, task.id, context))!.agentName, task.name);
  } finally { await f.close(); }
});

test("startup renames only canonical hub and permanently retains its legacy name claim", async () => {
  const f = await fixture();
  try {
    await f.runtime.main.commit(async tx => {
      const metadata = await tx.doc(ChatDoc, f.runtime.main.id);
      metadata.agentName = "wintermute"; metadata.agentNameAlgorithm = "wintermute-v1";
    }, context);
    const before = (await f.runtime.harness.snapshot(ChatDoc, f.runtime.main.id, context))!;
    const history = await f.runtime.history(String(f.runtime.main.id));
    await f.restart();
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, f.runtime.main.id, context), { ...before, agentName: "hub", agentNameAlgorithm: "hub-v1" });
    assert.deepEqual(await f.runtime.history(String(f.runtime.main.id)), history);
    // Force a collision to prove the old claim is retained, independent of RNG.
    let attempts = 0;
    const next = await f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      const metadata = await tx.doc(ChatDoc, id);
      Object.assign(metadata, { kind: "task", title: "Not the hub", ...f.options.binding });
      await assignAgentName(tx, id, metadata, { id: "test-v2", candidate: () => ++attempts === 1 ? "wintermute" : "glasscut" });
    } }, context);
    const saved = (await f.runtime.harness.snapshot(ChatDoc, next.id, context))!;
    assert.equal(attempts, 2); assert.equal(saved.agentName, "glasscut");
    assert.equal(saved.agentRune, agentRunes[0]); // renaming consumed no rune
    await f.restart();
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, next.id, context), saved);
    assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});

test("startup backfills legacy Deck metadata without touching history, bindings or unmanaged conversations", async () => {
  const f = await fixture();
  try {
    const old = { kind: "task" as const, title: "Exact title", machineId: "offline", cwd: "/exact cwd", brief: { problem: "", description: "Exact\n  brief" } };
    const legacy = await f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      Object.assign(await tx.doc(ChatDoc, id), old);
      await tx.appendEntry(id, { kind: "deck.input", data: { text: "Exact history" } });
    } }, context);
    for (let i = 0; i < 101; i++) await f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      Object.assign(await tx.doc(ChatDoc, id), old);
    } }, context);
    const unmanaged = await f.runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const history = await f.runtime.history(String(legacy.id));
    await f.restart();
    const saved = (await f.runtime.harness.snapshot(ChatDoc, legacy.id, context))!;
    assert.ok(validAgentName(saved.agentName)); assert.equal(saved.agentNameAlgorithm, v1.id);
    const { agentName, agentNameAlgorithm, agentRune, ...retained } = saved;
    assert.ok(agentRunes.includes(agentRune!));
    assert.deepEqual(retained, old);
    assert.deepEqual(await f.runtime.history(String(legacy.id)), history);
    assert.equal(await f.runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
    const page = await f.runtime.listChats({ limit: 100 });
    const tail = await f.runtime.listChats({ limit: 100, after: page.next! });
    const names = [...page.items, ...tail.items].map(item => item.agentName);
    assert.equal(names.length, 103); assert.ok(names.every(validAgentName)); assert.equal(new Set(names).size, 103);
    await f.restart();
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, legacy.id, context), saved);
    assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});

test("TUI receives saved names through status and task pages while assistant roles remain canonical", async () => {
  const f = await fixture();
  try {
    const task = await f.runtime.createTask("Title remains separate", f.options.binding);
    const metadata = (await f.runtime.harness.snapshot(ChatDoc, task.id, context))!;
    await task.commit(tx => tx.appendEntry(task.id, { kind: "pi.assistant", data: {}, model: [{ role: "assistant", content: [{ type: "text", text: "Retained answer" }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 }] }), context);
    const command = (command: string, args: unknown, hubId?: string) => dispatch(f.runtime, { version: 1, id: "test", command, args, ...(hubId ? { hubId } : {}) });
    const ui = new TuiSession(command, String(task.id), f.runtime.hubId, join(f.directory, "drafts"));
    const snapshot = await ui.handle({ version: 1, id: "1", action: "poll" });
    assert.equal(snapshot.agentRune, metadata.agentRune); assert.equal(snapshot.agentName, metadata.agentName); assert.equal(snapshot.title, "Title remains separate");
    assert.ok(validTuiSnapshot(snapshot)); assert.equal(snapshot.entries[0]!.role, "assistant");
    const page = await ui.handle({ version: 1, id: "2", action: "tasks" });
    assert.equal(page.tasks!.items.find(item => item.chatId === String(task.id))!.agentName, metadata.agentName);
    const hub = await ui.handle({ version: 1, id: "3", action: "select", chatId: String(f.runtime.main.id) });
    assert.equal(hub.agentRune, "Δ"); assert.equal(hub.agentName, "hub"); assert.notEqual(hub.agentName, snapshot.agentName);
  } finally { await f.close(); }
});

test("child prefixes use both frozen compound components, with deterministic hub/legacy fallbacks", () => {
  for (const [name, expected] of [
    ["dustspill", "DS"], ["DUSTSPILL", "DS"], ["wintermute", "WM"], ["WinterMute-12", "WM"],
    ["winterwatch", "WW"], ["winterwire", "WW"], ["hub", "HU"], ["HUB", "HU"],
    ["legacy-name", "LE"], ["q", "QX"], ["123", "XX"], ["", "XX"],
  ]) assert.equal(subagentNamePrefix(name), expected);
  assert.equal(subagentNamePrefix(), "XX");
  assert.ok(Array.from({ length: 200 }, (_, i) => subagentNamePrefix(v1.candidate(i))).every(prefix => /^[A-Z]{2}$/.test(prefix)));
});

async function namedParent(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  return f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: f.options.model, cwd: f.options.binding.cwd }, init: async (tx, id) => {
    const metadata = await tx.doc(ChatDoc, id);
    Object.assign(metadata, { kind: "task", title: "Parent", ...f.options.binding });
    await assignAgentName(tx, id, metadata, { id: v1.id, candidate: () => name });
  } }, context);
}
let delegationRequest = 0;
async function namedDelegation(f: Awaited<ReturnType<typeof fixture>>, parentId = f.runtime.main.id, title?: string, task = "Full task\n  with exact details") {
  const requestId = `names-delegation-${++delegationRequest}`;
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("subagent", { task, ...(title === undefined ? {} : { title }) }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Child answer"), fauxAssistantMessage("Parent answer"),
  ]);
  const settled = await (await f.runtime.admit(String(parentId), { requestId, text: "Delegate", mode: "followUp" })).wait(context);
  assert.equal(settled.status, "done");
  const record = await f.runtime.harness.commit(async tx => (await tx.scanConversations({ ownerConversationId: parentId, order: "descending" }, 1)).items[0], context);
  assert.ok(record, "delegation must create a canonical Pi-owned child");
  const metadata = (await f.runtime.harness.snapshot(ChatDoc, record.id, context))!;
  assert.equal(metadata.kind, "subagent"); assert.equal(metadata.agentRune, undefined);
  return { record, metadata, requestId };
}

const ChildCursor = defineDocFamily<{ next: number }, null>({ kind: "deck.subagent-name-cursor", version: 1, scope: "session", family: true, initial: () => ({ next: 1 }), checkpointWhen: () => true });
const OrdinaryCursor = defineDoc<{ next: number; order?: number[] }>({ kind: "deck.agent-name-cursor", version: 1, scope: "session", initial: () => ({ next: 0 }), checkpointWhen: () => true });
const TestRuneCursor = defineDoc<{ next: number }>({ kind: "deck.agent-rune-cursor", version: 1, scope: "session", initial: () => ({ next: 0 }), checkpointWhen: () => true });

test("real children get task briefs and initials, share prefix sequences, and consume no ordinary names or runes", async () => {
  const f = await fixture(true);
  try {
    const dust = await namedParent(f, "dustspill"); const winter = await namedParent(f, "wintermute");
    const watch = await namedParent(f, "winterwatch"); const wire = await namedParent(f, "winterwire");
    const ordinaryCursor = await f.runtime.harness.snapshot(OrdinaryCursor, context);
    const runeCursor = await f.runtime.harness.snapshot(TestRuneCursor, context);
    const hubChild = await namedDelegation(f);
    const dustChild = await namedDelegation(f, dust.id, "Actual task title");
    const winterChild = await namedDelegation(f, winter.id);
    const watchChild = await namedDelegation(f, watch.id); const wireChild = await namedDelegation(f, wire.id);
    assert.equal(hubChild.metadata.agentName, "HU001"); assert.equal(dustChild.metadata.agentName, "DS001");
    assert.equal(winterChild.metadata.agentName, "WM001");
    assert.equal(watchChild.metadata.agentName, "WW001"); assert.equal(wireChild.metadata.agentName, "WW002");
    assert.equal(dustChild.metadata.agentNameAlgorithm, subagentNameAlgorithm);
    assert.deepEqual(dustChild.metadata.brief, { problem: "Actual task title", description: "Full task\n  with exact details" });
    assert.deepEqual(hubChild.metadata.brief, { problem: "Full task", description: "Full task\n  with exact details" });
    assert.deepEqual(await f.runtime.harness.snapshot(OrdinaryCursor, context), ordinaryCursor);
    assert.deepEqual(await f.runtime.harness.snapshot(TestRuneCursor, context), runeCursor);
    // Admission retry reuses the same parent submission/tool task, not a new child.
    assert.equal((await (await f.runtime.admit(String(dust.id), { requestId: dustChild.requestId, text: "Delegate", mode: "followUp" })).wait(context)).status, "done");
    assert.equal((await f.runtime.harness.commit(tx => tx.scanConversations({ ownerConversationId: dust.id }, 10), context)).items.length, 1);
    await f.restart();
    for (const child of [hubChild, dustChild, winterChild, watchChild, wireChild]) {
      assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, child.record.id, context), child.metadata);
      assert.equal(await lookupAgentName(f.runtime.harness, child.metadata.agentName!.toLowerCase(), context), child.record.id);
    }
    assert.equal((await namedDelegation(f, watch.id)).metadata.agentName, "WW003");
    assert.deepEqual(await f.runtime.harness.snapshot(TestRuneCursor, context), runeCursor);
  } finally { await f.close(); }
});

test("child claims are global and case-insensitive, grow beyond 999, and roll back with metadata/cursor", async () => {
  const f = await fixture(true);
  try {
    const dust = await namedParent(f, "dustspill");
    const reserved = await namedParent(f, "ds001"); // Legacy/future algorithms share the same claim bank.
    const first = await namedDelegation(f, dust.id);
    assert.equal(first.metadata.agentName, "DS002");
    assert.equal(await lookupAgentName(f.runtime.harness, "DS001", context), reserved.id);
    const cursor = await f.runtime.harness.snapshot(ChildCursor, "DS", context);
    const runeCursor = await f.runtime.harness.snapshot(TestRuneCursor, context);
    let rolledBackName: string | undefined;
    await assert.rejects(f.runtime.harness.commit(async tx => {
      const metadata = await tx.doc(ChatDoc, first.record.id);
      delete metadata.agentName; delete metadata.agentNameAlgorithm;
      await assignSubagentName(tx, first.record.id, metadata, { agentName: "dustspill" });
      rolledBackName = metadata.agentName;
      throw new Error("Roll back child identity");
    }, context), /Roll back child identity/);
    assert.equal(rolledBackName, "DS003");
    assert.equal(await lookupAgentName(f.runtime.harness, rolledBackName!, context), undefined);
    assert.deepEqual(await f.runtime.harness.snapshot(ChildCursor, "DS", context), cursor);
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, first.record.id, context), first.metadata);
    assert.equal((await namedDelegation(f, dust.id)).metadata.agentName, rolledBackName);
    await f.runtime.main.commit(async tx => { (await tx.doc(ChildCursor, "DS", null)).next = 999; }, context);
    assert.equal((await namedDelegation(f, dust.id)).metadata.agentName, "DS999");
    const thousand = await namedDelegation(f, dust.id);
    assert.equal(thousand.metadata.agentName, "DS1000");
    assert.deepEqual(await f.runtime.harness.snapshot(TestRuneCursor, context), runeCursor);
    await f.restart();
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, thousand.record.id, context), thousand.metadata);
    assert.equal((await namedDelegation(f, dust.id)).metadata.agentName, "DS1001");
  } finally { await f.close(); }
});

function nameStorage(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => {
      const name = String(row.name); assert.match(name, /^[a-z_]+$/);
      return { name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() };
    });
  } finally { db.close(); }
}

test("global name lookup is strictly read-only on hits, misses and invalid input", async () => {
  const f = await fixture(true);
  try {
    const parent = await namedParent(f, "dustspill"); const child = await namedDelegation(f, parent.id);
    const before = nameStorage(join(f.directory, "pi.sqlite"));
    for (const name of ["hub", "HUB", "Hub"]) assert.equal(await lookupAgentName(f.runtime.harness, name, context), f.runtime.main.id);
    for (const name of ["dustspill", "DUSTSPILL", "DustSpill"]) assert.equal(await lookupAgentName(f.runtime.harness, name, context), parent.id);
    for (const name of ["DS001", "ds001", "Ds001"]) assert.equal(await lookupAgentName(f.runtime.harness, name, context), child.record.id);
    for (const name of ["missing", "ZZ999999", "", " DS001", "DS001\n", "x".repeat(65), "\x1b[31mhub"]) assert.equal(await lookupAgentName(f.runtime.harness, name, context), undefined);
    assert.deepEqual(nameStorage(join(f.directory, "pi.sqlite")), before);
  } finally { await f.close(); }
});

test("startup migrates only coherent Pi-owned children, keeps old claims and ordinary identities, and never uses runes", async () => {
  const f = await fixture(true);
  try {
    const parent = await namedParent(f, "dustspill");
    const named = await namedDelegation(f, parent.id); const unnamed = await namedDelegation(f, parent.id);
    const wrongParent = await namedDelegation(f, parent.id); const wrongTask = await namedDelegation(f, parent.id);
    const unmanaged = await f.runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const forged = await f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      Object.assign(await tx.doc(ChatDoc, id), { kind: "subagent", title: "Forged", ...f.options.binding, parentChatId: String(parent.id), ownerTaskId: String(named.record.owner!.taskId), agentName: "forged-legacy", agentNameAlgorithm: v1.id, agentRune: agentRunes[0] });
    } }, context);
    await f.runtime.main.commit(async tx => {
      const legacy = await tx.doc(ChatDoc, named.record.id);
      Object.assign(legacy, { agentName: "legacy-child", agentNameAlgorithm: v1.id, agentRune: agentRunes[0] });
      const missing = await tx.doc(ChatDoc, unnamed.record.id);
      delete missing.agentName; delete missing.agentNameAlgorithm; missing.agentRune = agentRunes[1]!;
      const wrong1 = await tx.doc(ChatDoc, wrongParent.record.id);
      Object.assign(wrong1, { parentChatId: String(f.runtime.main.id), agentName: "wrong-parent", agentNameAlgorithm: v1.id, agentRune: agentRunes[2] });
      const wrong2 = await tx.doc(ChatDoc, wrongTask.record.id);
      Object.assign(wrong2, { ownerTaskId: "999999999", agentName: "wrong-task", agentNameAlgorithm: v1.id, agentRune: agentRunes[3] });
    }, context);
    const untouched = [f.runtime.main.id, parent.id, wrongParent.record.id, wrongTask.record.id, forged.id];
    const before = await Promise.all(untouched.map(id => f.runtime.harness.snapshot(ChatDoc, id, context)));
    const legacyBefore = (await f.runtime.harness.snapshot(ChatDoc, named.record.id, context))!;
    const history = await f.runtime.history(String(named.record.id));
    const ordinaryCursor = await f.runtime.harness.snapshot(OrdinaryCursor, context);
    const runeCursor = await f.runtime.harness.snapshot(TestRuneCursor, context);
    await f.restart();
    const migrated = (await f.runtime.harness.snapshot(ChatDoc, named.record.id, context))!;
    const { agentRune: _rune, ...withoutRune } = legacyBefore;
    assert.deepEqual(migrated, { ...withoutRune, agentName: "DS005", agentNameAlgorithm: subagentNameAlgorithm });
    assert.equal((await f.runtime.harness.snapshot(ChatDoc, unnamed.record.id, context))!.agentName, "DS006");
    assert.equal((await f.runtime.harness.snapshot(ChatDoc, unnamed.record.id, context))!.agentRune, undefined);
    assert.equal(await lookupAgentName(f.runtime.harness, "LEGACY-CHILD", context), named.record.id);
    assert.equal(await lookupAgentName(f.runtime.harness, "ds001", context), named.record.id); // Earlier claims are never retired either.
    assert.equal(await lookupAgentName(f.runtime.harness, "wrong-parent", context), undefined);
    assert.equal(await lookupAgentName(f.runtime.harness, "forged-legacy", context), undefined);
    assert.equal(await f.runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
    assert.deepEqual(await Promise.all(untouched.map(id => f.runtime.harness.snapshot(ChatDoc, id, context))), before);
    assert.deepEqual(await f.runtime.history(String(named.record.id)), history);
    assert.deepEqual(await f.runtime.harness.snapshot(OrdinaryCursor, context), ordinaryCursor);
    assert.deepEqual(await f.runtime.harness.snapshot(TestRuneCursor, context), runeCursor);
    // Permanent legacy aliases also block allocation by later ordinary algorithms.
    let attempts = 0;
    await f.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      const metadata = await tx.doc(ChatDoc, id); Object.assign(metadata, { kind: "task", ...f.options.binding });
      await assignAgentName(tx, id, metadata, { id: "test-v2", candidate: () => ++attempts === 1 ? "legacy-child" : "new-ordinary" });
    } }, context);
    assert.equal(attempts, 2);
    await f.restart();
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, named.record.id, context), migrated);
    assert.equal((await namedDelegation(f, parent.id)).metadata.agentName, "DS007");
  } finally { await f.close(); }
});
