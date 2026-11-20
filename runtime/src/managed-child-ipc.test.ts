import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ChatDoc, type DeckRuntime } from "./deck.js";
import { dispatch, serveIpc } from "./ipc.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { responseResult } from "./responses.js";
import { RexDoc } from "./rex-allocation.js";
import { launcherResponse } from "./launcher-hub.js";
import { validLaunchResponse } from "./launcher-contracts.js";
import { setup } from "./managed-child.test.support.js";
import { within } from "./instructions.test.support.js";
import { validLauncherList, type CreateManagedChildAck, type LauncherRequest, type ResponseEnvelope, type StatusSnapshot, type ChatListPage } from "./generated/contracts.js";

const machine = "b".repeat(32), binding = { machineId: machine, cwd: "/assigned workspace 日本語" };
function ipc(runtime: DeckRuntime) {
  const input = new PassThrough(), output = new PassThrough(), decoder = output.pipe(new FrameDecoder());
  const frames = decoder[Symbol.asyncIterator](), serving = serveIpc(runtime, input, output);
  return {
    async call(command: string, args: unknown = {}, identity: { hubId?: unknown } = { hubId: runtime.hubId }) {
      const request = { version: 1 as const, id: randomUUID(), command, args, ...identity };
      input.write(encodeFrame(request));
      const frame = await within(frames.next()); assert.equal(frame.done, false);
      const reply = frame.value as ResponseEnvelope;
      assert.equal(reply.id, request.id);
      if (reply.ok) responseResult(reply, request.id, request); // Validate the actual serialized ACK, not just dispatch's object.
      return reply;
    },
    async close() { input.end(); await serving; decoder.destroy(); output.destroy(); },
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deck-managed-ipc-")), path = join(root, "pi.sqlite");
  const effects: string[] = [];
  const f = setup({ hostFiles: { call: async (_binding, _id, operation) => { effects.push(operation); throw new Error("Unexpected native operation"); } } });
  let runtime = await f.open(path), channel = ipc(runtime);
  return { effects, faux: f.faux, get runtime() { return runtime; }, get channel() { return channel; },
    async reopen() { await channel.close(); await runtime.close(); runtime = await f.open(path); channel = ipc(runtime); },
    async close() { await channel.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); },
  };
}
function result<T>(reply: ResponseEnvelope): T { assert.ok(reply.ok, JSON.stringify(reply)); return reply.result as T; }

test("managed child IPC creates only an idle ownerless task and projects exact brief/parent metadata through discovery", async t => {
  const f = await fixture();
  try {
    const parent = await f.runtime.createTask("Parent", binding), parentChatId = String(parent.id);
    const create = t.mock.method(f.runtime, "createManagedChild"), admit = t.mock.method(f.runtime, "admit"), rex = t.mock.method(f.runtime, "openTerminal");
    const root = result<StatusSnapshot>(await f.channel.call("status")); assert.equal(root.managedChildren, 1);
    const brief = { problem: "  Exact problem 🧪\nsecond line  ", description: "Description\r\n  retained 日本語 " };
    const args = { requestId: randomUUID(), parentChatId, title: "  Child 日本語  ", ...brief };
    const ack = result<CreateManagedChildAck>(await f.channel.call("create_managed_child", args));
    assert.deepEqual(ack, { chatId: ack.chatId, parentChatId, brief });
    assert.ok(Number(ack.chatId) > Number(parentChatId));
    assert.equal(create.mock.callCount(), 1); assert.deepEqual(create.mock.calls[0]!.arguments, [parentChatId, args.title, args.requestId, brief]);
    const child = await f.runtime.chat(ack.chatId), saved = (await f.runtime.harness.snapshot(ChatDoc, child.id, context))!;
    assert.equal(saved.kind, "task"); assert.equal(saved.managedParentChatId, parentChatId);
    assert.equal(saved.parentChatId, undefined); assert.equal(saved.ownerTaskId, undefined);
    assert.deepEqual(saved.brief, brief); assert.equal(saved.title, args.title);
    assert.equal((await f.runtime.harness.commit(tx => tx.conversation(child.id), context))!.owner, undefined);
    const status = result<StatusSnapshot>(await f.channel.call("status", { chatId: ack.chatId }));
    assert.equal(status.binding!.managedParentChatId, parentChatId); assert.equal(status.binding!.kind, "task");
    assert.equal(status.binding!.machineId, binding.machineId); assert.equal(status.binding!.cwd, binding.cwd);
    assert.deepEqual(status.binding!.brief, brief); assert.equal(status.binding!.parentChatId, undefined); assert.equal(status.binding!.ownerTaskId, undefined);
    const page = result<ChatListPage>(await f.channel.call("list_chats"));
    const row = page.items.find(item => item.chatId === ack.chatId)!; assert.ok(row);
    assert.deepEqual(row, { ...status.binding, chatId: ack.chatId });
    const request: LauncherRequest = { version: 1, id: randomUUID(), command: "launch_list", args: {} };
    const list = JSON.parse(await launcherResponse(f.runtime, machine, true, { connectionId: "a".repeat(64), id: "b".repeat(64), launcher: { hubId: f.runtime.hubId }, body: JSON.stringify(request) }));
    assert.ok(validLaunchResponse(list, request, f.runtime.hubId, machine)); assert.ok(list.ok); assert.ok(validLauncherList(list.result));
    const launched = list.result.items.find((item: { chatId: string }) => item.chatId === ack.chatId);
    assert.ok(launched); assert.equal(launched.managedParentChatId, parentChatId); assert.equal(launched.title, args.title); assert.equal(launched.cwd, binding.cwd);
    assert.equal(Object.hasOwn(launched, "parentChatId"), false); assert.equal(Object.hasOwn(launched, "ownerTaskId"), false);
    for (const id of [parentChatId, ack.chatId]) {
      assert.deepEqual((await f.runtime.history(id)).items, []);
      assert.equal((await f.runtime.activity(id)).busy, false);
      assert.equal((await f.runtime.terminalStatus(id)).status, "unallocated");
    }
    assert.equal(await f.runtime.harness.snapshot(RexDoc, child.id, context), undefined);
    assert.equal(admit.mock.callCount(), 0); assert.equal(rex.mock.callCount(), 0);
    assert.equal(f.faux.state.callCount, 0); assert.deepEqual(f.effects, []);
  } finally { await f.close(); }
});

