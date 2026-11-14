import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AgentWizard, startupDraft, validWizardRequest, type WizardTransport } from "./agent-wizard.js";
import { bootstrapPath, StartupFiles } from "./agent-storage.js";
import { DraftStore } from "./drafts.js";
import type { RexBootstrapRecord } from "./generated/contracts.js";
async function fixture() {
  const root = await mkdtemp("/tmp/deck-wizard-unit-");
  const record: RexBootstrapRecord = { version: 1, id: randomUUID(), hubId: randomUUID(), machineId: "a".repeat(32), cwd: "/exact/workspace", client: "/tools/deck", draftRoot: root, port: 52800, target: { executable: "/tools/rex", server: "unix:///tmp/test.sock", hostId: randomUUID(), instanceId: randomUUID() }, binding: { sessionId: `session:${randomUUID()}`, windowId: `window:${randomUUID()}`, blockId: `block:${randomUUID()}`, pid: 1 } };
  await mkdir(join(root, "startups"), { mode: 0o700 }); await mkdir(bootstrapPath(root, record.id), { mode: 0o700 });
  const files = new StartupFiles(bootstrapPath(root, record.id));
  const calls: { command: string; args: any }[] = [];
  let loseCreate = false, loseAdopt = false, pending = false, drift = false;
  const allocationId = randomUUID();
  const transport: WizardTransport = {
    launcher: async () => { throw new Error("No remote fallback"); },
    hub: async (command, args) => {
      calls.push({ command, args: structuredClone(args) });
      if (command === "create_task_brief") {
        if (loseCreate) { loseCreate = false; throw new Error("PRIVATE lost ACK"); }
        return { chatId: "2", brief: { problem: args.problem, ...(args.description === undefined ? {} : { description: args.description }) } };
      }
      if (command === "rex_adopt") {
        if (loseAdopt) { loseAdopt = false; throw new Error("PRIVATE lost allocation ACK"); }
        return { version: 1, hubId: record.hubId, chatId: "2", requestId: args.requestId, allocationId, taskId: "5" };
      }
      assert.equal(command, "rex_status", "wizard has no input/stop/arbitrary command path");
      const b = record.binding!, t = record.target;
      return { version: 1, hubId: record.hubId, chatId: "2", taskId: "5", status: pending ? "pending" : "allocated", binding: pending ? null : { machineId: record.machineId, cwd: record.cwd, server: t.server, hostId: t.hostId, instanceId: t.instanceId, sessionId: b.sessionId, windowId: b.windowId, blockId: drift ? `block:${randomUUID()}` : b.blockId, hubId: record.hubId, chatId: "2", taskId: "5", readiness: "not_checked" }, previousBinding: null, bestEffort: true };
    },
  };
  return { root, record, files, calls, transport, wizard: new AgentWizard(record, files, transport), loseCreate: () => { loseCreate = true; }, loseAdopt: () => { loseAdopt = true; }, pending: (value: boolean) => { pending = value; }, drift: () => { drift = true; }, close: () => rm(root, { recursive: true, force: true }) };
}
const req = (action: "poll" | "retry" | "discard") => ({ version: 1 as const, id: "request", action });
test("wizard requests require a nonblank bounded exact problem and preserve omitted/empty description", async () => {
  for (const description of [undefined, ""]) {
    const f = await fixture();
    try {
      const problem = "  problem\nline\t🌍  ";
      const result = await f.wizard.handle({ version: 1, id: "create", action: "create", problem, ...(description === undefined ? {} : { description }) });
      assert.equal(result.phase, "ready"); assert.equal(result.saved, true);
      const saved = (await startupDraft(f.record, f.files))!;
      assert.equal(saved.problem, problem); assert.equal(Object.hasOwn(saved, "description"), description !== undefined);
      assert.equal(saved.description, description);
      const draft = (await new DraftStore(f.record.hubId, f.root).load(saved.inputId)).request;
      assert.ok(draft.kind === "input"); assert.equal(draft.text, problem);
      assert.deepEqual(f.calls.map(c => c.command), ["create_task_brief", "rex_adopt", "rex_status"]);
      assert.equal(f.calls[1]!.args.bootstrap.root, f.root);
      assert.equal((await stat(join(f.files.directory, "form.json"))).mode & 0o777, 0o600);
      assert.equal(result.ready!.inputId, saved.inputId);
    } finally { await f.close(); }
  }
  for (const problem of ["", " \t\n", "🌍".repeat(513), "\ud800"]) assert.equal(validWizardRequest({ version: 1, id: "x", action: "create", problem }), false);
  assert.equal(validWizardRequest({ version: 1, id: "x", action: "retry", problem: "replacement" }), false);
  assert.equal(validWizardRequest({ version: 1, id: "x", action: "create", problem: "ok", description: "🌍".repeat(2049) }), false);
});
test("lost creation ACK/restart never advances on poll; explicit retry uses original brief and IDs", async () => {
  const f = await fixture(); f.loseCreate();
  try {
    const first = await f.wizard.handle({ version: 1, id: "c", action: "create", problem: " exact\nproblem ", description: "\t" });
    assert.equal(first.phase, "blocked"); assert.equal(first.saved, true); assert.doesNotMatch(first.notice, /PRIVATE/);
    const bytes = await readFile(join(f.files.directory, "form.json"));
    const restarted = new AgentWizard(f.record, f.files, f.transport);
    for (let i = 0; i < 3; i++) assert.equal((await restarted.handle(req("poll"))).phase, "blocked");
    assert.equal(f.calls.length, 1);
    await assert.rejects(restarted.handle({ ...req("retry"), problem: "replace" }));
    assert.equal((await restarted.handle(req("retry"))).phase, "ready");
    assert.deepEqual(f.calls[0]!.args, f.calls[1]!.args);
    assert.deepEqual(await readFile(join(f.files.directory, "form.json")), bytes);
    assert.equal(f.calls.filter(c => c.command === "rex_adopt").length, 1);
  } finally { await f.close(); }
});
test("lost adoption ACK retains task/input identities; recovery retrieves creation without opening or admitting", async () => {
  const f = await fixture(); f.loseAdopt();
  try {
    assert.equal((await f.wizard.handle({ version: 1, id: "c", action: "create", problem: "exact initial" })).phase, "blocked");
    const draft = (await startupDraft(f.record, f.files))!;
    assert.equal((await new DraftStore(f.record.hubId, f.root).load(draft.inputId)).request.requestId, draft.inputId);
    const count = f.calls.length;
    await f.wizard.handle(req("poll")); assert.equal(f.calls.length, count);
    assert.equal(await new AgentWizard(f.record, f.files, f.transport).recoverCreation(), "2");
    assert.equal(f.calls.length, count);
    assert.equal((await f.wizard.handle(req("retry"))).phase, "ready");
    const adopts = f.calls.filter(c => c.command === "rex_adopt"); assert.equal(adopts.length, 2); assert.deepEqual(adopts[0]!.args, adopts[1]!.args);
    assert.equal(f.calls.filter(c => c.command === "create_task_brief").length, 1);
  } finally { await f.close(); }
});
test("storage refusal precedes effects; immutable form and input-attempt fence survive a fresh client", async () => {
  const f = await fixture();
  try {
    await chmod(f.files.directory, 0o755); // Refused even when tests run as root.
    assert.equal((await f.wizard.handle({ version: 1, id: "c", action: "create", problem: "exact" })).phase, "blocked");
    assert.equal(f.calls.length, 0);
    await chmod(f.files.directory, 0o700);
    assert.equal((await new AgentWizard(f.record, f.files, f.transport).handle({ version: 1, id: "c", action: "create", problem: "exact" })).phase, "ready");
    const form = (await startupDraft(f.record, f.files))!, bytes = await readFile(join(f.files.directory, "form.json"));
    await assert.rejects(f.files.publish("form.json", { ...form, problem: "different" }), /identity conflict/);
    assert.deepEqual(await readFile(join(f.files.directory, "form.json")), bytes);
    assert.equal(await f.files.claim("input-attempt.json"), true);
    const reopened = new StartupFiles(f.files.directory);
    assert.equal(await reopened.claim("input-attempt.json"), false);
    assert.equal(await reopened.read("completed.json"), undefined, "attempt is not completion");
    assert.equal((await new DraftStore(f.record.hubId, f.root).load(form.inputId)).request.requestId, form.inputId);
    assert.equal(f.calls.filter(c => c.command === "create_task_brief").length, 1);
  } finally { await chmod(f.files.directory, 0o700); await f.close(); }
});
test("pending allocations poll observations only; binding drift fences transition; discard is not cancellation", async () => {
  const f = await fixture(); f.pending(true);
  try {
    assert.equal((await f.wizard.handle({ version: 1, id: "c", action: "create", problem: "exact" })).phase, "waiting");
    const before = f.calls.length;
    await f.wizard.handle(req("poll")); assert.deepEqual(f.calls.slice(before).map(c => c.command), ["rex_status"]);
    f.pending(false); f.drift(); assert.equal((await f.wizard.handle(req("poll"))).phase, "blocked");
    assert.equal((await f.wizard.handle(req("discard"))).phase, "blocked");
    assert.equal((await new DraftStore(f.record.hubId, f.root).list()).length, 0);
    const count = f.calls.length; await f.wizard.handle(req("retry")); assert.equal(f.calls.length, count);
    assert.ok(await f.files.read("form.json")); assert.ok(await f.files.read("discarded.json"));
  } finally { await f.close(); }
});
