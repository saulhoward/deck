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
 console.log(JSON.stringify({endpoint:'unix:///tmp/deck-rex-fake.sock',host_id:mode==='wrong_server'?'00000000-0000-0000-0000-000000000000':uuid,instance_id:(mode==='changed_server'&&created)||mode==='inspect-identity'||(mode==='inspect-identity-after'&&fs.existsSync(root+'/inspected'))?'00000000-0000-0000-0000-000000000000':uuid,api_revision:mode==='inspect-api-mismatch'?9:8}));
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
} else if(command[0]==='api') {
 assert.equal(command[1],'call'); const input=JSON.parse(command[3]); assert.equal(input.session_id,'session:'+uuid);
 fs.writeFileSync(root+'/inspected','read');
 const block={block_id:'block:'+uuid,window_id:'window:'+uuid,host_id:uuid,flavor:'com.superlogical.terminal.shell',placement:'placed'};
 const missing=['inspect-missing-terminal','inspect-detached','inspect-detached-omitted','inspect-partial','inspect-inconsistent'].includes(mode);
 if(command[2]==='session.view') {
  const error='Error: stream response "control-1" failed: session '+input.session_id+' not found (status=404 code=session_not_found)';
  if(mode==='inspect-missing-session') {console.error(error);process.exit(3);}
  if(mode==='inspect-mixed-404') {console.log('{}');console.error(error);process.exit(3);}
  if(mode==='inspect-spoof-stdout') {console.log(error);process.exit(3);}
  if(mode==='inspect-forbidden') {console.error(error.replace('status=404','status=403'));process.exit(3);}
  if(mode==='inspect-malformed') {console.log('PRIVATE_INSPECTION');process.exit(0);}
  if(mode==='inspect-flood') {console.log('PRIVATE_FLOOD'.repeat(10000));process.exit(0);}
  const blocks=missing?[]:[{...block,host_id:mode==='inspect-host-conflict'?'00000000-0000-0000-0000-000000000000':uuid}];
  if(mode==='inspect-duplicate') blocks.push({...block});
  const count=Number(fs.readFileSync(root+'/views','utf8'));fs.writeFileSync(root+'/views',String(count+1));
  console.log(JSON.stringify({session_id:input.session_id,revision:mode==='inspect-revision'&&count>0?2:1,...(mode==='inspect-partial'?{truncated:true}:{}),windows:[{window_id:mode==='inspect-wrong-window'?'window:00000000-0000-0000-0000-000000000000':'window:'+uuid,layers:[{blocks}]}]}));
 } else if(command[2]==='session.list_blocks') {
  console.log(JSON.stringify({blocks:mode==='inspect-missing-terminal'||mode==='inspect-partial'?[]:[{...block,...(mode==='inspect-detached'?{window_id:null,placement:'detached'}:mode==='inspect-detached-omitted'?{window_id:undefined,placement:'detached'}:{}),...(mode==='inspect-inconsistent'?{block_id:'block:00000000-0000-0000-0000-000000000000'}:{})}]}));
 } else if(command[2]==='com.superlogical.terminal.process') {
  assert.equal(input.block_id,'block:'+uuid);assert.deepEqual(input.args,{});
  fs.writeFileSync(root+'/read-started','read');
  if(mode==='inspect-cancel'||mode==='inspect-timeout') {process.on('SIGTERM',()=>{});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
  console.log(JSON.stringify(mode==='inspect-pending-omitted'?{}:{child:mode==='inspect-exited'?undefined:mode==='inspect-pending'?null:{pid:123,argv0:'PRIVATE_PROCESS'},foreground:mode==='inspect-exited'?undefined:null,last_exit:mode==='inspect-process-malformed'?{exit_code:'0'}:mode==='inspect-exited'?{exit_code:7}:null,home:'PRIVATE_HOME'}));
 } else process.exit(98);
} else process.exit(99);
`, { mode: 0o700 });
  return path;
}
