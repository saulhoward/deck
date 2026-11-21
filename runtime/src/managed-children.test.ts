import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InboxDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { ChatDoc, type DeckRuntime } from "./deck.js";
import { setup } from "./managed-child.test.support.js";
import { namedChildren } from "./subagent-view.test.support.js";
import { validManagedChildren, validActivity } from "./view-contracts.js";
import { serveIpc } from "./ipc.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";

async function fixture(run: (runtime: DeckRuntime, path: string, faux: ReturnType<typeof setup>["faux"]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "deck-managed-children-")), path = join(directory, "pi.sqlite");
  const f = setup({ environment: () => { throw new Error("Read must not resolve a worker"); } });
  const runtime = await f.open(path);
  try { await run(runtime, path, f.faux); }
  finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
}
const sample = async (runtime: DeckRuntime, parent = String(runtime.main.id)) => (await runtime.activity(parent, false, false, true)).children;
// Legacy records need no migration, auxiliary index, input or name allocation.
async function legacy(runtime: DeckRuntime, parent: string | undefined, count: number) {
  return runtime.harness.commit(async tx => {
    const ids: ConversationId[] = [];
    for (let i = 0; i < count; i++) {
      const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
      Object.assign(await tx.doc(ChatDoc, record.id), { kind: "task", title: `Legacy ${i}`, ...(parent ? { managedParentChatId: parent } : {}), machineId: "offline", cwd: "/PRIVATE_PATH", agentName: "helper", agentRune: "ᚠ" });
      ids.push(record.id);
    }
    return ids;
  }, context);
}
function stored(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => {
      const name = String(row.name); assert.match(name, /^[a-z_]+$/);
      return { name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() };
    });
  } finally { db.close(); }
}

test("managed children discover only direct independent tasks, including metadata-only creation and legacy records, without writes or effects", async t => {
  await fixture(async (runtime, path, faux) => {
    const parent = await runtime.createTask("Parent", { machineId: "offline", cwd: "/saved" });
    const parentId = String(parent.id);
    const child = await runtime.createManagedChild(parentId, undefined, "problem", { problem: "Own problem 🧪", description: "" });
    const manual = await runtime.createManagedChild(parentId, "Canonical title", "manual", { problem: " \t\n", description: "PRIVATE_BRIEF" });
    const old = (await legacy(runtime, parentId, 1))[0]!;
    const foreign = await runtime.createManagedChild(String(runtime.main.id), "Foreign", "foreign");
    const grandchild = await runtime.createManagedChild(String(child.id), "Grandchild", "grandchild");
    const [captured] = await namedChildren(runtime, parentId);
    const capturedId = Number(captured!.chatId) as ConversationId;
    // Canonical Pi ownership wins even over coherent forged Deck task metadata.
    await runtime.harness.commit(async tx => Object.assign(await tx.doc(ChatDoc, capturedId), { kind: "task", managedParentChatId: parentId, parentChatId: undefined, ownerTaskId: undefined }), context);
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await legacy(runtime, undefined, 1);
    const metadata = (await runtime.harness.snapshot(ChatDoc, child.id, context))!;
    assert.equal(metadata.title, metadata.agentName);
    for (const id of [parent.id, child.id, manual.id, old, foreign.id, grandchild.id]) assert.deepEqual((await runtime.history(String(id))).items, []);
    const before = stored(path), scans: unknown[][] = [], metadataReads: ConversationId[] = [];
    const commit = runtime.harness.commit.bind(runtime.harness), snapshot = runtime.harness.snapshot.bind(runtime.harness);
    let inCommit = false;
    const mockedCommit = t.mock.method(runtime.harness, "commit", (fn: (tx: Tx) => unknown, ctx: typeof context) => {
      assert.equal(inCommit, false);
      return commit(async tx => {
        inCommit = true;
        try { return await fn(new Proxy(tx, { get(target, key) {
          if (key === "doc") return () => assert.fail("read must not acquire/create documents");
          if (key === "scanConversations") return (...args: Parameters<Tx["scanConversations"]>) => { scans.push(args); return target.scanConversations(...args); };
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
        } })); } finally { inCommit = false; }
      }, ctx);
    });
    const mockedSnapshot = t.mock.method(runtime.harness, "snapshot", (token: unknown, id: unknown, ...rest: unknown[]) => {
      assert.equal(inCommit, false, "metadata snapshot must be outside commit");
      if (token === ChatDoc) metadataReads.push(id as ConversationId);
      return Reflect.apply(snapshot, runtime.harness, [token, id, ...rest]);
    });
    try {
      assert.equal((await runtime.activity(parentId)).children, undefined);
      assert.equal((await runtime.activity(parentId, true, true)).children, undefined);
      assert.equal(scans.filter(args => (args[0] as any).ownerConversationId === undefined).length, 0);
      scans.length = 0; metadataReads.length = 0;
      const view = (await sample(runtime, parentId))!;
      assert.equal(validManagedChildren(view, parentId), true);
      assert.deepEqual(view.items.map(item => item.chatId), [old, manual.id, child.id].map(String));
      assert.deepEqual(view.items.map(item => item.title), ["Legacy 0", "Canonical title", "Own problem 🧪"]);
      assert.equal(view.items[0]!.agentRune, "ᚠ"); assert.equal(view.items[2]!.agentName, metadata.agentName);
      assert.ok(view.items.every(item => item.status?.state === "idle")); assert.equal(view.hasMore, false);
      assert.deepEqual(scans, [[{ order: "descending" }, 100]]);
      assert.equal(metadataReads.includes(capturedId), false);
      assert.equal(await runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
      assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|description|cwd|machineId|instructions|ownerTaskId/);
      scans.length = 0;
      assert.equal(await sample(runtime, captured!.chatId), undefined);
      assert.equal(await sample(runtime, String(unmanaged.id)), undefined);
      assert.deepEqual(scans, [], "unsupported parents never scan or scope-walk");
      assert.deepEqual(stored(path), before); assert.equal(faux.state.callCount, 0);
    } finally { mockedCommit.mock.restore(); mockedSnapshot.mock.restore(); }
  });
});

