import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type TaskId } from "@earendil-works/pi-durable";
import { ChatDoc } from "./chat-doc.js";
import { attachedCommand } from "./attached-client.js";
import { DraftStore } from "./drafts.js";
import { launcherResponse } from "./launcher-hub.js";
import { setup } from "./managed-child.test.support.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { taskClientResponse } from "./remote-clients.js";
import { RexDoc, type RexPlan } from "./rex-allocation.js";
import { namedChildren } from "./subagent-view.test.support.js";
import { taskCommand, taskScope } from "./task-client.js";
import { TuiSession } from "./tui-session.js";
import type { TuiRequest } from "./generated/contracts.js";

// Exercise TuiSession through the actual framed clients, canonical guards and Pi
// runtime. Only native Rex effects are faked: allocation/startup/relationship
// records, command admission, deduplication and reply validation are real.
async function fixture(remote: boolean, managed = false, allocated = true) {
  const root = await mkdtemp(join(tmpdir(), "deck-tui-child-"));
  const machine = "b".repeat(32), binding = { machineId: machine, cwd: "/exact saved 日本語 workspace" };
  const client = { executable: "/approved/deck", socket: join(root, "client.sock") };
  const target = { executable: "/saved/rex", server: "unix:///tmp/parent-rex.sock", hostId: randomUUID(), instanceId: randomUUID() };
  const plans: RexPlan[] = [];
  const f = setup({ binding: remote ? { machineId: "a".repeat(32), cwd: "/hub" } : binding, rexClient: client.executable, hostFiles: {
    rexClientFor: id => remote && id === machine ? client : undefined,
    call: async (saved, _id, op, args) => {
      assert.deepEqual(saved, binding);
      if (op === "rex_inspect") return { ok: true, code: "rex_inspected", output: JSON.stringify({ version: 1, scope: JSON.parse(args.plan!).scope, state: "running", exitCode: null, revision: 1 }) };
      assert.equal(op, "rex_allocate"); const plan = JSON.parse(args.plan!) as RexPlan; plans.push(plan);
      return { ok: true, code: "allocated", output: JSON.stringify({ version: 1, ...plan, sessionId: plan.sessionId ?? `session:${randomUUID()}`, windowId: `window:${randomUUID()}`, blockId: `block:${randomUUID()}`, readiness: "not_checked" }) };
    },
  } });
  const runtime = await f.open(join(root, "pi.sqlite"));
  const outer = await runtime.createTask("Root parent", binding);
  const parent = managed ? await runtime.createManagedChild(String(outer.id), "Managed parent", randomUUID()) : outer, parentId = String(parent.id);
  const settle = (taskId: string) => runtime.harness.waitForTask(Number(taskId) as TaskId, context);
  if (allocated) await settle((await runtime.openTerminal({ chatId: parentId, requestId: randomUUID(), port: 52800, target })).taskId);
  const store = new DraftStore(runtime.hubId, join(root, "drafts"));
  const flags = { loseCreateOnce: false, malformedCreateOnce: false, loseOpenOnce: false };
  const requests: any[] = [], replies: any[] = [], draftsAtOpen: unknown[][] = [], peers = new Set<Socket>();
  const server = createServer(socket => {
    peers.add(socket); socket.on("error", () => {}); socket.on("close", () => peers.delete(socket));
    socket.pipe(new FrameDecoder()).on("data", (frame: any) => {
      void (async () => {
        const outer = JSON.parse(frame.body), request = frame.launcher ? JSON.parse(outer.args.body) : outer;
        requests.push(request);
        if (request.command === "open_managed_child") draftsAtOpen.push(await store.list());
        const envelope = { ...frame, connectionId: "a".repeat(64), id: "b".repeat(64) };
        const body = remote ? await taskClientResponse(runtime, machine, client, envelope) : await launcherResponse(runtime, machine, true, envelope);
        const reply = JSON.parse(body), inner = frame.launcher && reply.ok ? JSON.parse(reply.result.body) : reply;
        replies.push({ command: request.command, ...inner });
        if (request.command === "create_managed_child") {
          if (flags.loseCreateOnce) { flags.loseCreateOnce = false; socket.destroy(); return; }
          if (flags.malformedCreateOnce && inner.ok) {
            flags.malformedCreateOnce = false; inner.result.parentChatId = String(runtime.main.id);
            if (frame.launcher) reply.result.body = JSON.stringify(inner);
          }
        }
        if (request.command === "open_managed_child" && flags.loseOpenOnce) { flags.loseOpenOnce = false; socket.destroy(); return; }
        socket.end(encodeFrame(reply));
      })().catch(() => socket.destroy());
    }).on("error", () => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(client.socket, resolve)); await chmod(client.socket, 0o600);
  const session = async (id = parentId) => {
    const doc = await runtime.harness.snapshot(RexDoc, (await runtime.chat(id)).id, context);
    const scope = doc?.binding ? taskScope(runtime.hubId, id, doc.allocationId, doc.binding.blockId) : undefined;
    const command = (name: string, args: Record<string, unknown>, hubId?: string) => remote
      ? taskCommand(client.socket, scope!, name, args, hubId)
      : attachedCommand({ hubId: runtime.hubId, machineId: machine, socket: client.socket }, id, name, args, hubId);
    const tui = new TuiSession(command, id, runtime.hubId, join(root, "drafts"), 52800);
    if (remote) await tui.registerStartup(scope!.allocationId, scope!.blockId); else await tui.registerAttachment(machine);
    await tui.handle({ version: 1, id: randomUUID(), action: "poll" }); // Observe current model settings before mutations.
    return { tui, command, act: (action: TuiRequest["action"], args: Partial<TuiRequest> = {}) => tui.handle({ version: 1, id: randomUUID(), action, ...args }) };
  };
  return { root, runtime, parent, parentId, outer, flags, store, plans, requests, replies, draftsAtOpen, session, settle, faux: f.faux,
    close: async () => { for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); await rm(root, { recursive: true, force: true }); },
  };
}

for (const remote of [false, true]) for (const managed of [false, true]) test(`${remote ? "remote allocation" : "local attachment"} guarded TUI: ${managed ? "managed" : "ordinary"} parent creates/opens its own child and nested child, without input or parent mutation`, async () => {
  const f = await fixture(remote, managed);
  try {
    const parent = await f.session(), before = await f.runtime.harness.snapshot(RexDoc, f.parent.id, context);
    const meta = await f.runtime.harness.snapshot(ChatDoc, f.parent.id, context), agent = await f.runtime.harness.snapshot(AgentDoc, f.parent.id, context);
    const form = { title: "Own child", managedParentChatId: f.parentId, problem: " exact 日本語\n", description: "trailing spaces  " };
    const created = await parent.act("create", { taskForm: form });
    assert.equal(created.chatId, f.parentId); assert.equal(created.clientMode, "task"); assert.equal(created.draft, null); assert.match(created.notice, /Child \d+ created\. Child TUI opening/);
    const ack = f.replies.find(r => r.command === "open_managed_child"); assert.equal(ack.ok, true); await f.settle(ack.result.ack.taskId);
    const childId = ack.result.childId, child = await f.runtime.chat(childId);
    const childMeta = await f.runtime.harness.snapshot(ChatDoc, child.id, context);
    assert.equal(childMeta!.managedParentChatId, f.parentId); assert.equal(childMeta!.machineId, meta!.machineId); assert.equal(childMeta!.cwd, meta!.cwd);
    assert.deepEqual(childMeta!.brief, { problem: form.problem, description: form.description });
    assert.equal(f.plans[1]!.sessionId, before!.binding!.sessionId); assert.equal(f.plans[1]!.chatId, childId); assert.notEqual(f.plans[1]!.allocationId, before!.allocationId);
    assert.equal(f.plans[1]!.workerSocket, remote ? join(f.root, "client.sock") : undefined);
    assert.deepEqual(await f.runtime.harness.snapshot(RexDoc, f.parent.id, context), before);
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, f.parent.id, context), meta);
    assert.deepEqual(await f.runtime.harness.snapshot(AgentDoc, f.parent.id, context), agent);
    for (let i = 0; i < 3; i++) assert.equal((await parent.act("poll")).chatId, f.parentId);
    await assert.rejects(parent.act("retry"), /No pending draft/);
    // Child TUI has its own terminal authority but only its own parent pin.
    const nested = await f.session(childId);
    await assert.rejects(nested.act("create", { taskForm: { ...form, title: "Forbidden sibling" } }), /locked/);
    const grandchild = await nested.act("create", { taskForm: { title: "Nested child", managedParentChatId: childId } });
    assert.equal(grandchild.chatId, childId); assert.match(grandchild.notice, /Child TUI opening/);
    const last = f.replies.filter(r => r.command === "open_managed_child").at(-1)!; await f.settle(last.result.ack.taskId);
    assert.equal(last.result.parentChatId, childId); assert.equal(f.plans[2]!.sessionId, before!.binding!.sessionId);
    assert.notEqual(f.plans[2]!.allocationId, f.plans[1]!.allocationId);
    const creates = f.requests.filter(r => r.command === "create_managed_child"), opens = f.requests.filter(r => r.command === "open_managed_child");
    assert.deepEqual(creates.map(r => r.args.parentChatId), [f.parentId, childId]); assert.deepEqual(opens.map(r => r.args.chatId), [f.parentId, childId]);
    assert.ok(f.requests.every(r => r.hubId === f.runtime.hubId));
    assert.deepEqual(f.draftsAtOpen, [[], []], "durable creation drafts are cleared before either terminal attempt");
    assert.deepEqual(await f.store.list(), []);
    assert.ok(!f.requests.some(r => ["rex_open", "admit", "create_task", "create_task_brief"].includes(r.command)));
    for (const id of [f.parentId, childId, last.result.childId]) assert.deepEqual((await f.runtime.history(id)).items, []);
    assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});

