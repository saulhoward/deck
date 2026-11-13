import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { nativeFixture, waitFor, readTool } from "./mcp.test.support.js";
import { profileGrant } from "./mcp-tools.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
const binary=process.env.DECK_TEST_BINARY;
async function waitForWriterExit(state:string) {
  // SIGKILL delivery is asynchronous. Observe the existing lock becoming free;
  // never delete it, or race a replacement writer against the dying Pi process.
  await waitFor(async()=>spawnSync("python3",["-c","import os,sys,fcntl; f=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); os.close(f)",join(state,"writer.lock")],{timeout:2000}).status===0);
}
class PiFixture {
  readonly child; stderr=""; private seq=0; private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  constructor(f:Awaited<ReturnType<typeof nativeFixture>>,readonly port?:number) {
    this.child=spawn(binary!,["serve",...(port?["--port",String(port)]:["--stdio"]),"--mock","--directory",f.state,"--workspace",f.workspace,"--runtime",fileURLToPath(new URL("./mcp-pi.test.fixture.js",import.meta.url)),"--mcp",f.config,"--mcp-catalog",f.catalogPath],{stdio:"pipe"});
    this.child.stderr.on("data",b=>{this.stderr+=String(b);});
    if(port)this.child.stdout.resume();else this.child.stdout.pipe(new FrameDecoder()).on("data",value=>{const p=this.pending.get(value.id);this.pending.delete(value.id);if(value.ok)p?.resolve(value.result);else p?.reject(Object.assign(new Error(value.error.message),{code:value.error.code}));});
    this.child.on("exit",code=>{for(const p of this.pending.values())p.reject(new Error(`Native/Pi fixture exit ${code}: ${this.stderr}`));this.pending.clear();});
  }
  call(command:string,args:unknown={},hubId?:string):Promise<any>{const id=`test-${++this.seq}`;if(this.port)return fetch(`http://127.0.0.1:${this.port}/v1/command`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({version:1,id,command,args,...(hubId?{hubId}:{})}),signal:AbortSignal.timeout(3000)}).then(async response=>{const value:any=await response.json();if(!value.ok)throw new Error(JSON.stringify(value.error));return value.result;});return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.stdin.write(encodeFrame({version:1,id,command,args,...(hubId?{hubId}:{})}));});}
  async close(){if(this.child.exitCode!==null||this.child.signalCode!==null)return;const exited=once(this.child,"close");if(this.port)this.child.kill("SIGTERM");else this.child.stdin.end();await exited;if(!this.port)assert.equal(this.child.exitCode,0,this.stderr);}
}

test("central Pi invokes the native stdio server only after explicit grants and records original result/provenance",{skip:!binary,timeout:30000},async()=>{
  const f=await nativeFixture(binary!);f.profile.tools.push(readTool);f.catalog=await f.save();const runtime=new PiFixture(f);
  try {
    const status=await runtime.call("status"),chatId=status.mainChatId,hub=status.hubId;
    if(process.env.DECK_PACKAGE_BINARY===binary)assert.match(await readFile(join(f.state,"test-pi-runtime-root"),"utf8"),/\/libexec\/deck\/runtime\/dist\/deck\.js$/);
    assert.deepEqual((await runtime.call("tool_profiles",{chatId},hub)).profiles,[]);
    await runtime.call("admit",{chatId,requestId:"ungranted",text:"MCP:normal",mode:"followUp"},hub);
    await waitFor(()=>runtime.call("activity",{chatId},hub),v=>!v.busy&&v.queued===0);
    await assert.rejects(readFile(join(f.workspace,"counter.txt")));
    await runtime.call("set_tool_profiles",{chatId,expectedRevision:0,profiles:[profileGrant(f.catalog.profiles[0]!)]},hub);
    await runtime.call("admit",{chatId,requestId:"granted-read",text:"MCP:read",mode:"followUp"},hub);
    await waitFor(()=>runtime.call("activity",{chatId},hub),v=>!v.busy&&v.queued===0);await assert.rejects(readFile(join(f.workspace,"counter.txt")));
    await runtime.call("admit",{chatId,requestId:"granted",text:"MCP:normal",mode:"followUp"},hub);
    await waitFor(()=>runtime.call("activity",{chatId},hub),v=>!v.busy&&v.queued===0);
    assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
    const history=await runtime.call("history",{chatId,limit:100},hub);assert.match(JSON.stringify(history),/deck.mcp/);assert.match(JSON.stringify(history),/counter updated/);assert.match(JSON.stringify(history),/read-only fixture/);assert.ok(JSON.stringify(history).includes(f.catalog.profiles[0]!.revision));
    assert.equal((await readdir(join(f.state,"worker/operations"))).filter(n=>n.endsWith(".json")).length,2);
  }finally{await runtime.close();await f.cleanup();}
});

