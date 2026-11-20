import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { defineTask, InboxDoc, type Conversation, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { ChatDoc, DeckRuntime, type RuntimeOptions } from "./deck.js";
import { validActivitySnapshot, validSubagentSnapshot, type ActivitySnapshot, type HistoryPage } from "./generated/contracts.js";
import { serveIpc } from "./ipc.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(run: (runtime: DeckRuntime, faux: ReturnType<typeof fauxProvider>, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "deck-subagent-status-")); const path = join(directory, "pi.sqlite");
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const options: RuntimeOptions = {
    implementation: "a".repeat(64), models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: "offline", cwd: "/saved" },
    environment: () => { throw new Error("Projection must not resolve a worker"); },
    hostFiles: { call: async () => { throw new Error("No native effects expected"); } },
  };
  const runtime = await DeckRuntime.open(path, options);
  try { await run(runtime, faux, path); }
  finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
}
const isChild = (messages: readonly { role: string; content?: unknown }[]) => messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Foreground delegation"));
const sample = async (runtime: DeckRuntime, id = runtime.main.id) => (await runtime.activity(String(id), false, true)).subagents!;

for (const outcome of ["done", "error", "cancel"] as const) {
  test(`foreground child status samples working then ${outcome} from canonical Pi work`, { timeout: 10_000 }, async () => {
    await fixture(async (runtime, faux) => {
      const entered = gate(); const release = gate(); const aborted = gate();
      const route: FauxResponseFactory = async (request, options) => {
        if (isChild(request.messages)) {
          options?.signal?.addEventListener("abort", aborted.release, { once: true });
          entered.release(); await release.promise;
          return outcome === "error"
            ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE_PROVIDER_SENTINEL" })
            : fauxAssistantMessage([fauxThinking("PRIVATE_CHILD_REASONING"), { type: "text", text: "PRIVATE_CHILD_ANSWER" }]);
        }
        return request.messages.some(message => message.role === "toolResult")
          ? fauxAssistantMessage("Parent finished")
          : fauxAssistantMessage(fauxToolCall("subagent", { task: "PRIVATE_TOOL_ARGUMENTS", title: "Foreground helper" }), { stopReason: "toolUse" });
      };
      faux.setResponses(Array.from({ length: 3 }, () => route));
      try {
        const parent = await runtime.admit(String(runtime.main.id), { requestId: outcome, text: "Delegate", mode: "followUp" });
        await entered.promise;
        const working = await sample(runtime);
        assert.equal(validSubagentSnapshot(working), true);
        assert.equal(working.chatId, String(runtime.main.id)); assert.equal(working.hasMore, false); assert.equal(working.items.length, 1);
        const item = working.items[0]!;
        assert.equal(item.title, "Foreground helper"); assert.match(item.agentName!, /^HU[0-9]{3,}$/); assert.equal(item.agentRune, undefined);
        assert.deepEqual(item.status, { state: "working" });
        assert.equal((await runtime.activity(String(runtime.main.id))).subagents, undefined);
        assert.equal((await runtime.activity(String(runtime.main.id), true)).subagents, undefined);
        const child = await runtime.chat(item.chatId);
        assert.deepEqual(await sample(runtime, child.id), { chatId: item.chatId, items: [], hasMore: false });
        if (outcome === "cancel") {
          const stopping = runtime.stop(String(runtime.main.id));
          await aborted.promise; release.release(); await stopping;
        } else release.release();
        const settled = await parent.wait(context); await runtime.main.waitForIdle(context);
        assert.equal(settled.status, outcome === "cancel" ? "unanswered" : "done");
        const calls = faux.state.callCount;
        const final = await sample(runtime);
        const status = final.items[0]!.status!;
        assert.equal(status.state, outcome === "cancel" ? "idle" : outcome);
        if (outcome === "cancel") assert.equal(status.taskId, undefined);
        else {
          assert.match(status.taskId!, /^[1-9]\d*$/);
          assert.deepEqual(status, (await runtime.activity(item.chatId, true)).agentStatus);
        }
        assert.doesNotMatch(JSON.stringify(final), /PRIVATE_|model_error|arguments|conversationId|agentNameAlgorithm/);
        assert.deepEqual(await sample(runtime), final); assert.equal(faux.state.callCount, calls);
      } finally { release.release(); }
    });
  });
}

