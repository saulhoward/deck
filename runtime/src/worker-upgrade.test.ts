import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import { DeckRuntime } from "./deck.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";
import { upgrade } from "./worker-upgrade.js";
import { validRexRegistration } from "./remote-contracts.js";
import type { RexWorkerConnection, RexWorkerRegistry, RexWorkerUpgrade } from "./generated/contracts.js";
const oldDigest = "b".repeat(64), newDigest = "c".repeat(64), machine = "d".repeat(32);
const oldClient = "/tools/old-deck", client = "/tools/new-deck";
async function put(path: string, value: unknown) { await writeFile(path, JSON.stringify(value), { mode: 0o600 }); }
async function fixture(busy?: "task" | "queued" | "placed") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deck-offline-upgrade-"))), hub = join(root, "hub"), worker = join(root, "worker");
  await mkdir(hub, { mode: 0o700 }); await mkdir(worker, { mode: 0o700 }); await mkdir(join(worker, "operations"), { mode: 0o700 });
  const { models } = provider();
  const runtime = await DeckRuntime.open(join(hub, "session.sqlite"), { models, model, implementation: IMPLEMENTATION, binding: { machineId: "a".repeat(32), cwd: root }, environment: () => undefined });
  const hubId = runtime.hubId;
  await runtime.createTask("Retained task", { machineId: machine, cwd: root }, "retain-task");
  if (busy === "task") {
    const task = defineTask<{}, { phase: "parked" }, null>({ name: "test.upgrade-parked", version: 1, initial: () => ({ phase: "parked" }), phases: { parked: async () => {} }, abort: async () => {} });
    await runtime.main.commit(tx => tx.createTask(task, {}, { ownership: { kind: "conversation" }, background: true }), context);
  } else if (busy) await runtime.main.commit(async tx => {
    if (busy === "placed") {
      const entry = await tx.appendEntry(runtime.main.id, { kind: "test.input", model: [{ role: "user", content: "pending", timestamp: 0 }] });
      await tx.createSubmission({ conversationId: runtime.main.id, type: "input", status: "placed", entry: entry.id });
    } else await tx.createSubmission({ conversationId: runtime.main.id, type: "input", status: "queued" });
  }, context);
  await runtime.close();
  await put(join(hub, "config.json"), { version: 1, machine_id: "a".repeat(32) });
  await put(join(worker, "config.json"), { version: 1, machine_id: machine });
  const before: RexWorkerConnection = { version: 1, server: "https://hub.example", hostId: randomUUID(), account: "test", executable: "/tools/rex", hubId, hubPort: 52800, sessionId: `session:${randomUUID()}`, pid: 123, pendingSession: false, implementation: oldDigest, rexClient: { executable: oldClient, socket: "/tmp/retained-worker/client.sock" } };
  await put(join(worker, "rex-connection.json"), before);
  await put(join(worker, "operations", "1.json"), { hash: "e".repeat(64), result: null });
  await put(join(worker, "operations", "2.json"), { hash: "f".repeat(64), result: { ok: true, output: "original result" } });
  const registry: RexWorkerRegistry = { version: 1, hubId, hosts: [{ version: 1, hubId, machineId: machine, implementation: oldDigest, capabilities: ["files", "bash", "rex", "launcher"], rexClient: before.rexClient }] };
  await put(join(hub, "rex-workers.json"), registry);
  const plan = join(root, "plan.json"), approval = join(root, "approval.json");
  const prepare = () => upgrade({ mode: "prepare", state: worker, from: "", output: plan, client, implementation: newDigest });
  const approve = () => upgrade({ mode: "approve", state: hub, from: plan, output: approval, client, implementation: newDigest });
  const apply = () => upgrade({ mode: "apply", state: worker, from: approval, output: "", client, implementation: newDigest });
  return { root, hub, hubId, worker, before, registry, plan, approval, prepare, approve, apply, close: () => rm(root, { recursive: true, force: true }) };
}
async function bytes(path: string) { return readFile(path, "utf8"); }

test("offline administration cannot overwrite unresolved live custody", async () => {
  const f = await fixture();
  try {
    await f.prepare(); await f.approve();
    const plan = { version: 1, id: randomUUID(), hubId: f.hubId, machineId: machine, beforeImplementation: oldDigest, implementation: newDigest, beforeClient: f.before.rexClient, client: { executable: client, socket: f.before.rexClient.socket } };
    const local = join(f.worker, "live-handoff.json");
    await put(local, { plan, before: f.before, phase: "prepared" });
    await assert.rejects(f.prepare(), /Live handoff is unresolved/);
    await assert.rejects(f.apply(), /Live handoff is unresolved/);
    assert.deepEqual(JSON.parse(await bytes(join(f.worker, "rex-connection.json"))), f.before);
    const registryPath = join(f.hub, "rex-workers.json");
    const registry = JSON.parse(await bytes(registryPath)); registry.handoffs = [{ plan, phase: "committed" }];
    await put(registryPath, registry);
    const saved = await bytes(registryPath);
    await assert.rejects(f.approve(), /unresolved live handoffs/);
    assert.equal(await bytes(registryPath), saved);
  } finally { await f.close(); }
});