test("real hub TUI detach/reopen leaves an in-flight MCP invocation, grants and execution environment unchanged",{skip:!binary,timeout:30000},async()=>{
  const f=await nativeFixture(binary!),probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const address=probe.address();assert.ok(address&&typeof address!=="string");await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const runtime=new PiFixture(f,address.port);let chatId:string|undefined,hub:string|undefined;
  try {
    const status=await waitFor(()=>runtime.call("status"));chatId=status.mainChatId;hub=status.hubId;
    const selection=[profileGrant(f.catalog.profiles[0]!)];const grants=await runtime.call("set_tool_profiles",{chatId,expectedRevision:0,profiles:selection},hub);
    await runtime.call("admit",{chatId,requestId:"detach",text:"MCP:gated",mode:"followUp"},hub);
    const started=await waitFor(async()=>JSON.parse(await readFile(join(f.workspace,"started.json"),"utf8")));
    for(let i=0;i<2;i++) {
      const tui: import("node:child_process").SpawnSyncReturns<string>=spawnSync("python3",[fileURLToPath(new URL("../../scripts/tui-pty-test.py",import.meta.url)),binary!,"hub","--tui","--port",String(address.port)],{input:JSON.stringify([{wait_status:"working"},{keys:":q\r"}]),encoding:"utf8",timeout:10000,env:{...process.env,DECK_NODE:process.execPath,DECK_CLIENT_STATE_DIRECTORY:join(f.root,"client")}});
      assert.equal(tui.status,0,tui.stderr+tui.stdout);assert.equal(JSON.parse(tui.stdout).restored,true);
      process.kill(started.pid,0);assert.equal(runtime.child.exitCode,null);assert.equal((await runtime.call("activity",{chatId},hub)).busy,true);
      assert.deepEqual(await runtime.call("tool_profiles",{chatId},hub),grants);assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
      assert.deepEqual(JSON.parse(await readFile(join(f.workspace,"started.json"),"utf8")),started);
    }
    await writeFile(join(f.workspace,"release"),"finish only this invocation");await waitFor(()=>runtime.call("activity",{chatId},hub),v=>!v.busy&&v.queued===0);
    assert.match(JSON.stringify(await runtime.call("history",{chatId,limit:100},hub)),/counter updated/);
  }finally{
    await writeFile(join(f.workspace,"release"),"cleanup fixture result");
    if(chatId){try{await runtime.call("stop",{chatId},hub);await waitFor(()=>runtime.call("activity",{chatId},hub),v=>!v.busy&&v.queued===0);await waitFor(()=>runtime.call("set_tool_profiles",{chatId,expectedRevision:1,profiles:[profileGrant(f.catalog.profiles[0]!)]},hub));}catch{}}
    await runtime.close();await f.cleanup();
  }
});

