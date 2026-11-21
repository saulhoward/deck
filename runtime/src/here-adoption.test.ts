import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { responseFrame } from "./responses.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type TaskId } from "@earendil-works/pi-durable";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { IMPLEMENTATION, model, provider, gate, within } from "./instructions.test.support.js";
import { RexDoc, type RexPlan } from "./rex-allocation.js";
import { dispatch } from "./ipc.js";
import { launcherResponse } from "./launcher-hub.js";
import { AgentWizard } from "./agent-wizard.js";
import { bootstrapPath, bootstrapRecord, StartupFiles, startupIndexes } from "./agent-storage.js";
import { adoptHere, hereContext, currentHereRecord, inspectHereRegistration, type HereTransport } from "./here-adoption.js";
import type { LauncherRequest, RexAdoptArgs, RexAdoptAck, RexBootstrapRecord } from "./generated/contracts.js";

async function fixture(remote = false, fresh = false) {
  const root = await mkdtemp("/tmp/deck-here-adopt-");
  const hubMachine = "a".repeat(32), machineId = remote ? "b".repeat(32) : hubMachine;
  const binding = { machineId, cwd: "/saved/workspace, not invoking cwd" };
  const client = { executable: "/tools/deck", socket: "/private/worker.sock" };
  const plans: RexPlan[] = [], queries: any[] = [];
  let presence = "running", uncertain = false, allowReopen = false;
  const { models } = provider();
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, implementation: IMPLEMENTATION, binding: { machineId: hubMachine, cwd: "/hub" }, rexClient: client.executable, environment: () => undefined, hostFiles: {
    rexClientFor: machine => machine === machineId ? client : undefined,
    call: async (actual, _id, operation, args) => {
      assert.deepEqual(actual, binding);
      if (operation === "rex_inspect") {
        const query = JSON.parse(args.plan!); queries.push(query);
        return { ok: true, code: "rex_inspected", output: JSON.stringify({ version: 1, scope: query.scope, state: presence, exitCode: null, revision: 1 }) };
      }
      assert.equal(operation, "rex_allocate", "no resolve, native create/run or input effects");
      const plan: RexPlan = JSON.parse(args.plan!); plans.push(plan);
      if (uncertain) return { ok: false, code: "effect_uncertain", output: "" };
      if (!plan.bootstrap) {
        assert.ok(allowReopen, "HERE must never create an ordinary terminal");
        return { ok: true, code: "allocated", output: JSON.stringify({ version: 1, server: plan.server, hostId: plan.hostId, instanceId: plan.instanceId, sessionId: plan.sessionId, windowId: `window:${randomUUID()}`, blockId: `block:${randomUUID()}`, hubId: plan.hubId, chatId: plan.chatId, allocationId: plan.allocationId, readiness: "not_checked" }) };
      }
      assert.equal(plan.bootstrap?.kind, "here");
      const proof = await bootstrapRecord(plan.bootstrap!.root, plan.bootstrap!.id, false);
      if (proof.here?.chatId !== plan.chatId) return { ok: false, code: "invalid", output: "" };
      assert.equal(proof.binding!.blockId, plan.bootstrap!.blockId);
      assert.equal(proof.machineId, actual.machineId); assert.equal(proof.cwd, actual.cwd);
      assert.equal(proof.workerSocket, plan.workerSocket); assert.equal(proof.client, plan.client);
      // Mock only the private native proof/claim effect. No real Rex invocation.
      await writeFile(join(bootstrapPath(proof.draftRoot, proof.id), "record.json"), JSON.stringify({ ...proof, claim: { chatId: plan.chatId, allocationId: plan.allocationId } }), { mode: 0o600 });
      return { ok: true, code: "allocated", output: JSON.stringify({ version: 1, server: plan.server, hostId: plan.hostId, instanceId: plan.instanceId, sessionId: proof.binding!.sessionId, windowId: proof.binding!.windowId, blockId: proof.binding!.blockId, hubId: plan.hubId, chatId: plan.chatId, allocationId: plan.allocationId, readiness: "not_checked" }) };
    },
  } });
  const send = async (request: LauncherRequest) => {
    const reply = JSON.parse(await launcherResponse(runtime, machineId, true, { connectionId: "a".repeat(64), id: "b".repeat(64), launcher: { hubId: runtime.hubId }, body: JSON.stringify(request) }));
    if (!reply.ok) throw new Error(reply.error.code);
    return reply.result;
  };
  const brief = { problem: "Saved exact problem", description: "Never sent as input" };
  const chatId = remote && fresh
    ? (await send({ version: 1, id: randomUUID(), command: "launch_create", args: { requestId: randomUUID(), title: "Here", cwd: binding.cwd, ...brief } })).chatId as string
    : String((await runtime.createTask("Here", binding, randomUUID(), undefined, brief)).id);
  const chat = await runtime.chat(chatId);
  const saved = { chat: await runtime.harness.snapshot(ChatDoc, chat.id, context), agent: await runtime.harness.snapshot(AgentDoc, chat.id, context) };
  const id = randomUUID();
  const proc = { pid: process.ppid, ppid: 1, pgid: process.ppid, uid: process.getuid!(), start: "mock-birth", tty: "/dev/ttys001", executable: client.executable };
  const record: RexBootstrapRecord = { version: 1, id, hubId: runtime.hubId, machineId, cwd: binding.cwd, client: client.executable, draftRoot: root, port: 52800, ...(remote ? { workerSocket: client.socket } : {}), target: { executable: "/tools/rex", server: "unix:///tmp/mock-rex.sock", hostId: randomUUID(), instanceId: randomUUID() }, binding: { sessionId: `session:${randomUUID()}`, windowId: `window:${randomUUID()}`, blockId: `block:${randomUUID()}`, pid: process.ppid }, here: { chatId, process: proc, terminal: { ...proc, pid: 1, executable: "/bin/zsh" } } };
  await mkdir(join(root, "startups"), { mode: 0o700 });
  await mkdir(bootstrapPath(root, id), { mode: 0o700 });
  const files = new StartupFiles(bootstrapPath(root, id));
  await files.publish("record.json", record);
  await writeFile(join(root, "startups", `${id}.json`), JSON.stringify({ version: 1, id, hubId: runtime.hubId, machineId }), { mode: 0o600 });
  const env = { session: process.env.REX_SESSION, block: process.env.REX_BLOCK };
  process.env.REX_SESSION = record.binding!.sessionId; process.env.REX_BLOCK = record.binding!.blockId;
  const read = async (command: string, selected: string) => {
    const request = { version: 1 as const, id: randomUUID(), hubId: runtime.hubId, command, args: { chatId: selected, ...(command === "status" ? { rexHereAdopt: 1 } : {}) } };
    if (!remote) return dispatch(runtime, request);
    const result = await send({ version: 1, id: randomUUID(), command: "launch_task", args: { chatId: selected, body: JSON.stringify(request) } });
    const reply = JSON.parse(result.body); if (!reply.ok) throw new Error(reply.error.code); return reply.result;
  };
  let admissions = 0;
  const transport: HereTransport = {
    status: id => read("status", id), rexStatus: id => read("rex_status", id),
    adopt: async args => {
      admissions++;
      const ack = remote ? (await send({ version: 1, id: randomUUID(), command: "launch_adopt", args })).ack as RexAdoptAck : await runtime.adoptTerminal(args);
      await runtime.harness.waitForTask(Number(ack.taskId) as TaskId, context);
      return ack;
    },
  };
  const args: RexAdoptArgs = { chatId, requestId: id, port: record.port, target: record.target, bootstrap: { id, root, blockId: record.binding!.blockId, kind: "here" } };
  return { root, runtime, record, files, transport, chat, chatId, saved, plans, queries, binding, args, admissions: () => admissions, presence: (state: string) => { presence = state; }, uncertain: () => { uncertain = true; }, allowReopen: () => { allowReopen = true; }, send, close: async () => {
    for (const [key, value] of [["REX_SESSION", env.session], ["REX_BLOCK", env.block]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await runtime.close(); await rm(root, { recursive: true, force: true });
  } };
}
for (const remote of [false, true]) for (const fresh of [false, true]) test(`HERE ${remote ? "remote" : "local"} ${fresh ? "new" : "existing"} task uses one exact allocation and preserves workspace/brief without input`, async () => {
  const f = await fixture(remote, fresh);
  try {
    assert.deepEqual(await hereContext(f.record, f.chatId, f.transport), { hubId: f.runtime.hubId, machineId: f.binding.machineId, chatId: f.chatId, cwd: f.binding.cwd });
    assert.deepEqual(await currentHereRecord(f.root, f.record.id, f.record), f.record);
    const ready = await adoptHere(f.record, f.files, f.transport);
    assert.equal(ready.chatId, f.chatId); assert.equal(f.plans.length, 1); assert.equal(f.admissions(), 1);
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, f.chat.id, context), f.saved.chat);
    assert.deepEqual(await f.runtime.harness.snapshot(AgentDoc, f.chat.id, context), f.saved.agent);
    assert.deepEqual((await f.runtime.history(f.chatId)).items, []);
    assert.deepEqual(await startupIndexes(f.root, f.runtime.hubId, f.binding.machineId), []);
    const claimed = await currentHereRecord(f.root, f.record.id, f.record);
    assert.deepEqual(await adoptHere(claimed, f.files, f.transport), ready); assert.equal(f.admissions(), 1);
    assert.deepEqual(await f.runtime.adoptTerminal(f.args), await f.files.read("adopted.json")); assert.equal(f.plans.length, 1);
    await f.runtime.registerTerminalStartup(f.chatId, ready.allocationId, f.record.binding!.blockId);
    f.presence("client_exited");
    assert.equal((await f.runtime.inspectTerminal(f.chatId)).observation?.state, "client_exited");
    assert.deepEqual(f.queries[0].bootstrap, f.args.bootstrap);
    await assert.rejects(hereContext(f.record, f.chatId, f.transport), /prior Rex/);
    assert.throws(() => new AgentWizard(claimed, f.files, { hub: async () => {}, launcher: async () => {} }), /Bootstrap/);
  } finally { await f.close(); }
});
for (const mode of ["lost", "bad", "pending"] as const) test(`HERE ${mode} ACK/outcome keeps a durable single-send fence`, async () => {
  const f = await fixture();
  try {
    const original = f.transport.adopt;
    f.transport.adopt = async args => { const ack = await original(args); if (mode === "lost") throw new Error("lost ACK"); return mode === "bad" ? { ...ack as object, chatId: "999" } : ack; };
    const read = f.transport.rexStatus;
    if (mode === "pending") f.transport.rexStatus = async id => { const status = await read(id) as any; return status.taskId ? { ...status, status: "pending", binding: null } : status; };
    await assert.rejects(adoptHere(f.record, f.files, f.transport, { polls: 2, pauseMs: 0 }));
    const fence = await readFile(join(f.files.directory, "adoption-intent.json"));
    if (mode === "pending") { f.transport.rexStatus = read; assert.equal((await adoptHere(f.record, f.files, f.transport)).chatId, f.chatId); }
    else await assert.rejects(adoptHere(await currentHereRecord(f.root, f.record.id, f.record), f.files, f.transport), /no automatic resend/);
    assert.equal(f.admissions(), 1); assert.equal(f.plans.length, 1);
    assert.deepEqual(await readFile(join(f.files.directory, "adoption-intent.json")), fence);
  } finally { await f.close(); }
});
test("HERE concurrent helpers have one exclusive intent publisher", async () => {
  const f = await fixture();
  try {
    const outcome = await Promise.allSettled([adoptHere(f.record, f.files, f.transport), adoptHere(f.record, f.files, f.transport)]);
    assert.equal(outcome.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.admissions(), 1); assert.equal(f.plans.length, 1);
  } finally { await f.close(); }
});
test("HERE global block reservation and prior allocation conflicts preserve all original metadata", async () => {
  const f = await fixture();
  try {
    await adoptHere(f.record, f.files, f.transport);
    const before = await f.runtime.harness.snapshot(RexDoc, f.chat.id, context);
    for (const args of [{ ...f.args, requestId: randomUUID() }, { ...f.args, bootstrap: { id: f.args.bootstrap.id, root: f.args.bootstrap.root, blockId: f.args.bootstrap.blockId } }, { ...f.args, bootstrap: { ...f.args.bootstrap, root: "/other-root" } }]) await assert.rejects(f.runtime.adoptTerminal(args as RexAdoptArgs), { code: "conflict" });
    const other = await f.runtime.createTask("Other", f.binding);
    await assert.rejects(f.runtime.adoptTerminal({ ...f.args, chatId: String(other.id), requestId: randomUUID(), bootstrap: { ...f.args.bootstrap, id: randomUUID(), root: "/other-root" } }), { code: "conflict" });
    assert.equal(f.plans.length, 1); assert.equal(await f.runtime.harness.snapshot(RexDoc, other.id, context), undefined);
    assert.deepEqual(await f.runtime.harness.snapshot(RexDoc, f.chat.id, context), before);
  } finally { await f.close(); }
});
test("HERE launch_adopt rechecks launcher scope at serialized admission", async () => {
  const f = await fixture(true), entered = gate(), release = gate();
  try {
    const allocate = f.runtime.allocateTerminal.bind(f.runtime);
    f.runtime.allocateTerminal = async (...args) => { entered.release(); await release.promise; return allocate(...args); };
    const pending = f.send({ version: 1, id: randomUUID(), command: "launch_adopt", args: f.args });
    await within(entered.promise);
    await f.chat.commit(async tx => { (await tx.doc(ChatDoc, f.chat.id)).machineId = "c".repeat(32); }, context);
    release.release(); await assert.rejects(pending); assert.equal(f.plans.length, 0);
  } finally { release.release(); await f.close(); }
});

