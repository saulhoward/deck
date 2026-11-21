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
  const flags = { loseManagedOpenOnce: false, managedOpen: false, parentRex: false, badParentMachine: false, badParentCwd: false, badOpenAck: false, managed: false, badManagedAck: false, phase1: false, badBriefAck: false, legacyBriefHub: false, loseCreateOnce: false, offlineReadsAfterCreate: false, noRex: false, loseCreate: false, loseOpen: false, badSelect: false, badList: false, sparse: false, badRex: false };
  const chats: ChatListItem[] = [
    { chatId: "1", kind: "main", title: "Main", machineId: "saved-worker", cwd: "/saved/main" },
    { chatId: "2", kind: "task", title: "Existing task", machineId: "other-worker", cwd: "/saved/task" },
  ];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()); requests.push(value);
    const { command, args, id } = value; const chat = chats.find((c) => c.chatId === (args.chatId ?? "1"))!;
    let result: any;
    // Keep the lost-ACK case stale until its explicit retry. A fast successful
    // background read must not hide the disconnected rendering path.
    if (flags.offlineReadsAfterCreate && chats.some(c => c.chatId === "3") && (command === "status" || command === "history")) { response.destroy(); return; }
    if (command === "status") result = { hubId: hub, hubGuard: 1, ...(flags.managed ? { managedChildren: 1, managedChildProblem: 1 } : {}), ...(flags.managedOpen ? { managedChildOpen: 1 } : {}), ...(flags.phase1 ? { taskBrief: 1, hostInventory: 1 } : {}), ...(flags.noRex ? {} : { rexOpen: 1 }), rexStartup: 1, mainChatId: "1", chatId: flags.badSelect ? "1" : chat.chatId, binding: chat, tools: "offline", activity: { scheduling: "running", tasks: [{ record: { otherTaskText: "OTHER_TASK_CONTENT" }, state: {} }], submissions: [] } };
    else if (command === "history") result = { items: [{ id: Number(chat.chatId) * 100, kind: "deck.input", data: { text: `history for ${chat.chatId}` } }], next: String(Number(chat.chatId) * 100) };
    else if (command === "list_hosts") result = { sampledAtMs: 1, items: [{ machineId: "a".repeat(32), kind: "local", rex: true, connection: "local" }, { machineId: "b".repeat(32), kind: "worker", rex: true, connection: "offline" }] };
    else if (command === "list_chats") result = flags.badList ? { items: [chats[1], chats[0]] } : flags.sparse && !args.after ? { items: [], next: "1" } : { items: chats.filter((c) => Number(c.chatId) > Number(args.after ?? 0)) };
    else if (command === "create_managed_child") {
      const parent = chats.find(c => c.chatId === args.parentChatId)!;
      const brief = { ...(args.problem === undefined ? {} : { problem: args.problem }), ...(args.description === undefined ? {} : { description: args.description }) };
      if (!chats.some(c => c.chatId === "3")) chats.push({ chatId: "3", kind: "task", title: args.title ?? "DS003", agentName: "DS003", machineId: parent.machineId, cwd: parent.cwd, managedParentChatId: parent.chatId, brief });
      if (flags.loseCreate || flags.loseCreateOnce) { flags.loseCreateOnce = false; response.destroy(); return; }
      flags.offlineReadsAfterCreate = false;
      result = { chatId: "3", parentChatId: flags.badManagedAck ? "1" : args.parentChatId, brief };
    }
    else if (command === "create_task" || command === "create_task_brief") {
      if (command === "create_task_brief" && flags.legacyBriefHub) { response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "invalid", message: "Unknown command" } })); return; }
      if (!chats.some((c) => c.chatId === "3")) chats.push({ chatId: "3", kind: "task", title: args.title, machineId: args.machineId, cwd: args.cwd, ...(command === "create_task_brief" ? { brief: { ...(args.problem === undefined ? {} : { problem: args.problem }), ...(args.description === undefined ? {} : { description: args.description }) } } : {}) });
      if (flags.loseCreate || flags.loseCreateOnce) { flags.loseCreateOnce = false; response.destroy(); return; }
      flags.offlineReadsAfterCreate = false;
      result = { chatId: "3", ...(command === "create_task_brief" ? { brief: flags.badBriefAck ? {} : chats.find(c => c.chatId === "3")!.brief } : {}) };
    } else if (command === "rex_status") result = { version: 1, hubId: hub, chatId: flags.badRex ? "1" : args.chatId,
      taskId: flags.parentRex ? "8" : null, status: flags.parentRex ? "allocated" : "unallocated",
      binding: flags.parentRex ? { machineId: flags.badParentMachine ? "wrong-worker" : chat.machineId, cwd: flags.badParentCwd ? "/wrong" : chat.cwd,
        server: "unix:///tmp/rex.sock", hostId: hub, instanceId: hub, sessionId: `session:${hub}`, windowId: `window:${hub}`, blockId: `block:${hub}`,
        hubId: hub, chatId: args.chatId, taskId: "8", readiness: "not_checked" } : null, previousBinding: null, bestEffort: true };
    else if (command === "open_managed_child") {
      if (flags.loseOpen || flags.loseManagedOpenOnce) { flags.loseManagedOpenOnce = false; response.destroy(); return; }
      result = { parentChatId: flags.badOpenAck ? "1" : args.chatId, childId: args.childId,
        ack: { version: 1, chatId: args.childId, requestId: args.requestId, taskId: "9", status: "admitted", completion: "not_waited", bestEffort: true } };
    }
    else if (command === "rex_inspect") result = { version: 1, hubId: hub, chatId: args.chatId, requestId: hub, taskId: null, startedAtMs: 1, finishedAtMs: 2, status: "unbound", observation: null };
    else if (command === "rex_open") {
      if (flags.loseOpen) { response.destroy(); return; }
      result = { version: 1, chatId: args.chatId, requestId: args.requestId, taskId: "9", status: "admitted", completion: "not_waited", bestEffort: true };
    } else if (command === "rex_startup") result = { version: 1, taskId: "8", chatId: args.chatId, allocationId: args.allocationId, blockId: args.blockId, registered: true, observation: "matched", historical: true, live: "not_checked" };
    else if (command === "activity") result = { chatId: args.chatId, busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false };
    else if (command === "admit") result = { submissionId: "9" };
    else assert.fail(`Unexpected command ${command}`);
    // Binding projections do not contain their enclosing chat identity.
    if (command === "status" && result?.binding) { result.binding = { ...result.binding }; delete result.binding.chatId; }
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
    await assert.rejects(direct.handle({ version: 1, id: "3", action: "agentsmd" }), /Read-only/);
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
  const f = await fixture(); f.flags.phase1 = true; f.flags.loseCreateOnce = lose; f.flags.offlineReadsAfterCreate = lose;
  try {
    const form = { title: "Brief task", machineId: "b".repeat(32), cwd: "/remote path", problem: "  Exact problem 日本語\\n", description: "LONG_BRIEF_".repeat(90) + "END_BRIEF" };
    const child = spawn("python3", [resolve("scripts/tui-pty-test.py"), binary!, "hub", "--tui", "--port", String(f.port)], { env: f.local.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", errors = ""; child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c));
    const steps: any[] = [
      { wait: "history for 1" }, { keys: "\x1b" }, { keys: ":hosts" }, { wait: "client idle" }, { keys: "\r" }, { wait: "HOSTS" }, { wait: "offline" }, { keys: "off" }, { wait: "Search: off" }, { keys: "\r" }, { wait: "TASK BRIEF" },
      { keys: ":cancel\r" }, { wait: "Unsubmitted task form cleared" }, { keys: ":new" }, { wait: "client idle" }, { keys: "\r" }, { wait: "TASK BRIEF" }, { keys: "\x1b" }, { keys: "cc" },
      { keys: "\x1b[200~" + JSON.stringify(form) + "\x1b[201~" }, { wait: "END_BRIEF" }, { keys: "\x1b" }, { keys: ":send" }, { wait: "client idle" }, { keys: "\r" },
    ];
    if (lose) steps.push({ wait: "LOCKED" }, { wait: "END_BRIEF" }, { wait: "STALE" }, { keys: ":retry" }, { wait: "client idle" }, { capture: "retry" }, { keys: "\r" });
    steps.push({ wait: "Task 3 created" }, { keys: ":select 3" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Read-only task inspection" }, { keys: ":brief" }, { wait: "client idle" }, { keys: "\r" }, { wait: "immutable creation snapshot" }, { wait: "Exact problem" }, { keys: "\x1b" }, { keys: ":q\r" });
    child.stdin.end(JSON.stringify(steps)); const [code] = await once(child, "exit"); assert.equal(code, 0, errors + out);
    if (lose) {
      const screen = JSON.parse(out).screens.retry;
      assert.match(screen, /STALE · client idle/);
      assert.match(screen, /Hub connection lost or cancelled; request outcome unconfirmed/);
      assert.doesNotMatch(screen, /client waiting/);
    }
    const creates = f.requests.filter(r => r.command === "create_task_brief"); assert.equal(creates.length, lose ? 2 : 1);
    assert.equal(f.requests.filter(r => r.command === "create_task").length, 0);
    const { requestId, ...actual } = creates[0].args; assert.deepEqual(actual, form);
    if (lose) assert.deepEqual(creates[0].args, creates[1].args);
    assert.equal(f.requests.filter(r => r.command === "rex_open").length, 1); assert.equal(f.requests.filter(r => r.command === "admit").length, 0);
    assert.equal(f.chats.filter(c => c.chatId === "3").length, 1); assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

for (const tui of [false, true]) test(`${tui ? "real PTY: :" : "plain client: /"}task-at saves exact explicit target and opens Rex without input`, { skip: tui && !binary, timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const target = { machineId: "b".repeat(32), cwd: "/remote path 🧪", title: " exact remote title " };
    const command = `${tui ? ":" : "/"}task-at ${JSON.stringify(target)}`;
    const child = tui
      ? spawn("python3", [fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url)), resolve(binary!), "agent", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } })
      : spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(f.port)], { env: f.local.env });
    const closed = once(child, "close"); child.stdout.resume(); let errors = ""; child.stderr.on("data", b => { errors += b; });
    child.stdin.end(tui ? JSON.stringify([{ wait: "history for 1" }, { keys: "\x1b" }, { keys: command }, { wait: "exact remote title" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Task 3 created" }, { keys: ":q\r" }]) : `${command}\n/exit\n`);
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
    Object.assign(f.chats[1]!, { agentRune: "ᚦ", agentName: "frostwire", agentNameAlgorithm: "wintermute-v1", brief: { problem: "Fix /api/path handling\nwith Unicode 界" } });
    const steps: object[] = [{ wait: "history for 2" }, { wait: "Rex startup registered" }, { keys: "\x1b" }];
    for (const cmd of [":tasks", ":hosts", ":new", ":hub", ":main", ":select 1", ":task forbidden", ":task-at {}"]) steps.push({ keys: cmd }, { wait: "client idle" }, { keys: "\r" }, { wait: "Task client locked" });
    // Command mode pauses polls and exposes precise transport readiness. A
    // neutral footer during normal editing does not mean Ctrl-S can be queued.
    steps.push({ keys: "iallowed in Rex" }, { keys: "\x1b" }, { keys: ":send" }, { wait: ":send" }, { wait: "client idle" }, { keys: "\r" }, { wait: "Input admitted" }, { keys: ":q\r" });
    const child = spawn("python3", [fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url)), resolve(binary!), "agent", "--tui", "--port", String(f.port), "--task", "2", "--hub-id", hub, "--rex-allocation", hub], { env: { ...f.local.env, DECK_NODE: process.execPath, REX_BLOCK: `block:${hub}` } });
    const closed = once(child, "close"); let output = "", errors = ""; child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { errors += c; }); child.stdin.end(JSON.stringify(steps));
    assert.equal((await closed)[0], 0, errors);
    const terminal = Buffer.from(JSON.parse(output).output, "base64").toString();
    assert.ok(terminal.includes("\x1b]2;ᚦ - Fix /api/path handling with Unicode 界\x1b\\"));
    assert.ok(!terminal.includes("\x1b]2;ᚦ - task\x1b\\"));
    assert.ok(!terminal.includes("\x1b]2;ᚦ - Existing task\x1b\\"));
    assert.ok(!terminal.includes("\x1b]2;Δ"));
    assert.equal(f.requests.filter(r => r.command === "admit").length, 1);
    assert.equal(f.requests.find(r => r.command === "admit").args.text, "allowed in Rex");
    assert.ok(f.requests.every(r => r.args.chatId === "2"));
    assert.ok(!f.requests.some(r => ["list_chats", "create_task"].includes(r.command)));
  } finally { await f.close(); }
});


