import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const binary = process.env.DECK_TEST_BINARY;
for (const patch of [
  { version: 2 },
  { id: "9007199254740992" },
  { id: "9223372036854775808" },
  { operation: "environment" },
  { args: { path: "sample.txt", content: "PRIVATE", command: "touch must-not-exist" } },
  { operation: "bash", args: { command: "touch must-not-exist", timeout: 301 } },
  { operation: "rex_allocate", args: { plan: "{}" } },
  { id: "progress:2", operation: "bash_progress", args: { target: "1" } },
]) test(`native ingress refuses before receipt or effect: ${JSON.stringify(patch)}`, { skip: !binary, timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-native-contract-"));
  try {
    assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0);
    await writeFile(join(directory, "sample.txt"), "untouched");
    const fixture = join(directory, "raw-client.mjs");
    await writeFile(fixture, `
      import assert from 'node:assert/strict';import {writeSync,readSync} from 'node:fs';
      const args=process.argv.slice(2);
      const body=Buffer.from(JSON.stringify({version:1,id:'100',machineId:args[1],cwd:${JSON.stringify(directory)},operation:'write',args:{path:'sample.txt',content:'PRIVATE'},...${JSON.stringify(patch)}}));
      const header=Buffer.alloc(4);header.writeUInt32BE(body.length);
      writeSync(Number(args[7]),Buffer.concat([header,body]));
      assert.equal(readSync(Number(args[6]),Buffer.alloc(4),0,4,null),0);
      console.log('invalid native request fenced');
    `);
    const result = spawnSync(binary!, ["serve", "--stdio", "--mock", "--directory", directory, "--runtime", fixture], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /invalid native request fenced/);
    assert.equal(await readFile(join(directory, "sample.txt"), "utf8"), "untouched");
    assert.deepEqual(await readdir(join(directory, "worker", "operations")), []);
    assert.equal((await readdir(directory)).includes("must-not-exist"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
