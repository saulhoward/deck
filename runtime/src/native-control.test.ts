import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const binary = process.env.DECK_TEST_BINARY;
test("invalid native cancellation identity cancels accepted processes and refuses later effects", { skip: !binary, timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-native-control-"));
  try {
    assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0);
    const fixture = join(directory, "raw-control.mjs");
    await writeFile(fixture, `
      import assert from 'node:assert/strict';import {writeSync,readSync,readFileSync} from 'node:fs';
      const args=process.argv.slice(2),root=${JSON.stringify(directory)},binding={machineId:args[1],cwd:root};
      const send=(id,operation,args)=>{const body=Buffer.from(JSON.stringify({version:1,id,...binding,operation,args}));const header=Buffer.alloc(4);header.writeUInt32BE(body.length);writeSync(Number(process.argv.slice(2)[7]),Buffer.concat([header,body]));};
      send('1','bash',{command:'sleep 30',timeout:30});
      let accepted=false;
      for(let i=0;i<500;i++){try{accepted=!!readFileSync(root+'/worker/operations/1.json').length;break;}catch{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
      assert.equal(accepted,true);
      writeSync(Number(args[8]),Buffer.alloc(8)); // Zero cannot name an operation.
      const exact=n=>{const b=Buffer.alloc(n);let used=0;while(used<n){const got=readSync(Number(args[6]),b,used,n-used,null);assert.notEqual(got,0);used+=got;}return b;};
      const reply=JSON.parse(exact(exact(4).readUInt32BE()).toString());assert.equal(reply.result.code,'cancelled');
      send('2','write',{path:'must-not-exist',content:'PRIVATE'});
      assert.equal(readSync(Number(args[6]),Buffer.alloc(4),0,4,null),0);
      console.log('control failure fenced');
    `);
    const result = spawnSync(binary!, ["serve", "--stdio", "--mock", "--directory", directory, "--runtime", fixture], { encoding: "utf8", timeout: 7_000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /control failure fenced/);
    assert.deepEqual(await readdir(join(directory, "worker", "operations")), ["1.json"]);
    assert.equal(JSON.parse(await readFile(join(directory, "worker", "operations", "1.json"), "utf8")).result.code, "cancelled");
    assert.equal((await readdir(directory)).includes("must-not-exist"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
