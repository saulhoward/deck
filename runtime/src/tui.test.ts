import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { freeHubPort } from "./hub-port.test.support.js";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";
import { hubCommand } from "./hub-client.js";
import { displayText, thinkingUsage, TuiSession, validRequest, validReply } from "./tui-session.js";
import type { ActivitySnapshot, HistoryEntry, ModelSettingsChange, ModelSettingsSnapshot, TuiRequest } from "./generated/contracts.js";

async function fixture(withSettings = false, withProgramStatus = false, withStyle = false, withTools = false, history: { newest?: number, pageSize?: number, hidden?: (id: number) => boolean } = {}) {
  const local = await clientEnv(); const requests: any[] = []; let loss = false, malformed = false, oversized = false, hang = false;
  let settingsLoss = false, settingsInvalid = false, plainHistory = false;
  let retainedInputs: { id: number, kind: string, data: { text: string, requestId: string } }[] = [];
  // One-shot gates make a request genuinely in-flight until a PTY checkpoint
  // releases it; tests never guess the background poll timing with sleeps.
  const gates = new Map<string, { entered: ReturnType<typeof Promise.withResolvers<any>>, reply: ReturnType<typeof Promise.withResolvers<"ok" | "fail">> }>();
  const pendingGates = new Set<ReturnType<typeof Promise.withResolvers<"ok" | "fail">>>();
  const holdNext = (command: string) => {
    assert.ok(!gates.has(command), `Already holding ${command}`);
    const entered = Promise.withResolvers<any>(), reply = Promise.withResolvers<"ok" | "fail">();
    gates.set(command, { entered, reply }); pendingGates.add(reply);
    return { entered: entered.promise, release: (outcome: "ok" | "fail" = "ok") => reply.resolve(outcome) };
  };
  const settings: ModelSettingsSnapshot = { hubId: "tui-test", chatId: "1", selection: { provider: "mock", modelId: "echo", thinkingLevel: "medium" }, defaultModel: { provider: "mock", modelId: "echo" }, models: ["echo", "zeta"].map((modelId) => ({ provider: "mock", modelId, name: modelId, thinkingLevels: ["off", "low", "medium", "high"], defaultThinkingLevel: "medium" })) };
  let statusReads = 0, statusOutcome: "done" | "error" = "done", statusId = 0;
  const activity: ActivitySnapshot = { ...(withProgramStatus ? { agentStatus: { state: "idle" as const } } : {}), chatId: "1", busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false };
  const progress = { version: 1, chatId: "1", provisional: true };
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()); requests.push(value);
    const { id, command, args } = value; let result;
    // Older-only gates cannot be consumed by a racing latest-history poll.
    const gateKey = command === "history" && args.before && gates.has("older") ? "older" : command;
    const gate = gates.get(gateKey);
    if (gate) {
      gates.delete(gateKey); gate.entered.resolve(value);
      const outcome = await gate.reply.promise; pendingGates.delete(gate.reply);
      if (outcome === "fail") { response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "internal", message: "Delayed fixture read failed" } })); return; }
    }
    if (withProgramStatus && (command === "history" || command === "activity") && activity.agentStatus?.state === "working" && ++statusReads >= 3) {
      activity.agentStatus = { state: statusOutcome, taskId: String(statusId) }; activity.busy = false;
    }
    if (command === "status") result = { ...(withTools ? { toolInventoryStatus: "ready", toolInventory: {
      chatId: "1", hubMachineId: "a".repeat(32), workerMachineId: "b".repeat(32),
      builtins: [{ name: "read", location: "worker" }, { name: "bash", location: "worker" }, { name: "task_list", location: "hub" }, { name: "custom_environment_tool", location: "environment" }],
      mcp: [{ profileId: "hub_search", machineId: "a".repeat(32), location: "hub", workspace: "fixed", revision: "c".repeat(64), state: "enabled", tools: [{ name: "search", alias: "mcp_hub_search_alias" }] },
        { profileId: "worker_browser", machineId: "b".repeat(32), location: "worker", workspace: "task", revision: "d".repeat(64), state: "not_granted", tools: [{ name: "browse", alias: "mcp_worker_browser_alias" }] }],
    } } : {}), ...(withStyle ? { machineId: "local", binding: { machineId: "local", cwd: process.cwd(), kind: "main", title: "Hub", agentName: "wintermute", agentNameAlgorithm: "wintermute-v1", agentRune: "Δ" } } : {}), ...(withSettings ? { modelSettings: 1 } : {}), hubId: "tui-test", hubGuard: 1, mainChatId: "1", chatId: "1", provider: "mock", model: { provider: "mock", modelId: "echo" }, tools: "offline" };
    else if (command === "subagent_view") {
      assert.equal(args.chatId, "1");
      const childId = args.childId ?? (args.name.toUpperCase() === "WM001" ? "2" : args.name.toUpperCase() === "WM002" ? "3" : undefined);
      if (!childId) { response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "not_found", message: "Subagent not found" } })); return; }
      const childActivity = { ...activity, chatId: childId, subagents: { chatId: childId, items: [], hasMore: false } };
      let childResult: unknown;
      if (args.operation === "status") childResult = { hubId: "tui-test", hubGuard: 1, mainChatId: "1", chatId: childId, provider: "mock", model: { provider: "mock", modelId: "echo" }, tools: "offline", binding: { machineId: "local", cwd: process.cwd(), kind: "subagent", title: "Review implementation", agentName: childId === "2" ? "WM001" : "WM002", agentNameAlgorithm: "subagent-v1", parentChatId: "1", ownerTaskId: "1" } };
      else if (args.operation === "history") {
        const newest = args.options?.before ? Number(args.options.before) - 1 : 200;
        const items = Array.from({ length: Math.min(20, newest) }, (_, i) => ({ id: newest - i, kind: "deck.input", data: { text: `CHILD ${childId} HISTORY ${newest - i}` } }));
        childResult = { items, ...(items.at(-1)!.id > 1 ? { next: String(items.at(-1)!.id) } : {}), ...(args.options?.includeActivity ? { activity: childActivity } : {}), ...(args.options?.includeProgress ? { progress: { ...progress, chatId: childId } } : {}) };
      } else if (args.operation === "activity") childResult = childActivity;
      else if (args.operation === "progress") childResult = { ...progress, chatId: childId };
      else assert.fail(`Unexpected child operation ${args.operation}`);
      result = { hubId: "tui-test", parentChatId: "1", childId, operation: args.operation, ...(args.name === undefined ? {} : { name: args.name }), result: childResult };
    }
    else if (command === "model_settings") result = settingsInvalid ? { ...settings, chatId: "2" } : settings;
    else if (command === "set_model_settings") {
      if (JSON.stringify(args.expected) !== JSON.stringify(settings.selection)) { response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "conflict", message: "Refresh settings" } })); return; }
      settings.selection = { ...args.selection };
      if (settingsLoss) { response.destroy(); return; }
      result = { hubId: settings.hubId, chatId: "1", selection: settings.selection };
    }
    else if (command === "history") {
      if (hang) return;
      if (oversized && args.limit > 1) { response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "too_large", message: "Page too large" } })); return; }
      const newest = args.before ? Number(args.before) - 1 : (history.newest ?? 120);
      let items: HistoryEntry[] = withStyle ? [{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "# Report\n**Ready** with `code`\n\n| Task | Status |\n| :--- | ---: |\n| Unicode 界 | done |\n| Rendering | ready |" }] }] }, { id: 1, kind: "deck.input", data: { text: "Please render this cleanly." } }] : Array.from({ length: Math.max(0, Math.min(args.limit, history.pageSize ?? 20, newest)) }, (_, i) => history.hidden?.(newest - i)
        ? { id: newest - i, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "DO_NOT_RENDER" }] }] }
        : { id: newest - i, kind: "deck.input", data: { text: `line ${newest - i}\nretained ${plainHistory ? "text" : "👩🏽‍💻 é"}\n\x1b]52;c;DO_NOT_RENDER\x07safe` } });
      if (retainedInputs.length) items = [...retainedInputs.filter(e => !args.before || e.id < Number(args.before)), ...items].sort((a, b) => b.id - a.id).slice(0, Math.min(args.limit, history.pageSize ?? 20));
      result = { items, ...(items.length && items.at(-1)!.id > 1 ? { next: String(items.at(-1)!.id) } : {}), ...(args.includeActivity ? { activity } : {}), ...(args.includeProgress ? { progress } : {}) };
    } else if (command === "activity") result = activity;
    else if (command === "progress") result = progress;
    else if (command === "admit") {
      if (loss) { response.destroy(); return; }
      if (withProgramStatus) { activity.agentStatus = { state: "working" }; activity.busy = true; statusReads = 0; statusId++; statusOutcome = args.text === "fail" ? "error" : "done"; }
      result = malformed ? { wrong: true } : { submissionId: "9" };
    } else if (command === "stop") result = { requested: true };
    else assert.fail(`Unexpected TUI command ${command}`);
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const session = new TuiSession((name, args, expected) => hubCommand(address.port, name, args, expected), undefined, undefined, local.env.DECK_CLIENT_STATE_DIRECTORY);
  let sequence = 0;
  const action = (action: TuiRequest["action"], text?: string, hold?: boolean, configuration?: ModelSettingsChange) => session.handle({ version: 1, id: String(++sequence), action, ...(text !== undefined ? { text } : {}), ...(hold !== undefined ? { hold } : {}), ...(configuration ? { configuration } : {}) });
  return { local, requests, port: address.port, action, holdNext, retainInputs: () => { retainedInputs = requests.filter(r => r.command === "admit").map((r, i) => ({ id: 121 + i, kind: "deck.input", data: { requestId: r.args.requestId, text: r.args.text } })); }, newest: (id: number) => { history.newest = id; }, runningTools: (names: string[]) => { activity.tools = names.map((name, i) => ({ callId: String(i + 1), name, status: "running", nested: false })); }, plainHistory: () => { plainHistory = true; }, subagents: (value: ActivitySnapshot["subagents"]) => { if (value === undefined) delete activity.subagents; else activity.subagents = value; }, settingsLoss: (value: boolean) => { settingsLoss = value; }, settingsInvalid: (value: boolean) => { settingsInvalid = value; }, loss: (value: boolean) => { loss = value; }, malformed: (value: boolean) => { malformed = value; }, oversized: () => { oversized = true; }, hang: () => { hang = true; }, close: async () => { for (const reply of pendingGates) reply.resolve("fail"); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close(); } };
}

test("TUI adapter holds bounded canonical pages, samples independently, reduces only validated too-large reads", async () => {
  const f = await fixture();
  try {
    const first = await f.action("poll"); assert.equal(first.entries.length, 20); assert.equal(first.entries[0]!.id, 101);
    assert.equal(first.hubId, "tui-test"); assert.doesNotMatch(JSON.stringify(first), /DO_NOT_RENDER|\\u001b/);
    assert.ok(validReply({ version: 1, id: "1", ok: true, snapshot: first }, "1", "tui-test", "1"));
    assert.equal(validReply({ version: 1, id: "1", ok: true, snapshot: first }, "1", "tui-test", "1", "configure"), false);
    assert.equal(validReply({ version: 1, id: "1", ok: true, snapshot: first }, "2"), false);
    assert.equal(validReply({ version: 1, id: "1", ok: true, snapshot: first }, "1", "wrong"), false);
    assert.equal(validReply({ version: 1, id: "1", ok: true, snapshot: { ...first, entries: first.entries.slice().reverse() } }, "1"), false);
    const held = await f.action("poll", undefined, true); assert.deepEqual(held.entries, first.entries);
    assert.deepEqual(f.requests.slice(-2).map((v) => v.command), ["activity", "progress"]);
    const older = await f.action("older"); assert.equal(older.historical, true); assert.equal(older.entries.at(-1)!.id, 100);
    assert.equal(f.requests.at(-1).args.before, "101");
    await f.action("poll"); assert.deepEqual(f.requests.slice(-2).map((v) => v.command), ["activity", "progress"]);
    f.oversized(); const latest = await f.action("latest"); assert.equal(latest.entries.length, 1);
    assert.deepEqual(f.requests.slice(-7).map((v) => v.args.limit), [80, 40, 20, 10, 5, 2, 1]);
    const since = f.requests.length;
    await f.action("poll");
    assert.deepEqual(f.requests.slice(since).filter(v => v.command === "history").map(v => v.args.limit), [1]);
    await f.action("older"); // The two directions learn independently.
    assert.deepEqual(f.requests.slice(-7).map(v => v.args.limit), [80, 40, 20, 10, 5, 2, 1]);
    assert.ok(f.requests.slice(1).every((v) => v.hubId === "tui-test"));
    assert.ok(f.requests.every((v) => ["status", "history", "activity", "progress"].includes(v.command)));
  } finally { await f.close(); }
});

