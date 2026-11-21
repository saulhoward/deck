import assert from "node:assert/strict";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { TuiSession, validReply } from "./tui-session.js";
import type { ActivitySnapshot, ManagedChildSnapshot } from "./generated/contracts.js";

for (const taskMode of [false, true]) {
  test(`TUI children refresh in held/history windows and clear across omission/selection (${taskMode ? "task" : "hub"} client)`, async () => {
    const local = await clientEnv(); const calls: { command: string; args: Record<string, unknown> }[] = [];
    let children: ManagedChildSnapshot | undefined = { chatId: "2", items: [{ chatId: "3", title: "Review\n\x1b]52;c;PRIVATE\x07code", agentName: "wintermute", status: { state: "working" } }], hasMore: false };
    let omitActivity = false, fail = false;
    const machine = "a".repeat(32), hub = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const session = new TuiSession(async (command, args) => {
      calls.push({ command, args }); const chatId = String(args.chatId ?? "2");
      if (command === "status") return { hubId: hub, hubGuard: 1, mainChatId: "1", chatId, model: { provider: "mock", modelId: "echo" }, tools: "offline", binding: { kind: "task", title: "Parent", machineId: machine, cwd: "/saved" } };
      const activity: ActivitySnapshot = { chatId, busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false, subagents: { chatId, items: [{ chatId: "9", title: "Captured helper" }], hasMore: false }, ...(children ? { children } : {}) };
      if (command === "history" || command === "activity") assert.equal(args.includeChildren, true);
      if (fail && (command === "activity" || command === "history")) throw new Error("read unavailable");
      if (command === "history") return { items: [{ id: args.before ? 9 : 10, kind: "deck.input", data: { text: "Retained" } }], next: args.before ? "9" : "10", ...(!omitActivity ? { activity } : {}) };
      if (command === "activity") return activity;
      assert.equal(command, "progress"); return { version: 1, chatId, provisional: true };
    }, "2", hub, local.env.DECK_CLIENT_STATE_DIRECTORY);
    let sequence = 0;
    const poll = (hold = false) => session.handle({ version: 1, id: String(++sequence), action: "poll", hold });
    try {
      if (taskMode) await session.registerAttachment(machine);
      const first = await poll();
      assert.equal(first.children!.items[0]!.status!.state, "working");
      assert.equal(first.children!.items[0]!.title, "Review code");
      assert.equal(first.subagents!.items[0]!.title, "Captured helper");
      assert.match(children.items[0]!.title, /PRIVATE/); // Canonical source remains unchanged.
      assert.ok(validReply({ version: 1, id: "ok", ok: true, snapshot: first }, "ok", hub, "2"));
      children.items[0]!.status = { state: "done", taskId: "8" };
      const held = await poll(true);
      assert.deepEqual(held.entries, first.entries); assert.equal(held.children!.items[0]!.status!.state, "done");
      assert.equal(first.children!.items[0]!.status!.state, "working"); // Owned snapshot, not shared mutable sample.
      const older = await session.handle({ version: 1, id: "older", action: "older" });
      assert.equal(older.historical, true);
      children.items[0]!.status = { state: "error", taskId: "9" };
      const historical = await poll();
      assert.deepEqual(historical.entries, older.entries); assert.equal(historical.children!.items[0]!.status!.state, "error");
      fail = true;
      await assert.rejects(poll(), /read unavailable/);
      fail = false;
      const afterError = await session.handle({ version: 1, id: "older-error", action: "older" });
      assert.equal(afterError.children, undefined, "failed read clears sample even from later non-observation replies");
      delete children.items[0]!.status;
      assert.equal((await poll()).children!.items[0]!.status, undefined);
      children = { chatId: "2", items: [], hasMore: false };
      assert.deepEqual((await poll()).children, children);
      children = undefined;
      assert.equal((await poll()).children, undefined); // Legacy/unavailable is not cached success or an empty assertion.
      children = { chatId: "2", items: [{ chatId: "3", title: "New child", status: { state: "working" } }], hasMore: false };
      assert.ok((await poll()).children);
      omitActivity = true;
      assert.equal((await session.handle({ version: 1, id: "latest", action: "latest" })).children, undefined);
      if (!taskMode) {
        omitActivity = false; assert.ok((await poll()).children);
        assert.equal((await session.handle({ version: 1, id: "switch", action: "select", chatId: "4" })).children, undefined);
        children = { chatId: "4", items: [], hasMore: false };
        assert.equal((await poll()).children!.chatId, "4");
      }
      assert.ok(calls.every(call => ["status", "history", "activity", "progress"].includes(call.command)));
    } finally { await local.close(); }
  });
}

test("captured subagent inspection never sends includeChildren in closed options and cannot inherit a parent's managed list", async () => {
  const local = await clientEnv(), hub = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", machine = "a".repeat(32);
  const calls: { command: string; args: Record<string, any> }[] = [];
  const status = (child: boolean) => ({ hubId: hub, hubGuard: 1, mainChatId: "1", chatId: child ? "3" : "2", model: { provider: "mock", modelId: "echo" }, tools: "offline",
    binding: { machineId: machine, cwd: "/saved", kind: child ? "subagent" : "task", title: "Task", ...(child ? { parentChatId: "2", ownerTaskId: "1", agentName: "WM001", agentNameAlgorithm: "subagent-v1" } : {}) } });
  const activity = (chatId: string): ActivitySnapshot => ({ chatId, busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false,
    ...(chatId === "2" ? { children: { chatId, items: [{ chatId: "4", title: "Managed" }], hasMore: false } } : {}) });
  const session = new TuiSession(async (command, args) => {
    calls.push({ command, args });
    if (command === "status") return status(false);
    if (command === "history") { assert.equal(args.includeChildren, true); return { items: [], activity: activity("2") }; }
    assert.equal(command, "subagent_view"); assert.equal(args.chatId, "2");
    const options = args.options as Record<string, unknown> | undefined;
    assert.equal(options?.includeChildren, undefined);
    const result = args.operation === "status" ? status(true) : args.operation === "history" ? { items: [], activity: activity("3") } : args.operation === "activity" ? activity("3") : { version: 1, chatId: "3", provisional: true };
    return { hubId: hub, parentChatId: "2", childId: "3", operation: args.operation, ...(args.name ? { name: args.name } : {}), result };
  }, "2", hub, local.env.DECK_CLIENT_STATE_DIRECTORY);
  try {
    await session.registerAttachment(machine);
    assert.ok((await session.handle({ version: 1, id: "first", action: "poll" })).children);
    const inspected = await session.handle({ version: 1, id: "inspect", action: "subagent", text: "wm001" });
    assert.equal(inspected.chatId, "3"); assert.equal(inspected.children, undefined);
    assert.equal((await session.handle({ version: 1, id: "held", action: "poll", hold: true })).children, undefined);
    assert.equal((await session.handle({ version: 1, id: "live", action: "poll" })).children, undefined);
    assert.equal((await session.handle({ version: 1, id: "parent", action: "parent" })).children!.chatId, "2");
    assert.ok(calls.some(call => call.command === "subagent_view" && call.args.operation === "activity"));
    assert.ok(calls.every(call => ["status", "history", "subagent_view"].includes(call.command)));
  } finally { await local.close(); }
});