test("HERE uncertain allocation retains global reservation and refuses every replacement path", async () => {
  const f = await fixture();
  try {
    f.uncertain();
    await assert.rejects(adoptHere(f.record, f.files, f.transport), /unconfirmed/);
    const before = await f.runtime.harness.snapshot(RexDoc, f.chat.id, context);
    assert.equal((await f.runtime.terminalStatus(f.chatId)).status, "uncertain");
    const other = await f.runtime.createTask("Competing", f.binding);
    await assert.rejects(f.runtime.adoptTerminal({ ...f.args, requestId: randomUUID(), chatId: String(other.id) }), { code: "conflict" });
    await assert.rejects(f.runtime.adoptTerminal({ ...f.args, requestId: randomUUID() }), { code: "conflict" });
    await assert.rejects(f.runtime.allocateTerminal(f.chatId, randomUUID(), { ...f.record.target, client: f.record.client, port: f.record.port, bootstrap: f.args.bootstrap, clientState: f.root }, undefined, f.binding, { priorTaskId: before!.taskId }), { code: "conflict" });
    await assert.rejects(hereContext(f.record, f.chatId, f.transport), /prior Rex/);
    assert.deepEqual(await f.runtime.harness.snapshot(RexDoc, f.chat.id, context), before);
    assert.equal(f.plans.length, 1);
  } finally { await f.close(); }
});
test("HERE mode cannot authorize a different chat than its native proof", async () => {
  const f = await fixture();
  try {
    const other = await f.runtime.createTask("Wrong native chat", f.binding);
    const ack = await f.runtime.adoptTerminal({ ...f.args, chatId: String(other.id) });
    await f.runtime.harness.waitForTask(Number(ack.taskId) as TaskId, context);
    assert.equal((await f.runtime.terminalStatus(String(other.id))).status, "not_allocated");
    assert.equal((await f.runtime.terminalStatus(f.chatId)).status, "unallocated");
    assert.equal((await bootstrapRecord(f.root, f.record.id)).claim, undefined);
    assert.deepEqual((await f.runtime.history(String(other.id))).items, []);
  } finally { await f.close(); }
});
test("HERE process death reopens only on explicit open, in the saved session without bootstrap", async () => {
  const f = await fixture();
  try {
    await adoptHere(f.record, f.files, f.transport);
    f.presence("client_exited"); f.allowReopen();
    const ack = await f.runtime.openTerminal({ chatId: f.chatId, requestId: randomUUID(), port: f.record.port, confirmedOnly: true });
    await f.runtime.harness.waitForTask(Number(ack.taskId) as TaskId, context);
    assert.equal(f.plans.length, 2); assert.equal(f.plans[1]!.bootstrap, undefined);
    assert.equal(f.plans[1]!.sessionId, f.record.binding!.sessionId);
    assert.equal(f.plans[1]!.clientState, f.root);
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, f.chat.id, context), f.saved.chat);
    assert.deepEqual((await f.runtime.history(f.chatId)).items, []);
  } finally { await f.close(); }
});
test("HERE helper refuses wrong endpoint, full environment or parent proof before any send", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ hubId: randomUUID() }, { machineId: "c".repeat(32) }, { port: 52801 }, { workerSocket: "/wrong.sock" }]) await assert.rejects(currentHereRecord(f.root, f.record.id, { ...f.record, ...patch }));
    process.env.REX_SESSION = f.record.binding!.sessionId + "\n";
    await assert.rejects(currentHereRecord(f.root, f.record.id, f.record));
    process.env.REX_SESSION = f.record.binding!.sessionId;
    process.env.REX_BLOCK = "block:short";
    await assert.rejects(currentHereRecord(f.root, f.record.id, f.record));
    process.env.REX_BLOCK = f.record.binding!.blockId;
    await writeFile(join(f.files.directory, "record.json"), JSON.stringify({ ...f.record, binding: { ...f.record.binding, pid: process.pid } }));
    await assert.rejects(currentHereRecord(f.root, f.record.id, f.record));
    assert.equal(f.admissions(), 0); assert.equal(f.plans.length, 0);
  } finally { await f.close(); }
});
test("HERE context refuses all historical attempt states without mutations", async () => {
  const f = await fixture();
  try {
    for (const status of ["allocated", "pending", "uncertain", "aborted", "not_allocated"]) {
      const transport = { ...f.transport, rexStatus: async () => ({ version: 1, hubId: f.record.hubId, chatId: f.chatId, taskId: "5", status, binding: null, previousBinding: null, bestEffort: true }) };
      await assert.rejects(hereContext(f.record, f.chatId, transport));
    }
    // Even a dangling historical allocation ID is never projected as absent.
    await f.chat.commit(async tx => { (await tx.doc(RexDoc, f.chat.id)).taskId = 999999; }, context);
    assert.equal((await f.runtime.terminalStatus(f.chatId)).status, "uncertain");
    await assert.rejects(hereContext(f.record, f.chatId, f.transport));
    assert.equal(f.admissions(), 0); assert.equal(f.plans.length, 0);
    assert.equal(await f.files.read("adoption-intent.json"), undefined);
  } finally { await f.close(); }
});