test("a fitting history reply without optional samples cannot replay an old live preview", async () => {
  const local = await clientEnv();
  let includeSample = true;
  const session = new TuiSession(async name => {
    if (name === "status") return { hubGuard: 1, hubId: "test", chatId: "1", mainChatId: "1", tools: "offline" };
    assert.equal(name, "history");
    return { items: [], ...(includeSample ? { activity: { busy: true, queued: 1, tools: [{ status: "running", name: "bash" }, { status: "done", name: "read" }, { status: "running", name: "bash" }, { status: "running", name: "mcp_service" }] }, progress: { generation: { text: "partial" } } } : {}) };
  }, undefined, undefined, local.env.DECK_CLIENT_STATE_DIRECTORY);
  try {
    const first = await session.handle({ version: 1, id: "1", action: "poll" });
    assert.equal(first.preview, "partial"); assert.deepEqual(first.activeTools, ["bash", "mcp_service"]);
    includeSample = false;
    const next = await session.handle({ version: 1, id: "2", action: "poll" });
    assert.equal(next.preview, ""); assert.equal(next.activityKnown, false); assert.deepEqual(next.activeTools, []);
  } finally { await local.close(); }
});

test(":agentsmd keeps the source/binding on lost admission; polls only the receipt before reporting missing or applied", async () => {
  const local = await clientEnv(), store = new DraftStore("test", local.env.DECK_CLIENT_STATE_DIRECTORY);
  const binding = { machineId: "assigned", cwd: "/work" };
  const admissions: Record<string, unknown>[] = [];
  let terminal = false, applied = false, available = false, taskId = "20";
  const session = new TuiSession(async (name, args, expected) => {
    if (name === "status") return { hubId: "test", hubGuard: 1, mainChatId: "1", chatId: "1", binding, tools: "native", toolInventory: { chatId: "1", builtins: [], mcp: [], ...(applied ? { agentsMdLoaded: true } : {}) } };
    assert.equal(expected, "test");
    if (name === "history") return { items: [] };
    if (name === "import_instructions") {
      admissions.push(args); assert.deepEqual((await store.load(String(args.requestId))).request, { kind: "instructions", ...args });
      if (admissions.length === 1) throw new Error("ACK lost");
      return { taskId };
    }
    assert.equal(name, "instruction_status"); assert.deepEqual(args, { chatId: "1", taskId });
    if (!available) throw new Error("read unavailable");
    return { import: { taskId, state: terminal ? "terminal" : "running", ...(terminal ? { result: applied ? { status: "applied", source: { path: "~/.codex/AGENTS.md" } } : { status: "rejected", reason: "not_found" } } : {}) } };
  }, undefined, undefined, local.env.DECK_CLIENT_STATE_DIRECTORY);
  const act = (action: TuiRequest["action"]) => session.handle({ version: 1, id: "1", action });
  try {
    await assert.rejects(act("agentsmd"), /ACK lost/);
    assert.equal((await act("poll")).draft?.kind, "instructions"); assert.equal(admissions.length, 1);
    const ack = await act("retry"); assert.deepEqual(admissions[0], admissions[1]);
    assert.equal(admissions[0]?.source, "user"); assert.equal(admissions[0]?.machineId, binding.machineId);
    assert.equal(ack.draft, null); assert.match(ack.notice, /admitted; result unavailable/);
    available = true; assert.equal((await act("poll")).toolInventory?.agentsMdLoaded, undefined);
    terminal = true; const missing = await act("poll"); assert.match(missing.notice, /File not found: ~\/.codex\/AGENTS.md/); assert.equal(missing.toolInventory?.agentsMdLoaded, undefined);
    applied = true; taskId = "21";
    const loaded = await act("agentsmd"); assert.match(loaded.notice, /Loaded/); assert.equal(loaded.toolInventory?.agentsMdLoaded, true);
    assert.equal(admissions.length, 3); assert.notEqual(admissions[2]?.requestId, admissions[0]?.requestId);
  } finally { await local.close(); }
});

test("TUI saves exact input before admission; loss/malformed ACK preserves bytes, no replay until explicit retry", async () => {
  const f = await fixture(); const store = new DraftStore("tui-test", f.local.env.DECK_CLIENT_STATE_DIRECTORY);
  try {
    await f.action("poll"); f.loss(true);
    const text = "original\n  preserve spaces 👩🏽‍💻\n";
    await assert.rejects(f.action("send", text), /unconfirmed/);
    const summary = (await store.list())[0]!; const path = join(store.directory, `${summary.requestId}.json`); const bytes = await readFile(path);
    assert.equal((await store.load(summary.requestId)).request.kind, "input");
    const admitted = f.requests.filter((v) => v.command === "admit"); assert.equal(admitted.length, 1); assert.equal(admitted[0].args.text, text);
    const current = await f.action("poll"); assert.equal(current.draft!.requestId, summary.requestId);
    await assert.rejects(f.action("send", "different"), /unresolved/); assert.equal(f.requests.filter((v) => v.command === "admit").length, 1);
    f.loss(false); f.malformed(true); await assert.rejects(f.action("retry")); assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(f.requests.filter((v) => v.command === "admit").at(-1).args, admitted[0].args);
    f.malformed(false); const result = await f.action("retry"); assert.equal(result.draft, null); assert.deepEqual(await store.list(), []);
    const all = f.requests.filter((v) => v.command === "admit"); assert.equal(all.length, 3); assert.equal(new Set(all.map((v) => v.id)).size, 3); assert.ok(all.every((v) => v.args.requestId === summary.requestId));
  } finally { await f.close(); }
});

test("TUI disk refusal is not mistaken for a saved draft and sends no admission", async () => {
  const f = await fixture(); const root = f.local.env.DECK_CLIENT_STATE_DIRECTORY;
  try {
    await f.action("poll"); await chmod(root, 0o755);
    await assert.rejects(f.action("send", "must remain in the editor"), /private/);
    const state = await f.action("poll"); assert.equal(state.draft!.saved, false);
    assert.equal(f.requests.filter((v) => v.command === "admit").length, 0);
    await chmod(root, 0o700);
    assert.deepEqual(await new DraftStore("tui-test", root).list(), []);
    await f.action("retry");
    assert.equal(f.requests.filter((v) => v.command === "admit").length, 1);
    assert.equal(f.requests.at(-1).args.requestId, state.draft!.requestId);
  } finally { await chmod(root, 0o700); await f.close(); }
});
test("TUI stop and draft discard are distinct explicit actions", async () => {
  const f = await fixture(); const store = new DraftStore("tui-test", f.local.env.DECK_CLIENT_STATE_DIRECTORY);
  try {
    await store.save({ kind: "instructions", chatId: "1", requestId: "11111111-1111-4111-8111-111111111111", machineId: "saved-worker", cwd: "/saved" });
    const snapshot = await f.action("poll"); assert.equal(snapshot.draft!.kind, "instructions"); assert.equal(snapshot.draft!.saved, true);
    const before = f.requests.length;
    await assert.rejects(f.action("retry"), /--no-tui/); assert.equal(f.requests.length, before);
    const stopped = await f.action("stop"); assert.match(stopped.notice, /not a drained/); assert.equal(stopped.draft!.requestId, snapshot.draft!.requestId);
    const discarded = await f.action("discard"); assert.equal(discarded.draft, null); assert.deepEqual(await store.list(), []);
    assert.equal(f.requests.length, before + 1); assert.equal(f.requests.at(-1).command, "stop");
  } finally { await f.close(); }
});

test("TUI settings loss observes before new input, never replays changes or alters saved drafts", async () => {
  const f = await fixture(true);
  try {
    const before = (await f.action("poll")).modelSettings!;
    const change: ModelSettingsChange = { expected: before.selection, selection: { ...before.selection, modelId: "zeta", thinkingLevel: "high" } };
    f.settingsLoss(true);
    await assert.rejects(f.action("configure", undefined, undefined, change), /unconfirmed/);
    await assert.rejects(f.action("send", "not yet"), /unconfirmed/);
    f.settingsInvalid(true); await assert.rejects(f.action("poll"), /unconfirmed/);
    await assert.rejects(f.action("configure", undefined, undefined, change), /unconfirmed/);
    assert.equal(f.requests.filter((r) => r.command === "set_model_settings").length, 1);
    assert.ok(!f.requests.some((r) => r.command === "admit"));
    f.settingsInvalid(false); f.settingsLoss(false);
    const observed = await f.action("poll"); assert.deepEqual(observed.modelSettings!.selection, change.selection);
    f.loss(true); await assert.rejects(f.action("send", "saved input"));
    const store = new DraftStore("tui-test", f.local.env.DECK_CLIENT_STATE_DIRECTORY);
    const draft = (await store.list())[0]!; const path = join(store.directory, `${draft.requestId}.json`), bytes = await readFile(path);
    await assert.rejects(f.action("configure", undefined, undefined, { expected: change.selection, selection: before.selection }), /saved requests/);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(f.requests.filter((r) => r.command === "set_model_settings").length, 1);
  } finally { await f.close(); }
});

test("TUI closed requests and display projection reject controls without changing source bytes", () => {
  assert.equal(validRequest({ version: 1, id: "1", action: "poll", text: "not allowed" }), false);
  assert.equal(validRequest({ version: 1, id: "1", action: "send", text: "x", hold: true }), false);
  assert.equal(validRequest({ version: 1, id: "1", action: "send", text: "🧪".repeat(5000) }), false);
  assert.equal(validRequest({ version: 1, id: "1", action: "send", text: "x", extra: true }), false);
  assert.equal(validRequest({ version: 1, id: "1", action: "configure" }), false);
  assert.equal(validRequest({ version: 1, id: "1", action: "poll", configuration: { expected: { provider: "mock", modelId: "echo", thinkingLevel: "medium" }, selection: { provider: "mock", modelId: "echo", thinkingLevel: "high" } } }), false);
  const original = "ok\x1b[31mred\x1b]52;c;SECRET\x07\u009b\rtext";
  assert.equal(displayText(original, 8192), "okredtext"); assert.ok(original.includes("SECRET"));
  assert.ok(Buffer.byteLength(displayText("👩".repeat(8192), 4096)) <= 4096);
});

test("thinking usage shows only validated provider counts, not hidden reasoning", () => {
  assert.equal(thinkingUsage({ reasoning: 27, output: 50 }), 27);
  assert.equal(thinkingUsage({ reasoning: 1, output: 1 }), 1);
  for (const usage of [undefined, null, {}, [], { reasoning: 0, output: 50 }, { reasoning: 0, output: 0 }, { reasoning: 3 }, { reasoning: "3", output: 50 }, { reasoning: -1, output: 50 }, { reasoning: 1.5, output: 50 }, { reasoning: 51, output: 50 }, { reasoning: Infinity, output: Infinity }]) assert.equal(thinkingUsage(usage), undefined);
});