for (const remote of [false, true]) for (const badAck of [false, true]) test(`${remote ? "remote" : "local"} guarded TUI ${badAck ? "malformed" : "lost"} child creation ACK: exact persisted retry survives session restart, no background resend`, async () => {
  const f = await fixture(remote, true); f.flags.loseCreateOnce = !badAck; f.flags.malformedCreateOnce = badAck;
  try {
    const parent = await f.session(), form = { title: "Saved child", managedParentChatId: f.parentId, problem: " exact\n", description: "日本語" };
    await assert.rejects(parent.act("create", { taskForm: form }));
    const saved = (await f.store.list())[0]!, path = join(f.store.directory, `${saved.requestId}.json`), bytes = await readFile(path);
    assert.deepEqual((await f.store.load(saved.requestId)).request, { kind: "task", chatId: f.parentId, requestId: saved.requestId, ...form });
    const recovered = await f.session();
    for (let i = 0; i < 3; i++) assert.equal((await recovered.act("poll")).draft!.requestId, saved.requestId);
    assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 1); assert.equal(f.plans.length, 1);
    assert.deepEqual(await readFile(path), bytes);
    const created = await recovered.act("retry"); assert.equal(created.chatId, f.parentId); assert.equal(created.draft, null); assert.match(created.notice, /Child TUI opening/);
    const creates = f.requests.filter(r => r.command === "create_managed_child"); assert.equal(creates.length, 2); assert.deepEqual(creates[0].args, creates[1].args);
    const open = f.replies.find(r => r.command === "open_managed_child"); assert.equal(open.ok, true); await f.settle(open.result.ack.taskId);
    assert.equal((await f.runtime.listChats()).items.filter(c => c.managedParentChatId === f.parentId).length, 1);
    assert.equal(f.requests.filter(r => r.command === "rex_status").length, 1, "saved retry is not a new form preflight");
    assert.deepEqual(f.draftsAtOpen, [[]]); assert.deepEqual(await f.store.list(), []);
    assert.equal(f.plans.length, 2); assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});

