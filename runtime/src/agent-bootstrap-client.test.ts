import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { bootstrapPath, StartupFiles } from "./agent-storage.js";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";
import type { RexBootstrapRecord, TuiRequest, TuiResponse } from "./generated/contracts.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";

type Options = { legacy?: boolean; attempted?: boolean; startup?: "refused" | "lost_ack" | "wrong_allocation"; form?: "missing" | "invalid" };
async function fixture(t: TestContext, options: Options = {}) {
  const local = await clientEnv(), root = local.env.DECK_CLIENT_STATE_DIRECTORY;
  const calls: any[] = [], entries: any[] = [];
  const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const children: { child: ReturnType<typeof spawn>; closed: Promise<unknown> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()); calls.push(value);
    const { command, args, id } = value;
    const reply = (result: object) => response.end(JSON.stringify({ version: 1, id, ok: true, result }));
    if (command === "status") reply({ hubId: record.hubId, hubGuard: 1, rexStartup: 1, mainChatId: "1", chatId: "2", tools: "offline", binding: { kind: "task", title: form.title, machineId: record.machineId, cwd: record.cwd, brief: { problem: form.problem, description: form.description } } });
    else if (command === "history") reply({ items: entries });
    else if (command === "rex_startup") {
      received.resolve(); await release.promise;
      if (options.startup === "lost_ack") { response.destroy(); return; }
      if (options.startup === "refused") { response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "invalid", message: "Startup refused" } })); return; }
      reply({ version: 1, taskId: "8", chatId: "2", allocationId: options.startup === "wrong_allocation" ? randomUUID() : record.claim!.allocationId, blockId: record.binding!.blockId, registered: true, observation: "matched", historical: true, live: "not_checked" });
    } else if (command === "admit") {
      entries.unshift({ id: entries.length + 10, kind: "deck.input", data: { text: args.text } });
      reply({ submissionId: "9" });
    } else response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "invalid", message: `Unexpected command ${command}` } }));
  });
  t.after(async () => {
    release.resolve();
    for (const { child, closed } of children) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await local.close();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const record: RexBootstrapRecord = {
    version: 1, id: randomUUID(), hubId: randomUUID(), machineId: "a".repeat(32), cwd: "/exact/agent-workspace", client: "/tools/deck", draftRoot: root, port: address.port,
    target: { executable: "/tools/rex", server: "unix:///tmp/unused-agent-test.sock", hostId: randomUUID(), instanceId: randomUUID() },
    // bootstrapRecord verifies the helper's parent, not the spawned helper PID.
    binding: { sessionId: `session:${randomUUID()}`, windowId: `window:${randomUUID()}`, blockId: `block:${randomUUID()}`, pid: process.pid },
    claim: { chatId: "2", allocationId: randomUUID() },
  };
  await mkdir(bootstrapPath(root, record.id), { recursive: true, mode: 0o700 });
  const files = new StartupFiles(bootstrapPath(root, record.id)), indexes = new StartupFiles(join(root, "startups"));
  const index = { version: 1, id: record.id, hubId: record.hubId, machineId: record.machineId };
  await indexes.publish(`${record.id}.json`, index); await files.publish("record.json", record);
  const inputId = randomUUID();
  const form = { version: 1, bootstrapId: record.id, hubId: record.hubId, machineId: record.machineId, cwd: record.cwd, creationId: randomUUID(), adoptionId: randomUUID(), title: "Brief is not input", problem: "  Exact problem 🌍\nnot an automatic prompt  ", description: "Creation metadata only", ...(options.legacy ? { inputId } : {}) };
  if (options.form !== "missing") await files.publish("form.json", { ...form, ...(options.form === "invalid" ? { bootstrapId: randomUUID() } : {}) });
  if (options.attempted) await files.publish("input-attempt.json", { attempted: true });
  const store = new DraftStore(record.hubId, root);
  const legacy = { kind: "input" as const, chatId: "2", requestId: inputId, text: form.problem, mode: "steer" as const };
  if (options.legacy) await store.save(legacy);
  const draftBytes = () => readFile(join(store.directory, `${inputId}.json`));
  const start = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./tui-bridge.js", import.meta.url)), "--port", String(record.port), "--hub-id", record.hubId, "--task", "2", "--rex-allocation", record.claim!.allocationId, "--agent-bootstrap", record.id, "--client-state", root], { env: { ...local.env, REX_BLOCK: record.binding!.blockId } });
    const closed = once(child, "close"); children.push({ child, closed });
    let errors = ""; child.stderr.on("data", chunk => { errors += String(chunk); });
    const decoder = child.stdout.pipe(new FrameDecoder()), replies = decoder[Symbol.asyncIterator]();
    let id = 0;
    const send = (action: TuiRequest["action"], args: Partial<TuiRequest> = {}) => child.stdin.write(encodeFrame({ version: 1, id: String(++id), action, ...args }));
    return {
      send, closed,
      registered: () => Promise.race([received.promise, closed.then(() => { throw new Error(`Bridge exited before rex_startup: ${errors}`); })]),
      next: async () => { const result = await replies.next(); assert.equal(result.done, false, `Bridge closed without a renderer reply: ${errors}`); const reply = result.value as TuiResponse; assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.snapshot!; },
      noReply: async () => { await closed; assert.equal((await replies.next()).done, true, errors); },
      stop: async () => { child.stdin.end(); assert.equal((await closed)[0], 0, errors); },
    };
  };
  const pending = async () => {
    assert.equal(await files.read("completed.json"), undefined);
    assert.deepEqual(await indexes.read(`${record.id}.json`), index);
    assert.deepEqual(calls.map(c => c.command), ["status", "history", "rex_startup"]);
    assert.deepEqual(calls.at(-1).args, { chatId: "2", allocationId: record.claim!.allocationId, blockId: record.binding!.blockId });
    assert.ok(calls.every(c => c.hubId === record.hubId && c.args.chatId === "2"));
  };
  const completed = async () => {
    assert.deepEqual(await files.read("completed.json"), { version: 1 });
    assert.equal(await indexes.read(`${record.id}.json`), undefined);
  };
  const noAdmission = () => assert.deepEqual(calls.filter(c => !["status", "history", "rex_startup"].includes(c.command)), []);
  return { start, release: () => release.resolve(), pending, completed, noAdmission, calls, files, form, store, legacy, draftBytes, record };
}