for (const brief of [undefined, { description: "Not the problem" }, { problem: " \t\n" }, { problem: "  Saved /task/problem\nsecond line 界  " }]) test(`real PTY: terminal title follows the selected problem or legacy title (${JSON.stringify(brief)})`, { skip: !binary, timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    if (brief) f.chats[1]!.brief = brief;
    // Legacy task with no rune: neutral dot, never hub or a directory label.
    const expected = brief?.problem?.trim() ? "· - Saved /task/problem second line 界" : "· - Existing task";
    const child = spawn("python3", [resolve("scripts/tui-pty-test.py"), binary!, "hub", "--tui", "--port", String(f.port)], { env: f.local.env });
    let out = "", errors = ""; child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c));
    const closed = once(child, "close");
    child.stdin.end(JSON.stringify([
      { wait: "history for 1" }, { keys: "\x1b" }, { keys: ":select 2" }, { wait: "client idle" }, { keys: "\r" },
      { wait: "history for 2" }, { sleep: 1.2 },
      { keys: ":hub" }, { wait: "client idle" }, { keys: "\r" }, { wait: "history for 1" }, { keys: ":q\r" },
    ]));
    assert.equal((await closed)[0], 0, errors + out);
    const result = JSON.parse(out); assert.equal(result.restored, true);
    const terminal = Buffer.from(result.output, "base64").toString();
    const titles = [...terminal.matchAll(/\x1b\]2;([^\x1b]*)\x1b\\/g)].map(m => m[1]);
    assert.deepEqual(titles, ["Δ - hub", expected, "Δ - hub"], "Polling must not repeat the title; navigation must restore the correct identity");
    assert.equal(terminal.split("\x1b[22;2t").length - 1, 1);
    assert.equal(terminal.split("\x1b[23;2t").length - 1, 1);
    assert.ok(terminal.indexOf("\x1b[23;2t") > terminal.lastIndexOf("\x1b]2;"), "Detach restores the terminal title after the final update");
    assert.ok(f.requests.every(r => ["status", "history", "activity"].includes(r.command)), "Title changes are presentation only");
  } finally { await f.close(); }
});

