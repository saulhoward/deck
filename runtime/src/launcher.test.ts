import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { chmod,mkdtemp,writeFile,rm,mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer,type Socket } from "node:net";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc,defineTask,type TaskId } from "@earendil-works/pi-durable";
import { ChatDoc,DeckRuntime } from "./deck.js";
import { RexDoc,type RexPlan } from "./rex-allocation.js";
import { provider,model,IMPLEMENTATION,gate,within } from "./instructions.test.support.js";
import { launcherResponse } from "./launcher-hub.js";
import { launcherCommand,launcherTarget } from "./launcher-client.js";
import { LauncherDrafts } from "./launcher-drafts.js";
import { runLauncher,launchOptions } from "./launcher-main.js";
import { validLaunchRequest,validLaunchResponse } from "./launcher-contracts.js";
import { validWorkerFrame,validRegistry,validHello } from "./remote-contracts.js";
import { taskClientResponse } from "./remote-clients.js";
import { FrameDecoder,encodeFrame } from "./protocol.js";
import { counterTool } from "./mcp.test.support.js";
import { profileGrant } from "./mcp-tools.js";
import type { LauncherRequest,LauncherCreated,TaskRelayFrame } from "./generated/contracts.js";
const machine="b".repeat(32),uuid="12345678-1234-4234-8234-123456789abc";
const workerProfile={id:"worker",machineId:machine,revision:"f".repeat(64),workspace:"task" as const,tools:[counterTool]};
const serviceProfile={...workerProfile,id:"service",machineId:"a".repeat(32),workspace:"fixed" as const};
const req=(command:LauncherRequest["command"],args:object={}):LauncherRequest=>({version:1,id:randomUUID(),command,args}) as LauncherRequest;
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"dl4-")),client={executable:"/tools/deck",socket:join(root,"client.sock")};const {models}=provider();let calls=0;
 const plans:RexPlan[]=[];
 const options:Parameters<typeof DeckRuntime.open>[1]={models,model,implementation:IMPLEMENTATION,mcpCatalog:{version:1,profiles:[workerProfile,serviceProfile]},rexClient:"/hub/deck",binding:{machineId:"a".repeat(32),cwd:root},environment:()=>undefined,hostFiles:{rexClientFor:m=>m===machine?client:undefined,call:async(binding,_id,op,args)=>{
  calls++;assert.equal(binding.machineId,machine);
  if(op==="rex_resolve")return {ok:true,code:"rex_resolved",output:JSON.stringify({executable:"/tools/rex",server:"unix:///tmp/rex.sock",hostId:uuid,instanceId:uuid})};
  if(op==="rex_inspect")return {ok:true,code:"rex_inspected",output:JSON.stringify({version:1,scope:JSON.parse(args.plan!).scope,state:"running",exitCode:null,revision:1})};
  assert.equal(op,"rex_allocate");const plan=JSON.parse(args.plan!) as RexPlan;plans.push(plan);return {ok:true,code:"allocated",output:JSON.stringify({version:1,...plan,sessionId:`session:${randomUUID()}`,windowId:`window:${randomUUID()}`,blockId:`block:${randomUUID()}`,readiness:"not_checked"})};
 }}};
 let runtime=await DeckRuntime.open(join(root,"pi.sqlite"),options);
 const target={hubId:runtime.hubId,machineId:machine,socket:client.socket};
 const envelope=(request:LauncherRequest,hubId=runtime.hubId):TaskRelayFrame=>({connectionId:"a".repeat(64),id:"b".repeat(64),launcher:{hubId},body:JSON.stringify(request)});
 const send=async(request:LauncherRequest,approved=true,assigned=machine,hubId=runtime.hubId)=>JSON.parse(await launcherResponse(runtime,assigned,approved,envelope(request,hubId)));
 await writeFile(join(root,"worker.json"),JSON.stringify({version:1,machineId:machine,hubId:runtime.hubId,hubAddress:"100.64.0.1:1234",hubPeer:{nodeId:"nHub",userId:"42"},rexClient:client,launcher:true}),{mode:0o600});
 return {root,client,target,get runtime(){return runtime;},restart:async()=>{await runtime.close();runtime=await DeckRuntime.open(join(root,"pi.sqlite"),options);},send,envelope,plans,calls:()=>calls,close:async()=>{await runtime.close();await rm(root,{recursive:true,force:true});}};
}
test("launcher authority is explicit, ordered and exclusive from task scope",()=>{
 const client={executable:"/tools/deck",socket:"/private/client.sock"},host={machineId:machine,peer:{nodeId:"nWorker",userId:"42"},client:false,implementation:"a".repeat(64),capabilities:["files","bash","rex","mcp","launcher"],rexClient:client};
 assert.ok(validRegistry({version:1,hubId:uuid,hosts:[host]}));assert.equal(validRegistry({version:1,hubId:uuid,hosts:[{...host,rexClient:undefined}]}),false);
 const hello={version:1,hubId:uuid,machineId:machine,connectionId:"c".repeat(64),implementation:host.implementation,capabilities:host.capabilities,rexClient:client};assert.ok(validHello(hello));assert.equal(validHello({...hello,capabilities:["files","bash","launcher","rex"]}),false);
 const frame={connectionId:"a".repeat(64),id:"b".repeat(64),body:"{}"};assert.equal(validWorkerFrame(frame),false);assert.ok(validWorkerFrame({...frame,launcher:{hubId:uuid}}));assert.equal(validWorkerFrame({...frame,launcher:{hubId:uuid},scope:{hubId:uuid,chatId:"2",allocationId:uuid,blockId:`block:${uuid}`}}),false);
 for(const command of ["admit","login_start","set_tool_profiles","create_task","rex_startup"])assert.equal(validLaunchRequest({...req("launch_list"),command}),false);
 const create=req("launch_create",{requestId:uuid,title:"exact",cwd:"/workspace",problem:""});assert.ok(validLaunchRequest(create));
 for(const patch of [{machineId:machine},{cwd:"relative"},{title:"🧪".repeat(51)},{description:"\ud800"},{cwd:"/bad\0path"}])assert.equal(validLaunchRequest({...create,args:{...create.args,...patch}}),false);
});
test("launcher creates once with exact brief/binding, no generation/grants, and opens separately with pinned client",async()=>{
 const f=await fixture();try{
  await f.runtime.setToolProfiles({chatId:String(f.runtime.main.id),expectedRevision:0,profiles:[profileGrant(serviceProfile)]});
  const args={requestId:randomUUID(),title:" exact 🧪 title ",cwd:"/remote workspace",problem:"",description:"line one\nline two"},request=req("launch_create",args);
  assert.equal((await f.send(request,false)).ok,false);assert.equal((await f.send(request,true,machine,randomUUID())).ok,false);
  const first=await f.send(request);assert.ok(first.ok);assert.ok(validLaunchResponse(first,request,f.runtime.hubId,machine));assert.ok(first.ok);const created=first.result as LauncherCreated;
  assert.deepEqual((await f.send(request)).result,created);assert.equal((await f.send(req("launch_create",{...args,problem:"changed"}))).ok,false);
  assert.equal((await f.runtime.history(created.chatId)).items.filter(e=>e.kind==="deck.input").length,0);assert.equal((await f.runtime.activity(created.chatId)).busy,false);assert.deepEqual((await f.runtime.toolProfiles(created.chatId)).profiles,[]);assert.equal(f.calls(),0);
  assert.match(created.agentName!, /^[a-z]+$/);assert.equal(created.agentNameAlgorithm,"wintermute-v1");
  const list=await f.send(req("launch_list"));assert.deepEqual(list.result.items,[{chatId:created.chatId,title:args.title,cwd:args.cwd,agentName:created.agentName,agentNameAlgorithm:created.agentNameAlgorithm}]);
  const selection=await f.runtime.setToolProfiles({chatId:created.chatId,expectedRevision:0,profiles:[profileGrant(workerProfile),profileGrant(serviceProfile)]});
  const open=await f.send(req("launch_open",{chatId:created.chatId,requestId:randomUUID()}));assert.ok(open.ok);await f.runtime.harness.waitForTask(Number(open.result.ack.taskId) as TaskId,context);
  assert.deepEqual(await f.runtime.toolProfiles(created.chatId),selection);
  assert.equal(f.plans.length,1);assert.equal(f.plans[0]!.client,f.client.executable);assert.equal(f.plans[0]!.workerSocket,f.client.socket);
  const inspect=await f.send(req("launch_inspect",{chatId:created.chatId}));assert.ok(inspect.ok);assert.equal(inspect.result.status.binding.cwd,args.cwd);
  const chat=await f.runtime.chat(created.chatId),doc=(await f.runtime.harness.snapshot(RexDoc,chat.id,context))!;
  await assert.rejects(taskClientResponse(f.runtime,machine,f.client,{connectionId:"a".repeat(64),id:"b".repeat(64),body:JSON.stringify(request),scope:{hubId:f.runtime.hubId,chatId:created.chatId,allocationId:doc.allocationId!,blockId:doc.binding!.blockId}}),/Invalid task command/);
 }finally{await f.close();}
});
test("launcher cannot inspect/open main, other hosts or owned conversations; no cross-scope effects",async()=>{
 const f=await fixture();try{
  const other=await f.runtime.createTask("other",{machineId:"c".repeat(32),cwd:"/other"});
  const parked=defineTask<{}, {phase:"hold"}, null>({name:"test.launcher-owner",version:1,initial:()=>({phase:"hold"}),phases:{hold:async()=>{}},abort:async()=>{}});
  const owned=await f.runtime.main.commit(async tx=>{
    const owner=await tx.createTask(parked,{}, {ownership:{kind:"conversation"},background:true});
    const child=await tx.createConversation({ownership:{kind:"task",taskId:owner}});
    Object.assign(await tx.doc(ChatDoc,child.id),{kind:"task",title:"misleading",machineId:machine,cwd:"/remote"});(await tx.doc(AgentDoc,child.id)).cwd="/remote";return child.id;
  },context);
  const ids=[String(f.runtime.main.id),String(other.id),String(owned),"999999"];
  for(const id of ids)for(const command of ["launch_open","launch_inspect"] as const)assert.equal((await f.send(req(command,{chatId:id,...(command==="launch_open"?{requestId:randomUUID()}:{} )}))).ok,false);
  assert.equal(f.calls(),0);assert.deepEqual((await f.send(req("launch_list"))).result.items,[]);
  await f.runtime.main.commit(async tx=>{Object.assign(await tx.doc(ChatDoc,f.runtime.main.id),{kind:"task",machineId:machine});},context);
  assert.deepEqual((await f.send(req("launch_list"))).result.items,[],"canonical main never appears even under misleading metadata");
  assert.equal((await f.send(req("launch_inspect",{chatId:String(f.runtime.main.id)}))).ok,false);
 }finally{await f.close();}
});
test("launcher open rechecks task binding at serialized allocation, not just socket ingress",async()=>{
 const f=await fixture();const entered=gate(),release=gate();try{
  const created=(await f.send(req("launch_create",{requestId:randomUUID(),title:"task",cwd:"/remote"}))).result;
  const original=f.runtime.allocateTerminal.bind(f.runtime);f.runtime.allocateTerminal=async(...args)=>{entered.release();await release.promise;return original(...args);};
  const pending=f.send(req("launch_open",{chatId:created.chatId,requestId:randomUUID()}));await within(entered.promise);
  const chat=await f.runtime.chat(created.chatId);await chat.commit(async tx=>{(await tx.doc(ChatDoc,chat.id)).machineId="c".repeat(32);},context);release.release();assert.equal((await pending).ok,false);assert.equal(f.plans.length,0);
 }finally{release.release();await f.close();}
});
async function socketFixture(){
 const f=await fixture(),peers=new Set<Socket>(),requests:LauncherRequest[]=[];let drop:"launch_create"|"launch_open"|undefined,bad=false;
 const server=createServer(socket=>{peers.add(socket);socket.on("error",()=>{});socket.on("close",()=>peers.delete(socket));socket.pipe(new FrameDecoder()).on("data",(frame:TaskRelayFrame)=>{
  const request=JSON.parse(frame.body) as LauncherRequest;requests.push(request);
  void launcherResponse(f.runtime,machine,true,{...frame,connectionId:"a".repeat(64),id:"b".repeat(64)}).then(body=>{if(request.command===drop){drop=undefined;socket.destroy();return;}const reply=JSON.parse(body);if(bad && request.command==="launch_create" && reply.ok)reply.result.brief={};socket.end(encodeFrame(reply));}).catch(()=>socket.destroy());
 }).on("error",()=>socket.destroy());});await new Promise<void>(r=>server.listen(f.client.socket,r));await chmod(f.client.socket,0o600);
 const old=process.env.DECK_CLIENT_STATE_DIRECTORY;process.env.DECK_CLIENT_STATE_DIRECTORY=join(f.root,"drafts");
 return {...f,get runtime(){return f.runtime;},requests,drop:(c:"launch_create"|"launch_open")=>{drop=c;},bad:()=>{bad=true;},close:async()=>{if(old===undefined)delete process.env.DECK_CLIENT_STATE_DIRECTORY;else process.env.DECK_CLIENT_STATE_DIRECTORY=old;for(const p of peers)p.destroy();await new Promise<void>(r=>server.close(()=>r()));await f.close();}};
}
test("launcher lost create ACK retains exact draft; observations never replay; explicit recovery never opens",async()=>{
 const f=await socketFixture(),out:string[]=[];try{
  const args=["--launch-from",f.root],form={title:" literal 🧪 ",cwd:"/remote",problem:"",description:"  exact\nbrief  "};f.drop("launch_create");
  await assert.rejects(runLauncher([...args,"--new",JSON.stringify(form),"--confirm"],s=>out.push(s)),/outcome unconfirmed/);
  const store=new LauncherDrafts(f.target),drafts=await store.list();assert.equal(drafts.length,1);const draft=drafts[0]!;assert.equal(draft.command,"launch_create");assert.deepEqual(draft.args,{...form,requestId:draft.args.requestId});
  await runLauncher([...args,"--drafts"],()=>{});await runLauncher(args,()=>{});assert.equal(f.requests.filter(r=>r.command==="launch_create").length,1);
  await f.restart();
  await runLauncher([...args,"--retry",draft.args.requestId,"--confirm"],s=>out.push(s));assert.deepEqual(await store.list(),[]);assert.deepEqual(f.requests.filter(r=>r.command==="launch_create"),[draft,draft]);assert.equal(f.plans.length,0);assert.equal((await f.runtime.listChats()).items.filter(c=>c.kind==="task").length,1);
 }finally{await f.close();}
});
test("launcher saves/validates/clears creation before separate open; lost open ACK never recreates or retries",async()=>{
 const f=await socketFixture();try{
  f.drop("launch_open");const args=["--launch-from",f.root];await assert.rejects(runLauncher([...args,"--new",JSON.stringify({title:"task",cwd:"/remote"}),"--confirm"],()=>{}),/outcome unconfirmed/);
  const store=new LauncherDrafts(f.target),draft=(await store.list())[0]!;assert.equal(draft.command,"launch_open");
  await assert.rejects(runLauncher([...args,"--retry",draft.args.requestId,"--confirm"],()=>{}),/not replayed/);
  assert.equal(f.requests.filter(r=>r.command==="launch_create").length,1);assert.equal(f.requests.filter(r=>r.command==="launch_open").length,1);
  assert.equal((await store.list()).length,1);await runLauncher([...args,"--discard",draft.args.requestId,"--confirm"],()=>{});assert.deepEqual(await store.list(),[]);
 }finally{await f.close();}
});
test("malformed creation ACK cannot clear an exact brief draft or request Rex",async()=>{
 const f=await socketFixture();try{f.bad();await assert.rejects(runLauncher(["--launch-from",f.root,"--new",JSON.stringify({title:"task",cwd:"/remote",problem:""}),"--confirm"],()=>{}),/acknowledgement/);assert.equal((await new LauncherDrafts(f.target).list()).length,1);assert.equal(f.requests.some(r=>r.command==="launch_open"),false);}finally{await f.close();}
});
test("launcher local refusal/confirmation and private config/draft checks precede mutation",async()=>{
 const f=await fixture();try{
  for(const args of [["--launch-from",f.root,"--new","{}"],["--launch-from",f.root,"--open","2"],["--launch-from",f.root,"--list","--confirm"],["--launch-from",f.root,"--login"],["--launch-from",f.root,"--task","2"],["--launch-from",f.root,"--rex-allocation",uuid]])assert.throws(()=>launchOptions(args));
  const target=await launcherTarget(f.root);assert.deepEqual(target,f.target);await assert.rejects(launcherCommand(target,req("launch_list")),/not sent/);
  await chmod(join(f.root,"worker.json"),0o644);await assert.rejects(launcherTarget(f.root),/configuration/);await chmod(join(f.root,"worker.json"),0o600);
  const store=new LauncherDrafts(target,join(f.root,"private")),request=req("launch_create",{requestId:randomUUID(),title:"task",cwd:"/remote"}) as Extract<LauncherRequest,{command:"launch_create"}>;
  await store.save(request);await store.save(request);await assert.rejects(store.save({...request,args:{...request.args,title:"changed"}}),/conflict/);await assert.rejects(store.remove({...request,args:{...request.args,title:"changed"}}),/changed/);assert.deepEqual(await store.load(request.args.requestId),request);
  const badRoot=join(f.root,"public");await mkdir(badRoot,{mode:0o755});await assert.rejects(new LauncherDrafts(target,badRoot).save(request),/private/);
 }finally{await f.close();}
});
