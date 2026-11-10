import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const binary = process.env.DECK_TEST_BINARY;
const selected = new Set(["selected status", "wrong selected chat", "wrong pinned hub", "unsafe main", "status private field", "started login", "started wrong login", "auth event variants", "terminal login cannot prompt", "private provider event", "reply accepted", "reply cannot echo answer"]);
const fixtures = JSON.parse(await readFile(new URL("../../src/status_login.test.json", import.meta.url), "utf8")) as any[];
for (const fixture of fixtures.filter((f) => selected.has(f.name))) test(`native status/login forwarding: ${fixture.name}`, { skip: !binary, timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-control-native-"));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.equal(spawnSync(binary!, ["init", "--directory", root]).status, 0);
  const writer = join(root, "writer.mjs"), calls = join(root, "calls");
  await writeFile(writer, `import {appendFileSync} from 'node:fs'; let input=Buffer.alloc(0);process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE(0)){const n=input.readUInt32BE(0),request=JSON.parse(input.subarray(4,n+4));input=input.subarray(n+4);appendFileSync(${JSON.stringify(calls)},'read\\n');const body=Buffer.from(JSON.stringify({version:1,id:request.id,ok:true,result:${JSON.stringify(fixture.result)}}));const header=Buffer.alloc(4);header.writeUInt32BE(body.length);process.stdout.write(Buffer.concat([header,body]));}});`);
  const hub = spawn(binary!, ["serve", "--mock", "--directory", root, "--port", String(port), "--runtime", writer]); const closed = once(hub, "close"); let errors = ""; hub.stderr.on("data", (b) => { errors += String(b); }); hub.stdout.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let i = 0; i < 300 && !errors.includes("hub listening"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(errors, /hub listening/);
    const value = await fetch(`http://127.0.0.1:${port}/v1/command`, { method: "POST", body: JSON.stringify({ version: 1, id: "test", command: fixture.command, args: fixture.args, hubId: fixture.hubId }), signal: AbortSignal.timeout(3000) }).then((res) => res.json(), () => null);
    if (fixture.valid) assert.deepEqual(value, { version: 1, id: "test", ok: true, result: fixture.result });
    else {
      assert.equal(value, null);
      const result = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Invalid status/login did not fence transport")), 3000); })]);
      assert.notEqual(result[0], 0); assert.match(errors, /runtime unavailable/);
    }
    assert.equal(await readFile(calls, "utf8"), "read\n"); assert.doesNotMatch(errors, /PRIVATE/);
  } finally { clearTimeout(timer); if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGKILL"); await closed; await rm(root, { recursive: true, force: true }); }
});
