import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { encodeFrame } from "./protocol.js";

const binary = process.env.DECK_TEST_BINARY;
for (const mode of ["killed", "clean exit", "in-flight killed", "active shell killed", "failed harness"] as const) {
  test(`hub notices writer ${mode}, releases port and permits reopen`, { skip: !binary, timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "deck-writer-failure-"));
    const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0);
    const fixture = join(directory, "writer.mjs");
    const shellPidFile = join(directory, "shell.pid");
    const shellCommand = `trap '' TERM; printf '%s' \"$$\" > '${shellPidFile.replace(/'/g, "'\\''")}'; while :; do sleep 1; done`;
    await writeFile(fixture, `import {writeFileSync,existsSync} from 'node:fs';
      const args=process.argv.slice(2),database=args[0]; writeFileSync(database+'.pid',String(process.pid));
      let input=Buffer.alloc(0); process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);if(input.length>=4&&input.length>=4+input.readUInt32BE(0))writeFileSync(database+'.request','seen')});
      setInterval(()=>{if(existsSync(database+'.exit'))process.exit(0)},20);
      ${mode === "failed harness" ? `const {DeckRuntime}=await import(${JSON.stringify(pathToFileURL(resolve("runtime/dist/deck.js")).href)});
        const open=DeckRuntime.open; DeckRuntime.open=async(...args)=>{const runtime=await open(...args);
          Object.defineProperty(runtime.harness,'closed',{value:new Promise(resolve=>{setInterval(()=>{if(existsSync(database+'.fail'))resolve({reason:'failed',error:new Error('PRIVATE_FAILURE_SENTINEL')})},20)})});return runtime};
        await import(${JSON.stringify(pathToFileURL(resolve("runtime/dist/main.js")).href)});` : ""}
      ${mode === "active shell killed" ? `const {PipeFiles}=await import(${JSON.stringify(pathToFileURL(resolve("runtime/dist/host-files.js")).href)});
        const tools=new PipeFiles(Number(args[6]),Number(args[7]),Number(args[8]));
        void tools.call({machineId:args[1],cwd:args[2]},'9001','bash',{command:${JSON.stringify(shellCommand)},timeout:30}).catch(()=>{});` : ""}
    `);
    const hub = spawn(binary!, ["serve", "--mock", "--directory", directory, "--port", String(port), "--runtime", fixture]);
    const closed = once(hub, "close"); let errors = ""; let pid: number | undefined; let shellPid: number | undefined;
    const transport = new AbortController();
    hub.stderr.on("data", (chunk) => { errors += String(chunk); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (let i = 0; i < 200; i++) {
        try { pid = Number(await readFile(join(directory, "session.sqlite.pid"), "utf8")); } catch { /* Not started yet. */ }
        if (pid && errors.includes("hub listening")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(pid && errors.includes("hub listening"), errors);
      let pending: Promise<boolean> | undefined;
      if (mode === "in-flight killed") {
        pending = fetch(`http://127.0.0.1:${port}/v1/command`, { method: "POST", body: JSON.stringify({ version: 1, id: "stalled", command: "status" }), signal: transport.signal }).then((response) => !response.ok, () => true);
        let received = false;
        for (let i = 0; i < 200; i++) {
          try { await readFile(join(directory, "session.sqlite.request")); received = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
        }
        assert.ok(received, "Hub never forwarded the request");
      }
      if (mode === "active shell killed") {
        for (let i = 0; i < 200; i++) {
          try { shellPid = Number(await readFile(shellPidFile, "utf8")); if (shellPid) break; } catch { /* Not executing yet. */ }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(shellPid, "Native shell never started");
      }
      if (mode === "clean exit") await writeFile(join(directory, "session.sqlite.exit"), "exit");
      else if (mode === "failed harness") await writeFile(join(directory, "session.sqlite.fail"), "fail");
      else process.kill(pid, "SIGKILL");
      const result = await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Hub kept listening after writer failure: ${errors}`)), 2000);
      })]);
      pid = undefined; // The failed writer was reaped; never signal a potentially reused PID.
      assert.notEqual(result[0], 0); assert.match(errors, /runtime unavailable/);
      assert.doesNotMatch(errors, /PRIVATE_FAILURE_SENTINEL/);
      if (mode === "failed harness") assert.match(errors, /store failed; stopping writer/);
      if (pending) assert.equal(await pending, true);
      if (shellPid) {
        assert.throws(() => process.kill(shellPid!, 0), { code: "ESRCH" }); shellPid = undefined;
        const receipt = JSON.parse(await readFile(join(directory, "worker/operations/9001.json"), "utf8")) as { result: { code: string } };
        assert.equal(receipt.result.code, "cancelled");
      }
      const replacement = createServer(); replacement.listen(port, "127.0.0.1"); await once(replacement, "listening");
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
      const reopened = spawnSync(binary!, ["serve", "--stdio", "--mock", "--directory", directory, "--runtime", resolve("runtime/dist/main.js")], {
        input: encodeFrame({ version: 1, id: "reopen", command: "status" }), timeout: 5000,
      });
      assert.equal(reopened.status, 0, reopened.stderr.toString());
      assert.equal(JSON.parse(reopened.stdout.subarray(4).toString()).ok, true);
    } finally {
      clearTimeout(timer); transport.abort();
      if (shellPid) { try { process.kill(-shellPid, "SIGKILL"); } catch { /* Already cleaned up. */ } }
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } }
      if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGKILL");
      await closed; await rm(directory, { recursive: true, force: true });
    }
  });
}