for (const drift of [false, true]) test(`HERE creation TUI uses exact allocation without attach-machine (${drift ? "workspace drift" : "ready"})`, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(chunk);
    const raw = JSON.parse(Buffer.concat(bytes).toString()); calls.push(raw.command);
    try { response.end(responseFrame({ version: 1, id: raw.id, ok: true, result: await dispatch(f.runtime, raw) }, raw).subarray(4)); }
    catch { response.end(JSON.stringify({ version: 1, id: raw.id, ok: false, error: { code: "conflict", message: "Refused" } })); }
  });
  try {
    const ready = await adoptHere(f.record, f.files, f.transport);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const id = randomUUID(), creationId = randomUUID();
    const original = { version: 1, mode: "here", id, hubId: f.record.hubId, machineId: f.record.machineId, cwd: drift ? "/changed" : f.record.cwd, client: f.record.client, draftRoot: f.root, port: address.port, pid: process.pid };
    await mkdir(bootstrapPath(f.root, id), { mode: 0o700 });
    const files = new StartupFiles(bootstrapPath(f.root, id));
    await files.publish("here.json", original);
    await files.publish("form.json", { version: 1, bootstrapId: id, hubId: original.hubId, machineId: original.machineId, cwd: original.cwd, creationId, title: "Here", problem: "Saved exact problem" });
    await files.publish("created.json", { requestId: creationId, chatId: f.chatId });
    await writeFile(join(f.root, "startups", `${id}.json`), JSON.stringify({ version: 1, id, hubId: original.hubId, machineId: original.machineId }), { mode: 0o600 });
    child = spawn(process.execPath, [fileURLToPath(new URL("./tui-bridge.js", import.meta.url)), "--port", String(address.port), "--hub-id", f.record.hubId, "--task", f.chatId, "--rex-allocation", ready.allocationId, "--here-startup", id, "--client-state", f.root]);
    child.stderr!.resume();
    const closed = once(child, "close"), decoder = child.stdout!.pipe(new FrameDecoder());
    const replies: unknown[] = []; decoder.on("data", value => { replies.push(value); child!.stdin!.end(); });
    child.stdin!.on("error", () => {});
    child.stdin!.write(encodeFrame({ version: 1, id: "poll", action: "poll" }));
    await closed;
    assert.equal(calls.includes("rex_startup"), !drift);
    assert.equal(replies.length, drift ? 0 : 1);
    assert.deepEqual(await files.read("completed.json"), drift ? undefined : { version: 1 });
    assert.deepEqual((await f.runtime.history(f.chatId)).items, []);
    assert.equal(f.plans.length, 1);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});

