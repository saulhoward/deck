import * as wire from "./generated/contracts.js";
import { rexSocketPath } from "./rex-endpoint.js";
import { validSafePiId, type ReplyContext } from "./mutation-contracts.js";

export function validBootstrapClaim(value: unknown): value is wire.RexBootstrapClaim {
  return wire.validRexBootstrapClaim(value) && value.root.startsWith("/") && !value.root.includes("\0") && Buffer.byteLength(value.root) <= 4096;
}
export function validInspectionQuery(value: unknown): value is wire.RexInspectionQuery {
  return wire.validRexInspectionQuery(value) && (value.bootstrap === undefined || (value.bootstrap.kind === "here" && validBootstrapClaim(value.bootstrap) && value.bootstrap.blockId === value.scope.blockId));
}
export function validAdoptArgs(value: unknown): value is wire.RexAdoptArgs {
  return wire.validRexAdoptArgs(value) && validSafePiId(value.chatId) && validResolvedTarget(value.target) && validBootstrapClaim(value.bootstrap);
}
export function validOpenArgs(value: unknown): value is wire.RexOpenArgs {
  if (!wire.validRexOpenArgs(value) || !validSafePiId(value.chatId)) return false;
  const target = value.target;
  return !target || validTargetOptions(target);
}
export function validOpenManagedChildArgs(value: unknown): value is wire.OpenManagedChildArgs {
  return wire.validOpenManagedChildArgs(value) && validSafePiId(value.chatId) && validSafePiId(value.childId) && Number(value.childId) > Number(value.chatId);
}
export function validTargetOptions(value: unknown): value is wire.RexTargetOptions {
  return wire.validRexTargetOptions(value) && (value.executable === undefined || (value.executable.startsWith("/") && !value.executable.includes("\0") && Buffer.byteLength(value.executable) <= 4096)) && (value.server === undefined || rexSocketPath(value.server) !== undefined);
}
export function validResolvedTarget(value: unknown): value is wire.RexOpenTarget {
  return wire.validRexOpenTarget(value) && validTargetOptions(value);
}
export function validRexReadArgs(value: unknown): value is wire.RexReadArgs { return wire.validRexReadArgs(value) && validSafePiId(value.chatId); }
export function validRexArgs(command: string, value: unknown): boolean {
  return command === "open_managed_child" ? validOpenManagedChildArgs(value) : command === "rex_adopt" ? validAdoptArgs(value) : command === "rex_open" ? validOpenArgs(value) : ["rex_status", "rex_inspect"].includes(command) ? validRexReadArgs(value) : true;
}
export function validRexReply(request: ReplyContext, value: unknown): boolean {
  if (!["open_managed_child", "rex_open", "rex_adopt", "rex_status", "rex_inspect"].includes(request.command)) return true;
  if (!wire.validRexUuid(request.hubId) || !validRexArgs(request.command, request.args)) return false;
  if (request.command === "open_managed_child") {
    const args = request.args as wire.OpenManagedChildArgs;
    return wire.validOpenManagedChildAck(value) && value.parentChatId === args.chatId && value.childId === args.childId && value.ack.chatId === args.childId && value.ack.requestId === args.requestId && validSafePiId(value.ack.taskId);
  }
  const args = request.args as wire.RexOpenArgs;
  if (request.command === "rex_adopt") return wire.validRexAdoptAck(value) && value.hubId === request.hubId && value.chatId === args.chatId && value.requestId === args.requestId && validSafePiId(value.taskId);
  if (request.command === "rex_open") return wire.validRexOpenAck(value) && value.chatId === args.chatId && value.requestId === args.requestId && validSafePiId(value.taskId);
  if (request.command === "rex_inspect") return wire.validRexInspectionSnapshot(value) && value.chatId === args.chatId && value.hubId === request.hubId && (value.taskId === null || validSafePiId(value.taskId)) && value.finishedAtMs >= value.startedAtMs && (value.status === "sampled") === (value.observation !== null) && (!value.observation || (value.observation.state === "exited") === (value.observation.exitCode !== null));
  if (!wire.validRexStatusSnapshot(value) || value.chatId !== args.chatId || value.hubId !== request.hubId || (value.status === "unallocated") !== (value.taskId === null) || (value.taskId !== null && !validSafePiId(value.taskId)) || (value.status === "allocated" && value.binding === null)) return false;
  return [value.binding, value.previousBinding].every((binding) => !binding || (binding.chatId === args.chatId && binding.hubId === request.hubId && validSafePiId(binding.taskId))) && (!value.binding || value.binding.taskId === value.taskId);
}
