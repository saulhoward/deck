import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { RESTORE_MARKER } from "./backup.js";
const binary = process.env.DECK_TEST_BINARY;
async function until(read: () => Promise<boolean>) {
  for (let index = 0; index < 500; index++) { if (await read()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Backup fixture did not become ready");
}

test("native backup/restore preserve retained and uncertain effects without replay; existing destinations and unsafe flag combinations refuse", { skip: !binary, timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-backup-native-")); const state = join(root, "state");
  const invoke = (args: string[]) => spawnSync(binary!, args, { encoding: "utf8", timeout: 5000 });
  try {
    assert.equal(invoke(["init", "--directory", state]).status, 0);
    const fixture = join(root, "native.mjs");
    await writeFile(fixture, `import assert from 'node:assert/strict';
      const {PipeFiles}=await import(${JSON.stringify(pathToFileURL(resolve("runtime/dist/host-files.js")).href)});
      const args=process.argv.slice(2),tools=new PipeFiles(Number(args[6]),Number(args[7]),Number(args[8]));
      const binding={machineId:args[1],cwd:args[2]};
      try {
        const result=await tools.call(binding,'9100','write',{path:'effect.txt',content:'only once'});
        assert.equal(result.ok,true);
        if(process.env.RESTORED_TEST==='1') assert.equal((await tools.call(binding,'9200','write',{path:'uncertain.txt',content:'never replay'})).code,'effect_uncertain');
      } finally {await tools.close();}
    `);
    const native = (directory: string, restored = false) => spawnSync(binary!, ["serve", "--stdio", "--mock", "--directory", directory, "--workspace", root, "--runtime", fixture], { encoding: "utf8", timeout: 5000, env: { ...process.env, ...(restored ? { RESTORED_TEST: "1" } : {}) } });
    const original = native(state); assert.equal(original.status, 0, original.stderr); await rm(join(root, "effect.txt"));
    const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
    const request = { version: 1, id: "9200", machineId: config.machine_id, cwd: await import("node:fs/promises").then((fs) => fs.realpath(root)), operation: "write", args: { path: "uncertain.txt", content: "never replay" } };
    await writeFile(join(state, "worker", "operations", "9200.json"), JSON.stringify({ hash: createHash("sha256").update(JSON.stringify(request)).digest("hex"), result: null }), { mode: 0o600 });
    await writeFile(join(state, "auth.json"), "FAKE_PRIVATE_CREDENTIAL_STORE", { mode: 0o600 });
    const backup = join(root, "backup"); const backed = invoke(["backup", "--directory", state, "--output", backup]); assert.equal(backed.status, 0, backed.stderr);
    assert.ok(!(await readdir(join(backup, "files"))).includes("auth.json"));
    const withAuth = join(root, "with-auth"); assert.equal(invoke(["backup", "--directory", state, "--output", withAuth, "--include-credentials"]).status, 0);
    assert.equal(await readFile(join(withAuth, "files", "auth.json"), "utf8"), "FAKE_PRIVATE_CREDENTIAL_STORE");
    const restored = join(root, "restored"); const result = invoke(["restore", "--from", backup, "--directory", restored]); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /no work resumed/);
    assert.equal(await readFile(join(restored, "config.json"), "utf8"), await readFile(join(state, "config.json"), "utf8"));
    const replay = native(restored, true); assert.equal(replay.status, 0, replay.stderr);
    assert.ok(!(await readdir(root)).includes("effect.txt")); assert.ok(!(await readdir(root)).includes("uncertain.txt"));
    assert.notEqual(invoke(["restore", "--from", backup, "--directory", restored]).status, 0);
    assert.notEqual(invoke(["backup", "--directory", state, "--output", backup]).status, 0);
    const nested = join(backup, "nested"); assert.notEqual(invoke(["restore", "--from", backup, "--directory", nested]).status, 0); assert.ok(!(await readdir(backup)).includes("nested"));
    for (const args of [["backup"], ["restore", "--from", backup], ["restore", "--from", backup, "--directory", join(root, "x"), "--include-credentials"], ["serve", "--mock", "--output", join(root, "x")]]) assert.notEqual(invoke(args).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("backup refuses a live Pi writer and its orphaned surviving child, without creating an output", { skip: !binary, timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-backup-live-")); const state = join(root, "state");
  const invoke = (args: string[]) => spawnSync(binary!, args, { encoding: "utf8", timeout: 5000 });
  let writer: number | undefined;
  assert.equal(invoke(["init", "--directory", state]).status, 0);
  const fixture = join(root, "main.mjs"); const pidPath = join(root, "writer.pid");
  await writeFile(fixture, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidPath)},String(process.pid));await import(${JSON.stringify(pathToFileURL(resolve("runtime/dist/main.js")).href)});`);
  const supervisor = spawn(binary!, ["serve", "--stdio", "--mock", "--directory", state, "--runtime", fixture]); const closed = once(supervisor, "close");
  let errors = ""; supervisor.stderr.on("data", (chunk) => { errors += String(chunk); });
  const decoder = supervisor.stdout.pipe(new FrameDecoder()); const frames = decoder[Symbol.asyncIterator]();
  try {
    await until(async () => { try { writer = Number(await readFile(pidPath, "utf8")); return !!writer; } catch { return false; } });
    supervisor.stdin.write(encodeFrame({ version: 1, id: "ready", command: "status" }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { assert.equal((await Promise.race([frames.next(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Writer readiness timed out")), 5000); })])).value.ok, true, errors); }
    finally { clearTimeout(timer); }
    for (const orphan of [false, true]) {
      if (orphan) { const exited = once(supervisor, "exit"); supervisor.kill("SIGKILL"); await exited; }
      const blocked = invoke(["backup", "--directory", state, "--output", join(root, "blocked")]);
      assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /running writer/); assert.ok(!(await readdir(root)).includes("blocked"));
    }
    supervisor.stdin.end(); await closed; writer = undefined;
    const backed = invoke(["backup", "--directory", state, "--output", join(root, "complete")]); assert.equal(backed.status, 0, backed.stderr);
  } finally {
    if (writer) { try { process.kill(writer, "SIGKILL"); } catch { /* Already closed. */ } }
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    decoder.destroy(); await closed; await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["backup", "restore"] as const) test(`${mode} child retains writer lock after supervisor death; interrupted restore never becomes an init/serve target`, { skip: !binary, timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-backup-lock-")); const state = join(root, "state"); const output = join(root, "output");
  const invoke = (args: string[]) => spawnSync(binary!, args, { encoding: "utf8", timeout: 5000 });
  let pid: number | undefined; let supervisor: ReturnType<typeof spawn> | undefined;
  try {
    assert.equal(invoke(["init", "--directory", mode === "backup" ? state : output]).status, 0);
    const fakeRuntime = join(root, "fake-runtime", "runtime", "dist"); await import("node:fs/promises").then((fs) => fs.mkdir(fakeRuntime, { recursive: true }));
    const pidFile = join(root, "child.pid");
    await writeFile(join(fakeRuntime, "backup-main.js"), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
    const args = mode === "backup" ? ["backup", "--directory", state, "--output", output] : ["restore", "--from", output, "--directory", state];
    supervisor = spawn(binary!, args, { env: { ...process.env, DECK_RUNTIME_ROOT: dirname(dirname(fakeRuntime)) } }); supervisor.stdout?.resume(); supervisor.stderr?.resume();
    const closed = once(supervisor, "close");
    await until(async () => { try { pid = Number(await readFile(pidFile, "utf8")); return !!pid; } catch { return false; } });
    const exited = once(supervisor, "exit"); supervisor.kill("SIGKILL"); await exited;
    const blocked = invoke(["init", "--directory", state]); assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /running writer/);
    assert.notEqual(invoke(["backup", "--directory", state, "--output", join(root, "competing")]).status, 0);
    process.kill(pid!, "SIGKILL"); pid = undefined; await closed;
    if (mode === "restore") {
      assert.ok((await readdir(state)).includes(RESTORE_MARKER));
      const incomplete = invoke(["init", "--directory", state]); assert.notEqual(incomplete.status, 0); assert.match(incomplete.stderr, /incomplete restore/);
      const serve = invoke(["serve", "--stdio", "--mock", "--directory", state]); assert.notEqual(serve.status, 0); assert.match(serve.stderr, /incomplete restore/);
    } else assert.equal(invoke(["backup", "--directory", state, "--output", join(root, "complete")]).status, 0);
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