// Synthetic records exercise invalid/legacy metadata without invoking any tool
// or provider. Real foreground creation and status transitions are covered above.
const ownerTask = defineTask<{}, { phase: "blocked" }, null>({ name: "test.subagent-owner", version: 1, initial: () => ({ phase: "blocked" }), phases: { blocked: async () => {} }, abort: async () => {} });
async function children(parent: Conversation, count: number) {
  return parent.commit(async tx => {
    const owner = await tx.createTask(ownerTask, {}, { ownership: { kind: "conversation" } });
    const ids: ConversationId[] = [];
    for (let i = 0; i < count; i++) {
      const record = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
      Object.assign(await tx.doc(ChatDoc, record.id), {
        kind: "subagent", title: `Helper ${i}`, machineId: "offline", cwd: "/saved",
        parentChatId: String(parent.id), ownerTaskId: String(owner), agentName: "helper", agentRune: "ᚠ",
      });
      ids.push(record.id);
    }
    return { ids, owner };
  }, context);
}

// A complete SQLite data sample also catches document/name cursor creation or
// changed commit generations; checking only the returned view would miss those.
function stored(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => {
      const name = String(row.name); assert.match(name, /^[a-z_]+$/);
      return { name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() };
    });
  } finally { db.close(); }
}

test("subagent scope uses canonical ownership, rejects forged/incoherent hints, and stays read-only", { timeout: 10_000 }, async t => {
  await fixture(async (runtime, faux, path) => {
    const parent = runtime.main; const other = await runtime.createTask("Other", { machineId: "offline", cwd: "/saved" });
    const { ids, owner } = await children(parent, 6);
    const [valid, wrongKind, wrongParent, wrongTask, malformedTitle, nonStringTitle] = ids as [ConversationId, ConversationId, ConversationId, ConversationId, ConversationId, ConversationId];
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "task", taskId: owner } }, context);
    const ownerless = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const foreign = (await children(other, 1)).ids[0]!;
    const grandchild = (await children(await runtime.chat(String(valid)), 1)).ids[0]!;
    await parent.commit(async tx => {
      Object.assign(await tx.doc(ChatDoc, valid), { title: "x".repeat(159) + "😀tail", agentName: "INVALID NAME", agentRune: "Δ" });
      (await tx.doc(ChatDoc, wrongKind)).kind = "task";
      (await tx.doc(ChatDoc, wrongParent)).parentChatId = String(other.id);
      (await tx.doc(ChatDoc, wrongTask)).ownerTaskId = "999999";
      (await tx.doc(ChatDoc, malformedTitle)).title = "bad\ud800";
      Object.assign(await tx.doc(ChatDoc, nonStringTitle), { title: 123 });
      Object.assign(await tx.doc(ChatDoc, ownerless.id), { kind: "subagent", title: "FORGED_OWNERLESS", parentChatId: String(parent.id), ownerTaskId: String(owner) });
      (await tx.doc(ChatDoc, foreign)).parentChatId = String(parent.id);
    }, context);
    const unmanagedInbox = await runtime.harness.snapshot(InboxDoc, unmanaged.id, context);
    const before = stored(path);
    let inCommit = false; const scans: unknown[][] = []; const metadataReads: ConversationId[] = [];
    const commit = runtime.harness.commit.bind(runtime.harness);
    const snapshot = runtime.harness.snapshot.bind(runtime.harness);
    const commitMock = t.mock.method(runtime.harness, "commit", async (fn: (tx: Tx) => unknown, ctx: typeof context) => {
      assert.equal(inCommit, false, "projection must not nest commits");
      return commit(async tx => {
        inCommit = true;
        try {
          return await fn(new Proxy(tx, { get(target, key) {
            if (key === "doc") return () => { assert.fail("read projection must not acquire/create documents"); };
            if (key === "scanConversations") return (...args: Parameters<Tx["scanConversations"]>) => { scans.push(args); return target.scanConversations(...args); };
            const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
          } }));
        } finally { inCommit = false; }
      }, ctx);
    });
    const snapshotMock = t.mock.method(runtime.harness, "snapshot", (token: unknown, id: unknown, ...rest: unknown[]) => {
      assert.equal(inCommit, false, "snapshot must be outside commits");
      if (token === ChatDoc) metadataReads.push(id as ConversationId);
      return Reflect.apply(snapshot, runtime.harness, [token, id, ...rest]);
    });
    try {
      assert.equal((await runtime.activity(String(parent.id))).subagents, undefined);
      assert.equal(scans.length, 0); assert.equal(metadataReads.length, 0);
      const view = await sample(runtime);
      assert.equal(validSubagentSnapshot(view), true);
      assert.deepEqual(view, { chatId: String(parent.id), items: [{ chatId: String(valid), title: "x".repeat(159), status: { state: "working" } }], hasMore: true });
      assert.deepEqual(scans, [[{ ownerConversationId: parent.id, order: "descending" }, 16]]);
      assert.equal(metadataReads.length, 7);
      for (const id of [ownerless.id, foreign, grandchild]) assert.equal(metadataReads.includes(id), false);
      assert.equal(await runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
      assert.deepEqual(await runtime.harness.snapshot(InboxDoc, unmanaged.id, context), unmanagedInbox);
      assert.deepEqual(stored(path), before); assert.equal(faux.state.callCount, 0);
    } finally { commitMock.mock.restore(); snapshotMock.mock.restore(); }
  });
});

