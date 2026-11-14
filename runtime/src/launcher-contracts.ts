import { validLauncherRequest, validLauncherList, validLauncherCreated, validLauncherOpened, validLauncherAdopted, validLauncherInspection, validResponseEnvelope, type LauncherRequest, type ResponseEnvelope } from "./generated/contracts.js";
import { validBrief, validBriefBinding, briefFields } from "./task-brief.js";
import { validAdoptArgs, validRexReply } from "./rex-open-contracts.js";
import { validSafePiId } from "./mutation-contracts.js";
export const launcherBodyLimit = 128 * 1024;
export function validLaunchRequest(value: unknown): value is LauncherRequest {
  if (!validLauncherRequest(value) || Buffer.byteLength(JSON.stringify(value)) > launcherBodyLimit) return false;
  switch(value.command) {
    case "launch_adopt": return validAdoptArgs(value.args);
    case "launch_list": return value.args.after === undefined || validSafePiId(value.args.after);
    case "launch_create": return validBriefBinding(value.args.title,value.args.cwd) && validBrief({...(value.args.problem===undefined?{}:{problem:value.args.problem}),...(value.args.description===undefined?{}:{description:value.args.description})});
    default: return validSafePiId(value.args.chatId);
  }
}
export function validLaunchResponse(value: unknown, request: LauncherRequest, hubId: string, machineId: string): value is ResponseEnvelope {
  if (!validResponseEnvelope(value) || value.id !== request.id) return false;
  if (!value.ok) return true;
  const r=value.result;
  switch(request.command) {
    case "launch_list": return validLauncherList(r) && r.hubId===hubId && r.machineId===machineId && (r.next===undefined || (validSafePiId(r.next) && Number(r.next)>Number(request.args.after??0))) && r.items.every((t,i)=>validSafePiId(t.chatId) && validBriefBinding("task",t.cwd) && Number(t.chatId)>Number(i?r.items[i-1]!.chatId:request.args.after??0) && (r.next===undefined || Number(t.chatId)<=Number(r.next)));
    case "launch_create": return validLauncherCreated(r) && r.hubId===hubId && r.machineId===machineId && r.requestId===request.args.requestId && validSafePiId(r.chatId) && r.title===request.args.title && r.cwd===request.args.cwd && validBrief(r.brief) && JSON.stringify(briefFields(r.brief))===JSON.stringify(briefFields(request.args));
    case "launch_adopt": return validLauncherAdopted(r) && r.hubId === hubId && r.machineId === machineId && validRexReply({ command: "rex_adopt", args: request.args, hubId }, r.ack);
    case "launch_open": return validLauncherOpened(r) && r.hubId===hubId && r.machineId===machineId && r.ack.chatId===request.args.chatId && r.ack.requestId===request.args.requestId && validSafePiId(r.ack.taskId);
    case "launch_inspect": return validLauncherInspection(r) && r.hubId===hubId && r.machineId===machineId && r.status.hubId===hubId && r.status.chatId===request.args.chatId && r.inspection.hubId===hubId && r.inspection.chatId===request.args.chatId && [r.status.binding,r.status.previousBinding].every(b=>!b || b.machineId===machineId);
  }
}
