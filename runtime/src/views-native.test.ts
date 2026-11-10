import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const binary = process.env.DECK_TEST_BINARY;
const selected = new Set(["activity default args", "progress full sample", "instructions default empty", "history scoped previews", "activity closed nested tool", "activity unsafe tool ID", "progress generation needs run", "instructions requested task wrong", "instructions active with outcome", "instructions applied source mismatch", "history wrong chat before rendering entries", "history unrequested preview"]);
const fixtures = JSON.parse(await readFile(new URL("../../src/views.test.json", import.meta.url), "utf8")) as { name: string; command: string; args: unknown; result: unknown; valid: boolean }[];
for (const fixture of fixtures.filter((item) => selected.has(item.name))) test(`native live view forwarding: ${fixture.name}`, { skip: !binary, timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-view-native-"));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.equal(spawnSync(binary!, ["init", "--directory", root]).status, 0);
  const writer = join(root, "writer.mjs"), calls = join(root, "calls");
  await writeFile(writer, `import {appendFileSync} from 'node:fs';
    let input=Buffer.alloc(0);process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);
      while(input.length>=4&&input.length>=4+input.readUInt32BE(0)) {
        const n=input.readUInt32BE(0),request=JSON.parse(input.subarray(4,n+4));input=input.subarray(n+4);
        appendFileSync(${JSON.stringify(calls)},'read\\n');
        const payload=Buffer.from(JSON.stringify({version:1,id:request.id,ok:true,result:${JSON.stringify(fixture.result)}}));
        const header=Buffer.alloc(4);header.writeUInt32BE(payload.length);process.stdout.write(Buffer.concat([header,payload]));
      }
    });`);
  const hub = spawn(binary!, ["serve", "--mock", "--directory", root, "--port", String(port), "--runtime", writer]);
  const closed = once(hub, "close"); let errors = ""; hub.stderr.on("data", (chunk) => { errors += String(chunk); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let i = 0; i < 300 && !errors.includes("hub listening"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(errors, /hub listening/);
    const result = await fetch(`http://127.0.0.1:${port}/v1/command`, { method: "POST", body: JSON.stringify({ version: 1, id: "read", command: fixture.command, args: fixture.args }), signal: AbortSignal.timeout(3000) }).then((reply) => reply.json(), () => null);
    if (fixture.valid) assert.deepEqual(result, { version: 1, id: "read", ok: true, result: fixture.result });
    else {
      assert.equal(result, null);
      const status = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Invalid view did not fence transport")), 3000); })]);
      assert.notEqual(status[0], 0); assert.match(errors, /runtime unavailable/);
    }
    assert.equal(await readFile(calls, "utf8"), "read\n"); assert.doesNotMatch(errors, /PRIVATE|MUST_NOT_PRINT/);
  } finally {
    clearTimeout(timer); if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGKILL"); await closed;
    await rm(root, { recursive: true, force: true });
  }
});
