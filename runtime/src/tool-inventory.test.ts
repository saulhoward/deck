import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { DeckRuntime } from "./deck.js";
import { dispatch } from "./ipc.js";
import { profileGrant, toolAlias, McpGrantsDoc } from "./mcp-tools.js";
import { projectToolInventory } from "./tool-inventory.js";
import { validToolInventory, validInventoryFields } from "./tool-inventory-contracts.js";
import { validStatusLoginReply } from "./status-login-contracts.js";
import type { McpProfile, ToolInventory } from "./generated/contracts.js";

const hub = "a".repeat(32), worker = "b".repeat(32), unrelated = "c".repeat(32);
const tool = { name: "lookup", description: "PRIVATE_DESCRIPTION", inputSchema: '{"type":"object","properties":{},"required":[],"additionalProperties":false}' };
const local: McpProfile = { id: "local", machineId: hub, workspace: "task", revision: "1".repeat(64), tools: [tool] };
const service: McpProfile = { ...local, id: "service", workspace: "fixed" };
const remote: McpProfile = { ...local, id: "remote", machineId: worker, tools: [tool, { ...tool, name: "second" }] };
const other: McpProfile = { ...local, id: "unrelated", machineId: unrelated, workspace: "fixed" };
async function fixture(native = true) {
  const root = await mkdtemp(join(tmpdir(), "deck-tool-inventory-")), faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  let probes = 0;
  const options = { implementation: "a".repeat(64), models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: hub, cwd: "/saved" }, environment: () => { probes++; throw new Error("Must not resolve/probe environment"); }, ...(native ? { mcpCatalog: { version: 1 as const, profiles: [local, service, remote, other] }, hostFiles: { registeredHosts: async () => { probes++; throw new Error("Must not probe workers"); }, call: async () => { probes++; throw new Error("Must not dispatch effects"); } } } : {}) };
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), options);
  return { runtime, root, options, faux, probes: () => probes, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
const surface = (inventory: ToolInventory) => [...inventory.builtins.map(t => t.name), ...inventory.mcp.filter(p => p.state === "enabled").flatMap(p => p.tools.map(t => t.alias))].sort();

test("real runtime inventory projects resolved model tools, scoped approvals/grants and hub/worker execution without probing", async () => {
  const f = await fixture(); const r = f.runtime, main = String(r.main.id);
  try {
    const original = await r.main.agent(context), initial = await r.toolInventory(main);
    assert.deepEqual(surface(initial), original.tools.map(t => t.name).sort());
    assert.ok(initial.builtins.every(t => t.location === "hub"));
    assert.deepEqual(initial.mcp.map(p => [p.profileId, p.state]), [["local", "not_granted"], ["service", "not_granted"]]);
    assert.doesNotMatch(JSON.stringify(initial), /PRIVATE_DESCRIPTION|inputSchema|executable|env|unrelated/);
    const task = await r.createTask("Worker task", { machineId: worker, cwd: "/remote" }), id = String(task.id);
    const status: any = await dispatch(r, { command: "status", args: { chatId: id }, hubId: r.hubId }, undefined, true);
    assert.equal(status.activity, undefined); assert.equal(status.machineId, undefined); assert.equal(status.hostInventory, undefined);
    assert.ok(validStatusLoginReply({ command: "status", args: { chatId: id }, hubId: r.hubId }, status));
    assert.equal(status.toolInventoryStatus, "ready");
    assert.deepEqual(status.toolInventory.mcp.map((p: any) => p.profileId), ["service", "remote"]);
    for (const t of status.toolInventory.builtins) assert.equal(t.location, ["read", "write", "edit", "bash"].includes(t.name) ? "worker" : "hub");
    await r.setToolProfiles({ chatId: id, expectedRevision: 0, profiles: [profileGrant(service), profileGrant(remote)] });
    const granted = await r.toolInventory(id);
    assert.deepEqual(granted.mcp.map(p => [p.state, p.location]), [["enabled", "hub"], ["enabled", "worker"]]);
    assert.deepEqual(surface(granted), (await task.agent(context)).tools.map(t => t.name).sort());
    // A selected extension/grant does not bypass the actual model allowlist.
    await r.configure(id, { modelTools: (await task.agent(context)).tools.filter(t => !["write", toolAlias(remote, "second")].includes(t.name)) });
    const filtered = await r.toolInventory(id);
    assert.ok(!filtered.builtins.some(t => t.name === "write"));
    assert.deepEqual(filtered.mcp.find(p => p.profileId === "remote")!.tools.map(t => t.name), ["lookup"]);
    await r.configure(id, { modelTools: [] });
    const hidden = await r.toolInventory(id);
    assert.deepEqual(hidden.builtins, []); assert.ok(hidden.mcp.every(p => p.state === "unavailable" && !p.tools.length));
    // Restore then remove native extension: identically named CodingTools now
    // use Pi's environment, NOT native worker/hub dispatch.
    await r.configure(id, { modelTools: null, extensions: (await task.agent(context)).extensions.filter(e => e.name !== "deck.native-files") });
    assert.ok((await r.toolInventory(id)).builtins.filter(t => ["read", "write", "edit", "bash"].includes(t.name)).every(t => t.location === "environment"));
    assert.equal(f.probes(), 0);
  } finally { await f.close(); }
});

test("fallback CodingTools and extra model tools are present; callable-only/deferred registrations are not fabricated", async () => {
  const f = await fixture(false);
  try {
    const agent = await f.runtime.main.agent(context), inventory = await f.runtime.toolInventory(String(f.runtime.main.id));
    assert.deepEqual(surface(inventory), agent.tools.map(t => t.name).sort());
    assert.ok(inventory.builtins.filter(t => ["read", "write", "edit", "bash"].includes(t.name)).every(t => t.location === "environment"));
    const extra = defineTool({ name: "mcp_environment_extra", description: "PRIVATE", parameters: Type.Object({}), execute: async () => ({ output: [] }) });
    const internal = defineTool({ ...extra, name: "internal_only", callers: ["tools"] });
    const extension = defineExtension({ name: "injected-environment", tools: [extra, internal] });
    const projected = projectToolInventory("1", { ...agent, tools: [...agent.tools, extra], callable: [...agent.callable, internal], extensions: [...agent.extensions, extension] }, { version: 1, profiles: [] }, [], hub, worker, () => false);
    assert.deepEqual(projected.builtins.at(-1), { name: "mcp_environment_extra", location: "environment" });
    assert.ok(!projected.builtins.some(t => t.name === "internal_only"));
    assert.equal(f.probes(), 0);
  } finally { await f.close(); }
});

test("missing or changed catalog revisions remain unavailable saved grants without invented workspace/tools", async () => {
  const f = await fixture(); const id = String(f.runtime.main.id);
  try {
    await f.runtime.setToolProfiles({ chatId: id, expectedRevision: 0, profiles: [profileGrant(local)] });
    await f.runtime.close();
    const runtime = await DeckRuntime.open(join(f.root, "pi.sqlite"), { ...f.options, mcpCatalog: { version: 1, profiles: [{ ...local, revision: "2".repeat(64) }] } });
    try {
      const inventory = await runtime.toolInventory(id);
      assert.deepEqual(inventory.mcp.map(p => p.state), ["not_granted", "unavailable"]);
      assert.equal(inventory.mcp[1]!.revision, local.revision); assert.equal(inventory.mcp[1]!.workspace, undefined);
      assert.deepEqual(inventory.mcp[1]!.tools, []);
      // Removing grants without removing a selected alias is also unavailable,
      // never enabled merely because a matching extension exists.
      await runtime.setToolProfiles({ chatId: id, expectedRevision: 1, profiles: [profileGrant({ ...local, revision: "2".repeat(64) })] });
      await runtime.harness.commit(async tx => { (await tx.doc(McpGrantsDoc, runtime.main.id)).profiles = []; }, context);
      assert.equal((await runtime.toolInventory(id)).mcp[0]!.state, "unavailable");
    } finally { await runtime.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("real foreground subagent inventory inherits grants and filtered model policy, not parent-only control tools", async () => {
  const f = await fixture(); const id = String(f.runtime.main.id);
  try {
    await f.runtime.setToolProfiles({ chatId: id, expectedRevision: 0, profiles: [profileGrant(local)] });
    const original = await f.runtime.main.agent(context);
    await f.runtime.configure(id, { tools: original.tools.filter(t => t.name !== "write") });
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { task: "Inspect only" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Child done"), fauxAssistantMessage("Parent done"),
    ]);
    await (await f.runtime.admit(id, { requestId: "inventory-child", text: "Delegate", mode: "followUp" })).wait(context);
    const child = (await f.runtime.listChats()).items.find(c => c.kind === "subagent")!; assert.ok(child);
    const inventory = await f.runtime.toolInventory(child.chatId), agent = await (await f.runtime.chat(child.chatId)).agent(context);
    assert.deepEqual(surface(inventory), agent.tools.map(t => t.name).sort());
    assert.ok(!inventory.builtins.some(t => ["write", "subagent", "task_create", "task_send", "task_stop"].includes(t.name)));
    assert.equal(inventory.mcp.find(p => p.profileId === "local")!.state, "enabled");
    assert.equal(f.probes(), 0);
  } finally { await f.close(); }
});

test("inventory semantic validation rejects crossed chat identity, duplicates, contradictory statuses and private metadata", () => {
  const value: ToolInventory = { chatId: "1", hubMachineId: hub, builtins: [{ name: "read", location: "worker" }], mcp: [{ ...profileGrant(local), location: "hub", workspace: "task", state: "enabled", tools: [{ name: "lookup", alias: toolAlias(local, "lookup") }] }] };
  assert.ok(validToolInventory(value, "1")); assert.equal(validToolInventory(value, "2"), false);
  assert.ok(validInventoryFields({ chatId: "1" })); assert.ok(validInventoryFields({ chatId: "1", toolInventory: value }));
  for (const status of ["unsupported", "unavailable"] as const) assert.equal(validInventoryFields({ chatId: "1", toolInventory: value, toolInventoryStatus: status }), false);
  assert.equal(validInventoryFields({ chatId: "1", toolInventoryStatus: "ready" }), false);
  for (const bad of [
    { ...value, chatId: "9007199254740992" }, { ...value, builtins: [value.builtins[0], value.builtins[0]] },
    { ...value, mcp: [value.mcp[0], value.mcp[0]] }, { ...value, env: "SECRET" },
    { ...value, mcp: [{ ...value.mcp[0], state: "unavailable" }] },
    { ...value, mcp: [{ ...value.mcp[0], tools: [] }] },
    { ...value, hubMachineId: "\x1b]bad" },
    { ...value, builtins: Array.from({ length: 129 }, (_, i) => ({ name: `tool${i}`, location: "hub" })) },
  ]) assert.equal(validToolInventory(bad), false, JSON.stringify(bad));
});

test("status preserves selection but explicitly omits inventory when projection fails", async t => {
  const f = await fixture();
  try {
    t.mock.method(f.runtime, "toolInventory", async () => { throw new Error("PRIVATE_DIAGNOSTIC"); });
    const status: any = await dispatch(f.runtime, { command: "status", args: {} });
    assert.equal(status.chatId, String(f.runtime.main.id)); assert.equal(status.toolInventory, undefined); assert.equal(status.toolInventoryStatus, "unavailable");
    assert.ok(validStatusLoginReply({ command: "status", args: {} }, status));
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_DIAGNOSTIC/); assert.equal(f.probes(), 0);
  } finally { await f.close(); }
});