test("real PTY: task/new leaders retain hub authority and preserve unsent input", { skip: !binary, timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const child = spawn("python3", [fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url)), resolve(binary!), "hub", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } });
    const closed = once(child, "close"); child.stdout.resume(); let errors = ""; child.stderr.on("data", b => { errors += b; });
    child.stdin.end(JSON.stringify([
      { wait: "history for 1" }, { keys: "\x1b" }, { keys: " t" }, { wait: "TASKS" }, { keys: "\x1b" },
      { keys: " n" }, { wait: "TASK BRIEF" }, { keys: ":cancel\r" }, { wait: "Unsubmitted task form cleared" },
      { keys: "ikeep this" }, { keys: "\x1b" }, { keys: " n" }, { wait: "Unsent prompt preserved" }, { wait: "keep this" }, { keys: ":q!\r" },
    ]));
    assert.equal((await closed)[0], 0, errors);
    assert.ok(f.requests.some(r => r.command === "list_chats"));
    assert.ok(!f.requests.some(r => ["admit", "create_task", "create_task_brief", "rex_open", "stop"].includes(r.command)));
  } finally { await f.close(); }
});

test("real PTY: hub inspection is read-only, creation opens Rex, and :hub returns", { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const command = (text: string) => [{ keys: text }, { wait: text }, { wait: "client idle" }, { keys: "\r" }];
    const steps = [
      { wait: "history for 1" }, { keys: "keep this" }, { keys: "\x1b" }, ...command(":tasks"), { wait: "TASKS" },
      { keys: "\x1b[B\r" }, { wait: "Unsent prompt preserved" }, { keys: "\x1b" }, { wait: "keep this" }, { keys: "dd" },
      ...command(":task New task 🧪"), { wait: "Task 3 created" }, ...command(":tasks"), { wait: "New task" }, { keys: "New task" }, { wait: "Search: New task" }, { keys: "\r" },
      { wait: "history for 3" }, { wait: "READ ONLY" }, { keys: "imust not edit" }, { keys: "\x1b[200~pasted input\x1b[201~" }, { keys: "\x13" }, { wait: "Read-only task inspection" }, ...command(":rex"), { wait: "Allocation: unallocated" }, { keys: "i" }, { wait: "Presence: unbound" },
      { keys: "o" }, { wait: "Rex attempt admitted" }, { keys: "\x1b" }, ...command(":hub"), { wait: "history for 1" }, { keys: ":q\r" },
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

for (const badAck of [false, true]) test(`managed TUI creation retains parent/brief across ${badAck ? "wrong-parent ACK" : "lost ACK"}, recovery and explicit retry`, async () => {
  const f = await fixture(); f.flags.managed = true; f.flags.phase1 = true; f.flags.noRex = true;
  try {
    const form = { title: "Managed", managedParentChatId: "2", problem: " exact 日本語\n", description: "own description" };
    await f.act("poll"); f.flags.badManagedAck = badAck; f.flags.loseCreateOnce = !badAck;
    await assert.rejects(f.act("create", { taskForm: form }));
    const store = new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY), saved = await store.list();
    assert.equal(saved.length, 1);
    const draft = (await store.load(saved[0]!.requestId)).request;
    assert.deepEqual(draft, { kind: "task", chatId: "1", requestId: saved[0]!.requestId, ...form });
    f.flags.badManagedAck = false;
    const recovered = new TuiSession((name, args, pin) => hubCommand(f.port, name, args, pin), undefined, undefined, f.local.env.DECK_CLIENT_STATE_DIRECTORY, f.port);
    assert.equal((await recovered.handle({ version: 1, id: "1", action: "poll" })).draft!.kind, "task");
    assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 1);
    await assert.rejects(recovered.handle({ version: 1, id: "2", action: "select", chatId: "2" }), /Resolve saved requests/);
    const done = await recovered.handle({ version: 1, id: "3", action: "retry" });
    assert.match(done.notice, /Managed child 3 created; no input submitted/); assert.equal(done.draft, null);
    const calls = f.requests.filter(r => r.command === "create_managed_child"); assert.equal(calls.length, 2); assert.deepEqual(calls[0].args, calls[1].args);
    assert.deepEqual(calls[0].args, { requestId: draft.requestId, title: form.title, parentChatId: "2", problem: form.problem, description: form.description });
    assert.equal(calls[0].hubId, hub);
    assert.ok(!f.requests.some(r => ["create_task", "create_task_brief", "rex_open", "admit"].includes(r.command)));
    assert.deepEqual(await store.list(), []);
    const tasks = await f.act("tasks"); assert.equal(tasks.tasks!.items.at(-1)!.managedParentChatId, "2");
    const view = await recovered.handle({ version: 1, id: "4", action: "select", chatId: "3" });
    assert.equal(view.managedParentChatId, "2"); assert.deepEqual(view.brief, { problem: form.problem, description: form.description });
    await assert.rejects(recovered.handle({ version: 1, id: "5", action: "send", text: "forbidden inspection write" }), /Read-only/);
    const reply = { version: 1, id: "r", ok: true, snapshot: view };
    assert.ok(validReply(reply, "r"));
    for (const patch of [{ managedParentChatId: "3" }, { kind: "subagent" }, { managedParentChatId: "9007199254740992" }]) assert.equal(validReply({ ...reply, snapshot: { ...view, ...patch } }, "r"), false);
    assert.equal(validReply({ ...reply, snapshot: { ...view, tasks: { items: [{ ...tasks.tasks!.items.at(-1)!, parentChatId: "1" }] } } }, "r"), false);
  } finally { await f.close(); }
});

test("managed creation refuses an old hub and locked task clients before drafts/effects, without fallback", async () => {
  const f = await fixture(); f.flags.phase1 = true;
  try {
    const form = { title: "Managed", managedParentChatId: "1" };
    await assert.rejects(f.act("create", { taskForm: form }), /Hub lacks managed children/);
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
    f.flags.managed = true;
    const task = f.taskSession(); await task.registerStartup(hub, `block:${hub}`);
    await assert.rejects(task.handle({ version: 1, id: "1", action: "create", taskForm: form }), /locked/);
    assert.ok(!f.requests.some(r => r.command.startsWith("create_") || r.command === "admit"));
  } finally { await f.close(); }
});

test("real PTY: new-child preserves a legacy active form then creates a self-parented problem with an unrelated unsent prompt", { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture(); f.flags.managed = true; f.flags.phase1 = true; f.flags.noRex = true;
  try {
    const command = (text: string) => [{ keys: text }, { wait: "client idle" }, { keys: "\r" }];
    const child = spawn("python3", [resolve("scripts/tui-pty-test.py"), binary!, "hub", "--tui", "--port", String(f.port)], { env: f.local.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", errors = ""; child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c));
    child.stdin.end(JSON.stringify([
      { wait: "history for 1" }, { keys: "\x1b" }, ...command(":new"), { wait: "TASK BRIEF" }, { keys: "i" },
      { keys: '\x1b[200~{"title":"UNSUBMITTED_FORM"}\x1b[201~' }, { keys: "\x1b" },
      ...command(":new-child not allowed while form active"), { wait: "Resolve the current task form" }, { capture: "form" },
      ...command(":cancel"), { wait: "Unsubmitted task form cleared" }, { keys: "iUNSENT_PROMPT" }, { keys: "\x1b" },
      ...command(":new-child 2 KEEP_MY_PROBLEM"), { wait: "3 created" }, { capture: "preserved" },
      { keys: "cc" }, { keys: "\x1b" }, ...command(":tasks"), { wait: "managed child of 1" }, { keys: "\x1b" },
      ...command(":select 3"), { wait: "Read-only task inspection" },
      ...command(":new-child READONLY_REFUSED"), { wait: "Read-only task inspection" },
      ...command(":brief"), { wait: "KEEP_MY_PROBLEM" }, { keys: "\x1b" }, { keys: ":q\r" },
    ]));
    const [code] = await once(child, "exit"); assert.equal(code, 0, errors + out);
    const screens = JSON.parse(out).screens;
    assert.match(screens.form, /UNSUBMITTED_FORM/); assert.match(screens.preserved, /UNSENT_PROMPT/);
    assert.doesNotMatch(screens.preserved, /TASK BRIEF/);
    const creates = f.requests.filter(r => r.command === "create_managed_child"); assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].args, { requestId: creates[0].args.requestId, parentChatId: "1", problem: "2 KEEP_MY_PROBLEM", description: "" });
    assert.ok(!f.requests.some(r => ["admit", "rex_open", "create_task", "create_task_brief"].includes(r.command)));
  } finally { await f.close(); }
});

for (const managed of [false, true]) test(`registered ${managed ? "managed" : "ordinary"} task TUI creates its own child, clears the exact draft before scoped open and remains in the parent`, async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, managedOpen: true, parentRex: true, phase1: true });
  if (managed) f.chats[1]!.managedParentChatId = "1";
  try {
    const task = f.taskSession(); await task.registerStartup(hub, `block:${hub}`);
    const form = { title: "Own child", managedParentChatId: "2", problem: " exact 日本語\n", description: "preserve trailing spaces  " };
    const created = await task.handle({ version: 1, id: "create", action: "create", taskForm: form });
    assert.equal(created.chatId, "2"); assert.equal(created.clientMode, "task"); assert.equal(created.draft, null);
    assert.match(created.notice, /Child 3 created\. Child TUI opening/);
    const calls = f.requests.filter(r => ["rex_status", "create_managed_child", "open_managed_child"].includes(r.command));
    assert.deepEqual(calls.map(r => r.command), ["rex_status", "create_managed_child", "open_managed_child"]);
    const { managedParentChatId, ...brief } = form;
    assert.deepEqual(calls[1].args, { requestId: calls[1].args.requestId, parentChatId: managedParentChatId, ...brief });
    assert.deepEqual(calls[2].args, { chatId: "2", childId: "3", requestId: calls[2].args.requestId, port: f.port });
    assert.match(calls[2].args.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(calls[1].args.requestId, calls[2].args.requestId);
    assert.ok(calls.every(r => r.hubId === hub));
    for (let i = 0; i < 3; i++) assert.equal((await task.handle({ version: 1, id: `poll${i}`, action: "poll" })).chatId, "2");
    await assert.rejects(task.handle({ version: 1, id: "retry", action: "retry" }), /No pending draft/);
    assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 1);
    assert.equal(f.requests.filter(r => r.command === "open_managed_child").length, 1);
    assert.ok(!f.requests.some(r => ["rex_open", "create_task", "create_task_brief", "admit"].includes(r.command)));
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

for (const reason of ["capability", "unallocated", "machine", "cwd", "chat"] as const) test(`task child composer refuses ${reason} preflight before reserving a draft or creating anything`, async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, managedOpen: reason !== "capability", parentRex: reason !== "unallocated", phase1: true });
  f.flags.badParentMachine = reason === "machine"; f.flags.badParentCwd = reason === "cwd"; f.flags.badRex = reason === "chat";
  try {
    const task = f.taskSession(); await task.registerStartup(hub, `block:${hub}`);
    await assert.rejects(task.handle({ version: 1, id: "create", action: "create", taskForm: { title: "Must stay unsent", managedParentChatId: "2" } }));
    assert.equal((await task.handle({ version: 1, id: "poll", action: "poll" })).draft, null);
    assert.equal(f.requests.filter(r => r.command === "rex_status").length, reason === "capability" ? 0 : 1);
    assert.ok(!f.requests.some(r => r.command.startsWith("create_") || ["open_managed_child", "rex_open", "admit"].includes(r.command)));
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
    // A refused new form does not leave an in-memory reservation either.
    Object.assign(f.flags, { managedOpen: true, parentRex: true, badParentMachine: false, badParentCwd: false, badRex: false });
    await task.handle({ version: 1, id: "refresh", action: "poll" });
    await assert.rejects(task.handle({ version: 1, id: "retry", action: "retry" }), /No pending draft/);
    if (reason !== "capability") assert.equal((await task.handle({ version: 1, id: "create2", action: "create", taskForm: { title: "Now allowed", managedParentChatId: "2" } })).draft, null);
  } finally { await f.close(); }
});