for (const remote of [false, true]) test(`${remote ? "remote" : "local"} guarded TUI lost child-open ACK requires explicit recovery; changed parent allocation refuses rather than reopening elsewhere`, async () => {
  const f = await fixture(remote); f.flags.loseOpenOnce = true;
  try {
    const parent = await f.session();
    const created = await parent.act("create", { taskForm: { title: "Open once", managedParentChatId: f.parentId } });
    assert.match(created.notice, /created; same-session Rex open unconfirmed/); assert.equal(created.draft, null);
    const ack = f.replies.find(r => r.command === "open_managed_child"); assert.ok(ack.ok); await f.settle(ack.result.ack.taskId);
    const childId = ack.result.childId;
    for (let i = 0; i < 3; i++) await parent.act("poll");
    await assert.rejects(parent.act("retry"), /No pending draft/);
    assert.equal(f.requests.filter(r => r.command === "open_managed_child").length, 1);
    const recovered = await parent.act("childOpen", { chatId: childId }); assert.equal(recovered.chatId, f.parentId); assert.match(recovered.notice, /TUI reused/);
    const opens = f.requests.filter(r => r.command === "open_managed_child"); assert.equal(opens.length, 2); assert.notEqual(opens[0].args.requestId, opens[1].args.requestId);
    assert.equal(f.plans.length, 2, "explicit recovery reuses the running child rather than allocating again");
    await f.parent.commit(async tx => { (await tx.doc(RexDoc, f.parent.id)).allocationId = randomUUID(); }, context);
    await assert.rejects(parent.act("childOpen", { chatId: childId }), /unconfirmed/);
    assert.equal(f.plans.length, 2); assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 1);
    assert.deepEqual(await f.store.list(), []); assert.deepEqual(f.draftsAtOpen, [[], [], []]);
    assert.ok(!f.requests.some(r => r.command === "rex_open" || r.command === "admit"));
  } finally { await f.close(); }
});