const testBinary = process.env.DECK_TEST_BINARY;
test("real PTY: :model and Shift-Tab change settings without losing the prompt or submitting input", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(true);
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo [medium]" }, { keys: "keep me" }, { keys: "\x1b" },
      { keys: ":model" }, { wait: ":model" }, { wait: "client idle" }, { keys: "\r" }, { wait: "MODELS" },
      { keys: "qqq" }, { wait: "No matches" }, { keys: "\r" },
      { keys: "\x15zt" }, { wait: "Search: zt" }, { keys: "\r" }, { wait: "settings applied" },
      { keys: "\x1b[Z" }, { wait: "mock/zeta [high]" },
      { keys: "\x1b[Z" }, { wait: "mock/zeta [off]" },
      { keys: "\x1b[Z" }, { wait: "mock/zeta [low]" },
      { keys: "\x1b[Z" }, { wait: "mock/zeta [medium]" },
      { keys: "\x13" }, { wait: "Input admitted" }, { keys: ":q\r" },
    ]);
    const changed = f.requests.filter((r) => r.command === "set_model_settings");
    assert.deepEqual(changed.map((r) => r.args.selection.thinkingLevel), ["medium", "high", "off", "low", "medium"]);
    assert.equal(f.requests.filter((r) => r.command === "admit").length, 1);
    assert.equal(f.requests.find((r) => r.command === "admit").args.text, "keep me");
    assert.ok(!f.requests.some((r) => r.command === "stop" || r.command === "create_task"));
  } finally { await f.close(); }
});
type PtyCheckpoints = Record<string, () => unknown | Promise<unknown>>;
async function pty(port: number, env: NodeJS.ProcessEnv, steps: unknown[], screens?: Record<string, string>, checkpoints?: PtyCheckpoints) {
  assert.ok(testBinary); const binary = resolve(testBinary);
  const driver = fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url));
  const checkpointErrors: string[] = [];
  const control = checkpoints ? createServer(async (request, response) => {
    try {
      const name = decodeURIComponent(request.url!.slice(1));
      assert.ok(Object.hasOwn(checkpoints, name), `Unknown PTY checkpoint ${name}`);
      await checkpoints[name]!(); response.end("ok");
    } catch (error) { checkpointErrors.push(String(error)); response.statusCode = 500; response.end(String(error)); }
  }) : undefined;
  try {
    const args = [driver, binary, "agent", "--tui", "--port", String(port)];
    const driverEnv: NodeJS.ProcessEnv = { ...env, DECK_NODE: process.execPath, DECK_RUNTIME_ROOT: fileURLToPath(new URL("../../", import.meta.url)) };
    if (control) {
      control.listen(0, "127.0.0.1"); await once(control, "listening");
      const address = control.address(); assert.ok(address && typeof address !== "string");
      driverEnv.DECK_TEST_CHECKPOINT_PORT = String(address.port);
    }
    // Pin the companion bridge to this build, not an installed Deck inherited
    // from the test runner (which may have older closed wire contracts).
    const child = spawn("python3", args, { env: driverEnv });
    const closed = once(child, "close"); let output = "", errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; }); child.stdin.end(JSON.stringify(steps));
    assert.equal((await closed)[0], 0, [errors, ...checkpointErrors].join("\n"));
    const result = JSON.parse(output); assert.equal(result.restored, true);
    if (screens) Object.assign(screens, result.screens);
    const terminal = Buffer.from(result.output, "base64").toString(); assert.doesNotMatch(terminal, /DO_NOT_RENDER/); return terminal;
  } finally {
    if (control) { control.closeAllConnections(); await new Promise<void>((resolve) => control.close(() => resolve())); }
  }
}
function promptRegion(screen: string) {
  const rows = screen.split("\n"), rules = rows.flatMap((row, i) => row.startsWith("─") ? [i] : []);
  assert.equal(rules.length, 2, screen);
  return { rows, upper: rules[0]!, prompt: rows.slice(rules[0]! + 1, rules[1]) };
}
function textColors(terminal: string, text: string) {
  let foreground = "default"; const colors = new Set<string>();
  for (const part of terminal.split(/(\x1b\[[0-9:;]*m)/)) {
    if (/^\x1b\[[0-9:;]*m$/.test(part)) {
      if (/^\x1b\[(?:0|39)?m$/.test(part)) foreground = "default";
      const rgb = part.match(/38[:;]2[:;](\d+)[:;](\d+)[:;](\d+)/);
      if (rgb) foreground = rgb.slice(1).join(",");
    } else if (part.includes(text)) colors.add(foreground);
  }
  return colors;
}
function assertScrollNotice(screen: string, text: string) {
  const { rows, upper } = promptRegion(screen);
  assert.equal(rows[upper - 1]!.trim(), text, "Scroll notice belongs immediately above the prompt upper rule");
  assert.equal(rows.filter(row => row.includes(text)).length, 1);
}
test("real PTY: Rex title and program status track agent work without polling flicker or stale completion", { skip: !testBinary, timeout: 25_000 }, async () => {
  const f = await fixture(false, true);
  try {
    const output = await pty(f.port, f.local.env, [
      { wait_status: "idle" }, { sleep: 1.2 },
      { keys: "work" }, { keys: "\x1b" }, { keys: ":send" }, { wait: "client idle" }, { keys: "\r" },
      { wait_status: "working" }, { wait_status: "done" }, { sleep: 1.2 },
      { keys: "\x1b" }, { wait_status: "idle" }, { sleep: 1.2 },
      { keys: "ifail" }, { keys: "\x1b" }, { keys: ":send" }, { wait: "client idle" }, { keys: "\r" },
      { wait_status: "working" }, { wait_status: "error" },
      { keys: ":help" }, { wait: "client idle" }, { sleep: 5.2 }, { wait_status: "clear" },
      { keys: "\x1b" }, { keys: ":q\r" },
    ]);
    assert.ok(output.includes("\x1b]2;Δ - hub\x1b\\"));
    const reports = [...output.matchAll(/\x1b\]7501;state=([^:\x1b]+):id=deck(?::[^\x1b]*)?\x1b\\/g)].map((m) => m[1]);
    assert.equal(reports.filter((s) => s === "working").length, 2);
    assert.equal(reports.filter((s) => s === "done").length, 1);
    assert.equal(reports.filter((s) => s === "error").length, 1);
    assert.ok(!output.includes("progress="));
    assert.equal(f.requests.filter((r) => r.command === "admit").length, 2);
    assert.ok(!f.requests.some((r) => r.command === "stop"));
  } finally { await f.close(); }
});

test("real PTY: Vim editing, literal bracketed paste, Unicode, resize, explicit submit, detach restores terminal", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { keys: "\x1b]52;c;c2VjcmV0\x07" }, { keys: "hello world" }, { keys: "\x1b" }, { keys: "0cwZig" }, { keys: "\x1b" },
      { keys: "A" }, { keys: "\x1b[200~\n:q! 👩🏽‍💻\x1b[201~" }, { keys: "\x1b" },
      { resize: [12, 32] }, { resize: [40, 100] }, { keys: ":send" }, { wait: ":send" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Input admitted" },
      { keys: "\tk" }, { keys: "\x04" }, { keys: ":older" }, { wait: ":older" }, { wait: "client idle" }, { keys: "\r" }, { wait: "line 100" },
      { keys: ":latest" }, { wait: ":latest" }, { wait: "client idle" }, { keys: "\r" }, { wait: "line 120" },
      { keys: ":q\r" },
    ]);
    const admits = f.requests.filter((v) => v.command === "admit"); assert.equal(admits.length, 1); assert.equal(admits[0].args.text, "Zig world\n:q! 👩🏽‍💻");
    assert.ok(f.requests.some((v) => v.args.before)); assert.ok(!f.requests.some((v) => ["stop", "rex_open", "create_task"].includes(v.command)));
  } finally { await f.close(); }
});
test("real PTY: uncertain input stays locked, survives detach and retries only by explicit command", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(); const store = new DraftStore("tui-test", f.local.env.DECK_CLIENT_STATE_DIRECTORY);
  try {
    f.loss(true);
    await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { keys: "keep exact bytes 👩🏽‍💻" }, { keys: "\u0013" }, { wait: "unconfirmed" },
      { wait: "SAVED LOCKED" }, { keys: "ignored edit" }, { keys: "\u0013" }, { keys: "\u001b" }, { keys: ":q\r" },
    ]);
    const saved = (await store.list())[0]!; assert.ok(saved);
    const original = f.requests.find((v) => v.command === "admit").args;
    assert.equal(f.requests.filter((v) => v.command === "admit").length, 1);
    assert.equal(original.text, "keep exact bytes 👩🏽‍💻");
    const bytes = await readFile(join(store.directory, `${saved.requestId}.json`));
    f.loss(false);
    await pty(f.port, f.local.env, [{ wait: "mock/echo" }, { keys: ":retry\r" }, { wait: "Input admitted" }, { keys: ":q\r" }]);
    assert.deepEqual(f.requests.filter((v) => v.command === "admit").at(-1).args, original);
    assert.deepEqual(JSON.parse(bytes.toString()).request, { kind: "input", ...original });
    assert.deepEqual(await store.list(), []);
  } finally { await f.close(); }
});
test("real PTY: a send queued behind a delayed poll freezes exact input and dispatches once before another poll", { skip: !testBinary, timeout: 15000 }, async () => {
  const f = await fixture(), screens: Record<string, string> = {};
  const store = new DraftStore("tui-test", f.local.env.DECK_CLIENT_STATE_DIRECTORY);
  const text = "  queued 👩🏽‍💻 é\nsecond line  \n";
  let poll: ReturnType<typeof f.holdNext>, admission: ReturnType<typeof f.holdNext>, followingPoll: ReturnType<typeof f.holdNext>;
  let heldRequest: any;
  try {
    const output = await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { keys: `\x1b[200~${text}\x1b[201~` }, { wait: "second line" }, { capture: "original" },
      { checkpoint: "hold poll" }, { keys: "\r" }, { wait: "SEND QUEUED" },
      { wait: "Message queued locally; Esc cancels before sending." }, { capture: "queued" },
      { keys: "XXXXX\x7f\x1b[13;2u" }, { keys: "\x1b[200~rejected\npaste :q!\x1b[201~" }, { keys: "\r\r\x13" }, { capture: "frozen" },
      // Locked mode must still let the wheel inspect the chat, keeping both notices.
      { keys: "\x1b[<64;4;6M" }, { wait: "Scrolled up · :latest to follow new messages" }, { capture: "lockedUp" },
      { keys: "\x1b[<65;4;6M" }, { capture: "lockedDown" },
      { checkpoint: "dispatch" }, { wait: "SENDING" }, { capture: "sending" },
      { keys: "YYYYY\r\r\x13" }, { capture: "sendingFrozen" },
      { checkpoint: "acknowledge" }, { wait: "Input admitted" }, { capture: "admitted" },
      { checkpoint: "following poll" }, { keys: "\x1b" }, { keys: ":q\r" },
    ], screens, {
      "hold poll": async () => { poll = f.holdNext("history"); heldRequest = await poll.entered; },
      dispatch: async () => {
        assert.equal(f.requests.filter(r => r.command === "admit").length, 0);
        assert.deepEqual(await store.list(), [], "A local queue must not create a durable admission draft");
        admission = f.holdNext("admit"); poll.release(); await admission.entered;
        assert.deepEqual(f.requests.slice(f.requests.indexOf(heldRequest) + 1).map(r => r.command), ["admit"], "Queued input takes the next request slot before any background poll");
      },
      acknowledge: () => { followingPoll = f.holdNext("history"); admission.release(); },
      "following poll": async () => { await followingPoll.entered; assert.equal(f.requests.filter(r => r.command === "admit").length, 1); followingPoll.release(); },
    });
    assert.ok(textColors(output, "second line").has("160,160,160"), "Queued/pending input is rendered dim");
    const original = promptRegion(screens.original!).prompt;
    for (const name of ["queued", "frozen", "lockedUp", "lockedDown", "sending", "sendingFrozen"]) assert.deepEqual(promptRegion(screens[name]!).prompt, original, name);
    for (const name of ["queued", "frozen", "lockedUp", "lockedDown"]) {
      const { rows, upper } = promptRegion(screens[name]!);
      assert.match(rows[upper]!, /SEND QUEUED/); assert.match(screens[name]!, /Message queued locally; Esc cancels before sending\./);
    }
    assertScrollNotice(screens.lockedUp!, "Scrolled up · :latest to follow new messages");
    assert.doesNotMatch(screens.lockedDown!, /Scrolled up/);
    for (const name of ["sending", "sendingFrozen"]) {
      const { rows, upper } = promptRegion(screens[name]!); assert.match(rows[upper]!, /SENDING/); assert.doesNotMatch(rows[upper]!, /SEND QUEUED/);
    }
    assert.ok(promptRegion(screens.admitted!).prompt.every(row => row.trim() === ""));
    assert.doesNotMatch(screens.admitted!, /SEND QUEUED|SENDING/);
    const admits = f.requests.filter(r => r.command === "admit");
    assert.equal(admits.length, 1); assert.equal(admits[0].args.text, text); assert.deepEqual(await store.list(), []);
    assert.ok(!f.requests.some(r => ["stop", "create_task"].includes(r.command)));
  } finally { await f.close(); }
});

for (const outcome of ["escape", "read failure"] as const) {
  test(`real PTY: queued send ${outcome} cancels locally, preserves the prompt and never sends on read recovery`, { skip: !testBinary, timeout: 15000 }, async () => {
    const f = await fixture(), screens: Record<string, string> = {};
    const text = "keep cancelled bytes 👩🏽‍💻\n  second line  ";
    let poll: ReturnType<typeof f.holdNext>, recovery: ReturnType<typeof f.holdNext>;
    try {
      const cancel = outcome === "escape" ? [{ keys: "\x1b" }, { wait: "Queued send cancelled; prompt preserved." }, { checkpoint: "release poll" }] : [{ checkpoint: "release poll" }, { wait: "Queued message not sent; prompt preserved." }];
      const output = await pty(f.port, f.local.env, [
        { wait: "mock/echo" }, { keys: `\x1b[200~${text}\x1b[201~` }, { wait: "second line" }, { capture: "original" },
        { checkpoint: "hold poll" }, { keys: "\r" }, { wait: "SEND QUEUED" }, ...cancel, { capture: "cancelled" },
        { checkpoint: "recovery poll" }, { capture: "recovered" },
        // Both paths unlock editing. Escape cancellation is Normal mode; failed
        // reads preserve Insert mode. No Enter here: no new send is authorized.
        { keys: outcome === "escape" ? "A+editable" : "+editable" }, { wait: "+editable" }, { capture: "editable" },
        { keys: "\x1b" }, { keys: ":q!\r" },
      ], screens, {
        "hold poll": async () => { poll = f.holdNext("history"); await poll.entered; },
        "release poll": () => { recovery = f.holdNext("history"); poll.release(outcome === "escape" ? "ok" : "fail"); },
        "recovery poll": async () => {
          await recovery.entered; const next = f.holdNext("history"); recovery.release();
          await next.entered; assert.equal(f.requests.filter(r => r.command === "admit").length, 0); next.release();
        },
      });
      assert.ok(textColors(output, "second line").has("160,160,160"), "Locally queued input is dim even though it never dispatches");
      for (const name of ["cancelled", "recovered"]) {
        assert.deepEqual(promptRegion(screens[name]!).prompt, promptRegion(screens.original!).prompt);
        assert.doesNotMatch(screens[name]!, /SEND QUEUED|SENDING/);
      }
      assert.match(screens.cancelled!, outcome === "escape" ? /Queued send cancelled; prompt preserved\./ : /Queued message not sent; prompt preserved\./);
      assert.notDeepEqual(promptRegion(screens.editable!).prompt, promptRegion(screens.original!).prompt);
      assert.equal(f.requests.filter(r => r.command === "admit").length, 0);
      assert.deepEqual(await new DraftStore("tui-test", f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
      assert.ok(!f.requests.some(r => ["stop", "create_task"].includes(r.command)));
    } finally { await f.close(); }
  });
}

test("real PTY: an uncertain queued admission remains saved and locked without automatic retry", { skip: !testBinary, timeout: 15000 }, async () => {
  const f = await fixture(), screens: Record<string, string> = {};
  const text = "queued admission must not replay 👩🏽‍💻";
  let poll: ReturnType<typeof f.holdNext>, recovery: ReturnType<typeof f.holdNext>;
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { keys: text }, { wait: "queued admission must not replay" }, { capture: "original" },
      { checkpoint: "hold poll" }, { keys: "\r" }, { wait: "SEND QUEUED" }, { checkpoint: "lose admission" },
      { wait: "unconfirmed" }, { wait: "LOCKED" },
      { keys: "XXXXX\r\r\x13" }, { keys: "\x1b[200~rejected paste\x1b[201~" },
      { checkpoint: "recovery poll" }, { wait: "SAVED LOCKED" }, { capture: "locked" }, { keys: "\x1b" }, { keys: ":q\r" },
    ], screens, {
      "hold poll": async () => { poll = f.holdNext("history"); await poll.entered; },
      "lose admission": () => { f.loss(true); recovery = f.holdNext("history"); poll.release(); },
      "recovery poll": async () => {
        await recovery.entered; const next = f.holdNext("history"); recovery.release();
        await next.entered; assert.equal(f.requests.filter(r => r.command === "admit").length, 1); next.release();
      },
    });
    assert.deepEqual(promptRegion(screens.locked!).prompt, promptRegion(screens.original!).prompt);
    assert.doesNotMatch(screens.locked!, /SEND QUEUED|SENDING/);
    const admits = f.requests.filter(r => r.command === "admit"); assert.equal(admits.length, 1); assert.equal(admits[0].args.text, text);
    const store = new DraftStore("tui-test", f.local.env.DECK_CLIENT_STATE_DIRECTORY), saved = await store.list(); assert.equal(saved.length, 1);
    assert.deepEqual((await store.load(saved[0]!.requestId)).request, { kind: "input", ...admits[0].args });
  } finally { await f.close(); }
});

