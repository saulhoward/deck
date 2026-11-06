import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export const REX_UUID = "12345678-1234-1234-1234-123456789abc";
export async function fakeRex(directory: string, mode = "") {
  await writeFile(join(directory, "mode"), mode);
  const path = join(directory, "fake-rex");
  await writeFile(path, `#!${process.execPath}
const fs=require('node:fs'), assert=require('node:assert/strict');
const root=${JSON.stringify(directory)}, uuid=${JSON.stringify(REX_UUID)}, mode=fs.readFileSync(root+'/mode','utf8');
const args=process.argv.slice(2); assert.deepEqual(args.slice(0,5),['--autostart=false','--timeout','2s','--server','unix:///tmp/deck-rex-fake.sock']);
assert.equal(process.env.OPENAI_API_KEY,undefined); assert.equal(process.env.BASH_ENV,undefined); assert.equal(process.env.REX_SERVER,undefined); assert.equal(process.env.NODE_OPTIONS,undefined);
fs.appendFileSync(root+'/calls',JSON.stringify(args)+'\\n');
const command=args.slice(5), created=fs.existsSync(root+'/created');
if(command[0]==='server') {
 console.log(JSON.stringify({endpoint:'unix:///tmp/deck-rex-fake.sock',host_id:mode==='wrong_server'?'00000000-0000-0000-0000-000000000000':uuid,instance_id:mode==='changed_server'&&created?'00000000-0000-0000-0000-000000000000':uuid,api_revision:8}));
} else if(command[0]==='new') {
 fs.appendFileSync(root+'/created','create\\n');
 assert.ok(command.includes('--shell=none')); assert.ok(command.includes('--keep-open'));
 const argv=command.slice(command.indexOf('--')+1); assert.equal(argv[1],'agent'); assert.ok(argv.includes('--hub-id')); assert.ok(argv.includes('--task')); assert.match(argv[argv.indexOf('--rex-allocation')+1],/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/); assert.equal(argv.includes('--message'),false);
 if(mode==='cancel'||mode==='lost_ack') {process.on('SIGTERM',()=>{}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
 if(mode==='failed') { console.error('PRIVATE_REX_ERROR'); process.exit(7); }
 if(mode==='malformed') { console.log('PRIVATE_BAD_RESULT'); process.exit(0); }
 if(mode==='flood') process.stdout.write('PRIVATE_FLOOD'.repeat(20000));
 console.log(JSON.stringify({session_id:'session:'+uuid,initial_windows:[{window_id:'window:'+uuid,block_ids:['block:'+uuid],revision:1}]}));
} else if(command[0]==='block') {
 assert.deepEqual(command,['block','ls','--session','session:'+uuid,'--json','--short=false']);
 console.log(JSON.stringify({blocks:[{block_id:'block:'+uuid,window_id:'window:'+uuid,host_id:uuid,flavor:mode==='wrong_block'?'other':'com.superlogical.terminal.shell'}]}));
} else process.exit(99);
`, { mode: 0o700 });
  return path;
}