test("subagent scan is bounded to newest 16 canonical children with conservative sparse/overflow indication", { timeout: 10_000 }, async () => {
  await fixture(async (runtime, faux, path) => {
    const { ids } = await children(runtime.main, 20);
    const before = stored(path);
    const view = await sample(runtime);
    assert.equal(view.hasMore, true); assert.equal(view.items.length, 16);
    assert.deepEqual(view.items.map(item => item.chatId), ids.slice(-16).reverse().map(String));
    assert.equal(validSubagentSnapshot(view), true);
    assert.deepEqual(stored(path), before);
    await runtime.main.commit(async tx => { (await tx.doc(ChatDoc, ids.at(-1)!)).kind = "main"; }, context);
    const sparse = await sample(runtime);
    assert.equal(sparse.hasMore, true); assert.equal(sparse.items.length, 15);
    assert.deepEqual(sparse.items.map(item => item.chatId), ids.slice(-16, -1).reverse().map(String));
    assert.equal(faux.state.callCount, 0);
  });
});

test("canonical child owners must still resolve to a task in the selected parent", { timeout: 10_000 }, async t => {
  await fixture(async (runtime, faux, path) => {
    const { owner } = await children(runtime.main, 1);
    const other = await runtime.createTask("Other", { machineId: "offline", cwd: "/saved" });
    const commit = runtime.harness.commit.bind(runtime.harness); const before = stored(path);
    for (const missing of [true, false]) {
      const mocked = t.mock.method(runtime.harness, "commit", (fn: (tx: Tx) => unknown, ctx: typeof context) => commit(tx => fn(new Proxy(tx, {
        get(target, key) {
          if (key === "task") return async (id: Parameters<Tx["task"]>[0]) => {
            const record = await target.task(id);
            return id === owner ? missing ? undefined : { ...record, conversationId: other.id } : record;
          };
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
        },
      })), ctx));
      try { assert.deepEqual(await sample(runtime), { chatId: String(runtime.main.id), items: [], hasMore: true }); }
      finally { mocked.mock.restore(); }
    }
    assert.deepEqual(stored(path), before); assert.equal(faux.state.callCount, 0);
  });
});

