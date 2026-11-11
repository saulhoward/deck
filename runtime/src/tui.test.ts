import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";
import { hubCommand } from "./hub-client.js";
import { displayText, TuiSession, validRequest, validReply } from "./tui-session.js";
import type { ActivitySnapshot, ModelSettingsChange, ModelSettingsSnapshot, TuiRequest } from "./generated/contracts.js";

async function fixture(withSettings = false, withProgramStatus = false) {
  const local = await clientEnv(); const requests: any[] = []; let loss = false, malformed = false, oversized = false, hang = false;
  let settingsLoss = false, settingsInvalid = false;
  const settings: ModelSettingsSnapshot = { hubId: "tui-test", chatId: "1", selection: { provider: "mock", modelId: "echo", thinkingLevel: "medium" }, defaultModel: { provider: "mock", modelId: "echo" }, models: ["echo", "zeta"].map((modelId) => ({ provider: "mock", modelId, name: modelId, thinkingLevels: ["off", "low", "medium", "high"], defaultThinkingLevel: "medium" })) };
  let statusReads = 0, statusOutcome: "done" | "error" = "done", statusId = 0;
  const activity: ActivitySnapshot = { ...(withProgramStatus ? { agentStatus: { state: "idle" as const } } : {}), chatId: "1", busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false };
  const progress = { version: 1, chatId: "1", provisional: true };
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()); requests.push(value);
    const { id, command, args } = value; let result;
    if (withProgramStatus && (command === "history" || command === "activity") && activity.agentStatus?.state === "working" && ++statusReads >= 3) {
      activity.agentStatus = { state: statusOutcome, taskId: String(statusId) }; activity.busy = false;
    }
    if (command === "status") result = { ...(withSettings ? { modelSettings: 1 } : {}), hubId: "tui-test", hubGuard: 1, mainChatId: "1", chatId: "1", provider: "mock", model: { provider: "mock", modelId: "echo" }, tools: "offline" };
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
      const newest = args.before ? Number(args.before) - 1 : 120;
      const items = Array.from({ length: Math.min(args.limit, 20) }, (_, i) => ({ id: newest - i, kind: "deck.input", data: { text: `line ${newest - i}\nretained 👩🏽‍💻 é\n\x1b]52;c;DO_NOT_RENDER\x07safe` } }));
      result = { items, next: String(items.at(-1)!.id), ...(args.includeActivity ? { activity } : {}), ...(args.includeProgress ? { progress } : {}) };
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
  return { local, requests, port: address.port, action, settingsLoss: (value: boolean) => { settingsLoss = value; }, settingsInvalid: (value: boolean) => { settingsInvalid = value; }, loss: (value: boolean) => { loss = value; }, malformed: (value: boolean) => { malformed = value; }, oversized: () => { oversized = true; }, hang: () => { hang = true; }, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close(); } };
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
    assert.ok(f.requests.slice(1).every((v) => v.hubId === "tui-test"));
    assert.ok(f.requests.every((v) => ["status", "history", "activity", "progress"].includes(v.command)));
  } finally { await f.close(); }
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

