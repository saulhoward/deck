import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const binary = process.env.DECK_TEST_BINARY;
test("inherited native-effect pipes execute files in Zig and preserve host affinity independently of chat IPC", { skip: !binary, timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-worker-"));
  try {
    assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0);
    const fixture = join(directory, "worker-client.mjs");
    await writeFile(fixture, `
      import assert from 'node:assert/strict';
      import { PipeFiles } from ${JSON.stringify(pathToFileURL(resolve("runtime/dist/host-files.js")).href)};
      const args = process.argv.slice(2); const machineId = args[1]; const readFd = args[6]; const writeFd = args[7];
      const host = new PipeFiles(Number(readFd), Number(writeFd), Number(args[8]));
      const binding = { machineId, cwd: ${JSON.stringify(directory)} };
      try {
        const first = await host.call(binding, '100', 'write', {path:'sample.txt',content:'hello 🌍'});
        assert.equal(first.ok,true);
        assert.deepEqual(await host.call(binding,'100','write',{path:'sample.txt',content:'hello 🌍'}),first);
        assert.equal((await host.call(binding,'100','write',{path:'sample.txt',content:'conflict'})).code,'conflict');
        assert.equal((await host.call({...binding,machineId:'offline'},'101','write',{path:'sample.txt',content:'bad'})).code,'offline');
        assert.equal((await host.call(binding,'102','edit',{path:'sample.txt',oldText:'hello',newText:'goodbye'})).ok,true);
        assert.equal((await host.call(binding,'103','read',{path:'sample.txt'})).output,'goodbye 🌍');
        const shell = await host.call(binding,'104','bash',{command:'printf shell-ok; test -z "$OPENAI_API_KEY"',timeout:5});
        assert.equal(shell.ok,true); assert.equal(shell.exitCode,0); assert.match(shell.output,/shell-ok/);
        const privateFds = [args[3],args[6],args[7],args[8]].map(fd=>'test ! -e /dev/fd/'+fd).join(' && ');
        assert.equal((await host.call(binding,'109','bash',{command:privateFds,timeout:5})).ok,true);
        const once = await host.call(binding,'105','bash',{command:'printf once >> count.txt',timeout:5});
        assert.deepEqual(await host.call(binding,'105','bash',{command:'printf once >> count.txt',timeout:5}),once);
        assert.equal((await host.call(binding,'106','read',{path:'count.txt'})).output,'once');
        const controller = new AbortController();
        const started = Date.now();
        const running = host.call(binding,'107','bash',{command:'trap "" TERM; while :; do printf flood-output; done',timeout:30},controller.signal);
        await new Promise(resolve=>setTimeout(resolve,100));
        assert.equal((await host.call(binding,'108','read',{path:'sample.txt'})).ok,true);
        controller.abort();
        const cancelled = await running;
        assert.equal(cancelled.code,'cancelled'); assert.ok(Date.now()-started<4000);
        const controllers = Array.from({length:4},()=>new AbortController());
        const active = controllers.map((c,i)=>host.call(binding,String(110+i),'bash',{command:'sleep 30',timeout:30},c.signal));
        const busy = await host.call(binding,'114','bash',{command:'printf must-not-run',timeout:5});
        assert.equal(busy.code,'busy');
        controllers.forEach(c=>c.abort());
        for (const result of await Promise.all(active)) assert.equal(result.code,'cancelled');
        console.log('native worker verified');
      } finally { host.close(); }
    `);
    const result = spawnSync(binary!, ["serve", "--stdio", "--mock", "--directory", directory, "--runtime", fixture], { encoding: "utf8", timeout: 10_000, env: { ...process.env, OPENAI_API_KEY: "must-not-leak" } });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /native worker verified/);
    assert.equal(await readFile(join(directory, "sample.txt"), "utf8"), "goodbye 🌍");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