test("offline upgrade changes only paired pins, retains uncertainty, session, tasks and old client authority; retries are idempotent", async () => {
  const f = await fixture();
  try {
    const paths = [join(f.worker, "config.json"), join(f.worker, "operations", "1.json"), join(f.worker, "operations", "2.json"), join(f.hub, "config.json"), join(f.hub, "session.sqlite")];
    const originals = await Promise.all(paths.map(path => readFile(path)));
    const originalConnection = await bytes(join(f.worker, "rex-connection.json"));
    await f.prepare(); const plan = await bytes(f.plan); await f.prepare(); assert.equal(await bytes(f.plan), plan);
    const released = { version: 1 as const, id: randomUUID(), hubId: f.hubId, machineId: machine, beforeImplementation: oldDigest, implementation: newDigest, beforeClient: f.before.rexClient, client: { executable: client, socket: f.before.rexClient.socket } };
    await put(join(f.hub, "rex-workers.json"), { ...f.registry, handoffs: [{ plan: released, phase: "free_old" }] });
    assert.equal(await bytes(join(f.worker, "rex-connection.json")), originalConnection);
    await f.approve(); const registry = await bytes(join(f.hub, "rex-workers.json")); await f.approve(); assert.equal(await bytes(join(f.hub, "rex-workers.json")), registry);
    assert.equal(await bytes(join(f.worker, "rex-connection.json")), originalConnection, "hub approval does not rewrite worker custody");
    const updated = JSON.parse(registry) as RexWorkerRegistry;
    assert.equal(updated.handoffs, undefined, "new offline pins supersede the released receipt for this machine");
    const registration = updated.hosts[0]!;
    assert.equal(registration.implementation, newDigest); assert.equal(registration.rexClient.executable, client); assert.deepEqual(registration.previousClients, [f.before.rexClient]); assert.ok(validRexRegistration(registration));
    await f.apply(); const connection = await bytes(join(f.worker, "rex-connection.json")); await f.apply(); assert.equal(await bytes(join(f.worker, "rex-connection.json")), connection);
    assert.deepEqual(JSON.parse(connection), { ...f.before, implementation: newDigest, rexClient: { ...f.before.rexClient, executable: client } });
    for (const [index, path] of paths.entries()) assert.deepEqual(await readFile(path), originals[index], path);
  } finally { await f.close(); }
});

test("hub approval checks all canonical pending/background work and queued/placed submissions without resuming or changing source bytes", async () => {
  for (const busy of ["task", "queued", "placed"] as const) {
    const f = await fixture(busy);
    try {
      await f.prepare(); const database = await readFile(join(f.hub, "session.sqlite")), registry = await bytes(join(f.hub, "rex-workers.json"));
      await assert.rejects(f.approve(), /Unfinished work/);
      assert.deepEqual(await readFile(join(f.hub, "session.sqlite")), database); assert.equal(await bytes(join(f.hub, "rex-workers.json")), registry);
      await assert.rejects(readFile(f.approval), { code: "ENOENT" });
    } finally { await f.close(); }
  }
});

test("worker apply refuses changed receipts, identity, scope, pending session and wrong prepared package without pin reset", async () => {
  for (const change of ["receipt", "identity", "scope", "pending", "package", "unapproved"] as const) {
    const f = await fixture();
    try {
      await f.prepare(); await f.approve();
      if (change === "receipt") await put(join(f.worker, "operations", "1.json"), { hash: "a".repeat(64), result: null });
      if (change === "identity") await put(join(f.worker, "config.json"), { version: 1, machine_id: "e".repeat(32) });
      if (change === "scope") await put(join(f.worker, "rex-connection.json"), { ...f.before, account: "other" });
      if (change === "pending") await put(join(f.worker, "rex-connection.json"), { ...f.before, pendingSession: true });
      if (change === "unapproved") await put(f.approval, JSON.parse(await bytes(f.plan)));
      const original = await bytes(join(f.worker, "rex-connection.json"));
      await assert.rejects(change === "package" ? upgrade({ mode: "apply", state: f.worker, from: f.approval, output: "", client, implementation: "0".repeat(64) }) : f.apply());
      assert.equal(await bytes(join(f.worker, "rex-connection.json")), original);
    } finally { await f.close(); }
  }
});

test("lost hub acknowledgement can regenerate the same approval; stale plans cannot roll back a later transition", async () => {
  const f = await fixture();
  try {
    await f.prepare(); await f.approve(); await rm(f.approval);
    const savedPlan = JSON.parse(await bytes(f.plan)) as RexWorkerUpgrade;
    await put(f.plan, { ...savedPlan, receiptsHash: "0".repeat(64) });
    await assert.rejects(f.approve(), /different preparation evidence/);
    await assert.rejects(readFile(f.approval), { code: "ENOENT" });
    await put(f.plan, savedPlan); await f.approve(); await f.apply();
    await put(f.plan, { ...savedPlan, id: randomUUID() });
    const before = await bytes(join(f.hub, "rex-workers.json")); await assert.rejects(f.approve(), /no longer matches|another transition/);
    assert.equal(await bytes(join(f.hub, "rex-workers.json")), before);
  } finally { await f.close(); }
});

