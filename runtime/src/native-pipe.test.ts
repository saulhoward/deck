import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import test from "node:test";
import { FrameDecoder, encodeFrame } from "./protocol.js";

// Real inherited descriptors, fake worker, no model/provider/workspace effects.
for (const mode of ["extra", "code", "exit", "mixed", "missing", "wrong-id", "utf8", "lost", "duplicate", "progress", "preflight", "close"]) {
  test(`native pipe ${mode}: bounded validation fences pending work without replay`, { timeout: 10_000 }, async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {PipeFiles} from ${JSON.stringify(new URL("./host-files.js", import.meta.url).href)};
      const host=new PipeFiles(3,4,5), binding={machineId:'worker',cwd:'/saved'}, mode=${JSON.stringify(mode)};
      let samples=0;
      try {
        if(mode==='preflight') {
          for(const [id,operation,args] of [['0','write',{path:'x',content:'PRIVATE'}],['9007199254740992','write',{path:'x',content:'PRIVATE'}],['1','environment',{}],['1','write',{path:'x',content:'🌍'.repeat(32769)}],['1','bash',{command:'true',timeout:301}],['1','read',{path:'\\ud800'}],['progress:1','bash_progress',{target:'1'}]]) await assert.rejects(host.call(binding,id,operation,args),/invalid:.*no operation sent/);
          assert.equal((await host.call(binding,'1','read',{path:'x'})).output,'safe');
        } else if(mode==='duplicate') {
          assert.equal((await host.call(binding,'1','read',{path:'x'})).output,'safe');
          await assert.rejects(host.call(binding,'2','write',{path:'x',content:'PRIVATE'}),/effect_uncertain/);
        } else if(mode==='progress') {
          await assert.rejects(host.call(binding,'1','bash',{command:'true'},undefined,()=>samples++),/effect_uncertain/);
          assert.equal(samples,0);
        } else {
          const first=host.call(binding,'1','write',{path:'x',content:'PRIVATE'});
          const second=host.call(binding,'2','edit',{path:'x',oldText:'x',newText:'PRIVATE'});
          const results=Promise.allSettled([first,second]);
          if(mode==='close') { await new Promise(r=>setTimeout(r,50)); void host.close(); }
          for(const result of await results) { assert.equal(result.status,'rejected');assert.match(result.reason.message,/effect_uncertain/);assert.doesNotMatch(result.reason.message,/PRIVATE/); }
        }
        if(mode!=='preflight') await assert.rejects(host.call(binding,'3','write',{path:'x',content:'PRIVATE'}),/offline/);
        console.log('verified');
      } finally { await host.close(); }
    `], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"] });
    const closed = once(child, "close"); let output = "", errors = "";
    child.stdout!.on("data", (data) => { output += data; }); child.stderr!.on("data", (data) => { errors += data; });
    const fds: ReadonlyArray<typeof child.stdio[number]> = child.stdio;
    const reply = fds[3] as Duplex, requests = (fds[4] as Duplex).pipe(new FrameDecoder());
    const control = fds[5] as Duplex; let cancellationBytes = 0; control.on("data", (data: Buffer) => { cancellationBytes += data.length; });
    const seen: any[] = [];
    const good = (id: string) => ({ version: 1, id, result: { ok: true, output: "safe" } });
    requests.on("data", (request) => {
      seen.push(request);
      if (mode === "preflight") { reply.end(encodeFrame(good(request.id))); return; }
      if (mode === "duplicate" && seen.length === 1) { reply.write(encodeFrame(good(request.id))); return; }
      if (mode === "progress" && request.operation !== "bash_progress") return;
      if (mode !== "progress" && seen.length < 2) return;
      if (mode === "close") { setTimeout(() => reply.end(), 100); return; }
      if (mode === "lost") { reply.end(); return; }
      if (mode === "utf8") {
        const bytes = Buffer.from([0xff]); const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); reply.end(Buffer.concat([header, bytes])); return;
      }
      const value: any = good("1");
      if (mode === "extra") value.result.private = "PRIVATE";
      if (mode === "code") value.result.code = "effect_uncertain";
      if (mode === "exit") value.result.exitCode = 0;
      if (mode === "mixed") value.progress = { output: "PRIVATE", truncated: false, lossyUtf8: false };
      if (mode === "missing") delete value.result;
      if (mode === "wrong-id") value.id = "99";
      if (mode === "progress") { delete value.result; value.id = request.id; value.progress = { output: "🌍".repeat(513), truncated: false, lossyUtf8: false }; }
      // Even a valid reply queued behind the invalid frame must not settle work.
      reply.end(Buffer.concat([encodeFrame(value), encodeFrame(good("2"))]));
    });
    try {
      assert.equal((await closed)[0], 0, errors); assert.match(output, /verified/);
      assert.equal(seen.length, mode === "preflight" ? 1 : 2); assert.equal(cancellationBytes, 0);
    } finally { reply.destroy(); control.destroy(); requests.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; }
  });
}
