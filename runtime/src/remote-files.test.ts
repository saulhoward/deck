import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseRoutes, RoutedFiles } from "./remote-files.js";
import { PipeFiles } from "./host-files.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
const local = "a".repeat(32), remote = "b".repeat(32);
const routes = { hubId: "hub", hosts: [{ machineId: remote, readFd: 11, writeFd: 12, controlFd: 13 }] };
test("native route projection rejects identity/descriptor aliasing before constructing pipes", () => {
  assert.deepEqual(parseRoutes(JSON.stringify(routes), local, [3, 4, 5, 6]), routes);
  const interactive = { ...routes.hosts[0], rexClient: { executable: "/tools/deck", socket: "/private/worker/client.sock" }, clientReadFd: 14, clientWriteFd: 15 };
  assert.deepEqual(parseRoutes(JSON.stringify({ ...routes, hosts: [interactive] }), local, [3, 4, 5, 6]).hosts[0], interactive);
  for (const value of [
    { ...routes, hosts: [routes.hosts[0], routes.hosts[0]] },
    { ...routes, hosts: [{ ...routes.hosts[0], machineId: local }] },
    { ...routes, hosts: [{ ...routes.hosts[0], readFd: 3 }] },
    { ...routes, hosts: [{ ...routes.hosts[0], writeFd: 11 }] },
    { ...routes, hosts: [{ ...routes.hosts[0], controlFd: 0 }] },
    { ...routes, hosts: [{ ...interactive, clientReadFd: 11 }] },
    { ...routes, hosts: [{ ...interactive, clientWriteFd: undefined }] },
    { ...routes, hosts: [{ ...interactive, rexClient: undefined }] },
    { ...routes, hosts: [{ ...interactive, rexClient: { ...interactive.rexClient, executable: "relative" } }] },
    { ...routes, hosts: [{ ...interactive, rexClient: { ...interactive.rexClient, socket: "/bad\0socket" } }] },
    { ...routes, verified: true },
    { ...routes, hosts: [{ ...routes.hosts[0], extra: true }] },
  ]) assert.throws(() => parseRoutes(JSON.stringify(value), local, [3, 4, 5, 6]));
});
test("routing never falls back from an unavailable saved host or enables remote Rex", async () => {
  let calls = 0, closed = false;
  const native = { call: async () => { calls++; return { ok: true, output: "local" }; }, close: async () => { closed = true; } } as unknown as PipeFiles;
  const files = new RoutedFiles(local, native, { hubId: "hub", hosts: [] });
  assert.equal((await files.call({ machineId: remote, cwd: "/remote" }, "1", "write", { path: "file", content: "never local" })).code, "offline");
  assert.equal((await files.call({ machineId: remote, cwd: "/remote" }, "2", "rex_allocate", { plan: "{}" })).code, "offline");
  assert.equal(calls, 0);
  assert.equal((await files.call({ machineId: local, cwd: "/local" }, "3", "read", { path: "file" })).output, "local");
  assert.equal(calls, 1); await files.close(); assert.equal(closed, true);
});
// Exercise evented inherited descriptors with more readers than libuv's default
// threadpool. The child is only a client adapter; it never opens a Pi store.
test("evented remote pipes do not starve filesystem work and fence only their own host", { timeout: 10_000 }, async () => {
  const script = `
    import { PipeFiles } from ${JSON.stringify(new URL("./host-files.js", import.meta.url).href)};
    import { readFile } from 'node:fs/promises';
    const hosts = Array.from({length: 5}, (_, i) => new PipeFiles(3+i*3, 4+i*3, 5+i*3, true));
    await readFile(process.argv[1]);
    const binding = {machineId:'${remote}',cwd:'/remote'};
    console.log(JSON.stringify(await Promise.all(hosts.map((host, i) => host.call(binding, String(i+1), 'read', {path:'x'}).catch(e=>({error:e.message}))))));
    console.log(JSON.stringify(await hosts[4].call(binding,'20','read',{path:'x'})));
    await Promise.all(hosts.map(h=>h.close()));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, new URL("./remote-files.test.js", import.meta.url).pathname], { stdio: ["ignore", "pipe", "pipe", ...Array.from({ length: 15 }, () => "pipe" as const)] });
  let output = "", errors = ""; child.stdout!.on("data", b => { output += b; }); child.stderr!.on("data", b => { errors += b; });
  const completion = new Promise<number | null>(r => child.on("exit", r));
  try {
    for (let i = 0; i < 5; i++) {
      const decoder = new FrameDecoder(); const requests = child.stdio[4 + i * 3]!, results = child.stdio[3 + i * 3]!;
      (requests as import("node:stream").Readable).pipe(decoder).on("data", (request: { id: string }) => {
        if (i === 0) results.destroy();
        else (results as import("node:stream").Writable).write(encodeFrame({version: 1, id: request.id, result: {ok:true,output:`host-${i}`}}));
      });
    }
    assert.equal(await completion, 0, errors);
    const [first, second] = output.trim().split("\n").map(line => JSON.parse(line));
    assert.match(first[0].error, /effect_uncertain/);
    for (let i = 1; i < 5; i++) assert.equal(first[i].output, `host-${i}`);
    assert.equal(second.output, "host-4");
  } finally { child.kill("SIGKILL"); }
});
const binary = process.env.DECK_TEST_BINARY;
for (const standalone of [false, true]) test(`${standalone ? "standalone" : "deck worker"} init creates private identity without a Pi store and never silently reenrolls`, { skip: !binary, timeout: 10_000 }, async () => {
  const executable = standalone ? resolve(process.env.DECK_TEST_WORKER_BINARY ?? join(dirname(resolve(binary!)), "deck-worker")) : resolve(binary!);
  const prefix = standalone ? [] : ["worker"];
  const parent = await mkdtemp(join(tmpdir(), "deck-worker-cli-")), directory = join(parent, "worker");
  try {
    const args = [...prefix, "init", "--directory", directory, "--hub-id", "hub", "--hub-address", "100.64.0.1:52901", "--hub-node", "nHub", "--hub-user", "18446744073709551615"];
    const result = spawnSync(executable, args, { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
    const saved = await readFile(join(directory, "worker.json"), "utf8"), config = JSON.parse(saved);
    assert.match(config.machineId, /^[a-f0-9]{32}$/); assert.equal(config.hubPeer.userId, "18446744073709551615");
    assert.equal((await stat(directory)).mode & 0o077, 0); assert.equal((await stat(join(directory, "worker.json"))).mode & 0o077, 0);
    assert.deepEqual((await readdir(directory)).sort(), ["worker.json", "writer.lock"]);
    assert.notEqual(spawnSync(executable, args).status, 0);
    assert.equal(await readFile(join(directory, "worker.json"), "utf8"), saved);
    const fake = join(parent, "tailscale");
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' '{"BackendState":"Running","Self":{"ID":"nWorker","UserID":18446744073709551615,"TailscaleIPs":["100.64.0.2"]}}'\n`, {mode: 0o700});
    const identity = spawnSync(executable, [...prefix, "identity", "--directory", directory, "--tailscale", fake], { encoding: "utf8" });
    assert.equal(identity.status, 0, identity.stderr); const projected = JSON.parse(identity.stdout);
    assert.equal(projected.machineId, config.machineId); assert.equal(projected.peer.userId, config.hubPeer.userId);
    assert.match(projected.implementation, /^[a-f0-9]{64}$/); assert.deepEqual(projected.capabilities, ["files", "bash"]); assert.equal(projected.client, false);
    const raw = await readFile(join(dirname(executable), standalone ? ".deck-worker-wrapped" : ".deck-wrapped")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return readFile(executable); throw error; });
    assert.equal(projected.implementation, createHash("sha256").update(raw).digest("hex"));
    const peer = spawnSync(executable, [...prefix, "peer", "--tailscale", fake], { encoding: "utf8" });
    assert.equal(peer.status, 0, peer.stderr); assert.deepEqual(JSON.parse(peer.stdout), projected.peer);
    const clientRoot = await mkdtemp(join(tmpdir(), "drc-"));
    try {
      const clientDirectory = join(clientRoot, "worker"); const clientArgs = [...args]; clientArgs[clientArgs.indexOf(directory)] = clientDirectory;
      clientArgs.push("--client", resolve(binary!));
      const created = spawnSync(executable, clientArgs, { encoding: "utf8" }); assert.equal(created.status, 0, created.stderr);
      const identityArgs = [...prefix, "identity", "--directory", clientDirectory, "--tailscale", fake];
      const identity = spawnSync(executable, identityArgs, { encoding: "utf8" }); assert.equal(identity.status, 0, identity.stderr);
      const interactive = JSON.parse(identity.stdout); assert.deepEqual(interactive.capabilities, ["files", "bash", "rex"]);
      assert.deepEqual(interactive.rexClient, { executable: resolve(binary!), socket: join(clientDirectory, "client.sock") });
      assert.equal(interactive.implementation, projected.implementation);
      const savedClient = JSON.parse(await readFile(join(clientDirectory, "worker.json"), "utf8"));
      savedClient.rexClient.socket = join(clientRoot, "different.sock"); await writeFile(join(clientDirectory, "worker.json"), JSON.stringify(savedClient));
      assert.notEqual(spawnSync(executable, identityArgs).status, 0, "a worker cannot publish a socket outside its pinned directory");
      assert.deepEqual((await readdir(clientDirectory)).sort(), ["worker.json", "writer.lock"]);
    } finally { await rm(clientRoot, { recursive: true, force: true }); }
    assert.notEqual(spawnSync(executable, [...prefix, "serve", "--directory", directory]).status, 0);
    const invalid = [...args]; invalid[invalid.indexOf(directory)] = join(parent, "invalid"); invalid[invalid.length - 1] = "18446744073709551616";
    assert.notEqual(spawnSync(executable, invalid).status, 0); await assert.rejects(stat(join(parent, "invalid")), {code:"ENOENT"});
    const identityArgs = [...prefix, "identity", "--directory", directory, "--tailscale", fake];
    for (const bad of [
      { ...config, hubAddress: "127.0.0.1:52901" }, { ...config, hubAddress: "example.test:52901" },
      { ...config, hubPeer: { ...config.hubPeer, userId: "01" } }, { ...config, hubPeer: { ...config.hubPeer, userId: 1 } },
      { ...config, machineId: "UPPERCASE" }, { ...config, verified: true },
    ]) {
      const bytes = JSON.stringify(bad); await writeFile(join(directory, "worker.json"), bytes);
      const refused = spawnSync(executable, identityArgs, { encoding: "utf8" }); assert.notEqual(refused.status, 0); assert.equal(refused.stdout, "");
      assert.equal(await readFile(join(directory, "worker.json"), "utf8"), bytes);
    }
    await writeFile(join(directory, "worker.json"), saved); await chmod(join(directory, "worker.json"), 0o644);
    assert.notEqual(spawnSync(executable, identityArgs).status, 0); await chmod(join(directory, "worker.json"), 0o600);
    const outside = join(parent, "outside.json"); await writeFile(outside, saved, { mode: 0o600 });
    await unlink(join(directory, "worker.json")); await symlink(outside, join(directory, "worker.json"));
    assert.notEqual(spawnSync(executable, identityArgs).status, 0); await unlink(join(directory, "worker.json"));
    await writeFile(join(directory, "worker.json"), saved, {mode:0o600});
    const badVerifier = spawnSync(executable, [...prefix, "run", "--directory", directory, "--tailscale", "relative-cli"], {timeout:1000});
    assert.equal(badVerifier.error, undefined); assert.notEqual(badVerifier.status, 0);
    assert.deepEqual((await readdir(directory)).sort(), ["worker.json", "writer.lock"]);
  } finally { await rm(parent, {recursive:true,force:true}); }
});
