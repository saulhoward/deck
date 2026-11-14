import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { serveIpc } from "./ipc.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defineTask, defineDocFamily, InboxDoc } from "@earendil-works/pi-durable";
import { DeckRuntime, ChatDoc, type RuntimeOptions } from "./deck.js";
import { validDiscoveryPage } from "./discovery-contracts.js";

async function fixture(run: (runtime: DeckRuntime, options: RuntimeOptions, path: string, faux: ReturnType<typeof fauxProvider>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "deck-contract-"));
  const path = join(directory, "session.sqlite");
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel();
  const options: RuntimeOptions = { models, model: { provider: model.provider, modelId: model.id }, binding: { machineId: "worker-a", cwd: directory }, environment: () => undefined };
  const runtime = await DeckRuntime.open(path, options);
  try { await run(runtime, options, path, faux, directory); }
  finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
}

const input = (requestId: string, text = "Hello") => ({ requestId, text, mode: "followUp" as const });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("chat discovery pages canonical Pi records, preserves offline bindings and resumes after reopen without creating metadata", async () => {
  await fixture(async (runtime, options, path, faux) => {
    const first = await runtime.createTask("First", options.binding, "first-task");
    const unmanaged = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const offline = await runtime.createTask("Offline task", { machineId: "offline-worker", cwd: "/saved/work" }, "offline-task");
    const last = await runtime.createTask("Last", options.binding, "last-task");
    const page1 = await runtime.listChats({ limit: 2 });
    assert.deepEqual(page1.items.map((chat) => chat.chatId), [String(runtime.main.id), String(first.id)]);
    assert.equal(page1.next, String(first.id)); assert.equal(validDiscoveryPage(page1, { limit: 2 }), true);
    const page2 = await runtime.listChats({ limit: 2, after: page1.next! });
    const named = await runtime.harness.snapshot(ChatDoc, offline.id, context);
    assert.deepEqual(page2.items, [{ chatId: String(offline.id), kind: "task", title: "Offline task", machineId: "offline-worker", cwd: "/saved/work", agentName: named!.agentName, agentNameAlgorithm: named!.agentNameAlgorithm, agentRune: named!.agentRune }]);
    assert.equal(await runtime.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
    assert.equal(validDiscoveryPage(page2, { limit: 2, after: page1.next }), true);
    const sparse = await runtime.listChats({ limit: 1, after: String(first.id) });
    assert.equal(sparse.items.length, 0); assert.equal(sparse.next, String(unmanaged.id));
    assert.equal(validDiscoveryPage(sparse, { limit: 1, after: String(first.id) }), true);
    for (const limit of [0, -1, 101, 1.5, NaN]) await assert.rejects(runtime.listChats({ limit }), { code: "invalid" });
    for (const after of ["0", "-1", "oops", "1.5", "9007199254740992"]) await assert.rejects(runtime.listChats({ after }), { code: "invalid" });
    await runtime.close();
    const reopened = await DeckRuntime.open(path, options);
    try {
      const page3 = await reopened.listChats({ limit: 2, after: page2.next! });
      assert.deepEqual(page3.items.map((chat) => chat.chatId), [String(last.id)]);
      assert.equal(page3.next, undefined); assert.equal(validDiscoveryPage(page3, { limit: 2, after: page2.next }), true);
      assert.equal((await reopened.listChats()).items.length, 4);
      assert.equal(await reopened.harness.snapshot(ChatDoc, unmanaged.id, context), undefined);
      assert.equal(faux.state.callCount, 0);
    } finally { await reopened.close(); }
  });
});

test("history pages more than 100 canonical entries without gaps, survives reopen and respects fork ancestry", async () => {
  await fixture(async (runtime, options, path, faux) => {
    const other = await runtime.createTask("Other history", options.binding);
    const ids = await runtime.main.commit(async (tx) => {
      const ids = [];
      for (let i = 0; i < 125; i++) {
        ids.push((await tx.appendEntry(runtime.main.id, { kind: "deck.input", data: { text: `retained ${i}` } })).id);
        if (i % 9 === 0) await tx.appendEntry(other.id, { kind: "deck.input", data: { text: "unrelated" } });
      }
      return ids;
    }, context);
    const main = String(runtime.main.id);
    const first = await runtime.history(main);
    assert.deepEqual(first.items.map((entry) => entry.id), ids.slice(25).reverse());
    assert.equal(first.next, String(ids[25]));
    const newer = await runtime.main.commit((tx) => tx.appendEntry(runtime.main.id, { kind: "deck.input", data: { text: "newer during pagination" } }), context);
    for (const limit of [0, -1, 101, 1.5, NaN]) await assert.rejects(runtime.history(main, { limit }), { code: "invalid" });
    for (const before of ["0", "-1", "oops", "1.5", "9007199254740992"]) await assert.rejects(runtime.history(main, { before }), { code: "invalid" });
    for (const after of ["-1", "oops", "1.5", "9007199254740992"]) await assert.rejects(runtime.history(main, { after }), { code: "invalid" });
    await assert.rejects(runtime.history(main, { before: "1", after: "0" }), { code: "invalid" });
    const fork = await runtime.main.fork(ids[80]!, { ownership: { kind: "ownerless" } }, context);
    const childEntry = await fork.commit((tx) => tx.appendEntry(fork.id, { kind: "deck.input", data: { text: "fork only" } }), context);
    await runtime.close();
    const reopened = await DeckRuntime.open(path, options);
    try {
      const rest = [];
      let before: string | undefined = first.next;
      while (before) {
        const page = await reopened.history(main, { limit: 7, before });
        rest.push(...page.items.map((entry) => entry.id)); before = page.next;
      }
      assert.deepEqual(rest, ids.slice(0, 25).reverse());
      assert.equal((await reopened.history(main, { before: String(ids[0]) })).items.length, 0);
      const inherited = [];
      before = undefined;
      do {
        const page = await reopened.history(String(fork.id), { limit: 13, ...(before ? { before } : {}) });
        inherited.push(...page.items.map((entry) => entry.id)); before = page.next;
      } while (before);
      assert.deepEqual(inherited, [childEntry.id, ...ids.slice(0, 81).reverse()]);
      const forward = [];
      let after = String(ids[50]);
      for (;;) {
        const page = await reopened.history(main, { limit: 9, after });
        forward.push(...page.items.map((entry) => entry.id));
        if (!page.next) break;
        after = page.next;
      }
      assert.deepEqual(forward, [...ids.slice(51), newer.id]);
      assert.deepEqual((await reopened.history(main, { after: String(newer.id) })).items, []);
      const forkForward = [];
      after = "0";
      for (;;) {
        const page = await reopened.history(String(fork.id), { limit: 11, after });
        forkForward.push(...page.items.map((entry) => entry.id));
        if (!page.next) break;
        after = page.next;
      }
      assert.deepEqual(forkForward, [...ids.slice(0, 81), childEntry.id]);
      assert.equal(faux.state.callCount, 0);
    } finally { await reopened.close(); }
  });
});

test("activity reads Pi busy/inbox/tool state, bounds tool summaries and keeps other chats isolated", async () => {
  await fixture(async (runtime, options, path, faux) => {
    await runtime.close();
    const generating = gate(); const startTools = gate(); const toolsEntered = gate(); const finishTools = gate();
    let calls = 0;
    const native = await DeckRuntime.open(path, { ...options, hostFiles: { call: async () => {
      if (++calls === 1) toolsEntered.release();
      await finishTools.promise; return { ok: true, output: "private-tool-output" };
    } } });
    try {
      const id = String(native.main.id);
      const other = await native.createTask("Unrelated", options.binding);
      assert.equal((await native.activity(id)).busy, false);
      faux.setResponses([
        async () => { generating.release(); await startTools.promise; return fauxAssistantMessage(Array.from({ length: 40 }, (_, i) => fauxToolCall("read", { path: "/do-not-expose-secret-arguments" }, { id: `call-${i}-${"x".repeat(200)}` })), { stopReason: "toolUse" }); },
        fauxAssistantMessage("Finished"),
      ]);
      const first = await native.admit(id, input("activity-main")); await generating.promise;
      const queued = await native.admit(id, input("activity-queued"));
      const working = await native.activity(id);
      assert.equal(working.busy, true); assert.equal(working.queued, 1);
      assert.equal(working.generation?.phase, "generating"); assert.match(working.runTaskId!, /^\d+$/);
      await queued.abort(context);
      startTools.release(); await toolsEntered.promise;
      const tools = await native.activity(id);
      assert.equal(tools.busy, true); assert.equal(tools.queued, 0);
      assert.equal(tools.tools.length, 32); assert.equal(tools.omittedTools, 8);
      assert.ok(tools.tools.every((tool) => tool.name === "read" && ["pending", "running"].includes(tool.status) && tool.callId.length <= 128));
      assert.doesNotMatch(JSON.stringify(tools), /do-not-expose|private-tool-output/);
      assert.equal((await native.activity(String(other.id))).busy, false);
      assert.equal((await native.activity(String(other.id))).tools.length, 0);
      finishTools.release(); assert.equal((await first.wait(context)).status, "done"); assert.equal(calls, 40);
      assert.equal((await native.activity(id)).busy, false);
      assert.equal((await native.activity(id)).tools.length, 0);
      await assert.rejects(native.activity("bad"), { code: "invalid" });
    } finally { startTools.release(); finishTools.release(); await native.close(); }
  });
});

test("native follow-ups are placed FIFO one at a time; stopping withdraws queued input", async () => {
  await fixture(async (runtime, _options, _path, faux) => {
    const entered = gate(); const release = gate();
    faux.setResponses([
      async () => { entered.release(); await release.promise; return fauxAssistantMessage("First"); },
      fauxAssistantMessage("Second"), fauxAssistantMessage("Third"),
    ]);
    const id = String(runtime.main.id);
    const first = await runtime.admit(id, input("first", "First request"));
    await entered.promise;
    const second = await runtime.admit(id, input("second", "Second request"));
    const third = await runtime.admit(id, input("third", "Third request"));
    assert.equal((await second.status(context)).status, "queued");
    assert.equal((await third.status(context)).status, "queued");
    release.release();
    for (const submission of [first, second, third]) assert.equal((await submission.wait(context)).status, "done");
    const entries = (await runtime.history(id)).items.slice().reverse();
    assert.deepEqual(entries.filter((entry) => entry.kind === "deck.input").map((entry) => (entry.data as { text: string }).text), ["First request", "Second request", "Third request"]);
    assert.equal(faux.state.callCount, 3);

    const started = gate(); const finish = gate();
    faux.setResponses([async () => { started.release(); await finish.promise; return fauxAssistantMessage("Interrupted"); }]);
    const running = await runtime.admit(id, input("running"));
    await started.promise;
    const queued = await runtime.admit(id, input("queued"));
    const stopping = runtime.stop(id);
    finish.release();
    await stopping;
    assert.equal((await queued.wait(context)).status, "unanswered");
    assert.notEqual((await running.status(context)).status, "placed");
  });
});

test("native steering joins busy work at the tool boundary", async () => {
  await fixture(async (runtime, _options, _path, faux) => {
    const entered = gate(); const release = gate();
    faux.setResponses([
      async () => { entered.release(); await release.promise; return fauxAssistantMessage(fauxToolCall("read", { path: "unavailable" }), { stopReason: "toolUse" }); },
      fauxAssistantMessage("Answer incorporating steering"),
    ]);
    const id = String(runtime.main.id);
    const first = await runtime.admit(id, input("initial"));
    await entered.promise;
    const steer = await runtime.admit(id, { requestId: "steer", text: "Use the new approach", mode: "steer" });
    assert.equal((await steer.status(context)).status, "queued");
    release.release();
    const a = await first.wait(context); const b = await steer.wait(context);
    assert.equal(a.status, "done"); assert.equal(b.status, "done");
    if (a.status === "done" && b.status === "done") assert.equal(a.answer, b.answer);
    assert.equal(faux.state.callCount, 2);
  });
});

test("durable admissions deduplicate concurrent retries, reject conflicts and survive reopen", async () => {
  await fixture(async (runtime, options, path, faux) => {
    faux.setResponses([fauxAssistantMessage("Hello back")]);
    const id = String(runtime.main.id);
    const [first, retry] = await Promise.all([runtime.admit(id, input("r1")), runtime.admit(id, input("r1"))]);
    assert.equal(first.id, retry.id);
    assert.equal((await first.wait(context)).status, "done");
    await assert.rejects(runtime.admit(id, input("r1", "Different")), { code: "conflict" });
    await runtime.close();
    const reopened = await DeckRuntime.open(path, { ...options, binding: { machineId: "wrong-default", cwd: "/" }, admissionGuard: async () => { throw new Error("Auth unavailable"); } });
    try {
      assert.equal(reopened.main.id, runtime.main.id);
      assert.equal(reopened.hubId, runtime.hubId);
      assert.equal((await reopened.harness.snapshot(ChatDoc, reopened.main.id, context))?.machineId, "worker-a");
      assert.equal((await reopened.admit(id, input("r1"))).id, first.id);
      assert.equal(faux.state.callCount, 1);
      await assert.rejects(reopened.admit(id, input("new-without-auth")), /Auth unavailable/);
    } finally { await reopened.close(); }
  });
});

test("capture labels observed choices, hashes instructions and leaves later idle configuration explicit", async () => {
  await fixture(async (runtime, options, path, faux, directory) => {
    const id = String(runtime.main.id);
    await writeFile(join(directory, "AGENTS.md"), "UNREAD_PROJECT_INSTRUCTION");
    await runtime.configure(id, { instructions: "Original instruction" });
    for (const cwd of ["/different", null]) await assert.rejects(runtime.configure(id, { cwd }), { code: "invalid" });
    assert.equal((await runtime.main.agent(context)).cwd, directory);
    faux.setResponses([(request) => {
      const messages = JSON.stringify(request.messages);
      assert.match(messages, /Original instruction/); assert.doesNotMatch(messages, /UNREAD_PROJECT_INSTRUCTION/);
      return fauxAssistantMessage("Done");
    }]);
    const first = await runtime.admit(id, input("capture")); await first.wait(context);
    const entry = (await runtime.history(id)).items.find((entry) => entry.kind === "deck.input")!;
    const data = entry.data as { capture: string };
    const capture = JSON.parse(data.capture) as Record<string, unknown>;
    assert.equal(capture.version, 3); assert.equal(capture.implementation, runtime.implementation); assert.equal(capture.semantics, "observed-at-reservation");
    assert.deepEqual(capture.model, options.model); assert.equal(capture.cwd, directory);
    assert.deepEqual(capture.tools, ["read", "write", "edit", "bash", "host_list", "task_list", "task_history", "task_activity", "task_create", "task_message", "hub_message", "subagent"]);
    assert.match(String(capture.instructionsHash), /^[a-f0-9]{64}$/);
    assert.doesNotMatch(data.capture, /Original instruction|UNREAD_PROJECT_INSTRUCTION/);
    await runtime.configure(id, { instructions: "Changed later" });
    assert.equal((await runtime.admit(id, input("capture"))).id, first.id);
    assert.equal(faux.state.callCount, 1);
    assert.equal(((await runtime.history(id)).items.find((item) => item.kind === "deck.input")!.data as { capture: string }).capture, data.capture);
  });
});

test("unadmitted reservation refuses settings drift across reopen; restoring choices repairs the original ID", async () => {
  await fixture(async (runtime, options, path, faux) => {
    const id = String(runtime.main.id);
    await runtime.configure(id, { instructions: "Original" });
    const originalChat = runtime.chat.bind(runtime);
    runtime.chat = async (id) => { const chat = await originalChat(id); chat.submit = async () => { throw new Error("Simulated crash before Pi submit"); }; return chat; };
    await assert.rejects(runtime.admit(id, input("gap")), /Simulated crash/);
    runtime.chat = originalChat;
    assert.equal(faux.state.callCount, 0);
    await runtime.configure(id, { instructions: "Changed" });
    await runtime.close();
    const reopened = await DeckRuntime.open(path, options);
    try {
      await assert.rejects(reopened.admit(id, input("gap")), { code: "settings_changed" });
      assert.equal((await reopened.history(id)).items.length, 0); assert.equal(faux.state.callCount, 0);
      await reopened.configure(id, { instructions: "Original" });
      faux.setResponses([fauxAssistantMessage("Recovered")]);
      assert.equal((await (await reopened.admit(id, input("gap"))).wait(context)).status, "done");
      assert.equal(faux.state.callCount, 1);
    } finally { await reopened.close(); }
  });
});

test("legacy reservation repair keeps the original limited capture without inventing newly observed fields", async () => {
  await fixture(async (runtime, options, path, faux) => {
    const Legacy = defineDocFamily<{ hash: string; capture: string }, { hash: string; capture: string }>({ kind: "deck.admission", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: (seed) => seed, checkpointWhen: () => true });
    const id = String(runtime.main.id); const agent = await runtime.main.agent(context);
    const request = input("legacy");
    const capture = await runtime.main.commit(async (tx) => {
      const capture = JSON.stringify({ model: agent.model, thinkingLevel: agent.thinkingLevel, binding: await tx.doc(ChatDoc, runtime.main.id) });
      await tx.doc(Legacy, runtime.main.id, request.requestId, { hash: createHash("sha256").update(JSON.stringify([request.text, request.mode])).digest("hex"), capture });
      return capture;
    }, context);
    faux.setResponses([fauxAssistantMessage("Legacy recovered")]);
    await (await runtime.admit(id, request)).wait(context);
    const data = (await runtime.history(id)).items.find((entry) => entry.kind === "deck.input")!.data as { capture: string };
    assert.equal(data.capture, capture); assert.equal(JSON.parse(data.capture).version, undefined);
  });
});

test("agent status projects canonical idle, settled answers and failures without exposing diagnostics or executing work", async () => {
  await fixture(async (runtime, options, path, faux) => {
    const id = String(runtime.main.id);
    const inboxBefore = await runtime.harness.snapshot(InboxDoc, runtime.main.id, context);
    assert.deepEqual((await runtime.activity(id, true)).agentStatus, { state: "idle" });
    assert.deepEqual(await runtime.harness.snapshot(InboxDoc, runtime.main.id, context), inboxBefore);
    assert.equal((await runtime.activity(id)).agentStatus, undefined); // Older clients receive the original view.
    faux.setResponses([fauxAssistantMessage("Answer"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "INVALID_REQUEST_PRIVATE_DIAGNOSTIC" })]);
    await (await runtime.admit(id, input("answer"))).wait(context); await runtime.main.waitForIdle(context);
    const done = (await runtime.activity(id, true)).agentStatus!;
    assert.equal(done.state, "done"); assert.match(done.taskId!, /^[1-9]\d*$/);
    assert.deepEqual((await runtime.activity(id, true)).agentStatus, done); assert.equal(faux.state.callCount, 1);
    const other = await runtime.createTask("Other", options.binding);
    assert.deepEqual((await runtime.activity(String(other.id), true)).agentStatus, { state: "idle" });
    await (await runtime.admit(id, input("failed"))).wait(context); await runtime.main.waitForIdle(context);
    const failed = (await runtime.activity(id, true)).agentStatus!;
    assert.equal(failed.state, "error"); assert.notEqual(failed.taskId, done.taskId);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_DIAGNOSTIC/); assert.equal(faux.state.callCount, 2);
    await runtime.close(); const reopened = await DeckRuntime.open(path, options);
    try { assert.deepEqual((await reopened.activity(id, true)).agentStatus, failed); assert.equal(faux.state.callCount, 2); }
    finally { await reopened.close(); }
  });
});