test("real PTY: detach remains responsive while HTTP history is stalled", { skip: !testBinary, timeout: 15_000 }, async () => {
  const f = await fixture(); f.hang();
  try { await pty(f.port, f.local.env, [{ wait: "STALE" }, { sleep: .3 }, { keys: ":q\r" }]); assert.ok(f.requests.some((v) => v.command === "history")); assert.ok(!f.requests.some((v) => v.command === "stop")); }
  finally { await f.close(); }
});
test("real PTY: default hub loads personal AGENTS.md only on request and retains input and answer after detach", { skip: !testBinary, timeout: 20_000 }, async () => {
  assert.ok(testBinary); const local = await clientEnv();
  const port = await freeHubPort();
  const home = join(local.env.DECK_CLIENT_STATE_DIRECTORY, "hub-home"), env = { ...local.env, HOME: home };
  const directory = join(home, ".local/share/deck/hubs/default");
  const initialize = spawn(resolve(testBinary), ["init"], { env }); initialize.stdout.resume(); initialize.stderr.resume();
  const initialized = (await once(initialize, "close"))[0];
  if (initialized !== 0) { await local.close(); assert.fail("Scratch hub initialization failed"); }
  // Task creation now opens Rex. Keep worker discovery away from any live
  // operator server; real Rex tests use their own isolated private servers.
  const hub = spawn(resolve(testBinary), ["serve", "--mock", "--port", String(port), "--workspace", local.env.DECK_CLIENT_STATE_DIRECTORY], { env: { ...env, DECK_NODE: process.execPath, PATH: directory } });
  const closed = once(hub, "close"); let errors = ""; hub.stdout.resume(); hub.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    let status: any;
    for (let i = 0; i < 100; i++) {
      try { status = await hubCommand(port, "status"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.ok(status, errors); assert.match(status.binding.agentName, /^[a-z]+$/);
    assert.equal(JSON.parse(await readFile(join(directory, "config.json"), "utf8")).machine_id, status.machineId);
    const screens: Record<string, string> = {};
    await pty(port, local.env, [
      { resize: [40, 140] }, { wait: `${status.model.provider}/${status.model.modelId}` }, { keys: "hello from real Zig TUI" }, { keys: "\x1b" },
      { keys: ":agentsmd" }, { wait: "client idle" }, { keys: "\r" }, { wait: "File not found: ~/.codex/AGENTS.md" }, { capture: "missing" },
      { checkpoint: "install" }, { keys: ":agentsmd" }, { wait: "client idle" }, { keys: "\r" }, { wait: "AGENTS.md loaded" }, { capture: "received" },
      { keys: "\x13" }, { wait: "Input admitted" }, { wait: "Deck prototype response" }, { wait: "Δ hub" }, { keys: ":q\r" },
    ], screens, { install: async () => { await mkdir(join(home, ".codex")); await writeFile(join(home, ".codex/AGENTS.md"), "PRIVATE_PERSONAL_BODY"); } });
    assert.doesNotMatch(screens.missing!, /AGENTS.md loaded/); assert.doesNotMatch(screens.received!, /PRIVATE_PERSONAL_BODY/);
    assert.match(screens.received!, /hello from real Zig TUI/);
    const history: any = await hubCommand(port, "history", { chatId: status.chatId, limit: 80 }, status.hubId);
    assert.ok(history.items.some((v: any) => v.kind === "deck.input" && v.data.text === "hello from real Zig TUI"));
    assert.ok(history.items.some((v: any) => v.kind === "pi.assistant"));
    const settings: any = await hubCommand(port, "model_settings", { chatId: status.chatId }, status.hubId);
    await pty(port, local.env, [
      { wait: `${status.model.provider}/${status.model.modelId}` }, { wait: "Δ hub" }, { keys: "\x1b" },
      { keys: ":task TUI created task" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Rex open unconfirmed" },
      { keys: ":tasks" }, { wait: "client idle" }, { keys: "\r" }, { wait: "TASKS" }, { keys: "\x1b[B\r" },
      { wait: "Read-only task inspection" }, { wait: `[${settings.selection.thinkingLevel}]` }, { wait: "READ ONLY" },
      { keys: "itask-only input" }, { keys: "\x1b" }, { keys: ":send" }, { wait: "client idle" }, { keys: "\r" },
      { wait: "Read-only task inspection" }, { keys: ":q\r" },
    ]);
    const chats: any = await hubCommand(port, "list_chats", {}, status.hubId);
    const task = chats.items.find((c: any) => c.title === "TUI created task"); assert.ok(task);
    const taskHistory: any = await hubCommand(port, "history", { chatId: task.chatId }, status.hubId);
    assert.equal(taskHistory.items.filter((e: any) => e.kind === "deck.input").length, 0);
    assert.ok(!taskHistory.items.some((e: any) => e.kind === "pi.assistant"));
    assert.deepEqual((await hubCommand(port, "history", { chatId: status.chatId, limit: 80 }, status.hubId) as any).items, history.items);
    const after: any = await hubCommand(port, "status", {}, status.hubId); assert.equal(after.hubId, status.hubId);
  } finally {
    if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
    await closed; await local.close();
  }
});
test("real PTY: Vesper sidebar, centered Markdown/table, expanding prompt and Enter/Shift-Enter", { skip: !testBinary, timeout: 20000 }, async () => {
  const f = await fixture(true, false, true); const screens: Record<string, string> = {};
  try {
    const output = await pty(f.port, f.local.env, [
      { wait: "Report" }, { wait_row: { row: 38, text: "Δ hub" } }, { capture: "collapsed" },
      { resize: [40, 140] }, { wait_row: { row: 2, text: "Δ hub" } }, { capture: "wide" },
      { keys: "hello" }, { keys: "\x1b[13;2u" }, { keys: "second" }, { keys: "\x1b[13;2u" }, { keys: "third" }, { wait: "third" }, { capture: "expanded" },
      { keys: "\r" }, { wait: "Input admitted" }, { keys: "\x1b" },
      { resize: [40, 80] }, { wait_row: { row: 38, text: "Δ hub" } }, { capture: "narrow" },
      { keys: ":sidebar-toggle\r" }, { wait_row: { row: 2, text: "Δ hub" } }, { capture: "forced" },
      { resize: [40, 140] }, { keys: ":sidebar-toggle\r" }, { wait_row: { row: 38, text: "Δ hub" } }, { capture: "hidden" }, { keys: ":q\r" },
    ], screens);
    if (process.env.DECK_TUI_CAPTURE) console.log(JSON.stringify(screens));
    // pyte display strings omit the continuation cell of wide glyphs.
    const wide = screens.wide!.split("\n").map(row => row.replaceAll("界", "界 ")), expanded = screens.expanded!.split("\n").map(row => row.replaceAll("界", "界 "));
    assert.equal(wide[2]!.indexOf("Δ hub"), 112); assert.equal(wide[4]!.slice(89).trim(), "");
    assert.doesNotMatch(screens.wide!, /wintermute|PROMPT|NORMAL|you ·|#\d|\/16384 bytes/);
    const userRow = wide.findIndex(row => row.includes("• Please render"));
    for (const y of [userRow - 2, userRow - 1, userRow + 1, userRow + 2]) assert.equal(wide[y]!.slice(0, 88).trim(), "");
    assert.ok(wide.some(row => row.indexOf("• Please render") === 2));
    assert.ok(wide.some(row => row.indexOf("Δ Report") === 2));
    assert.equal(wide[39]!.trim(), "mock/echo [medium]");
    assert.equal(wide[39]!.indexOf("mock/echo"), 121);
    assert.ok(wide.slice(0, 37).every(row => row[88] === (row.startsWith("─") ? "┤" : "│")));
    assert.equal(wide[37]!, "─".repeat(88) + "┴" + "─".repeat(51));
    assert.match(screens.wide!, /Inventory unsupported by hub/);
    assert.doesNotMatch(screens.wide!, /:tools/);
    assert.equal(wide[30]!.slice(90).trim(), "#SUBAGENTS");
    assert.equal(wide[33]!.slice(90).trim(), "#TOOLS");
    assert.equal(wide[35]!.slice(90).trim(), "Unknown, not an empty tool list.");
    assert.ok(wide.slice(6, 30).every(row => row.slice(89).trim() === ""));
    assert.equal(wide[36]!.slice(89).trim(), ""); // Bottom sidebar padding.
    assert.ok(wide.some(row => row.indexOf("Please render") === 4));
    assert.ok(wide.slice(0, 37).filter(row => !row.startsWith("─")).every(row => row.slice(84, 88).trim() === ""));
    assert.ok(wide.some(row => row.includes("Task") && row.includes("Status")));
    assert.doesNotMatch(screens.wide!, /\*\*Ready\*\*|:---|---:/);
    assert.ok(expanded.some(row => row.indexOf("hello") === 4));
    assert.ok(expanded.some(row => row.indexOf("second") === 4));
    assert.ok(expanded.some(row => row.indexOf("third") === 4));
    const rules = (rows: string[]) => rows.flatMap((row, i) => row.startsWith("─") ? [i] : []);
    assert.equal(rules(wide)[1]! - rules(wide)[0]!, 3); // two input rows
    assert.equal(rules(expanded)[1]! - rules(expanded)[0]!, 4);
    assert.match(screens.narrow!.split("\n")[38]!, /Δ hub/);
    assert.match(screens.collapsed!.split("\n")[38]!, /Δ hub/);
    assert.ok(screens.forced!.split("\n").slice(0, 37).every(row => row.replaceAll("界", "界 ")[54] === (row.startsWith("─") ? "┤" : "│")));
    assert.match(screens.hidden!.split("\n")[38]!, /Δ hub/);
    const admits = f.requests.filter(r => r.command === "admit");
    assert.equal(admits.length, 1); assert.equal(admits[0].args.text, "hello\nsecond\nthird");
    assert.match(output, /38[:;]2[:;]255[:;]199[:;]153/);
    assert.match(output, /48[:;]2[:;]16[:;]16[:;]16/);
    assert.match(output, /48[:;]2[:;]24[:;]32[:;]48/);
    assert.match(wide[38]!, /Δ hub.*\(.*\)/);
  } finally { await f.close(); }
});

test("real PTY: prompt word-wrap survives resize without changing admitted bytes", { skip: !testBinary, timeout: 20000 }, async () => {
  const f = await fixture(); const screens: Record<string, string> = {};
  const text = "alpha beta ".repeat(12) + "tail";
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { resize: [20, 32] }, { keys: text }, { wait: "tail" }, { capture: "wrapped" },
      { resize: [20, 24] }, { wait: "tail" }, { capture: "narrow" },
      { keys: "\r" }, { wait: "Input admitted" }, { keys: "\x1b" }, { keys: ":q\r" },
    ], screens);
    for (const screen of Object.values(screens)) {
      const lines = screen.split("\n"), rules = lines.flatMap((row, i) => row.startsWith("─") ? [i] : []);
      const prompt = lines.slice(rules[0]! + 1, rules[1]);
      assert.ok(prompt.length > 2);
      assert.ok(prompt.every(row => /^(?:(?:alpha|beta|tail)| )*$/.test(row)), prompt.join("\n"));
    }
    assert.equal(f.requests.filter(r => r.command === "admit").length, 1);
    assert.equal(f.requests.find(r => r.command === "admit").args.text, text);
  } finally { await f.close(); }
});

test("real PTY: mouse wheel reporting is enabled by default with an explicit native-selection opt-out", { skip: !testBinary, timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const output = await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { keys: "\x1b" }, { keys: ":mouse-toggle\r" }, { wait: "Terminal mouse selection enabled" },
      { keys: ":mouse-toggle\r" }, { wait: "Mouse wheel reporting enabled" }, { keys: ":q\r" },
    ]);
    const enable = "\x1b[?1002;1003;1004;1006h", disable = "\x1b[?1002;1003;1004;1006;1016l";
    const initialEnable = output.indexOf(enable), optOut = output.indexOf(disable), optIn = output.indexOf(enable, optOut + disable.length);
    // Vaxis enables mouse reporting during setup; model initialization must
    // retain it rather than immediately issuing the old default disable.
    assert.ok(initialEnable >= 0 && output.indexOf(enable, initialEnable + enable.length) < optOut);
    assert.equal(output.slice(0, optOut).split(enable).length - 1, 2);
    assert.ok(optIn > optOut, "The second toggle restores wheel reporting");
    assert.ok(output.indexOf(disable, optIn + enable.length) > optIn, "Detach disables mouse reporting again");
    assert.ok(!f.requests.some(r => ["admit", "stop", "create_task"].includes(r.command)));
  } finally { await f.close(); }
});

