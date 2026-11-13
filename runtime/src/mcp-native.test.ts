import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile, mkdir, chmod, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeFixture, waitFor, hash, readTool, NativeDriver } from "./mcp.test.support.js";
import { schemaHash } from "./mcp-contracts.js";
const binary=process.env.DECK_TEST_BINARY;

test("approved MCP read tool retains its original snapshot; a fresh call observes the counter mutation",{skip:!binary,timeout:25000},async()=>{
  const f=await nativeFixture(binary!);f.profile.tools.push(readTool);const catalog=await f.save();const driver=f.driver();
  try {
    const plan=JSON.stringify({...JSON.parse(f.plan("normal",catalog.profiles[0]!)),tool:"read",schemaHash:schemaHash(readTool),argumentsJSON:"{}"});
    const first=await driver.call("600","mcp_call",{plan});assert.equal(first.code,"mcp_result");assert.deepEqual(JSON.parse(first.output).result.structuredContent,{count:0,cwd:f.workspace});
    await assert.rejects(readFile(join(f.workspace,"counter.txt")));
    assert.equal((await driver.call("601","mcp_call",{plan:f.plan("normal",catalog.profiles[0]!)})).code,"mcp_result");
    assert.deepEqual(await driver.call("600","mcp_call",{plan}),first);
    const fresh=await driver.call("602","mcp_call",{plan});assert.equal(JSON.parse(fresh.output).result.structuredContent.count,1);
    assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
  }finally{await driver.close();await f.cleanup();}
});

for(const flavor of ["paginated","catalog_progress"])test(`bounded MCP ${flavor} discovery completes without changing grants`,{skip:!binary,timeout:20000},async()=>{
  const f=await nativeFixture(binary!,flavor),driver=f.driver();try{assert.equal((await driver.call("700","mcp_call",{plan:f.plan("normal")})).code,"mcp_result");}finally{await driver.close();await f.cleanup();}
});

test("MCP timeout fences only its invocation and retains uncertainty",{skip:!binary,timeout:35000},async()=>{
  const f=await nativeFixture(binary!),driver=f.driver();try{
    const started=Date.now(),result=await driver.call("710","mcp_call",{plan:f.plan("hang")});assert.equal(result.code,"effect_uncertain");assert.ok(Date.now()-started>=19500&&Date.now()-started<28000);
    assert.equal((await driver.call("711","mcp_call",{plan:f.plan("normal")})).code,"mcp_result");assert.equal((await readFile(join(f.workspace,"counter.txt"),"utf8")).length,2);
    assert.deepEqual(await driver.call("710","mcp_call",{plan:f.plan("hang")}),result);
  }finally{await driver.close();await f.cleanup();}
});

test("MCP pins and private permissions fail closed; approved environment is not ambient or command expansion",{skip:!binary,timeout:30000},async()=>{
  const f=await nativeFixture(binary!);const script=join(f.root,"server.mjs");await copyFile(f.profile.argv[0]!,script);f.profile.argv[0]=script;f.profile.files=[{path:script,sha256:hash(await readFile(script))}];f.profile.env.push({name:"LITERAL",value:"$(touch must-not-exist)"});
  const approved=await f.save();const driver=f.driver();
  try {
    assert.ok(!JSON.stringify(approved).includes(script));assert.ok(!JSON.stringify(approved).includes("FIXTURE_SECRET"));
    const plan=f.plan("normal",approved.profiles[0]!);const first=await driver.call("720","mcp_call",{plan});assert.equal(first.code,"mcp_result");
    const marker=JSON.parse(await readFile(join(f.workspace,"started.json"),"utf8"));assert.equal(marker.env.LITERAL,"$(touch must-not-exist)");await assert.rejects(readFile(join(f.workspace,"must-not-exist")));
    await writeFile(f.profile.env[0]!.file!,"changed credential");assert.equal((await driver.call("721","mcp_call",{plan})).code,"mcp_unavailable");
    assert.deepEqual(await driver.call("720","mcp_call",{plan}),first);
    await writeFile(f.profile.env[0]!.file!,"disposable-token\n");await writeFile(script,"// changed pinned build\n",{flag:"a"});assert.equal((await driver.call("722","mcp_call",{plan})).code,"mcp_unavailable");
    assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
    await chmod(f.config,0o644);const unsafe=spawnSync(binary!,["mcp","export","--config",f.config],{encoding:"utf8"});assert.notEqual(unsafe.status,0);assert.equal(unsafe.stdout,"");await chmod(f.config,0o600);
    for(const name of ["NODE_OPTIONS","LD_PRELOAD","PI_TOKEN","DECK_NODE","OPENAI_API_KEY"]) {
      await writeFile(f.config,JSON.stringify({version:1,machineId:f.machineId,profiles:[{...f.profile,env:[{name,value:"PRIVATE"}]}]}));
      const denied=spawnSync(binary!,["mcp","export","--config",f.config],{encoding:"utf8"});assert.notEqual(denied.status,0);assert.doesNotMatch(denied.stdout+denied.stderr,/PRIVATE/);
    }
  }finally{await driver.close();await f.cleanup();}
});

