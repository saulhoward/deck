import * as wire from "./generated/contracts.js";
import { validCatalog } from "./mcp-contracts.js";
import type { ReplyContext } from "./mutation-contracts.js";
const safe = (id: string) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
const unique = (profiles: wire.McpGrant[]) => new Set(profiles.map(g=>`${g.machineId}/${g.profileId}`)).size===profiles.length;
export function validMcpArgs(command: string,args: unknown): boolean {
  if(command==="mcp_catalog") return !!args && typeof args==="object" && !Array.isArray(args) && Object.keys(args).length===0;
  if(command==="tool_profiles") return wire.validStopArgs(args) && safe(args.chatId);
  if(command==="set_tool_profiles") return wire.validMcpGrantArgs(args) && safe(args.chatId) && unique(args.profiles);
  return true;
}
export function validMcpReply(request: ReplyContext,result: unknown): boolean {
  if(request.command==="mcp_catalog") return validCatalog(result) && Buffer.byteLength(JSON.stringify(result))<=256*1024;
  if(!["tool_profiles","set_tool_profiles"].includes(request.command)) return true;
  if(!validMcpArgs(request.command,request.args) || !wire.validMcpGrantSnapshot(result) || !safe(result.chatId) || !unique(result.profiles)) return false;
  const args=request.args as wire.McpGrantArgs;
  if(result.chatId!==args.chatId) return false;
  return request.command!=="set_tool_profiles" || (result.revision===args.expectedRevision || result.revision===args.expectedRevision+1) && result.profiles.length===args.profiles.length && result.profiles.every((g,i)=>g.machineId===args.profiles[i]!.machineId && g.profileId===args.profiles[i]!.profileId && g.revision===args.profiles[i]!.revision);
}