test("real PTY: SGR wheel scrolls in Insert and chat focus, keeps the prompt, and places history notices above its rule", { skip: !testBinary, timeout: 15000 }, async () => {
  const f = await fixture(), screens: Record<string, string> = {};
  const scrolled = "Scrolled up · :latest to follow new messages", historical = "Older history · :latest to return";
  const up = "\x1b[<64;4;6M", down = "\x1b[<65;4;6M";
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { keys: "keep mouse input" }, { wait: "keep mouse input" }, { capture: "latest" },
      // No Esc/Tab: wheel reports must work while the prompt is in Insert mode.
      { keys: up.repeat(4) }, { wait: scrolled }, { capture: "insertUp" },
      { keys: " + insert" }, { wait: "keep mouse input + insert" },
      { keys: down.repeat(4) }, { capture: "insertDown" },
      // A report over the prompt also scrolls the main chat, without stealing focus.
      { keys: "\x1b[<64;4;36M" }, { wait: scrolled }, { capture: "overPrompt" },
      { keys: "\x1b[<65;4;36M" }, { keys: "\x1b" }, { keys: "\t" },
      { keys: up.repeat(4) }, { wait: scrolled }, { capture: "chatUp" },
      { keys: down.repeat(4) }, { capture: "chatDown" },
      { keys: ":older" }, { wait: "client idle" }, { keys: "\r" }, { wait: historical }, { wait: "line 100" }, { capture: "older" },
      { keys: up }, { keys: down.repeat(30) }, { wait: "line 120" }, { capture: "olderBottom" },
      { keys: ":latest" }, { wait: "client idle" }, { keys: "\r" }, { wait: "line 120" }, { capture: "returned" },
      { keys: "\x13" }, { wait: "Input admitted" }, { keys: ":q\r" },
    ], screens);
    for (const name of ["insertUp", "overPrompt", "chatUp"]) assertScrollNotice(screens[name]!, scrolled);
    assertScrollNotice(screens.older!, historical);
    for (const name of ["latest", "insertDown", "chatDown", "olderBottom", "returned"]) assert.doesNotMatch(screens[name]!, /Scrolled up|Older history|Returning to latest/);
    // pyte does not fully emulate ZWJ emoji repainting. Compare the retained
    // message IDs and their row positions, not its rendering of those clusters.
    const chat = (name: string) => {
      const { rows, upper } = promptRegion(screens[name]!);
      return rows.slice(0, upper - 1).flatMap((row, i) => { const id = row.match(/line \d+/)?.[0]; return id ? [[i, id]] : []; });
    };
    assert.notDeepEqual(chat("insertUp"), chat("latest"), "Wheel-up must move retained messages, not only show a notice");
    assert.deepEqual(chat("insertDown"), chat("latest"));
    assert.deepEqual(chat("chatUp"), chat("insertUp"));
    assert.deepEqual(chat("chatDown"), chat("latest"));
    for (const [name, screen] of Object.entries(screens)) {
      assert.equal(promptRegion(screen).prompt.map(row => row.trim()).join("\n").trim(), ["latest", "insertUp"].includes(name) ? "keep mouse input" : "keep mouse input + insert");
    }
    const admits = f.requests.filter(r => r.command === "admit");
    assert.equal(admits.length, 1); assert.equal(admits[0].args.text, "keep mouse input + insert");
    assert.ok(f.requests.some(r => r.command === "history" && r.args.before));
  } finally { await f.close(); }
});

test("real PTY: footer commands, literal slash input and Normal-mode model leader", { skip: !testBinary, timeout: 15000 }, async () => {
  const f = await fixture(true); const screens: Record<string, string> = {};
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { keys: "/model literal" }, { keys: "\x1b" },
      { keys: " m" }, { wait: "MODELS" }, { keys: "\x1b" },
      { keys: ":send" }, { wait: "client idle" }, { capture: "command" }, { keys: "\r" },
      { wait: "Input admitted" }, { keys: ":q\r" },
    ], screens);
    const rows = screens.command!.split("\n");
    assert.equal(rows[39]!.indexOf(":send"), 1);
    assert.equal(rows[39]!.indexOf("mock/echo [medium]"), 81);
    assert.equal(f.requests.filter(r => r.command === "admit").length, 1);
    assert.equal(f.requests.find(r => r.command === "admit").args.text, "/model literal");
    assert.equal(f.requests.filter(r => r.command === "set_model_settings").length, 0);
  } finally { await f.close(); }
});

for (const mode of ["ok", "exit", "oversized", "symlink", "fifo", "invalid", "missing", "interrupt", "suspend", "terminate"]) {
  test(`real PTY: external editor ${mode} restores terminal, keeps exact input and cleans private files`, { skip: !testBinary, timeout: 20000 }, async () => {
    const f = await fixture(); const root = f.local.env.DECK_CLIENT_STATE_DIRECTORY;
    const original = "draft /literal 👩‍💻"; const edited = "edited\n  exact 👩‍💻\n";
    const script = join(root, "fake editor.py"); const report = join(root, "editor-report.json");
    try {
      await writeFile(script, `import sys, os, json, stat, termios\nfrom pathlib import Path\np = Path(sys.argv[-1])\nassert sys.argv[1] == 'quoted flag'\nassert stat.S_IMODE(p.stat().st_mode) == 0o600\nassert stat.S_IMODE(p.parent.stat().st_mode) == 0o700\nassert os.tcgetpgrp(0) == os.getpgrp()\nassert termios.tcgetattr(0)[3] & termios.ICANON\nassert termios.tcgetattr(0)[3] & termios.ECHO\nPath(os.environ['EDITOR_REPORT']).write_text(json.dumps({'original': p.read_text(), 'pid': os.getpid()}))\nprint('EDITOR_READY', flush=True)\ninput()\nmode = os.environ['EDITOR_TEST_MODE']\nif mode == 'exit': sys.exit(7)\nif mode == 'symlink':\n p.unlink()\n p.symlink_to(os.environ['EDITOR_REPORT'])\nelif mode == 'fifo':\n p.unlink()\n os.mkfifo(p)\nelif mode == 'oversized': p.write_text('x' * 16385)\nelif mode == 'invalid': p.write_bytes(b'\\xff')\nelse: p.write_text(${JSON.stringify(edited)})\n`);
      const env = { ...f.local.env, TMPDIR: root, EDITOR: mode === "missing" ? "/does-not-exist/deck-editor" : `python3 "${script}" 'quoted flag'`, EDITOR_REPORT: report, EDITOR_TEST_MODE: mode };
      const steps: object[] = [{ wait: "mock/echo" }, { keys: original }, { keys: "\x1b" }, { keys: "v" }];
      if (mode !== "missing") steps.push({ wait: "EDITOR_READY" });
      if (mode === "terminate") steps.push({ signal: "SIGTERM" });
      else {
        if (mode !== "missing") steps.push({ keys: mode === "interrupt" ? "\x03" : mode === "suspend" ? "\x1a" : "\r" });
        steps.push({ wait: mode === "ok" ? "Editor contents loaded" : "Editor failed" }, { keys: ":send" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Input admitted" }, { keys: ":q\r" });
      }
      const output = await pty(f.port, env, steps);
      if (mode !== "missing") {
        const observed = JSON.parse(await readFile(report, "utf8")); assert.equal(observed.original, original);
        assert.throws(() => process.kill(observed.pid, 0), { code: "ESRCH" });
      }
      const admits = f.requests.filter(r => r.command === "admit");
      assert.equal(admits.length, mode === "terminate" ? 0 : 1);
      if (admits.length) assert.equal(admits[0].args.text, mode === "ok" ? edited : original);
      assert.equal(f.requests.filter(r => r.command === "stop").length, 0);
      assert.deepEqual((await readdir(root)).filter(name => name.startsWith("deck-editor-")), []);
      if (mode !== "terminate") assert.ok((output.match(/\x1b\[\?1049h/g) ?? []).length >= 2);
    } finally { await f.close(); }
  });
}

test("real PTY: SIGTERM restores terminal without stopping the hub", { skip: !testBinary, timeout: 15_000 }, async () => {
  const f = await fixture();
  try { await pty(f.port, f.local.env, [{ wait: "mock/echo" }, { signal: "SIGTERM" }]); assert.ok(f.requests.every((v) => ["status", "history"].includes(v.command))); }
  finally { await f.close(); }
});


test("real PTY: hub/local MCP inventory, full details and shell caveat remain read-only", { skip: !testBinary, timeout: 20000 }, async () => {
  const f = await fixture(true, false, true, true), screens: Record<string, string> = {};
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { resize: [40, 140] }, { wait: "hub_search · enabled (1)" }, { capture: "sidebar" },
      { keys: "keep this draft" }, { keys: "\x1b" }, { keys: ":tools\r" }, { wait: "mcp_hub_search_alias" }, { capture: "details" },
      { keys: "G" }, { wait: "permissions" }, { capture: "end" }, { keys: "\x1b" }, { wait: "keep this draft" },
      { resize: [12, 80] }, { keys: ":tools\r" }, { wait: "TOOLS · chat" }, { keys: "G" }, { wait: "permissions" },
      { keys: "\x1b" }, { keys: ":q!\r" },
    ], screens);
    for (const expected of ["MCP · HUB", "MCP · WORKER LOCAL", "worker_browser · not granted (1)", "BUILT-IN · WORKER LOCAL", "BUILT-IN · HUB", "ENVIRONMENT TOOLS"]) assert.ok(screens.sidebar!.includes(expected), expected);
    assert.match(screens.details!, /workspace fixed/);
    assert.match(screens.details!, /mcp_worker_browser_alias/);
    assert.match(screens.end!, /MCP is not the whole tool surface/);
    assert.ok(f.requests.every(r => ["status", "history", "model_settings"].includes(r.command)));
  } finally { await f.close(); }
});