test("managed child bounded scan caps canonical records at 100 and retains a conservative overflow even with zero matches", async t => {
  await fixture(async (runtime, path, faux) => {
    const parent = String(runtime.main.id);
    assert.deepEqual(await sample(runtime), { chatId: parent, items: [], hasMore: false });
    const old = (await legacy(runtime, parent, 1))[0]!;
    await legacy(runtime, undefined, 101);
    const commit = runtime.harness.commit.bind(runtime.harness), scans: number[] = [];
    const mocked = t.mock.method(runtime.harness, "commit", (fn: (tx: Tx) => unknown, ctx: typeof context) => commit(tx => fn(new Proxy(tx, { get(target, key) {
      if (key === "scanConversations") return async (...args: Parameters<Tx["scanConversations"]>) => { assert.deepEqual(args, [{ order: "descending" }, 100]); const page = await target.scanConversations(args[0], args[1], args[2]); scans.push(page.items.length); return page; };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } })), ctx));
    try {
      const before = stored(path);
      assert.deepEqual(await sample(runtime), { chatId: parent, items: [], hasMore: true });
      assert.deepEqual(scans, [100]); assert.deepEqual(stored(path), before);
      const ids = await legacy(runtime, parent, 18);
      scans.length = 0;
      const many = (await sample(runtime))!;
      assert.equal(many.hasMore, true); assert.equal(many.items.length, 16);
      assert.deepEqual(many.items.map(item => item.chatId), ids.slice(-16).reverse().map(String));
      assert.ok(!many.items.some(item => item.chatId === String(old))); assert.deepEqual(scans, [100]);
      assert.equal(faux.state.callCount, 0);
    } finally { mocked.mock.restore(); }
  });
});

