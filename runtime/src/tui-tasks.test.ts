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
import type { TuiRequest } from "./generated/contracts.js";

const hub = "12345678-1234-4234-8234-123456789abc";
async function fixture() {
  const local = await clientEnv(); const requests: any[] = [];
  const flags = { loseCreate: false, loseOpen: false, badSelect: false, badList: false, sparse: false, badRex: false };
  const chats = [
    { chatId: "1", kind: "main", title: "Main", machineId: "saved-worker", cwd: "/saved/main" },
    { chatId: "2", kind: "task", title: "Existing task", machineId: "other-worker", cwd: "/saved/task" },
  ];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()); requests.push(value);
    const { command, args, id } = value; const chat = chats.find((c) => c.chatId === (args.chatId ?? "1"))!;
    let result: any;
    if (command === "status") result = { hubId: hub, hubGuard: 1, rexOpen: 1, mainChatId: "1", chatId: flags.badSelect ? "1" : chat.chatId, binding: chat, tools: "offline" };
    else if (command === "history") result = { items: [{ id: Number(chat.chatId) * 100, kind: "deck.input", data: { text: `history for ${chat.chatId}` } }], next: String(Number(chat.chatId) * 100) };
    else if (command === "list_chats") result = flags.badList ? { items: [chats[1], chats[0]] } : flags.sparse && !args.after ? { items: [], next: "1" } : { items: chats.filter((c) => Number(c.chatId) > Number(args.after ?? 0)) };
    else if (command === "create_task") {
      if (!chats.some((c) => c.chatId === "3")) chats.push({ chatId: "3", kind: "task", title: args.title, machineId: args.machineId, cwd: args.cwd });
      if (flags.loseCreate) { response.destroy(); return; }
      result = { chatId: "3" };
    } else if (command === "rex_status") result = { version: 1, hubId: hub, chatId: flags.badRex ? "1" : args.chatId, taskId: null, status: "unallocated", binding: null, previousBinding: null, bestEffort: true };
    else if (command === "rex_inspect") result = { version: 1, hubId: hub, chatId: args.chatId, requestId: hub, taskId: null, startedAtMs: 1, finishedAtMs: 2, status: "unbound", observation: null };
    else if (command === "rex_open") {
      if (flags.loseOpen) { response.destroy(); return; }
      result = { version: 1, chatId: args.chatId, requestId: args.requestId, taskId: "9", status: "admitted", completion: "not_waited", bestEffort: true };
    } else if (command === "admit") result = { submissionId: "9" };
    else assert.fail(`Unexpected command ${command}`);
    // Binding projections do not contain their enclosing chat identity.
    if (result?.binding) { result.binding = { ...result.binding }; delete result.binding.chatId; }
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const session = new TuiSession((name, args, pin) => hubCommand(address.port, name, args, pin), undefined, undefined, local.env.DECK_CLIENT_STATE_DIRECTORY, address.port);
  let id = 0;
  const act = (action: TuiRequest["action"], args: Partial<TuiRequest> = {}) => session.handle({ version: 1, id: String(++id), action, ...args });
  return { local, requests, flags, chats, port: address.port, act, close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await local.close(); } };
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
    assert.equal(selected.chatId, "2"); assert.equal(selected.mainChatId, "1"); assert.equal(selected.draft!.text, "original target input");
    assert.deepEqual(selected.entries, []); assert.equal(selected.preview, ""); assert.equal(selected.tasks, undefined); assert.equal(selected.rex, undefined);
    await assert.rejects(f.act("select", { chatId: "1" }), /Resolve saved/);
    assert.notDeepEqual((await f.act("poll")).entries, initial.entries);
    assert.ok(!f.requests.some((r) => ["admit", "stop", "create_task", "rex_open"].includes(r.command)));
    await f.act("retry"); assert.equal(f.requests.at(-1).args.chatId, "2");
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

const binary = process.env.DECK_TEST_BINARY;
test("real PTY: task picker, protected prompt, create/select, Rex read/open and main return", { skip: !binary, timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const command = (text: string) => [{ keys: text }, { wait: text }, { wait: "client idle" }, { keys: "\r" }];
    const steps = [
      { wait: "history for 1" }, { keys: "ikeep this" }, { keys: "\x1b" }, ...command("/tasks"), { wait: "TASKS" },
      { keys: "j\r" }, { wait: "Unsent prompt preserved" }, { keys: "\x1b" }, { wait: "keep this" }, { keys: "dd" }, { wait: "0/16384 bytes" },
      ...command("/task New task 🧪"), { wait: "Task 3 created" }, ...command("/tasks"), { wait: "New task" }, { keys: "jj\r" },
      { wait: "history for 3" }, ...command("/rex"), { wait: "Allocation: unallocated" }, { keys: "i" }, { wait: "Presence: unbound" },
      { keys: "o" }, { wait: "Rex attempt admitted" }, { keys: "\x1b" }, ...command("/main"), { wait: "history for 1" }, { keys: ":q\r" },
    ];
    const driver = fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url));
    const child = spawn("python3", [driver, resolve(binary!), "agent", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } });
    const closed = once(child, "close"); let output = "", errors = "";
    child.stdout.on("data", (c) => { output += c; }); child.stderr.on("data", (c) => { errors += c; }); child.stdin.end(JSON.stringify(steps));
    assert.equal((await closed)[0], 0, errors); assert.equal(JSON.parse(output).restored, true);
    assert.equal(f.requests.filter((r) => r.command === "create_task").length, 1);
    assert.equal(f.requests.find((r) => r.command === "create_task").args.title, "New task 🧪");
    assert.equal(f.requests.filter((r) => r.command === "rex_open").length, 1);
    assert.equal(f.requests.find((r) => r.command === "rex_open").args.chatId, "3");
    assert.ok(!f.requests.some((r) => ["admit", "stop"].includes(r.command)));
  } finally { await f.close(); }
});