test("configuration cannot change active or queued work, but succeeds once Pi settles it", { timeout: 10_000 }, async () => {
  await fixture(async (runtime, options, path, faux) => {
    const id = String(runtime.main.id); const entered = gate(); const release = gate();
    faux.setResponses([async () => { entered.release(); await release.promise; return fauxAssistantMessage("First"); }, fauxAssistantMessage("Second")]);
    const first = await runtime.admit(id, input("active"));
    try {
      await entered.promise;
      await assert.rejects(runtime.configure(id, { instructions: "Must not apply" }), { code: "busy" });
      const queued = await runtime.admit(id, input("queued"));
      assert.deepEqual((await runtime.activity(id, true)).agentStatus, { state: "working" });
      await assert.rejects(runtime.configure(id, { thinkingLevel: "high" }), { code: "busy" });
      assert.equal((await runtime.main.agent(context)).instructions, undefined);
      release.release(); await first.wait(context); await queued.wait(context);
      await runtime.configure(id, { instructions: "Now idle" });
      assert.equal((await runtime.main.agent(context)).instructions, "Now idle");
    } finally { release.release(); }
  });
});

test("configuration checks authoritative pending tasks even when chat activity looks idle", async () => {
  await fixture(async (runtime, _options, _path, faux) => {
    faux.setResponses([fauxAssistantMessage("Already seen answer")]);
    await (await runtime.admit(String(runtime.main.id), input("prior-answer"))).wait(context);
    await runtime.main.waitForIdle(context);
    const prior = (await runtime.activity(String(runtime.main.id), true)).agentStatus!;
    const pending = defineTask<{}, { phase: "blocked" }, null>({ name: "test.uninstalled", version: 1, initial: () => ({ phase: "blocked" }), phases: { blocked: async () => {} }, abort: async () => {} });
    await runtime.main.commit((tx) => tx.createTask(pending, {}, { ownership: { kind: "conversation" } }), context);
    const id = String(runtime.main.id);
    assert.equal((await runtime.activity(id)).busy, false);
    assert.deepEqual((await runtime.activity(id, true)).agentStatus, { state: "working", settledTaskId: prior.taskId });
    await assert.rejects(runtime.configure(id, { instructions: "Not safe yet" }), { code: "busy" });
  });
});

