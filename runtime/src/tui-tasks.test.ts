import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";
import { hubCommand } from "./hub-client.js";
import { TuiSession, validRequest, validReply } from "./tui-session.js";
import type { TuiRequest, ChatListItem } from "./generated/contracts.js";

const hub = "12345678-1234-4234-8234-123456789abc";
async function fixture() {
  const local = await clientEnv(); const requests: any[] = [];
  const flags = { phase1: false, badBriefAck: false, legacyBriefHub: false, loseCreateOnce: false, noRex: false, loseCreate: false, loseOpen: false, badSelect: false, badList: false, sparse: false, badRex: false };
  const chats: ChatListItem[] = [
    { chatId: "1", kind: "main", title: "Main", machineId: "saved-worker", cwd: "/saved/main" },
    { chatId: "2", kind: "task", title: "Existing task", machineId: "other-worker", cwd: "/saved/task" },
  ];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()); requests.push(value);
    const { command, args, id } = value; const chat = chats.find((c) => c.chatId === (args.chatId ?? "1"))!;
    let result: any;
    if (command === "status") result = { hubId: hub, hubGuard: 1, ...(flags.phase1 ? { taskBrief: 1, hostInventory: 1 } : {}), ...(flags.noRex ? {} : { rexOpen: 1 }), rexStartup: 1, mainChatId: "1", chatId: flags.badSelect ? "1" : chat.chatId, binding: chat, tools: "offline", activity: { scheduling: "running", tasks: [{ record: { otherTaskText: "OTHER_TASK_CONTENT" }, state: {} }], submissions: [] } };
    else if (command === "history") result = { items: [{ id: Number(chat.chatId) * 100, kind: "deck.input", data: { text: `history for ${chat.chatId}` } }], next: String(Number(chat.chatId) * 100) };
    else if (command === "list_hosts") result = { sampledAtMs: 1, items: [{ machineId: "a".repeat(32), kind: "local", rex: true, connection: "local" }, { machineId: "b".repeat(32), kind: "worker", rex: true, connection: "offline" }] };
    else if (command === "list_chats") result = flags.badList ? { items: [chats[1], chats[0]] } : flags.sparse && !args.after ? { items: [], next: "1" } : { items: chats.filter((c) => Number(c.chatId) > Number(args.after ?? 0)) };
    else if (command === "create_task" || command === "create_task_brief") {
      if (command === "create_task_brief" && flags.legacyBriefHub) { response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "invalid", message: "Unknown command" } })); return; }
      if (!chats.some((c) => c.chatId === "3")) chats.push({ chatId: "3", kind: "task", title: args.title, machineId: args.machineId, cwd: args.cwd, ...(command === "create_task_brief" ? { brief: { ...(args.problem === undefined ? {} : { problem: args.problem }), ...(args.description === undefined ? {} : { description: args.description }) } } : {}) });
      if (flags.loseCreate || flags.loseCreateOnce) { flags.loseCreateOnce = false; response.destroy(); return; }
      result = { chatId: "3", ...(command === "create_task_brief" ? { brief: flags.badBriefAck ? {} : chats.find(c => c.chatId === "3")!.brief } : {}) };
    } else if (command === "rex_status") result = { version: 1, hubId: hub, chatId: flags.badRex ? "1" : args.chatId, taskId: null, status: "unallocated", binding: null, previousBinding: null, bestEffort: true };
    else if (command === "rex_inspect") result = { version: 1, hubId: hub, chatId: args.chatId, requestId: hub, taskId: null, startedAtMs: 1, finishedAtMs: 2, status: "unbound", observation: null };
    else if (command === "rex_open") {
      if (flags.loseOpen) { response.destroy(); return; }
      result = { version: 1, chatId: args.chatId, requestId: args.requestId, taskId: "9", status: "admitted", completion: "not_waited", bestEffort: true };
    } else if (command === "rex_startup") result = { version: 1, taskId: "8", chatId: args.chatId, allocationId: args.allocationId, blockId: args.blockId, registered: true, observation: "matched", historical: true, live: "not_checked" };
    else if (command === "activity") result = { chatId: args.chatId, busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false };
    else if (command === "admit") result = { submissionId: "9" };
    else assert.fail(`Unexpected command ${command}`);
    // Binding projections do not contain their enclosing chat identity.
    if (result?.binding) { result.binding = { ...result.binding }; delete result.binding.chatId; }
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const session = new TuiSession((name, args, pin) => hubCommand(address.port, name, args, pin), undefined, undefined, local.env.DECK_CLIENT_STATE_DIRECTORY, address.port);
  let id = 0;
  const act = (action: TuiRequest["action"], args: Partial<TuiRequest> = {}) => session.handle({ version: 1, id: String(++id), action, ...args });
  const taskSession = () => new TuiSession((name, args, pin) => hubCommand(address.port, name, args, pin), "2", hub, local.env.DECK_CLIENT_STATE_DIRECTORY, address.port);
  return { local, requests, flags, chats, port: address.port, act, taskSession, close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await local.close(); } };
}