test("lost MCP result delivery recovers the exact completed native receipt into Pi without another mutation",{skip:!binary,timeout:30000},async()=>{
  const f=await nativeFixture(binary!);let runtime=new PiFixture(f);let piPid:number|undefined;
  try {
    const status=await runtime.call("status"),chatId=status.mainChatId,hub=status.hubId;
    await runtime.call("set_tool_profiles",{chatId,expectedRevision:0,profiles:[profileGrant(f.catalog.profiles[0]!)]},hub);
    await runtime.call("admit",{chatId,requestId:"lost-reply",text:"MCP:gated",mode:"followUp"},hub);
    const started=await waitFor(async()=>JSON.parse(await readFile(join(f.workspace,"started.json"),"utf8")));
    piPid=Number(await readFile(join(f.state,"test-pi-pid"),"utf8"));process.kill(piPid,"SIGSTOP");
    await writeFile(join(f.workspace,"release"),"release this fixture only");
    const operation=String(started.id).slice(5),path=join(f.state,"worker/operations",`${operation}.json`);
    const completed=await waitFor(async()=>JSON.parse(await readFile(path,"utf8")),v=>v.result?.code==="mcp_result");
    const original=await readFile(path,"utf8");assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
    process.kill(runtime.child.pid!,"SIGSTOP");const exited=once(runtime.child,"exit");process.kill(runtime.child.pid!,"SIGKILL");process.kill(piPid,"SIGKILL");piPid=undefined;await exited;
    await waitForWriterExit(f.state);runtime=new PiFixture(f);await runtime.call("status");
    await waitFor(()=>runtime.call("activity",{chatId},hub),v=>!v.busy&&v.queued===0);
    const history=await runtime.call("history",{chatId,limit:100},hub);
    assert.ok(JSON.stringify(history).includes(JSON.stringify(completed.result.output).slice(1,-1)));
    assert.equal(await readFile(path,"utf8"),original);assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
    assert.deepEqual((await readdir(join(f.state,"worker/operations"))).filter(n=>n.endsWith(".json")),[`${operation}.json`]);
  }finally{if(piPid)try{process.kill(piPid,"SIGCONT");process.kill(piPid,"SIGKILL");}catch{}try{if(runtime.child.pid)process.kill(runtime.child.pid,"SIGCONT");}catch{}await runtime.close();await f.cleanup();}
});

test("SIGKILL after MCP mutation acceptance preserves Pi invocation and uncertain native bytes without replay",{skip:!binary,timeout:40000},async()=>{
  const f=await nativeFixture(binary!);let runtime=new PiFixture(f);let piPid:number|undefined,serverPid:number|undefined;
  try {
    const status=await runtime.call("status"),chatId=status.mainChatId,hub=status.hubId;
    await runtime.call("set_tool_profiles",{chatId,expectedRevision:0,profiles:[profileGrant(f.catalog.profiles[0]!)]},hub);
    await runtime.call("admit",{chatId,requestId:"crash-cutoff",text:"MCP:hang",mode:"followUp"},hub);
    const started=JSON.parse(await waitFor(()=>readFile(join(f.workspace,"started.json"),"utf8")));serverPid=started.pid;
    piPid=Number(await readFile(join(f.state,"test-pi-pid"),"utf8"));assert.ok(Number.isSafeInteger(piPid)&&piPid>1);
    const operation=String(started.id).slice(5),path=join(f.state,"worker/operations",`${operation}.json`);
    const before=await readFile(path,"utf8");assert.equal(JSON.parse(before).result,null);assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
    // Freeze both owners before the failure so neither can publish a synthetic
    // completion. Kill only this fresh test server's owned group; SIGKILL alone
    // does not promise automatic cleanup of descendants on Darwin.
    process.kill(piPid,"SIGSTOP");process.kill(runtime.child.pid!,"SIGSTOP");
    process.kill(-serverPid!,"SIGKILL");serverPid=undefined;
    const exited=once(runtime.child,"exit");process.kill(runtime.child.pid!,"SIGKILL");process.kill(piPid,"SIGKILL");piPid=undefined;await exited;
    assert.equal(await readFile(path,"utf8"),before);
    await waitForWriterExit(f.state);runtime=new PiFixture(f);
    const recovered=await runtime.call("status");assert.equal(recovered.hubId,hub);
    await waitFor(()=>runtime.call("activity",{chatId},hub),v=>!v.busy&&v.queued===0);
    const history=await runtime.call("history",{chatId,limit:100},hub);
    assert.match(JSON.stringify(history),/effect_uncertain/);assert.match(JSON.stringify(history),/no automatic new invocation/);
    assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");assert.equal(await readFile(path,"utf8"),before);
    assert.deepEqual((await readdir(join(f.state,"worker/operations"))).filter(n=>n.endsWith(".json")),[`${operation}.json`]);
  }finally{
    if(serverPid)try{process.kill(-serverPid,"SIGKILL");}catch{}
    if(piPid)try{process.kill(piPid,"SIGCONT");process.kill(piPid,"SIGKILL");}catch{}
    try{if(runtime.child.pid)process.kill(runtime.child.pid,"SIGCONT");}catch{}
    await runtime.close();await f.cleanup();
  }
});
