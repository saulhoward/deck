// One-shot remote bootstrap UI. Successful creation and Rex admission are
// separate actions; neither acknowledgement promises a running terminal.
import { randomUUID } from "node:crypto";
import { launcherTarget,launcherCommand,type LauncherTarget } from "./launcher-client.js";
import { LauncherDrafts,type LaunchMutation } from "./launcher-drafts.js";
import { validLaunchRequest,validLaunchResponse } from "./launcher-contracts.js";
import { type LauncherRequest,type LauncherCreated } from "./generated/contracts.js";
const usage=`deck agent --launch-from ABS_WORKER_DIRECTORY [--list [--after ID]]
  --new '{"title":"...","cwd":"/absolute/work","problem":"...","description":"..."}' --confirm
  --open CHAT_ID --confirm | --inspect CHAT_ID
  --drafts | --retry CREATION_DRAFT_UUID --confirm | --discard DRAFT_UUID --confirm
New tasks have no MCP grants; existing selections remain unchanged.
Create/open are explicit, separate operations. Lost open replies are NOT retried.
Only configured, approved launcher workers can use this surface. No hub login.
`;
export function launchOptions(args:string[]) {
  if(args[0]!=="--launch-from" || !args[1])throw new Error(usage);
  let action="list",value:string|undefined,after:string|undefined,confirm=false,selected=false;
  for(let i=2;i<args.length;i++){
    const key=args[i]!;
    if(key==="--confirm"){if(confirm)throw new Error("Duplicate confirmation");confirm=true;continue;}
    if(key==="--after"){if(after!==undefined || !args[++i])throw new Error("Invalid cursor");after=args[i];continue;}
    if(!["--list","--new","--open","--inspect","--drafts","--retry","--discard"].includes(key) || selected)throw new Error(usage);
    selected=true;action=key.slice(2);
    if(!["list","drafts"].includes(action)){value=args[++i];if(!value)throw new Error(usage);}
  }
  const mutating=["new","open","retry","discard"].includes(action);
  if(mutating!==confirm || (after!==undefined && action!=="list"))throw new Error("Mutations require --confirm; other options cannot imply confirmation");
  return {directory:args[1],action,value,after};
}
export async function runLauncher(args:string[],out:(text:string)=>void=console.log,send=launcherCommand){
  if(args.length===3 && args[0]==="--launch-from" && args[2]==="--help"){out(usage);return;}
  const o=launchOptions(args),target=await launcherTarget(o.directory),store=new LauncherDrafts(target);
  const observe=async(command:"launch_list"|"launch_inspect",a:Record<string,string>)=>{
    const request={version:1,id:randomUUID(),command,args:a} as LauncherRequest;
    if(!validLaunchRequest(request))throw new Error("Invalid launcher observation; not sent");
    const result=await send(target,request);
    if(!validLaunchResponse({version:1,id:request.id,ok:true,result},request,target.hubId,target.machineId))throw new Error("Launcher identity/observation invalid; no mutation requested");
    return result;
  };
  if(o.action==="drafts"){out(JSON.stringify((await store.list()).map(r=>({draftId:r.args.requestId,command:r.command,...(r.command==="launch_create"?{title:r.args.title,cwd:r.args.cwd}:{chatId:r.args.chatId})}))));return;}
  if(o.action==="discard"){const request=await store.load(o.value!);await store.remove(request);out("Draft discarded locally; earlier requests/effects are not rolled back.");return;}
  if(o.action==="list" || o.action==="inspect"){out(JSON.stringify(await observe(o.action==="list"?"launch_list":"launch_inspect",o.action==="list"?(o.after?{after:o.after}:{}):{chatId:o.value!})));return;}
  // Observe this configured hub/machine before any mutation. Never silently
  // choose another worker, fall back to localhost or mint a second hub.
  await observe("launch_list",{});
  const submit=async(request:LaunchMutation)=>{
    await store.save(request);
    const result=await send(target,request);
    if(!validLaunchResponse({version:1,id:request.id,ok:true,result},request,target.hubId,target.machineId))throw new Error("Invalid launcher acknowledgement; draft retained");
    await store.remove(request);out(JSON.stringify(result));return result;
  };
  const openTask=async(chatId:string)=>{
    const request={version:1 as const,id:randomUUID(),command:"launch_open" as const,args:{chatId,requestId:randomUUID()}};
    if(!validLaunchRequest(request))throw new Error("Invalid task ID; not sent");
    await submit(request);out("Rex request acknowledged, not terminal readiness. Use --inspect to observe; do not automatically repeat opening.");
  };
  if(o.action==="retry"){
    const request=await store.load(o.value!);
    if(request.command!=="launch_create")throw new Error("Open outcome is uncertain: use --inspect, then explicitly discard/reconcile; open requests are not replayed");
    const created=await submit(request) as LauncherCreated;
    out(`Creation recovered. Opening is separate: --open ${created.chatId} --confirm`);return;
  }
  if((await store.list()).length)throw new Error("Pending launcher drafts exist; inspect/recover or explicitly discard them before a new mutation");
  if(o.action==="open"){await openTask(o.value!);return;}
  let form:Record<string,unknown>;
  try{form=JSON.parse(o.value!);if(!form || Array.isArray(form) || Object.keys(form).some(k=>!["title","cwd","problem","description"].includes(k)))throw new Error();}
  catch{throw new Error("Invalid new-task JSON; use title,cwd,problem?,description? only");}
  const request={version:1,id:randomUUID(),command:"launch_create",args:{...form,requestId:randomUUID()}};
  if(!validLaunchRequest(request) || request.command!=="launch_create")throw new Error("Invalid task brief or absolute cwd; no request sent");
  const created=await submit(request) as LauncherCreated;
  // Save -> create -> validate ACK -> remove exact draft -> separate Rex open.
  await openTask(created.chatId);
}
if(process.argv[1]?.endsWith("/launcher-main.js"))runLauncher(process.argv.slice(2)).catch(error=>{process.stderr.write(`deck launcher: ${error instanceof Error?error.message:"request failed; outcome unconfirmed"}\n`);process.exitCode=1;});