test("TUI task pages and selection keep identity, old reads, and target drafts isolated", async () => {
  const f = await fixture();
  try {
    const initial = await f.act("poll");
    f.flags.sparse = true;
    const empty = await f.act("tasks"); assert.equal(empty.tasks!.next, "1"); assert.deepEqual(empty.tasks!.items, []);
    const next = await f.act("tasks", { after: "1" }); assert.equal(next.tasks!.items[0]!.chatId, "2");
    f.flags.badList = true; await assert.rejects(f.act("tasks")); f.flags.badList = false;
    assert.deepEqual((await f.act("poll")).tasks, next.tasks);
    f.flags.badSelect = true; await assert.rejects(f.act("select", { chatId: "2" })); f.flags.badSelect = false;
    assert.equal((await f.act("poll")).chatId, "1");
    const store = new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY);
    await store.save({ kind: "input", chatId: "2", requestId: "11111111-1111-4111-8111-111111111111", text: "original target input", mode: "steer" });
    const selected = await f.act("select", { chatId: "2" });
    assert.equal(selected.chatId, "2"); assert.equal(selected.hubChatId, "1"); assert.equal(selected.clientMode, "hub"); assert.equal(selected.draft, null);
    assert.match(selected.notice, /Read-only/);
    assert.deepEqual(selected.entries, []); assert.equal(selected.preview, ""); assert.equal(selected.tasks, undefined); assert.equal(selected.rex, undefined);
    for (const action of ["send", "retry", "discard", "stop", "configure"] as const) {
      const change = { provider: "mock", modelId: "echo", thinkingLevel: "off" as const };
      await assert.rejects(f.act(action, action === "send" ? { text: "must not send" } : action === "configure" ? { configuration: { expected: change, selection: change } } : {}), /Read-only/);
    }
    assert.notDeepEqual((await f.act("poll")).entries, initial.entries);
    assert.ok(!f.requests.some((r) => ["admit", "stop", "create_task", "rex_open"].includes(r.command)));
    assert.equal((await store.load("11111111-1111-4111-8111-111111111111")).request.kind, "input");
    await f.act("select", { chatId: "1" }); assert.equal((await f.act("poll")).chatId, "1");
    assert.ok(f.requests.slice(1).every((r) => r.hubId === hub));
  } finally { await f.close(); }
});

