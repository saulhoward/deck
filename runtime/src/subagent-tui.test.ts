import assert from "node:assert/strict";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { TuiSession, validReply } from "./tui-session.js";
import type { ActivitySnapshot, SubagentSnapshot } from "./generated/contracts.js";

for (const taskMode of [false, true]) {
  test(`TUI subagents refresh in held/history windows and clear across omission/selection (${taskMode ? "task" : "hub"} client)`, async () => {
    const local = await clientEnv(); const calls: { command: string; args: Record<string, unknown> }[] = [];
    let children: SubagentSnapshot | undefined = { chatId: "2", items: [{ chatId: "3", title: "Review\n\x1b]52;c;PRIVATE\x07code", agentName: "wintermute", status: { state: "working" } }], hasMore: false };
    let omitActivity = false;
    const machine = "a".repeat(32), hub = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const session = new TuiSession(async (command, args) => {
      calls.push({ command, args }); const chatId = String(args.chatId ?? "2");
      if (command === "status") return { hubId: hub, hubGuard: 1, mainChatId: "1", chatId, model: { provider: "mock", modelId: "echo" }, tools: "offline", binding: { kind: "task", title: "Parent", machineId: machine, cwd: "/saved" } };
      const activity: ActivitySnapshot = { chatId, busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false, ...(children ? { subagents: children } : {}) };
      if (command === "history" || command === "activity") assert.equal(args.includeSubagents, true);
      if (command === "history") return { items: [{ id: args.before ? 9 : 10, kind: "deck.input", data: { text: "Retained" } }], next: args.before ? "9" : "10", ...(!omitActivity ? { activity } : {}) };
      if (command === "activity") return activity;
      assert.equal(command, "progress"); return { version: 1, chatId, provisional: true };
    }, "2", hub, local.env.DECK_CLIENT_STATE_DIRECTORY);
    let sequence = 0;
    const poll = (hold = false) => session.handle({ version: 1, id: String(++sequence), action: "poll", hold });
    try {
      if (taskMode) await session.registerAttachment(machine);
      const first = await poll();
      assert.equal(first.subagents!.items[0]!.status!.state, "working");
      assert.equal(first.subagents!.items[0]!.title, "Review code");
      assert.match(children.items[0]!.title, /PRIVATE/); // Canonical source remains unchanged.
      assert.ok(validReply({ version: 1, id: "ok", ok: true, snapshot: first }, "ok", hub, "2"));
      children.items[0]!.status = { state: "done", taskId: "8" };
      const held = await poll(true);
      assert.deepEqual(held.entries, first.entries); assert.equal(held.subagents!.items[0]!.status!.state, "done");
      assert.equal(first.subagents!.items[0]!.status!.state, "working"); // Owned snapshot, not shared mutable sample.
      const older = await session.handle({ version: 1, id: "older", action: "older" });
      assert.equal(older.historical, true);
      children.items[0]!.status = { state: "error", taskId: "9" };
      const historical = await poll();
      assert.deepEqual(historical.entries, older.entries); assert.equal(historical.subagents!.items[0]!.status!.state, "error");
      delete children.items[0]!.status;
      assert.equal((await poll()).subagents!.items[0]!.status, undefined);
      children = { chatId: "2", items: [], hasMore: false };
      assert.deepEqual((await poll()).subagents, children);
      children = undefined;
      assert.equal((await poll()).subagents, undefined); // Legacy/unavailable is not cached success or an empty assertion.
      children = { chatId: "2", items: [{ chatId: "3", title: "New child", status: { state: "working" } }], hasMore: false };
      assert.ok((await poll()).subagents);
      omitActivity = true;
      assert.equal((await session.handle({ version: 1, id: "latest", action: "latest" })).subagents, undefined);
      if (!taskMode) {
        omitActivity = false; assert.ok((await poll()).subagents);
        assert.equal((await session.handle({ version: 1, id: "switch", action: "select", chatId: "4" })).subagents, undefined);
        children = { chatId: "4", items: [], hasMore: false };
        assert.equal((await poll()).subagents!.chatId, "4");
      }
      assert.ok(calls.every(call => ["status", "history", "activity", "progress"].includes(call.command)));
    } finally { await local.close(); }
  });
}