for (const badAck of [false, true]) test(`task own-child ${badAck ? "malformed" : "lost"} creation ACK retains exact saved request across polls/restart; explicit retry opens only after acknowledgement`, async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, managedOpen: true, parentRex: true, phase1: true, badManagedAck: badAck, loseCreateOnce: !badAck });
  try {
    const task = f.taskSession(); await task.registerStartup(hub, `block:${hub}`);
    const form = { title: "Exact own child", managedParentChatId: "2", problem: "  exact\n日本語", description: "Own child brief" };
    await assert.rejects(task.handle({ version: 1, id: "create", action: "create", taskForm: form }));
    const store = new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY), saved = (await store.list())[0]!;
    const path = join(store.directory, `${saved.requestId}.json`), bytes = await readFile(path);
    assert.deepEqual((await store.load(saved.requestId)).request, { kind: "task", chatId: "2", requestId: saved.requestId, ...form });
    for (let i = 0; i < 3; i++) await task.handle({ version: 1, id: `poll${i}`, action: "poll" });
    await assert.rejects(task.handle({ version: 1, id: "replace", action: "create", taskForm: { ...form, title: "must not replace" } }), /Resolve saved/);
    await assert.rejects(task.handle({ version: 1, id: "open", action: "childOpen", chatId: "3" }), /Resolve pending/);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 1);
    assert.equal(f.requests.filter(r => r.command === "open_managed_child").length, 0);
    f.flags.badManagedAck = false; f.flags.parentRex = false; // Never re-preflight a saved creation identity.
    const recovered = f.taskSession(); await recovered.registerStartup(hub, `block:${hub}`);
    assert.equal((await recovered.handle({ version: 1, id: "poll", action: "poll" })).draft!.requestId, saved.requestId);
    const done = await recovered.handle({ version: 1, id: "retry", action: "retry" });
    assert.equal(done.chatId, "2"); assert.equal(done.draft, null); assert.match(done.notice, /Child 3 created/);
    const creates = f.requests.filter(r => r.command === "create_managed_child"); assert.equal(creates.length, 2); assert.deepEqual(creates[0].args, creates[1].args);
    assert.equal(f.requests.filter(r => r.command === "rex_status").length, 1);
    assert.equal(f.requests.filter(r => r.command === "open_managed_child").length, 1);
    assert.equal(f.chats.filter(c => c.chatId === "3").length, 1);
    assert.deepEqual(await store.list(), []);
  } finally { await f.close(); }
});

