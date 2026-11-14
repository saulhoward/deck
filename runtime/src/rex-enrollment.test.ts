import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { freeHubPort as portPair } from "./hub-port.test.support.js";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { hubCommand } from "./hub-client.js";
import { launcherCommand, rexLauncherTarget } from "./launcher-client.js";
const deck = process.env.DECK_TEST_BINARY, rex = process.env.DECK_TEST_REX_FORWARD;
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read(); if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Automatic worker condition not observed");
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close"); child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { await closed; } finally { clearTimeout(timer); }
}
test("API14 isolated Rex: automatic registration, assigned-worker reads/cancellation, same daemon reconnect and central history", { skip: !deck || !rex, timeout: 75_000 }, async () => {
  const root = await realpath(await mkdtemp("/tmp/deck-auto-"));
  const hubState = join(root, "hub"), workerState = join(root, "worker"), hubWork = join(root, "hub-work"), workerWork = join(root, "worker-work"), runtime = join(root, "rex");
  for (const dir of [hubWork, workerWork, runtime, join(root, "bin")]) await mkdir(dir);
  await symlink(rex!, join(root, "bin", "rex"));
  const instructions = "Exact worker instructions\nUnicode 🌍\n";
  await writeFile(join(workerWork, "AGENTS.md"), instructions);
  await writeFile(join(hubWork, "AGENTS.md"), "Wrong hub workspace — must not be read");
  const config = join(root, "empty.lua"); await writeFile(config, "");
  const endpoint = `unix://${runtime}/server.sock`, port = await portPair();
  // Inject a test-only provider into a disposable runtime entry. Production
  // code/deadlines stay unchanged; the native automatic-route owner is real.
  const fixture = join(root, "fixture"), dist = join(fixture, "runtime/dist");
  await mkdir(dist, { recursive: true }); await writeFile(join(fixture, "package.json"), '{"type":"module"}');
  await symlink(resolve("node_modules"), join(fixture, "node_modules"));
  for (const name of await readdir(resolve("runtime/dist"))) {
    if (name === "main.js") await writeFile(join(dist, name), await readFile(resolve("runtime/dist", name)));
    else if (name !== "providers.js") await symlink(resolve("runtime/dist", name), join(dist, name));
  }
  await writeFile(join(dist, "providers.js"), `
    export * from ${JSON.stringify(pathToFileURL(resolve("runtime/dist/providers.js")).href)};
    import { startupProviders as base } from ${JSON.stringify(pathToFileURL(resolve("runtime/dist/providers.js")).href)};
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
    export async function startupProviders(...args) {
      if (args[0] !== '--mock') throw new Error('test-only provider');
      const configured = await base(...args), faux = fauxProvider();
      const respond = request => {
        faux.appendResponses([respond]);
        if (request.messages.some(m => m.role === 'user' && m.content === 'cancel-native-effect') && !request.messages.some(m => m.role === 'toolResult'))
          return fauxAssistantMessage(fauxToolCall('bash', { command: 'printf issued >> effect-started; sleep 60; printf finished >> effect-finished', timeout: 60 }), { stopReason: 'toolUse' });
        return fauxAssistantMessage('mock complete');
      };
      faux.setResponses([respond]); configured.models.setProvider(faux.provider); return configured;
    }
  `);
  const wrapped = join(dirname(deck!), ".deck-wrapped");
  const hubBinary = await access(wrapped).then(() => wrapped, () => deck!);
  const env = { HOME: root, PATH: `${root}/bin:/usr/bin:/bin`, REX_RUNTIME_DIR: runtime, TMPDIR: root, TERM: "xterm-256color", LANG: "en_US.UTF-8", DECK_RUNTIME_ROOT: fixture, DECK_NODE: process.execPath, DECK_CLIENT_STATE_DIRECTORY: join(root, "client") };
  const server = spawn(rex!, ["server", "run", "--listen", endpoint, "--state-dir", join(root, "rex-state"), "--config", config, "--restore=false"], { env });
  server.stdout.resume(); server.stderr.resume();
  let hub: ChildProcess | undefined, worker: ChildProcess | undefined, relayDirectory: string | undefined;
  let errors = "", servingState = hubState;
  const admin = (args: string[]) => new Promise<string>((accept, reject) => execFile(deck!, args, { env, cwd: hubWork, timeout: 15000 }, (error, stdout, stderr) => error ? reject(new Error(`Isolated administration failed: ${stderr}`)) : accept(stdout)));
  const startHub = () => {
    hub = spawn(hubBinary, ["serve", "--mock", "--directory", servingState, "--port", String(port)], { env, cwd: hubWork });
    hub.stdout!.resume(); hub.stderr!.on("data", b => { errors = (errors + String(b)).slice(-8192); });
  };
  try {
    await until(() => access(`${runtime}/server.sock`).then(() => true, () => false), Boolean);
    // No init, registry, machine-ID exchange, Tailscale executable, or login.
    startHub();
    const status: any = await until(() => hubCommand(port, "status").catch(() => undefined), Boolean);
    assert.equal(status.binding.cwd, hubWork);
    assert.equal((await stat(hubState)).mode & 0o777, 0o700);
    worker = spawn(deck!, ["worker", "rex", "--directory", workerState, "--hub", endpoint, "--rex", rex!, "--client", deck!, "--port", String(port)], { env, cwd: workerWork });
    worker.stdout!.resume(); worker.stderr!.on("data", b => { errors = (errors + String(b)).slice(-8192); });
    const hosts: any = await until(() => hubCommand(port, "list_hosts", {}, status.hubId), (x: any) => x.items.some((h: any) => h.kind === "worker" && h.connection === "connected"));
    assert.equal(hosts.items.length, 2);
    const target = await rexLauncherTarget(workerState); relayDirectory = target.socket.slice(0, target.socket.lastIndexOf("/"));
    assert.equal(target.hubId, status.hubId);
    assert.notEqual(target.machineId, status.machineId);
    const created: any = await launcherCommand(target, { version: 1, id: randomUUID(), command: "launch_create", args: { requestId: randomUUID(), title: "Automatic worker task", cwd: workerWork, problem: "Required problem", description: "Exact\noptional description\t" } });
    assert.equal(created.machineId, target.machineId); assert.equal(created.cwd, workerWork);
    assert.equal(created.brief.description, "Exact\noptional description\t");
    const taskId = created.chatId;
    const imported: any = await hubCommand(port, "import_instructions", { chatId: taskId, machineId: target.machineId, cwd: workerWork, requestId: randomUUID() }, target.hubId);
    const applied: any = await until(() => hubCommand(port, "instruction_status", { chatId: taskId, taskId: imported.taskId }, target.hubId), (x: any) => x.import?.state === "terminal");
    assert.equal(applied.import.result.status, "applied");
    assert.equal(applied.source.sha256, createHash("sha256").update(instructions).digest("hex"));
    await assert.rejects(access(join(workerState, "session.sqlite")), { code: "ENOENT" });
    const identity = await readFile(join(workerState, "config.json"), "utf8");
    const pid = worker.pid;
    const cancelledTask: any = await launcherCommand(target, { version: 1, id: randomUUID(), command: "launch_create", args: { requestId: randomUUID(), title: "Cancel native effect", cwd: workerWork } });
    await hubCommand(port, "admit", { chatId: cancelledTask.chatId, requestId: randomUUID(), text: "cancel-native-effect", mode: "steer" }, target.hubId);
    await until(() => readFile(join(workerWork, "effect-started"), "utf8").catch(() => ""), Boolean);
    await assert.rejects(access(join(hubWork, "effect-started")), { code: "ENOENT" });
    await hubCommand(port, "stop", { chatId: cancelledTask.chatId }, target.hubId);
    await until(() => hubCommand(port, "activity", { chatId: cancelledTask.chatId }, target.hubId), (v: any) => !v.busy && v.queued === 0);
    // Stop ACK is not drainage: wait for the worker's final native bash receipt.
    await until(async () => Promise.all((await readdir(join(workerState, "operations"))).filter(n => /^[0-9]+\.json$/.test(n)).map(async n => JSON.parse(await readFile(join(workerState, "operations", n), "utf8")))), values => values.some(v => v.result?.code === "cancelled"));
    await assert.rejects(access(join(workerWork, "effect-finished")), { code: "ENOENT" });
    const issued = await readFile(join(workerWork, "effect-started"), "utf8");
    await stop(hub); hub = undefined;
    const registryBytes = await readFile(join(hubState, "rex-workers.json"));
    const archive = join(root, "backup"), restored = join(root, "restored-hub");
    await admin(["backup", "--directory", hubState, "--output", archive]);
    await admin(["restore", "--from", archive, "--directory", restored]);
    assert.deepEqual(await readFile(join(restored, "rex-workers.json")), registryBytes);
    // Only the restored directory is served; never divergent live copies.
    servingState = restored;
    startHub();
    await until(() => hubCommand(port, "list_hosts", {}, target.hubId).catch(() => undefined), (x: any) => x?.items.some((h: any) => h.machineId === target.machineId && h.connection === "connected"));
    assert.equal(worker.pid, pid); assert.equal(worker.exitCode, null);
    assert.equal(await readFile(join(workerState, "config.json"), "utf8"), identity);
    const list: any = await launcherCommand(target, { version: 1, id: randomUUID(), command: "launch_list", args: {} });
    assert.deepEqual(list.items.map((item: any) => item.chatId), [taskId, cancelledTask.chatId]);
    assert.equal(await readFile(join(workerWork, "effect-started"), "utf8"), issued, "native cancellation/reconnect does not reexecute the effect");
    await assert.rejects(access(join(workerWork, "effect-finished")), { code: "ENOENT" });
    assert.equal((await hubCommand(port, "status") as any).hubId, status.hubId);
    const before = await hubCommand(port, "history", { chatId: taskId }, target.hubId);
    await stop(worker); worker = undefined;
    await until(() => hubCommand(port, "list_hosts", {}, target.hubId), (x: any) => x.items.some((h: any) => h.machineId === target.machineId && h.connection === "offline"));
    assert.deepEqual(await hubCommand(port, "history", { chatId: taskId }, target.hubId), before);
  } catch (error) { throw new Error(`${String(error)}\n${errors}`); }
  finally {
    await stop(worker); await stop(hub); await stop(server);
    if (relayDirectory) await rm(relayDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
