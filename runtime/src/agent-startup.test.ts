import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { freeHubPort as portPair } from "./hub-port.test.support.js";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { hubCommand } from "./hub-client.js";
import { taskCommand, taskScope } from "./task-client.js";
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
for (const { remote, upgrading, live = false, interrupted = false } of [{ remote: false, upgrading: false }, { remote: true, upgrading: false }, { remote: true, upgrading: true }, { remote: true, upgrading: true, live: true }, { remote: true, upgrading: true, live: true, interrupted: true }]) test(`API14+ isolated ${interrupted ? "remote-live-recovery" : live ? "remote-live-upgrade" : upgrading ? "remote-upgrade" : remote ? "remote-selected" : "local"} agent: same-block create/open, exact brief, detach/list/resume${remote ? " and detached worker reuse" : ""}`, { skip: !deck || !rex || (interrupted && process.getuid?.() === 0), timeout: 100000 }, async () => {
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
  const nativeUpgrade = async (request: unknown) => {
    const socket = createConnection({ host: "127.0.0.1", port: port === 65535 ? 65534 : port + 1 });
    const decoder = socket.pipe(new FrameDecoder());
    const reply = new Promise<any>((resolve, reject) => {
      decoder.once("data", resolve); decoder.on("error", reject); socket.on("error", reject);
      socket.once("close", () => reject(new Error("Upgrade control closed")));
      socket.once("connect", () => socket.write(encodeFrame(request)));
    });
    const timer = setTimeout(() => socket.destroy(new Error("Upgrade control timeout")), 5000);
    try { return await reply; } finally { clearTimeout(timer); socket.destroy(); decoder.destroy(); }
  };
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
    let activeClient = deck!;
    const cli = (...extra: string[]) => invoke(activeClient, ["agent", ...flags, ...extra]);
    // Use another immutable path so live cases exercise real executable
    // replacement. Stable-contact cases stay on their original package; an
    // explicit previous Nix package instead exercises automatic legacy-client
    // reuse with genuinely different native/runtime bytes.
    let original = deck!;
    if (remote) {
      if (process.env.DECK_TEST_PREVIOUS_BINARY && !live) original = await realpath(process.env.DECK_TEST_PREVIOUS_BINARY);
      else {
        let image = await realpath(deck!);
        const wrapped = join(dirname(image), ".deck-wrapped");
        if (await access(wrapped).then(() => true, () => false)) image = wrapped;
        original = join(root, "original-client"); await copyFile(image, original); await chmod(original, 0o500);
      }
    }
    if (remote && !upgrading && !process.env.DECK_TEST_PREVIOUS_BINARY) activeClient = original;
    if (live) {
      activeClient = join(root, "replacement-client");
      let image = await realpath(deck!); const wrapped = join(dirname(image), ".deck-wrapped");
      if (await access(wrapped).then(() => true, () => false)) image = wrapped;
      await copyFile(image, activeClient); await chmod(activeClient, 0o500);
    }
    const launched = await invoke(original, ["agent", ...flags]); assert.match(launched, /Task creation Rex session/);
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
    if (live) {
      const before = await readFile(join(daemon!.directory, "rex-connection.json"), "utf8");
      await assert.rejects(cli(), /upgrade deferred/, "unclaimed original forms must not lose their client scope");
      assert.match(await cli("--drafts"), new RegExp(id), "recovery remains available via verified pinned-client dispatch");
      if (!interrupted) assert.match(await cli("--list"), /No independent tasks/, "deferral must not block read-only contact");
      assert.equal(await readFile(join(daemon!.directory, "rex-connection.json"), "utf8"), before);
      await assert.rejects(access(join(daemon!.directory, "live-handoff.json")), { code: "ENOENT" });
    }
    assert.equal((await hubCommand(port, "list_chats", {}, status.hubId) as any).items.length, 1);
    const problem = "  Required task problem 🌍  ", description = " optional exact description  ";
    await send(problem);
    await until(capture, text => text.includes(problem.trim()) && text.includes("Nothing created"));
    await send("\r"); await send(description); await send("\r");
    assert.equal((await hubCommand(port, "list_chats", {}, status.hubId) as any).items.length, 1, "fields/Enter navigation do not create work");
    await send("\r");
    const page: any = await until(() => hubCommand(port, "list_chats", {}, status.hubId), (p: any) => p.items.length === 2);
    const task = page.items.find((item: any) => item.kind === "task"); assert.ok(task); assert.equal(task.cwd, work); assert.equal(task.machineId, record.machineId);
    const taskStatus: any = await hubCommand(port, "status", { chatId: task.chatId }, status.hubId);
    assert.deepEqual(taskStatus.binding.brief, { problem, description });
    await until(capture, text => text.includes("Enter to send"));
    assert.deepEqual((await hubCommand(port, "history", { chatId: task.chatId }, status.hubId) as any).items, [], "creation opens an empty chat");
    const activity: any = await hubCommand(port, "activity", { chatId: task.chatId }, status.hubId);
    assert.equal(activity.busy, false); assert.equal(activity.queued, 0);
    // The first user message is separately authored in the task TUI, not the brief.
    const message = "Start only on this explicit user message";
    await send(message); await send("\r");
    const history: any = await until(() => hubCommand(port, "history", { chatId: task.chatId }, status.hubId), (h: any) => h.items.some((entry: any) => entry.kind === "deck.input"));
    const inputs = history.items.filter((entry: any) => entry.kind === "deck.input"); assert.equal(inputs.length, 1); assert.equal(inputs[0].data.text, message);
    assert.equal((await processState()).child.pid, b.pid, "wizard and task TUI retain the same native process");
    const allocated: any = await hubCommand(port, "rex_status", { chatId: task.chatId }, status.hubId);
    assert.equal(allocated.status, "allocated"); assert.equal(allocated.binding.blockId, b.blockId); assert.equal(allocated.binding.sessionId, b.sessionId);
    assert.equal((await rexJson(localHome, "session", "ls", "--json", "--short=false")).sessions.length, 1, "adoption did not create a second session");
    await until(() => access(join(client, "startups", `${id}.json`)).then(() => true, () => false), exists => !exists);
    let reopened: any = allocated;
    if (!upgrading) {
    // Inject the crash boundary where the form completed and removed its index
    // but the original launcher never cleared its durable creation fence.
    const scope = createHash("sha256").update(JSON.stringify({ hubId: record.hubId, machineId: record.machineId })).digest("hex");
    const pending = join(client, "startups", `${scope}.pending.json`);
    await writeFile(pending, JSON.stringify({ version: 1, id, hubId: record.hubId, machineId: record.machineId }), { mode: 0o600, flag: "wx" });
    assert.match(await cli("--drafts"), /bootstrap-launch-unconfirmed/);
    assert.match(await cli("--discard", id, "--confirm"), /not stopped\/deleted/);
    await assert.rejects(access(pending), { code: "ENOENT" });
    await access(join(client, "startups", id, "discarded.json"));
    const connectionBefore = daemon ? await readFile(join(daemon.directory, "rex-connection.json"), "utf8") : undefined;
    const registryBefore = remote ? await readFile(join(root, "hub", "rex-workers.json"), "utf8") : undefined;
    assert.match(await cli("--list"), new RegExp(task.agentName));
    if (daemon) assert.equal(await readFile(join(daemon.directory, "rex-connection.json"), "utf8"), connectionBefore);
    if (remote) assert.equal(await readFile(join(root, "hub", "rex-workers.json"), "utf8"), registryBefore);
    assert.match(await cli("--resume", task.agentName), /reused/); assert.equal((await processState()).child.pid, b.pid);
    if (daemon) assert.equal(JSON.parse(await readFile(join(daemon.directory, "rex-connection.json"), "utf8")).pid, daemon.pid);
    await rexCall(localHome, "send-key", "--session", b.sessionId, "--block", b.blockId, "ctrl+c");
    await until(processState, p => !p.child && !!p.last_exit);
    assert.match(await cli("--resume", task.agentName), /admitted/);
    reopened = await until(() => hubCommand(port, "rex_status", { chatId: task.chatId }, status.hubId), (s: any) => s.status === "allocated" && s.binding.blockId !== b.blockId);
    assert.equal(reopened.binding.sessionId, b.sessionId);
    const resumedCapture = () => rexCall(localHome, "capture", "--session", reopened.binding.sessionId, "--block", reopened.binding.blockId, "--trim", "--unwrap");
    await until(resumedCapture, text => text.includes(message));
    assert.equal((await hubCommand(port, "list_chats", {}, status.hubId) as any).items.length, 2);
    assert.equal((await hubCommand(port, "history", { chatId: task.chatId }, status.hubId) as any).items.filter((entry: any) => entry.kind === "deck.input").length, 1, "resume never submits the brief or replays input");
    await assert.rejects(cli("--resume", task.agentName, "--here"), /interactive terminal/, "non-PTY refusal precedes transport/terminal mutation");
    const connectionAtAttach = daemon ? await readFile(join(daemon.directory, "rex-connection.json")) : undefined;
    const registrationAtAttach = remote ? await readFile(join(root, "hub", "rex-workers.json")) : undefined;
    const attachedText = "New input from my current terminal";
    // A real invoking PTY, outside Rex and deliberately in a different cwd. An
    // absence of BOTH Rex hints selects the outside-Rex attachment path.
    const here = spawn("python3", [resolve("scripts/tui-pty-test.py"), deck!, "agent", ...flags, "--resume", task.agentName, "--here"], { cwd: hubWork, env: { ...env, PATH: `${root}/bin:${process.env.PATH}`, REX_SESSION: undefined, REX_BLOCK: undefined } });
    let hereOut = "", hereErr = ""; here.stdout!.on("data", b => { hereOut += String(b); }); here.stderr!.on("data", b => { hereErr += String(b); });
    const hereClosed = once(here, "close");
    here.stdin!.end(JSON.stringify([{ wait: "Connecting to the selected hub" }, { wait: message }, { capture: "history" }, { keys: attachedText }, { keys: "\r" }, { wait: "Input admitted" }, { keys: "\u0003" }]));
    assert.equal((await hereClosed)[0], 0, hereErr);
    const captureHere = JSON.parse(hereOut); assert.equal(captureHere.restored, true); assert.match(captureHere.screens.history, /Start only on this explicit user message/);
    assert.doesNotMatch(captureHere.screens.history, /Connecting to the local hub/);
    assert.deepEqual(await hubCommand(port, "rex_status", { chatId: task.chatId }, status.hubId), reopened, "here leaves original allocation and startup observation unchanged");
    assert.equal((await rexJson(localHome, "session", "ls", "--json", "--short=false")).sessions.length, 1);
    assert.equal((await hubCommand(port, "status", { chatId: task.chatId }, status.hubId) as any).binding.cwd, work, "here does not rebind tools to the invoking cwd");
    const afterHere: any = await hubCommand(port, "history", { chatId: task.chatId }, status.hubId);
    assert.equal(afterHere.items.filter((e: any) => e.kind === "deck.input").length, 2); assert.ok(afterHere.items.some((e: any) => e.data?.text === attachedText));
    if (daemon) assert.deepEqual(await readFile(join(daemon.directory, "rex-connection.json")), connectionAtAttach);
    if (remote) assert.deepEqual(await readFile(join(root, "hub", "rex-workers.json")), registrationAtAttach);
    const createFlags = remote ? flags : ["--local", "--port", String(port), "--rex", "/definitely-unavailable-rex"];
    const createHere = async (steps: object[], formOnly = false) => {
      const driver = spawn("python3", [resolve("scripts/tui-pty-test.py"), deck!, "agent", ...createFlags, "--here"], { cwd: work, env: { ...env, PATH: `${root}/bin:${process.env.PATH}`, ...(formOnly ? { DECK_TEST_FORM_ONLY: "1" } : {}), REX_SESSION: undefined, REX_BLOCK: undefined } });
      let out = "", err = ""; driver.stdout!.on("data", b => { out += b; }); driver.stderr!.on("data", b => { err += b; });
      const closed = once(driver, "close"); driver.stdin!.end(JSON.stringify(steps));
      assert.equal((await closed)[0], 0, err); return JSON.parse(out);
    };
    // A partial ambient Rex identity is not an outside-Rex fallback. Refuse
    // before any task, startup, allocation or worker registration is changed.
    const partialStarts = await readdir(join(client, "startups"));
    const partialTasks = await hubCommand(port, "list_chats", {}, status.hubId);
    const partial = JSON.parse(await invoke("python3", [resolve("scripts/agent-here-refusal-pty-test.py"), deck!, "agent", ...flags, "--here"], work, { ...env, PATH: `${root}/bin:${process.env.PATH}`, REX_BLOCK: "block:11111111-1111-4111-8111-111111111111" }));
    assert.notEqual(partial.exitCode, 0); assert.match(partial.output, /agent startup refused/);
    assert.deepEqual(await readdir(join(client, "startups")), partialStarts);
    assert.deepEqual(await hubCommand(port, "list_chats", {}, status.hubId), partialTasks);
    assert.deepEqual(await hubCommand(port, "rex_status", { chatId: task.chatId }, status.hubId), reopened);
    const beforeCreate = await readdir(join(client, "startups"));
    assert.equal((await createHere([{ wait: "Create a task" }, { wait: "Nothing created" }, { keys: "Cancel without creating" }, { keys: "\u0003" }], true)).restored, true);
    assert.equal((await hubCommand(port, "list_chats", {}, status.hubId) as any).items.length, 2);
    assert.equal((await readdir(join(client, "startups"))).filter(n => n.endsWith(".json") && validRexUuid(n.slice(0, -5))).length, 0, "empty cancelled forms leave no blocking index");
    const hereProblem = "A new agent in this terminal", hereDescription = "Exact optional brief 日本語", hereInput = "Explicit input after here creation";
    const newHere = await createHere([{ wait: "Create a task" }, { wait: "Nothing created" }, { keys: hereProblem }, { keys: "\r" }, { keys: hereDescription }, { keys: "\r" }, { wait: "Create & attach here" }, { capture: "form" }, { keys: "\r" }, { wait: "Enter to send" }, { capture: "empty" }, { keys: hereInput }, { keys: "\r" }, { wait: "Input admitted" }, { keys: "\u0003" }]);
    assert.equal(newHere.restored, true); assert.match(newHere.screens.form, /Create & attach here/);
    const herePage: any = await hubCommand(port, "list_chats", {}, status.hubId);
    assert.equal(herePage.items.length, 3); const newTask = herePage.items.find((c: any) => c.title === hereProblem); assert.ok(newTask);
    assert.equal(newTask.machineId, record.machineId); assert.equal(newTask.cwd, work);
    assert.deepEqual((await hubCommand(port, "status", { chatId: newTask.chatId }, status.hubId) as any).binding.brief, { problem: hereProblem, description: hereDescription });
    assert.equal((await hubCommand(port, "rex_status", { chatId: newTask.chatId }, status.hubId) as any).status, "unallocated");
    const hereHistory: any = await hubCommand(port, "history", { chatId: newTask.chatId }, status.hubId);
    assert.deepEqual(hereHistory.items.filter((e: any) => e.kind === "deck.input").map((e: any) => e.data.text), [hereInput]);
    assert.equal((await rexJson(localHome, "session", "ls", "--json", "--short=false")).sessions.length, 1, "here creation and cancellation allocate no Rex terminals");
    const newStarts = (await readdir(join(client, "startups"))).filter(n => validRexUuid(n) && !beforeCreate.includes(n));
    assert.equal(newStarts.length, 2);
    const completed = []; for (const id of newStarts) if (await access(join(client, "startups", id, "completed.json")).then(() => true, () => false)) completed.push(id);
    assert.equal(completed.length, 1); const saved = JSON.parse(await readFile(join(client, "startups", completed[0]!, "here.json"), "utf8"));
    assert.equal(saved.mode, "here"); assert.equal(saved.binding, undefined); assert.equal(saved.target, undefined);
    // Crash boundary: task creation is retained, but TUI completion/index
    // cleanup did not commit. Recovery must use the installed here helper even
    // when the verified worker's pinned client is a different path/version.
    const hereDirectory = join(client, "startups", saved.id);
    await rm(join(hereDirectory, "completed.json"));
    await writeFile(join(client, "startups", `${saved.id}.json`), JSON.stringify({ version: 1, id: saved.id, hubId: saved.hubId, machineId: saved.machineId }), { mode: 0o600 });
    const hereForm = await readFile(join(hereDirectory, "form.json"));
    const recoveredHere = await new Promise<{ out: string; err: string }>((accept, reject) => {
      execFile(deck!, ["agent", ...flags, "--recover", saved.id, "--confirm"], { cwd: work, env, timeout: 20000 }, (error, out, err) => error ? reject(new Error(err)) : accept({ out, err }));
    });
    assert.match(recoveredHere.out, /Creation recovered/); assert.doesNotMatch(recoveredHere.err, /reusing the existing worker/);
    assert.deepEqual(await readFile(join(hereDirectory, "form.json")), hereForm);
    assert.equal((await hubCommand(port, "list_chats", {}, status.hubId) as any).items.length, 3);
    assert.equal((await hubCommand(port, "history", { chatId: newTask.chatId }, status.hubId) as any).items.filter((e: any) => e.kind === "deck.input").length, 1);
    assert.equal((await readdir(join(client, "startups"))).filter(n => n.endsWith(".json") && validRexUuid(n.slice(0, -5))).length, 0);
    if (daemon) assert.deepEqual(await readFile(join(daemon.directory, "rex-connection.json")), connectionAtAttach);
    if (remote) assert.deepEqual(await readFile(join(root, "hub", "rex-workers.json")), registrationAtAttach);
    }
    if (daemon) {
      assert.equal(JSON.parse(await readFile(join(daemon.directory, "rex-connection.json"), "utf8")).pid, daemon.pid);
      const hosts: any = await hubCommand(port, "list_hosts", {}, status.hubId); assert.equal(hosts.items.find((h: any) => h.machineId === record.machineId).connection, "connected");
      if (upgrading) {
      // Exercise offline legacy transition or negotiated live replacement,
      // strictly on these test-owned services after canonical work settles.
      for (const chatId of [String(status.chatId), task.chatId]) if (chatId !== "undefined") await until(() => hubCommand(port, "activity", { chatId }, status.hubId), (a: any) => !a.busy && a.queued === 0);
      if (!live) {
      await stop(hub); hub = undefined;
      const command = await invoke("/bin/ps", ["-p", String(daemon.pid), "-o", "command="]);
      assert.ok(command.includes(daemon.directory) && command.includes("worker rex --detach"));
      process.kill(daemon.pid, "SIGTERM");
      await until(() => invoke("/bin/ps", ["-p", String(daemon!.pid), "-o", "stat="]).catch(() => ""), state => !state.trim() || state.trim().startsWith("Z"));
      }
      const connectionFile = join(daemon.directory, "rex-connection.json"), beforeUpgrade = JSON.parse(await readFile(connectionFile, "utf8"));
      const workerIdentity = await readFile(join(daemon.directory, "config.json"), "utf8");
      const operations = join(daemon.directory, "operations");
      await writeFile(join(operations, "900000000.json"), JSON.stringify({ hash: "a".repeat(64), result: null }), { mode: 0o600 });
      const retained = await Promise.all((await readdir(operations)).sort().map(async name => [name, await readFile(join(operations, name), "utf8")] as const));
      // Checkout outputs may be group-writable under the builder's umask.
      // Approve only an immutable private copy, not a weakened executable check.
      let replacement = live ? activeClient : await realpath(deck!);
      if (!live && !replacement.startsWith("/nix/store/")) {
        replacement = join(root, "replacement-client"); await copyFile(deck!, replacement); await chmod(replacement, 0o500);
      }
      if (live) {
        activeClient = replacement;
        const hubPid = hub!.pid;
        // Fail LOCAL publication after the hub durably commits. The old daemon
        // must keep custody and retry only the same control intent, not effects.
        const contact = cli("--list"); void contact.catch(() => {});
        if (process.getuid?.() !== 0) {
        await until(async () => JSON.parse(await readFile(join(daemon!.directory, "live-handoff.json"), "utf8").catch(() => "null")), p => p?.phase === "prepared");
        await chmod(daemon.directory, 0o500);
        await until(async () => JSON.parse(await readFile(join(root, "hub", "rex-workers.json"), "utf8")), r => r.handoffs?.[0]?.phase === "committed");
        assert.deepEqual(JSON.parse(await readFile(connectionFile, "utf8")), beforeUpgrade);
        const pending = JSON.parse(await readFile(join(daemon.directory, "live-handoff.json"), "utf8"));
        assert.equal(pending.phase, "prepared");
        const registry = await readFile(join(root, "hub", "rex-workers.json"), "utf8");
        const changed = { ...pending.plan, implementation: "f".repeat(64) };
        assert.equal((await nativeUpgrade({ kind: "worker_upgrade", action: "commit", plan: changed })).status, "deferred", "same ID with changed evidence cannot take custody");
        assert.equal((await nativeUpgrade({ kind: "worker_upgrade", action: "commit", plan: pending.plan })).status, "committed", "lost-ACK retry of the exact control phase is idempotent");
        assert.equal(await readFile(join(root, "hub", "rex-workers.json"), "utf8"), registry);
        if (interrupted) {
          await stop(hub);
          hub = spawn(deck!, ["serve", "--mock", "--directory", join(root, "hub"), "--port", String(port)], { env: hubEnv, cwd: hubWork });
          hub.stdout!.resume(); hub.stderr!.on("data", b => { errors = (errors + String(b)).slice(-8192); });
          const recovered: any = await until(() => hubCommand(port, "status").catch(() => undefined), Boolean);
          assert.equal(recovered.hubId, status.hubId);
        }
        await chmod(daemon.directory, 0o700);
        }
        assert.match(await contact, new RegExp(task.agentName));
        if (!interrupted) assert.equal(hub!.pid, hubPid);
        await assert.rejects(access(join(daemon.directory, "live-handoff.json")), { code: "ENOENT" });
      } else {
      const plan = join(root, "upgrade-plan.json"), approval = join(root, "upgrade-approval.json");
      await invoke(replacement, ["worker", "upgrade", "prepare", "--directory", daemon.directory, "--output", plan]);
      await invoke(deck!, ["worker", "upgrade", "approve", "--directory", join(root, "hub"), "--from", plan, "--output", approval, "--confirm"], work, hubEnv);
      await invoke(replacement, ["worker", "upgrade", "apply", "--directory", daemon.directory, "--from", approval, "--confirm"]);
      activeClient = replacement;
      }
      const applied = JSON.parse(await readFile(connectionFile, "utf8"));
      assert.equal(applied.rexClient.executable, replacement); assert.equal(applied.sessionId, beforeUpgrade.sessionId); assert.equal(applied.hubId, beforeUpgrade.hubId);
      assert.equal(await readFile(join(daemon.directory, "config.json"), "utf8"), workerIdentity);
      const approved = JSON.parse(await readFile(join(root, "hub", "rex-workers.json"), "utf8")).hosts[0];
      assert.deepEqual(approved.previousClients, [beforeUpgrade.rexClient]);
      if (live) {
        const completedPlan = { version: 1, id: approved.upgradeId, hubId: record.hubId, machineId: record.machineId, beforeImplementation: beforeUpgrade.implementation, beforeClient: beforeUpgrade.rexClient, implementation: applied.implementation, client: applied.rexClient };
        const saved = await readFile(join(root, "hub", "rex-workers.json"), "utf8");
        for (const action of ["prepare", "commit"]) assert.equal((await nativeUpgrade({ kind: "worker_upgrade", action, plan: completedPlan })).status, "finished", "stale control cannot resurrect completed custody");
        assert.equal(await readFile(join(root, "hub", "rex-workers.json"), "utf8"), saved);
      }
      if (!live) {
      hub = spawn(deck!, ["serve", "--mock", "--directory", join(root, "hub"), "--port", String(port)], { env: hubEnv, cwd: hubWork });
      hub.stdout!.resume(); hub.stderr!.on("data", b => { errors = (errors + String(b)).slice(-8192); });
      await until(() => hubCommand(port, "status").catch(() => undefined), Boolean);
      assert.match(await cli("--list"), new RegExp(task.agentName));
      }
      const restarted = JSON.parse(await readFile(connectionFile, "utf8"));
      if (live) assert.equal(restarted.pid, daemon.pid, "exec retains daemon PID and actual writer lock"); else assert.notEqual(restarted.pid, daemon.pid);
      daemon.pid = restarted.pid;
      assert.equal(restarted.sessionId, beforeUpgrade.sessionId);
      assert.match(await cli("--resume", task.agentName), /reused/, "upgrade does not replace the old allocated terminal");
      assert.deepEqual((await hubCommand(port, "rex_status", { chatId: task.chatId }, status.hubId) as any).binding, reopened.binding);
      const claimed = JSON.parse(await readFile(recordFile, "utf8")) as RexBootstrapRecord;
      const oldScope = taskScope(record.hubId, task.chatId, claimed.claim!.allocationId, b.blockId);
      assert.deepEqual((await taskCommand(daemon.socket, oldScope, "status", { chatId: task.chatId }, record.hubId) as any).binding, taskStatus.binding, "old allocated terminal retains its exact task authority");
      for (const [name, bytes] of retained) assert.equal(await readFile(join(operations, name), "utf8"), bytes, name);
      if (live) {
        const current = await readFile(connectionFile, "utf8");
        await assert.rejects(invoke(original, ["agent", ...flags]), /upgrade deferred/, "retaining an old terminal package does not authorize automatic rollback");
        assert.equal(await readFile(connectionFile, "utf8"), current);
      }
      assert.match(await cli(), /Task creation Rex session/);
      const freshId = (await readdir(join(client, "startups"))).find(name => name.endsWith(".json") && validRexUuid(name.slice(0, -5)))!.slice(0, -5);
      const fresh = JSON.parse(await readFile(join(client, "startups", freshId, "record.json"), "utf8")) as RexBootstrapRecord;
      assert.equal(fresh.client, replacement); assert.equal(fresh.machineId, record.machineId);
      assert.equal((await hubCommand(port, "history", { chatId: task.chatId }, status.hubId) as any).items.filter((entry: any) => entry.kind === "deck.input").length, 1);
      }
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
      await chmod(daemon.directory, 0o700);
      const latest = JSON.parse(await readFile(join(daemon.directory, "rex-connection.json"), "utf8").catch(() => "null"));
      if (latest?.pid && latest.rexClient?.socket === daemon.socket) daemon.pid = latest.pid;
      const command = await invoke("/bin/ps", ["-p", String(daemon.pid), "-o", "command="], work).catch(() => "");
      if (command.includes(daemon.directory) && command.includes("worker rex")) { process.kill(daemon.pid, "SIGTERM"); await new Promise(r => setTimeout(r, 1000)); }
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
