import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { ChatDoc } from "./chat-doc.js";
import { agentNameAlgorithms, lookupAgentName } from "./agent-names.js";
import { ManagedChildRequest } from "./managed-child.js";
import { briefInstructions } from "./task-brief.js";
import { setup } from "./managed-child.test.support.js";
import type { TaskBrief } from "./generated/contracts.js";

const Cursor = defineDoc<{ next: number; order?: number[] }>({ kind: "deck.agent-name-cursor", version: 1, scope: "session", initial: () => ({ next: 0 }), checkpointWhen: () => true });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("problem-only creation atomically uses the permanent wintermute name for title and instructions without inference; concurrent and restart replays consume no names", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-child-problem-")), path = join(root, "pi.sqlite"), f = setup();
  let runtime = await f.open(path);
  try {
    const parent = await runtime.createTask("Parent", f.options.binding, "parent"), parentId = String(parent.id);
    await runtime.configure(parentId, { thinkingLevel: "high", instructions: "PRIVATE PARENT INSTRUCTIONS" });
    const original = await parent.agent(context), before = (await runtime.harness.snapshot(Cursor, context))!;
    const brief = { problem: "  Own problem 🧪\nKeep exact bytes  ", description: "" };
    const children = await Promise.all(Array.from({ length: 8 }, () => runtime.createManagedChild(parentId, undefined, "auto", brief)));
    const child = children[0]!, childId = String(child.id);
    assert.ok(children.every(c => c.id === child.id));
    const saved = (await runtime.harness.snapshot(ChatDoc, child.id, context))!;
    assert.equal(saved.title, saved.agentName); assert.equal(saved.agentNameAlgorithm, "wintermute-v1");
    assert.equal(saved.agentName, agentNameAlgorithms["wintermute-v1"]!.candidate(before.order![before.next]!));
    assert.equal(await lookupAgentName(runtime.harness, saved.title, context), child.id);
    assert.deepEqual(saved.brief, brief); assert.equal(saved.managedParentChatId, parentId);
    assert.equal(saved.machineId, f.options.binding.machineId); assert.equal(saved.cwd, f.options.binding.cwd);
    assert.equal((await runtime.harness.commit(tx => tx.conversation(child.id), context))!.owner, undefined);
    const agent = await child.agent(context), agentDoc = (await runtime.harness.snapshot(AgentDoc, child.id, context))!;
    assert.equal(agent.instructions, briefInstructions(saved.title, brief)); assert.equal(agentDoc.instructions, agent.instructions);
    assert.doesNotMatch(agent.instructions!, /PRIVATE PARENT/);
    assert.deepEqual(agent.model, original.model); assert.equal(agent.thinkingLevel, original.thinkingLevel); assert.equal(agent.cwd, original.cwd);
    for (const kind of ["tools", "callable", "deferred", "extensions"] as const) assert.deepEqual(agent[kind].map(t => t.name), original[kind].map(t => t.name));
    assert.deepEqual((await runtime.history(childId)).items, []); assert.equal((await runtime.activity(childId)).busy, false);
    assert.equal((await runtime.terminalStatus(childId)).status, "unallocated"); assert.equal(f.faux.state.callCount, 0);
    const receipt = await runtime.harness.snapshot(ManagedChildRequest, "auto", context);
    assert.deepEqual(receipt, { hash: digest(["deck.managed-child-create.problem.v1", parentId, brief]), chatId: child.id });
    const after = (await runtime.harness.snapshot(Cursor, context))!;
    assert.equal(after.next, before.next + 1);
    // Even the exact generated title is a distinct explicit-title request mode.
    await assert.rejects(runtime.createManagedChild(parentId, saved.title, "auto", brief), { code: "conflict" });
    await assert.rejects(runtime.createManagedChild(parentId, undefined, "auto", { ...brief, problem: brief.problem.trim() }), { code: "conflict" });
    await assert.rejects(runtime.createManagedChild(String(runtime.main.id), undefined, "auto", brief), { code: "conflict" });
    assert.deepEqual(await runtime.harness.snapshot(Cursor, context), after);
    await runtime.configure(parentId, { thinkingLevel: "off", tools: [] });
    await runtime.close(); runtime = await f.open(path);
    assert.equal((await runtime.createManagedChild(parentId, undefined, "auto", brief)).id, child.id);
    assert.deepEqual(await runtime.harness.snapshot(ChatDoc, child.id, context), saved);
    assert.deepEqual(await runtime.harness.snapshot(AgentDoc, child.id, context), agentDoc);
    assert.deepEqual(await runtime.harness.snapshot(Cursor, context), after);
    assert.equal(await lookupAgentName(runtime.harness, saved.title, context), child.id);
    assert.equal((await runtime.listChats()).items.length, 3); assert.equal(f.faux.state.callCount, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy explicit-title receipts retain exact hashes and cannot be retargeted into problem-only mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-child-legacy-")), path = join(root, "pi.sqlite"), f = setup();
  let runtime = await f.open(path);
  try {
    const parentId = String(runtime.main.id), brief = { problem: "Own problem", description: "" };
    const child = await runtime.createManagedChild(parentId, "Manual title", "legacy", brief);
    const empty = await runtime.createManagedChild(parentId, "Manual empty brief", "legacy-empty");
    assert.equal((await runtime.harness.snapshot(ManagedChildRequest, "legacy", context))!.hash, digest(["deck.managed-child-create.v1", parentId, "Manual title", brief]));
    assert.equal((await runtime.harness.snapshot(ManagedChildRequest, "legacy-empty", context))!.hash, digest(["deck.managed-child-create.v1", parentId, "Manual empty brief", {}]));
    await runtime.close(); runtime = await f.open(path);
    assert.equal((await runtime.createManagedChild(parentId, "Manual title", "legacy", brief)).id, child.id);
    assert.equal((await runtime.createManagedChild(parentId, "Manual empty brief", "legacy-empty")).id, empty.id);
    await assert.rejects(runtime.createManagedChild(parentId, undefined, "legacy", brief), { code: "conflict" });
    assert.equal((await runtime.harness.snapshot(ChatDoc, child.id, context))!.title, "Manual title");
    assert.equal((await runtime.listChats()).items.length, 3); assert.equal(f.faux.state.callCount, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("direct problem-only API rejects blank/oversized/malformed problems, nonempty or omitted descriptions, and brief overrides before reserving names or receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-child-problem-invalid-")), f = setup(), runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const parentId = String(runtime.main.id), before = await runtime.harness.snapshot(Cursor, context);
    const invalid: unknown[] = [null, {}, { problem: "Own" }, { description: "" },
      ...["", " \t\n\u3000\ufeff", null, 42, "🧪".repeat(512) + "a", "x".repeat(2049), "\ud800"].map(problem => ({ problem, description: "" })),
      ...[undefined, null, " ", "Override"].map(description => ({ problem: "Own", description })),
      ...["title", "cwd", "machineId", "instructions", "agentName", "model", "text"].map(key => ({ problem: "Own", description: "", [key]: "override" }))];
    for (const [i, brief] of invalid.entries()) {
      const requestId = `invalid-${i}`;
      await assert.rejects(runtime.createManagedChild(parentId, undefined, requestId, brief as TaskBrief), { code: "invalid" });
      assert.equal(await runtime.harness.snapshot(ManagedChildRequest, requestId, context), undefined);
    }
    for (const title of ["", " \u3000", null]) await assert.rejects(runtime.createManagedChild(parentId, title as string, "invalid-title", { problem: "Own", description: "" }), { code: "invalid" });
    assert.equal((await runtime.listChats()).items.length, 1); assert.deepEqual(await runtime.harness.snapshot(Cursor, context), before);
    const boundary = { problem: "🧪".repeat(512), description: "" };
    const child = await runtime.createManagedChild(parentId, undefined, "boundary", boundary);
    assert.deepEqual((await runtime.harness.snapshot(ChatDoc, child.id, context))!.brief, boundary);
    assert.equal(f.faux.state.callCount, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("a failure after problem-only name/title/instructions/receipt assignment rolls back the entire creation and name claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-child-problem-rollback-")), f = setup(), runtime = await f.open(join(root, "pi.sqlite"));
  try {
    const parent = await runtime.createTask("Parent", f.options.binding), parentId = String(parent.id), brief = { problem: "Own", description: "" };
    const before = await runtime.harness.snapshot(Cursor, context), count = (await runtime.listChats()).items.length;
    const commit = runtime.harness.commit.bind(runtime.harness); let rolledBackName: string | undefined;
    runtime.harness.commit = (fn, ctx) => commit(async tx => {
      let createdId: ConversationId | undefined;
      const result = await fn(new Proxy(tx, { get(target, property) {
        if (property === "createConversation") return async (...args: Parameters<typeof tx.createConversation>) => { const created = await tx.createConversation(...args); createdId = created.id; return created; };
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } }));
      if (createdId !== undefined) {
        const saved = await tx.doc(ChatDoc, createdId); rolledBackName = saved.agentName;
        assert.equal(saved.title, rolledBackName); assert.equal((await tx.doc(AgentDoc, createdId)).instructions, briefInstructions(saved.title, brief));
        assert.equal((await tx.doc(ManagedChildRequest, "rollback", "unused")).chatId, createdId);
        throw new Error("Injected failure after all creation writes");
      }
      return result;
    }, ctx);
    try { await assert.rejects(runtime.createManagedChild(parentId, undefined, "rollback", brief), /Injected failure/); }
    finally { runtime.harness.commit = commit; }
    assert.ok(rolledBackName); assert.equal(await lookupAgentName(runtime.harness, rolledBackName, context), undefined);
    assert.deepEqual(await runtime.harness.snapshot(Cursor, context), before);
    assert.equal(await runtime.harness.snapshot(ManagedChildRequest, "rollback", context), undefined);
    assert.equal((await runtime.listChats()).items.length, count);
    const child = await runtime.createManagedChild(parentId, undefined, "rollback", brief);
    assert.equal((await runtime.harness.snapshot(ChatDoc, child.id, context))!.title, rolledBackName);
    assert.equal(await lookupAgentName(runtime.harness, rolledBackName, context), child.id); assert.equal(f.faux.state.callCount, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