test("task context is separate and its host binding and model survive reopen", async () => {
  await fixture(async (runtime, options, path, faux) => {
    const task = await runtime.createTask("Fix parser", { machineId: "offline-worker", cwd: "/project" }, "create-task");
    const retry = await runtime.createTask("Fix parser", { machineId: "offline-worker", cwd: "/project" }, "create-task");
    assert.equal(retry.id, task.id);
    await assert.rejects(runtime.createTask("Different", { machineId: "offline-worker", cwd: "/project" }, "create-task"), { code: "conflict" });
    faux.setResponses([fauxAssistantMessage("Task answer")]);
    await (await runtime.admit(String(task.id), input("task-input", "Task-only request"))).wait(context);
    assert.equal((await runtime.history(String(runtime.main.id))).items.length, 0);
    assert.ok((await runtime.history(String(task.id))).items.length > 0);
    await runtime.close();
    const reopened = await DeckRuntime.open(path, options);
    try {
      const chat = await reopened.createTask("Fix parser", { machineId: "offline-worker", cwd: "/project" }, "create-task");
      assert.equal(chat.id, task.id);
      assert.deepEqual((await chat.agent(context)).model, options.model);
      assert.equal((await reopened.harness.snapshot(ChatDoc, chat.id, context))?.machineId, "offline-worker");
    } finally { await reopened.close(); }
  });
});

