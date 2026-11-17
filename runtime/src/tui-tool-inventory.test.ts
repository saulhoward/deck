import assert from "node:assert/strict";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { TuiSession, validReply } from "./tui-session.js";
import type { ToolInventory, TuiRequest } from "./generated/contracts.js";

const sample = (chatId: string, name = "read"): ToolInventory => ({ chatId, builtins: [{ name, location: "worker" }], mcp: [] });

test("TuiSession selects and periodically refreshes scoped inventory, clears failures/legacy data and guards identities", async t => {
  const local = await clientEnv();
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const calls: { name: string; args: Record<string, unknown>; hub?: string }[] = [];
  let result: "ready" | "legacy" | "fail" | "invalid" | "wrongChat" | "wrongHub" | "wrongMain" | "serverUnavailable" = "ready", name = "read";
  const session = new TuiSession(async (command, args, hub) => {
    calls.push({ name: command, args, ...(hub ? { hub } : {}) });
    if (command === "status") {
      if (result === "fail") throw new Error("Private connection diagnostic");
      const chatId = String(args.chatId ?? "1");
      return { hubId: result === "wrongHub" ? "another-hub" : "hub", mainChatId: result === "wrongMain" ? "9" : "1", chatId: result === "wrongChat" ? "3" : chatId, hubGuard: 1, tools: "offline", ...(result === "legacy" ? {} : result === "serverUnavailable" ? { toolInventoryStatus: "unavailable" } : { toolInventory: { ...sample(result === "invalid" ? "9" : chatId, name) }, toolInventoryStatus: "ready" }) };
    }
    if (command === "history") return { items: [{ id: 2, kind: "deck.input", data: { text: "visible history" } }], next: args.before ? undefined : "2" };
    if (command === "activity") return { busy: false, queued: 0 };
    if (command === "progress") return {};
    assert.fail(`Unexpected inventory RPC/effect: ${command}`);
  }, undefined, "hub", local.env.DECK_CLIENT_STATE_DIRECTORY);
  let requestId = 0;
  const act = async (action: TuiRequest["action"], args: Partial<TuiRequest> = {}) => {
    const id = String(++requestId), snapshot = await session.handle({ version: 1, id, action, ...args });
    assert.ok(validReply({ version: 1, id, ok: true, snapshot }, id));
    return snapshot;
  };
  const statuses = () => calls.filter(c => c.name === "status");
  try {
    const first = await act("poll"); assert.deepEqual(first.toolInventory, sample("1")); assert.equal(first.toolInventoryStatus, "ready");
    assert.equal(statuses().length, 1); name = "bash";
    t.mock.timers.tick(1999); assert.deepEqual((await act("poll")).toolInventory, sample("1")); assert.equal(statuses().length, 1);
    t.mock.timers.tick(1); assert.deepEqual((await act("latest")).toolInventory, sample("1", "bash")); assert.equal(statuses().length, 2);
    assert.deepEqual(statuses()[1], { name: "status", args: { chatId: "1" }, hub: "hub" });
    const selected = await act("select", { chatId: "2" }); assert.deepEqual(selected.toolInventory, sample("2", "bash")); assert.deepEqual(selected.entries, []);
    assert.equal(statuses().length, 3); // Selection is never throttled.
    await act("latest"); const older = await act("older"); assert.equal(older.historical, true);
    name = "edit"; t.mock.timers.tick(2000);
    const held = await act("poll", { hold: true }); assert.deepEqual(held.toolInventory, sample("2", "edit")); assert.deepEqual(held.entries, older.entries); assert.equal(held.historical, true);
    for (const failure of ["fail", "invalid", "wrongChat", "wrongHub", "wrongMain", "serverUnavailable", "legacy"] as const) {
      result = failure; t.mock.timers.tick(2000);
      const state = await act("poll", { hold: true });
      assert.equal(state.toolInventory, undefined, failure);
      assert.equal(state.toolInventoryStatus, failure === "legacy" ? "unsupported" : "unavailable", failure);
      assert.doesNotMatch(JSON.stringify(state), /Private connection diagnostic/);
      result = "ready"; t.mock.timers.tick(2000);
      assert.equal((await act("poll", { hold: true })).toolInventoryStatus, "ready");
    }
    result = "legacy";
    const legacy = await act("select", { chatId: "4" }); assert.equal(legacy.toolInventory, undefined); assert.equal(legacy.toolInventoryStatus, "unsupported");
    assert.ok(calls.every(c => ["status", "history", "activity", "progress"].includes(c.name)));
  } finally { await local.close(); }
});