test("real PTY: subagent sidebar updates working/done/error and unknown, reports overflow and stale reads", { skip: !testBinary, timeout: 30_000 }, async () => {
  const f = await fixture(); const screens: Record<string, string> = {};
  const children: NonNullable<ActivitySnapshot["subagents"]> = { chatId: "1", items: [{ chatId: "2", title: "Review", agentName: "WM001", status: { state: "working" } }], hasMore: false };
  // pyte predates joined-emoji widths; keep this sidebar/layout capture ASCII.
  f.plainHistory(); f.subagents({ chatId: "1", items: [], hasMore: false });
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { resize: [40, 140] }, { wait_row: { row: 30, text: "#SUBAGENTS" } }, { wait_row: { row: 31, text: "None" } },
      { checkpoint: "working" }, { wait_row: { row: 30, text: "WM001" } }, { wait_row: { row: 30, text: "working" } }, { capture: "working" },
      { keys: "\x1b" }, { keys: ":older\r" }, { wait: "Older history" },
      { checkpoint: "done" }, { wait_row: { row: 30, text: "done" } }, { capture: "done" },
      { checkpoint: "error" }, { wait_row: { row: 30, text: "error" } },
      { checkpoint: "unknown" }, { wait_row: { row: 30, text: "unknown" } },
      { checkpoint: "overflow" }, { wait: "11+ more" }, { capture: "overflow" },
      { resize: [24, 112] }, { wait: "14+ more" }, { capture: "small" },
      { resize: [40, 140] }, { checkpoint: "unavailable" }, { wait_row: { row: 31, text: "Unavailable" } },
      { checkpoint: "working" }, { wait_row: { row: 30, text: "WM001" } },
      { checkpoint: "failRead" }, { wait: "SUBAGENTS · STALE" }, { capture: "stale" },
      { keys: ":q!\r" },
    ], screens, {
      working: () => f.subagents(children),
      done: () => { children.items[0]!.status = { state: "done", taskId: "10" }; },
      error: () => { children.items[0]!.status = { state: "error", taskId: "11" }; },
      unknown: () => { delete children.items[0]!.status; },
      overflow: () => f.subagents({ chatId: "1", items: Array.from({ length: 16 }, (_, i) => ({ chatId: String(17 - i), title: "Helper", agentName: `helper-${i}`, status: { state: "working" as const } })), hasMore: true }),
      unavailable: () => f.subagents(undefined),
      failRead: async () => { const pending = f.holdNext("activity"); await pending.entered; pending.release("fail"); f.hang(); },
    });
    for (const name of ["working", "done", "overflow", "small", "stale"]) {
      assert.match(screens[name]!, /#SUBAGENTS/); assert.match(screens[name]!, /#TOOLS/); assert.doesNotMatch(screens[name]!, /:tools/);
    }
    assert.match(screens.done!, /Older history/);
    const sidebar = screens.working!.split("\n").map(row => row.slice(90).trim());
    assert.equal(sidebar[29], "#SUBAGENTS"); assert.equal(sidebar[33], "#TOOLS");
    assert.equal(sidebar[31], "Review");
    assert.equal(sidebar[35], "Unknown, not an empty tool list.");
    assert.ok(sidebar.slice(6, 29).every(row => row === ""));
    const small = screens.small!.split("\n").map(row => row.slice(90).trim());
    assert.equal(small[19], "empty tool list.");
    assert.equal(small[20], ""); assert.equal(sidebar[36], "");
    assert.doesNotMatch(screens.small!, /Inventory unavailable.*working/);
    assert.ok(f.requests.filter(r => r.command === "history" || r.command === "activity").every(r => r.args.includeSubagents === true));
    assert.ok(f.requests.every(r => ["status", "history", "activity", "progress"].includes(r.command)));
  } finally { await f.close(); }
});

// Compare every rendered chat cell, including blank margins, independently of
// the changing transport/error/history notices immediately above the prompt.
function scrollbackChat(screen: string) {
  const { rows, upper } = promptRegion(screen);
  return rows.slice(0, upper - 2);
}
const scrollbackUp = "\x1b[<64;4;6M", scrollbackDown = "\x1b[<65;4;6M";
const olderNotice = "Older history · :latest to return", loadingOlder = "Loading older history…";

test("real PTY: automatic scrollback deduplicates slow wheel bursts, anchors cached pages and returns live at the bottom", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(), screens: Record<string, string> = {}; f.plainHistory();
  const olderReads = () => f.requests.filter(r => r.command === "history" && r.args.before);
  let held = f.holdNext("older"), live: ReturnType<typeof f.holdNext>;
  try {
    await pty(f.port, f.local.env, [
      { wait: "line 120" }, { keys: "keep exact scrollback prompt" }, { capture: "latest" },
      { keys: scrollbackUp.repeat(60) }, { wait: "line 101" }, { capture: "early" },
      { checkpoint: "entered" }, { wait: loadingOlder }, { capture: "loading" },
      { keys: scrollbackUp.repeat(60) }, { capture: "burst" }, { checkpoint: "release" },
      { wait: olderNotice }, { capture: "loaded" },
      // Keep the cached bottom visible while one fresh latest read restores live mode.
      { checkpoint: "hold live" }, { keys: scrollbackDown.repeat(60) }, { wait: "Returning to latest…" }, { capture: "cachedBottom" },
      { checkpoint: "return live" }, { keys: "\x1b" },
      // Slot readiness acknowledges the read; unchanged cached text cannot.
      { keys: ":" }, { wait: "client idle" }, { keys: "\x1b" }, { wait: "line 120" }, { capture: "reset" }, { checkpoint: "hold again" },
      { keys: scrollbackUp.repeat(60) }, { wait: "line 101" }, { wait: loadingOlder }, { capture: "resetTop" },
      { checkpoint: "release again" }, { wait: olderNotice }, { keys: ":q!\r" },
    ], screens, {
      entered: async () => { assert.equal((await held.entered).args.before, "101"); },
      release: () => { assert.equal(olderReads().length, 1); held.release(); },
      "hold live": () => { live = f.holdNext("history"); },
      "return live": async () => { assert.equal((await live.entered).args.before, undefined); live.release(); },
      "hold again": () => { assert.equal(olderReads().length, 1); held = f.holdNext("older"); },
      "release again": async () => { assert.equal((await held.entered).args.before, "101"); held.release(); },
    });
    assert.doesNotMatch(screens.early!, /Loading older history/);
    for (const name of ["loading", "burst", "loaded", "resetTop"]) assert.deepEqual(scrollbackChat(screens[name]!), scrollbackChat(screens.early!), name);
    assertScrollNotice(screens.loading!, loadingOlder); assertScrollNotice(screens.loaded!, olderNotice);
    assertScrollNotice(screens.cachedBottom!, "Returning to latest…");
    // Live mode has one extra chat row; the cached bottom retains the exact
    // bottom 32 rows, shifted upward only by the dedicated history notice.
    const latest = promptRegion(screens.latest!);
    assert.deepEqual(scrollbackChat(screens.cachedBottom!), latest.rows.slice(1, latest.upper - 1));
    assert.deepEqual(scrollbackChat(screens.reset!), scrollbackChat(screens.latest!));
    assert.doesNotMatch(screens.reset!, /Older history|Scrolled up|Loading older|Returning to latest/);
    for (const screen of Object.values(screens)) assert.deepEqual(promptRegion(screen).prompt, latest.prompt);
    assert.deepEqual(olderReads().map(r => r.args.before), ["101", "101"]);
    assert.ok(f.requests.every(r => ["status", "history", "activity", "progress"].includes(r.command)));
  } finally { await f.close(); }
});

test("real PTY: automatic scrollback failure preserves the viewport and retries the same cursor only on new upward intent", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(), screens: Record<string, string> = {}; f.plainHistory();
  const olderReads = () => f.requests.filter(r => r.command === "history" && r.args.before);
  let held = f.holdNext("older");
  let poll: ReturnType<typeof f.holdNext>;
  try {
    await pty(f.port, f.local.env, [
      { wait: "line 120" }, { keys: "failure keeps this prompt" },
      { keys: scrollbackUp.repeat(60) }, { wait: loadingOlder }, { capture: "before" },
      { checkpoint: "fail" }, { wait: "Older history unavailable · scroll up to retry" }, { capture: "failed" },
      { checkpoint: "observe polls" }, { capture: "polled" },
      { keys: scrollbackUp }, { checkpoint: "retry" }, { wait: loadingOlder }, { capture: "retrying" },
      { checkpoint: "succeed" }, { wait: olderNotice }, { capture: "recovered" },
      { keys: "\x1b" }, { keys: ":q!\r" },
    ], screens, {
      fail: async () => { await held.entered; poll = f.holdNext("activity"); held.release("fail"); },
      "observe polls": async () => {
        await poll.entered;
        const next = f.holdNext("activity"); poll.release(); await next.entered; poll = next;
        assert.equal(olderReads().length, 1, "Completed background polls must not retry a failed older read");
        held = f.holdNext("older");
      },
      retry: async () => { poll.release(); assert.equal((await held.entered).args.before, "101"); },
      succeed: () => { assert.deepEqual(olderReads().map(r => r.args.before), ["101", "101"]); held.release(); },
    });
    assertScrollNotice(screens.failed!, "Older history unavailable · scroll up to retry");
    assertScrollNotice(screens.polled!, "Older history unavailable · scroll up to retry");
    for (const screen of Object.values(screens)) {
      assert.deepEqual(scrollbackChat(screen), scrollbackChat(screens.before!));
      assert.deepEqual(promptRegion(screen).prompt, promptRegion(screens.before!).prompt);
    }
    assert.deepEqual(olderReads().map(r => r.args.before), ["101", "101"]);
    assert.ok(f.requests.every(r => ["status", "history", "activity", "progress"].includes(r.command)));
  } finally { await f.close(); }
});

test("real PTY: automatic scrollback keyboard gestures traverse finite short pages and stop at the start of history", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(false, false, false, false, { newest: 14, pageSize: 2 }), screens: Record<string, string> = {}; f.plainHistory();
  let held = f.holdNext("older");
  const steps: object[] = [{ wait: "line 14" }, { keys: "short page prompt" }, { capture: "initial" }, { keys: "\x1b" }];
  const checkpoints: PtyCheckpoints = {};
  // Each different upward gesture reaches the current loaded top. Hold every
  // reply so even a burst of arrow events cannot accidentally fetch two pages.
  // Empty command mode exposes idle readiness after release without another
  // scroll gesture or any assumption about how long the reply/render takes.
  const gestures = ["\x1b[5~", "\x15", "\x02", "\t99k", "\x1b[A".repeat(32), "gg"];
  for (const [i, keys] of gestures.entries()) {
    steps.push({ keys }, { checkpoint: `entered${i}` }, { keys: ":" }, { capture: `before${i}` },
      { checkpoint: `page${i}` }, { wait: "client idle" }, { keys: "\x1b" }, { capture: `after${i}` });
    checkpoints[`entered${i}`] = async () => { await held.entered; };
    checkpoints[`page${i}`] = async () => {
      assert.equal((await held.entered).args.before, String(13 - i * 2));
      const prior = held; if (i < gestures.length - 1) held = f.holdNext("older"); prior.release();
    };
  }
  // :latest redraws its new top rows before clearing older rows below them.
  // Release that reply only after Enter, then expose every 32-byte PTY chunk:
  // seeing "line 14" mid-frame is not evidence of a completed screen update.
  steps.push({ keys: "gg" }, { wait: "Start of history · :latest to return" }, { wait: "line 1" }, { capture: "start" },
    { keys: "ggkk\x1b[A\x1b[5~\x15\x02" }, { checkpoint: "exhausted" }, { capture: "stillStart" },
    { checkpoint: "hold latest" }, { keys: ":latest" }, { wait: "client idle" }, { keys: "\r" },
    { checkpoint: "latest entered" }, { read_chunk: 32 }, { checkpoint: "release latest" },
    { wait: "line 14" }, { capture: "latest" }, { read_chunk: null }, { keys: ":q!\r" });
  let latest: ReturnType<typeof f.holdNext>;
  checkpoints["hold latest"] = () => { latest = f.holdNext("history"); };
  checkpoints["latest entered"] = async () => { assert.equal((await latest.entered).args.before, undefined); };
  checkpoints["release latest"] = () => { latest.release(); };
  checkpoints.exhausted = async () => {
    const poll = f.holdNext("activity"); await poll.entered;
    assert.deepEqual(f.requests.filter(r => r.command === "history" && r.args.before).map(r => r.args.before), ["13", "11", "9", "7", "5", "3"]);
    poll.release();
  };
  try {
    await pty(f.port, f.local.env, steps, screens, checkpoints);
    for (const i of gestures.keys()) assert.deepEqual(scrollbackChat(screens[`after${i}`]!), scrollbackChat(screens[`before${i}`]!), `short page ${i} must not jump on prepend`);
    assertScrollNotice(screens.start!, "Start of history · :latest to return");
    assert.deepEqual(scrollbackChat(screens.stillStart!), scrollbackChat(screens.start!));
    assert.deepEqual(scrollbackChat(screens.latest!), scrollbackChat(screens.initial!));
    for (const screen of Object.values(screens)) assert.deepEqual(promptRegion(screen).prompt, promptRegion(screens.initial!).prompt);
    assert.deepEqual(f.requests.filter(r => r.command === "history" && r.args.before).map(r => r.args.before), ["13", "11", "9", "7", "5", "3"]);
  } finally { await f.close(); }
});

