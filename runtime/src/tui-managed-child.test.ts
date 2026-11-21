import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, defineDoc, type TaskId } from "@earendil-works/pi-durable";
import { ChatDoc } from "./chat-doc.js";
import { agentNameAlgorithms, lookupAgentName } from "./agent-names.js";
import { ManagedChildRequest } from "./managed-child.js";
import { briefInstructions } from "./task-brief.js";
import { attachedCommand } from "./attached-client.js";
import { DraftStore } from "./drafts.js";
import { launcherResponse } from "./launcher-hub.js";
import { setup } from "./managed-child.test.support.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { taskClientResponse } from "./remote-clients.js";
import { RexDoc, type RexPlan } from "./rex-allocation.js";
import { namedChildren } from "./subagent-view.test.support.js";
import { taskCommand, taskScope } from "./task-client.js";
import { TuiSession, TuiRequestNotSent, validRequest } from "./tui-session.js";
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
  const flags = { loseCreateOnce: false, malformedCreateOnce: false, loseOpenOnce: false, hideProblemCapability: false };
  const requests: any[] = [], replies: any[] = [], draftsAtOpen: unknown[][] = [], draftsAtCreate: unknown[][] = [], peers = new Set<Socket>();
  const server = createServer(socket => {
    peers.add(socket); socket.on("error", () => {}); socket.on("close", () => peers.delete(socket));
    socket.pipe(new FrameDecoder()).on("data", (frame: any) => {
      void (async () => {
        const outer = JSON.parse(frame.body), request = frame.launcher ? JSON.parse(outer.args.body) : outer;
        requests.push(request);
        if (request.command === "open_managed_child") draftsAtOpen.push(await store.list());
        if (request.command === "create_managed_child") draftsAtCreate.push(await Promise.all((await store.list()).map(d => store.load(d.requestId))));
        const envelope = { ...frame, connectionId: "a".repeat(64), id: "b".repeat(64) };
        const body = remote ? await taskClientResponse(runtime, machine, client, envelope) : await launcherResponse(runtime, machine, true, envelope);
        const reply = JSON.parse(body), inner = frame.launcher && reply.ok ? JSON.parse(reply.result.body) : reply;
        replies.push({ command: request.command, ...structuredClone(inner) });
        if (request.command === "status" && flags.hideProblemCapability && inner.ok) {
          delete inner.result.managedChildProblem;
          if (frame.launcher) reply.result.body = JSON.stringify(inner);
        }
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
  return { root, runtime, parent, parentId, outer, flags, store, plans, requests, replies, draftsAtOpen, draftsAtCreate, client, machine, session, settle, faux: f.faux,
    close: async () => {
      // Lost ACKs still admitted real Pi tasks. Drain them before closing SQLite.
      for (const taskId of new Set(replies.filter(r => r.command === "open_managed_child" && r.ok).map(r => r.result.ack.taskId as string))) await settle(taskId);
      for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); await rm(root, { recursive: true, force: true }); },
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
    assert.equal(childMeta!.title, form.title);
    const creation = f.requests.find(r => r.command === "create_managed_child");
    assert.deepEqual(await f.runtime.harness.snapshot(ManagedChildRequest, creation.args.requestId, context), { hash: digest(["deck.managed-child-create.v1", f.parentId, form.title, { problem: form.problem, description: form.description }]), chatId: child.id });
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
    const capturedMeta = (await f.runtime.harness.snapshot(ChatDoc, (await f.runtime.chat(captured.chatId)).id, context))!;
    await f.runtime.harness.abortTask(Number(capturedMeta.ownerTaskId) as TaskId, context);
    await f.settle(capturedMeta.ownerTaskId!);
    const before = f.requests.length;
    await assert.rejects(parent.act("create", { taskForm: { title: "Spoof", managedParentChatId: mainId } }), /locked/);
    assert.equal(f.requests.length, before);
    for (const id of [String(other.id), String(foreign.id), captured.chatId]) await assert.rejects(parent.act("childOpen", { chatId: id }), /unconfirmed/);
    const inspected = await parent.act("subagent", { text: captured.name }); assert.equal(inspected.inspectParentChatId, f.parentId);
    const reads = f.requests.length;
    await assert.rejects(parent.act("create", { taskForm: { title: "Captured", managedParentChatId: captured.chatId } }), /Read-only/);
    await assert.rejects(parent.act("newChild", { text: "Captured chat must not become its own parent" }), /Read-only/);
    await assert.rejects(parent.act("childOpen", { chatId: String(foreign.id) }), /Read-only/);
    assert.equal(f.requests.length, reads);
    await parent.act("parent");
    const readOnly = new TuiSession(parent.command, f.parentId, f.runtime.hubId, join(f.root, "drafts"), 52800);
    await readOnly.handle({ version: 1, id: "read", action: "poll" });
    const readOnlyBefore = f.requests.length;
    await assert.rejects(readOnly.handle({ version: 1, id: "refuse", action: "newChild", text: "Selection alone grants no child creation" }), /Return to the hub/);
    assert.equal(f.requests.length, readOnlyBefore);
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

const NameCursor = defineDoc<{ next: number; order?: number[] }>({ kind: "deck.agent-name-cursor", version: 1, scope: "session", initial: () => ({ next: 0 }), checkpointWhen: () => true });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

for (const remote of [false, true]) for (const managed of [false, true]) test(`${remote ? "remote allocation" : "local attachment"} :new-child PROBLEM: ${managed ? "managed" : "ordinary"} selected parent, permanent wintermute title, exact own instructions and nested self-parent`, async () => {
  const f = await fixture(remote, managed);
  try {
    await f.runtime.configure(f.parentId, { thinkingLevel: "high", instructions: "PRIVATE PARENT INSTRUCTIONS" });
    const parent = await f.session(), before = await f.runtime.harness.snapshot(RexDoc, f.parent.id, context);
    const meta = await f.runtime.harness.snapshot(ChatDoc, f.parent.id, context), agent = await f.runtime.harness.snapshot(AgentDoc, f.parent.id, context);
    const parentAgent = await f.parent.agent(context), cursor = (await f.runtime.harness.snapshot(NameCursor, context))!;
    const problem = " \tOwn problem 日本語 🧪\nKeep leading and trailing whitespace  \n";
    const created = await parent.act("newChild", { text: problem });
    assert.equal(created.chatId, f.parentId); assert.equal(created.draft, null); assert.match(created.notice, /Child \d+ created\. Child TUI opening/);
    const opened = f.replies.find(r => r.command === "open_managed_child"); assert.equal(opened.ok, true); await f.settle(opened.result.ack.taskId);
    const childId = opened.result.childId, child = await f.runtime.chat(childId), saved = (await f.runtime.harness.snapshot(ChatDoc, child.id, context))!;
    assert.equal(saved.title, saved.agentName); assert.equal(saved.agentNameAlgorithm, "wintermute-v1");
    assert.equal(saved.agentName, agentNameAlgorithms["wintermute-v1"]!.candidate(cursor.order![cursor.next]!));
    assert.equal(await lookupAgentName(f.runtime.harness, saved.title, context), child.id);
    assert.equal(saved.managedParentChatId, f.parentId); assert.equal(saved.machineId, meta!.machineId); assert.equal(saved.cwd, meta!.cwd);
    assert.deepEqual(saved.brief, { problem, description: "" });
    assert.equal((await f.runtime.harness.commit(tx => tx.conversation(child.id), context))!.owner, undefined);
    const childAgent = await child.agent(context);
    assert.equal(childAgent.instructions, briefInstructions(saved.title, { problem, description: "" }));
    assert.doesNotMatch(childAgent.instructions!, /PRIVATE PARENT/);
    assert.equal((await f.runtime.harness.snapshot(AgentDoc, child.id, context))!.instructions, childAgent.instructions);
    assert.deepEqual(childAgent.model, parentAgent.model); assert.equal(childAgent.thinkingLevel, "high"); assert.equal(childAgent.cwd, parentAgent.cwd);
    for (const kind of ["tools", "callable", "deferred", "extensions"] as const) assert.deepEqual(childAgent[kind].map(t => t.name), parentAgent[kind].map(t => t.name));
    const request = f.requests.find(r => r.command === "create_managed_child");
    assert.deepEqual(request.args, { requestId: request.args.requestId, parentChatId: f.parentId, problem, description: "" });
    assert.deepEqual(f.draftsAtCreate[0]!.map((s: any) => s.request), [{ kind: "task", chatId: f.parentId, requestId: request.args.requestId, managedParentChatId: f.parentId, problem, description: "" }]);
    assert.deepEqual(await f.runtime.harness.snapshot(ManagedChildRequest, request.args.requestId, context), { hash: digest(["deck.managed-child-create.problem.v1", f.parentId, { problem, description: "" }]), chatId: child.id });
    assert.equal(f.plans[1]!.sessionId, before!.binding!.sessionId); assert.equal((await f.runtime.terminalStatus(childId)).binding!.cwd, meta!.cwd);
    assert.equal(f.plans[1]!.workerSocket, remote ? f.client.socket : undefined);
    const nested = await f.session(childId), nestedProblem = "\u3000Nested independent instructions\n  ";
    const grandchild = await nested.act("newChild", { text: nestedProblem }); assert.equal(grandchild.chatId, childId);
    const last = f.replies.filter(r => r.command === "open_managed_child").at(-1)!; await f.settle(last.result.ack.taskId);
    const grand = await f.runtime.chat(last.result.childId), grandMeta = (await f.runtime.harness.snapshot(ChatDoc, grand.id, context))!;
    assert.equal(grandMeta.managedParentChatId, childId); assert.equal(grandMeta.title, grandMeta.agentName); assert.equal(grandMeta.agentNameAlgorithm, "wintermute-v1");
    assert.equal((await grand.agent(context)).instructions, briefInstructions(grandMeta.title, { problem: nestedProblem, description: "" }));
    assert.deepEqual(f.requests.filter(r => r.command === "create_managed_child").map(r => r.args.parentChatId), [f.parentId, childId]);
    assert.deepEqual(f.requests.filter(r => r.command === "open_managed_child").map(r => r.args.chatId), [f.parentId, childId]);
    assert.equal(f.plans[2]!.sessionId, before!.binding!.sessionId); assert.notEqual(f.plans[2]!.allocationId, f.plans[1]!.allocationId);
    assert.equal((await f.runtime.harness.snapshot(NameCursor, context))!.next, cursor.next + 2);
    assert.deepEqual(await f.runtime.harness.snapshot(RexDoc, f.parent.id, context), before);
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, f.parent.id, context), meta);
    assert.deepEqual(await f.runtime.harness.snapshot(AgentDoc, f.parent.id, context), agent);
    for (let i = 0; i < 3; i++) assert.equal((await parent.act("poll")).chatId, f.parentId);
    assert.deepEqual(f.draftsAtOpen, [[], []]); assert.deepEqual(await f.store.list(), []);
    assert.ok(!f.requests.some(r => ["rex_open", "admit", "create_task", "create_task_brief", "import_instructions"].includes(r.command)));
    for (const id of [f.parentId, childId, last.result.childId]) { assert.deepEqual((await f.runtime.history(id)).items, []); assert.equal((await f.runtime.activity(id)).busy, false); }
    assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});

for (const remote of [false, true]) for (const malformed of [false, true]) test(`${remote ? "remote" : "local"} :new-child ${malformed ? "malformed" : "lost"} creation ACK: restart/retry preserves auto identity, brief, bytes, child and permanent claim`, async () => {
  const f = await fixture(remote, true); f.flags.loseCreateOnce = !malformed; f.flags.malformedCreateOnce = malformed;
  try {
    const parent = await f.session(), problem = "  Exact 日本語 🧪\n  ", cursor = (await f.runtime.harness.snapshot(NameCursor, context))!;
    const chats = (await f.runtime.listChats()).items.length;
    await assert.rejects(parent.act("newChild", { text: problem }));
    const summary = (await f.store.list())[0]!, path = join(f.store.directory, `${summary.requestId}.json`), bytes = await readFile(path);
    const expected = { kind: "task", chatId: f.parentId, requestId: summary.requestId, managedParentChatId: f.parentId, problem, description: "" };
    assert.deepEqual((await f.store.load(summary.requestId)).request, expected);
    assert.equal(Object.hasOwn(JSON.parse(bytes.toString()).request, "title"), false);
    const receipt = (await f.runtime.harness.snapshot(ManagedChildRequest, summary.requestId, context))!;
    const child = await f.runtime.chat(String(receipt.chatId)), saved = await f.runtime.harness.snapshot(ChatDoc, child.id, context), agent = await f.runtime.harness.snapshot(AgentDoc, child.id, context);
    assert.equal(saved!.title, saved!.agentName); assert.equal(saved!.agentNameAlgorithm, "wintermute-v1");
    const allocated = await f.runtime.harness.snapshot(NameCursor, context); assert.equal(allocated!.next, cursor.next + 1);
    const recovered = await f.session();
    for (let i = 0; i < 3; i++) assert.equal((await recovered.act("poll")).draft!.requestId, summary.requestId);
    await assert.rejects(recovered.act("newChild", { text: "Must not replace the saved problem" }), /Resolve saved/);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 1); assert.equal(f.plans.length, 1);
    // A second uncertain replay must leave the *original file*, including its timestamp, untouched.
    f.flags.loseCreateOnce = true; await assert.rejects(recovered.act("retry")); assert.deepEqual(await readFile(path), bytes);
    const created = await recovered.act("retry"); assert.equal(created.chatId, f.parentId); assert.equal(created.draft, null);
    const requests = f.requests.filter(r => r.command === "create_managed_child"); assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(r => r.args), Array(3).fill({ requestId: summary.requestId, parentChatId: f.parentId, problem, description: "" }));
    assert.deepEqual(f.draftsAtCreate.map(ds => ds.map((s: any) => s.request)), Array(3).fill([expected]));
    const open = f.replies.find(r => r.command === "open_managed_child"); assert.equal(open.result.childId, String(child.id)); await f.settle(open.result.ack.taskId);
    assert.equal((await f.runtime.listChats()).items.length, chats + 1);
    assert.deepEqual(await f.runtime.harness.snapshot(NameCursor, context), allocated);
    assert.deepEqual(await f.runtime.harness.snapshot(ManagedChildRequest, summary.requestId, context), receipt);
    assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, child.id, context), saved);
    assert.deepEqual(await f.runtime.harness.snapshot(AgentDoc, child.id, context), agent);
    assert.equal(await lookupAgentName(f.runtime.harness, saved!.title, context), child.id);
    assert.equal(f.requests.filter(r => r.command === "rex_status").length, 1, "retry is not a new-form preflight");
    assert.deepEqual(f.draftsAtOpen, [[]]); assert.deepEqual(await f.store.list(), []); assert.equal(f.plans.length, 2); assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});

for (const remote of [false, true]) test(`${remote ? "remote" : "local"} :new-child lost open ACK clears creation draft; only explicit :child-open recovers, never recreation`, async () => {
  const f = await fixture(remote); f.flags.loseOpenOnce = true;
  try {
    const parent = await f.session(), created = await parent.act("newChild", { text: "An independently named child" });
    assert.equal(created.chatId, f.parentId); assert.equal(created.draft, null); assert.match(created.notice, /created; same-session Rex open unconfirmed/);
    const open = f.replies.find(r => r.command === "open_managed_child"); await f.settle(open.result.ack.taskId);
    const cursor = await f.runtime.harness.snapshot(NameCursor, context), recovered = await f.session();
    for (let i = 0; i < 3; i++) assert.equal((await recovered.act("poll")).draft, null);
    await assert.rejects(recovered.act("retry"), /No pending draft/);
    assert.equal(f.requests.filter(r => r.command === "open_managed_child").length, 1);
    const opened = await recovered.act("childOpen", { chatId: open.result.childId }); assert.equal(opened.chatId, f.parentId); assert.match(opened.notice, /TUI reused/);
    const opens = f.requests.filter(r => r.command === "open_managed_child"); assert.equal(opens.length, 2); assert.notEqual(opens[0].args.requestId, opens[1].args.requestId);
    assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 1);
    assert.deepEqual(await f.runtime.harness.snapshot(NameCursor, context), cursor); assert.equal(f.plans.length, 2);
    assert.deepEqual(await f.store.list(), []); assert.deepEqual(f.draftsAtOpen, [[], []]);
    assert.ok(!f.requests.some(r => ["admit", "rex_open"].includes(r.command))); assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});

for (const remote of [false, true]) test(`${remote ? "remote" : "local"} :new-child missing capability refuses before draft and cannot clear a recovered auto draft`, async () => {
  const f = await fixture(remote); f.flags.hideProblemCapability = true;
  try {
    const parent = await f.session(), cursor = await f.runtime.harness.snapshot(NameCursor, context), count = (await f.runtime.listChats()).items.length;
    await assert.rejects(parent.act("newChild", { text: "Requires a capable hub" }), TuiRequestNotSent);
    assert.equal((await parent.act("poll")).draft, null); assert.deepEqual(await f.store.list(), []);
    const draft = { kind: "task" as const, chatId: f.parentId, requestId: randomUUID(), managedParentChatId: f.parentId, problem: "  Saved before upgrade  ", description: "" as const };
    await f.store.save(draft); const path = join(f.store.directory, `${draft.requestId}.json`), bytes = await readFile(path);
    const recovered = await f.session();
    await assert.rejects(recovered.act("newChild", { text: "Do not replace" }), error => error instanceof Error && !(error instanceof TuiRequestNotSent));
    await assert.rejects(recovered.act("retry"), /saved request unchanged/);
    assert.equal((await recovered.act("poll")).draft!.requestId, draft.requestId); assert.deepEqual(await readFile(path), bytes);
    assert.equal((await f.runtime.listChats()).items.length, count); assert.deepEqual(await f.runtime.harness.snapshot(NameCursor, context), cursor);
    assert.ok(!f.requests.some(r => ["rex_status", "create_managed_child", "open_managed_child", "rex_open", "admit"].includes(r.command)));
  } finally { await f.close(); }
});

test(":new-child unallocated attachment refuses before saving; an existing pending draft is not dismissed", async () => {
  const f = await fixture(false, false, false);
  try {
    const parent = await f.session(), before = await f.runtime.harness.snapshot(NameCursor, context);
    await assert.rejects(parent.act("newChild", { text: "No parent terminal" }), error => error instanceof TuiRequestNotSent && /Parent has no confirmed Rex allocation/.test(error.message));
    assert.equal((await parent.act("poll")).draft, null); assert.deepEqual(await f.store.list(), []);
    const draft = { kind: "task" as const, chatId: f.parentId, requestId: randomUUID(), managedParentChatId: f.parentId, problem: "Original unresolved child", description: "" as const };
    await f.store.save(draft); const path = join(f.store.directory, `${draft.requestId}.json`), bytes = await readFile(path), recovered = await f.session();
    await assert.rejects(recovered.act("newChild", { text: "Do not dismiss original" }), error => error instanceof Error && !(error instanceof TuiRequestNotSent) && /Resolve saved/.test(error.message));
    assert.deepEqual(await readFile(path), bytes); assert.equal((await recovered.act("poll")).draft!.requestId, draft.requestId);
    assert.deepEqual(await f.runtime.harness.snapshot(NameCursor, context), before); assert.deepEqual(f.plans, []);
    assert.ok(!f.requests.some(r => r.command.startsWith("create_") || ["open_managed_child", "rex_open", "admit"].includes(r.command)));
  } finally { await f.close(); }
});

test(":new-child accepts only text: nonblank well-formed Unicode, bounded by UTF-8 bytes, no form/target/authority overrides", async () => {
  const base = { version: 1, id: "validation", action: "newChild", text: "  exact problem 日本語  " };
  for (const text of [base.text, "x".repeat(2048), "🧪".repeat(512), "\u3000x\ufeff"]) assert.equal(validRequest({ ...base, text }), true);
  for (const text of [undefined, null, 1, "", " \t\r\n\u3000\ufeff\u00a0", "x".repeat(2049), "🧪".repeat(512) + "x", "\ud800", "x\udfff"]) assert.equal(validRequest({ ...base, text }), false);
  const mixed = [{ taskForm: { title: "Forged", managedParentChatId: "2" } }, { taskTarget: { title: "Forged", machineId: "a", cwd: "/" } },
    ...["chatId", "managedParentChatId", "parentChatId", "host", "hostId", "machineId", "cwd", "title", "description", "hubId", "requestId", "before", "after", "entryId"].map(key => ({ [key]: "2" })),
    { hold: true }, { offset: 0 }, { configuration: { expected: {}, selection: {} } }];
  for (const extra of mixed) assert.equal(validRequest({ ...base, ...extra }), false, JSON.stringify(extra));
  const f = await fixture(false);
  try {
    const parent = await f.session(), before = f.requests.length;
    for (const extra of mixed) await assert.rejects(parent.tui.handle({ ...base, ...extra } as TuiRequest), /Invalid renderer request/);
    assert.equal(f.requests.length, before); assert.deepEqual(await f.store.list(), []);
    const boundary = "🧪".repeat(512); await parent.act("newChild", { text: boundary });
    const ack = f.replies.find(r => r.command === "open_managed_child"); await f.settle(ack.result.ack.taskId);
    const child = await f.runtime.chat(ack.result.childId);
    assert.deepEqual((await f.runtime.harness.snapshot(ChatDoc, child.id, context))!.brief, { problem: boundary, description: "" });
  } finally { await f.close(); }
});

for (const missingCapability of [false, true]) test(`framed bridge :new-child ${missingCapability ? "missing capability" : "unallocated parent"} returns notSent:true, but never for an existing unresolved draft`, { timeout: 15_000 }, async () => {
  const f = await fixture(false, false, missingCapability); f.flags.hideProblemCapability = missingCapability;
  const start = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./tui-bridge.js", import.meta.url)), "--task", f.parentId, "--hub-id", f.runtime.hubId,
      "--attach-machine", f.machine, "--worker-socket", f.client.socket, "--client-state", join(f.root, "drafts")]);
    const decoder = child.stdout.pipe(new FrameDecoder()); let errors = ""; child.stderr.on("data", data => { errors += data; });
    return { child, request: async (action: TuiRequest["action"], text?: string) => {
      const reply = once(decoder, "data"); child.stdin.write(encodeFrame({ version: 1, id: randomUUID(), action, ...(text === undefined ? {} : { text }) }));
      return (await reply)[0];
    }, close: async () => { const closed = once(child, "close"); child.stdin.end(); assert.equal((await closed)[0], 0, errors); } };
  };
  let bridge: ReturnType<typeof start> | undefined;
  try {
    bridge = start(); assert.equal((await bridge.request("poll")).ok, true);
    const refused = await bridge.request("newChild", "Do not reserve an identity"); assert.equal(refused.ok, false); assert.equal(refused.notSent, true);
    assert.deepEqual(await f.store.list(), []); await bridge.close(); bridge = undefined;
    const draft = { kind: "task" as const, chatId: f.parentId, requestId: randomUUID(), managedParentChatId: f.parentId, problem: "Retained auto request", description: "" as const };
    await f.store.save(draft); const path = join(f.store.directory, `${draft.requestId}.json`), bytes = await readFile(path);
    bridge = start(); assert.equal((await bridge.request("poll")).snapshot.draft.requestId, draft.requestId);
    const retained = await bridge.request("newChild", "Do not replace retained request"); assert.equal(retained.ok, false); assert.equal(Object.hasOwn(retained, "notSent"), false);
    assert.deepEqual(await readFile(path), bytes);
    assert.ok(!f.requests.some(r => r.command.startsWith("create_") || ["open_managed_child", "rex_open", "admit"].includes(r.command)));
    await bridge.close(); bridge = undefined;
  } finally { if (bridge) { const closed = once(bridge.child, "close"); bridge.child.kill(); await closed; } await f.close(); }
});