for (const remote of [false, true]) test(`${remote ? "remote" : "local"} guarded TUI rejects forged/captured/foreign child targets and read-only child forms`, async () => {
  const f = await fixture(remote);
  try {
    const parent = await f.session(), mainId = String(f.runtime.main.id);
    const other = await f.runtime.createTask("Other root", { machineId: "b".repeat(32), cwd: "/exact saved 日本語 workspace" });
    const foreign = await f.runtime.createManagedChild(String(other.id), "Other parent's child", randomUUID());
    const captured = (await namedChildren(f.runtime, f.parentId))[0]!;
    const before = f.requests.length;
    await assert.rejects(parent.act("create", { taskForm: { title: "Spoof", managedParentChatId: mainId } }), /locked/);
    assert.equal(f.requests.length, before);
    for (const id of [String(other.id), String(foreign.id), captured.chatId]) await assert.rejects(parent.act("childOpen", { chatId: id }), /unconfirmed/);
    const inspected = await parent.act("subagent", { text: captured.name }); assert.equal(inspected.inspectParentChatId, f.parentId);
    const reads = f.requests.length;
    await assert.rejects(parent.act("create", { taskForm: { title: "Captured", managedParentChatId: captured.chatId } }), /Read-only/);
    await assert.rejects(parent.act("childOpen", { chatId: String(foreign.id) }), /Read-only/);
    assert.equal(f.requests.length, reads);
    await parent.act("parent");
    // Merely forging the metadata cannot erase Pi's captured ownership.
    const owned = await f.runtime.chat(captured.chatId);
    await owned.commit(async tx => { const saved = await tx.doc(ChatDoc, owned.id); saved.kind = "task"; saved.managedParentChatId = f.parentId; delete saved.parentChatId; delete saved.ownerTaskId; }, context);
    await assert.rejects(parent.act("childOpen", { chatId: captured.chatId }), /unconfirmed/);
    await assert.rejects(parent.command("rex_open", { chatId: f.parentId, requestId: randomUUID(), port: 52800 }));
    await assert.rejects(parent.command("create_managed_child", { parentChatId: String(other.id), requestId: randomUUID(), title: "Cross-parent" }));
    assert.equal(f.plans.length, 1); assert.deepEqual(await f.store.list(), []); assert.equal(f.faux.state.callCount, 0);
    assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 0);
    assert.ok(!f.requests.some(r => ["rex_open", "admit"].includes(r.command)));
  } finally { await f.close(); }
});

test("unallocated --here attachment refuses own-child form before saving or creating; it never falls back to a new Rex session", async () => {
  const f = await fixture(false, false, false);
  try {
    const parent = await f.session();
    await assert.rejects(parent.act("create", { taskForm: { title: "No Rex parent", managedParentChatId: f.parentId } }), /Parent has no confirmed Rex allocation/);
    assert.equal((await parent.act("poll")).draft, null); assert.deepEqual(await f.store.list(), []); assert.deepEqual(f.plans, []);
    assert.deepEqual((await f.runtime.listChats()).items.map(c => c.chatId), [String(f.runtime.main.id), f.parentId]);
    assert.ok(!f.requests.some(r => r.command.startsWith("create_") || r.command === "open_managed_child" || r.command === "rex_open"));
  } finally { await f.close(); }
});
