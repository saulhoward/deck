import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { TaskId } from "@earendil-works/pi-durable";
import { DeckRuntime } from "./deck.js";
import { RexDoc, type RexPlan } from "./rex-allocation.js";
import { taskClientResponse } from "./remote-clients.js";
import { taskCommand, taskScope } from "./task-client.js";
import { TuiSession, validRequest } from "./tui-session.js";
import { dispatch } from "./ipc.js";
import { parseTaskTarget } from "./task-target.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { IMPLEMENTATION, model, provider, gate, within } from "./instructions.test.support.js";
import type { TaskClientScope } from "./generated/contracts.js";
const machine = "b".repeat(32), uuid = "12345678-1234-1234-1234-123456789abc";
const target = { executable: "/tools/rex", server: "unix:///tmp/private-rex.sock", hostId: uuid, instanceId: uuid };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dcr-")); const client = { executable: "/tools/deck", socket: join(root, "client.sock") };
  const { models, faux } = provider(); faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("task reply")));
  const binding = { machineId: machine, cwd: "/remote workspace" }; let admission: Promise<void> | undefined;
  const plans: RexPlan[] = []; let discoveries = 0;
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, implementation: IMPLEMENTATION, rexClient: "/hub/deck", binding: { machineId: "a".repeat(32), cwd: root }, environment: () => undefined, admissionGuard: async () => { await admission; }, hostFiles: {
    rexClientFor: m => m === machine ? client : undefined,
    call: async (saved, _id, op, args) => {
      assert.deepEqual(saved, binding);
      if (op === "rex_resolve") { discoveries++; return { ok: true, code: "rex_resolved", output: JSON.stringify(target) }; }
      if (op === "rex_inspect") return { ok: true, code: "rex_inspected", output: JSON.stringify({ version: 1, scope: JSON.parse(args.plan!).scope, state: "exited", exitCode: 0, revision: 1 }) };
      assert.equal(op, "rex_allocate"); const plan = JSON.parse(args.plan!) as RexPlan; plans.push(plan);
      return { ok: true, code: "allocated", output: JSON.stringify({ version: 1, ...plan, sessionId: plan.sessionId ?? `session:${randomUUID()}`, windowId: `window:${randomUUID()}`, blockId: `block:${randomUUID()}`, readiness: "not_checked" }) };
    },
  } });
  const chat = await runtime.createTask("remote", binding), chatId = String(chat.id);
  const open = async () => {
    const ack = await runtime.openTerminal({ chatId, requestId: randomUUID(), port: 52800 });
    await runtime.harness.waitForTask(Number(ack.taskId) as TaskId, context);
    const doc = (await runtime.harness.snapshot(RexDoc, chat.id, context))!;
    return taskScope(runtime.hubId, chatId, doc.allocationId, doc.binding!.blockId);
  };
  const scope = await open();
  const direct = async (name: string, args: object, s: TaskClientScope = scope, assigned = machine, hubId = runtime.hubId) => JSON.parse(await taskClientResponse(runtime, assigned, client, { connectionId: "a".repeat(64), id: "b".repeat(64), scope: s, body: JSON.stringify({ version: 1, id: randomUUID(), command: name, args, hubId }) }));
  return { root, client, runtime, chat, chatId, scope, plans, open, direct, discoveries: () => discoveries, blockAdmission: (p?: Promise<void>) => { admission = p; }, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
test("assigned-host Rex launch pins its approved client/socket; remote commands are allocation/task scoped", async () => {
  const f = await fixture();
  try {
    assert.equal(f.discoveries(), 1); assert.equal(f.plans[0]!.client, f.client.executable); assert.equal(f.plans[0]!.workerSocket, f.client.socket);
    const status = await f.direct("status", { chatId: f.chatId }); assert.ok(status.ok); assert.equal(status.result.activity, undefined); assert.equal(status.result.binding.machineId, machine);
    assert.equal((await f.direct("admit", { chatId: f.chatId, requestId: randomUUID(), text: "before startup", mode: "steer" })).ok, false);
    assert.ok((await f.direct("rex_startup", { chatId: f.chatId, allocationId: f.scope.allocationId, blockId: f.scope.blockId })).ok);
    for (const [command, args] of [
      ["list_chats", {}], ["list_hosts", {}], ["create_task_brief", { title: "forbidden", machineId: machine, cwd: "/", requestId: randomUUID(), problem: "brief" }], ["create_task", { title: "forbidden", machineId: machine, cwd: "/", requestId: randomUUID() }],
      ["login_start", { requestId: randomUUID() }], ["rex_open", { chatId: f.chatId, port: 52800, requestId: randomUUID() }],
      ["status", {}], ["history", { chatId: String(f.runtime.main.id) }],
      ["rex_startup", { chatId: f.chatId, allocationId: randomUUID(), blockId: f.scope.blockId }],
    ] as const) assert.equal((await f.direct(command, args)).ok, false, command);
    for (const scope of [{ ...f.scope, allocationId: randomUUID() }, { ...f.scope, blockId: `block:${randomUUID()}` }, { ...f.scope, chatId: String(f.runtime.main.id) }, { ...f.scope, hubId: randomUUID() }]) assert.equal((await f.direct("status", { chatId: scope.chatId }, scope)).ok, false);
    assert.equal((await f.direct("status", { chatId: f.chatId }, f.scope, "c".repeat(32))).ok, false);
    assert.equal((await f.direct("status", { chatId: f.chatId }, f.scope, machine, randomUUID())).ok, false);
    assert.ok((await f.direct("model_settings", { chatId: f.chatId })).ok);
    const lookup = f.runtime.chat.bind(f.runtime), draining = gate(); let drained = false, stops = 0;
    f.runtime.chat = async id => new Proxy(await lookup(id), { get(target, property) {
      if (property === "abort") return async () => { stops++; await draining.promise; drained = true; };
      return Reflect.get(target, property, target);
    } });
    try { assert.deepEqual((await within(f.direct("stop", { chatId: f.chatId }))).result, { requested: true }); assert.equal(stops, 1); assert.equal(drained, false); }
    finally { f.runtime.chat = lookup; draining.release(); }
    const replacement = await f.open(); assert.notEqual(replacement.allocationId, f.scope.allocationId); assert.equal(f.discoveries(), 1);
    assert.equal((await f.direct("status", { chatId: f.chatId })).ok, false, "replacement revokes old terminal scope");
    assert.ok((await f.direct("status", { chatId: f.chatId }, replacement)).ok);
  } finally { await f.close(); }
});
test("explicit task targets keep exact host/cwd/title and create once before separate Rex opening", async () => {
  const f = await fixture();
  try {
    const target = { machineId: machine, cwd: "/remote workspace", title: " exact 🧪 title " };
    assert.deepEqual(parseTaskTarget(JSON.stringify(target)), target);
    for (const invalid of [{ ...target, cwd: "relative" }, { ...target, cwd: "/bad\0path" }, { ...target, machineId: "label" }, { ...target, title: "🧪".repeat(51) }, { ...target, title: " " }, { ...target, extra: true }]) assert.throws(() => parseTaskTarget(JSON.stringify(invalid)));
    assert.ok(validRequest({ version: 1, id: "1", action: "create", taskTarget: target }));
    for (const action of ["poll", "send", "configure", "select"]) assert.equal(validRequest({ version: 1, id: "1", action, taskTarget: target }), false);
    assert.equal(validRequest({ version: 1, id: "1", action: "create", text: "other title", taskTarget: target }), false);
    const calls: string[] = [];
    const session = new TuiSession(async (command, args, hubId) => { calls.push(command); return dispatch(f.runtime, { version: 1, id: randomUUID(), command, args, hubId }); }, undefined, f.runtime.hubId, join(f.root, "drafts"));
    await session.handle({ version: 1, id: "1", action: "poll" });
    const state = await session.handle({ version: 1, id: "2", action: "create", taskTarget: target });
    assert.equal(state.chatId, String(f.runtime.main.id)); assert.equal(state.draft, null);
    assert.ok(calls.indexOf("create_task") < calls.indexOf("rex_open"));
    const row = (await f.runtime.listChats()).items.find(c => c.title === target.title)!;
    assert.equal(row.machineId, target.machineId); assert.equal(row.cwd, target.cwd);
    const readonly = await session.handle({ version: 1, id: "3", action: "select", chatId: row.chatId }); assert.equal(readonly.clientMode, "hub");
    await assert.rejects(session.handle({ version: 1, id: "4", action: "send", text: "no local fallback" }), /Read-only/);
  } finally { await f.close(); }
});
test("remote mutation scope is rechecked at serialized admission, not only at socket ingress", async () => {
  const f = await fixture(); const blocked = gate();
  try {
    await f.direct("rex_startup", { chatId: f.chatId, allocationId: f.scope.allocationId, blockId: f.scope.blockId });
    f.blockAdmission(blocked.promise);
    const occupying = f.runtime.admit(String(f.runtime.main.id), { requestId: randomUUID(), text: "hub", mode: "steer" });
    const checked = gate(); const original = f.runtime.guardedCommand.bind(f.runtime);
    f.runtime.guardedCommand = (guard, fn) => original(async () => { await guard(); checked.release(); }, fn);
    const selection = (await f.runtime.modelSettings(f.chatId)).selection;
    const mutation = f.direct("set_model_settings", { chatId: f.chatId, expected: selection, selection: { ...selection, thinkingLevel: "off" } });
    await within(checked.promise);
    await f.chat.commit(async tx => { (await tx.doc(RexDoc, f.chat.id)).allocationId = randomUUID(); }, context);
    blocked.release(); await occupying;
    assert.equal((await mutation).ok, false);
    assert.deepEqual((await f.runtime.modelSettings(f.chatId)).selection, selection);
  } finally { blocked.release(); await f.close(); }
});
test("private socket TUI keeps exact draft on lost admission ACK; reconnect is read-only, explicit retry deduplicates", async () => {
  const f = await fixture(); const peers = new Set<Socket>(); const requests: any[] = [], admissions: any[] = []; let drop = true;
  const server = createServer(socket => {
    peers.add(socket); socket.on("close", () => peers.delete(socket)); socket.on("error", () => {});
    socket.pipe(new FrameDecoder()).on("data", (message: any) => {
      const request = JSON.parse(message.body); requests.push(request);
      void taskClientResponse(f.runtime, machine, f.client, { ...message, connectionId: "a".repeat(64), id: "b".repeat(64) }).then(body => {
        const reply = JSON.parse(body);
        if (request.command === "admit") { admissions.push(reply); if (drop) { drop = false; socket.destroy(); return; } }
        socket.end(encodeFrame(reply));
      }).catch(() => socket.destroy());
    }).on("error", () => socket.destroy());
  });
  await new Promise<void>(r => server.listen(f.client.socket, r)); await chmod(f.client.socket, 0o600);
  const session = new TuiSession((name, args, hub) => taskCommand(f.client.socket, f.scope, name, args, hub), f.chatId, f.runtime.hubId, join(f.root, "drafts"));
  let id = 0; const act = (action: "poll" | "send" | "retry", text?: string) => session.handle({ version: 1, id: String(++id), action, ...(text === undefined ? {} : { text }) });
  try {
    await session.registerStartup(f.scope.allocationId, f.scope.blockId);
    assert.deepEqual(requests.slice(0, 3).map(r => r.command), ["status", "history", "rex_startup"]);
    assert.equal((await act("poll")).clientMode, "task");
    const text = "  exact remote bytes 🧪\nsecond line  ";
    await assert.rejects(act("send", text), /outcome unconfirmed/);
    const saved = (await act("poll")).draft; assert.ok(saved?.saved); assert.equal(saved.text, text);
    assert.equal(requests.filter(r => r.command === "admit").length, 1);
    const recovered = await act("retry"); assert.equal(recovered.draft, null);
    assert.deepEqual(admissions[0], { ...admissions[1], id: admissions[0].id });
    const sends = requests.filter(r => r.command === "admit"); assert.deepEqual(sends[0].args, sends[1].args);
    assert.equal(sends[0].args.text, text); assert.equal(requests.filter(r => r.command === "rex_startup").length, 1);
    await assert.rejects(session.handle({ version: 1, id: "nav", action: "tasks" }), /locked/);
    await assert.rejects(taskCommand(f.client.socket, f.scope, "status", { chatId: String(f.runtime.main.id) }, f.runtime.hubId), /not sent/);
  } finally { for (const peer of peers) peer.destroy(); await new Promise<void>(r => server.close(() => r())); await f.close(); }
});