test("MCP isolated profiles keep same-named tools, credentials and task workspaces separate under cancellation",{skip:!binary,timeout:20000},async()=>{
  const f=await nativeFixture(binary!),other=join(f.root,"other-work"),secret=join(f.root,"other-secret");await mkdir(other);await writeFile(secret,"other-account-token",{mode:0o600});
  const second={...f.profile,id:"other",env:[{name:"FIXTURE_SECRET",file:secret,sha256:hash("other-account-token")}]};
  await writeFile(f.config,JSON.stringify({version:1,machineId:f.machineId,profiles:[f.profile,second]}));const exported=spawnSync(binary!,["mcp","export","--config",f.config],{encoding:"utf8"});assert.equal(exported.status,0,exported.stderr);await writeFile(f.catalogPath,exported.stdout);const catalog=JSON.parse(exported.stdout);
  const driver=f.driver();try{
    const one=driver.call("730","mcp_call",{plan:f.plan("gated",catalog.profiles[0])});const two=driver.call("731","mcp_call",{plan:JSON.stringify({...JSON.parse(f.plan("gated",catalog.profiles[1])),conversationId:"2"})},{cwd:other});
    const first=await waitFor(async()=>JSON.parse(await readFile(join(f.workspace,"started.json"),"utf8"))),next=await waitFor(async()=>JSON.parse(await readFile(join(other,"started.json"),"utf8")));
    assert.equal(first.cwd,f.workspace);assert.equal(next.cwd,other);assert.notEqual(first.pid,next.pid);assert.equal(first.env.FIXTURE_SECRET,"disposable-token\n");assert.equal(next.env.FIXTURE_SECRET,"other-account-token");
    driver.cancel("730");assert.equal((await one).code,"effect_uncertain");process.kill(next.pid,0);await writeFile(join(other,"release"),"release second only");assert.equal((await two).code,"mcp_result");
    assert.equal(await readFile(join(other,"counter.txt"),"utf8"),"x");assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
  }finally{await driver.close();await f.cleanup();}
});

test("MCP preserves single-line argument lexemes instead of normalizing payloads",{skip:!binary,timeout:20000},async()=>{
  const f=await nativeFixture(binary!),driver=f.driver();try {
    const argumentsJSON=' { "mo\\u0064e" : "\\u006eormal" } ',plan=JSON.stringify({...JSON.parse(f.plan("normal")),argumentsJSON});
    assert.equal((await driver.call("740","mcp_call",{plan})).code,"mcp_result");const started=JSON.parse(await readFile(join(f.workspace,"started.json"),"utf8"));
    assert.equal(started.arguments.mode,"normal");assert.ok(started.wire.includes('"arguments":'+argumentsJSON));
    await assert.rejects(driver.call("741","mcp_call",{plan:JSON.stringify({...JSON.parse(plan),argumentsJSON:'{\n"mode":"normal"}'})}),/invalid native request/i);
  }finally{await driver.close();await f.cleanup();}
});