test("legacy snapshot is valid unknown inventory, while crossed identities and contradictory states are rejected", async () => {
  const local = await clientEnv();
  try {
    const session = new TuiSession(async command => command === "status" ? { hubId: "hub", mainChatId: "1", chatId: "1", hubGuard: 1, tools: "offline" } : { items: [] }, undefined, "hub", local.env.DECK_CLIENT_STATE_DIRECTORY);
    const snapshot = await session.handle({ version: 1, id: "1", action: "poll" });
    assert.equal(snapshot.toolInventoryStatus, "unsupported"); assert.equal(snapshot.toolInventory, undefined);
    delete snapshot.toolInventoryStatus;
    const reply = (s: unknown) => validReply({ version: 1, id: "1", ok: true, snapshot: s }, "1");
    assert.equal(reply(snapshot), true);
    assert.equal(reply({ ...snapshot, toolInventory: sample("1") }), true);
    assert.equal(reply({ ...snapshot, toolInventory: sample("2") }), false);
    assert.equal(reply({ ...snapshot, toolInventoryStatus: "ready" }), false);
    assert.equal(reply({ ...snapshot, toolInventory: sample("1"), toolInventoryStatus: "unavailable" }), false);
    // Task snapshots can carry only the selected chat's inventory without any
    // broad host/configuration capability; no new task-mode navigation privilege.
    assert.equal(reply({ ...snapshot, clientMode: "task", chatId: "2", toolInventory: sample("2") }), true);
  } finally { await local.close(); }
});

test("registered task-mode session refreshes through scoped status only, without configuration/navigation privileges", async t => {
  const local = await clientEnv(), hubId = "11111111-1111-4111-8111-111111111111";
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const calls: string[] = []; let name = "read";
  try {
    const session = new TuiSession(async (command, args, expectedHub) => {
      calls.push(command); assert.equal(expectedHub, hubId);
      if (command === "status") { assert.equal(args.chatId, "2"); return { hubId, mainChatId: "1", chatId: "2", hubGuard: 1, rexStartup: 1, tools: "offline", toolInventory: sample("2", name) }; }
      if (command === "history") return { items: [] };
      if (command === "rex_startup") return {};
      assert.fail(`Unexpected task-mode inventory command ${command}`);
    }, "2", hubId, local.env.DECK_CLIENT_STATE_DIRECTORY);
    await session.registerStartup(hubId, `block:${hubId}`);
    const first = await session.handle({ version: 1, id: "1", action: "poll" });
    assert.equal(first.clientMode, "task"); assert.deepEqual(first.toolInventory, sample("2")); assert.equal(first.hosts, undefined);
    name = "bash"; t.mock.timers.tick(2000);
    const next = await session.handle({ version: 1, id: "2", action: "latest" }); assert.deepEqual(next.toolInventory, sample("2", "bash"));
    assert.ok(validReply({ version: 1, id: "2", ok: true, snapshot: next }, "2", hubId, "2", "latest", undefined, undefined, "task", "1"));
    const count = calls.length;
    await assert.rejects(session.handle({ version: 1, id: "3", action: "hosts" }), /locked/);
    await assert.rejects(session.handle({ version: 1, id: "4", action: "select", chatId: "1" }), /locked/);
    assert.equal(calls.length, count);
    assert.deepEqual(calls.filter(c => c !== "history"), ["status", "rex_startup", "status"]);
  } finally { await local.close(); }
});