test("publication failure after hub commit leaves a recoverable transition, never an automatic rollback", { skip: process.getuid!() === 0 }, async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const original = await bytes(join(f.worker, "rex-connection.json"));
    // Reading the input and writing inside hub/ still work, but publishing the
    // external approval fails only AFTER the durable registry update.
    await chmod(f.root, 0o500);
    await assert.rejects(f.approve(), { code: "EACCES" });
    const committed = await bytes(join(f.hub, "rex-workers.json"));
    assert.equal(JSON.parse(committed).hosts[0].implementation, newDigest);
    assert.equal(await bytes(join(f.worker, "rex-connection.json")), original);
    await assert.rejects(readFile(f.approval), { code: "ENOENT" });
    await chmod(f.root, 0o700); await f.approve();
    assert.equal(await bytes(join(f.hub, "rex-workers.json")), committed);
    await chmod(f.worker, 0o500);
    await assert.rejects(f.apply(), { code: "EACCES" });
    assert.equal(await bytes(join(f.worker, "rex-connection.json")), original);
    await chmod(f.worker, 0o700); await f.apply();
    assert.equal(JSON.parse(await bytes(join(f.worker, "rex-connection.json"))).implementation, newDigest);
  } finally { await chmod(f.root, 0o700); await chmod(f.worker, 0o700); await f.close(); }
});

test("hub refuses scope/capability drift and a full predecessor list without dropping prior client authority", async () => {
  for (const change of ["hub", "machine", "implementation", "socket", "capabilities", "history-limit"] as const) {
    const f = await fixture();
    try {
      await f.prepare();
      const changed = structuredClone(f.registry), host = changed.hosts[0]!;
      if (change === "hub") { changed.hubId = randomUUID(); host.hubId = changed.hubId; }
      if (change === "machine") host.machineId = "f".repeat(32);
      if (change === "implementation") host.implementation = "f".repeat(64);
      if (change === "socket") host.rexClient.socket = "/different/socket";
      if (change === "capabilities") host.capabilities = ["files", "bash", "rex", "mcp", "launcher"];
      if (change === "history-limit") host.previousClients = Array.from({ length: 8 }, (_, i) => ({ ...host.rexClient, executable: `/tools/older-${i}` }));
      await put(join(f.hub, "rex-workers.json"), changed); const before = await bytes(join(f.hub, "rex-workers.json"));
      await assert.rejects(f.approve()); assert.equal(await bytes(join(f.hub, "rex-workers.json")), before);
      await assert.rejects(readFile(f.approval), { code: "ENOENT" });
    } finally { await f.close(); }
  }
});

test("successive upgrades accumulate exact prior client scopes instead of discarding old allocations", async () => {
  const f = await fixture();
  try {
    await f.prepare(); await f.approve(); await f.apply();
    const plan = join(f.root, "second-plan.json"), approval = join(f.root, "second-approval.json"), next = "/tools/next-deck", implementation = "f".repeat(64);
    await upgrade({ mode: "prepare", state: f.worker, from: "", output: plan, client: next, implementation });
    await upgrade({ mode: "approve", state: f.hub, from: plan, output: approval, client: next, implementation });
    await upgrade({ mode: "apply", state: f.worker, from: approval, output: "", client: next, implementation });
    const registered = (JSON.parse(await bytes(join(f.hub, "rex-workers.json"))) as RexWorkerRegistry).hosts[0]!;
    assert.deepEqual(registered.previousClients, [{ ...f.before.rexClient, executable: client }, f.before.rexClient]);
    assert.equal(registered.rexClient.executable, next);
  } finally { await f.close(); }
});

test("preparation refuses unsupported receipt formats, symlinks, insecure metadata and incomplete enrollment", async () => {
  for (const invalid of ["format", "symlink", "permissions", "pending", "missing-hub", "socket"] as const) {
    const f = await fixture();
    try {
      const path = join(f.worker, "operations", "1.json");
      if (invalid === "format") await put(path, { hash: "e".repeat(64), futureReceipt: true });
      if (invalid === "symlink") { await rm(path); await symlink(join(f.worker, "operations", "2.json"), path); }
      if (invalid === "permissions") await chmod(join(f.worker, "rex-connection.json"), 0o644);
      if (invalid === "pending") await put(join(f.worker, "rex-connection.json"), { ...f.before, pendingSession: true });
      if (invalid === "missing-hub") { const { hubId: _, ...rest } = f.before; await put(join(f.worker, "rex-connection.json"), rest); }
      if (invalid === "socket") await put(join(f.worker, "rex-connection.json"), { ...f.before, rexClient: { executable: oldClient, socket: "relative" } });
      await assert.rejects(f.prepare()); await assert.rejects(readFile(f.plan), { code: "ENOENT" });
    } finally { await f.close(); }
  }
});