test("real PTY: automatic scrollback cancels intent queued behind a poll but retains downward movement during an in-flight read", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(), screens: Record<string, string> = {}; f.plainHistory();
  const olderReads = () => f.requests.filter(r => r.command === "history" && r.args.before);
  let poll: ReturnType<typeof f.holdNext>, held: ReturnType<typeof f.holdNext>;
  try {
    await pty(f.port, f.local.env, [
      { wait: "line 120" }, { keys: "queued scrollback prompt" }, { checkpoint: "hold poll" },
      { keys: scrollbackUp.repeat(60) }, { wait: "line 101" }, { capture: "queuedTop" },
      { keys: scrollbackDown.repeat(4) }, { capture: "cancelled" }, { checkpoint: "cancelled" },
      { keys: scrollbackUp.repeat(4) }, { checkpoint: "dispatch" }, { wait: loadingOlder },
      { keys: scrollbackDown.repeat(4) }, { capture: "pendingDown" }, { checkpoint: "complete" },
      { wait: olderNotice }, { capture: "loadedDown" },
      // Wheel/PageUp while Help hides the chat must not create older intent.
      { keys: "\x1b" }, { keys: ":help\r" }, { wait: "HELP" },
      { keys: scrollbackUp.repeat(60) + "\x1b[5~\x15\x02" }, { checkpoint: "hidden chat" },
      { keys: "\x1b" }, { keys: ":q!\r" },
    ], screens, {
      "hold poll": async () => { poll = f.holdNext("history"); await poll.entered; },
      cancelled: async () => {
        assert.equal(olderReads().length, 0);
        const next = f.holdNext("activity"); poll.release(); await next.entered; poll = next;
        assert.equal(olderReads().length, 0, "Down cancels waiting upward intent before the slot opens");
        held = f.holdNext("older");
      },
      dispatch: async () => { poll.release(); assert.equal((await held.entered).args.before, "101"); },
      complete: () => { assert.equal(olderReads().length, 1); held.release(); },
      "hidden chat": async () => { const next = f.holdNext("activity"); await next.entered; assert.equal(olderReads().length, 1); next.release(); },
    });
    assert.notDeepEqual(scrollbackChat(screens.cancelled!), scrollbackChat(screens.queuedTop!));
    assert.deepEqual(scrollbackChat(screens.pendingDown!), scrollbackChat(screens.cancelled!));
    assert.deepEqual(scrollbackChat(screens.loadedDown!), scrollbackChat(screens.pendingDown!), "An already-sent read completes without undoing subsequent downward scrolling");
    for (const screen of Object.values(screens)) assert.deepEqual(promptRegion(screen).prompt, promptRegion(screens.queuedTop!).prompt);
    assert.deepEqual(olderReads().map(r => r.args.before), ["101"]);
  } finally { await f.close(); }
});

test("real PTY: automatic scrollback skips at most four hidden pages per gesture and resumes through sparse history", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(false, false, false, false, { newest: 8, pageSize: 1, hidden: id => id > 1 && id < 8 }), screens: Record<string, string> = {}; f.plainHistory();
  const cursors = () => f.requests.filter(r => r.command === "history" && r.args.before).map(r => r.args.before);
  let held = f.holdNext("older"), poll: ReturnType<typeof f.holdNext>;
  try {
    await pty(f.port, f.local.env, [
      { wait: "line 8" }, { keys: "sparse prompt" }, { keys: scrollbackUp }, { checkpoint: "entered" },
      { capture: "before" }, { checkpoint: "skip four" },
      { wait: olderNotice }, { capture: "budgetSpent" },
      { checkpoint: "no polling crawl" }, { keys: scrollbackUp }, { checkpoint: "resume" },
      { keys: "\x1b" }, { keys: ":" }, { wait: "client idle" }, { keys: "\x1b" }, { capture: "visiblePrepend" },
      { keys: "\tgg" }, { wait: "Start of history · :latest to return" }, { wait: "line 1" }, { capture: "start" },
      { keys: ":latest" }, { wait: "client idle" }, { keys: "\r" },
      { keys: ":" }, { wait: "client idle" }, { keys: "\x1b" }, { wait: "line 8" }, { capture: "latest" },
      // Explicit :older keeps its page-replacement semantics: this hidden page
      // must replace line 8, not enter automatic skip/cache behavior.
      { keys: ":older" }, { wait: "client idle" }, { keys: "\r" }, { wait: olderNotice }, { capture: "manual" },
      { keys: ":q!\r" },
    ], screens, {
      entered: async () => { assert.equal((await held.entered).args.before, "8"); },
      "skip four": async () => {
        for (const cursor of ["7", "6", "5"]) {
          const next = f.holdNext("older"); held.release(); held = next;
          assert.equal((await held.entered).args.before, cursor);
        }
        poll = f.holdNext("activity"); held.release(); await poll.entered;
        assert.deepEqual(cursors(), ["8", "7", "6", "5"], "One gesture may read only four invisible pages");
      },
      "no polling crawl": async () => {
        const next = f.holdNext("activity"); poll.release(); await next.entered; poll = next;
        assert.deepEqual(cursors(), ["8", "7", "6", "5"]);
        held = f.holdNext("older");
      },
      resume: async () => {
        poll.release(); assert.equal((await held.entered).args.before, "4");
        for (const cursor of ["3", "2"]) {
          const next = f.holdNext("older"); held.release(); held = next;
          assert.equal((await held.entered).args.before, cursor);
        }
        held.release();
      },
    });
    for (const name of ["budgetSpent", "visiblePrepend"]) assert.deepEqual(scrollbackChat(screens[name]!), scrollbackChat(screens.before!), name);
    assert.match(screens.start!, /line 1/); assert.match(screens.start!, /line 8/);
    assert.doesNotMatch(screens.latest!, /Start of history|Older history/);
    assert.doesNotMatch(screens.manual!, /line 8|Loading older/);
    assertScrollNotice(screens.manual!, olderNotice);
    for (const screen of Object.values(screens)) assert.deepEqual(promptRegion(screen).prompt, promptRegion(screens.before!).prompt);
    assert.deepEqual(cursors(), ["8", "7", "6", "5", "4", "3", "2", "8"]);
    assert.ok(f.requests.filter(r => r.command === "history").every(r => r.args.limit === 80), "Renderer caching must not enlarge bridge page limits");
  } finally { await f.close(); }
});


test("real PTY: subagent names open read-only history, paginate, switch siblings and return to parent", { skip: !testBinary, timeout: 30_000 }, async () => {
  const f = await fixture(); const screens: Record<string, string> = {};
  f.plainHistory();
  try {
    await pty(f.port, f.local.env, [
      { wait: "line 120" }, { resize: [40, 140] },
      { keys: "unsent" }, { keys: "\x1b" }, { keys: ":subagent wm001\r" }, { wait: "Unsent prompt preserved" },
      { keys: "ddi" }, { keys: "\x1b" }, { keys: ":subagent wM001\r" }, { wait: "CHILD 2 HISTORY 200" }, { capture: "child" },
      { keys: ":send\r" }, { wait: "Read-only" },
      { keys: ":older\r" }, { wait: "CHILD 2 HISTORY 180" },
      { keys: "\x1b[6~" }, { wait: "CHILD 2 HISTORY 200" }, { capture: "childLive" },
      { keys: ":subagent missing\r" }, { wait: "Subagent not found" },
      { keys: ":subagent wm002\r" }, { wait: "CHILD 3 HISTORY 200" }, { capture: "sibling" },
      { keys: ":parent\r" }, { wait: "line 120" }, { capture: "parent" }, { keys: ":q!\r" },
    ], screens);
    assert.match(screens.child!, /WM001/); assert.match(screens.child!, /Read-only/);
    assert.match(screens.childLive!, /WM001/); assert.match(screens.childLive!, /Read-only/);
    assert.doesNotMatch(screens.childLive!, /Older history|Returning to latest/);
    const olderIndex = f.requests.findIndex(r => r.command === "subagent_view" && r.args.operation === "history" && r.args.options?.before);
    assert.ok(olderIndex >= 0);
    assert.ok(f.requests.slice(olderIndex + 1).some(r => r.command === "subagent_view" && r.args.childId === "2" && r.args.operation === "history" && !r.args.options?.before));
    assert.match(screens.sibling!, /WM002/); assert.doesNotMatch(screens.parent!, /CHILD [23] HISTORY/);
    assert.ok(f.requests.some(r => r.command === "subagent_view" && r.args.name === "wM001"));
    assert.ok(f.requests.filter(r => r.command === "subagent_view").every(r => r.args.chatId === "1"));
    assert.ok(f.requests.every(r => ["status", "history", "activity", "progress", "subagent_view"].includes(r.command)));
  } finally { await f.close(); }
});


test("real PTY: working subagent names and active tools flicker grey-green without changing text or sending input", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(false, false, false, true); const screens: Record<string, string> = {};
  f.plainHistory();
  f.subagents({ chatId: "1", items: [
    { chatId: "3", agentName: "DS001", title: "Review implementation", status: { state: "working" } },
    { chatId: "2", agentName: "DS002", title: "Completed review", status: { state: "done", taskId: "10" } },
  ], hasMore: false });
  f.runningTools(["bash", "mcp_hub_search_alias", "mcp_worker_browser_alias"]);
  try {
    const output = await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { resize: [40, 140] }, { wait: "DS001" }, { wait: "hub_search/search" },
      { keys: "keep exact prompt" }, { sleep: 2.6 }, { capture: "active" },
      { keys: "\x1b" }, { keys: ":q!\r" },
    ], screens);
    for (const label of ["DS001", "worker · bash", "hub_search/search"]) {
      assert.deepEqual(textColors(output, label), new Set(["153,255,228", "160,160,160"]), label);
    }
    for (const label of ["DS002", "Review implementation", "Completed review", "working"]) {
      assert.deepEqual(textColors(output, label), new Set(["160,160,160"]), label);
    }
    // More updates than startup/resize/poll can produce: the idle parent has no
    // rune animation, so active sidebar color changes must drive their own redraws.
    assert.ok((output.match(/DS001/g) ?? []).length >= 8);
    assert.match(screens.active!, /DS001/); assert.match(screens.active!, /Review implementation/);
    assert.match(screens.active!, /keep exact prompt/); assert.doesNotMatch(screens.active!, /worker_browser\/browse/);
    assert.ok(f.requests.every(r => ["status", "history", "activity", "progress"].includes(r.command)));
  } finally { await f.close(); }
});


test("input admission notice clears on the next successful live or held refresh, not on failed reads or unrelated notices", async () => {
  const f = await fixture(false, true);
  try {
    await f.action("poll");
    const admitted = "Input admitted; completion not yet confirmed";
    for (const action of ["poll", "latest"] as const) {
      assert.equal((await f.action("send", "new input")).notice, admitted);
      const refreshed = await f.action(action);
      assert.equal(refreshed.notice, ""); assert.equal(refreshed.busy, true); // Dismissal is not a completion claim.
    }
    assert.equal((await f.action("send", "held input")).notice, admitted);
    assert.equal((await f.action("poll", undefined, true)).notice, "");
    assert.equal((await f.action("send", "before failed read")).notice, admitted);
    const held = f.holdNext("history"), failed = f.action("poll");
    const rejected = assert.rejects(failed, /Delayed fixture read failed/);
    await held.entered; held.release("fail"); await rejected;
    // A non-live older page cannot infer completion or dismiss the acknowledgement.
    assert.equal((await f.action("older")).notice, admitted);
    assert.equal((await f.action("latest")).notice, "");
    const stopped = (await f.action("stop")).notice;
    assert.match(stopped, /Stop requested/);
    assert.equal((await f.action("poll")).notice, stopped);
    assert.equal(f.requests.filter(r => r.command === "admit").length, 4);
  } finally { await f.close(); }
});

test("real PTY: admission acknowledgement disappears after a successful refresh without claiming completion", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(); const screens: Record<string, string> = {};
  try {
    await pty(f.port, f.local.env, [
      { wait: "line 120" }, { keys: "once only" }, { keys: "\r" }, { wait: "Input admitted" }, { capture: "admitted" },
      { checkpoint: "refreshed" }, { keys: "\x1b" }, { keys: ":" }, { wait: "client idle" }, { keys: "\x1b" }, { capture: "live" },
      { keys: ":q\r" },
    ], screens, { refreshed: async () => { const read = f.holdNext("history"); await read.entered; read.release(); } });
    assert.match(screens.admitted!, /Input admitted; completion not yet confirmed/);
    assert.doesNotMatch(screens.live!, /Input admitted|completion not yet confirmed/);
    assert.equal(f.requests.filter(r => r.command === "admit").length, 1);
  } finally { await f.close(); }
});


for (const manual of [false, true]) test(`real PTY: bottom intent waits for an in-flight ${manual ? "manual" : "automatic"} older read, then follows newly arriving messages`, { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(); const screens: Record<string, string> = {}; f.plainHistory();
  const older = f.holdNext("older"); let latest: ReturnType<typeof f.holdNext>;
  try {
    await pty(f.port, f.local.env, [
      { wait: "line 120" }, { keys: "keep bottom prompt" },
      ...(manual ? [{ keys: "\x1b" }, { keys: ":older\r" }] : [{ keys: scrollbackUp.repeat(60) }]), { checkpoint: "older entered" },
      { keys: scrollbackDown.repeat(60) }, { wait: "Returning to latest…" }, { checkpoint: "finish older" },
      { checkpoint: "finish latest" }, { wait: "line 121" }, { capture: "live" },
      { checkpoint: "new message" }, { wait: "line 122" }, { capture: "following" }, { keys: "\x1b" }, { keys: ":q!\r" },
    ], screens, {
      "older entered": async () => { await older.entered; f.newest(121); latest = f.holdNext("history"); },
      "finish older": () => { assert.equal(f.requests.filter(r => r.command === "history").length, 2); older.release(); },
      "finish latest": async () => { assert.equal((await latest.entered).args.before, undefined); latest.release(); },
      "new message": () => { f.newest(122); },
    });
    for (const screen of Object.values(screens)) {
      assert.doesNotMatch(screen, /Older history|Scrolled up|Returning to latest|Loading older/);
      assert.match(screen, /keep bottom prompt/);
    }
    assert.equal(f.requests.filter(r => r.command === "history" && r.args.before).length, 1);
    assert.ok(f.requests.every(r => ["status", "history", "activity", "progress"].includes(r.command)));
  } finally { await f.close(); }
});