test("TUI task creation saves before send and retries the same binding/identity after lost ACK", async () => {
  const f = await fixture(); const root = f.local.env.DECK_CLIENT_STATE_DIRECTORY;
  try {
    await f.act("poll"); await chmod(root, 0o755);
    await assert.rejects(f.act("create", { text: "Exact task title" }), /private/);
    assert.ok(!f.requests.some((r) => r.command === "create_task"));
    assert.equal((await f.act("poll")).draft!.saved, false);
    await chmod(root, 0o700); f.flags.loseCreate = true;
    await assert.rejects(f.act("retry"));
    const first = f.requests.find((r) => r.command === "create_task");
    assert.equal(first.args.cwd, "/saved/main"); assert.equal(first.args.machineId, "saved-worker");
    const store = new DraftStore(hub, root); const path = join(store.directory, `${first.args.requestId}.json`); const bytes = await readFile(path);
    await f.act("tasks"); await f.act("rexStatus"); await assert.rejects(f.act("select", { chatId: "2" }), /Resolve saved/);
    await assert.rejects(f.act("create", { text: "Different" })); assert.deepEqual(await readFile(path), bytes);
    f.chats[0]!.cwd = "/new/default"; f.flags.loseCreate = false;
    const state = await f.act("retry"); assert.equal(state.chatId, "1"); assert.equal(state.draft, null); assert.match(state.notice, /Task 3 created/);
    assert.deepEqual(f.requests.filter((r) => r.command === "create_task").at(-1).args, first.args);
    assert.deepEqual(await store.list(), []); assert.ok(!f.requests.some((r) => r.command === "admit" || r.command === "stop"));
  } finally { await chmod(root, 0o700); await f.close(); }
});

test("TUI Rex views stay scoped; explicit open uses the client port and never retries after loss", async () => {
  const f = await fixture();
  try {
    await f.act("poll"); await f.act("select", { chatId: "2" });
    const inspected = await f.act("rexInspect"); assert.equal(inspected.rex!.inspection!.status, "unbound");
    assert.ok(validReply({ version: 1, id: "r", ok: true, snapshot: inspected }, "r", hub, "2", "rexInspect"));
    f.flags.badRex = true; await assert.rejects(f.act("rexStatus")); f.flags.badRex = false;
    f.flags.loseOpen = true; await assert.rejects(f.act("rexOpen"), /may exist/);
    await f.act("poll"); await f.act("rexInspect");
    const opens = f.requests.filter((r) => r.command === "rex_open"); assert.equal(opens.length, 1);
    assert.equal(opens[0].args.port, f.port); assert.equal(opens[0].args.chatId, "2");
    f.flags.loseOpen = false; const ack = await f.act("rexOpen"); assert.match(ack.notice, /not ready/); assert.equal(ack.rex, undefined);
    assert.notEqual(f.requests.at(-1).args.requestId, opens[0].args.requestId);
    assert.ok(!f.requests.some((r) => ["admit", "stop", "create_task"].includes(r.command)));
  } finally { await f.close(); }
});

test("TUI task boundary rejects mixed actions, cursor drift and unauthorized chat changes", async () => {
  for (const request of [{ action: "select" }, { action: "select", chatId: "9007199254740992" }, { action: "poll", chatId: "2" }, { action: "rexOpen", text: "x" }, { action: "send", text: "x", after: "1" }, { action: "create", text: "🧪".repeat(51) }]) assert.equal(validRequest({ version: 1, id: "1", ...request }), false);
  const f = await fixture();
  try {
    const snapshot = await f.act("tasks"); const reply = { version: 1, id: "r", ok: true, snapshot };
    assert.ok(validReply(reply, "r", hub, "1", "tasks"));
    assert.equal(validReply(reply, "r", hub, "1", "tasks", undefined, "2"), false);
    assert.equal(validReply(reply, "r", hub, "2", "poll"), false);
    assert.equal(validReply(reply, "r", hub, "2", "select", "2"), false);
    assert.ok(validReply(reply, "r", hub, "2", "select", "1"));
    assert.equal(validReply({ ...reply, snapshot: { ...snapshot, tasks: { items: snapshot.tasks!.items.slice().reverse() } } }, "r"), false);
    assert.equal(validReply({ ...reply, snapshot: { ...snapshot, tasks: { items: [], after: "2", next: "2" } } }, "r"), false);
  } finally { await f.close(); }
});