test("MCP backup/restore retains completed, uncertain and stale evidence byte-for-byte without unpublished temporary files",{skip:!binary,timeout:25000},async()=>{
  const f=await nativeFixture(binary!);let driver=f.driver();
  try {
    const plan=f.plan("normal"),first=await driver.call("750","mcp_call",{plan});assert.equal(first.code,"mcp_result");
    assert.equal((await driver.call("751","mcp_call",{plan:f.plan("changed")})).code,"effect_uncertain");await driver.close();
    const operations=join(f.state,"worker/operations"),unknown=JSON.stringify({version:2,kind:"mcp",hash:hash(JSON.stringify({version:1,id:"752",machineId:f.machineId,cwd:f.workspace,operation:"mcp_call",args:{plan}})),result:null});
    await writeFile(join(operations,"752.json"),unknown,{mode:0o600});await writeFile(join(operations,`753.json.${"0".repeat(32)}.mcp-tmp`),"unpublished",{mode:0o600});
    const backup=join(f.root,"backup"),restored=join(f.root,"restored");for(const args of [["backup","--directory",f.state,"--output",backup],["restore","--from",backup,"--directory",restored]]){const r=spawnSync(binary!,args,{encoding:"utf8",timeout:7000});assert.equal(r.status,0,r.stderr);}
    const copied=await readdir(join(restored,"worker/operations"));assert.ok(copied.includes(`mcp-${f.catalog.profiles[0]!.revision}.stale`));assert.ok(!copied.some(n=>n.endsWith(".mcp-tmp")));
    for(const name of copied)assert.deepEqual(await readFile(join(restored,"worker/operations",name)),await readFile(join(operations,name)));
    driver=new NativeDriver(binary!,restored,f.workspace,f.config,f.catalogPath);assert.deepEqual(await driver.call("750","mcp_call",{plan}),first);assert.equal((await driver.call("752","mcp_call",{plan})).code,"effect_uncertain");
    assert.equal(await readFile(join(restored,"worker/operations/752.json"),"utf8"),unknown);assert.equal((await driver.call("754","mcp_call",{plan})).code,"mcp_catalog_changed");assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"xx");
  }finally{await driver.close();await f.cleanup();}
});