test("plain allocation client resumes a TUI auto draft with /retry through framed guards, reusing its child/name and exact title-absent request", { timeout: 15_000 }, async () => {
  const f = await fixture(true, true); f.flags.loseCreateOnce = true;
  let processChild: ReturnType<typeof spawn> | undefined;
  try {
    const parent = await f.session(), problem = "  TUI problem to plain recovery 日本語\n  ";
    await assert.rejects(parent.act("newChild", { text: problem }));
    const draft = (await f.store.list())[0]!, receipt = (await f.runtime.harness.snapshot(ManagedChildRequest, draft.requestId, context))!;
    const child = await f.runtime.chat(String(receipt.chatId)), saved = await f.runtime.harness.snapshot(ChatDoc, child.id, context), cursor = await f.runtime.harness.snapshot(NameCursor, context);
    const allocation = (await f.runtime.harness.snapshot(RexDoc, f.parent.id, context))!;
    processChild = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--no-tui", "--task", f.parentId, "--hub-id", f.runtime.hubId,
      "--rex-allocation", allocation.allocationId!, "--worker-socket", f.client.socket], { env: { ...process.env, REX_BLOCK: allocation.binding!.blockId, DECK_CLIENT_STATE_DIRECTORY: join(f.root, "drafts") } });
    let output = "", errors = ""; processChild.stdout!.on("data", data => { output += data; }); processChild.stderr!.on("data", data => { errors += data; });
    const closed = once(processChild, "close"); processChild.stdin!.end("/draft\n/retry\n/exit\n"); assert.equal((await closed)[0], 0, errors);
    assert.match(output, /Recovered task draft/); assert.match(output, /Parent chat remains selected/); assert.equal(errors, "");
    const creates = f.requests.filter(r => r.command === "create_managed_child"); assert.equal(creates.length, 2); assert.deepEqual(creates[1].args, creates[0].args);
    assert.deepEqual(creates[1].args, { requestId: draft.requestId, parentChatId: f.parentId, problem, description: "" });
    const open = f.replies.find(r => r.command === "open_managed_child"); await f.settle(open.result.ack.taskId); assert.equal(open.result.childId, String(child.id));
    assert.deepEqual(await f.runtime.harness.snapshot(NameCursor, context), cursor); assert.deepEqual(await f.runtime.harness.snapshot(ChatDoc, child.id, context), saved);
    assert.deepEqual(await f.store.list(), []); assert.deepEqual(f.draftsAtOpen, [[]]); assert.equal(f.plans.length, 2); assert.equal(f.faux.state.callCount, 0);
    assert.ok(!f.requests.some(r => ["admit", "rex_open", "create_task", "create_task_brief"].includes(r.command)));
  } finally { if (processChild && processChild.exitCode === null && processChild.signalCode === null) { const closed = once(processChild, "close"); processChild.kill(); await closed; } await f.close(); }
});