test("real PTY: Page Down at a manual older page returns live; a failed latest read requires fresh downward intent", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(); const screens: Record<string, string> = {}; f.plainHistory();
  let latest: ReturnType<typeof f.holdNext>; let attempts = 0;
  try {
    await pty(f.port, f.local.env, [
      { wait: "line 120" }, { keys: "keep manual prompt" }, { keys: "\x1b" }, { keys: ":older\r" }, { wait: "line 100" },
      { checkpoint: "hold latest" }, { keys: "\x1b[6~" }, { wait: "Returning to latest…" }, { checkpoint: "fail latest" },
      { wait: "Delayed fixture read failed" }, { capture: "failed" }, { checkpoint: "no retry" },
      { keys: "\x1b[6~" }, { wait: "line 121" }, { capture: "live" }, { keys: ":q!\r" },
    ], screens, {
      "hold latest": () => { latest = f.holdNext("history"); },
      "fail latest": async () => { assert.equal((await latest.entered).args.before, undefined); attempts = f.requests.filter(r => r.command === "history").length; latest.release("fail"); },
      "no retry": async () => { const poll = f.holdNext("activity"); await poll.entered; assert.equal(f.requests.filter(r => r.command === "history").length, attempts); f.newest(121); poll.release(); },
    });
    assert.match(screens.failed!, /line 100/); assert.match(screens.failed!, /keep manual prompt/);
    assert.doesNotMatch(screens.live!, /Older history|Scrolled up|Returning to latest|Delayed fixture read failed/);
    assert.match(screens.live!, /keep manual prompt/);
    assert.ok(f.requests.every(r => ["status", "history", "activity", "progress"].includes(r.command)));
  } finally { await f.close(); }
});

test("admitted inputs remain distinct from history and drafts until an exact retained request identity is observed", async () => {
  const local = await clientEnv();
  const admissions: Record<string, any>[] = [];
  let items: any[] = [{ id: 1, kind: "deck.input", data: { text: "same text", requestId: "old" } }];
  let failRead = false, loseAck = false;
  const session = new TuiSession(async (name, args) => {
    if (name === "status") return { hubGuard: 1, hubId: "test", chatId: "1", mainChatId: "1", tools: "offline" };
    if (name === "admit") { admissions.push(args); if (loseAck) throw new Error("Lost ACK"); return { submissionId: "9" }; }
    if (name === "history") { if (failRead) throw new Error("Read failed"); return { items, activity: { chatId: "1", busy: false, queued: 0, tools: [] } }; }
    if (name === "activity") return { chatId: "1", busy: false, queued: 0, tools: [] };
    assert.equal(name, "progress"); return { version: 1, chatId: "1", provisional: true };
  }, undefined, undefined, local.env.DECK_CLIENT_STATE_DIRECTORY);
  let sequence = 0;
  const act = (action: TuiRequest["action"], text?: string, hold?: boolean) => session.handle({ version: 1, id: String(++sequence), action, ...(text === undefined ? {} : { text }), ...(hold === undefined ? {} : { hold }) });
  try {
    await act("poll");
    const first = await act("send", "same text");
    assert.deepEqual(first.admittedInputs, [{ requestId: admissions[0]!.requestId, text: "same text" }]);
    assert.equal(first.entries.length, 1); assert.equal(first.draft, null);
    const polled = await act("poll");
    assert.equal(polled.notice, ""); assert.deepEqual(polled.admittedInputs, first.admittedInputs);
    await act("send", "same text");
    assert.equal((await act("poll")).admittedInputs?.length, 2);
    items = [{ id: 2, kind: "deck.input", data: { text: "same text", requestId: admissions[0]!.requestId } }, ...items];
    assert.equal((await act("poll", undefined, true)).admittedInputs?.length, 2, "Activity/idle cannot confirm an echo");
    const observed = await act("poll");
    assert.deepEqual(observed.admittedInputs, [{ requestId: admissions[1]!.requestId, text: "same text" }]);
    assert.deepEqual(observed.entries.map(e => e.id), [1, 2]);
    failRead = true; await assert.rejects(act("latest"), /Read failed/);
    assert.deepEqual((await act("poll", undefined, true)).admittedInputs, observed.admittedInputs);
    loseAck = true; await assert.rejects(act("send", "uncertain"), /Lost ACK/);
    const uncertain = await act("poll", undefined, true);
    assert.equal(uncertain.draft?.text, "uncertain"); assert.deepEqual(uncertain.admittedInputs, observed.admittedInputs);
    // Retained input can arrive even though its ACK was lost. Explicit recovery
    // must not add a second display copy after we have already seen that identity.
    failRead = false;
    items = [{ id: 3, kind: "deck.input", data: { text: "uncertain", requestId: admissions[2]!.requestId } }, ...items];
    assert.equal((await act("poll")).admittedInputs?.length, 1);
    loseAck = false; await act("retry");
    assert.equal(admissions[2]!.requestId, admissions[3]!.requestId);
    assert.equal((await act("poll", undefined, true)).admittedInputs?.length, 1);
    items = items.filter(e => e.id !== 3);
    items = admissions.slice(1, 3).reverse().map((a, i) => ({ id: 4 - i, kind: "deck.input", data: { text: a.text, requestId: a.requestId } })).concat(items);
    const confirmed = await act("latest");
    assert.equal(confirmed.admittedInputs, undefined); assert.equal(confirmed.draft, null);
    assert.equal(admissions.length, 4, "Observation must never resend input");
    for (let i = 0; i < 18; i++) await act("send", `${i}: ${"界".repeat(4000)}\x1b]52;c;DO_NOT_RENDER\x07`);
    const bounded = (await act("poll")).admittedInputs!;
    assert.equal(bounded.length, 16); assert.match(bounded[0]!.text, /^2:/);
    assert.ok(bounded.every(input => Buffer.byteLength(input.text) <= 8192 && input.text.endsWith("[view clipped]") && !input.text.includes("DO_NOT_RENDER")));
  } finally { await local.close(); }
});

test("admitted echoes stay parent-scoped during read-only subagent inspection and return without replay", async () => {
  const f = await fixture();
  try {
    const sent = await f.action("send", "parent only");
    assert.equal((await f.action("subagent", "wm001")).admittedInputs, undefined);
    assert.equal((await f.action("poll")).admittedInputs, undefined);
    assert.deepEqual((await f.action("parent")).admittedInputs, sent.admittedInputs);
    assert.equal(f.requests.filter(r => r.command === "admit").length, 1);
  } finally { await f.close(); }
});

test("admitted echo replies enforce closed bounds, unique identities and writable scope", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.action("poll");
    const valid = (admittedInputs: unknown, extra = {}) => validReply({ version: 1, id: "1", ok: true, snapshot: { ...snapshot, admittedInputs, ...extra } }, "1");
    assert.ok(valid([{ requestId: "r", text: "界".repeat(2730) }]));
    assert.equal(valid([{ requestId: "r", text: "界".repeat(2731) }]), false);
    for (const inputs of [null, [{ text: "no identity" }], [{ requestId: "r", text: "x", id: 1 }], Array(2).fill({ requestId: "same", text: "x" }), Array.from({ length: 17 }, (_, i) => ({ requestId: String(i), text: "x" }))]) assert.equal(valid(inputs), false);
    assert.equal(valid([{ requestId: "r", text: "x" }], { chatId: "2", kind: "task" }), false);
    assert.equal(valid([{ requestId: "r", text: "x" }], { chatId: "2", kind: "subagent", inspectParentChatId: "1" }), false);
    assert.ok(valid([{ requestId: "r", text: "x" }], { chatId: "2", kind: "task", clientMode: "task" }));
  } finally { await f.close(); }
});


test("real PTY: admitted text appears immediately in grey and is replaced once by retained user history", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(), screens: Record<string, string> = {}; f.plainHistory();
  try {
    const output = await pty(f.port, f.local.env, [
      { wait: "line 120" }, { keys: "admitted echo text" }, { keys: "\r" }, { wait: "Input admitted" }, { capture: "acknowledged" },
      { checkpoint: "unobserved refresh" }, { keys: "\x1b" }, { keys: ":" }, { wait: "client idle" }, { keys: "\x1b" }, { capture: "stillUnobserved" },
      { checkpoint: "confirm history" }, { keys: ":" }, { wait: "client idle" }, { keys: "\x1b" }, { capture: "retained" }, { keys: ":q\r" },
    ], screens, {
      "unobserved refresh": async () => { const next = f.holdNext("history"); await next.entered; next.release(); },
      "confirm history": async () => { const next = f.holdNext("history"); await next.entered; f.retainInputs(); next.release(); },
    });
    for (const screen of Object.values(screens)) {
      const { rows, upper, prompt } = promptRegion(screen);
      assert.equal(rows.slice(0, upper).join("\n").split("admitted echo text").length - 1, 1);
      assert.equal(prompt.join("").trim(), "");
    }
    assert.doesNotMatch(screens.stillUnobserved!, /Input admitted/);
    assert.ok(textColors(output, "admitted echo text").has("160,160,160"));
    assert.equal(f.requests.filter(r => r.command === "admit").length, 1);
  } finally { await f.close(); }
});

test("real PTY: Tab completes commands and subagent names locally; Shift-Tab reverses without configuring or sending", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(true), screens: Record<string, string> = {};
  f.subagents({ chatId: "1", items: [{ chatId: "3", title: "Second", agentName: "WM002" }, { chatId: "2", title: "First", agentName: "WM001" }], hasMore: true });
  let requests = 0;
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo" }, { resize: [40, 140] }, { wait: "WM002" }, { keys: "keep completion prompt" }, { keys: "\x1b" },
      { keys: ":su" }, { wait: "client idle" }, { checkpoint: "start" }, { keys: "\t" }, { wait: ":subagent " }, { capture: "verb" },
      { keys: "wm\t" }, { wait: ":subagent WM001" }, { capture: "first" },
      { keys: "\t" }, { wait: ":subagent WM002" }, { keys: "\x1b[Z" }, { wait: ":subagent WM001" }, { capture: "reversed" },
      { keys: "\x1b" }, { keys: ":rex o\t" }, { wait: ":rex open" }, { capture: "rex" },
      { keys: "\x1b" }, { keys: ":se\t\t" }, { wait: ":send" }, { capture: "send" },
      { keys: "\x1b" }, { keys: ":q!\t" }, { wait: ":q!" }, { capture: "quit" },
      { keys: "\x1b" }, { keys: ":subagent missing\t" }, { wait: ":subagent missing" }, { capture: "unmatched" },
      { checkpoint: "no effects" }, { keys: "\x1b" }, { keys: ":q!\r" },
    ], screens, {
      start: () => { requests = f.requests.length; },
      "no effects": () => { assert.equal(f.requests.length, requests, "Completion must not issue reads, mutations, or settings changes"); },
    });
    for (const screen of Object.values(screens)) {
      assert.equal(promptRegion(screen).prompt.map(row => row.split("│")[0]!).join("").trim(), "keep completion prompt");
      assert.match(screen, /mock\/echo \[medium\]/);
    }
    assert.ok(f.requests.every(r => ["status", "history", "model_settings", "activity", "progress"].includes(r.command)));
  } finally { await f.close(); }
});

test("real PTY: completed subagent names execute only on Enter and siblings remain completable in read-only inspection", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(), screens: Record<string, string> = {};
  f.subagents({ chatId: "1", items: [{ chatId: "3", title: "Second", agentName: "WM002" }, { chatId: "2", title: "First", agentName: "WM001" }], hasMore: false });
  try {
    await pty(f.port, f.local.env, [
      { wait: "line 120" }, { keys: "\x1b" }, { keys: ":sub\twm\t" }, { wait: ":subagent WM001" }, { checkpoint: "not executed" },
      { keys: "\r" }, { wait: "CHILD 2 HISTORY 200" }, { capture: "child" },
      { keys: ":sub\twm\t\t" }, { wait: ":subagent WM002" }, { keys: "\r" }, { wait: "CHILD 3 HISTORY 200" }, { capture: "sibling" },
      { keys: ":pa\t" }, { wait: ":parent" }, { keys: "\r" }, { wait: "line 120" }, { capture: "parent" }, { keys: ":q\r" },
    ], screens, { "not executed": () => { assert.equal(f.requests.filter(r => r.command === "subagent_view").length, 0); } });
    assert.match(screens.child!, /Read-only/); assert.match(screens.sibling!, /Read-only/);
    assert.doesNotMatch(screens.parent!, /CHILD [23] HISTORY/);
    assert.ok(f.requests.some(r => r.command === "subagent_view" && r.args.name === "WM001"));
    assert.ok(f.requests.some(r => r.command === "subagent_view" && r.args.name === "WM002"));
    assert.ok(f.requests.every(r => ["status", "history", "activity", "progress", "subagent_view"].includes(r.command)));
  } finally { await f.close(); }
});