test("stop requests and unrelated admissions proceed while issued native files drain", { timeout: 10_000 }, async () => {
  await fixture(async (runtime, options, path, faux) => {
    await runtime.close();
    const entered = gate(); const release = gate();
    const native = await DeckRuntime.open(path, { ...options, hostFiles: { call: async () => {
      entered.release(); await release.promise; return { ok: true, output: "drained" };
    } } });
    const inputPipe = new PassThrough(); const output = new PassThrough();
    const decoder = output.pipe(new FrameDecoder()); const frames = decoder[Symbol.asyncIterator]();
    const serving = serveIpc(native, inputPipe, output);
    try {
      const task = await native.createTask("Independent", options.binding);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", { path: "file.txt", content: "test" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Independent response"),
      ]);
      await native.admit(String(native.main.id), input("draining"));
      await entered.promise;
      inputPipe.write(encodeFrame({ version: 1, id: "stop", command: "stop", args: { chatId: String(native.main.id) } }));
      const stop = await frames.next(); assert.equal(stop.value.result.requested, true);
      assert.deepEqual((await native.activity(String(native.main.id), true)).agentStatus, { state: "working" });
      await assert.rejects(native.configure(String(native.main.id), { instructions: "Too early; effects still drain" }), { code: "busy" });
      inputPipe.write(encodeFrame({ version: 1, id: "other", command: "admit", args: { chatId: String(task.id), requestId: "independent", text: "Hello", mode: "followUp" } }));
      const admission = await frames.next(); assert.equal(admission.value.id, "other"); assert.equal(admission.value.ok, true);
      inputPipe.write(encodeFrame({ version: 1, id: "status", command: "status" }));
      assert.equal((await frames.next()).value.ok, true);
    } finally {
      release.release(); inputPipe.end(); await serving;
      await native.close(); decoder.destroy(); output.destroy();
    }
  });
});