for (const badAck of [false, true]) test(`task child ${badAck ? "malformed open ACK" : "lost open ACK"} never recreates or reopens implicitly; childOpen retains parent snapshot`, async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, managedOpen: true, parentRex: true, phase1: true, loseOpen: !badAck, badOpenAck: badAck });
  try {
    const task = f.taskSession(); await task.registerStartup(hub, `block:${hub}`);
    const created = await task.handle({ version: 1, id: "create", action: "create", taskForm: { title: "Created exactly once", managedParentChatId: "2" } });
    assert.match(created.notice, /Child 3 created; same-session Rex open unconfirmed/); assert.match(created.notice, /:child-open 3/); assert.equal(created.draft, null);
    const store = new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY); assert.deepEqual(await store.list(), []);
    for (let i = 0; i < 3; i++) await task.handle({ version: 1, id: `poll${i}`, action: "poll" });
    await assert.rejects(task.handle({ version: 1, id: "retry", action: "retry" }), /No pending draft/);
    assert.equal(f.requests.filter(r => r.command === "open_managed_child").length, 1);
    f.flags.loseOpen = false; f.flags.badOpenAck = false;
    const opened = await task.handle({ version: 1, id: "open", action: "childOpen", chatId: "3" });
    assert.match(opened.notice, /Child 3 TUI opening/); assert.equal(opened.chatId, "2"); assert.equal(opened.clientMode, "task");
    const opens = f.requests.filter(r => r.command === "open_managed_child"); assert.equal(opens.length, 2);
    assert.notEqual(opens[0].args.requestId, opens[1].args.requestId);
    assert.deepEqual(opens[1].args, { ...opens[0].args, requestId: opens[1].args.requestId });
    assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 1);
    assert.equal(f.requests.filter(r => r.command === "rex_open").length, 0);
    const reply = { version: 1, id: "open", ok: true, snapshot: opened };
    assert.ok(validRequest({ version: 1, id: "open", action: "childOpen", chatId: "3" }));
    assert.ok(validReply(reply, "open", hub, "2", "childOpen", "3", undefined, "task", "1"));
    for (const patch of [{ chatId: "3", managedParentChatId: "2" }, { hubId: "11111111-1111-4111-8111-111111111111" }, { clientMode: "hub" }, { hubChatId: "3" }, { kind: "subagent", parentChatId: "1", inspectParentChatId: "1" }]) {
      assert.equal(validReply({ ...reply, snapshot: { ...opened, ...patch } }, "open", hub, "2", "childOpen", "3", undefined, "task", "1"), false);
    }
    for (const target of [undefined, "1", "2", "9007199254740992"]) assert.equal(validReply(reply, "open", hub, "2", "childOpen", target), false);
    for (const patch of [{ chatId: undefined }, { chatId: "0" }, { chatId: "9007199254740992" }, { text: "no" }, { taskForm: { title: "No", managedParentChatId: "2" } }, { after: "1" }]) assert.equal(validRequest({ version: 1, id: "open", action: "childOpen", chatId: "3", ...patch }), false);
  } finally { await f.close(); }
});