test("native MCP exact receipts, host/workspace binding, private environment and legacy receipt isolation",{skip:!binary,timeout:45000},async()=>{
  const f=await nativeFixture(binary!);let driver=f.driver();
  try {
    assert.equal(spawnSync(binary!,["mcp","probe","--config",f.config,"--profile","counter","--workspace",f.workspace],{encoding:"utf8",timeout:15000}).status,0);
    await assert.rejects(readFile(join(f.workspace,"counter.txt")));
    const first=await driver.call("100","mcp_call",{plan:f.plan("normal")});assert.equal(first.code,"mcp_result",JSON.stringify(first));assert.ok(first.ok);
    const started=JSON.parse(await readFile(join(f.workspace,"started.json"),"utf8"));assert.equal(started.cwd,f.workspace);assert.equal(started.env.FIXTURE_SECRET,"disposable-token\n");
    for(const forbidden of ["OPENAI_API_KEY","PI_PRIVATE","SSH_AUTH_SOCK","PATH","HOME"])assert.equal(started.env[forbidden],undefined,forbidden);
    assert.throws(()=>process.kill(started.pid,0),{code:"ESRCH"});assert.doesNotMatch(first.output,/PRIVATE MCP DIAGNOSTIC/);
    assert.deepEqual(await driver.call("100","mcp_call",{plan:f.plan("normal")}),first);
    assert.equal((await driver.call("100","mcp_call",{plan:f.plan("env")})).code,"conflict");
    const receipt=await readFile(join(f.state,"worker/operations/100.json"),"utf8");assert.equal(JSON.parse(receipt).kind,"mcp");assert.equal(JSON.parse(receipt).version,2);
    assert.equal((await driver.call("100","write",{path:"unwritten",content:"x"})).code,"conflict");assert.equal(await readFile(join(f.state,"worker/operations/100.json"),"utf8"),receipt);
    const legacy=await driver.call("101","write",{path:"legacy",content:"x"});assert.ok(legacy.ok);
    const old=await readFile(join(f.state,"worker/operations/101.json"),"utf8");assert.equal((await driver.call("101","mcp_call",{plan:f.plan("normal")})).code,"conflict");assert.equal(await readFile(join(f.state,"worker/operations/101.json"),"utf8"),old);
    assert.equal((await driver.call("102","mcp_call",{plan:f.plan("normal")},{machineId:"e".repeat(32)})).code,"offline");
    const wrong={...JSON.parse(f.plan("normal")),taskMachineId:"e".repeat(32)};assert.equal((await driver.call("103","mcp_call",{plan:JSON.stringify(wrong)})).code,"mcp_refused");
    assert.equal((await driver.call("104","mcp_call",{plan:JSON.stringify({...wrong,taskMachineId:f.machineId,tool:"not_approved"})})).code,"mcp_refused");
    assert.equal((await driver.call("105","mcp_call",{plan:JSON.stringify({...JSON.parse(f.plan("normal")),argumentsJSON:'{"mode":"normal","extra":1}'})})).code,"mcp_refused");
    assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
    await driver.close();driver=f.driver();assert.deepEqual(await driver.call("100","mcp_call",{plan:f.plan("normal")}),first);assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
    // Lost acceptance/result: explicit identical retry reads evidence, never executes.
    const body=JSON.stringify({version:1,id:"106",machineId:f.machineId,cwd:f.workspace,operation:"mcp_call",args:{plan:f.plan("normal")}});
    await writeFile(join(f.state,"worker/operations/106.json"),JSON.stringify({version:2,kind:"mcp",hash:hash(body),result:null}),{mode:0o600});
    assert.equal((await driver.call("106","mcp_call",{plan:f.plan("normal")})).code,"effect_uncertain");assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
  }finally{await driver.close();await f.cleanup();}
});