test("direct task selection never grants participation; registered Rex clients cannot escape their task", async () => {
  const f = await fixture();
  try {
    const direct = f.taskSession();
    assert.equal((await direct.handle({ version: 1, id: "1", action: "poll" })).clientMode, "hub");
    await assert.rejects(direct.handle({ version: 1, id: "2", action: "send", text: "no direct input" }), /Read-only/);
    const store = new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY);
    const draft = { kind: "input" as const, chatId: "2", requestId: "11111111-1111-4111-8111-111111111111", text: "exact saved bytes", mode: "steer" as const };
    await store.save(draft);
    const task = f.taskSession();
    await task.registerStartup(hub, `block:${hub}`);
    const state = await task.handle({ version: 1, id: "1", action: "poll" });
    assert.equal(state.clientMode, "task"); assert.equal(state.draft!.text, draft.text);
    const before = f.requests.length;
    for (const request of [{ action: "tasks" }, { action: "select", chatId: "1" }, { action: "select", chatId: "3" }, { action: "create", text: "no child UI" }] as const) {
      await assert.rejects(task.handle({ version: 1, id: "2", ...request }), /locked/);
    }
    assert.equal(f.requests.length, before);
    await task.handle({ version: 1, id: "3", action: "retry" });
    assert.equal(f.requests.at(-1).command, "admit"); assert.equal(f.requests.at(-1).args.chatId, "2");
    assert.equal(f.requests.at(-1).args.text, draft.text);
    const reply = { version: 1, id: "r", ok: true, snapshot: state };
    assert.equal(validReply(reply, "r", hub, "2", "poll", undefined, undefined, "hub", "1"), false);
    assert.equal(validReply(reply, "r", hub, "2", "poll", undefined, undefined, "task", "3"), false);
    assert.equal(validReply({ ...reply, snapshot: { ...state, chatId: "1" } }, "r"), false);
    assert.equal(validReply({ ...reply, snapshot: { ...state, tasks: { items: [] } } }, "r"), false);
    assert.equal(validReply({ ...reply, snapshot: { ...state, clientMode: "hub" } }, "r"), false); // inspection cannot expose a writable draft
  } finally { await f.close(); }
});

