import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DeckRuntime } from "./deck.js";
import { dispatch } from "./ipc.js";
import { McpGrantsDoc, profileGrant, toolAlias, loadCatalog } from "./mcp-tools.js";
import { schemaSupported, parseSchema, validCallPlan, validCatalog, validRpcReply, validToolResult, valueMatches } from "./mcp-contracts.js";
import { parseMcpJson } from "./mcp-json.js";
import { validCommandArgs, validReplyContext } from "./command-contracts.js";
import { responseResult } from "./responses.js";
import { counterTool, inputSchema, outputSchema, hash } from "./mcp.test.support.js";
import type { McpCatalog, McpProfile } from "./generated/contracts.js";
const local="a".repeat(32), remote="b".repeat(32);
const profile: McpProfile={id:"counter",machineId:local,revision:hash("profile"),workspace:"task",tools:[counterTool]};
const catalog: McpCatalog={version:1,profiles:[profile]};
const rendered=(m:any)=>typeof m.content==="string"?m.content:m.content.map((c:any)=>c.text??"").join("");

test("shared MCP semantic fixtures",async()=>{
  const cases=JSON.parse(await readFile(new URL("../../src/mcp.test.json",import.meta.url),"utf8"));
  for(const c of cases) assert.equal(c.kind==="schema"?schemaSupported(c.value):c.kind==="match"?valueMatches(c.schema,c.value):c.kind==="result"?validToolResult(c.value):validRpcReply(c.value,"7"),c.valid,JSON.stringify(c));
});

test("MCP strict schema, JSON, byte bounds and correlated result validation",()=>{
  assert.ok(schemaSupported(parseSchema(inputSchema)));assert.ok(parseSchema(outputSchema));
  for(const key of ["$ref","$defs","oneOf","anyOf","pattern","default","format"]) assert.equal(schemaSupported({...JSON.parse(inputSchema),[key]:"ignored"}),false,key);
  for(const schema of [{type:"array",items:{type:"string"}},{type:"object",properties:{},required:[],additionalProperties:true},{type:"string",enum:["x","x"]},{type:"integer",minimum:0,maximum:-1},{type:"string",minLength:2,maxLength:1}])assert.equal(schemaSupported(schema),false);
  assert.equal(valueMatches(parseSchema(inputSchema),{mode:"normal"}),true);assert.equal(valueMatches(parseSchema(inputSchema),{mode:"normal",extra:1}),false);
  assert.equal(valueMatches(parseSchema(outputSchema),{count:"1"}),false);assert.equal(valueMatches(parseSchema(outputSchema),{count:1.5}),false);
  assert.throws(()=>parseSchema(inputSchema.replace('"type":"object"','"type":"object","type":"object"')));
  assert.throws(()=>parseMcpJson('{"a":1,"\\u0061":2}'));assert.deepEqual(parseMcpJson(' {"a":[1,{"b":"\\\\\\\""}],"c":null} '),JSON.parse(' {"a":[1,{"b":"\\\\\\\""}],"c":null} '));
  const result={content:[{type:"text",text:"exact 😀\n"}],structuredContent:{count:1}};
  const reply=JSON.stringify({jsonrpc:"2.0",id:"call:7",result});assert.ok(validRpcReply(reply,"7",counterTool));assert.equal(validRpcReply(reply,"8",counterTool),false);
  assert.equal(validRpcReply(reply.replace('"jsonrpc":"2.0"','"jsonrpc":"2.0","jsonrpc":"2.0"'),"7"),false);
  assert.equal(validToolResult({...result,content:[{type:"image",data:"AA=="}]}),false);
  assert.equal(validToolResult({...result,structuredContent:{count:"1"}},counterTool),false);
  assert.equal(validToolResult({...result,structuredContent:{count:"1"},isError:true},counterTool),true);
  assert.equal(validToolResult({content:[{type:"text",text:"\ud800"}]}),false);
  assert.equal(validRpcReply(JSON.stringify({jsonrpc:"2.0",id:"call:7",error:{code:-32000,message:"failed",data:{unknown:true}}}),"7"),true);
  assert.equal(validCatalog({...catalog,profiles:[profile,profile]}),false);
  assert.equal(validCatalog({ ...catalog,profiles:[{...profile,executable:"/private/secret"}]}),false);
  assert.equal(validCallPlan({version:1,profileId:"counter",revision:profile.revision,tool:"counter",schemaHash:hash("schema"),conversationId:"9007199254740992",taskMachineId:local,grantRevision:1,argumentsJSON:"{}"}),false);
});