test("own-parent creation and childOpen do not grant read-only inspectors or forged forms participation", async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, managedOpen: true, parentRex: true, phase1: true });
  try {
    const task = f.taskSession(); await task.registerStartup(hub, `block:${hub}`);
    const readonly = f.taskSession(); await readonly.handle({ version: 1, id: "poll", action: "poll" });
    const before = f.requests.length;
    for (const parent of ["1", "3"]) await assert.rejects(task.handle({ version: 1, id: "forge", action: "create", taskForm: { title: "forged", managedParentChatId: parent } }), /locked/);
    for (const request of [{ action: "create", taskForm: { title: "read only", managedParentChatId: "2" } }, { action: "childOpen", chatId: "3" }] as const) await assert.rejects(readonly.handle({ version: 1, id: "readonly", ...request }), /Read-only|Return to the hub/);
    assert.equal(f.requests.length, before);
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

for (const loseOpen of [false, true]) test(`real PTY: required new-child problem self-parents and ${loseOpen ? "recovers lost open explicitly" : "opens scoped child"} while preserving unsent prompt`, { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, managedOpen: true, parentRex: true, phase1: true, loseManagedOpenOnce: loseOpen });
  try {
    const command = (text: string) => [{ keys: text }, { wait: "client idle" }, { keys: "\r" }];
    const steps: object[] = [
      { wait: "history for 2" }, { wait: "Rex startup registered" }, { keys: "UNSENT_EXACT_PROMPT" }, { keys: "\x1b" },
      ...command(":new-child"), { wait: "Usage: :new-child PROBLEM" },
      ...command(":new-child   "), { wait: "Usage: :new-child PROBLEM" }, { capture: "usage" },
      ...command(":new-child 1 KEEP_PROBLEM"), { wait: "Child 3 created" }, { capture: "preserved" },
    ];
    if (loseOpen) steps.push({ wait: "same-session Rex open unconfirmed" }, ...command(":retry"), { wait: "No pending draft to retry" }, ...command(":child-open 3"), { wait: "Child 3 TUI opening" });
    else steps.push({ wait: "Child TUI opening" });
    steps.push({ wait: "history for 2" }, { capture: "opened" }, { keys: ":q!\r" });
    const child = spawn("python3", [resolve("scripts/tui-pty-test.py"), binary!, "agent", "--tui", "--port", String(f.port), "--task", "2", "--hub-id", hub, "--rex-allocation", hub], { env: { ...f.local.env, DECK_NODE: process.execPath, REX_BLOCK: `block:${hub}` } });
    const closed = once(child, "close"); let out = "", errors = "";
    child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c)); child.stdin.end(JSON.stringify(steps));
    assert.equal((await closed)[0], 0, errors + out);
    const screens = JSON.parse(out).screens;
    for (const screen of [screens.usage, screens.preserved, screens.opened]) { assert.match(screen, /UNSENT_EXACT_PROMPT/); assert.doesNotMatch(screen, /TASK BRIEF/); }
    const creates = f.requests.filter(r => r.command === "create_managed_child"); assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].args, { requestId: creates[0].args.requestId, parentChatId: "2", problem: "1 KEEP_PROBLEM", description: "" });
    const opens = f.requests.filter(r => r.command === "open_managed_child"); assert.equal(opens.length, loseOpen ? 2 : 1);
    assert.ok(opens.every(r => r.args.chatId === "2" && r.args.childId === "3" && r.args.port === f.port));
    if (loseOpen) assert.notEqual(opens[0].args.requestId, opens[1].args.requestId);
    assert.ok(f.requests.filter(r => ["status", "history"].includes(r.command)).every(r => r.args.chatId === "2"));
    assert.equal(f.requests.filter(r => r.command === "rex_status").length, 1);
    assert.ok(!f.requests.some(r => ["rex_open", "admit", "create_task", "create_task_brief", "list_chats"].includes(r.command)));
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

