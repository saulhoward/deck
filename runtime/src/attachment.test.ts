import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, defineTask } from "@earendil-works/pi-durable";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { model, provider, IMPLEMENTATION, gate, within } from "./instructions.test.support.js";
import { launcherResponse } from "./launcher-hub.js";
import { validLaunchRequest, validLaunchResponse } from "./launcher-contracts.js";
import { attachedCommand } from "./attached-client.js";
import { TuiSession } from "./tui-session.js";
import { DraftStore } from "./drafts.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { validLauncherTaskReply, type LauncherRequest, type TaskRelayFrame } from "./generated/contracts.js";
const machine = "b".repeat(32);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deck-attach-")), { models } = provider();
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, implementation: IMPLEMENTATION, binding: { machineId: "a".repeat(32), cwd: root }, environment: () => undefined });
  const chat = await runtime.createTask("Attached", { machineId: machine, cwd: "/saved workspace" });
  const chatId = String(chat.id), target = { hubId: runtime.hubId, machineId: machine, socket: join(root, "client.sock") };
  const request = (command = "status", args: object = { chatId }, id = chatId): LauncherRequest => ({ version: 1, id: randomUUID(), command: "launch_task", args: { chatId: id, body: JSON.stringify({ version: 1, id: randomUUID(), command, args, hubId: runtime.hubId }) } });
  const envelope = (request: LauncherRequest): TaskRelayFrame => ({ connectionId: "a".repeat(64), id: "b".repeat(64), launcher: { hubId: runtime.hubId }, body: JSON.stringify(request) });
  const send = async (r: LauncherRequest, approved = true, worker = machine) => JSON.parse(await launcherResponse(runtime, worker, approved, envelope(r)));
  return { root, runtime, chat, chatId, target, request, envelope, send, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
test("attachment has distinct launcher authority, validates inner scope, and never acquires terminal authority", async () => {
  const f = await fixture();
  try {
    const request = f.request(), response = await f.send(request);
    assert.ok(validLaunchResponse(response, request, f.runtime.hubId, machine)); assert.ok(response.ok);
    const result = response.result; assert.ok(validLauncherTaskReply(result));
    const status = JSON.parse(result.body).result;
    assert.equal(status.chatId, f.chatId); assert.equal(status.binding.cwd, "/saved workspace"); assert.equal(status.inspection, undefined);
    assert.equal((await f.runtime.terminalStatus(f.chatId)).status, "unallocated");
    assert.equal((await f.send(request, false)).ok, false);
    assert.equal((await f.send(request, true, "c".repeat(32))).ok, false);
    for (const command of ["rex_open", "rex_startup", "create_task", "list_chats", "login_start", "set_tool_profiles", "send_agent_message"]) assert.equal(validLaunchRequest(f.request(command)), false, command);
    assert.equal(validLaunchRequest(f.request("status", { chatId: "1" })), false);
    assert.equal(validLaunchRequest(f.request("history", { chatId: f.chatId, limit: 100000 })), false);
    assert.equal(validLaunchRequest(f.request("status", {})), false);
    assert.equal(validLaunchResponse({ ...response, result: { ...result, machineId: "c".repeat(32) } }, request, f.runtime.hubId, machine), false);
    const inner = JSON.parse(result.body); inner.id = randomUUID();
    assert.equal(validLaunchResponse({ ...response, result: { ...result, body: JSON.stringify(inner) } }, request, f.runtime.hubId, machine), false);
    assert.equal((await f.send(f.request("stop", { chatId: f.chatId }))).ok, true);
    assert.equal((await f.runtime.terminalStatus(f.chatId)).status, "unallocated");
  } finally { await f.close(); }
});
test("attachment refuses main, other workers, owned tasks, missing tasks and changed agent cwd", async () => {
  const f = await fixture();
  try {
    const other = await f.runtime.createTask("Other", { machineId: "c".repeat(32), cwd: "/other" });
    const parked = defineTask<{}, { phase: "hold" }, null>({ name: "test.attach-owner", version: 1, initial: () => ({ phase: "hold" }), phases: { hold: async () => {} }, abort: async () => {} });
    const owned = await f.runtime.main.commit(async tx => {
      const owner = await tx.createTask(parked, {}, { ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
      Object.assign(await tx.doc(ChatDoc, child.id), { kind: "task", title: "Not independent", machineId: machine, cwd: "/saved workspace" });
      (await tx.doc(AgentDoc, child.id)).cwd = "/saved workspace"; return String(child.id);
    }, context);
    for (const id of [String(f.runtime.main.id), String(other.id), owned, "999999"]) {
      for (const command of ["status", "stop"]) assert.equal((await f.send(f.request(command, { chatId: id }, id))).ok, false);
    }
    await f.chat.commit(async tx => { (await tx.doc(AgentDoc, f.chat.id)).cwd = "/different"; }, context);
    assert.equal((await f.send(f.request())).ok, false);
  } finally { await f.close(); }
});
test("attachment rechecks canonical binding at serialized mutation admission and response release", async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try {
    const original = f.runtime.admit.bind(f.runtime);
    f.runtime.admit = async (...args) => { entered.release(); await release.promise; return original(...args); };
    const pending = f.send(f.request("admit", { chatId: f.chatId, requestId: randomUUID(), text: "must not be admitted", mode: "followUp" }));
    await within(entered.promise);
    await f.chat.commit(async tx => { (await tx.doc(ChatDoc, f.chat.id)).machineId = "c".repeat(32); }, context);
    release.release(); assert.equal((await pending).ok, false);
    assert.equal((await f.runtime.history(f.chatId)).items.filter(e => e.kind === "deck.input").length, 0);
  } finally { release.release(); await f.close(); }
});
test("attachment suppresses data after a binding change and respects live-upgrade admission fences", async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try {
    const transition = randomUUID(); await f.runtime.pauseWorker(machine, transition);
    const blocked = await f.send(f.request("admit", { chatId: f.chatId, requestId: randomUUID(), text: "not admitted while paused", mode: "followUp" }));
    assert.ok(blocked.ok); assert.equal(JSON.parse(blocked.result.body).error.code, "busy");
    assert.equal((await f.runtime.history(f.chatId)).items.filter(e => e.kind === "deck.input").length, 0);
    await f.runtime.resumeWorker(machine, transition);
    const original = f.runtime.history.bind(f.runtime);
    f.runtime.history = async (...args) => { const page = await original(...args); entered.release(); await release.promise; return page; };
    const pending = f.send(f.request("history", { chatId: f.chatId })); await within(entered.promise);
    await f.chat.commit(async tx => { (await tx.doc(ChatDoc, f.chat.id)).machineId = "c".repeat(32); }, context);
    release.release(); const refused = await pending; assert.equal(refused.ok, false); assert.equal(refused.result, undefined);
  } finally { release.release(); await f.close(); }
});
test("current-terminal TUI over real launcher framing retains post-commit lost ACK, never auto-retries or opens Rex", async () => {
  const f = await fixture(), peers = new Set<Socket>(), requests: any[] = []; let drop = true;
  const server = createServer(socket => {
    peers.add(socket); socket.on("error", () => {}); socket.on("close", () => peers.delete(socket));
    socket.pipe(new FrameDecoder()).on("data", (frame: TaskRelayFrame) => {
      const outer = JSON.parse(frame.body), inner = JSON.parse(outer.args.body); requests.push(inner);
      void launcherResponse(f.runtime, machine, true, { ...frame, connectionId: "a".repeat(64), id: "b".repeat(64) }).then(body => {
        if (drop && inner.command === "admit") { drop = false; socket.destroy(); return; }
        socket.end(encodeFrame(JSON.parse(body)));
      }).catch(() => socket.destroy());
    }).on("error", () => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(f.target.socket, resolve)); await chmod(f.target.socket, 0o600);
  const session = new TuiSession((command, args, hubId) => attachedCommand(f.target, f.chatId, command, args, hubId), f.chatId, f.runtime.hubId, join(f.root, "drafts"));
  const action = (action: "poll" | "send" | "retry", text?: string) => session.handle({ version: 1, id: randomUUID(), action, ...(text === undefined ? {} : { text }) });
  try {
    await session.registerAttachment(machine);
    assert.equal((await action("poll")).clientMode, "task");
    const text = "Exact attached input 日本語\n  preserved";
    await assert.rejects(action("send", text), /unconfirmed/);
    const store = new DraftStore(f.runtime.hubId, join(f.root, "drafts")), draft = (await store.list())[0]!;
    const path = join(store.directory, `${draft.requestId}.json`), bytes = await readFile(path);
    await action("poll"); assert.equal(requests.filter(r => r.command === "admit").length, 1); assert.deepEqual(await readFile(path), bytes);
    assert.equal((await action("retry")).draft, null); assert.deepEqual(await store.list(), []);
    const admissions = requests.filter(r => r.command === "admit"); assert.equal(admissions.length, 2); assert.deepEqual(admissions[0].args, admissions[1].args);
    assert.equal((await f.runtime.history(f.chatId)).items.filter(e => e.kind === "deck.input").length, 1);
    assert.equal((await f.runtime.terminalStatus(f.chatId)).status, "unallocated");
    await assert.rejects(session.handle({ version: 1, id: "nav", action: "select", chatId: String(f.runtime.main.id) }), /locked/);
    assert.equal(requests.some(r => ["rex_startup", "rex_open", "create_task"].includes(r.command)), false);
  } finally { for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
