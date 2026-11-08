import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import { ChatDoc, DeckRuntime } from "./deck.js";
import type { RexPlan, RexTarget } from "./rex-allocation.js";
import type { FileResult, HostFiles } from "./host-files.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";
import { fakeRex, REX_UUID as uuid } from "./rex-allocation.test.support.js";
const target: RexTarget = { executable: "/rex", client: "/deck", server: "unix:///tmp/rex.sock", hostId: uuid, instanceId: uuid, port: 52800 };
const binding = { machineId: "worker", cwd: "/saved" };
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function setup(read: HostFiles["call"]) {
  const root = await mkdtemp(join(tmpdir(), "deck-rex-inspection-")); const { models } = provider(); let calls = 0;
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, binding, implementation: IMPLEMENTATION, environment: () => undefined, hostFiles: { call: async (...args) => {
    if (args[2] !== "rex_allocate") { calls++; assert.equal(args[2], "rex_inspect"); assert.ok(BigInt(args[1]) >= 1n << 63n); assert.deepEqual(args[0], binding); return read(...args); }
    const plan = JSON.parse(String(args[3].plan)) as RexPlan;
    return { ok: true, code: "allocated", output: JSON.stringify({ version: 1, ...plan, sessionId: `session:${uuid}`, windowId: `window:${uuid}`, blockId: `block:${uuid}`, readiness: "not_checked" }) };
  } } });
  const chat = await runtime.createTask("Inspect", binding, "task"); const id = String(chat.id);
  const taskId = await runtime.allocateTerminal(id, "allocation", target); await runtime.harness.waitForTask(taskId, context);
  return { runtime, id, chat, calls: () => calls, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
function observation(args: Parameters<HostFiles["call"]>[3], state = "running", patch = {}): FileResult {
  const query = JSON.parse(String(args.plan));
  return { ok: true, code: "rex_inspected", output: JSON.stringify({ version: 1, scope: query.scope, state, exitCode: state === "exited" ? 7 : null, revision: 1, ...patch }) };
}

test("fresh internal inspection preserves provenance/history and writes no Pi records or native task", async () => {
  const local = await setup(async (_binding, _id, _operation, args) => observation(args));
  try {
    const binding = await local.runtime.terminalBinding(local.id); const history = await local.runtime.history(local.id);
    let writes = 0; const unsubscribe = local.runtime.harness.subscribeCommits((publication) => { writes += publication.changes.length; });
    const first = await local.runtime.inspectTerminal(local.id); const second = await local.runtime.inspectTerminal(local.id);
    assert.equal(first.status, "sampled"); assert.equal(first.observation?.state, "running"); assert.notEqual(first.requestId, second.requestId); assert.equal(local.calls(), 2);
    assert.deepEqual(await local.runtime.terminalBinding(local.id), binding); assert.deepEqual(await local.runtime.history(local.id), history);
    assert.equal((await local.runtime.terminalStartup(local.id)).observation, "not_observed"); assert.equal(writes, 0); unsubscribe();
    assert.equal((await local.runtime.harness.inspect(context)).tasks.length, 0);
    assert.equal((await local.runtime.inspectTerminal(String(local.runtime.main.id))).status, "unbound");
    assert.equal(local.calls(), 2); // No label lookup/adoption for absent bindings.
  } finally { await local.close(); }
});

test("inspection rejects malformed/scope-drifted results, keeps failed reads inconclusive, and never retries effects", async () => {
  let mode = "running";
  const local = await setup(async (_binding, _id, _op, args) => {
    if (mode === "throw") throw new Error("PRIVATE_FAILURE");
    if (mode === "malformed") return { ok: true, code: "rex_inspected", output: "PRIVATE_BAD" };
    if (mode === "scope") return observation(args, "missing_session", { scope: { ...JSON.parse(String(args.plan)).scope, blockId: `block:00000000-0000-0000-0000-000000000000` } });
    if (mode === "private") return observation(args, "running", { private: "PRIVATE_ERROR" });
    if (mode === "badexit") return observation(args, "exited", { exitCode: null });
    if (mode === "offline") return { ok: false, code: "offline", output: "PRIVATE_WORKER" };
    return observation(args);
  });
  try {
    for (mode of ["throw", "malformed", "scope", "private", "badexit"]) {
      const result = await local.runtime.inspectTerminal(local.id); assert.equal(result.observation?.state, "inconclusive"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    }
    mode = "offline"; assert.equal((await local.runtime.inspectTerminal(local.id)).observation?.state, "unavailable");
    assert.equal(local.calls(), 6); await assert.rejects(local.runtime.allocateTerminal(local.id, "fresh", target), { code: "conflict" });
  } finally { await local.close(); }
});

test("in-flight inspection is bounded, cancellable, independent of admission and fenced against binding ABA", async () => {
  const entered = deferred(), release = deferred();
  const local = await setup(async (_binding, _id, _op, args) => { entered.release(); await release.promise; return observation(args, "missing_session"); });
  try {
    const reading = local.runtime.inspectTerminal(local.id); await entered.promise;
    await assert.rejects(local.runtime.inspectTerminal(local.id), { code: "busy" });
    // Admission is not held by worker I/O. Even change+restore fences this sample.
    await local.chat.commit(async (tx) => { (await tx.doc(ChatDoc, local.chat.id)).cwd = "/other"; (await tx.doc(AgentDoc, local.chat.id)).cwd = "/other"; }, context);
    await local.chat.commit(async (tx) => { (await tx.doc(ChatDoc, local.chat.id)).cwd = binding.cwd; (await tx.doc(AgentDoc, local.chat.id)).cwd = binding.cwd; }, context);
    await local.runtime.createTask("Independent", binding, "independent");
    release.release(); const result = await reading; assert.equal(result.status, "stale"); assert.equal(result.observation, null);
    const abort = new AbortController(); abort.abort();
    assert.equal((await local.runtime.inspectTerminal(local.id, abort.signal)).status, "cancelled"); assert.equal(local.calls(), 1);
    await local.chat.commit(async (tx) => { (await tx.doc(AgentDoc, local.chat.id)).cwd = "/raw-drift"; }, context);
    assert.equal((await local.runtime.inspectTerminal(local.id)).status, "conflict"); assert.equal(local.calls(), 1);
  } finally { release.release(); await local.close(); }
});

test("inspection caps active reads at four and suppresses a late result after cancellation", async () => {
  const entered = deferred(), release = deferred(); const ids = new Set<string>();
  const local = await setup(async (_binding, id, _op, args) => { assert.ok(!ids.has(id)); ids.add(id); if (ids.size === 4) entered.release(); await release.promise; return observation(args, "missing_session"); });
  try {
    const chats = [local.id];
    for (let i = 0; i < 4; i++) { const chat = await local.runtime.createTask(`Task ${i}`, binding, `task-${i}`); const id = String(chat.id); const task = await local.runtime.allocateTerminal(id, `allocate-${i}`, target); await local.runtime.harness.waitForTask(task, context); chats.push(id); }
    const abort = new AbortController(); const reads = chats.slice(0, 4).map((id, index) => local.runtime.inspectTerminal(id, index === 0 ? abort.signal : undefined));
    await entered.promise; await assert.rejects(local.runtime.inspectTerminal(chats[4]!), { code: "busy" });
    abort.abort(); release.release(); const results = await Promise.all(reads);
    assert.equal(results[0]?.status, "cancelled"); assert.equal(results[0]?.observation, null);
    assert.ok(results.slice(1).every((result) => result.status === "sampled"));
    assert.equal((await local.runtime.inspectTerminal(chats[4]!)).status, "sampled"); assert.equal(ids.size, 5);
  } finally { release.release(); await local.close(); }
});

const binary = process.env.DECK_TEST_BINARY;
test("native exact-object inspection: scoped presence states, failures, cancellation and no read receipts", { skip: !binary, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-rex-inspect-native-"));
  try {
    assert.equal(spawnSync(binary!, ["init", "--directory", root]).status, 0); await fakeRex(root);
    const result = spawnSync(binary!, ["serve", "--stdio", "--mock", "--directory", root, "--workspace", root, "--runtime", resolve("runtime/dist/rex-inspection.test.fixture.js")], { env: { ...process.env, DECK_TEST_BINARY: binary, OPENAI_API_KEY: "PRIVATE_CREDENTIAL", REX_SERVER: "WRONG_AMBIENT_SERVER" }, encoding: "utf8", timeout: 80_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { running: "running", pending: "pending", "pending-omitted": "pending", exited: "exited", "missing-session": "missing_session", "missing-terminal": "missing_terminal", detached: "conflict", "detached-omitted": "conflict", duplicate: "conflict", "host-conflict": "conflict", "wrong-window": "conflict", partial: "inconclusive", inconsistent: "inconclusive", "mixed-404": "inconclusive", "process-malformed": "inconclusive", "api-mismatch": "inconclusive", identity: "identity_changed", "identity-after": "identity_changed", revision: "inconclusive", malformed: "inconclusive", flood: "inconclusive", "spoof-stdout": "inconclusive", forbidden: "inconclusive", timeout: "inconclusive", cancel: "cancelled" });
    const calls = (await readFile(join(root, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).slice(5) as string[]);
    assert.equal(calls.filter((args) => args[0] === "new").length, 1);
    assert.ok(calls.every((args) => ["new", "server", "api", "block"].includes(args[0]!)));
    assert.ok(calls.filter((args) => args[0] === "api").every((args) => ["session.view", "session.list_blocks", "com.superlogical.terminal.process"].includes(args[2]!)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