for (const remote of [false, true]) test(`HERE capability is opt-in, preserving older ${remote ? "scoped" : "local"} status decoders`, async () => {
  const f = await fixture(remote);
  try {
    const read = async (args: Record<string, unknown>) => {
      const request = { version: 1, id: randomUUID(), hubId: f.runtime.hubId, command: "status", args };
      if (!remote) return dispatch(f.runtime, request) as Promise<any>;
      const reply = await f.send({ version: 1, id: randomUUID(), command: "launch_task", args: { chatId: f.chatId, body: JSON.stringify(request) } });
      return JSON.parse(reply.body).result;
    };
    const legacy = await read({ chatId: f.chatId });
    assert.equal(Object.hasOwn(legacy, "rexHereAdopt"), false);
    const opted = await read({ chatId: f.chatId, rexHereAdopt: 1 });
    assert.equal(opted.rexHereAdopt, 1);
    delete opted.rexHereAdopt;
    assert.deepEqual(Object.keys(opted).sort(), Object.keys(legacy).sort(), "no other new unsolicited status fields");
    await assert.rejects(hereContext(f.record, f.chatId, { ...f.transport, status: async () => legacy }), /scope unavailable/);
    assert.equal(f.admissions(), 0);
  } finally { await f.close(); }
});
test("HERE client exit still permits explicit separate child opening in its saved session", async () => {
  const f = await fixture();
  try {
    await adoptHere(f.record, f.files, f.transport);
    const child = await f.runtime.createManagedChild(f.chatId, undefined, randomUUID(), { problem: "After parent detach", description: "" });
    const before = await f.runtime.harness.snapshot(RexDoc, f.chat.id, context);
    f.presence("client_exited"); f.allowReopen();
    const ack = await f.runtime.openManagedChild({ chatId: f.chatId, childId: String(child.id), requestId: randomUUID(), port: f.record.port });
    await f.runtime.harness.waitForTask(Number(ack.ack.taskId) as TaskId, context);
    const status = await f.runtime.terminalStatus(String(child.id));
    assert.equal(status.status, "allocated");
    assert.equal(status.binding?.sessionId, f.record.binding!.sessionId);
    assert.notEqual(status.binding?.blockId, f.record.binding!.blockId);
    assert.equal(f.plans[1]!.bootstrap, undefined);
    assert.deepEqual(await f.runtime.harness.snapshot(RexDoc, f.chat.id, context), before);
    assert.deepEqual((await f.runtime.history(String(child.id))).items, []);
  } finally { await f.close(); }
});