test("MCP command boundaries require explicit hub identity, exact grants and closed replies",()=>{
  const args={chatId:"1",expectedRevision:0,profiles:[profileGrant(profile)]};
  assert.ok(validCommandArgs("set_tool_profiles",args));assert.equal(validReplyContext({command:"set_tool_profiles",args}),false);
  assert.ok(validReplyContext({command:"set_tool_profiles",args,hubId:"hub"}));
  assert.equal(validCommandArgs("set_tool_profiles",{...args,profiles:[...args.profiles,...args.profiles]}),false);
  const request={command:"set_tool_profiles",args,hubId:"hub"},result={chatId:"1",revision:1,profiles:args.profiles};
  assert.deepEqual(responseResult({version:1,id:"ack",ok:true,result},"ack",request),result);
  for(const bad of [{...result,chatId:"2"},{...result,revision:3},{...result,profiles:[]},{...result,extra:"PRIVATE"}])assert.throws(()=>responseResult({version:1,id:"ack",ok:true,result:bad},"ack",request));
});

test("Pi grants start empty, reject wrong hosts, preserve strict arguments and route only approved tools",async()=>{
  const root=await mkdtemp(join(tmpdir(),"deck-mcp-pi-"));const faux=fauxProvider(),models=createModels();models.setProvider(faux.provider);
  const calls: {id:string;plan:any;binding:any}[]=[];
  const service={...profile,id:"service",workspace:"fixed" as const};const worker={...profile,id:"worker",machineId:remote};
  const third={...service,id:"third",machineId:"c".repeat(32)};
  const options={models,model:{provider:"faux",modelId:"faux-1"},binding:{machineId:local,cwd:"/saved exact 😀"},environment:()=>undefined,mcpCatalog:{version:1 as const,profiles:[profile,service,worker,third]},hostFiles:{call:async(binding:any,id:string,operation:any,args:any)=>{
    assert.equal(operation,"mcp_call");const plan=JSON.parse(args.plan);calls.push({id,plan,binding});assert.equal(plan.argumentsJSON,'{"mode":"normal"}');
    return {ok:true,code:"mcp_result",output:JSON.stringify({jsonrpc:"2.0",id:`call:${id}`,result:{content:[{type:"text",text:"native result"}],structuredContent:{count:1}}})};
  }}};
  let runtime=await DeckRuntime.open(join(root,"pi.sqlite"),options);const id=String(runtime.main.id),alias=toolAlias(profile,"counter");
  try {
    assert.equal((await runtime.main.agent(context)).tools.some(t=>t.name.startsWith("mcp_")),false);
    await assert.rejects(dispatch(runtime,{command:"set_tool_profiles",args:{chatId:id,expectedRevision:0,profiles:[profileGrant(profile)]}}));
    await assert.rejects(runtime.setToolProfiles({chatId:id,expectedRevision:0,profiles:[profileGrant(worker)]}),/binding/);
    await assert.rejects(runtime.setToolProfiles({chatId:id,expectedRevision:0,profiles:[profileGrant(third)]}),/binding/);
    assert.deepEqual(await runtime.toolProfiles(id),{chatId:id,revision:0,profiles:[]});
    await runtime.setToolProfiles({chatId:id,expectedRevision:0,profiles:[profileGrant(profile),profileGrant(service)]});
    assert.equal((await runtime.main.agent(context)).tools.filter(t=>t.name.startsWith("mcp_")).length,2);
    const task=await runtime.createTask("Independent",options.binding,"independent");assert.deepEqual((await runtime.toolProfiles(String(task.id))).profiles,[]);assert.equal((await task.agent(context)).tools.some(t=>t.name.startsWith("mcp_")),false);
    faux.setResponses([fauxAssistantMessage(fauxToolCall(alias,{mode:1}),{stopReason:"toolUse"}),fauxAssistantMessage("invalid arguments refused")]);
    await (await runtime.admit(id,{requestId:"bad",text:"bad",mode:"followUp"})).wait(context);assert.equal(calls.length,0);
    faux.setResponses([()=>{return fauxAssistantMessage(fauxToolCall(alias,{mode:"normal"}),{stopReason:"toolUse"});},request=>{const result=request.messages.filter(m=>m.role==="toolResult").at(-1)!;assert.equal(result.isError,false,rendered(result));return fauxAssistantMessage("done");}]);
    await (await runtime.admit(id,{requestId:"normal",text:"normal",mode:"followUp"})).wait(context);
    assert.equal(calls.length,1);assert.equal(calls[0]!.binding.machineId,local);assert.equal(calls[0]!.binding.cwd,options.binding.cwd);assert.equal(calls[0]!.plan.grantRevision,1);
    const remoteTask=await runtime.createTask("Assigned worker",{machineId:remote,cwd:"/remote exact"},"worker-task");
    await runtime.setToolProfiles({chatId:String(remoteTask.id),expectedRevision:0,profiles:[profileGrant(worker),profileGrant(service)]});
    await assert.rejects(runtime.setToolProfiles({chatId:String(remoteTask.id),expectedRevision:1,profiles:[profileGrant(third)]}),/binding/);
    faux.setResponses([fauxAssistantMessage(fauxToolCall(toolAlias(service,"counter"),{mode:"normal"}),{stopReason:"toolUse"}),fauxAssistantMessage("service done")]);
    await (await runtime.admit(String(remoteTask.id),{requestId:"service",text:"service",mode:"followUp"})).wait(context);assert.equal(calls[1]!.binding.machineId,local);assert.equal(calls[1]!.plan.taskMachineId,remote);assert.equal(calls[1]!.binding.cwd,"/remote exact");
    const stored=(await runtime.history(id,{limit:100})).items.filter(e=>e.kind==="deck.input").at(-1)!.data as any;
    assert.ok(JSON.stringify(stored).includes(profile.revision));
    await runtime.close();runtime=await DeckRuntime.open(join(root,"pi.sqlite"),options);
    assert.equal((await runtime.toolProfiles(id)).revision,1);assert.equal((await runtime.main.agent(context)).tools.filter(t=>t.name.startsWith("mcp_")).length,2);
    await assert.rejects(runtime.setToolProfiles({chatId:id,expectedRevision:0,profiles:[]}),{code:"settings_changed"});
    await runtime.close();runtime=await DeckRuntime.open(join(root,"pi.sqlite"),{...options,mcpCatalog:{version:1,profiles:[]}});
    assert.equal((await runtime.toolProfiles(id)).revision,1);assert.equal((await runtime.main.agent(context)).tools.some(t=>t.name.startsWith("mcp_")),false);
    assert.equal((await runtime.history(id,{limit:100})).items.length>0,true);
    await assert.rejects(runtime.setToolProfiles({chatId:id,expectedRevision:1,profiles:[profileGrant(profile)]}),/binding/);
    await runtime.setToolProfiles({chatId:id,expectedRevision:1,profiles:[]});assert.equal((await runtime.main.agent(context)).tools.some(t=>t.name.startsWith("mcp_")),false);
    await runtime.close();runtime=await DeckRuntime.open(join(root,"pi.sqlite"),options);assert.equal((await runtime.toolProfiles(id)).revision,2);assert.equal((await runtime.main.agent(context)).tools.some(t=>t.name.startsWith("mcp_")),false);
  }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
});

