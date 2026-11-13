// Narrow hub-side launcher authority, distinct from allocation-bound task RPC.
// The route is trusted native configuration; nothing in the body can select a
// machine, client executable, Rex endpoint, MCP grant or general hub command.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { ChatDoc, DeckError, type DeckRuntime } from "./deck.js";
import { briefFields } from "./task-brief.js";
import { agentNameFields } from "./agent-names.js";
import { prefixUnits } from "./view-text.js";
import { validSafePiId } from "./mutation-contracts.js";
import { validWorkerFrame } from "./remote-contracts.js";
import { validLaunchRequest, validLaunchResponse, launcherBodyLimit } from "./launcher-contracts.js";
import { type LauncherRequest, type LauncherList, type TaskRelayFrame, type ResponseEnvelope } from "./generated/contracts.js";
export async function launcherResponse(runtime: DeckRuntime, machineId: string, approved: boolean, frame: TaskRelayFrame): Promise<string> {
  if (!validWorkerFrame(frame) || !frame.launcher || frame.scope || Buffer.byteLength(frame.body)>launcherBodyLimit) throw new Error("Invalid launcher envelope");
  const raw: unknown=JSON.parse(frame.body);
  if (!validLaunchRequest(raw)) throw new Error("Invalid launcher request");
  const request: LauncherRequest=raw;
  const refused=()=>{throw new DeckError("conflict","Launcher scope unavailable; earlier requests may have applied");};
  const task=async(id:string)=>{
    if(!validSafePiId(id) || id===String(runtime.main.id)) return refused();
    const cid=Number(id) as ConversationId;
    const record=await runtime.harness.commit(tx=>tx.conversation(cid),context);
    const binding=await runtime.harness.snapshot(ChatDoc,cid,context),agent=await runtime.harness.snapshot(AgentDoc,cid,context);
    if(!record || record.owner || binding?.kind!=="task" || binding.machineId!==machineId || agent?.cwd!==binding.cwd)return refused();
    return binding;
  };
  const guard=async()=>{
    if(!approved || frame.launcher?.hubId!==runtime.hubId)refused();
    if(request.command==="launch_open" || request.command==="launch_inspect") {
      try{await task(request.args.chatId);}catch{refused();}
    }
  };
  const identity={hubId:runtime.hubId,machineId};
  let response:ResponseEnvelope;
  try {
    const result=await runtime.guardedCommand(guard,async()=>{
      switch(request.command){
        case "launch_list": {
          const page=await runtime.harness.commit(tx=>tx.scanConversations({order:"ascending"},25,request.args.after?{after:Number(request.args.after) as ConversationId,order:"ascending"}:undefined),context);
          const items:LauncherList["items"]=[];
          for(const record of page.items) {
            if(record.owner || record.id===runtime.main.id)continue;
            const binding=await runtime.harness.snapshot(ChatDoc,record.id,context),agent=await runtime.harness.snapshot(AgentDoc,record.id,context);
            if(binding?.kind==="task" && binding.machineId===machineId && agent?.cwd===binding.cwd)items.push({...agentNameFields(binding),chatId:String(record.id),title:prefixUnits(binding.title,200)||"Untitled task",cwd:binding.cwd});
          }
          return {...identity,items,...(page.next?{next:String(page.items.at(-1)!.id)}:{})};
        }
        case "launch_create": {
          const a=request.args,brief=briefFields(a);
          // Separate namespace from all historical hub/model task creation IDs.
          const created=await runtime.createTask(a.title,{machineId,cwd:a.cwd},`launcher:${machineId}:${a.requestId}`,undefined,brief);
          const chatId=String(created.id),saved=await task(chatId);
          if(saved.title!==a.title || saved.cwd!==a.cwd || JSON.stringify(briefFields(saved.brief??{}))!==JSON.stringify(brief))refused();
          return {...identity,...agentNameFields(saved),requestId:a.requestId,chatId,title:a.title,cwd:a.cwd,brief};
        }
        case "launch_open":
          // Approved remote clients always use the worker Unix socket. The port
          // remains a stable legacy plan field, not an exposed remote HTTP route.
          return {...identity,ack:await runtime.openTerminal({...request.args,port:52800})};
        case "launch_inspect":
          return {...identity,status:await runtime.terminalStatus(request.args.chatId),inspection:await runtime.inspectTerminal(request.args.chatId)};
      }
    });
    response={version:1,id:request.id,ok:true,result};
    if(!validLaunchResponse(response,request,runtime.hubId,machineId))throw new DeckError("too_large","Launcher response unavailable or exceeds bounds; outcome unconfirmed");
  }catch(error){response={version:1,id:request.id,ok:false,error:{code:error instanceof DeckError?error.code:"runtime_failed",message:error instanceof DeckError?error.message:"Launcher command failed; outcome unconfirmed"}};}
  return JSON.stringify(response);
}
