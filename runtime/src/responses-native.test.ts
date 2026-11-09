import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const binary = process.env.DECK_TEST_BINARY;
for (const mode of ["wrong-id", "missing-result", "truthy-ok", "mixed-payloads", "wrong-version", "malformed-json", "invalid-utf8", "unsafe-ack", "extra-ack", "import-wrong-chat", "import-wrong-request", "stop-false", "stop-extra", "startup-wrong-block", "startup-wrong-allocation", "startup-wrong-chat", "startup-unsafe-task", "startup-live", "startup-no-hub", "list-valid-sparse", "list-valid-empty", "list-valid-terminal", "list-bad-item", "list-extra", "list-unsafe-id", "list-unsafe-link", "list-half-link", "list-duplicate", "list-reversed", "list-before-after", "list-stalled-next", "list-next-before-last", "list-null-next", "list-request-limit"] as const) test(`native HTTP bridge ${mode.startsWith("list-valid-") ? "forwards scoped" : "refuses invalid"} ${mode} private response without replay`, { skip: !binary, timeout: 10_000 }, async () => {
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
        if(mode==='unsafe-ack')value.result.chatId='9007199254740992';
        if(mode==='extra-ack')value.result.private='PRIVATE_RESPONSE';
        if(mode.startsWith('import-'))value.result={chatId:mode==='import-wrong-chat'?'3':request.args.chatId,requestId:mode==='import-wrong-request'?'other-request':request.args.requestId,taskId:'9',admitted:true,completion:'not_waited'};
        if(mode.startsWith('stop-'))value.result={requested:mode!=='stop-false',...(mode==='stop-extra'?{drained:true}: {})};
        if(mode.startsWith('startup-'))value.result={version:1,...request.args,taskId:mode==='startup-unsafe-task'?'9007199254740992':'9',registered:true,observation:'matched',historical:true,live:mode==='startup-live'?'running':'not_checked'};
        if(mode==='startup-wrong-block')value.result.blockId='block:00000000-0000-0000-0000-000000000000';
        if(mode==='startup-wrong-allocation')value.result.allocationId='00000000-0000-0000-0000-000000000000';
        if(mode==='startup-wrong-chat')value.result.chatId='3';
        if(mode.startsWith('list-')) {
          const row=id=>({chatId:id,kind:'task',title:'Saved',machineId:'offline-worker',cwd:'/saved'});
          value.result={items:[row('4')],next:'9'};
          if(mode==='list-valid-empty')value.result.items=[];
          if(mode==='list-valid-terminal')delete value.result.next;
          if(mode==='list-bad-item')value.result.items.push({chatId:'5',kind:'task'});
          if(mode==='list-extra')value.result.items[0].private='PRIVATE_RESPONSE';
          if(mode==='list-unsafe-id')value.result.items[0].chatId='9007199254740992';
          if(mode==='list-unsafe-link')Object.assign(value.result.items[0],{parentChatId:'1',ownerTaskId:'9007199254740992'});
          if(mode==='list-half-link')value.result.items[0].parentChatId='1';
          if(mode==='list-duplicate')value.result.items=[row('4'),row('4')];
          if(mode==='list-reversed')value.result.items=[row('5'),row('4')];
          if(mode==='list-before-after')value.result.items=[row('3')];
          if(mode==='list-stalled-next')value.result.next='3';
          if(mode==='list-next-before-last')value.result={items:[row('6')],next:'4'};
          if(mode==='list-null-next')value.result.next=null;
          if(mode==='list-request-limit')value.result.items.push(row('5'));
        }
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
    const request = {
      version: 1, id: "original-transport-id",
      command: mode.startsWith("list-") ? "list_chats" : mode.startsWith("startup-") ? "rex_startup" : mode.startsWith("stop-") ? "stop" : mode.startsWith("import-") ? "import_instructions" : "create_task",
      args: mode.startsWith("list-") ? { limit: mode === "list-request-limit" ? 1 : 2, after: "3" } : mode.startsWith("startup-") ? { chatId: "2", allocationId: "11111111-1111-4111-8111-111111111111", blockId: "block:11111111-1111-4111-8111-111111111111" } : mode.startsWith("stop-") ? { chatId: "2" } : { requestId: "saved-durable-id", machineId: "saved-host", cwd: "/saved", ...(mode.startsWith("import-") ? { chatId: "2" } : { title: "Original" }) },
      ...(mode.startsWith("startup-") && mode !== "startup-no-hub" ? { hubId: "expected-hub" } : {}),
    };
    const result = await fetch(`http://127.0.0.1:${port}/v1/command`, { method: "POST", body: JSON.stringify(request).replace('"limit":2', '"limit":2.0').replace('"limit":1', '"limit":1e0'), signal: AbortSignal.timeout(3000) }).then(async (response) => ({ status: response.status, body: await response.text() }), () => null);
    if (mode.startsWith("list-valid-")) {
      assert.ok(result); assert.equal(result.status, 200);
      const page = JSON.parse(result.body).result;
      assert.equal(page.items.length, mode === "list-valid-empty" ? 0 : 1);
      assert.equal(page.next, mode === "list-valid-terminal" ? undefined : "9");
      assert.deepEqual((await readFile(committed, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [request]);
      return;
    }
    assert.equal(result, null, "Invalid private response was forwarded to the HTTP client");
    const status = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Invalid response did not fence transport")), 3000); })]);
    assert.notEqual(status[0], 0); assert.match(errors, /runtime unavailable/); assert.doesNotMatch(errors, /PRIVATE_RESPONSE/);
    assert.deepEqual((await readFile(committed, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [request]);
    const listener = createServer(); listener.listen(port, "127.0.0.1"); await once(listener, "listening"); await new Promise<void>((resolve) => listener.close(() => resolve()));
  } finally {
    clearTimeout(timer); if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGKILL"); await closed; await rm(directory, { recursive: true, force: true });
  }
});