test("managed children have a sixteen-item bound and report omissions without treating unrelated records as children", async () => {
  await fixture(async (runtime, _path, faux) => {
    const parent = String(runtime.main.id), ids = await legacy(runtime, parent, 16);
    assert.equal((await sample(runtime))!.hasMore, false);
    await legacy(runtime, parent, 1);
    const full = (await sample(runtime))!;
    assert.equal(full.items.length, 16); assert.equal(full.hasMore, true);
    await runtime.harness.commit(async tx => {
      (await tx.doc(ChatDoc, ids[0]!)).title = "bad\ud800";
      Object.assign(await tx.doc(ChatDoc, ids[1]!), { kind: "subagent", parentChatId: parent });
      Object.assign(await tx.doc(ChatDoc, ids.at(-1)!), { brief: { problem: "x".repeat(159) + "🤖tail" }, agentName: "BAD NAME", agentRune: "Δ" });
    }, context);
    const sparse = (await sample(runtime))!;
    assert.equal(sparse.items.length, 15); assert.equal(sparse.hasMore, true);
    const clipped = sparse.items.find(item => item.chatId === String(ids.at(-1)))!;
    assert.equal(clipped.title, "x".repeat(159)); assert.equal(clipped.agentName, undefined); assert.equal(clipped.agentRune, undefined);
    assert.equal(validManagedChildren(sparse, parent), true); assert.equal(faux.state.callCount, 0);
  });
});

test("managed child status observes authoritative inbox/work only; failed status is absent/unknown", async t => {
  await fixture(async (runtime, path, faux) => {
    const child = (await legacy(runtime, String(runtime.main.id), 1))[0]!;
    assert.deepEqual((await sample(runtime))!.items[0]!.status, { state: "idle" });
    const before = stored(path), snapshot = runtime.harness.snapshot.bind(runtime.harness);
    let fail = false;
    const mocked = t.mock.method(runtime.harness, "snapshot", (token: unknown, id: unknown, ...rest: unknown[]) => {
      if (token === InboxDoc && id === child) { if (fail) throw new Error("PRIVATE_ERROR"); return Promise.resolve({ items: [{ content: "PRIVATE_INPUT" }] }); }
      return Reflect.apply(snapshot, runtime.harness, [token, id, ...rest]);
    });
    try {
      assert.deepEqual((await sample(runtime))!.items[0]!.status, { state: "working" });
      fail = true;
      const view = (await sample(runtime))!;
      assert.equal(view.items[0]!.status, undefined); assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|idle/);
      assert.deepEqual(stored(path), before); assert.equal(faux.state.callCount, 0);
    } finally { mocked.mock.restore(); }
  });
});

test("IPC children are opt-in on activity/history, independent of subagents, with unchanged defaults and strict boolean flags", async () => {
  await fixture(async (runtime, _path, faux) => {
    const child = (await legacy(runtime, String(runtime.main.id), 1))[0]!;
    const [captured] = await namedChildren(runtime, String(runtime.main.id));
    const input = new PassThrough(), output = new PassThrough(), decoder = output.pipe(new FrameDecoder());
    const frames = decoder[Symbol.asyncIterator](), serving = serveIpc(runtime, input, output); let serial = 0;
    const call = async (command: string, args?: unknown) => {
      const id = String(++serial); input.write(encodeFrame({ version: 1, id, command, ...(args === undefined ? {} : { args }) }));
      const reply = (await frames.next()).value; assert.equal(reply.id, id); return reply;
    };
    try {
      assert.equal((await call("activity")).result.children, undefined);
      for (const flag of [undefined, false, true]) {
        const args = { chatId: String(runtime.main.id), ...(flag === undefined ? {} : { includeChildren: flag }) };
        const live = await call("activity", args); assert.equal(live.ok, true); assert.equal(validActivity(live.result), true);
        assert.equal(live.result.children !== undefined, flag === true); assert.equal(live.result.subagents, undefined);
        if (flag) assert.equal(live.result.children.items[0].chatId, String(child));
        const history = await call("history", { ...args, includeActivity: true }); assert.equal(history.ok, true);
        assert.deepEqual(history.result.activity.children, live.result.children);
      }
      assert.equal((await call("history", { chatId: String(runtime.main.id), includeChildren: true })).result.activity, undefined);
      const both = await call("activity", { includeChildren: true, includeSubagents: true });
      assert.equal(both.result.children.items[0].chatId, String(child)); assert.equal(both.result.subagents.items[0].chatId, captured!.chatId);
      for (const command of ["activity", "history"]) for (const includeChildren of [null, 1, "true", [], {}]) {
        const reply = await call(command, { chatId: String(runtime.main.id), includeChildren });
        assert.equal(reply.ok, false); assert.equal(reply.error.code, "invalid");
      }
      assert.equal(faux.state.callCount, 0);
    } finally { input.end(); await serving; decoder.destroy(); output.destroy(); }
  });
});