test("child status uses the sampled inbox even when there is no child task yet", { timeout: 10_000 }, async t => {
  await fixture(async (runtime, faux, path) => {
    const child = (await children(runtime.main, 1)).ids[0]!;
    assert.deepEqual((await sample(runtime)).items[0]!.status, { state: "idle" });
    const before = stored(path); const snapshot = runtime.harness.snapshot.bind(runtime.harness);
    const mocked = t.mock.method(runtime.harness, "snapshot", (token: unknown, id: unknown, ...rest: unknown[]) => {
      // Inject only the observational queue sample, not a fake durable submission.
      if (token === InboxDoc && id === child) return Promise.resolve({ items: [{ id: 1, mode: "followUp", content: "PRIVATE_QUEUED_INPUT" }] });
      return Reflect.apply(snapshot, runtime.harness, [token, id, ...rest]);
    });
    try {
      const view = await sample(runtime);
      assert.deepEqual(view.items[0]!.status, { state: "working" });
      assert.doesNotMatch(JSON.stringify(view), /PRIVATE_QUEUED_INPUT/);
      assert.deepEqual(stored(path), before); assert.equal(faux.state.callCount, 0);
    } finally { mocked.mock.restore(); }
  });
});

test("a child status read failure is absent/unknown, never idle or diagnostic text", { timeout: 10_000 }, async t => {
  await fixture(async (runtime, faux) => {
    const child = (await children(runtime.main, 1)).ids[0]!;
    const snapshot = runtime.harness.snapshot.bind(runtime.harness);
    const mocked = t.mock.method(runtime.harness, "snapshot", (token: unknown, id: unknown, ...rest: unknown[]) => {
      if (token === InboxDoc && id === child) throw new Error("PRIVATE_STATUS_ERROR");
      return Reflect.apply(snapshot, runtime.harness, [token, id, ...rest]);
    });
    try {
      const view = await sample(runtime);
      assert.equal(view.items.length, 1); assert.equal(view.items[0]!.status, undefined);
      assert.equal(validSubagentSnapshot(view), true); assert.doesNotMatch(JSON.stringify(view), /PRIVATE_STATUS_ERROR|idle/);
      assert.equal(faux.state.callCount, 0);
    } finally { mocked.mock.restore(); }
  });
});

test("IPC activity and history expose subagents only with the explicit flag and preserve parent scope", { timeout: 10_000 }, async () => {
  await fixture(async (runtime, faux) => {
    const child = (await children(runtime.main, 1)).ids[0]!;
    const other = await runtime.createTask("Other", { machineId: "offline", cwd: "/saved" });
    const input = new PassThrough(); const output = new PassThrough(); const decoder = output.pipe(new FrameDecoder());
    const frames = decoder[Symbol.asyncIterator](); const serving = serveIpc(runtime, input, output); let sequence = 0;
    const call = async (command: string, args: unknown) => {
      const id = String(++sequence); input.write(encodeFrame({ version: 1, id, command, args }));
      const frame = (await frames.next()).value; assert.equal(frame.id, id); return frame;
    };
    try {
      const id = String(runtime.main.id);
      for (const flag of [undefined, false, true]) {
        const args = { chatId: id, ...(flag === undefined ? {} : { includeSubagents: flag }) };
        const activityReply = await call("activity", args); assert.equal(activityReply.ok, true);
        const activity = activityReply.result as ActivitySnapshot; assert.equal(validActivitySnapshot(activity), true);
        assert.equal(activity.subagents !== undefined, flag === true); assert.equal(activity.agentStatus, undefined);
        if (flag) assert.equal(activity.subagents!.items[0]!.chatId, String(child));
        const historyReply = await call("history", { ...args, includeActivity: true }); assert.equal(historyReply.ok, true);
        const history = historyReply.result as HistoryPage;
        assert.deepEqual(history.activity?.subagents, activity.subagents);
      }
      const noActivity = await call("history", { chatId: id, includeSubagents: true });
      assert.equal(noActivity.ok, true); assert.equal(noActivity.result.activity, undefined);
      const isolated = await call("activity", { chatId: String(other.id), includeSubagents: true, includeAgentStatus: true });
      assert.equal(isolated.ok, true); assert.deepEqual(isolated.result.subagents, { chatId: String(other.id), items: [], hasMore: false });
      assert.deepEqual(isolated.result.agentStatus, { state: "idle" });
      for (const command of ["activity", "history"]) {
        const invalid = await call(command, { chatId: id, includeSubagents: "yes" });
        assert.equal(invalid.ok, false); assert.equal(invalid.error.code, "invalid");
      }
      assert.equal(faux.state.callCount, 0);
    } finally { input.end(); await serving; decoder.destroy(); output.destroy(); }
  });
});
