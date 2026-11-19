import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, chmod, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as httpServer } from "node:http";
import { createServer as unixServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { DeckRuntime } from "./deck.js";
import { model, provider, IMPLEMENTATION } from "./instructions.test.support.js";
import { dispatch } from "./ipc.js";
import { responseFrame } from "./responses.js";
import { launcherResponse } from "./launcher-hub.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { AgentWizard, startupDraft, wizardTransport, validWizardReply } from "./agent-wizard.js";
import { StartupFiles, bootstrapPath, hereRecord, startupRecord, bootstrapRecord } from "./agent-storage.js";
import { DraftStore } from "./drafts.js";
import type { AgentHereRecord, TaskRelayFrame, ResponseEnvelope } from "./generated/contracts.js";
async function fixture(remote: boolean) {
  const root = await mkdtemp(join(tmpdir(), "deck-here-")), { models } = provider();
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, implementation: IMPLEMENTATION, binding: { machineId: "a".repeat(32), cwd: root }, rexClient: "/tools/deck", environment: () => undefined });
  const calls: any[] = [], peers = new Set<Socket>(); let lost = false;
  const http = httpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString()); calls.push(request);
    let reply: ResponseEnvelope;
    try { reply = { version: 1, id: request.id, ok: true, result: await dispatch(runtime, request) }; }
    catch { reply = { version: 1, id: request.id, ok: false, error: { code: "invalid", message: "Refused" } }; }
    if (lost && request.command === "create_task_brief") { lost = false; res.destroy(); return; }
    res.end(responseFrame(reply, request).subarray(4));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const record: AgentHereRecord = { version: 1, mode: "here", id: randomUUID(), hubId: runtime.hubId, machineId: (remote ? "b" : "a").repeat(32), cwd: root, client: "/tools/deck", draftRoot: root, port: address.port, pid: process.pid, ...(remote ? { workerSocket: join(root, "client.sock") } : {}) };
  const unix = unixServer(socket => {
    peers.add(socket); socket.on("error", () => {}); socket.on("close", () => peers.delete(socket));
    socket.pipe(new FrameDecoder()).on("data", (frame: TaskRelayFrame) => {
      const request = JSON.parse(frame.body); calls.push(request);
      void launcherResponse(runtime, record.machineId, true, { ...frame, connectionId: "a".repeat(64), id: "b".repeat(64) }).then(body => {
        if (lost && request.command === "launch_create") { lost = false; socket.destroy(); return; }
        socket.end(encodeFrame(JSON.parse(body)));
      }).catch(() => socket.destroy());
    }).on("error", () => socket.destroy());
  });
  if (remote) { unix.listen(record.workerSocket!); await once(unix, "listening"); await chmod(record.workerSocket!, 0o600); }
  await mkdir(bootstrapPath(root, record.id), { recursive: true, mode: 0o700 });
  const files = new StartupFiles(bootstrapPath(root, record.id)), indexes = new StartupFiles(join(root, "startups"));
  await files.publish("here.json", record);
  await indexes.publish(`${record.id}.json`, { version: 1, id: record.id, hubId: record.hubId, machineId: record.machineId });
  const transport = wizardTransport(record, new AbortController().signal);
  const wizard = () => new AgentWizard(record, files, transport);
  return { root, runtime, record, files, indexes, calls, wizard, lose: () => { lost = true; }, close: async () => {
    for (const peer of peers) peer.destroy();
    if (remote) await new Promise<void>(resolve => unix.close(() => resolve()));
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await runtime.close(); await rm(root, { recursive: true, force: true });
  } };
}
const poll = { version: 1 as const, id: "poll", action: "poll" as const };
test("wizard reply codecs do not confuse here attachment and Rex allocation", () => {
  const base = { version: 1, id: "r", phase: "ready", notice: "Created", saved: true };
  const attachment = { hubId: randomUUID(), machineId: "a".repeat(32), chatId: "2" }, ready = { chatId: "2", allocationId: randomUUID() };
  const here = JSON.parse(JSON.stringify({ ...base, attachment })), rex = JSON.parse(JSON.stringify({ ...base, ready }));
  assert.ok(validWizardReply(here, true)); assert.equal(validWizardReply(here, false), false);
  assert.ok(validWizardReply(rex, false)); assert.equal(validWizardReply(rex, true), false);
  for (const invalid of [{ ...base, attachment, ready }, { ...here, saved: false }, { ...here, phase: "blocked" }, { ...here, attachment: { ...attachment, chatId: "9007199254740992" } }]) assert.equal(validWizardReply(invalid, true), false);
});
for (const remote of [false, true]) for (const failure of ["lost_ack", "receipt_write"] as const) test(`${remote ? "remote" : "local"} here creation retains post-commit ${failure}; only explicit exact retry attaches`, async () => {
  const f = await fixture(remote);
  try {
    if (failure === "lost_ack") f.lose();
    else {
      const publish = f.files.publish.bind(f.files); let fail = true;
      f.files.publish = async (name, value) => { if (name === "created.json" && fail) { fail = false; throw new Error("Injected publication loss"); } return publish(name, value); };
    }
    const first = await f.wizard().handle({ version: 1, id: "create", action: "create", problem: "  Exact problem 日本語\n", description: "" });
    assert.equal(first.phase, "blocked"); assert.ok(first.saved);
    const form = (await startupDraft(f.record, f.files))!, bytes = await readFile(join(f.files.directory, "form.json"));
    assert.equal(form.adoptionId, undefined); assert.equal(form.inputId, undefined); assert.equal(form.description, "");
    assert.equal((await f.runtime.listChats()).items.length, 2, "creation committed before the injected failure");
    const count = f.calls.length, restarted = f.wizard();
    for (let i = 0; i < 3; i++) assert.equal((await restarted.handle(poll)).phase, "blocked");
    assert.equal(f.calls.length, count, "restart and observation do not replay creation");
    const ready = await restarted.handle({ ...poll, action: "retry" }); assert.equal(ready.phase, "ready"); assert.equal(ready.ready, undefined);
    assert.ok(ready.attachment); assert.equal(ready.attachment.hubId, f.record.hubId); assert.equal(ready.attachment.machineId, f.record.machineId);
    assert.equal((await f.runtime.listChats()).items.length, 2);
    assert.deepEqual((await f.runtime.history(ready.attachment.chatId)).items, []);
    assert.equal((await f.runtime.terminalStatus(ready.attachment.chatId)).status, "unallocated");
    const creates = f.calls.filter(c => c.command === (remote ? "launch_create" : "create_task_brief"));
    assert.equal(creates.length, 2); assert.deepEqual(creates[0].args, creates[1].args);
    assert.deepEqual(await readFile(join(f.files.directory, "form.json")), bytes);
    assert.deepEqual(await new DraftStore(f.record.hubId, f.root).list(), []);
    assert.equal(f.calls.some(c => /rex_|adopt|open|admit/.test(c.command)), false);
    assert.equal(await f.files.read("completed.json"), undefined, "creation is not confirmed TUI attachment");
  } finally { await f.close(); }
});
test("discarding uncertain here creation keeps its task and original bytes without replay or cancellation", async () => {
  const f = await fixture(true);
  try {
    f.lose(); const wizard = f.wizard();
    await wizard.handle({ version: 1, id: "c", action: "create", problem: "Retain my task" });
    const bytes = await readFile(join(f.files.directory, "form.json")), count = f.calls.length;
    await wizard.handle({ ...poll, action: "discard" }); await wizard.handle({ ...poll, action: "retry" });
    assert.equal(f.calls.length, count); assert.equal((await f.runtime.listChats()).items.length, 2);
    assert.deepEqual(await readFile(join(f.files.directory, "form.json")), bytes);
    assert.equal(await f.indexes.read(`${f.record.id}.json`), undefined);
  } finally { await f.close(); }
});
test("here storage/provenance failures refuse before creation; legacy bootstrap cannot consume a here record", async () => {
  const f = await fixture(false);
  try {
    assert.deepEqual(await startupRecord(f.root, f.record.id), f.record);
    await assert.rejects(hereRecord(f.root, f.record.id), /native process/);
    await assert.rejects(bootstrapRecord(f.root, f.record.id, false));
    await chmod(f.files.directory, 0o755);
    const refused = await f.wizard().handle({ version: 1, id: "c", action: "create", problem: "No write" });
    assert.equal(refused.phase, "blocked"); assert.equal(f.calls.length, 0);
    await chmod(f.files.directory, 0o700);
    await f.files.publish("record.json", {});
    await assert.rejects(startupRecord(f.root, f.record.id), /Conflicting/);
  } finally { await chmod(f.files.directory, 0o700); await f.close(); }
});
for (const fault of ["none", "receipt", "cwd", "parent"] as const) test(`here TUI bridge validates creation provenance before input/completion (${fault})`, { timeout: 10000 }, async () => {
  const f = await fixture(false); let child: ReturnType<typeof spawn> | undefined;
  try {
    const ready = await f.wizard().handle({ version: 1, id: "c", action: "create", problem: "Brief only" }); assert.ok(ready.attachment);
    if (fault === "receipt") await writeFile(join(f.files.directory, "created.json"), JSON.stringify({ requestId: randomUUID(), chatId: ready.attachment.chatId }));
    if (fault === "cwd" || fault === "parent") await writeFile(join(f.files.directory, "here.json"), JSON.stringify({ ...f.record, ...(fault === "cwd" ? { cwd: "/different" } : { pid: process.pid + 1 }) }));
    child = spawn(process.execPath, [fileURLToPath(new URL("./tui-bridge.js", import.meta.url)), "--port", String(f.record.port), "--hub-id", f.record.hubId, "--task", ready.attachment.chatId, "--attach-machine", f.record.machineId, "--here-startup", f.record.id, "--client-state", f.root], { env: { HOME: f.root, PATH: process.env.PATH, REX_BLOCK: `block:${randomUUID()}` } });
    const closed = once(child, "close"), decoder = child.stdout!.pipe(new FrameDecoder()), replies: any[] = [];
    child.stderr!.resume(); decoder.on("data", reply => replies.push(reply));
    const first = once(decoder, "data");
    child.stdin!.write(encodeFrame({ version: 1, id: "1", action: "poll" }));
    if (fault === "none") {
      const [reply] = await Promise.race([first, closed.then(() => { throw new Error("Bridge closed before ready"); })]);
      assert.ok(reply.ok); assert.equal(reply.snapshot.clientMode, "task"); assert.deepEqual(reply.snapshot.entries, []);
      child.stdin!.end(); await closed;
      assert.deepEqual(await f.files.read("completed.json"), { version: 1 }); assert.equal(await f.indexes.read(`${f.record.id}.json`), undefined);
    } else {
      child.stdin!.write(encodeFrame({ version: 1, id: "2", action: "send", text: "Must not be admitted" }));
      await closed; assert.deepEqual(replies, []); assert.equal(await f.files.read("completed.json"), undefined); assert.ok(await f.indexes.read(`${f.record.id}.json`));
    }
    assert.deepEqual((await f.runtime.history(ready.attachment.chatId)).items, []);
    assert.equal((await f.runtime.terminalStatus(ready.attachment.chatId)).status, "unallocated");
  } finally { if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; } await f.close(); }
});
test("here creation recovery works through the actual control helper and never allocates or admits", async () => {
  const f = await fixture(false);
  const cli = async (action: string, ...values: string[]) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./agent-control-main.js", import.meta.url)), "local", String(f.record.port), action, f.root, ...values]);
    let out = "", err = ""; child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { err += b; });
    const closed = once(child, "close"); return { code: (await closed)[0], out, err };
  };
  try {
    f.lose(); await f.wizard().handle({ version: 1, id: "c", action: "create", problem: "Recover exact creation" });
    const bytes = await readFile(join(f.files.directory, "form.json"));
    assert.equal((await cli("prepare")).code, 1);
    assert.match((await cli("drafts")).out, new RegExp(f.record.id));
    const recovered = await cli("recover", f.record.id); assert.equal(recovered.code, 0, recovered.err); assert.match(recovered.out, /Creation recovered/);
    assert.equal(await f.indexes.read(`${f.record.id}.json`), undefined);
    assert.deepEqual(await readFile(join(f.files.directory, "form.json")), bytes);
    const created = await f.files.read("created.json") as { chatId: string };
    assert.equal((await f.runtime.terminalStatus(created.chatId)).status, "unallocated");
    assert.deepEqual((await f.runtime.history(created.chatId)).items, []);
    assert.equal((await f.runtime.listChats()).items.length, 2);
  } finally { await f.close(); }
});
