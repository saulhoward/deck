import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { RexBinding, RexResult, RexStartup } from "./rex-allocation.js";
import type { ReconcileResult } from "./rex-reconciliation.js";
import type { RexInspectionSnapshot } from "./generated/contracts.js";

// Deliberately opt-in: never connect to an operator's existing Rex server. Rex is
// externally managed, not installed/downloaded by the build or normal test suite.
const rexBinary = process.env.DECK_TEST_REX;
const deckBinary = process.env.DECK_TEST_BINARY;
type Allocation = { session_id: string; initial_windows: { window_id: string; block_ids: string[] }[] };
type Run = { window_id: string; block_ids: string[] };
type ProcessState = { child: { pid: number } | null; last_exit: { exit_code: number } | null };
type Sessions = { sessions: { session_id: string; label: string }[] };
type BlockView = { block: { block_id: string; window_id: string; label: string } };
type HubStatus = { mainChatId: string; hubId: string; binding: { machineId: string; cwd: string }; activity: { tasks: unknown[]; submissions: unknown[] } };
type HubReplies = { status: HubStatus; list_chats: { items: unknown[] }; create_task: { chatId: string } };
type HubReply<N extends string> = N extends keyof HubReplies ? HubReplies[N] : Record<string, unknown>;
type ScratchChild = { args: string[]; cwd: string; hasProviderKey: boolean; block: string; pid: number };
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const value = await read(); if (check(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Scratch Rex condition not observed");
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close"); child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await closed; } finally { clearTimeout(timer); }
}
function fullId(value: string, kind: string) { assert.match(value, new RegExp(`^${kind}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)); }

test("installed Rex contract: isolated local server, argv, stable IDs, ambiguous creation and central Deck clients", { skip: !rexBinary || !deckBinary, timeout: 90_000 }, async (t) => {
  assert.ok(isAbsolute(rexBinary!) && isAbsolute(deckBinary!), "Supply absolute test executable paths");
  await access(rexBinary!, constants.X_OK); await access(deckBinary!, constants.X_OK);
  // Short Unix path (macOS socket limit); 0700 root, explicit empty config, no
  // restore/autostart/tailnet/user daemon. No credentials copied into children.
  const root = await mkdtemp("/tmp/deck-rex-contract-"); await mkdir(join(root, "work with spaces 🌍"));
  const work = await realpath(join(root, "work with spaces 🌍"));
  const emptyConfig = join(root, "empty.lua"); await writeFile(emptyConfig, "", { mode: 0o600 });
  const endpoint = `unix://${root}/rex.sock`;
  const env = { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), TERM: "xterm-256color", LANG: "en_US.UTF-8",
    DECK_CLIENT_STATE_DIRECTORY: join(root, "client"), DECK_NODE: process.execPath, DECK_RUNTIME_ROOT: resolve("."),
  };
  const rex = async (...args: string[]): Promise<string> => new Promise((accept, reject) => {
    execFile(rexBinary!, ["--autostart=false", "--timeout", "2s", "--server", endpoint, ...args], { env, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Scratch rex ${args[0]} failed: ${stderr.slice(0, 512)}`)); else accept(stdout);
    });
  });
  const json = async <T>(...args: string[]): Promise<T> => JSON.parse(await rex(...args)) as T;
  let rexErrors = "";
  const server = spawn(rexBinary!, ["server", "run", "--listen", endpoint, "--state-dir", join(root, "rex-state"), "--config", emptyConfig, "--restore=false", "--max-sessions", "8", "--max-blocks", "12", "--max-windows", "8"], { env });
  server.on("error", () => { rexErrors = "Scratch Rex server failed to launch"; });
  server.stdout.resume(); server.stderr.on("data", (chunk) => { rexErrors = (rexErrors + String(chunk)).slice(-8192); });
  let hub: ChildProcess | undefined; const sessionIds: string[] = [];
  let allocation!: Allocation; let blockId = ""; let firstPid = 0;
  const record = join(root, "argv.json"); const release = join(root, "release"); const state = join(root, "deck");
  const label = `deck-test-${root.split("-").at(-1)}`;
  const newSession = async (name: string, argv: string[]) => {
    const value = await json<Allocation>("new", name, "--json", "--cwd", work, "--shell=none", "--keep-open", "--", ...argv);
    fullId(value.session_id, "session"); sessionIds.push(value.session_id);
    assert.equal(value.initial_windows.length, 1); fullId(value.initial_windows[0]!.window_id, "window");
    assert.equal(value.initial_windows[0]!.block_ids.length, 1); fullId(value.initial_windows[0]!.block_ids[0]!, "block"); return value;
  };
  const inspectProcess = (sid: string, bid: string) => json<ProcessState>("block", "call", "process", "--session", sid, "--block", bid);
  const childPid = async (sid: string, bid: string) => { const { child } = await inspectProcess(sid, bid); assert.ok(child); return child.pid; };
  const exit = async (sid: string, bid: string) => { const value = await until(() => inspectProcess(sid, bid), (value) => !!value.last_exit); assert.ok(value.last_exit); return value.last_exit; };
  try {
    await until(async () => { try { await access(join(root, "rex.sock")); return true; } catch { return false; } }, Boolean);
    await t.test("explicit Unix endpoint has no sessions/tailnet and caller schemas advertise no idempotency key", async () => {
      const status = await json<{ endpoint: string; session_count: number; tailscale: { state: string }; you: { transport: string }; api_revision: number; rex_version: string }>("server", "status", "--json");
      assert.equal(status.endpoint, endpoint); assert.equal(status.session_count, 0); assert.equal(status.tailscale.state, "disabled"); assert.equal(status.you.transport, "unix");
      assert.equal((await stat(join(root, "rex.sock"))).mode & 0o077, 0);
      assert.ok([8, 10].includes(status.api_revision), `Unvalidated Rex API ${status.api_revision}`);
      await assert.rejects(rex("api", "call", "session.view", JSON.stringify({ session_id: "session:00000000-0000-4000-8000-000000000001" })), /status=404 code=session_not_found/);
      t.diagnostic(`Rex ${status.rex_version}; API revision ${status.api_revision}; isolated Unix server`);
      const schema = await json<{ input_schema: { properties: Record<string, unknown>; additionalProperties: boolean } }>("api", "describe", "session.create", "--json");
      assert.deepEqual(Object.keys(schema.input_schema.properties).sort(), ["initial_windows", "label"]);
      assert.equal(schema.input_schema.additionalProperties, false);
      const window = await json<{ input_schema: { properties: Record<string, unknown>; additionalProperties: boolean } }>("api", "describe", "session.new_window", "--json");
      assert.deepEqual(Object.keys(window.input_schema.properties).sort(), ["focus", "layout", "session_id", "window_label"]);
      assert.equal(window.input_schema.additionalProperties, false); // No expected revision/process guard or idempotency key.
      const close = await json<{ input_schema: { properties: Record<string, unknown>; additionalProperties: boolean } }>("api", "describe", "block.close", "--json");
      assert.deepEqual(Object.keys(close.input_schema.properties).sort(), ["block_id", "keep_last", "session_id", "window_id"]);
      assert.equal(close.input_schema.additionalProperties, false);
      // API 10 advertises additionalProperties:false but ignores invented guard
      // fields on this call! Repeated identical "idempotency" arguments still
      // create distinct sessions. Metadata is not runtime guard enforcement.
      if (status.api_revision === 10) {
        const request = JSON.stringify({ label: "unsupported-guard", expected_revision: -1, idempotency_key: "scratch-only" });
        const first = await json<{ session_id: string }>("api", "call", "session.create", request);
        sessionIds.push(first.session_id);
        const second = await json<{ session_id: string }>("api", "call", "session.create", request);
        sessionIds.push(second.session_id);
        assert.notEqual(first.session_id, second.session_id);
        assert.equal((await json<Sessions>("session", "ls", "--json", "--short=false")).sessions.length, 2);
        await rex("session", "kill", first.session_id); await rex("session", "kill", second.session_id);
      }
      assert.equal((await json<Sessions>("session", "ls", "--json", "--short=false")).sessions.length, 0);
    });
    await t.test("direct argv preserves metacharacters/cwd; terminals outlive creation CLI connections", async () => {
      const literal = ["space argument", "$(touch INJECTED)", "; touch INJECTED", "--server=not-an-option", "quotes'\"", "line\nbreak", "🌍"];
      allocation = await newSession(label, [process.execPath, fileURLToPath(new URL("./rex-contract.test.fixture.js", import.meta.url)), record, release, ...literal]);
      blockId = allocation.initial_windows[0]!.block_ids[0]!;
      const observed = await until(async () => { try { return JSON.parse(await readFile(record, "utf8")) as ScratchChild; } catch { return undefined; } }, (value) => !!value);
      assert.deepEqual(observed!.args, literal); assert.equal(observed!.cwd, work); assert.equal(observed!.hasProviderKey, false);
      assert.equal(observed!.block, blockId); // Rex-supplied native block identity, not a label.
      firstPid = observed!.pid; assert.doesNotThrow(() => process.kill(firstPid, 0));
      await assert.rejects(access(join(work, "INJECTED")), { code: "ENOENT" });
      const processState = await inspectProcess(allocation.session_id, blockId);
      assert.equal(processState.child?.pid, firstPid);
      assert.equal(await readFile(`${record}.starts`, "utf8"), "start\n");
    });
    await t.test("full session/window/block IDs survive label changes and fresh CLI connections", async () => {
      await assert.rejects(rex("block", "ls", "--all", "--json"), /requires one session/i);
      const sid = allocation.session_id; const wid = allocation.initial_windows[0]!.window_id;
      await rex("session", "rename", sid, "renamed session");
      await rex("window", "rename", wid, "renamed window", "--session", sid);
      await rex("block", "rename", blockId, "renamed block", "--session", sid);
      const session = await json<{ session_id: string; windows: { window_id: string }[] }>("session", "inspect", sid, "--json");
      const block = await json<BlockView>("block", "inspect", blockId, "--session", sid, "--json");
      assert.equal(session.session_id, sid); assert.equal(session.windows[0]!.window_id, wid);
      assert.equal(block.block.block_id, blockId); assert.equal(block.block.window_id, wid); assert.equal(block.block.label, "renamed block");
      assert.equal(await childPid(sid, blockId), firstPid);
    });
    await t.test("discarding a creation ACK does not make retry safe: duplicate labels create different IDs", async () => {
      // Intentionally do not use the first ACK for lookup; enumerate this isolated
      // server just as a reconciler with a lost response would. This is NOT a
      // production auto-adopter or an assertion that labels prove provenance.
      const first = await newSession(label, [process.execPath, "-e", "setInterval(()=>{},1000)"]);
      const listed = (await json<Sessions>("session", "ls", "--json", "--short=false")).sessions;
      assert.deepEqual(listed.filter((row) => row.label === label).map((row) => row.session_id), [first.session_id]);
      const duplicate = await newSession(label, [process.execPath, "-e", "setInterval(()=>{},1000)"]);
      assert.notEqual(duplicate.session_id, first.session_id);
      const ambiguous = (await json<Sessions>("session", "ls", "--json", "--short=false")).sessions;
      assert.equal(ambiguous.filter((row) => row.label === label).length, 2);
      await assert.rejects(rex("session", "inspect", label, "--json"), /ambiguous/i);
      await rex("session", "kill", first.session_id, duplicate.session_id);
    });
    await t.test("keep-open retains an exited child without silently rerunning it", async () => {
      await writeFile(release, "exit");
      assert.equal((await exit(allocation.session_id, blockId)).exit_code, 7);
      assert.equal((await json<BlockView>("block", "inspect", blockId, "--session", allocation.session_id, "--json")).block.block_id, blockId);
      assert.equal(await readFile(`${record}.starts`, "utf8"), "start\n");
    });

    // The rest uses a separate scratch Deck --mock store, never the live hub.
    assert.equal(spawnSync(deckBinary!, ["init", "--directory", state], { env, cwd: resolve(".") }).status, 0);
    const config = JSON.parse(await readFile(join(state, "config.json"), "utf8")) as { machine_id: string };
    const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
    await new Promise<void>((accept) => probe.close(() => accept()));
    let expectedHubId: string | undefined;
    const command = async <N extends string>(name: N, args = {}): Promise<HubReply<N>> => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, id: "rex-contract", command: name, args, hubId: expectedHubId }), signal: AbortSignal.timeout(1000) });
      const result = await response.json() as { ok: boolean; result: HubReply<N> }; assert.equal(result.ok, true); return result.result;
    };
    const startHub = async () => {
      hub = spawn(deckBinary!, ["serve", "--mock", "--directory", state, "--workspace", work, "--port", String(port), "--runtime", fileURLToPath(new URL("./rex-contract.test.hub.js", import.meta.url))], { env: { ...env, DECK_REX_ALLOC_REQUEST: join(state, "allocator-request") }, cwd: resolve(".") });
      hub.on("error", () => {}); hub.stdout!.resume(); hub.stderr!.resume();
      // Do not mistake another process winning the ephemeral-port race for ours.
      return until(() => command("status").catch(() => undefined), (value) => value?.binding.machineId === config.machine_id && value.binding.cwd === work);
    };
    const status = (await startHub())!; expectedHubId = status.hubId;
    const task = await command("create_task", { requestId: "rex-task", title: "Rex scratch task", ...status.binding });
    const clientArgv = [deckBinary!, "agent", "--no-tui", "--port", String(port), "--task", String(task.chatId)];
    let clientAllocation!: Allocation; let clientBlock = ""; let clientPid = 0;
    const capture = () => rex("capture", "--session", clientAllocation.session_id, "--block", clientBlock, "--trim", "--unwrap");
    await t.test("Rex hosts a normal ownerless chat client; typed input reaches only the saved hub conversation", async () => {
      clientAllocation = await newSession("deck-client-proof", clientArgv); clientBlock = clientAllocation.initial_windows[0]!.block_ids[0]!;
      await until(capture, (text) => text.includes(`Deck chat ${task.chatId}`));
      clientPid = await childPid(clientAllocation.session_id, clientBlock);
      // Test-only simulation of a human typing, not model orchestration via rex send.
      await rex("send", "--session", clientAllocation.session_id, "--block", clientBlock, "TERMINAL_TYPED_INPUT\n");
      await until(() => command("history", { chatId: task.chatId }), (value) => JSON.stringify(value).includes("no inference performed"));
      assert.match(JSON.stringify(await command("history", { chatId: task.chatId })), /TERMINAL_TYPED_INPUT/);
      assert.doesNotMatch(JSON.stringify(await command("history", { chatId: status.mainChatId })), /TERMINAL_TYPED_INPUT/);
      await until(capture, (text) => text.includes("assistant: Deck prototype response"));
      assert.equal((await command("list_chats")).items.length, 2);
    });
    await t.test("hub restart reconnects the same Rex client without another conversation or terminal", async () => {
      await until(() => command("status"), (value) => value.activity.tasks.length === 0 && value.activity.submissions.length === 0);
      await stop(hub); hub = undefined;
      await until(capture, (text) => text.includes("Hub unavailable"));
      assert.equal(await childPid(clientAllocation.session_id, clientBlock), clientPid);
      // Creation success is not client readiness: a brand-new client currently
      // exits if its initial status request cannot reach the hub.
      const cold = await json<Run>("run", "--session", clientAllocation.session_id, "--label", "cold client", "--focus=false", "--keep-open", "--cwd", work, "--shell=none", "--json", "--", ...clientArgv);
      assert.equal(cold.block_ids.length, 1); const coldBlock = cold.block_ids[0]!; fullId(coldBlock, "block");
      assert.equal((await exit(clientAllocation.session_id, coldBlock)).exit_code, 1);
      const replacement = (await startHub())!;
      assert.equal(replacement.hubId, status.hubId); assert.equal(replacement.mainChatId, status.mainChatId);
      await until(capture, (text) => text.includes("Hub reconnected"));
      assert.equal((await exit(clientAllocation.session_id, coldBlock)).exit_code, 1);
      assert.equal(await childPid(clientAllocation.session_id, clientBlock), clientPid);
      await rex("block", "close", coldBlock, "--session", clientAllocation.session_id);
      assert.equal((await command("list_chats")).items.length, 2);
    });
    await t.test("exiting/replacing a client preserves identity; destroying Rex does not stop in-flight hub work", async () => {
      await rex("send", "--session", clientAllocation.session_id, "--block", clientBlock, "/exit\n");
      assert.equal((await exit(clientAllocation.session_id, clientBlock)).exit_code, 0);
      const before = await command("history", { chatId: task.chatId });
      const run = await json<Run>("run", "--session", clientAllocation.session_id, "--label", "replacement client", "--focus=false", "--keep-open", "--cwd", work, "--shell=none", "--json", "--", ...clientArgv);
      // Shape deliberately asserted by the probe; replacements are NEW block IDs,
      // not a restart-in-place or revival of Pi ownership.
      assert.equal(run.block_ids.length, 1); const replacementBlock = run.block_ids[0]!;
      fullId(replacementBlock, "block"); fullId(run.window_id, "window"); assert.notEqual(replacementBlock, clientBlock);
      await until(() => rex("capture", "--session", clientAllocation.session_id, "--block", replacementBlock, "--trim", "--unwrap"), (text) => text.includes("TERMINAL_TYPED_INPUT"));
      assert.deepEqual(await command("history", { chatId: task.chatId }), before);
      assert.equal((await command("list_chats")).items.length, 2);
      await writeFile(join(state, "gate-enabled"), "");
      await command("admit", { chatId: task.chatId, requestId: "detached-work", mode: "followUp", text: "DETACH_WORK" });
      await until(async () => access(join(state, "generation-started")).then(() => true, () => false), Boolean);
      await rex("session", "kill", clientAllocation.session_id);
      const active = await command("status");
      assert.ok(active.activity.tasks.length > 0); assert.ok(active.activity.submissions.length > 0);
      await writeFile(join(state, "gate-released"), "");
      const finished = await until(() => command("history", { chatId: task.chatId }), (value) => JSON.stringify(value).includes("DETACHED_WORK_FINISHED"));
      assert.ok(Array.isArray(finished.items));
      const answer = finished.items.find((entry: { kind?: string }) => entry.kind === "pi.assistant" && JSON.stringify(entry).includes("DETACHED_WORK_FINISHED"));
      assert.ok(answer); assert.match(JSON.stringify(answer), /"stopReason":"stop"/);
      await until(() => command("status"), (value) => value.activity.tasks.length === 0 && value.activity.submissions.length === 0);
      assert.doesNotMatch(JSON.stringify(await command("history", { chatId: status.mainChatId })), /DETACH_WORK/);
      assert.equal((await command("list_chats")).items.length, 2);
    });
    await t.test("explicit native-receipt reconciliation repairs a lost creation reply; inspection and startup remain separate", async () => {
      const info = await json<{ host_id: string; instance_id: string }>("server", "status", "--json");
      const chat = await command("create_task", { requestId: "internal-rex-chat", title: "Internal allocated task", ...status.binding });
      const request = join(state, "allocator-request");
      await writeFile(request, JSON.stringify({ chatId: chat.chatId, loseReply: true, target: { executable: rexBinary, server: endpoint, hostId: info.host_id, instanceId: info.instance_id, client: await realpath(deckBinary!), port } }));
      const original = await until(async () => { try { return JSON.parse(await readFile(`${request}.result`, "utf8")) as { taskId: number; duplicate: number; outcome: { status: string; result: RexResult }; binding?: RexBinding; startup: RexStartup }; } catch { return undefined; } }, (value) => !!value);
      assert.ok(original); assert.equal(original.taskId, original.duplicate); assert.equal(original.outcome.status, "completed"); assert.equal(original.outcome.result.status, "uncertain");
      assert.equal(original.binding, undefined); assert.equal(original.startup.observation, "unbound");
      const beforeRepair = await readdir(join(state, "worker/operations"));
      await writeFile(`${request}.reconcile`, "explicit operator request");
      const value = await until(async () => { try { return JSON.parse(await readFile(`${request}.reconciled`, "utf8")) as { taskId: number; reconciliationTaskId: number; outcome: { status: string; result: ReconcileResult }; originalOutcome: unknown; binding: RexBinding; startup: RexStartup }; } catch { return undefined; } }, (value) => !!value);
      assert.ok(value); assert.equal(value.taskId, original.taskId); assert.notEqual(value.reconciliationTaskId, value.taskId); assert.equal(value.outcome.status, "completed"); assert.equal(value.outcome.result.status, "reconciled");
      assert.deepEqual(value.originalOutcome, original.outcome); assert.deepEqual(await readdir(join(state, "worker/operations")), beforeRepair);
      const saved = value.binding; sessionIds.push(saved.sessionId);
      assert.equal(saved.chatId, chat.chatId); assert.equal(saved.hubId, status.hubId); assert.equal(saved.readiness, "not_checked");
      await until(() => rex("capture", "--session", saved.sessionId, "--block", saved.blockId, "--trim", "--unwrap"), (text) => text.includes("Rex startup registered"));
      assert.equal(value.startup.observation, "matched"); assert.equal(value.startup.live, "not_checked");
      assert.equal((JSON.parse(await readFile(`${request}.early`, "utf8")) as RexStartup).observation, "unbound");
      const history = await command("history", { chatId: chat.chatId }); assert.deepEqual(history.items, []);
      assert.equal((await command("list_chats")).items.length, 3);
      const receipt = JSON.parse(await readFile(join(state, "worker", "operations", `${value.taskId}.json`), "utf8")) as { result: { code: string } };
      assert.equal(receipt.result.code, "allocated");
      let sampleIndex = 0;
      const sample = async () => {
        const path = `${request}.presence.${sampleIndex++}`;
        await writeFile(path, "read");
        const result = await until(async () => { try { return JSON.parse(await readFile(`${path}.result`, "utf8")) as { presence: RexInspectionSnapshot; startup: RexStartup; binding: RexBinding }; } catch { return undefined; } }, (value) => !!value);
        assert.ok(result); assert.equal(result.presence.status, "sampled"); assert.equal(result.startup.observation, "matched");
        assert.equal(result.startup.live, "not_checked"); assert.deepEqual(result.binding, saved);
        assert.doesNotMatch(JSON.stringify(result.presence), /argv0|foreground|home|pid/);
        return result.presence;
      };
      const receipts = await readdir(join(state, "worker/operations"));
      assert.equal((await sample()).observation?.state, "running");
      await rex("send", "--session", saved.sessionId, "--block", saved.blockId, "/exit\n");
      assert.equal((await exit(saved.sessionId, saved.blockId)).exit_code, 0);
      await writeFile(`${request}.inspect`, "");
      const afterExit = await until(async () => { try { return JSON.parse(await readFile(`${request}.inspect.result`, "utf8")) as RexStartup; } catch { return undefined; } }, (value) => !!value);
      assert.deepEqual(afterExit, value.startup); // Historical registration does not become an invented heartbeat.
      const exited = await sample();
      assert.equal(exited.observation?.state, "exited", JSON.stringify(exited)); assert.equal(exited.observation.exitCode, 0);
      // Keep another ordinary scratch block in this session, making exact block
      // removal distinguishable from destruction of the whole saved session.
      const other = await json<Run>("run", "--session", saved.sessionId, "--focus=false", "--json", "--cwd", work, "--shell=none", "--keep-open", "--", process.execPath, "-e", "setInterval(()=>{},1000)");
      fullId(other.window_id, "window");
      await rex("block", "close", saved.blockId, "--session", saved.sessionId);
      assert.equal((await sample()).observation?.state, "missing_terminal");
      await rex("session", "kill", saved.sessionId);
      assert.equal((await sample()).observation?.state, "missing_session");
      assert.deepEqual(await readdir(join(state, "worker/operations")), receipts);
      assert.deepEqual((await command("history", { chatId: chat.chatId })).items, []);
    });
    await t.test("public best-effort open/reopen reuses running clients and replaces exited/missing objects without model input", async () => {
      const info = await json<{ host_id: string; instance_id: string }>("server", "status", "--json");
      const before = await command("history", { chatId: task.chatId });
      const publicStatus = () => command("rex_status", { chatId: task.chatId });
      const opened = await command("rex_open", { chatId: task.chatId, requestId: randomUUID(), port, target: { executable: rexBinary, server: endpoint, hostId: info.host_id, instanceId: info.instance_id } });
      assert.equal(opened.status, "admitted");
      const allocated = async () => {
        const value = await until(publicStatus, (s) => s.status !== "pending"); assert.equal(value.status, "allocated");
        const binding = value.binding as RexBinding;
        await until(() => rex("capture", "--session", binding.sessionId, "--block", binding.blockId, "--trim", "--unwrap"), (text) => text.includes("Rex startup registered"));
        return binding;
      };
      const first = await allocated(); sessionIds.push(first.sessionId);
      const cli = spawnSync(deckBinary!, ["rex", "open", "--task", task.chatId, "--port", String(port)], { env, encoding: "utf8", timeout: 5000 });
      assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /reused/);
      assert.deepEqual((await publicStatus()).binding, first);
      await rex("send", "--session", first.sessionId, "--block", first.blockId, "/exit\n"); await exit(first.sessionId, first.blockId);
      await command("rex_open", { chatId: task.chatId, requestId: randomUUID(), port });
      const second = await allocated(); assert.equal(second.sessionId, first.sessionId); assert.notEqual(second.blockId, first.blockId);
      assert.deepEqual((await publicStatus()).previousBinding, first);
      await rex("block", "close", second.blockId, "--session", second.sessionId);
      assert.equal(((await command("rex_inspect", { chatId: task.chatId })).observation as { state: string }).state, "missing_terminal");
      await command("rex_open", { chatId: task.chatId, requestId: randomUUID(), port });
      const third = await allocated(); assert.equal(third.sessionId, first.sessionId); assert.notEqual(third.blockId, second.blockId);
      await rex("session", "kill", third.sessionId);
      await command("rex_open", { chatId: task.chatId, requestId: randomUUID(), port });
      const fourth = await allocated(); sessionIds.push(fourth.sessionId); assert.notEqual(fourth.sessionId, first.sessionId);
      assert.deepEqual(await command("history", { chatId: task.chatId }), before);
      assert.equal((await command("list_chats")).items.length, 3);
    });
  } finally {
    // Release any test-only model gate even when an assertion failed.
    await writeFile(join(state, "gate-released"), "").catch(() => {});
    // Scope cleanup to the private server; never kill an operator's Rex daemon.
    for (const sid of sessionIds) await rex("session", "kill", sid).catch(() => {});
    await stop(hub); await stop(server);
    assert.ok(server.exitCode !== null || server.signalCode !== null, rexErrors);
    await rm(root, { recursive: true, force: true });
  }
});
