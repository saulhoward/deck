import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeRex, REX_UUID, REX_REJECTED_API_MODES } from "./rex-allocation.test.support.js";
import { freeHubPort } from "./hub-port.test.support.js";
const binary = process.env.DECK_TEST_BINARY;
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, failure = () => new Error("Rex open condition not observed")): Promise<T> {
  for (let i = 0; i < 300; i++) { const value = await read(); if (accept(value)) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw failure();
}
async function waitForHub(hub: ChildProcess, diagnostics: () => string): Promise<void> {
  const failure = (reason: string) => new Error(`Hub ${reason} (exit=${hub.exitCode}, signal=${hub.signalCode}): ${diagnostics().trim() || "no stderr"}`);
  await until(async () => {
    if (hub.exitCode !== null || hub.signalCode !== null) throw failure("exited before listening");
    return diagnostics();
  }, value => value.includes("hub listening"), () => failure("did not listen within the startup budget"));
}

test("Rex fixture reports an occupied enrollment port instead of a readiness timeout", { skip: !binary, timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-open-port-"));
  const occupied = createServer();
  let hub: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined;
  try {
    const port = await freeHubPort();
    occupied.listen(port + 1, "127.0.0.1"); await once(occupied, "listening");
    hub = spawn(binary!, ["serve", "--mock", "--directory", root, "--port", String(port)], { timeout: 8000, killSignal: "SIGKILL" });
    closed = once(hub, "close"); let errors = "";
    hub.stderr!.on("data", chunk => { errors += String(chunk); }); hub.stdout!.resume();
    await assert.rejects(waitForHub(hub, () => errors), /Hub exited before listening.*hub\/enrollment port already in use/s);
    await closed; assert.equal(hub.exitCode, 1);
  } finally {
    if (hub && hub.exitCode === null && hub.signalCode === null) hub.kill("SIGKILL");
    await closed;
    if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("public Rex CLI/HTTP uses packaged native effects for new, reuse, replacement and explicit unknown retry", { skip: !binary, timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-open-native-")), server = "unix:///tmp/deck%20rex-fake.sock";
  // Initialize the empty state before adding unrelated fake-CLI fixtures.
  assert.equal(spawnSync(binary!, ["init", "--directory", root]).status, 0);
  const rex = await fakeRex(root, "", server, true); await writeFile(join(root, "views"), "0");
  const bin = join(root, "bin"); await mkdir(bin); await symlink(process.execPath, join(bin, "node"));
  // Default serve binds both the HTTP port and the adjacent enrollment port.
  // listen(0) probes only one and can collide with ephemeral client connections.
  const port = await freeHubPort();
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as { machine_id: string };
  // An isolated PATH cannot fall through to the user's installed Rex. Routing
  // and focus env must not escape into the native discovery/allocation CLI.
  const env = { ...process.env, PATH: bin, REX_SERVER: "https://wrong.example", REX_HOME: "https://wrong.example", REX_SESSION: "PRIVATE", REX_BLOCK: "PRIVATE", OPENAI_API_KEY: "PRIVATE", DECK_CLIENT_STATE_DIRECTORY: join(root, "drafts") };
  const hub = spawn(binary!, ["serve", "--mock", "--directory", root, "--workspace", root, "--port", String(port)], { env });
  const closed = once(hub, "close"); let errors = ""; hub.stderr.on("data", (chunk) => { errors += String(chunk); }); hub.stdout.resume();
  let hubId: string | undefined;
  const command = async (command: string, args = {}): Promise<any> => {
    let value: any;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/command`, { method: "POST", body: JSON.stringify({ version: 1, id: "test", hubId, command, args }), signal: AbortSignal.timeout(4000) });
      value = await res.json();
    } catch (cause) { throw new Error(`Rex fixture ${command} request failed (exit=${hub.exitCode}, signal=${hub.signalCode}): ${errors.trim() || "no stderr"}`, { cause }); }
    assert.equal(value.ok, true, JSON.stringify(value)); return value.result;
  };
  try {
    await waitForHub(hub, () => errors);
    const status = await command("status");
    assert.equal(status.binding.machineId, config.machine_id); // Probing is not a port lease; never mutate another hub.
    hubId = status.hubId; assert.equal(status.rexOpen, 1);
    const chatId = (await command("create_task", { title: "Rex public", requestId: "task", ...status.binding })).chatId;
    const cli = (action: string, extra: string[] = [], task = chatId, success = true) => {
      const child = spawnSync(binary!, ["rex", action, "--task", task, "--port", String(port), ...extra], { env, encoding: "utf8", timeout: 8000 });
      assert.equal(child.status, success ? 0 : 1, child.stderr); assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE/); return child.stdout + child.stderr;
    };
    assert.match(cli("status"), /unallocated/);
    assert.match(cli("open", [], chatId, false), /Local Rex unavailable/); // Missing PATH executable, no task admitted.
    await symlink(rex, join(bin, "rex"));
    for (const mode of [...REX_REJECTED_API_MODES, "wrong_server", "inspect-identity", "resolve-remote", "resolve-tcp", "resolve-malformed"]) {
      await writeFile(join(root, "mode"), mode);
      // Wrong-host protection is an optional override, not guessed authority.
      const overrides = mode === "wrong_server" ? ["--host-id", REX_UUID] : mode === "inspect-identity" ? ["--instance-id", REX_UUID] : [];
      assert.match(cli("open", overrides, chatId, false), /Local Rex unavailable/);
      assert.match(cli("status"), /unallocated/);
    }
    await assert.rejects(readFile(join(root, "created")), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(root, "worker/operations")), []);
    await writeFile(join(root, "mode"), "api16");
    assert.match(cli("open"), /admitted/);
    const settled = () => until(() => command("rex_status", { chatId }), (value) => value.status !== "pending");
    let state = await settled(); assert.equal(state.status, "allocated"); assert.equal(state.binding.server, server); const first = state.taskId;
    await writeFile(join(root, "mode"), "api9"); // Intermediate revisions also retain API 8.
    assert.match(cli("open"), /reused/); assert.equal((await readFile(join(root, "created"), "utf8")).trim().split("\n").length, 1);
    assert.match(cli("inspect"), /running/);
    for (const mode of ["inspect-exited", "inspect-missing-terminal", "inspect-missing-session"]) {
      await writeFile(join(root, "mode"), mode); assert.match(cli("reopen"), /admitted/);
      state = await settled(); assert.equal(state.status, "allocated"); assert.ok(state.previousBinding); assert.notEqual(state.taskId, first);
    }
    const calls = (await readFile(join(root, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls.filter((args) => ["run", "new"].includes(args[5]!)).map((args) => args[5]), ["new", "run", "run", "new"]);
    // A native rejection AFTER issue is unknown, not permission to replay its ID.
    await writeFile(join(root, "mode"), "inspect-exited");
    assert.match(cli("reopen"), /admitted/); await settled();
    await writeFile(join(root, "mode"), "inspect-missing-session");
    // Separate task starts with a failed creation, then explicitly makes a new attempt.
    const other = (await command("create_task", { title: "Unknown", requestId: "other", ...status.binding })).chatId;
    await writeFile(join(root, "mode"), "failed");
    // A legacy raw-space endpoint and Rex's encoded status endpoint refer to
    // the same socket. Keep the saved spelling rather than rewriting records.
    const target = { executable: rex, server: decodeURIComponent(server), hostId: REX_UUID, instanceId: REX_UUID };
    const args = { chatId: other, port, requestId: "00000000-0000-4000-8000-000000000001", target };
    const uncertain = await command("rex_open", args);
    const unknown = await until(() => command("rex_status", { chatId: other }), (value) => value.status !== "pending"); assert.equal(unknown.status, "uncertain");
    assert.deepEqual(await command("rex_open", args), uncertain);
    await writeFile(join(root, "mode"), "api99"); // No hard-coded ceiling for later compatible APIs.
    const retry = await command("rex_open", { chatId: other, port, requestId: "00000000-0000-4000-8000-000000000002" }); assert.notEqual(retry.taskId, uncertain.taskId);
    const retried = await until(() => command("rex_status", { chatId: other }), (value) => value.status !== "pending");
    assert.equal(retried.status, "allocated"); assert.equal(retried.binding.server, target.server);
    assert.match(cli("inspect", [], other), /running/);
    const partial = (await command("create_task", { title: "Partial overrides", requestId: "partial", ...status.binding })).chatId;
    assert.match(cli("open", ["--server", server], partial), /admitted/);
    assert.equal((await until(() => command("rex_status", { chatId: partial }), (value) => value.status !== "pending")).status, "allocated");
    assert.deepEqual((await command("history", { chatId })).items, []); assert.deepEqual((await command("history", { chatId: other })).items, []);
    assert.equal((await command("list_chats")).items.length, 4);
  } finally { hub.kill("SIGTERM"); await closed; await rm(root, { recursive: true, force: true }); }
});

const fixtures = JSON.parse(await readFile(new URL("../../src/rex_open.test.json", import.meta.url), "utf8")) as any[];
for (const fixture of fixtures.filter((f) => ["admitted", "wrong chat", "unsafe task", "unallocated", "private status", "unbound inspection"].includes(f.name))) test(`native Rex forwarding: ${fixture.name}`, { skip: !binary, timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-rex-wire-"));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.equal(spawnSync(binary!, ["init", "--directory", root]).status, 0);
  const writer = join(root, "writer.mjs"), calls = join(root, "calls");
  await writeFile(writer, `import {appendFileSync} from 'node:fs'; let input=Buffer.alloc(0);process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE(0)){const n=input.readUInt32BE(0),request=JSON.parse(input.subarray(4,n+4));input=input.subarray(n+4);appendFileSync(${JSON.stringify(calls)},'read\\n');const body=Buffer.from(JSON.stringify({version:1,id:request.id,ok:true,result:${JSON.stringify(fixture.result)}}));const header=Buffer.alloc(4);header.writeUInt32BE(body.length);process.stdout.write(Buffer.concat([header,body]));}});`);
  const hub = spawn(binary!, ["serve", "--mock", "--directory", root, "--port", String(port), "--runtime", writer]); const closed = once(hub, "close"); let errors = ""; hub.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    await waitForHub(hub, () => errors);
    const value = await fetch(`http://127.0.0.1:${port}/v1/command`, { method: "POST", body: JSON.stringify({ version: 1, id: "test", command: fixture.command, args: fixture.args, hubId: fixture.hubId }), signal: AbortSignal.timeout(3000) }).then((reply) => reply.json(), () => null);
    if (fixture.valid) assert.deepEqual(value, { version: 1, id: "test", ok: true, result: fixture.result }); else assert.equal(value, null);
    assert.equal(await readFile(calls, "utf8"), "read\n"); assert.doesNotMatch(errors, /PRIVATE/);
  } finally { if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGKILL"); await closed; await rm(root, { recursive: true, force: true }); }
});