test("plain task client creates only its own child and opens the same-session route", async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, managedOpen: true, parentRex: true, phase1: true });
  try {
    const form = { title: "Plain child", managedParentChatId: "2", problem: "own child problem" };
    const child = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(f.port), "--task", "2", "--hub-id", hub, "--rex-allocation", hub], { env: { ...f.local.env, REX_BLOCK: `block:${hub}` } });
    const closed = once(child, "close"); child.stdout.resume(); let errors = ""; child.stderr.on("data", c => errors += String(c));
    child.stdin.end(`/new ${JSON.stringify({ ...form, managedParentChatId: "1" })}\n/new ${JSON.stringify(form)}\n/child-open 3\n/exit\n`);
    assert.equal((await closed)[0], 0, errors); assert.match(errors, /locked/);
    const creates = f.requests.filter(r => r.command === "create_managed_child"), opens = f.requests.filter(r => r.command === "open_managed_child");
    assert.equal(creates.length, 1); assert.equal(creates[0].args.parentChatId, "2"); assert.equal(opens.length, 2);
    assert.ok(opens.every(r => r.args.chatId === "2" && r.args.childId === "3"));
    assert.ok(!f.requests.some(r => ["rex_open", "admit", "create_task"].includes(r.command)));
  } finally { await f.close(); }
});

test("real PTY: failed new-child parent Rex preflight preserves editable unsent prompt without mutation uncertainty", { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, managedOpen: true, phase1: true });
  try {
    const child = spawn("python3", [resolve("scripts/tui-pty-test.py"), binary!, "agent", "--tui", "--port", String(f.port), "--task", "2", "--hub-id", hub, "--rex-allocation", hub], { env: { ...f.local.env, DECK_NODE: process.execPath, REX_BLOCK: `block:${hub}` } });
    const closed = once(child, "close"); let out = "", errors = ""; child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c));
    child.stdin.end(JSON.stringify([
      { wait: "history for 2" }, { keys: "PRESERVED_PROMPT" }, { keys: "\x1b" }, { keys: ":new-child The child problem" }, { wait: "client idle" }, { keys: "\r" },
      { wait: "Parent has no confirmed Rex allocation" }, { capture: "preserved" }, { keys: "A_EDITABLE" }, { wait: "_EDITABLE" },
      { keys: "\x1b" }, { keys: ":q!\r" },
    ]));
    assert.equal((await closed)[0], 0, errors + out); assert.match(JSON.parse(out).screens.preserved, /PRESERVED_PROMPT/);
    assert.doesNotMatch(JSON.parse(out).screens.preserved, /LOCKED|TASK BRIEF/);
    assert.ok(!f.requests.some(r => r.command.startsWith("create_") || ["open_managed_child", "rex_open", "admit"].includes(r.command)));
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

