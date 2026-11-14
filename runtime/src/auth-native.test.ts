import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { freeHubPort } from "./hub-port.test.support.js";
import { hubCommand } from "./hub-client.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { encodeFrame } from "./protocol.js";
const binary = process.env.DECK_TEST_BINARY;
const fakeKey = "FAKE_OP_KEY_NEVER_PRINT";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deck-auth-native-"));
  const state = join(root, "state"), bin = join(root, "bin"), config = join(root, ".config", "deck");
  await mkdir(bin); await mkdir(config, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: root, PATH: bin, DECK_NODE: process.execPath, OPENAI_API_KEY: "", OP_SESSION_fake: "FAKE_SESSION", OP_SERVICE_ACCOUNT_TOKEN: "FAKE_SERVICE" };
  assert.equal(spawnSync(binary!, ["init", "--directory", state], { env, encoding: "utf8" }).status, 0);
  const mapping = join(config, ".env"), record = join(root, "op-record.json");
  await writeFile(join(bin, "op"), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
const args=process.argv.slice(2); writeFileSync(${JSON.stringify(record)},JSON.stringify({args,reference:process.env.OPENAI_API_KEY}));
if(process.env.FAKE_OP_FAIL)process.exit(23);
if(args[0]!=='run'||args[1]!=='--no-masking'||args[2]!=='--')process.exit(24);
if(process.env.OPENAI_API_KEY!=='op://deck/local-openai-key/credential')process.exit(25);
process.env.OPENAI_API_KEY=${JSON.stringify(fakeKey)};
process.execve(args[3],args.slice(3),process.env);
`, { mode: 0o700 });
  const invoke = (args: string[], input?: Buffer, customEnv: NodeJS.ProcessEnv = env) => spawnSync(binary!, args, { env: customEnv, input, timeout: 15000 });
  const serve = (customEnv: NodeJS.ProcessEnv = env) => invoke(["serve", "--stdio", "--directory", state], encodeFrame({ version: 1, id: "status", command: "status" }), customEnv);
  const status = (output: Buffer) => { assert.equal(output.readUInt32BE(0), output.length - 4); const reply = JSON.parse(output.subarray(4).toString()); assert.equal(reply.ok, true); return reply.result; };
  return { root, state, env, mapping, record, invoke, serve, status, close: () => rm(root, { recursive: true, force: true }) };
}

test("native default serve resolves private references once before state, strips op authorization, and preserves framed IPC", { skip: !binary }, async () => {
  const f = await fixture();
  try {
    await writeFile(f.mapping, 'OPENAI_API_KEY="op://deck/local-openai-key/credential"\n', { mode: 0o600 });
    const result = f.serve({ ...f.env, OPENAI_API_KEY: "ambient-must-not-win" });
    assert.equal(result.status, 0, result.stderr.toString()); assert.equal(f.status(result.stdout).authentication, "api_key");
    assert.doesNotMatch(result.stdout.toString() + result.stderr.toString(), new RegExp(fakeKey + "|FAKE_SESSION|FAKE_SERVICE"));
    const record = JSON.parse(await readFile(f.record, "utf8"));
    assert.equal(record.reference, "op://deck/local-openai-key/credential"); assert.deepEqual(record.args.slice(0, 3), ["run", "--no-masking", "--"]);
    assert.doesNotMatch(JSON.stringify(record.args), new RegExp(fakeKey));
    await assert.rejects(readFile(join(f.state, "auth.json")), { code: "ENOENT" });
    const probe = join(f.root, "environment.cjs"), observed = join(f.root, "environment.json");
    await writeFile(probe, `require('node:fs').writeFileSync(${JSON.stringify(observed)},JSON.stringify({key:process.env.OPENAI_API_KEY===${JSON.stringify(fakeKey)},op:Object.keys(process.env).filter(k=>k.startsWith('OP_SESSION')||k==='OP_SERVICE_ACCOUNT_TOKEN')}));`);
    const checked = f.invoke(["serve", "--stdio", "--directory", f.state, "--runtime", probe]);
    assert.equal(checked.status, 0, checked.stderr.toString()); assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), { key: true, op: [] });
    // Mock never consults even an invalid mapping or op.
    await rm(f.record); await writeFile(f.mapping, "OPENAI_API_KEY=plaintext");
    const mockState = join(f.root, "mock"); assert.equal(f.invoke(["init", "--directory", mockState]).status, 0);
    const mock = f.invoke(["serve", "--stdio", "--mock", "--directory", mockState], encodeFrame({version:1,id:"mock",command:"status"}));
    assert.equal(mock.status, 0, mock.stderr.toString()); assert.equal(f.status(mock.stdout).authentication, "mock"); await assert.rejects(readFile(f.record), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("native startup refuses missing credentials and op failures before creating a Pi store, with no ambient fallback", { skip: !binary }, async () => {
  const f = await fixture();
  try {
    const missing = f.serve(); assert.notEqual(missing.status, 0); assert.match(missing.stderr.toString(), /deck login openai/);
    await assert.rejects(readFile(join(f.state, "session.sqlite")), { code: "ENOENT" });
    await writeFile(f.mapping, 'OPENAI_API_KEY="op://deck/local-openai-key/credential"', { mode: 0o600 });
    const failed = f.serve({ ...f.env, OPENAI_API_KEY: "ambient-fallback-forbidden", FAKE_OP_FAIL: "1" });
    assert.equal(failed.status, 23); await assert.rejects(readFile(join(f.state, "session.sqlite")), { code: "ENOENT" });
    const absent = f.serve({ ...f.env, PATH: "", OPENAI_API_KEY: "ambient-fallback-forbidden" });
    assert.notEqual(absent.status, 0); await assert.rejects(readFile(join(f.state, "session.sqlite")), { code: "ENOENT" });
    await writeFile(f.mapping, "NODE_OPTIONS=op://deck/item/field");
    assert.notEqual(f.serve().status, 0);
    await rm(f.mapping);
    const ambient = f.serve({ ...f.env, OPENAI_API_KEY: "fake-direct-key" });
    assert.equal(ambient.status, 0, ambient.stderr.toString()); assert.equal(f.status(ambient.stdout).authentication, "api_key");
  } finally { await f.close(); }
});

test("native login delegates a held state to its running hub and never starts an offline login", { skip: !binary, timeout: 25000 }, async () => {
  const f = await fixture();
  const port = await freeHubPort();
  const hub = spawn(binary!, ["serve", "--mock", "--directory", f.state, "--port", String(port)], { env: f.env, stdio: "pipe" });
  const closed = once(hub, "close"); hub.stdout.resume(); let errors = ""; hub.stderr.on("data", chunk => { errors += chunk; });
  try {
    let status: any;
    for (let i = 0; i < 100; i++) { try { status = await hubCommand(port, "status"); break; } catch { await new Promise(r => setTimeout(r, 30)); } }
    assert.ok(status, errors); assert.match(status.machineId, /^[a-f0-9]{32}$/);
    assert.equal(status.machineId, JSON.parse(await readFile(join(f.state, "config.json"), "utf8")).machine_id, `readiness must belong to this fixture, not a raced port: ${errors}`);
    // Mock refuses real login, but only AFTER the native online handoff and
    // identity checks. No fake-provider hooks are added to production code.
    const login = f.invoke(["login", "openai", "--directory", f.state, "--port", String(port)]);
    assert.notEqual(login.status, 0); assert.match(login.stderr.toString(), /authenticating through the running hub/);
    assert.doesNotMatch(login.stderr.toString(), /offline ChatGPT/);
    await assert.rejects(readFile(join(f.state, "auth.json")), { code: "ENOENT" });
    assert.equal((await hubCommand(port, "status") as any).hubId, status.hubId);
  } finally {
    hub.kill("SIGTERM"); await closed;
    let drained = false;
    for (let i = 0; i < 100; i++) { if (f.invoke(["backup", "--directory", f.state, "--output", join(f.root, "drained")]).status === 0) { drained = true; break; } await new Promise(r => setTimeout(r, 20)); }
    assert.ok(drained, "writer must drain before fixture cleanup"); await f.close();
  }
});

test("offline login native handoff inherits writer exclusion, starts no Pi, and releases the lock on exit", { skip: !binary, timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    // Native-only injected entry verifies the handoff without contacting OAuth.
    // Use the unwrapped executable when the supplied binary is a package wrapper.
    const raw = join(dirname(resolve(binary!)), ".deck-wrapped");
    const native = await readFile(raw).then(() => raw, () => binary!);
    const runtime = join(f.root, "fixture-runtime"); await mkdir(join(runtime, "runtime", "dist"), { recursive: true });
    await writeFile(join(runtime, "runtime", "dist", "login-main.js"), `const fs=require('node:fs');const a=process.argv.slice(2);if(a[0]!=='offline'||!fs.fstatSync(Number(a[3])).isFile())process.exit(3);
const probe="const fs=require('node:fs');try{const inherited=fs.fstatSync(Number(process.argv[1])),lock=fs.statSync(process.argv[2]);if(inherited.ino===lock.ino&&inherited.dev===lock.dev)process.exit(9)}catch{}";
if(require('node:child_process').spawnSync(process.execPath,['-e',probe,a[3],a[1]+'/writer.lock']).status!==0)process.exit(4);
console.log('LOCKED');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`);
    const child = spawn(native, ["login", "openai", "--directory", f.state], { env: { ...f.env, DECK_RUNTIME_ROOT: runtime }, stdio: "pipe" });
    const closed = once(child, "close"); let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
    try {
      const output = once(child.stdout, "data");
      const [data] = await Promise.race([output, closed.then(code => { throw new Error(`Login exited ${code}: ${errors}`); }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`Login readiness timeout: ${errors}`)), 5000); timer.unref(); })]); assert.match(String(data), /LOCKED/);
      const blocked = f.invoke(["backup", "--directory", f.state, "--output", join(f.root, "blocked")]);
      assert.notEqual(blocked.status, 0); assert.match(blocked.stderr.toString(), /running writer/);
      await assert.rejects(readFile(join(f.state, "session.sqlite")), { code: "ENOENT" });
      child.stdin.end(); assert.equal((await closed)[0], 0);
      const backup = f.invoke(["backup", "--directory", f.state, "--output", join(f.root, "backup")]);
      assert.equal(backup.status, 0, backup.stderr.toString());
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; }
  } finally { await f.close(); }
});
