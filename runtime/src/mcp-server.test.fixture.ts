// Disposable test server. This is not a product tool host or runtime dependency.
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
const inputSchema={type:"object",properties:{mode:{type:"string",enum:["normal","hang","crash","oversize","wrong_id","duplicate","tool_error","rpc_error","malformed","unsupported","bad_output","env","ping","partial","progress","changed","gated"]}},required:["mode"],additionalProperties:false};
const outputSchema={type:"object",properties:{count:{type:"integer",minimum:0,maximum:10000}},required:["count"],additionalProperties:false};
const readInput={type:"object",properties:{},required:[],additionalProperties:false};
const readOutput={type:"object",properties:{count:{type:"integer",minimum:0,maximum:10000},cwd:{type:"string",maxLength:4096}},required:["count","cwd"],additionalProperties:false};
const flavor=process.argv[2]??"normal";
let page=0;
const send=(value:unknown)=>process.stdout.write(JSON.stringify(value)+"\n");
process.stderr.write("PRIVATE MCP DIAGNOSTIC "+(process.env.FIXTURE_SECRET??"none")+"\n");
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const request=JSON.parse(line);
  if(request.method==="initialize") {
    if(flavor==="bad_init") {send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:"1900-01-01",capabilities:{tools:{}},serverInfo:{name:"fake",version:"1"}}});continue;}
    send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:"2025-06-18",capabilities:{tools:{listChanged:true}},serverInfo:{name:"fake",version:"1"}}});
  } else if(request.method==="tools/list") {
    if(flavor==="list_changed") send({jsonrpc:"2.0",method:"notifications/tools/list_changed"});
    if(flavor==="cursor_loop" || flavor==="many_pages") {send({jsonrpc:"2.0",id:request.id,result:{tools:[],nextCursor:flavor==="cursor_loop"?"same":String(page++)}});continue;}
    if(flavor==="catalog_bytes") {const tools=Array.from({length:40},(_,i)=>({name:`unapproved_${page}_${i}`,description:"x".repeat(4096),inputSchema:{type:"object"}}));send({jsonrpc:"2.0",id:request.id,result:{tools,nextCursor:String(page++)}});continue;}
    if(flavor==="paginated" && !request.params?.cursor) {send({jsonrpc:"2.0",id:request.id,result:{tools:[],nextCursor:"second"}});continue;}
    const tools=[{name:"counter",description:"Untrusted server description",inputSchema:flavor==="schema_change"?{...inputSchema,required:[]}:inputSchema,outputSchema}, {name:"read",inputSchema:readInput,outputSchema:readOutput}, {name:"not_approved",inputSchema:{type:"object"},annotations:{readOnlyHint:true}}];
    if(flavor==="duplicate_tool") tools.push(tools[0]!);
    send({jsonrpc:"2.0",id:request.id,result:{tools}});
    if(flavor==="catalog_progress") send({jsonrpc:"2.0",method:"notifications/progress",params:{progressToken:"ignored",progress:1}});
  } else if(request.method==="tools/call") {
    if(request.params.name==="read") {send({jsonrpc:"2.0",id:request.id,result:{content:[{type:"text",text:"read-only fixture"}],structuredContent:{count:existsSync("counter.txt")?readFileSync("counter.txt","utf8").length:0,cwd:process.cwd()}}});continue;}
    if(request.params.name!=="counter") throw new Error("Unapproved tool reached server");
    const mode=request.params.arguments.mode;
    appendFileSync("counter.txt","x"); const count=readFileSync("counter.txt","utf8").length;
    writeFileSync("started.json",JSON.stringify({pid:process.pid,id:request.id,cwd:process.cwd(),env:process.env,wire:line,arguments:request.params.arguments}));
    if(mode==="crash") process.exit(23);
    if(mode==="partial") {process.stdout.write('{"partial":',()=>process.exit(0));continue;}
    if(mode==="changed") {send({jsonrpc:"2.0",method:"notifications/tools/list_changed"});continue;}
    if(mode==="gated") while(!existsSync("release")) await new Promise(r=>setTimeout(r,10));
    if(mode==="hang") {await new Promise(resolve=>setTimeout(resolve,60000));continue;}
    if(mode==="malformed") {process.stdout.write("not-json\n");continue;}
    if(mode==="ping") {send({jsonrpc:"2.0",id:"server-ping",method:"ping"});send({jsonrpc:"2.0",id:"server-sampling",method:"sampling/createMessage",params:{}});}
    if(mode==="rpc_error") {send({jsonrpc:"2.0",id:request.id,error:{code:-32603,message:"service error",data:{mightHaveEffects:true}}});continue;}
    const result={content: mode==="unsupported"?[{type:"image",data:"AA==",mimeType:"image/png"}]:[{type:"text",text:mode==="oversize"?"X".repeat(70000):mode==="env"?JSON.stringify(process.env):"counter updated 😀"}],structuredContent:mode==="bad_output"?{count:"not-integer"}:{count},...(mode==="tool_error"?{isError:true}:{})};
    const reply={jsonrpc:"2.0",id:mode==="wrong_id"?"call:unrelated":request.id,result};
    if(mode==="duplicate") process.stdout.write(JSON.stringify(reply)+"\n"+JSON.stringify(reply)+"\n"); else send(reply);
    if(mode==="progress") send({jsonrpc:"2.0",method:"notifications/progress",params:{progressToken:"ignored",progress:1}});
  } else if(request.id==="server-ping" || request.id==="server-sampling") appendFileSync("server-responses.jsonl",JSON.stringify(request)+"\n");
  else if(request.method==="notifications/cancelled") writeFileSync("cancelled.json",JSON.stringify(request));
}