test("bootstrap bridge opens a new form as an empty chat; only explicit send admits input", { timeout: 10_000 }, async t => {
  const f = await fixture(t), client = f.start();
  assert.equal(Object.hasOwn(f.form, "inputId"), false);
  const formBytes = await readFile(join(f.files.directory, "form.json"));
  client.send("poll"); await client.registered();
  await f.pending(); assert.deepEqual(await f.store.list(), []);
  f.release();
  for (let i = 0; i < 3; i++) {
    if (i) client.send("poll");
    const snapshot = await client.next();
    assert.equal(snapshot.clientMode, "task"); assert.equal(snapshot.chatId, "2"); assert.equal(snapshot.hubChatId, "1");
    assert.deepEqual(snapshot.entries, []); assert.equal(snapshot.draft, null); assert.equal(snapshot.preview, "");
    assert.deepEqual(snapshot.brief, { problem: f.form.problem, description: f.form.description });
    await f.completed(); f.noAdmission(); assert.deepEqual(await f.store.list(), []);
  }
  assert.equal(await f.files.read("input-attempt.json"), undefined);
  const text = "An explicit user message, not the problem";
  client.send("send", { text }); assert.equal((await client.next()).draft, null);
  const admissions = f.calls.filter(c => c.command === "admit"); assert.equal(admissions.length, 1);
  assert.deepEqual(admissions[0].args, { chatId: "2", requestId: admissions[0].args.requestId, text, mode: "steer" });
  assert.equal(admissions[0].hubId, f.record.hubId);
  client.send("poll"); assert.deepEqual((await client.next()).entries, [{ id: 10, role: "user", text }]);
  assert.equal(f.calls.filter(c => c.command === "admit").length, 1);
  assert.deepEqual(await f.store.list(), []);
  assert.deepEqual(await readFile(join(f.files.directory, "form.json")), formBytes);
  await client.stop();
});

for (const attempted of [false, true]) test(`bootstrap bridge retains a legacy input draft${attempted ? " after an earlier attempt" : ""} without automatic admission or retry`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, { legacy: true, attempted }), bytes = await f.draftBytes();
  // A fresh bridge after completion must also leave the legacy request alone.
  for (let launch = 0; launch < 2; launch++) {
    const client = f.start(); client.send("poll");
    if (!launch) { await client.registered(); await f.pending(); assert.deepEqual(await f.draftBytes(), bytes); f.release(); }
    for (let poll = 0; poll < 2; poll++) {
      if (poll) client.send("poll");
      const snapshot = await client.next(); assert.deepEqual(snapshot.entries, []);
      assert.deepEqual(snapshot.draft, { kind: "input", requestId: f.legacy.requestId, text: f.legacy.text, saved: true, clipped: false });
      await f.completed(); f.noAdmission(); assert.deepEqual(await f.draftBytes(), bytes);
      assert.deepEqual((await f.store.load(f.legacy.requestId)).request, f.legacy);
    }
    await client.stop();
  }
  assert.equal(f.calls.filter(c => c.command === "rex_startup").length, 2);
  assert.deepEqual(await f.files.read("input-attempt.json"), attempted ? { attempted: true } : undefined);
});

for (const startup of ["refused", "lost_ack", "wrong_allocation"] as const) test(`bootstrap bridge ${startup} startup neither completes nor admits even queued input`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, { legacy: true, startup }), bytes = await f.draftBytes(), client = f.start();
  client.send("poll"); client.send("send", { text: "Must not pass failed startup" });
  await client.registered(); await f.pending(); f.release();
  await client.noReply();
  await f.pending(); f.noAdmission(); assert.deepEqual(await f.draftBytes(), bytes);
  assert.equal(await f.files.read("input-attempt.json"), undefined);
});

for (const form of ["missing", "invalid"] as const) test(`bootstrap bridge requires a valid startup form after registration (${form})`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, { form }), client = f.start();
  client.send("poll"); client.send("send", { text: "Must not pass invalid bootstrap" });
  await client.registered(); await f.pending(); f.release();
  await client.noReply();
  await f.pending(); f.noAdmission(); assert.deepEqual(await f.store.list(), []);
  assert.equal(await f.files.read("input-attempt.json"), undefined);
});