test("Pi scoped abort propagates cancellation to native bash and drains its result", async () => {
  await fixture(async (runtime, options, path, faux) => {
    await runtime.close();
    const entered = gate(); let aborted = false;
    const native = await DeckRuntime.open(path, { ...options, hostFiles: { call: async (_binding, _id, operation, _args, signal) => {
      assert.equal(operation, "bash"); assert.ok(signal); entered.release();
      return new Promise((resolve) => {
        const cancel = () => { aborted = true; resolve({ ok: false, output: "cancelled", code: "cancelled" }); };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    } } });
    try {
      faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" })]);
      await native.admit(String(native.main.id), input("shell-abort")); await entered.promise;
      await native.stop(String(native.main.id)); assert.equal(aborted, true);
      await native.main.waitForIdle(context);
      assert.deepEqual((await native.activity(String(native.main.id), true)).agentStatus, { state: "idle" });
    } finally { await native.close(); }
  });
});

test("native file adapter dispatches saved bindings and stable Pi task IDs without a hub environment", async () => {
  await fixture(async (runtime, options, path, faux) => {
    await runtime.close();
    const calls: { machineId: string; id: string; operation: string }[] = [];
    const native = await DeckRuntime.open(path, { ...options, hostFiles: { call: async (binding, id, operation) => {
      calls.push({ machineId: binding.machineId, id, operation });
      return { ok: false, output: "offline: assigned worker unavailable", code: "offline" };
    } } });
    try {
      const task = await native.createTask("Bound native tools", { machineId: "remote-offline", cwd: "/elsewhere" });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", { path: "must-not-write.txt", content: "test" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Worker is offline"),
      ]);
      await (await native.admit(String(task.id), input("native-write"))).wait(context);
      assert.equal(calls.length, 1); assert.equal(calls[0]?.machineId, "remote-offline");
      assert.equal(calls[0]?.operation, "write"); assert.match(calls[0]!.id, /^\d+$/);
      assert.match(JSON.stringify((await native.history(String(task.id))).items), /assigned worker unavailable/);
    } finally { await native.close(); }
  });
});

