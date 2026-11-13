// Isolated installed-native/Pi fault fixture; never used as a product provider.
import { fstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
// Installed wrappers set this root. Use their actual Pi adapters/dependencies,
// not checkout substitutes, while keeping the fake provider entrypoint external.
const root=process.env.DECK_RUNTIME_ROOT;
const entry=(name:string)=>root?pathToFileURL(join(root,"runtime/dist",name)).href:new URL(name,import.meta.url).href;
const dependency=(name:string)=>root?pathToFileURL(join(root,"node_modules/@earendil-works/pi-ai/dist",`${name}.js`)).href:`@earendil-works/pi-ai/${name}`;
const { createModels }=await import(dependency("models")) as typeof import("@earendil-works/pi-ai/models");
const { fauxProvider,fauxAssistantMessage,fauxToolCall }=await import(dependency("providers/faux")) as typeof import("@earendil-works/pi-ai/providers/faux");
const {DeckRuntime}=await import(entry("deck.js")) as typeof import("./deck.js");
const {PipeFiles}=await import(entry("host-files.js")) as typeof import("./host-files.js");
const {loadCatalog,toolAlias}=await import(entry("mcp-tools.js")) as typeof import("./mcp-tools.js");
const {serveIpc}=await import(entry("ipc.js")) as typeof import("./ipc.js");
const [path,machineId,cwd,lock,_mode,_model,read,write,control,_binary,_routes,catalogPath]=process.argv.slice(2);
if(!path||!machineId||!cwd||!catalogPath||!fstatSync(Number(lock)).isFile())throw new Error("Missing private test launch");
const host=new PipeFiles(Number(read),Number(write),Number(control)),catalog=await loadCatalog(catalogPath,machineId);
const faux=fauxProvider(),models=createModels();models.setProvider(faux.provider);
const alias=toolAlias(catalog.profiles[0]!,"counter");
faux.setResponses(Array.from({length:100},()=>request=>{
  const lastUser=request.messages.findLastIndex(m=>m.role==="user");
  if(request.messages.slice(lastUser+1).some(m=>m.role==="toolResult"))return fauxAssistantMessage("Observed MCP outcome; no automatic new invocation");
  const message=request.messages[lastUser];const text=message&&typeof message.content!=="string"?message.content.map(p=>p.type==="text"?p.text:"").join(""):String(message?.content??"");
  const mode=/MCP:(\w+)/.exec(text)?.[1]??"normal";
  return fauxAssistantMessage(fauxToolCall(mode==="read"?toolAlias(catalog.profiles[0]!,"read"):alias,mode==="read"?{}:{mode}),{stopReason:"toolUse"});
}));
let runtime: import("./deck.js").DeckRuntime|undefined;
try {
  runtime=await DeckRuntime.open(path,{models,model:{provider:"faux",modelId:"faux-1"},binding:{machineId,cwd},environment:()=>undefined,hostFiles:host,mcpCatalog:catalog,implementation:"fa".repeat(32)});
await writeFile(join(dirname(path),"test-pi-pid"),String(process.pid),{flush:true});
await writeFile(join(dirname(path),"test-pi-runtime-root"),entry("deck.js"));
  await serveIpc(runtime,process.stdin,process.stdout);
}finally{await runtime?.close();await host.close();}
