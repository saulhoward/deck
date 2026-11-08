import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const binary = process.env.DECK_TEST_BINARY;
for (const mode of ["wrong-id", "missing-result", "truthy-ok", "mixed-payloads", "wrong-version", "malformed-json", "invalid-utf8"] as const) test(`native HTTP bridge refuses ${mode} private response and fences its transport without replay`, { skip: !binary, timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-response-native-"));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0);
  const fixture = join(directory, "writer.mjs"), committed = join(directory, "committed");
  await writeFile(fixture, `import {appendFileSync} from 'node:fs';
    let input=Buffer.alloc(0);process.stdin.on('data',chunk=>{
      input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE(0)){
        const n=input.readUInt32BE(0),request=JSON.parse(input.subarray(4,n+4));input=input.subarray(n+4);
        appendFileSync(${JSON.stringify(committed)},JSON.stringify(request)+'\\n');
        const mode=${JSON.stringify(mode)};let value={version:1,id:request.id,ok:true,result:{chatId:'2'}};
        if(mode==='wrong-id')value.id='wrong-id';if(mode==='missing-result')delete value.result;
        if(mode==='truthy-ok')value.ok=1;if(mode==='mixed-payloads')value.error={code:'invalid',message:'PRIVATE_RESPONSE'};
        if(mode==='wrong-version')value.version=2;
        let payload=Buffer.from(mode==='malformed-json'?'{PRIVATE_RESPONSE':JSON.stringify(value));
        if(mode==='invalid-utf8')payload=Buffer.concat([Buffer.from('{"version":1,"id":"'+request.id+'","ok":true,"result":{"chatId":"2","opaque":"'),Buffer.from([255]),Buffer.from('"}}')]);
        const header=Buffer.alloc(4);header.writeUInt32BE(payload.length);process.stdout.write(Buffer.concat([header,payload]));
      }
    });`);
  const hub = spawn(binary!, ["serve", "--mock", "--directory", directory, "--port", String(port), "--runtime", fixture]);
  const closed = once(hub, "close"); let errors = ""; hub.stderr.on("data", (chunk) => { errors += String(chunk); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let i = 0; i < 300 && !errors.includes("hub listening"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(errors, /hub listening/);
    const request = { version: 1, id: "original-transport-id", command: "create_task", args: { requestId: "saved-durable-id", title: "Original", machineId: "saved-host", cwd: "/saved" } };
    const result = await fetch(`http://127.0.0.1:${port}/v1/command`, { method: "POST", body: JSON.stringify(request), signal: AbortSignal.timeout(3000) }).then(async (response) => ({ status: response.status, body: await response.text() }), () => null);
    assert.equal(result, null, "Invalid private response was forwarded to the HTTP client");
    const status = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Invalid response did not fence transport")), 3000); })]);
    assert.notEqual(status[0], 0); assert.match(errors, /runtime unavailable/); assert.doesNotMatch(errors, /PRIVATE_RESPONSE/);
    assert.deepEqual((await readFile(committed, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [request]);
    const listener = createServer(); listener.listen(port, "127.0.0.1"); await once(listener, "listening"); await new Promise<void>((resolve) => listener.close(() => resolve()));
  } finally {
    clearTimeout(timer); if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGKILL"); await closed; await rm(directory, { recursive: true, force: true });
  }
});
