import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { schemaHash } from "./mcp-contracts.js";
import type { FileResult } from "./host-files.js";
import type { McpCallPlan, McpCatalog, McpHostConfig, McpPrivateProfile, McpProfile, McpTool } from "./generated/contracts.js";
export const inputSchema=JSON.stringify({type:"object",properties:{mode:{type:"string",enum:["normal","hang","crash","oversize","wrong_id","duplicate","tool_error","rpc_error","malformed","unsupported","bad_output","env","ping","partial","progress","changed","gated"]}},required:["mode"],additionalProperties:false});
export const outputSchema=JSON.stringify({type:"object",properties:{count:{type:"integer",minimum:0,maximum:10000}},required:["count"],additionalProperties:false});
export const readTool: McpTool={name:"read",description:"Read counter and workspace without changing them",inputSchema:JSON.stringify({type:"object",properties:{},required:[],additionalProperties:false}),outputSchema:JSON.stringify({type:"object",properties:{count:{type:"integer",minimum:0,maximum:10000},cwd:{type:"string",maxLength:4096}},required:["count","cwd"],additionalProperties:false})};
export const counterTool: McpTool={name:"counter",description:"Disposable counter",inputSchema,outputSchema};
export const hash=(bytes: string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
let executablePin: Promise<{path:string;sha256:string}>|undefined;
export const nodePin=()=>executablePin??=realpath(process.execPath).then(async path=>({path,sha256:hash(await readFile(path))}));
export async function waitFor<T>(read:()=>Promise<T>, check:(value:T)=>boolean=Boolean,ms=7000):Promise<T> {
  const end=Date.now()+ms; let last:unknown;
  while(Date.now()<end) {try { const value=await read(); if(check(value)) return value;}catch(e){last=e;} await new Promise(r=>setTimeout(r,15));}
  throw new Error("Fixture readiness timeout",{cause:last});
}
export class NativeDriver {
  readonly child: ChildProcessWithoutNullStreams; stderr=""; private pending=new Map<string,{resolve:(v:FileResult)=>void;reject:(e:Error)=>void}>();
  constructor(binary: string,state:string,workspace:string,config:string,catalog:string,resetSigpipe=false) {
    this.child=spawn(resetSigpipe?"python3":binary,[...(resetSigpipe?["-c","import os,signal,sys;signal.signal(signal.SIGPIPE,signal.SIG_DFL);os.execv(sys.argv[1],sys.argv[1:])",binary]:[]),"serve","--stdio","--mock","--directory",state,"--workspace",workspace,"--runtime",fileURLToPath(new URL("./mcp-native.test.fixture.js",import.meta.url)),"--mcp",config,"--mcp-catalog",catalog],{stdio:"pipe",env:{...process.env,OPENAI_API_KEY:"must-not-leak",PI_PRIVATE:"must-not-leak",SSH_AUTH_SOCK:"must-not-leak"}});
    const decoder=new FrameDecoder(); this.child.stdout.pipe(decoder).on("data",(value:unknown)=>{const frame=value as {id:string;result?:FileResult;error?:string}; const pending=this.pending.get(frame.id); this.pending.delete(frame.id); if(frame.result) pending?.resolve(frame.result); else pending?.reject(new Error(frame.error));});
    this.child.stderr.on("data",chunk=>{this.stderr+=String(chunk);});
    this.child.on("exit",code=>{for(const p of this.pending.values())p.reject(new Error(`Fixture exit ${code}: ${this.stderr}`));this.pending.clear();});
  }
  call(id:string,operation:string,args:Record<string,unknown>,binding:Record<string,string>={}) {
    return new Promise<FileResult>((resolve,reject)=>{if(this.pending.has(id))throw new Error("Duplicate driver correlation");this.pending.set(id,{resolve,reject});this.child.stdin.write(encodeFrame({id,operation,args,...binding}));});
  }
  cancel(id:string){this.child.stdin.write(encodeFrame({cancel:id}));}
  async close(){if(this.child.exitCode!==null||this.child.signalCode!==null)return;const exited=once(this.child,"exit");this.child.stdin.end();await exited;assert.equal(this.child.exitCode,0,this.stderr);}
}
export async function nativeFixture(binary:string,flavor="normal") {
  const root=await realpath(await mkdtemp(join(tmpdir(),"deck-mcp-"))),state=join(root,"state"),workspace=join(root,"work");
  await mkdir(workspace);assert.equal(spawnSync(binary,["init","--directory",state]).status,0);
  const machineId=JSON.parse(await readFile(join(state,"config.json"),"utf8")).machine_id as string;
  const server=fileURLToPath(new URL("./mcp-server.test.fixture.js",import.meta.url));const executable=await nodePin();
  const secret="disposable-token\n";const secretPath=join(root,"secret");await writeFile(secretPath,secret,{mode:0o600});
  const profile: McpPrivateProfile={id:"counter",executable:executable.path,sha256:executable.sha256,argv:[server,flavor],cwd:"$TASK",files:[{path:server,sha256:hash(await readFile(server))}],env:[{name:"FIXTURE_SECRET",file:secretPath,sha256:hash(secret)}],tools:[counterTool]};
  const config=join(root,"profiles.json"),catalogPath=join(root,"catalog.json");
  const save=async()=>{await writeFile(config,JSON.stringify({version:1,machineId,profiles:[profile]} satisfies McpHostConfig),{mode:0o600});const exported=spawnSync(binary,["mcp","export","--config",config],{encoding:"utf8"});assert.equal(exported.status,0,exported.stderr);await writeFile(catalogPath,exported.stdout,{mode:0o600});return JSON.parse(exported.stdout) as McpCatalog;};
  const catalog=await save();
  const plan=(mode:string,publicProfile:McpProfile=catalog.profiles[0]!)=>JSON.stringify({version:1,profileId:publicProfile.id,revision:publicProfile.revision,tool:"counter",schemaHash:schemaHash(counterTool),conversationId:"1",taskMachineId:machineId,grantRevision:1,argumentsJSON:JSON.stringify({mode})} satisfies McpCallPlan);
  return {root,state,workspace,machineId,profile,config,catalogPath,catalog,plan,save,driver:(resetSigpipe=false)=>new NativeDriver(binary,state,workspace,config,catalogPath,resetSigpipe),cleanup:()=>rm(root,{recursive:true,force:true})};
}
