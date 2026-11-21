import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { hubCommand } from "./hub-client.js";
import { freeHubPort } from "./hub-port.test.support.js";
import { validRexUuid, type RexBootstrapRecord } from "./generated/contracts.js";

// Opt-in only. Every Rex call targets an explicit test-owned Unix server;
// neither the user's environment, credentials nor default Rex daemon is used.
const deck = process.env.DECK_TEST_BINARY, rex = process.env.DECK_TEST_REX_FORWARD;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 15000; let last: T | undefined;
  while (Date.now() < end) { last = await read(); if (check(last)) return last; await pause(70); }
  throw new Error(`HERE condition not observed: ${JSON.stringify(last)?.slice(-5000)}`);
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close"); child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  try { await closed; } finally { clearTimeout(timer); }
}
type Terminal = { sessionId: string; windowId: string; blockId: string; directory: string; rootPid: number; shellPid: number; launch?: string };

const zshAvailable = await access("/bin/zsh").then(() => true, () => false);
const bashAvailable = await access("/bin/bash").then(() => true, () => false);
const loginAvailable = await access("/usr/bin/login").then(() => true, () => false);
const variants = [
  { remote: false, shell: "script", wrapped: false, login: false },
  { remote: true, shell: "script", wrapped: false, login: false },
  { remote: false, shell: "zsh", wrapped: false, login: false },
  { remote: false, shell: "bash", wrapped: false, login: false },
  { remote: false, shell: "zsh", wrapped: true, login: false },
  { remote: false, shell: "zsh", wrapped: false, login: true },
  { remote: true, shell: "zsh", wrapped: false, login: true },
] as const;
for (const { remote, shell, wrapped, login } of variants) test(`native HERE ${remote ? "remote" : "local"}${shell !== "script" ? ` interactive ${shell}` : ""}${wrapped ? " wrapped" : ""}${login ? " login-root" : ""}: existing shell create/resume, same-session child, refusal and detached-client inspection`, { skip: !deck || !rex || (shell === "zsh" && !zshAvailable) || ((shell === "bash" || wrapped) && !bashAvailable) || (login && (process.platform !== "darwin" || process.getuid?.() === 0 || process.geteuid?.() === 0 || !loginAvailable)), timeout: 180000 }, async (testContext) => {
  const interactive = shell !== "script";
  const root = await realpath(await mkdtemp("/tmp/deck-here-native-"));
  const work = join(root, "saved-work"), invoking = join(root, "invoking-work"), client = join(root, "client");
  const localHome = join(root, "local"), hubHome = remote ? join(root, "remote") : localHome;
  for (const dir of new Set([work, invoking, localHome, hubHome, join(root, "bin")])) await mkdir(dir);
  await symlink(rex!, join(root, "bin", "rex"));
  // Model makeWrapper's exec -a and .deck-wrapped executable name without
  // running any installed Deck package or modifying the checkout binary.
  const clientDeck = wrapped ? join(root, "bin", "deck") : deck!;
  if (wrapped) {
    const selected = await realpath(deck!);
    const nativeSibling = join(dirname(selected), ".deck-wrapped");
    const nativeDeck = await access(nativeSibling).then(() => nativeSibling, () => selected);
    await copyFile(nativeDeck, join(root, "bin", ".deck-wrapped"));
    await chmod(join(root, "bin", ".deck-wrapped"), 0o700);
    await symlink(join(dirname(deck!), "deck-worker"), join(root, "bin", "deck-worker"));
    await writeFile(clientDeck, `#!/bin/bash --noprofile\nexec -a "$0" ${quote(join(root, "bin", ".deck-wrapped"))} "$@"\n`, { mode: 0o700 });
  }
  const config = join(root, "empty.lua"); await writeFile(config, "");
  const envFor = (home: string): NodeJS.ProcessEnv => ({ HOME: home, ZDOTDIR: home, PATH: `${root}/bin:/usr/bin:/bin`, REX_RUNTIME_DIR: join(home, "rex"), TMPDIR: root, TERM: "xterm-256color", LANG: "en_US.UTF-8", DECK_RUNTIME_ROOT: resolve("."), DECK_NODE: process.execPath, DECK_CLIENT_STATE_DIRECTORY: client });
  const endpoint = (home: string) => `unix://${home}/rex/server.sock`;
  const invoke = (binary: string, args: string[], env = envFor(localHome), cwd = work, timeout = 20000) => new Promise<string>((accept, reject) => {
    execFile(binary, args, { env, cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${args[0]}: ${stderr.slice(-4000)}`)) : accept(stdout));
  });
  const rexCall = (home: string, ...args: string[]) => invoke(rex!, ["--autostart=false", "--timeout", "2s", "--server", endpoint(home), ...args], envFor(home), work, 5000);
  const rexJson = async (home: string, ...args: string[]): Promise<any> => JSON.parse(await rexCall(home, ...args));
  const port = await freeHubPort();
  const flags = ["--port", String(port), "--rex", rex!, "--server", endpoint(localHome), ...(remote ? ["--hub", endpoint(hubHome)] : ["--local"])];
  const servers: ChildProcess[] = [], terminals: Terminal[] = []; let hub: ChildProcess | undefined, errors = "", hubId = "";
  const command = (name: string, args: Record<string, unknown> = {}): Promise<any> => hubCommand(port, name, args, hubId);
  const capture = (t: Terminal) => rexCall(localHome, "capture", "--session", t.sessionId, "--block", t.blockId, "--trim", "--unwrap");
  // Drive the terminal's exact-byte input API (installed Rex names it `write`).
  // Unlike paste/send-key, this queues exact UTF-8 bytes (including Enter).
  const input = (t: Terminal, data: string) => rexJson(localHome, "block", "call", "write", JSON.stringify({ data }), "--session", t.sessionId, "--block", t.blockId);
  const processState = (t: Terminal) => rexJson(localHome, "block", "call", "process", "--session", t.sessionId, "--block", t.blockId);
  const identity = async (pid: number) => {
    // ps uses the public kernel process table, so this can observe a real
    // setuid login even when libproc's proc_pidinfo rejects it with EPERM.
    const fields = (await invoke("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,uid=,ruid=,svuid=,pgid=,tdev="])).trim().split(/\s+/);
    assert.equal(fields.length, 7);
    return { pid: Number(fields[0]), ppid: Number(fields[1]), uid: Number(fields[2]), ruid: Number(fields[3]), svuid: Number(fields[4]), pgid: Number(fields[5]), tty: fields[6] };
  };
  const loginIdentities = async (t: Terminal) => {
    const rootIdentity = await identity(t.rootPid), shellIdentity = await identity(t.shellPid), uid = process.getuid!();
    assert.notEqual(t.rootPid, t.shellPid, "login must remain the Rex child, not exec the user shell");
    assert.equal(rootIdentity.uid, 0); assert.equal(rootIdentity.ruid, uid); assert.equal(rootIdentity.svuid, 0);
    assert.equal(shellIdentity.uid, uid); assert.equal(shellIdentity.ruid, uid); assert.equal(shellIdentity.svuid, uid);
    assert.equal(shellIdentity.ppid, t.rootPid, "the unprivileged zsh must be login's child");
    assert.notEqual(rootIdentity.tty, "??"); assert.equal(rootIdentity.tty, shellIdentity.tty);
    return { rootIdentity, shellIdentity };
  };
  const topology = async () => {
    const sessions = (await rexJson(localHome, "session", "ls", "--json", "--short=false")).sessions;
    const result = [];
    for (const s of sessions) {
      const blocks = await rexJson(localHome, "block", "ls", "--session", s.session_id, "--json", "--short=false");
      result.push({ sessionId: s.session_id, blocks: blocks.blocks.map((b: any) => b.block_id).sort() });
    }
    return result.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  };
  const startupBytes = async () => {
    const files: Record<string, string> = {};
    for (const name of (await readdir(join(client, "startups")).catch(() => [])).sort()) {
      if (validRexUuid(name)) for (const file of (await readdir(join(client, "startups", name))).sort()) files[`${name}/${file}`] = (await readFile(join(client, "startups", name, file))).toString("base64");
      else files[name] = (await readFile(join(client, "startups", name))).toString("base64");
    }
    return files;
  };
  const openShell = async (name: string, extra: string[], cwd = work, hints: Record<string, string | null> = {}, nestedLogin = false) => {
    const directory = join(root, name); await mkdir(directory);
    // Rex opens only this owned shell. Deck has not even started at the topology
    // snapshot. The shell remains alive after Deck detaches (not exec deck).
    assert.ok(!nestedLogin || (login && interactive), "nested login is confined to the private login-root fixtures");
    // Pause the unprivileged inner shell only long enough to observe the real
    // intermediate's credentials and ancestry. exec preserves this client PID;
    // neither login is replaced by a privileged shell or the Deck executable.
    const observeIntermediate = nestedLogin ? `echo $PPID > ${quote(join(directory, "intermediate.pid"))}; printf '%s\\n' "$REX_SESSION" "$REX_BLOCK" "$REX_SERVER" > ${quote(join(directory, "hints"))}; while [ ! -f ${quote(join(directory, "identity-checked"))} ]; do sleep .02; done; ` : "";
    const inner = `echo $$ > ${quote(join(directory, "client.pid"))}; ${observeIntermediate}exec ${[clientDeck, "agent", ...flags, ...extra, "--here"].map(quote).join(" ")}${nestedLogin ? ` 2> ${quote(join(directory, "native.stderr"))}` : ""}`;
    const privateEnv = [...Object.entries(envFor(localHome)).map(([key, value]) => `${key}=${value}`), `REX_SERVER=${endpoint(localHome)}`];
    const innerCommand = [...(nestedLogin ? ["/usr/bin/login", "-flpq", userInfo().username, "/usr/bin/env", ...privateEnv] : []), "/bin/sh", "-c", inner].map(quote).join(" ");
    const patch = Object.entries(hints).map(([key, value]) => value === null ? `unset ${key};` : `export ${key}=${quote(value)};`).join(" ");
    const script = `echo $$ > ${quote(join(directory, "shell.pid"))}; while [ ! -f ${quote(join(directory, "go"))} ]; do sleep .02; done; ${patch} ${innerCommand}; echo $? > ${quote(join(directory, "done"))}; while :; do sleep 1; done`;
    // The interactive variant uses the REAL Rex PTY and shell job control,
    // not the fake Rex foreground response in rex-here-pty-test.py. -f and the
    // private HOME prevent loading personal shell configuration (bash also
    // disables both profile and rc loading).
    // macOS login -f is permitted for the current account only. No sudo,
    // password, alternate user or fake process response is involved. -l keeps
    // the private cwd and disables login-style argv; it does NOT suppress the
    // OS login/audit records. -q suppresses motd/last-login/.hushlogin handling.
    // -p retains Rex's injected IDs. Overrides AFTER login restore private
    // HOME/ZDOTDIR/PATH before zsh runs; -f prevents personal rc/profile reads.
    const created = await rexJson(localHome, "new", name, "--json", "--cwd", cwd, "--shell=none", "--keep-open", "--", ...(login ? ["/usr/bin/login", "-flpq", userInfo().username] : []), "/usr/bin/env", ...privateEnv, ...(shell === "zsh" ? ["/bin/zsh", "-f", "-i"] : shell === "bash" ? ["/bin/bash", "--noprofile", "--norc", "-i"] : ["/bin/sh", "-c", script]));
    const t: Terminal = { sessionId: created.session_id, windowId: created.initial_windows[0].window_id, blockId: created.initial_windows[0].block_ids[0], directory, rootPid: 0, shellPid: 0 };
    terminals.push(t);
    if (interactive) {
      await input(t, `echo $$ > ${quote(join(directory, "shell.pid"))}\r`);
      t.launch = `${patch} ${innerCommand}; echo $? > ${quote(join(directory, "done"))}\r`;
    }
    t.shellPid = Number(await until(() => readFile(join(directory, "shell.pid"), "utf8").catch(() => ""), Boolean));
    await rexJson(localHome, "block", "call", "resize", JSON.stringify({ columns: 110, rows: 40 }), "--session", t.sessionId, "--block", t.blockId);
    const state = await processState(t); t.rootPid = state.child.pid;
    assert.ok(Number.isSafeInteger(t.rootPid) && t.rootPid > 0);
    if (login) {
      assert.equal(state.child.path, "/usr/bin/login"); assert.equal(state.child.user_id, 0);
      assert.equal(state.foreground.pid, t.shellPid); assert.equal(state.foreground.path, "/bin/zsh");
      await loginIdentities(t);
    } else assert.equal(t.rootPid, t.shellPid);
    return t;
  };
  const start = (t: Terminal) => t.launch ? input(t, t.launch) : writeFile(join(t.directory, "go"), "go");
  const waitScreen = (t: Terminal, text: string) => until(() => capture(t), s => s.includes(text));
  const noInput = async (chatId: string) => {
    assert.deepEqual((await command("history", { chatId })).items, []);
    const a = await command("activity", { chatId }); assert.equal(a.busy, false); assert.equal(a.queued, 0);
  };
  // Read-only canonical observation: rex_status intentionally omits the
  // startup receipt. RexDoc is current-only and checkpointed on every write.
  const rexDocument = (chatId: string) => {
    const db = new DatabaseSync(join(root, "hub", "session.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT r.kind, r.content FROM documents d JOIN document_revisions r ON r.document_id = d.id WHERE json_extract(d.record, '$.kind') = 'deck.rex' AND d.owner_id = ? ORDER BY r.seq DESC LIMIT 1").get(Number(chatId));
      if (!row) return undefined;
      assert.equal(row.kind, "base"); return JSON.parse(String(row.content));
    } finally { db.close(); }
  };
  const allocated = async (t: Terminal, chatId: string, cwd: string) => {
    const status = await until(() => command("rex_status", { chatId }), s => s.status === "allocated");
    const metadata = await until(async () => rexDocument(chatId), d => d?.startup?.blockId === t.blockId);
    assert.equal(metadata.binding.blockId, metadata.startup.blockId, "canonical startup observation matched");
    const b = status.binding;
    assert.equal(b.sessionId, t.sessionId); assert.equal(b.windowId, t.windowId); assert.equal(b.blockId, t.blockId); assert.equal(b.cwd, cwd);
    const ids = (await readdir(join(client, "startups"))).filter(validRexUuid);
    const records: RexBootstrapRecord[] = [];
    for (const id of ids) {
      const record = JSON.parse(await readFile(join(client, "startups", id, "record.json"), "utf8").catch(() => "null"));
      if (record?.here?.chatId === chatId) records.push(record);
    }
    assert.equal(records.length, 1); const record = records[0]!;
    const pid = Number(await readFile(join(t.directory, "client.pid"), "utf8"));
    assert.equal(record.binding!.pid, pid); assert.equal(record.here!.process.pid, pid); assert.notEqual(pid, t.shellPid);
    assert.equal(record.here!.terminal.pid, t.rootPid); assert.equal(record.cwd, cwd);
    if (interactive) assert.notEqual(record.here!.process.pgid, record.here!.terminal.pgid, "real interactive job control must give Deck a different process group from the shell");
    if (login) {
      const { rootIdentity, shellIdentity } = await loginIdentities(t);
      assert.equal(record.here!.terminal.ppid, rootIdentity.ppid); assert.equal(record.here!.terminal.pgid, rootIdentity.pgid);
      assert.notEqual(pid, t.rootPid);
      assert.equal(record.here!.terminal.uid, 0, "saved proof identifies the privileged login root");
      assert.equal(record.here!.terminal.executable, "/usr/bin/login");
      assert.equal(record.here!.process.uid, process.getuid!(), "Deck remains the current unprivileged user");
      assert.match(record.here!.terminal.start, /^darwin:[0-9a-f-]{36}:[0-9]+:[0-9]+$/);
      assert.equal(record.here!.terminal.tty, record.here!.process.tty);
      assert.notEqual(record.here!.process.pgid, shellIdentity.pgid, "Deck has its own job-control group, distinct from user zsh as well as root login");
    }
    if (wrapped) {
      assert.equal(record.client, clientDeck, "approved launcher remains the wrapper");
      assert.equal(record.here!.process.executable, join(root, "bin", ".deck-wrapped"), "kernel identity is the native executable, not the wrapper");
    }
    assert.equal(record.claim!.chatId, chatId); assert.equal(record.claim!.allocationId, metadata.allocationId);
    assert.equal(record.machineId, b.machineId); assert.equal(record.binding!.blockId, t.blockId);
    assert.equal(record.binding!.sessionId, t.sessionId);
    assert.equal((await processState(t)).child.pid, t.rootPid);
    await access(join(client, "startups", record.id, "completed.json"));
    await assert.rejects(access(join(client, "startups", `${record.id}.json`)), { code: "ENOENT" });
    return { status, record, pid };
  };
  try {
    for (const home of new Set([localHome, hubHome])) {
      await mkdir(join(home, "rex"));
      const server = spawn(rex!, ["server", "run", "--listen", endpoint(home), "--state-dir", join(home, "rex-state"), "--config", config, "--restore=false"], { env: envFor(home) });
      server.stdout.resume(); server.stderr.on("data", b => { errors = (errors + String(b)).slice(-6000); }); servers.push(server);
      await until(() => access(join(home, "rex/server.sock")).then(() => true, () => false), Boolean);
    }
    if (remote) assert.notEqual((await rexJson(localHome, "whoami", "--json")).host_id, (await rexJson(hubHome, "whoami", "--json")).host_id);
    // The hub and client must use the same approved launcher. A copied client
    // with a hub running another path correctly fails the allocation scope.
    hub = spawn(clientDeck, ["serve", "--mock", "--directory", join(root, "hub"), "--port", String(port)], { env: envFor(hubHome), cwd: invoking });
    hub.stdout!.resume(); hub.stderr!.on("data", b => { errors = (errors + String(b)).slice(-6000); });
    const connected: any = await until(() => hubCommand(port, "status").catch(() => undefined), Boolean); hubId = connected.hubId;
    const fresh = await openShell("create", []);
    const before = await topology(); await start(fresh);
    await waitScreen(fresh, "Create a task");
    assert.deepEqual(await topology(), before, "adoption preflight cannot allocate a terminal");
    const formPid = Number(await readFile(join(fresh.directory, "client.pid"), "utf8"));
    assert.doesNotThrow(() => process.kill(formPid, 0));
    const problem = "Native HERE exact problem 🌍", description = "Not an initial message";
    await input(fresh, problem); await waitScreen(fresh, problem);
    await input(fresh, "\r"); await input(fresh, description); await input(fresh, "\r");
    await waitScreen(fresh, "Create & attach here");
    assert.equal((await command("list_chats")).items.length, 1);
    await input(fresh, "\r"); await waitScreen(fresh, "Enter to send");
    const page = await command("list_chats"), task = page.items.find((c: any) => c.kind === "task"); assert.ok(task); assert.equal(page.items.length, 2);
    assert.deepEqual((await command("status", { chatId: task.chatId })).binding.brief, { problem, description });
    const parent = await allocated(fresh, task.chatId, work);
    if (interactive) {
      const state = await processState(fresh);
      const foregroundPgid = Number(await invoke("/bin/ps", ["-p", String(state.foreground.pid), "-o", "pgid="]));
      assert.equal(foregroundPgid, parent.record.here!.process.pgid, "real Rex foreground selection agrees with the adopted job's process group");
      testContext.diagnostic(JSON.stringify({ shell, wrapped, login, ...(login ? await loginIdentities(fresh) : {}), shellPid: fresh.shellPid, rootPid: fresh.rootPid, rootPgid: parent.record.here!.terminal.pgid, clientPid: parent.pid, clientPgid: parent.record.here!.process.pgid, rexForegroundPid: state.foreground.pid, rexForegroundPgid: foregroundPgid }));
    }
    assert.equal(parent.pid, formPid, "form and adopted TUI preserve the exact Deck process");
    assert.equal(task.machineId === connected.machineId, !remote);
    assert.deepEqual(await topology(), before, "HERE create does not issue Rex new/run"); await noInput(task.chatId);

    // Resume a saved task with NO prior allocation, deliberately from another
    // cwd. Adoption must use the task workspace, never the invoking shell cwd.
    const saved: any = await command("create_task_brief", { requestId: randomUUID(), title: "Saved HERE resume", machineId: task.machineId, cwd: work, problem: "Saved resume brief", description: "No replay" });
    assert.equal((await command("rex_status", { chatId: saved.chatId })).status, "unallocated");
    const savedTask = (await command("list_chats")).items.find((c: any) => c.chatId === saved.chatId);
    const resumed = await openShell("resume", ["--resume", savedTask.agentName], invoking);
    const beforeResume = await topology(); await start(resumed); await waitScreen(resumed, "Enter to send");
    await allocated(resumed, saved.chatId, work);
    assert.deepEqual(await topology(), beforeResume, "HERE resume does not issue Rex new/run"); await noInput(saved.chatId);
    assert.equal((await command("status", { chatId: saved.chatId })).binding.cwd, work);

    // Drive the ACTUAL parent's command mode, not a bridge mock. The command
    // creates an independently allocated child without selecting it or sending
    // either the task brief or the parent's unrelated unsent prompt as input.
    const prompt = "UNSENT_PARENT_PROMPT", childProblem = "Native child own problem";
    await input(fresh, prompt); await waitScreen(fresh, prompt);
    await input(fresh, "\x1b"); await pause(150);
    await input(fresh, `:new-child ${childProblem}`); await waitScreen(fresh, `:new-child ${childProblem}`); await input(fresh, "\r");
    await waitScreen(fresh, "Child TUI opening");
    const parentScreen = await capture(fresh); assert.ok(parentScreen.includes(prompt));
    const childPage = await command("list_chats");
    const child = childPage.items.find((c: any) => c.managedParentChatId === task.chatId); assert.ok(child, JSON.stringify(childPage));
    const childAllocation = await until(() => command("rex_status", { chatId: child.chatId }), s => s.status === "allocated");
    await until(async () => rexDocument(child.chatId), d => d?.startup?.blockId === childAllocation.binding.blockId);
    assert.notEqual(childAllocation.binding.blockId, fresh.blockId); assert.equal(childAllocation.binding.sessionId, fresh.sessionId); assert.equal(childAllocation.binding.cwd, work);
    assert.equal(child.machineId, task.machineId);
    assert.equal((await command("status", { chatId: child.chatId })).binding.brief.problem, childProblem);
    assert.deepEqual(await command("rex_status", { chatId: task.chatId }), parent.status, "child opening never replaces its parent");
    const afterChild = await topology();
    assert.equal(afterChild.length, beforeResume.length, "child opens in the parent's existing session");
    assert.equal(afterChild.reduce((n, s) => n + s.blocks.length, 0), beforeResume.reduce((n, s) => n + s.blocks.length, 0) + 1);
    assert.equal((await processState(fresh)).child.pid, fresh.rootPid); assert.doesNotThrow(() => process.kill(parent.pid, 0));
    await noInput(task.chatId); await noInput(child.chatId);
    // The footer renders the selected task brief, not the child notice.
    assert.ok(parentScreen.split("\n").slice(-3).join("\n").includes(problem), "parent remains selected");

    const refused = async (name: string, extra: string[], hints: Record<string, string | null>, expected: RegExp, nestedLogin = false) => {
      const t = await openShell(name, extra, invoking, hints, nestedLogin);
      const topologyBefore = await topology(), starts = await startupBytes(), tasks = await command("list_chats"), allocation = await command("rex_status", { chatId: task.chatId }), metadata = rexDocument(task.chatId);
      await start(t);
      if (nestedLogin) {
        const intermediatePid = Number(await until(() => readFile(join(t.directory, "intermediate.pid"), "utf8").catch(() => ""), Boolean));
        const clientPid = Number(await readFile(join(t.directory, "client.pid"), "utf8"));
        const intermediateIdentity = await identity(intermediatePid), clientIdentity = await identity(clientPid);
        const { rootIdentity, shellIdentity } = await loginIdentities(t), uid = process.getuid!();
        assert.notEqual(intermediatePid, t.rootPid, "only the outer login is the Rex root");
        assert.equal(intermediateIdentity.ppid, t.shellPid);
        assert.equal(intermediateIdentity.uid, 0); assert.equal(intermediateIdentity.ruid, uid); assert.equal(intermediateIdentity.svuid, 0);
        assert.equal((await invoke("/bin/ps", ["-p", String(intermediatePid), "-o", "comm="])).trim(), "/usr/bin/login");
        assert.equal(clientIdentity.ppid, intermediatePid);
        assert.equal(clientIdentity.uid, uid); assert.equal(clientIdentity.ruid, uid); assert.equal(clientIdentity.svuid, uid);
        assert.equal(clientIdentity.tty, rootIdentity.tty); assert.equal(intermediateIdentity.tty, rootIdentity.tty);
        const state = await processState(t);
        assert.equal(state.child.pid, t.rootPid); assert.equal(state.child.path, "/usr/bin/login"); assert.equal(state.child.user_id, 0);
        assert.equal(await readFile(join(t.directory, "hints"), "utf8"), `${t.sessionId}\n${t.blockId}\n${endpoint(localHome)}\n`, "valid hints still address the exact private terminal");
        testContext.diagnostic(JSON.stringify({ negative: name, rootIdentity, shellIdentity, intermediateIdentity, clientIdentity }));
        await writeFile(join(t.directory, "identity-checked"), "go");
      }
      const exit = await until(() => readFile(join(t.directory, "done"), "utf8").catch(() => ""), Boolean);
      const screen = await capture(t);
      const refusal = nestedLogin ? await readFile(join(t.directory, "native.stderr"), "utf8") : screen;
      // login does not propagate its child's exit status. For the nested case
      // require Deck's precise native refusal, not the outer login's status.
      if (nestedLogin) testContext.diagnostic(JSON.stringify({ negative: name, loginExit: Number(exit), nativeStderr: refusal.trim() }));
      else assert.notEqual(Number(exit), 0);
      assert.match(refusal, expected);
      assert.doesNotMatch(screen, /Create a task/, "refusal happens before the task form");
      assert.deepEqual(await topology(), topologyBefore); assert.deepEqual(await startupBytes(), starts, "refusal preserves durable startup bytes");
      assert.deepEqual(await command("list_chats"), tasks, "refused create makes no task");
      assert.deepEqual(await command("rex_status", { chatId: task.chatId }), allocation);
      assert.deepEqual(rexDocument(task.chatId), metadata, "allocation/startup metadata unchanged");
    };
    await refused("conflict", ["--resume", (await command("status", { chatId: task.chatId })).binding.agentName], {}, /agent startup refused/);
    await refused("partial", [], { REX_SESSION: null }, /agent startup refused/);
    await refused("malformed", [], { REX_BLOCK: "block:short" }, /agent startup refused/);
    await refused("foreign", [], { REX_SESSION: fresh.sessionId, REX_BLOCK: fresh.blockId }, /agent startup refused/);
    // Same credentials/executable as the allowed root, but at an INTERMEDIATE
    // ancestor. Ordinary libproc denial or credential conflict must stay fatal;
    // the root-only sysctl exception must never admit this chain.
    if (login) await refused("privileged-intermediate", [], {}, /native startup reason: (?:ProcessReadFailed|ProcessConflict)\b/, true);

    // Detach only Deck. The Rex root (login or shell) and user shell remain live;
    // inspection must not mistake it for the proven Deck client process.
    await input(fresh, ":q!\r");
    assert.equal(Number(await until(() => readFile(join(fresh.directory, "done"), "utf8").catch(() => ""), Boolean)), 0);
    assert.equal((await processState(fresh)).child.pid, fresh.rootPid);
    assert.doesNotThrow(() => process.kill(fresh.shellPid, 0));
    if (login) await loginIdentities(fresh);
    const inspection = await command("rex_inspect", { chatId: task.chatId });
    assert.equal(inspection.observation.state, "client_exited");
    assert.deepEqual(await command("rex_status", { chatId: task.chatId }), parent.status);
    await noInput(task.chatId);
    // Lost-ACK exact-ID/scope and single-send fences are in here-adoption.test;
    // this suite covers the real native process proof + installed Rex effects.
  } catch (error) {
    const screens = await Promise.all(terminals.map(async t => `${t.directory}:\n${await capture(t).catch(() => "unavailable")}\nRex process: ${JSON.stringify(await processState(t).catch(() => null))}`));
    const drafts = [];
    for (const id of (await readdir(join(client, "startups")).catch(() => [])).filter(validRexUuid)) {
      const record = JSON.parse(await readFile(join(client, "startups", id, "record.json"), "utf8").catch(() => "null"));
      if (record?.here) drafts.push({ id, port: record.port, workerSocket: record.workerSocket, chatId: record.here.chatId, files: await readdir(join(client, "startups", id)), allocation: await command("rex_status", { chatId: record.here.chatId }).catch(() => null) });
    }
    throw new Error(`${String(error)}\nHERE evidence: ${JSON.stringify(drafts)}\n${screens.join("\n")}\n${errors.slice(-1500)}`);
  } finally {
    // Private server/session ownership is unconditional, even if startup fails.
    // Detached workers are killed only after matching their unique directory in
    // the actual process command, never from an unverified ambient PID.
    for (const name of await readdir(join(client, "workers")).catch(() => [])) if (/^[0-9a-f]{64}$/.test(name)) {
      const directory = join(client, "workers", name);
      const c = JSON.parse(await readFile(join(directory, "rex-connection.json"), "utf8").catch(() => "null"));
      if (c?.pid) {
        const cmd = await invoke("/bin/ps", ["-p", String(c.pid), "-o", "command="]).catch(() => "");
        if (cmd.includes(directory) && cmd.includes("worker rex")) {
          process.kill(c.pid, "SIGTERM");
          await until(() => invoke("/bin/ps", ["-p", String(c.pid), "-o", "command="]).catch(() => ""), current => !current.includes(directory));
          // This socket came from the exact verified test-owned daemon, not an
          // ambient Rex path. Retire its private socket/lock directory too.
          if (typeof c.rexClient?.socket === "string" && /^\/tmp\/deck-rex-[0-9]+-[0-9a-f]+\/client\.sock$/.test(c.rexClient.socket)) await rm(dirname(c.rexClient.socket), { recursive: true, force: true });
        }
      }
    }
    for (const home of new Set([localHome, hubHome])) {
      const sessions = await rexJson(home, "session", "ls", "--json", "--short=false").catch(() => ({ sessions: [] }));
      for (const session of sessions.sessions) await rexCall(home, "session", "kill", session.session_id).catch(() => {});
    }
    await stop(hub); for (const server of servers) await stop(server);
    await rm(root, { recursive: true, force: true });
  }
});