test("managed child dispatch rejects unpinned, task-client and non-closed creation requests before runtime admission", async t => {
  const f = await fixture();
  try {
    const args = { requestId: randomUUID(), parentChatId: String(f.runtime.main.id), title: "Not created" };
    const create = t.mock.method(f.runtime, "createManagedChild");
    for (const [identity, code] of [[{}, "invalid"], [{ hubId: "another-hub" }, "conflict"], [{ hubId: "" }, "invalid"]] as const) {
      const reply = await f.channel.call("create_managed_child", args, identity); assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.error.code, code);
    }
    for (const invalid of [
      {}, { ...args, parentChatId: "0" }, { ...args, parentChatId: "9007199254740992" }, { ...args, title: " " },
      { ...args, machineId: machine }, { ...args, cwd: binding.cwd }, { ...args, chatId: args.parentChatId },
      { ...args, text: "must not submit" }, { ...args, brief: { problem: "nested" } }, { ...args, problem: null },
    ]) {
      const reply = await f.channel.call("create_managed_child", invalid); assert.equal(reply.ok, false, JSON.stringify(invalid)); if (!reply.ok) assert.equal(reply.error.code, "invalid");
    }
    await assert.rejects(dispatch(f.runtime, { version: 1, id: randomUUID(), command: "create_managed_child", args, hubId: f.runtime.hubId }, undefined, true), { code: "invalid" });
    assert.equal(create.mock.callCount(), 0);
    assert.equal((await f.runtime.listChats()).items.length, 1); assert.equal(f.faux.state.callCount, 0); assert.deepEqual(f.effects, []);
  } finally { await f.close(); }
});

test("managed child IPC replays exact ACKs across restart, rejects conflicting briefs/parents, and permits omitted brief", async () => {
  const f = await fixture();
  try {
    const parent = await f.runtime.createTask("Parent", binding), parentChatId = String(parent.id), hubId = f.runtime.hubId;
    const args = { requestId: randomUUID(), parentChatId, title: "Child", problem: " Exact problem ", description: "Exact\ndescription" };
    const ack = result<CreateManagedChildAck>(await f.channel.call("create_managed_child", args));
    assert.deepEqual(result(await f.channel.call("create_managed_child", args)), ack);
    for (const change of [{ title: "Changed" }, { parentChatId: String(f.runtime.main.id) }, { problem: "Exact problem" }, { description: "changed" }]) {
      const refused = await f.channel.call("create_managed_child", { ...args, ...change });
      assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.error.code, "conflict");
    }
    assert.equal((await f.runtime.listChats()).items.length, 3);
    await f.reopen(); assert.equal(f.runtime.hubId, hubId);
    assert.deepEqual(result(await f.channel.call("create_managed_child", args)), ack);
    assert.equal((await f.runtime.listChats()).items.length, 3);
    const empty = result<CreateManagedChildAck>(await f.channel.call("create_managed_child", { requestId: randomUUID(), parentChatId: String(f.runtime.main.id), title: "Main helper" }));
    assert.deepEqual(empty, { chatId: empty.chatId, parentChatId: String(f.runtime.main.id), brief: {} });
    assert.notEqual(empty.chatId, ack.chatId);
    assert.deepEqual((await f.runtime.history(ack.chatId)).items, []); assert.deepEqual((await f.runtime.history(empty.chatId)).items, []);
    assert.equal(f.faux.state.callCount, 0); assert.deepEqual(f.effects, []);
  } finally { await f.close(); }
});
