import { validHubCommand, validRequestEnvelope, validTransportId, type RequestEnvelope } from "./generated/contracts.js";
import { validMutationArgs, type ReplyContext } from "./mutation-contracts.js";
import { validDiscoveryArgs } from "./discovery-contracts.js";
import { validHistoryArgs } from "./history-contracts.js";
import { validRexArgs } from "./rex-open-contracts.js";
import { validViewArgs } from "./view-contracts.js";
import { validStatusLoginArgs } from "./status-login-contracts.js";

// Pure semantic composition, not a second authored wire model or dispatcher.
export function validCommandArgs(command: string, raw: unknown): boolean {
  const args = raw ?? {};
  return validHubCommand(command) && validStatusLoginArgs(command, args) &&
    (command !== "list_chats" || validDiscoveryArgs(args)) && (command !== "history" || validHistoryArgs(args)) &&
    validRexArgs(command, args) && validViewArgs(command, args) && validMutationArgs(command, args);
}
export function validReplyContext(request: ReplyContext): boolean {
  return (request.hubId === undefined || (validTransportId(request.hubId) && request.hubId.length <= 200)) && validCommandArgs(request.command, request.args);
}
export function validClientRequest(value: unknown): value is RequestEnvelope {
  return validRequestEnvelope(value) && validReplyContext(value);
}
