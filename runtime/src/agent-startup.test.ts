import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { freeHubPort as portPair } from "./hub-port.test.support.js";
import { join, resolve } from "node:path";
import test from "node:test";
import { hubCommand } from "./hub-client.js";
import { validRexUuid, type RexBootstrapRecord } from "./generated/contracts.js";
const deck = process.env.DECK_TEST_BINARY, rex = process.env.DECK_TEST_REX_FORWARD;
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 12000;
  let last: T | undefined;
  while (Date.now() < end) { last = await read(); if (check(last)) return last; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Startup condition not observed: ${JSON.stringify(last)?.slice(0, 2048)}`);
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close"); child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
  try { await closed; } finally { clearTimeout(timer); }
}
for (const remote of [false, true]) test(`API14 isolated ${remote ? "remote-selected" : "local"} agent: same-block create/start, exact brief, detach/list/resume${remote ? " and detached worker reuse" : ""}`, { skip: !deck || !rex, timeout: 100000 }, async () => {
  const root = await realpath(await mkdtemp("/tmp/deck-agent-"));
  const work = join(root, "worker-work"), hubWork = join(root, "hub-work"), client = join(root, "client"), localHome = join(root, "local"), hubHome = remote ? join(root, "remote") : localHome;
  for (const path of new Set([work, hubWork, localHome, hubHome, join(root, "bin")])) await mkdir(path);
  await symlink(rex!, join(root, "bin", "rex"));
  const config = join(root, "empty.lua"); await writeFile(config, "");
  const envFor = (home: string) => ({ HOME: home, PATH: `${root}/bin:/usr/bin:/bin`, REX_RUNTIME_DIR: join(home, "rex"), TMPDIR: root, TERM: "xterm-256color", LANG: "en_US.UTF-8", DECK_RUNTIME_ROOT: resolve("."), DECK_NODE: process.execPath, DECK_CLIENT_STATE_DIRECTORY: client });
  const env = envFor(localHome), hubEnv = envFor(hubHome), port = await portPair();
  const endpoint = (home: string) => `unix://${home}/rex/server.sock`;
  const invoke = (binary: string, args: string[], cwd = work, environment: NodeJS.ProcessEnv = env, timeout = 20000) => new Promise<string>((accept, reject) => {
    execFile(binary, args, { env: environment, cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${args[0]} failed: ${stderr.slice(0, 2048)}`)) : accept(stdout));
  });
  const rexCall = (home: string, ...args: string[]) => invoke(rex!, ["--autostart=false", "--timeout", "2s", "--server", endpoint(home), ...args], work, envFor(home), 5000);
  const rexJson = async (home: string, ...args: string[]): Promise<any> => JSON.parse(await rexCall(home, ...args));
  const servers: ChildProcess[] = []; let hub: ChildProcess | undefined; let errors = ""; let daemon: { pid: number; directory: string; socket: string } | undefined;
  let current: RexBootstrapRecord | undefined;
  try {
    for (const home of new Set([localHome, hubHome])) {
      await mkdir(join(home, "rex"));
      const server = spawn(rex!, ["server", "run", "--listen", endpoint(home), "--state-dir", join(home, "rex-state"), "--config", config, "--restore=false"], { env: envFor(home) });
      server.stdout.resume(); server.stderr.on("data", b => { errors = (errors + String(b)).slice(-8192); }); servers.push(server);
      await until(() => access(join(home, "rex/server.sock")).then(() => true, () => false), Boolean);
    }
    if (remote) assert.notEqual((await rexJson(localHome, "whoami", "--json")).host_id, (await rexJson(hubHome, "whoami", "--json")).host_id);
    hub = spawn(deck!, ["serve", "--mock", "--directory", join(root, "hub"), "--port", String(port)], { env: hubEnv, cwd: hubWork });
    hub.stdout!.resume(); hub.stderr!.on("data", b => { errors = (errors + String(b)).slice(-8192); });
    const status: any = await until(() => hubCommand(port, "status").catch(() => undefined), Boolean);
    const flags = ["--port", String(port), "--rex", rex!, "--server", endpoint(localHome), ...(remote ? ["--hub", endpoint(hubHome)] : ["--local"])];
    const cli = (...extra: string[]) => invoke(deck!, ["agent", ...flags, ...extra]);
    const launched = await cli(); assert.match(launched, /Task creation Rex session/);
    const names = (await readdir(join(client, "startups"))).filter(name => name.endsWith(".json") && validRexUuid(name.slice(0, -5)));
    assert.equal(names.length, 1);
    const id = names[0]!.slice(0, -5), recordFile = join(client, "startups", id, "record.json");
    const record: RexBootstrapRecord = JSON.parse(await readFile(recordFile, "utf8")); current = record;
    const b = record.binding!; assert.equal(record.cwd, work); assert.equal(record.hubId, status.hubId); assert.ok(b); assert.ok(launched.includes(b.sessionId));
    if (remote) {
      const directories = (await readdir(join(client, "workers"))).filter(name => /^[0-9a-f]{64}$/.test(name)); assert.equal(directories.length, 1);
      const directory = join(client, "workers", directories[0]!); const c = JSON.parse(await readFile(join(directory, "rex-connection.json"), "utf8"));
      daemon = { pid: c.pid, directory, socket: c.rexClient.socket }; assert.notEqual(record.machineId, status.machineId); assert.equal(record.workerSocket, c.rexClient.socket);
      await assert.rejects(access(join(directory, "session.sqlite")), { code: "ENOENT" });
    } else assert.equal(record.machineId, status.machineId);
    const capture = () => rexCall(localHome, "capture", "--session", b.sessionId, "--block", b.blockId, "--trim", "--unwrap");
    const send = (text: string) => rexCall(localHome, "send", "--session", b.sessionId, "--block", b.blockId, text);
    const processState = () => rexJson(localHome, "block", "call", "process", "--session", b.sessionId, "--block", b.blockId);
    await until(capture, text => text.includes("Create a task")); assert.equal((await processState()).child.pid, b.pid);
    assert.equal((await hubCommand(port, "list_chats", {}, status.hubId) as any).items.length, 1);
    const problem = "  Required task problem 🌍  ", description = " optional exact description  ";
    await send(problem);
    await until(capture, text => text.includes(problem.trim()) && text.includes("Nothing created"));
    await send("\r"); await send(description); await send("\r");
    assert.equal((await hubCommand(port, "list_chats", {}, status.hubId) as any).items.length, 1, "fields/Enter navigation do not create/start work");
    await send("\r");
    const page: any = await until(() => hubCommand(port, "list_chats", {}, status.hubId), (p: any) => p.items.length === 2);
    const task = page.items.find((item: any) => item.kind === "task"); assert.ok(task); assert.equal(task.cwd, work); assert.equal(task.machineId, record.machineId);
    const taskStatus: any = await hubCommand(port, "status", { chatId: task.chatId }, status.hubId);
    assert.deepEqual(taskStatus.binding.brief, { problem, description });
    const history: any = await until(() => hubCommand(port, "history", { chatId: task.chatId }, status.hubId), (h: any) => h.items.some((entry: any) => entry.kind === "deck.input"));
    const inputs = history.items.filter((entry: any) => entry.kind === "deck.input"); assert.equal(inputs.length, 1); assert.equal(inputs[0].data.text, problem);
    assert.equal((await processState()).child.pid, b.pid, "wizard and task TUI retain the same native process");
    const allocated: any = await hubCommand(port, "rex_status", { chatId: task.chatId }, status.hubId);
    assert.equal(allocated.status, "allocated"); assert.equal(allocated.binding.blockId, b.blockId); assert.equal(allocated.binding.sessionId, b.sessionId);
    assert.equal((await rexJson(localHome, "session", "ls", "--json", "--short=false")).sessions.length, 1, "adoption did not create a second session");
    await until(() => access(join(client, "startups", `${id}.json`)).then(() => true, () => false), exists => !exists);
    // Inject the crash boundary where the form completed and removed its index
    // but the original launcher never cleared its durable creation fence.
    const scope = createHash("sha256").update(JSON.stringify({ hubId: record.hubId, machineId: record.machineId })).digest("hex");
    const pending = join(client, "startups", `${scope}.pending.json`);
    await writeFile(pending, JSON.stringify({ version: 1, id, hubId: record.hubId, machineId: record.machineId }), { mode: 0o600, flag: "wx" });
    assert.match(await cli("--drafts"), /bootstrap-launch-unconfirmed/);
    assert.match(await cli("--discard", id, "--confirm"), /not stopped\/deleted/);
    await assert.rejects(access(pending), { code: "ENOENT" });
    await access(join(client, "startups", id, "discarded.json"));
    assert.match(await cli("--list"), new RegExp(task.agentName));
    assert.match(await cli("--resume", task.agentName), /reused/); assert.equal((await processState()).child.pid, b.pid);
    if (daemon) assert.equal(JSON.parse(await readFile(join(daemon.directory, "rex-connection.json"), "utf8")).pid, daemon.pid);
    await rexCall(localHome, "send-key", "--session", b.sessionId, "--block", b.blockId, "ctrl+c");
    await until(processState, p => !p.child && !!p.last_exit);
    assert.match(await cli("--resume", task.agentName), /admitted/);
    const reopened: any = await until(() => hubCommand(port, "rex_status", { chatId: task.chatId }, status.hubId), (s: any) => s.status === "allocated" && s.binding.blockId !== b.blockId);
    assert.equal(reopened.binding.sessionId, b.sessionId);
    await new Promise(r => setTimeout(r, 500));
    assert.equal((await hubCommand(port, "list_chats", {}, status.hubId) as any).items.length, 2);
    assert.equal((await hubCommand(port, "history", { chatId: task.chatId }, status.hubId) as any).items.filter((entry: any) => entry.kind === "deck.input").length, 1, "resume never replays initial input");
    if (daemon) {
      assert.equal(JSON.parse(await readFile(join(daemon.directory, "rex-connection.json"), "utf8")).pid, daemon.pid);
      const hosts: any = await hubCommand(port, "list_hosts", {}, status.hubId); assert.equal(hosts.items.find((h: any) => h.machineId === record.machineId).connection, "connected");
    }
  } catch (error) {
    let screen = "";
    if (current?.binding) screen = await rexCall(localHome, "capture", "--session", current.binding.sessionId, "--block", current.binding.blockId, "--trim", "--unwrap").catch(() => "");
    throw new Error(`${String(error)}\n${screen}\n${errors}`);
  } finally {
    // Only test-owned private servers, records and the detached worker whose
    // full unique directory remains in its actual process command line.
    if (!daemon) {
      for (const name of await readdir(join(client, "workers")).catch(() => [])) if (/^[0-9a-f]{64}$/.test(name)) {
        const directory = join(client, "workers", name);
        const c = JSON.parse(await readFile(join(directory, "rex-connection.json"), "utf8").catch(() => "null"));
        if (c?.pid) daemon = { pid: c.pid, directory, socket: c.rexClient.socket };
      }
    }
    if (daemon) {
      const command = await invoke("/bin/ps", ["-p", String(daemon.pid), "-o", "command="], work).catch(() => "");
      if (command.includes(daemon.directory) && command.includes("worker rex --detach")) { process.kill(daemon.pid, "SIGTERM"); await new Promise(r => setTimeout(r, 1000)); }
    }
    for (const home of new Set([localHome, hubHome])) {
      const sessions = await rexJson(home, "session", "ls", "--json", "--short=false").catch(() => ({ sessions: [] }));
      for (const s of sessions.sessions) await rexCall(home, "session", "kill", s.session_id).catch(() => {});
    }
    await stop(hub); for (const server of servers) await stop(server);
    if (daemon) await rm(daemon.socket.slice(0, daemon.socket.lastIndexOf("/")), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