for (const remote of [false, true]) test(`${remote ? "remote" : "local"} new-child checks changed capabilities before reserving a fresh identity`, async () => {
  const f = await fixture(remote);
  try {
    const parent = await f.session(), cursor = await f.runtime.harness.snapshot(NameCursor, context);
    f.flags.hideProblemCapability = true;
    await assert.rejects(parent.act("newChild", { text: "Hub capability removed after attachment" }), TuiRequestNotSent);
    assert.deepEqual(await f.store.list(), []);
    assert.deepEqual(await f.runtime.harness.snapshot(NameCursor, context), cursor);
    assert.ok(!f.requests.some(r => ["rex_status", "create_managed_child", "open_managed_child"].includes(r.command)));
    // Updating the same pinned hub is enough: no detach/reselection required.
    f.flags.hideProblemCapability = false;
    const result = await parent.act("newChild", { text: "Hub upgraded while attached" });
    assert.equal(result.draft, null); assert.equal(result.chatId, f.parentId);
    const open = f.replies.find(r => r.command === "open_managed_child"); await f.settle(open.result.ack.taskId);
    assert.equal(f.requests.filter(r => r.command === "create_managed_child").length, 1);
    assert.equal((await f.runtime.harness.snapshot(ChatDoc, (await f.runtime.chat(open.result.childId)).id, context))!.brief!.problem, "Hub upgraded while attached");
    assert.deepEqual(await f.store.list(), []); assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});