const testBinary = process.env.DECK_TEST_BINARY;
test("real PTY: /model and Shift-Tab change settings without losing the prompt or submitting input", { skip: !testBinary, timeout: 20_000 }, async () => {
  const f = await fixture(true);
  try {
    await pty(f.port, f.local.env, [
      { wait: "mock/echo [medium]" }, { keys: "ikeep me" }, { keys: "\x1b" },
      { keys: "/model" }, { wait: "/model" }, { wait: "client idle" }, { keys: "\r" }, { wait: "MODELS" },
      { keys: "j\r" }, { wait: "settings applied" },
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
async function pty(port: number, env: NodeJS.ProcessEnv, steps: unknown[]) {
  assert.ok(testBinary); const binary = resolve(testBinary);
  const driver = fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url));
  const child = spawn("python3", [driver, binary, "agent", "--tui", "--port", String(port)], { env: { ...env, DECK_NODE: process.execPath } });
  const closed = once(child, "close"); let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; }); child.stdin.end(JSON.stringify(steps));
  assert.equal((await closed)[0], 0, errors);
  const result = JSON.parse(output); assert.equal(result.restored, true);
  const terminal = Buffer.from(result.output, "base64").toString(); assert.doesNotMatch(terminal, /DO_NOT_RENDER/); return terminal;
}
test("real PTY: Rex title and program status track agent work without polling flicker or stale completion", { skip: !testBinary, timeout: 25_000 }, async () => {
  const f = await fixture(false, true);
  try {
    const output = await pty(f.port, f.local.env, [
      { wait_status: "idle" }, { sleep: 1.2 },
      { keys: "iwork" }, { keys: "\x1b" }, { keys: ":send" }, { wait: "client idle" }, { keys: "\r" },
      { wait_status: "working" }, { wait_status: "done" }, { sleep: 1.2 },
      { keys: "\x1b" }, { wait_status: "idle" }, { sleep: 1.2 },
      { keys: "ifail" }, { keys: "\x1b" }, { keys: ":send" }, { wait: "client idle" }, { keys: "\r" },
      { wait_status: "working" }, { wait_status: "error" },
      { keys: ":help" }, { wait: "client idle" }, { sleep: 5.2 }, { wait_status: "clear" },
      { keys: "\x1b" }, { keys: ":q\r" },
    ]);
    assert.ok(output.includes(`\x1b]2;Δ - ${basename(process.cwd())}\x1b\\`));
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
      { wait: "mock/echo" }, { keys: "\x1b]52;c;c2VjcmV0\x07" }, { keys: "ihello world" }, { keys: "\x1b" }, { keys: "0cwZig" }, { keys: "\x1b" },
      { keys: "A" }, { keys: "\x1b[200~\n:q! 👩🏽‍💻\x1b[201~" }, { keys: "\x1b" },
      { resize: [12, 32] }, { resize: [40, 100] }, { keys: ":send" }, { wait: ":send" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Input admitted" },
      { keys: "\tgg" }, { keys: "\x04" }, { keys: ":older" }, { wait: ":older" }, { wait: "client idle" }, { keys: "\r" }, { wait: "line 100" },
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
      { wait: "mock/echo" }, { keys: "ikeep exact bytes 👩🏽‍💻" }, { keys: "\u0013" }, { wait: "unconfirmed" },
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
test("real PTY: detach remains responsive while HTTP history is stalled", { skip: !testBinary, timeout: 15_000 }, async () => {
  const f = await fixture(); f.hang();
  try { await pty(f.port, f.local.env, [{ wait: "waiting" }, { sleep: .3 }, { keys: ":q\r" }]); assert.ok(f.requests.some((v) => v.command === "history")); assert.ok(!f.requests.some((v) => v.command === "stop")); }
  finally { await f.close(); }
});
test("real PTY: real isolated mock hub retains input and answer after TUI detach", { skip: !testBinary, timeout: 20_000 }, async () => {
  assert.ok(testBinary); const local = await clientEnv();
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const directory = join(local.env.DECK_CLIENT_STATE_DIRECTORY, "hub");
  const initialize = spawn(resolve(testBinary), ["init", "--directory", directory], { env: local.env }); initialize.stdout.resume(); initialize.stderr.resume();
  const initialized = (await once(initialize, "close"))[0];
  if (initialized !== 0) { await local.close(); assert.fail("Scratch hub initialization failed"); }
  const hub = spawn(resolve(testBinary), ["serve", "--mock", "--port", String(port), "--directory", directory, "--workspace", local.env.DECK_CLIENT_STATE_DIRECTORY], { env: local.env });
  const closed = once(hub, "close"); let errors = ""; hub.stdout.resume(); hub.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    let status: any;
    for (let i = 0; i < 100; i++) {
      try { status = await hubCommand(port, "status"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.ok(status, errors);
    await pty(port, local.env, [
      { wait: `${status.model.provider}/${status.model.modelId}` }, { keys: "ihello from real Zig TUI" }, { keys: "\x13" },
      { wait: "Input admitted" }, { wait: "Deck prototype response" }, { keys: ":q\r" },
    ]);
    const history: any = await hubCommand(port, "history", { chatId: status.chatId, limit: 80 }, status.hubId);
    assert.ok(history.items.some((v: any) => v.kind === "deck.input" && v.data.text === "hello from real Zig TUI"));
    assert.ok(history.items.some((v: any) => v.kind === "pi.assistant"));
    const settings: any = await hubCommand(port, "model_settings", { chatId: status.chatId }, status.hubId);
    await pty(port, local.env, [
      { wait: `${status.model.provider}/${status.model.modelId}` },
      { keys: "/task TUI created task" }, { wait: "client idle" }, { keys: "\r" }, { wait: "created; /select" },
      { keys: "/tasks" }, { wait: "client idle" }, { keys: "\r" }, { wait: "TASKS" }, { keys: "j\r" },
      { wait: "deck / TUI created task" }, { wait: `[${settings.selection.thinkingLevel}]` },
      { keys: "itask-only input" }, { keys: "\x1b" }, { keys: ":send" }, { wait: "client idle" }, { keys: "\r" },
      { wait: "Input admitted" }, { wait: "Deck prototype response" }, { keys: ":q\r" },
    ]);
    const chats: any = await hubCommand(port, "list_chats", {}, status.hubId);
    const task = chats.items.find((c: any) => c.title === "TUI created task"); assert.ok(task);
    const taskHistory: any = await hubCommand(port, "history", { chatId: task.chatId }, status.hubId);
    assert.equal(taskHistory.items.filter((e: any) => e.kind === "deck.input").length, 1);
    assert.ok(taskHistory.items.some((e: any) => e.kind === "deck.input" && e.data.text === "task-only input"));
    assert.deepEqual((await hubCommand(port, "history", { chatId: status.chatId, limit: 80 }, status.hubId) as any).items, history.items);
    const after: any = await hubCommand(port, "status", {}, status.hubId); assert.equal(after.hubId, status.hubId);
  } finally {
    if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
    await closed; await local.close();
  }
});
test("real PTY: SIGTERM restores terminal without stopping the hub", { skip: !testBinary, timeout: 15_000 }, async () => {
  const f = await fixture();
  try { await pty(f.port, f.local.env, [{ wait: "mock/echo" }, { signal: "SIGTERM" }]); assert.ok(f.requests.every((v) => ["status", "history"].includes(v.command))); }
  finally { await f.close(); }
});