for (const recovery of ["retry", "discard", "reconnect-retry", "reconnect-discard"] as const) test(`real PTY: new-child lost creation ACK ${recovery} preserves unrelated prompt and exact saved identity`, { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, noRex: true, phase1: true, loseCreateOnce: true });
  const command = (text: string) => [{ keys: text }, { wait: "client idle" }, { keys: "\r" }];
  const run = async (steps: object[]) => {
    const child = spawn("python3", [resolve("scripts/tui-pty-test.py"), binary!, "hub", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } });
    const closed = once(child, "close"); let out = "", errors = "";
    child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c)); child.stdin!.end(JSON.stringify(steps));
    assert.equal((await closed)[0], 0, errors + out);
    return JSON.parse(out).screens;
  };
  try {
    const reconnect = recovery.startsWith("reconnect"); const discard = recovery.endsWith("discard");
    const problem = "  Exact child problem 界 with trailing space  ";
    const steps: object[] = [
      { wait: "history for 1" }, { keys: "UNSENT_BEFORE_CREATE" }, { keys: "\x1b" },
      ...command(":new-child " + problem), { wait: "request outcome unconfirmed" }, { wait: "LOCKED" }, { capture: "lost" },
    ];
    if (!reconnect) steps.push(...command(discard ? ":discard" : ":retry"), { wait: discard ? "Draft discarded locally" : "3 created" }, { capture: "resolved" });
    steps.push({ keys: ":q!\r" });
    const screens = await run(steps);
    assert.match(screens.lost, /UNSENT_BEFORE_CREATE/); assert.doesNotMatch(screens.lost, /TASK BRIEF/);
    if (reconnect) {
      assert.equal((await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list()).length, 1);
      const next = await run([
        { wait: "Saved task" }, { wait: "LOCKED" }, { capture: "reconnected" }, { keys: "\x1b" },
        ...command(discard ? ":discard" : ":retry"), { wait: discard ? "Draft discarded locally" : "3 created" },
        { keys: "iRECONNECTED_EDITABLE" }, { wait: "RECONNECTED_EDITABLE" }, { capture: "resolved" }, { keys: "\x1b" }, { keys: ":q!\r" },
      ]);
      assert.doesNotMatch(next.reconnected.split("\n").slice(34, 37).join("\n"), /Exact child problem|UNSENT_BEFORE_CREATE/);
      assert.doesNotMatch(next.resolved, /LOCKED|TASK BRIEF/);
    } else {
      assert.match(screens.resolved, /UNSENT_BEFORE_CREATE/);
      assert.doesNotMatch(screens.resolved, /LOCKED|TASK BRIEF/);
    }
    const creates = f.requests.filter(r => r.command === "create_managed_child");
    assert.equal(creates.length, discard ? 1 : 2);
    assert.deepEqual(creates[0].args, { requestId: creates[0].args.requestId, parentChatId: "1", problem, description: "" });
    if (!discard) assert.deepEqual(creates[1].args, creates[0].args);
    assert.ok(!f.requests.some(r => ["admit", "rex_open", "open_managed_child", "create_task", "create_task_brief"].includes(r.command)));
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});

test("real PTY: new-child accepts 2048 UTF-8 bytes and refuses truncated overflow until corrected", { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, noRex: true, phase1: true });
  try {
    const problem = "é".repeat(1024);
    const child = spawn("python3", [resolve("scripts/tui-pty-test.py"), binary!, "hub", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } });
    const closed = once(child, "close"); let out = "", errors = "";
    child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c));
    child.stdin!.end(JSON.stringify([
      { wait: "history for 1" }, { keys: "UNCHANGED_PROMPT" }, { keys: "\x1b" }, { keys: ":new-child " },
      ...Array.from({ length: 32 }, () => ({ keys: "é".repeat(32) })), { keys: "x" },
      { wait: "Command limit exceeded" }, { keys: "\r" }, { wait: "Nothing submitted" }, { capture: "overflow" },
      { keys: "\x7fé" }, { wait: "client idle" }, { keys: "\r" }, { wait: "3 created" }, { capture: "created" }, { keys: ":q!\r" },
    ]));
    assert.equal((await closed)[0], 0, errors + out);
    for (const screen of Object.values(JSON.parse(out).screens) as string[]) assert.match(screen, /UNCHANGED_PROMPT/);
    const creates = f.requests.filter(r => r.command === "create_managed_child"); assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].args, { requestId: creates[0].args.requestId, parentChatId: "1", problem, description: "" });
    assert.equal(Buffer.byteLength(creates[0].args.problem, "utf8"), 2048);
    assert.ok(!f.requests.some(r => ["admit", "rex_open", "create_task", "create_task_brief"].includes(r.command)));
  } finally { await f.close(); }
});

for (const whitespace of ["\u3000", "\u00a0", "\ufeff"]) test(`real PTY: new-child Unicode-only whitespace ${whitespace.codePointAt(0)!.toString(16)} is usage, not a fenced bridge`, { skip: !binary, timeout: 15_000 }, async () => {
  const f = await fixture(); Object.assign(f.flags, { managed: true, phase1: true, noRex: true });
  try {
    const child = spawn("python3", [resolve("scripts/tui-pty-test.py"), binary!, "hub", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } });
    const closed = once(child, "close"); let out = "", errors = "";
    child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => errors += String(c));
    child.stdin.end(JSON.stringify([
      { wait: "history for 1" }, { keys: "PRESERVED_PROMPT" }, { keys: "\x1b" }, { keys: ":new-child " + whitespace },
      { wait: "client idle" }, { keys: "\r" }, { wait: "Usage: :new-child PROBLEM" },
      { keys: "A_EDITABLE" }, { wait: "PRESERVED_PROMPT_EDITABLE" }, { capture: "editable" }, { keys: "\x1b" }, { keys: ":q!\r" },
    ]));
    assert.equal((await closed)[0], 0, errors + out);
    assert.doesNotMatch(JSON.parse(out).screens.editable, /LOCKED|fenced|TASK BRIEF/);
    assert.ok(!f.requests.some(r => r.command.startsWith("create_") || ["admit", "rex_open", "open_managed_child"].includes(r.command)));
    assert.deepEqual(await new DraftStore(hub, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await f.close(); }
});