test("coding tools resolve only the assigned worker; offline never falls back to hub", async () => {
  await fixture(async (runtime, options, path, faux, directory) => {
    await runtime.close();
    await writeFile(join(directory, "sentinel.txt"), "assigned-worker-content");
    const bindings: string[] = [];
    const connected = await DeckRuntime.open(path, { ...options, environment: (binding) => {
      bindings.push(binding.machineId);
      return binding.machineId === "worker-a" ? new NodeExecutionEnv({ cwd: binding.cwd }) : undefined;
    } });
    try {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "sentinel.txt" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Read done"),
        fauxAssistantMessage(fauxToolCall("read", { path: join(directory, "sentinel.txt") }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Offline acknowledged"),
      ]);
      await (await connected.admit(String(connected.main.id), input("read-local"))).wait(context);
      const task = await connected.createTask("Offline", { machineId: "worker-b", cwd: directory });
      await (await connected.admit(String(task.id), input("read-offline"))).wait(context);
      const history = JSON.stringify((await connected.history(String(task.id))).items);
      assert.match(history, /unavailable/);
      assert.doesNotMatch(history, /assigned-worker-content/);
      assert.ok(bindings.includes("worker-a")); assert.ok(bindings.includes("worker-b"));
    } finally { await connected.close(); }
  });
});