test("MCP failures after dispatch are retained, bounded and never repeated; service errors stay distinct",{skip:!binary,timeout:60000},async()=>{
  // Start with default SIGPIPE disposition, unlike Node's inherited ignore.
  const f=await nativeFixture(binary!),driver=f.driver(true);
  try {
    let id=200,count=0;
    for(const mode of ["normal","crash","oversize","wrong_id","duplicate","malformed","unsupported","tool_error","rpc_error","env","ping","partial","progress"]) {
      const operation=String(id++),plan=f.plan(mode),result=await driver.call(operation,"mcp_call",{plan});count++;
      const code=mode==="tool_error"?"mcp_tool_error":mode==="rpc_error"?"mcp_rpc_error":["normal","env","ping","progress"].includes(mode)?"mcp_result":"effect_uncertain";
      assert.equal(result.code,code,mode+JSON.stringify(result));assert.equal(result.ok,code==="mcp_result");assert.ok(Buffer.byteLength(result.output)<=65536);
      assert.deepEqual(await driver.call(operation,"mcp_call",{plan}),result,mode);assert.equal((await readFile(join(f.workspace,"counter.txt"),"utf8")).length,count);
      if(mode==="env")assert.match(result.output,/disposable-token/); // MCP results are not a secret-removal boundary.
    }
    const replies=(await readFile(join(f.workspace,"server-responses.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.deepEqual(replies.find(r=>r.id==="server-ping").result,{});assert.equal(replies.find(r=>r.id==="server-sampling").error.code,-32601);
    assert.doesNotMatch(driver.stderr,/PRIVATE MCP DIAGNOSTIC|disposable-token/);
  }finally{await driver.close();await f.cleanup();}
});

test("MCP cancellation and capacity are isolated from native files, bash and other invocations",{skip:!binary,timeout:45000},async()=>{
  const f=await nativeFixture(binary!),driver=f.driver();
  try {
    const slow=driver.call("300","mcp_call",{plan:f.plan("hang")});await waitFor(()=>readFile(join(f.workspace,"started.json"),"utf8"));
    const second=driver.call("301","mcp_call",{plan:f.plan("hang")});await waitFor(()=>readFile(join(f.workspace,"counter.txt"),"utf8"),v=>v.length===2);
    await assert.rejects(driver.call("302","mcp_call",{plan:f.plan("normal")}),/busy/);
    const shells=Array.from({length:4},(_,i)=>driver.call(String(310+i),"bash",{command:"sleep 30",timeout:30}));
    assert.equal((await driver.call("314","bash",{command:"printf forbidden",timeout:5})).code,"busy");
    assert.equal((await driver.call("315","write",{path:"native.txt",content:"native while MCP busy"})).ok,true);
    assert.equal((await driver.call("316","read",{path:"native.txt"})).output,"native while MCP busy");
    const began=Date.now();driver.cancel("300");assert.equal((await slow).code,"effect_uncertain");assert.ok(Date.now()-began<3000);
    const normal=await driver.call("303","mcp_call",{plan:f.plan("normal")});assert.equal(normal.code,"mcp_result");
    driver.cancel("301");assert.equal((await second).code,"effect_uncertain");for(let i=0;i<4;i++)driver.cancel(String(310+i));for(const shell of await Promise.all(shells))assert.equal(shell.code,"cancelled");
    assert.equal((await readFile(join(f.workspace,"counter.txt"),"utf8")).length,3);
    assert.equal((await driver.call("300","mcp_call",{plan:f.plan("hang")})).code,"effect_uncertain");
  }finally{await driver.close();await f.cleanup();}
});

for(const flavor of ["bad_init","schema_change","duplicate_tool","cursor_loop","list_changed","many_pages","catalog_bytes"])test(`native MCP refuses ${flavor} without a tool call`,{skip:!binary,timeout:25000},async()=>{
  const f=await nativeFixture(binary!,flavor),driver=f.driver();
  try {
    const result=await driver.call("400","mcp_call",{plan:f.plan("normal")});assert.equal(result.ok,false);assert.ok(["mcp_unavailable","mcp_catalog_changed"].includes(result.code!));
    await assert.rejects(readFile(join(f.workspace,"counter.txt")));
    assert.deepEqual(await driver.call("400","mcp_call",{plan:f.plan("normal")}),result);
  }finally{await driver.close();await f.cleanup();}
});

test("schema drift persists a stale revision fence across restart; fixed-cwd service never adopts caller cwd",{skip:!binary,timeout:45000},async()=>{
  const f=await nativeFixture(binary!);let driver=f.driver();
  try {
    assert.equal((await driver.call("500","mcp_call",{plan:f.plan("bad_output")})).code,"effect_uncertain");
    const stale=`mcp-${f.catalog.profiles[0]!.revision}.stale`;assert.ok((await readdir(join(f.state,"worker/operations"))).includes(stale));
    await driver.close();driver=f.driver();assert.equal((await driver.call("501","mcp_call",{plan:f.plan("normal")})).code,"mcp_catalog_changed");
    assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");await driver.close();
    const fixed=join(f.root,"service");await mkdir(fixed);f.profile.cwd=fixed;f.profile.approval="explicit-second-review";
    const approved=await f.save();driver=f.driver();
    const plan={...JSON.parse(f.plan("normal",approved.profiles[0]!)),taskMachineId:"f".repeat(32)};
    assert.equal((await driver.call("502","mcp_call",{plan:JSON.stringify(plan)},{cwd:"/not-present-on-this-host"})).code,"mcp_result");
    assert.equal(await readFile(join(fixed,"counter.txt"),"utf8"),"x");assert.equal(await readFile(join(f.workspace,"counter.txt"),"utf8"),"x");
  }finally{await driver.close();await f.cleanup();}
});
