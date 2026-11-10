import * as wire from "./generated/contracts.js";
import { rexSocketPath } from "./rex-endpoint.js";
import { validSafePiId, type ReplyContext } from "./mutation-contracts.js";

export function validOpenArgs(value: unknown): value is wire.RexOpenArgs {
  if (!wire.validRexOpenArgs(value) || !validSafePiId(value.chatId)) return false;
  const target = value.target;
  return !target || validTargetOptions(target);
}
export function validTargetOptions(value: unknown): value is wire.RexTargetOptions {
  return wire.validRexTargetOptions(value) && (value.executable === undefined || (value.executable.startsWith("/") && !value.executable.includes("\0") && Buffer.byteLength(value.executable) <= 4096)) && (value.server === undefined || rexSocketPath(value.server) !== undefined);
}
export function validResolvedTarget(value: unknown): value is wire.RexOpenTarget {
  return wire.validRexOpenTarget(value) && validTargetOptions(value);
}
export function validRexReadArgs(value: unknown): value is wire.RexReadArgs { return wire.validRexReadArgs(value) && validSafePiId(value.chatId); }
export function validRexArgs(command: string, value: unknown): boolean {
  return command === "rex_open" ? validOpenArgs(value) : ["rex_status", "rex_inspect"].includes(command) ? validRexReadArgs(value) : true;
}
export function validRexReply(request: ReplyContext, value: unknown): boolean {
  if (!["rex_open", "rex_status", "rex_inspect"].includes(request.command)) return true;
  if (!wire.validRexUuid(request.hubId) || !validRexArgs(request.command, request.args)) return false;
  const args = request.args as wire.RexOpenArgs;
  if (request.command === "rex_open") return wire.validRexOpenAck(value) && value.chatId === args.chatId && value.requestId === args.requestId && validSafePiId(value.taskId);
  if (request.command === "rex_inspect") return wire.validRexInspectionSnapshot(value) && value.chatId === args.chatId && value.hubId === request.hubId && (value.taskId === null || validSafePiId(value.taskId)) && value.finishedAtMs >= value.startedAtMs && (value.status === "sampled") === (value.observation !== null) && (!value.observation || (value.observation.state === "exited") === (value.observation.exitCode !== null));
  if (!wire.validRexStatusSnapshot(value) || value.chatId !== args.chatId || value.hubId !== request.hubId || (value.status === "unallocated") !== (value.taskId === null) || (value.taskId !== null && !validSafePiId(value.taskId)) || (value.status === "allocated" && value.binding === null)) return false;
  return [value.binding, value.previousBinding].every((binding) => !binding || (binding.chatId === args.chatId && binding.hubId === request.hubId && validSafePiId(binding.taskId))) && (!value.binding || value.binding.taskId === value.taskId);
}