test("task creation without Rex capability refuses before a draft or mutation", async () => {
  const f = await fixture();
  try {
    f.flags.noRex = true;
    await assert.rejects(f.act("create", { text: "not a local task" }), /Rex support is required/);
    assert.equal((await f.act("poll")).draft, null);
    assert.ok(!f.requests.some(r => ["create_task", "rex_open", "admit"].includes(r.command)));
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

test("acknowledged task creation plus lost Rex open never replays either mutation", async () => {
  const f = await fixture();
  try {
    await f.act("poll"); f.flags.loseOpen = true;
    const created = await f.act("create", { text: "Rex required" });
    assert.match(created.notice, /Task 3 created; Rex open unconfirmed/); assert.equal(created.draft, null);
    await f.act("poll"); await assert.rejects(f.act("retry"));
    assert.equal(f.requests.filter(r => r.command === "create_task").length, 1);
    assert.equal(f.requests.filter(r => r.command === "rex_open").length, 1);
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

for (const rex of [false, true]) test(`plain client ${rex ? "Rex task locked" : "direct task read-only"} cannot bypass client roles`, async () => {
  const f = await fixture();
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(f.port), "--task", "2", ...(rex ? ["--hub-id", hub, "--rex-allocation", hub] : [])], { env: { ...f.local.env, REX_BLOCK: `block:${hub}` } });
    const closed = once(child, "close"); let out = "", errors = "";
    child.stdout.on("data", c => { out += c; }); child.stderr.on("data", c => { errors += c; });
    child.stdin.end(rex ? "/tasks\n/select 1\n/hub\n/main\n/task forbidden\n/task-at {}\n/status\nallowed task input\n/exit\n" : "forbidden input\n/stop\n/instructions load\n/retry\n/discard\n/exit\n");
    assert.equal((await closed)[0], 0, errors);
    assert.match(errors, rex ? /locked/ : /Read-only/);
    assert.doesNotMatch(out, /OTHER_TASK_CONTENT/);
    assert.equal(f.requests.filter(r => r.command === "admit").length, rex ? 1 : 0);
    assert.ok(!f.requests.some(r => ["list_chats", "create_task", "stop", "import_instructions"].includes(r.command)));
    assert.ok(f.requests.every(r => r.args.chatId === "2"));
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

test("one-shot direct task input refuses without saving or sending; REX_BLOCK alone grants nothing", async () => {
  const f = await fixture();
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(f.port), "--task", "2", "--message", "must not send"], { env: { ...f.local.env, REX_BLOCK: `block:${hub}` } });
    const closed = once(child, "close"); child.stdin.end(); child.stdout.resume(); let errors = ""; child.stderr.on("data", c => { errors += c; });
    assert.equal((await closed)[0], 1); assert.match(errors, /Read-only/);
    assert.deepEqual(f.requests.map(r => r.command), ["status"]);
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

const binary = process.env.DECK_TEST_BINARY;
test("plain client /new keeps a long exact brief and uses the distinct creation command", async () => {
  const f = await fixture(); f.flags.phase1 = true;
  try {
    const form = { title: "Plain brief", machineId: "b".repeat(32), cwd: "/worker path", problem: " exact 日本語\n", description: "long description ".repeat(80) };
    const child = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(f.port)], { env: f.local.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", errors = ""; child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c));
    child.stdin.end(`/hosts\n/new ${JSON.stringify(form)}\n/exit\n`); const [code] = await once(child, "exit"); assert.equal(code, 0, errors + out);
    const creates = f.requests.filter(r => r.command === "create_task_brief"); assert.equal(creates.length, 1);
    const { requestId, ...actual } = creates[0].args; assert.deepEqual(actual, form);
    assert.equal(f.requests.filter(r => r.command === "create_task" || r.command === "admit").length, 0);
    assert.equal(f.requests.filter(r => r.command === "rex_open").length, 1);
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

for (const oldHub of [false, true]) test(`brief creation ${oldHub ? "refuses an old hub before mutation" : "rejects an incomplete ACK"} without fallback, draft loss or Rex open`, async () => {
  const f = await fixture(); f.flags.phase1 = true;
  try {
    await f.act("poll"); // Observe support before the simulated server drift.
    f.flags.legacyBriefHub = oldHub; f.flags.badBriefAck = !oldHub;
    await assert.rejects(f.act("create", { taskForm: { title: "Brief", problem: "exact" } }), oldHub ? /Unknown command/ : /acknowledgement/i);
    const creates = f.requests.filter(r => r.command.startsWith("create_task")); assert.equal(creates.length, 1); assert.equal(creates[0].command, "create_task_brief");
    assert.equal(f.chats.length, oldHub ? 2 : 3); assert.equal(f.requests.filter(r => r.command === "rex_open").length, 0);
    const store = new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY);
    const saved = await store.list(); assert.equal(saved.length, 1);
    assert.equal((await store.load(saved[0]!.requestId)).request.kind, "task");
    f.flags.legacyBriefHub = false; f.flags.badBriefAck = false;
    await f.act("retry");
    const retried = f.requests.filter(r => r.command === "create_task_brief"); assert.deepEqual(retried[0].args, retried[1].args);
    assert.deepEqual(await store.list(), []); assert.equal(f.requests.filter(r => r.command === "rex_open").length, 1);
  } finally { await f.close(); }
});

for (const lose of [false, true]) test(`real PTY: deck hub brief composer, host selection, ${lose ? "lost ACK and explicit retry" : "separate create/open"}`, { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture(); f.flags.phase1 = true; f.flags.loseCreateOnce = lose;
  try {
    const form = { title: "Brief task", machineId: "b".repeat(32), cwd: "/remote path", problem: "  Exact problem 日本語\\n", description: "LONG_BRIEF_".repeat(90) + "END_BRIEF" };
    const child = spawn("python3", [resolve("scripts/tui-pty-test.py"), binary!, "hub", "--tui", "--port", String(f.port)], { env: f.local.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", errors = ""; child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c));
    const steps: any[] = [
      { wait: "history for 1" }, { keys: "/hosts" }, { wait: "client idle" }, { keys: "\r" }, { wait: "HOSTS" }, { wait: "offline" }, { keys: "j\r" }, { wait: "TASK BRIEF" },
      { keys: ":cancel\r" }, { wait: "Unsubmitted task form cleared" }, { keys: "/new" }, { wait: "client idle" }, { keys: "\r" }, { wait: "TASK BRIEF" },
      { keys: "\x1b[200~" + JSON.stringify(form) + "\x1b[201~" }, { wait: "END_BRIEF" }, { keys: "\x1b" }, { keys: ":send" }, { wait: "client idle" }, { keys: "\r" },
    ];
    if (lose) steps.push({ wait: "LOCKED" }, { wait: "END_BRIEF" }, { keys: ":retry" }, { wait: "client idle" }, { keys: "\r" });
    steps.push({ wait: "Task 3 created" }, { keys: "/select 3" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Read-only task inspection" }, { keys: "/brief" }, { wait: "client idle" }, { keys: "\r" }, { wait: "immutable creation snapshot" }, { wait: "Exact problem" }, { keys: "\x1b" }, { keys: ":q\r" });
    child.stdin.end(JSON.stringify(steps)); const [code] = await once(child, "exit"); assert.equal(code, 0, errors + out);
    const creates = f.requests.filter(r => r.command === "create_task_brief"); assert.equal(creates.length, lose ? 2 : 1);
    assert.equal(f.requests.filter(r => r.command === "create_task").length, 0);
    const { requestId, ...actual } = creates[0].args; assert.deepEqual(actual, form);
    if (lose) assert.deepEqual(creates[0].args, creates[1].args);
    assert.equal(f.requests.filter(r => r.command === "rex_open").length, 1); assert.equal(f.requests.filter(r => r.command === "admit").length, 0);
    assert.equal(f.chats.filter(c => c.chatId === "3").length, 1); assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

for (const tui of [false, true]) test(`${tui ? "real PTY" : "plain client"}: /task-at saves exact explicit target and opens Rex without input`, { skip: tui && !binary, timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const target = { machineId: "b".repeat(32), cwd: "/remote path 🧪", title: " exact remote title " };
    const command = `/task-at ${JSON.stringify(target)}`;
    const child = tui
      ? spawn("python3", [fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url)), resolve(binary!), "agent", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } })
      : spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(f.port)], { env: f.local.env });
    const closed = once(child, "close"); child.stdout.resume(); let errors = ""; child.stderr.on("data", b => { errors += b; });
    child.stdin.end(tui ? JSON.stringify([{ wait: "history for 1" }, { keys: command }, { wait: "/task-at" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Task 3 created" }, { keys: ":q\r" }]) : `${command}\n/exit\n`);
    assert.equal((await closed)[0], 0, errors);
    const creation = f.requests.filter(r => r.command === "create_task"); assert.equal(creation.length, 1);
    for (const [key, value] of Object.entries(target)) assert.equal(creation[0].args[key], value);
    const opened = f.requests.filter(r => r.command === "rex_open"); assert.equal(opened.length, 1); assert.equal(opened[0].args.chatId, "3");
    assert.ok(f.requests.indexOf(creation[0]) < f.requests.indexOf(opened[0]));
    assert.ok(!f.requests.some(r => r.command === "admit"));
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});
test("real PTY: allocation-registered Rex TUI participates but refuses every task-navigation path", { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    Object.assign(f.chats[1]!, { agentRune: "ᚦ", agentName: "frostwire", agentNameAlgorithm: "wintermute-v1" });
    const steps: object[] = [{ wait: "history for 2" }, { wait: "Rex startup registered" }];
    for (const cmd of ["/tasks", "/hosts", "/new", "/hub", "/main", "/select 1", "/task forbidden", "/task-at {}"]) steps.push({ keys: cmd }, { wait: "client idle" }, { keys: "\r" }, { wait: "Rex task client locked" });
    // Command mode pauses polls and exposes precise transport readiness. A
    // neutral footer during normal editing does not mean Ctrl-S can be queued.
    steps.push({ keys: "iallowed in Rex" }, { keys: "\x1b" }, { keys: ":send" }, { wait: ":send" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Input admitted" }, { keys: ":q\r" });
    const child = spawn("python3", [fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url)), resolve(binary!), "agent", "--tui", "--port", String(f.port), "--task", "2", "--hub-id", hub, "--rex-allocation", hub], { env: { ...f.local.env, DECK_NODE: process.execPath, REX_BLOCK: `block:${hub}` } });
    const closed = once(child, "close"); let output = "", errors = ""; child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { errors += c; }); child.stdin.end(JSON.stringify(steps));
    assert.equal((await closed)[0], 0, errors);
    const terminal = Buffer.from(JSON.parse(output).output, "base64").toString();
    assert.ok(terminal.includes("\x1b]2;ᚦ - task\x1b\\"));
    assert.ok(!terminal.includes("\x1b]2;Δ"));
    assert.equal(f.requests.filter(r => r.command === "admit").length, 1);
    assert.equal(f.requests.find(r => r.command === "admit").args.text, "allowed in Rex");
    assert.ok(f.requests.every(r => r.args.chatId === "2"));
    assert.ok(!f.requests.some(r => ["list_chats", "create_task"].includes(r.command)));
  } finally { await f.close(); }
});

test("real PTY: hub inspection is read-only, creation opens Rex, and /hub returns", { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const command = (text: string) => [{ keys: text }, { wait: text }, { wait: "client idle" }, { keys: "\r" }];
    const steps = [
      { wait: "history for 1" }, { keys: "ikeep this" }, { keys: "\x1b" }, ...command("/tasks"), { wait: "TASKS" },
      { keys: "j\r" }, { wait: "Unsent prompt preserved" }, { keys: "\x1b" }, { wait: "keep this" }, { keys: "dd" }, { wait: "0/16384 bytes" },
      ...command("/task New task 🧪"), { wait: "Task 3 created" }, ...command("/tasks"), { wait: "New task" }, { keys: "jj\r" },
      { wait: "history for 3" }, { wait: "READ ONLY" }, { keys: "imust not edit" }, { keys: "\x1b[200~pasted input\x1b[201~" }, { keys: "\x13" }, { wait: "Read-only task inspection" }, { wait: "0/16384 bytes" }, ...command("/rex"), { wait: "Allocation: unallocated" }, { keys: "i" }, { wait: "Presence: unbound" },
      { keys: "o" }, { wait: "Rex attempt admitted" }, { keys: "\x1b" }, ...command("/hub"), { wait: "history for 1" }, { keys: ":q\r" },
    ];
    const driver = fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url));
    const child = spawn("python3", [driver, resolve(binary!), "agent", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } });
    const closed = once(child, "close"); let output = "", errors = "";
    child.stdout.on("data", (c) => { output += c; }); child.stderr.on("data", (c) => { errors += c; }); child.stdin.end(JSON.stringify(steps));
    assert.equal((await closed)[0], 0, errors); assert.equal(JSON.parse(output).restored, true);
    assert.equal(f.requests.filter((r) => r.command === "create_task").length, 1);
    assert.equal(f.requests.find((r) => r.command === "create_task").args.title, "New task 🧪");
    assert.equal(f.requests.filter((r) => r.command === "rex_open").length, 2);
    assert.ok(f.requests.filter((r) => r.command === "rex_open").every(r => r.args.chatId === "3"));
    assert.ok(!f.requests.some((r) => ["admit", "stop"].includes(r.command)));
  } finally { await f.close(); }
});