for (const lost of [false, true]) test(`HERE explicit recovery reads historical registration (${lost ? "lost ACK" : "uncertain effect"}) without replay or process adoption`, async () => {
  const f = await fixture();
  try {
    if (lost) { const adopt = f.transport.adopt; f.transport.adopt = async args => { await adopt(args); throw new Error("Lost ACK"); }; }
    else f.uncertain();
    await assert.rejects(adoptHere(f.record, f.files, f.transport));
    const bytes = await readFile(join(f.files.directory, "adoption-intent.json"));
    const historical = await bootstrapRecord(f.root, f.record.id, false);
    delete process.env.REX_SESSION; delete process.env.REX_BLOCK;
    const observed = await inspectHereRegistration(historical, f.transport);
    assert.equal(observed.status, lost ? "allocated" : "uncertain");
    assert.equal(f.admissions(), 1); assert.equal(f.plans.length, 1);
    assert.deepEqual(await readFile(join(f.files.directory, "adoption-intent.json")), bytes);
    assert.equal(await f.files.read("completed.json"), undefined);
    assert.equal((await startupIndexes(f.root, f.runtime.hubId, f.record.machineId)).length, 1);
    assert.deepEqual((await f.runtime.history(f.chatId)).items, []);
  } finally { await f.close(); }
});