test("owned delegation inherits only parent's grants; active work blocks grant changes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"deck-mcp-child-")),faux=fauxProvider(),models=createModels();models.setProvider(faux.provider);
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
  const runtime=await DeckRuntime.open(join(root,"pi.sqlite"),{models,model:{provider:"faux",modelId:"faux-1"},binding:{machineId:local,cwd:"/saved"},environment:()=>undefined,mcpCatalog:catalog,hostFiles:{call:async(_binding,id)=>{calls++;entered.resolve();await release.promise;return{ok:true,code:"mcp_result",output:JSON.stringify({jsonrpc:"2.0",id:`call:${id}`,result:{content:[],structuredContent:{count:1}}})};}}});
  const id=String(runtime.main.id);
  try {
    await runtime.setToolProfiles({chatId:id,expectedRevision:0,profiles:[profileGrant(profile)]});
    faux.setResponses([fauxAssistantMessage(fauxToolCall("subagent",{task:"child work"}),{stopReason:"toolUse"}),fauxAssistantMessage(fauxToolCall(toolAlias(profile,"counter"),{mode:"normal"}),{stopReason:"toolUse"}),fauxAssistantMessage("child done"),fauxAssistantMessage("parent done")]);
    const submission=await runtime.admit(id,{requestId:"child",text:"delegate",mode:"followUp"});await entered.promise;
    await assert.rejects(runtime.setToolProfiles({chatId:id,expectedRevision:1,profiles:[]}),{code:"busy"});release.resolve();await submission.wait(context);
    assert.equal(calls,1);const child=(await runtime.listChats()).items.find(c=>c.parentChatId===id)!;assert.ok(child);
    assert.deepEqual((await runtime.toolProfiles(child.chatId)).profiles,[profileGrant(profile)]);
    await assert.rejects(runtime.setToolProfiles({chatId:child.chatId,expectedRevision:1,profiles:[]}),/independent/);
    assert.deepEqual((await runtime.harness.snapshot(McpGrantsDoc,(await runtime.chat(child.chatId)).id,context))?.profiles,[profileGrant(profile)]);
  }finally{release.resolve();await runtime.close();await rm(root,{recursive:true,force:true});}
});

test("public catalog files are bounded/private and cannot grant unregistered workers",async()=>{
  const root=await mkdtemp(join(tmpdir(),"deck-mcp-catalog-")),path=join(root,"catalog.json");
  try {
    await writeFile(path,JSON.stringify(catalog),{mode:0o600});assert.deepEqual(await loadCatalog(path,local),catalog);
    await writeFile(path,JSON.stringify({...catalog,profiles:[{...profile,machineId:remote}]}));await assert.rejects(loadCatalog(path,local),/unapproved/);
    assert.equal((await loadCatalog(path,local,{hubId:"hub",hosts:[{machineId:remote,mcp:true,readFd:3,writeFd:4,controlFd:5}]})).profiles.length,1);
    assert.ok((await readFile(path,"utf8")).length);
  }finally{await rm(root,{recursive:true,force:true});}
});
