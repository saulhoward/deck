import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { encodeFrame, FrameDecoder } from "./protocol.js";
const binary = process.env.DECK_TEST_BINARY;

test("new client reuses the verified original client without changing worker identity, receipts or uncertain state", { skip: !binary, timeout: 100_000 }, async () => {
  const root = await realpath(await mkdtemp("/tmp/deck-worker-contact-"));
  const machineId = randomBytes(16).toString("hex"), hostId = "00000000-0000-4000-8000-000000000001", hubId = "00000000-0000-4000-8000-000000000002", account = "contact-fixture";
  const socketRoot = `/tmp/deck-rex-${process.getuid!()}-${machineId}`, socket = join(socketRoot, "client.sock");
  await mkdir(socketRoot, { mode: 0o700 });
  let native = await realpath(binary!);
  const wrapped = join(dirname(native), ".deck-wrapped");
  if (await access(wrapped).then(() => true, () => false)) native = wrapped;
  const old = join(root, "original-client"); await copyFile(native, old); await chmod(old, 0o700);
  const digest = createHash("sha256").update(await readFile(old)).digest("hex");
  const clientRoot = join(root, "client"), key = createHash("sha256").update(JSON.stringify([hostId, account, 52800])).digest("hex"), worker = join(clientRoot, "workers", key);
  await mkdir(worker, { recursive: true, mode: 0o700 });
  await chmod(clientRoot, 0o700); await chmod(join(clientRoot, "workers"), 0o700);
  const config = JSON.stringify({ version: 1, machine_id: machineId });
  await writeFile(join(worker, "config.json"), config, { mode: 0o600 });
  await mkdir(join(worker, "operations"), { mode: 0o700 });
  const uncertain = JSON.stringify({ hash: "a".repeat(64), result: null });
  await writeFile(join(worker, "operations", "1.json"), uncertain, { mode: 0o600 });
  const fakeRex = join(root, "rex");
  await writeFile(fakeRex, `#!${process.execPath}\nif (process.argv.includes("whoami")) console.log(JSON.stringify(${JSON.stringify({ host_id: hostId, instance_id: hubId, account, api_revision: 14 })})); else process.exitCode=1;\n`, { mode: 0o700 });
  const holderEntry = join(root, "holder.mjs");
  await writeFile(holderEntry, 'process.stdin.resume(); process.stdin.on("end",()=>process.exit(0)); process.stdout.write("held\\n");');
  const env = { HOME: root, PATH: "/usr/bin:/bin", DECK_NODE: process.execPath, DECK_RUNTIME_ROOT: resolve("."), DECK_CLIENT_STATE_DIRECTORY: clientRoot };
  // This fixture owns the real writer lock, but has no Harness or effect loop.
  // All launcher replies below are read-only, scoped, test-owned responses.
  const holder = spawn(native, ["serve", "--mock", "--stdio", "--directory", worker, "--runtime", holderEntry], { env });
  const closed = once(holder, "close"); let diagnostics = "", output = "";
  holder.stderr.on("data", b => { diagnostics += String(b); }); holder.stdout.on("data", b => { output += String(b); });
  const commands: string[] = [];
  const server = createServer(peer => {
    const decoder = peer.pipe(new FrameDecoder());
    peer.on("error", () => {}); decoder.on("error", () => peer.destroy());
    decoder.on("data", frame => {
      assert.deepEqual(frame.launcher, { hubId });
      const request = JSON.parse(frame.body); commands.push(request.command); assert.equal(request.command, "launch_list");
      peer.end(encodeFrame({ version: 1, id: request.id, ok: true, result: { hubId, machineId, items: [] } }));
    });
  });
  const connectionFile = join(worker, "rex-connection.json");
  const connection = { version: 1, server: "https://fixture.invalid", hostId, hubId, account, executable: fakeRex, hubPort: 52800, pendingSession: false, pid: holder.pid!, implementation: digest, rexClient: { executable: old, socket } };
  const save = (value: unknown) => writeFile(connectionFile, JSON.stringify(value), { mode: 0o600 });
  const invoke = (environment: NodeJS.ProcessEnv = env) => new Promise<{ ok: boolean; stdout: string; stderr: string; failure: string | undefined }>(done => {
    execFile(native, ["agent", "--hub", connection.server, "--rex", fakeRex, "--list"], { env: environment, cwd: root, timeout: 20000 }, (error, stdout, stderr) => done({ ok: !error, stdout, stderr, failure: error?.message }));
  });
  try {
    for (let i = 0; !output.includes("held"); i++) {
      assert.ok(i < 200 && holder.exitCode === null && holder.signalCode === null, diagnostics);
      await new Promise(r => setTimeout(r, 10));
    }
    server.listen(socket); await once(server, "listening");
    await save(connection);
    const result = await invoke(); assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.stdout, /No independent tasks/); assert.match(result.stderr, /verified client \(including its UI version\)/);
    assert.equal(commands.length, 3); // Original worker readiness, selection and list; no mutations.
    assert.equal(await readFile(connectionFile, "utf8"), JSON.stringify(connection));
    assert.equal(await readFile(join(worker, "config.json"), "utf8"), config);
    assert.equal(await readFile(join(worker, "operations", "1.json"), "utf8"), uncertain);
    assert.equal(holder.exitCode, null); assert.equal(holder.signalCode, null);
    const count = commands.length;
    for (const change of [{ pendingSession: true }, { hostId: hubId }, { account: "different" }, { hubPort: 52801 }]) {
      const changed = { ...connection, ...change }; await save(changed);
      const refused = await invoke(); assert.equal(refused.ok, false); assert.match(refused.stderr, /identity differs or session creation is unconfirmed/);
      assert.equal(await readFile(connectionFile, "utf8"), JSON.stringify(changed));
    }
    await symlink(old, join(root, "alias"));
    const corrupt = join(root, "changed-client"); await copyFile(old, corrupt); await writeFile(corrupt, "\x7fELFchanged");
    for (const path of [join(root, "missing"), join(root, "alias"), corrupt]) {
      const changed = { ...connection, rexClient: { ...connection.rexClient, executable: path } }; await save(changed);
      const refused = await invoke(); assert.equal(refused.ok, false); assert.match(refused.stderr, /pinned client could not be safely reused/);
      assert.equal(await readFile(connectionFile, "utf8"), JSON.stringify(changed));
    }
    await save(connection);
    if (process.getuid!() !== 0) {
      // A valid image can still be refused by exec (owner lacks execution
      // permission even though another execution bit is set). No fallback.
      await chmod(old, 0o401);
      const denied = await invoke(); assert.equal(denied.ok, false);
      assert.match(denied.stderr, /pinned client could not be safely reused/);
      assert.equal(await readFile(connectionFile, "utf8"), JSON.stringify(connection));
      await chmod(old, 0o700);
    }
    const recursive = await invoke({ ...env, DECK_WORKER_CLIENT_REUSE: "1" });
    assert.equal(recursive.ok, false); assert.match(recursive.stderr, /pinned client could not be safely reused/);
    assert.equal(commands.length, count); assert.equal(holder.exitCode, null);
    assert.equal(await readFile(join(worker, "operations", "1.json"), "utf8"), uncertain);
  } finally {
    holder.stdin.end();
    const kill = setTimeout(() => holder.kill("SIGKILL"), 2000);
    try { await closed; } finally { clearTimeout(kill); }
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    await rm(socketRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  }
});
