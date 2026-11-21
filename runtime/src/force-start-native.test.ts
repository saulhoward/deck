import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DeckRuntime } from "./deck.js";
import { type RexWorkerRegistration, type RexWorkerRegistry, type WorkerHandoffPlan } from "./generated/contracts.js";
import { hubCommand } from "./hub-client.js";
import { freeHubPort } from "./hub-port.test.support.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
const binary = process.env.DECK_TEST_BINARY;
const parked = defineTask<{}, { phase: "parked" }, null>({ name: "test.force-parked", version: 1, initial: () => ({ phase: "parked" }), phases: { parked: async () => {} }, abort: async () => {} });

test("serve --force discards incompatible work offline and durably unlocks workers without losing pins or late handoff ACKs", { skip: !binary, timeout: 45000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "deck-force-native-")), db = join(state, "session.sqlite"), registry = join(state, "rex-workers.json");
  const env = { ...process.env, HOME: state, DECK_NODE: process.execPath, DECK_RUNTIME_ROOT: resolve(".") };
  const invoke = (...args: string[]) => spawnSync(binary!, [...args, "--directory", state], { input: encodeFrame({ version: 1, id: "status", command: "status" }), env, timeout: 12000 });
  const readRegistry = async (): Promise<RexWorkerRegistry> => JSON.parse(await readFile(registry, "utf8"));
  try {
    assert.equal(invoke("init").status, 0);
    const machine = JSON.parse(await readFile(join(state, "config.json"), "utf8")).machine_id;
    const { models } = provider();
    const runtime = await DeckRuntime.open(db, { models, model, implementation: IMPLEMENTATION, binding: { machineId: machine, cwd: state }, environment: () => undefined });
    const hubId = runtime.hubId, machineId = "b".repeat(32);
    const workerChat = await runtime.createTask("Worker", { machineId, cwd: state });
    const interrupted = await workerChat.commit(tx => tx.createTask(parked, {}, { ownership: { kind: "conversation" } }), ctx);
    await runtime.close();
    const plan = (machineId: string): WorkerHandoffPlan => ({ version: 1, id: randomUUID(), hubId, machineId, beforeImplementation: "a".repeat(64), beforeClient: { executable: "/old", socket: "/private/client.sock" }, implementation: "c".repeat(64), client: { executable: "/new", socket: "/private/client.sock" } });
    // Hash in native contract field order; object spreading the registration is not approval evidence.
    const prepared = plan(machineId), committed = plan("d".repeat(32));
    const planHash = (p: WorkerHandoffPlan) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
    const hosts: RexWorkerRegistration[] = [prepared, committed].map((p, i) => ({
      version: 1, hubId, machineId: p.machineId, capabilities: ["files", "bash", "rex", "launcher"], implementation: i ? p.implementation : p.beforeImplementation, rexClient: i ? p.client : p.beforeClient,
      ...(i ? { previousClients: [p.beforeClient], upgradeId: p.id, upgradeHash: planHash(p) } : {}),
    }));
    const saved: RexWorkerRegistry = { version: 1, hubId, hosts, handoffs: [{ phase: "prepared", plan: prepared }, { phase: "committed", plan: committed }] };
    await writeFile(registry, JSON.stringify({ version: 1, hubId: randomUUID(), hosts: [] }), { mode: 0o600 });
    const wrong = invoke("serve", "--mock", "--stdio", "--force");
    assert.notEqual(wrong.status, 0); assert.match(wrong.stderr.toString(), /Hub identity differs/);
    await writeFile(registry, JSON.stringify(saved));
    await chmod(state, 0o710);
    try {
      const unsafe = invoke("serve", "--mock", "--stdio", "--force");
      assert.notEqual(unsafe.status, 0); assert.match(unsafe.stderr.toString(), /owner-only state directory/);
      assert.deepEqual(await readRegistry(), saved);
    } finally { await chmod(state, 0o700); }
    const receipt = join(state, "worker/operations", `${interrupted}.json`), evidence = `{"hash":"${"f".repeat(64)}","result":null}\n`;
    await mkdir(join(state, "worker/operations"), { recursive: true }); await writeFile(receipt, evidence, { mode: 0o600 });
    const normal = invoke("serve", "--mock", "--stdio");
    assert.notEqual(normal.status, 0); assert.match(normal.stderr.toString(), /Unfinished work requires the original Deck implementation/);
    assert.deepEqual(await readRegistry(), saved);
    const forced = invoke("serve", "--mock", "--stdio", "--force");
    assert.equal(forced.status, 0, forced.stderr.toString()); assert.equal(JSON.parse(forced.stdout.subarray(4).toString()).result.hubId, hubId);
    assert.match(forced.stderr.toString(), /settled 1 unfinished tasks/); assert.match(forced.stderr.toString(), /released 2 hub-side worker handoff locks/);
    const released = await readRegistry(); assert.deepEqual(released.hosts, hosts); assert.deepEqual(released.handoffs?.map(s => s.phase), ["free_old", "free_new"]);
    for (const [i, handoff] of released.handoffs!.entries()) {
      const before = saved.handoffs![i]!;
      assert.deepEqual(handoff.plan, before.plan);
      assert.ok(Buffer.byteLength(JSON.stringify(handoff)) <= Buffer.byteLength(JSON.stringify(before)), "releasing even a full 64 KiB registry must not need more bytes");
    }
    assert.equal(await readFile(receipt, "utf8"), evidence);

    // New work AFTER the discard. A delayed protocol-1 commit must not carry the
    // old preparation across this work. The unrelated committed worker needs only its ACK.
    const paused = await Harness.open(await openNodeSqliteStorage(db), { models, registry: createRegistry() }, ctx);
    try { await paused.commit(tx => tx.createTask(parked, {}, { conversationId: workerChat.id, ownership: { kind: "conversation" } }), ctx); }
    finally { await paused.close(ctx); }
    const port = await freeHubPort();
    const hub = spawn(binary!, ["serve", "--mock", "--port", String(port), "--directory", state], { env });
    const closed = once(hub, "close"); let log = ""; hub.stdout.resume(); hub.stderr.on("data", b => { log += b; });
    const exchange = async (action: string, plan: WorkerHandoffPlan) => {
      const sock = createConnection({ host: "127.0.0.1", port: port + 1 });
      const decoder = sock.pipe(new FrameDecoder()); sock.on("error", e => decoder.destroy(e));
      try {
        const response = once(decoder, "data", { signal: AbortSignal.timeout(6000) });
        sock.write(encodeFrame({ kind: "worker_upgrade", action, plan }));
        const [reply] = await response;
        assert.equal(reply.id, plan.id); assert.equal(reply.hubId, hubId); return reply.status;
      } finally { sock.destroy(); decoder.destroy(); }
    };
    try {
      for (let i = 0; !log.includes("hub listening"); i++) {
        assert.ok(i < 250 && hub.exitCode === null && hub.signalCode === null, log); await new Promise(r => setTimeout(r, 20));
      }
      assert.equal((await hubCommand(port, "status") as { hubId: string }).hubId, hubId);
      for (const host of hosts) assert.ok(await hubCommand(port, "create_task", { machineId: host.machineId, title: "Unlocked", cwd: state, requestId: randomUUID() }, hubId));
      assert.equal(await exchange("probe", { ...prepared, id: randomUUID() }), "supported", "released receipt does not own future upgrades");
      assert.equal(await exchange("commit", { ...prepared, client: { ...prepared.client, executable: "/wrong" } }), "deferred");
      assert.equal(await exchange("commit", committed), "committed", "exact lost ACK, no native work");
      assert.equal(await exchange("commit", prepared), "deferred", "freshly admitted work blocks a new prepare");
      assert.deepEqual(await readRegistry(), released);
      await hubCommand(port, "stop", { chatId: String(workerChat.id) }, hubId);
      assert.equal(await exchange("commit", prepared), "committed", "re-prepare under current exclusion before publishing replacement pins");
      assert.equal((await readRegistry()).hosts[0]!.upgradeId, prepared.id);
      assert.equal(await readFile(receipt, "utf8"), evidence);
    } finally { if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM"); await closed; }
  } finally { await rm(state, { recursive: true, force: true }); }
});
