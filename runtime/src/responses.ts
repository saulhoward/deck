import { validStatusLoginReply } from "./status-login-contracts.js";
import { validRexReply } from "./rex-open-contracts.js";
import { validMutationAck, type ReplyContext } from "./mutation-contracts.js";
import { validDiscoveryPage } from "./discovery-contracts.js";
import { validHistoryPage } from "./history-contracts.js";
import { validViewReply } from "./view-contracts.js";
import { encodeFrame, FrameSizeError } from "./protocol.js";
import { validResponseEnvelope, validTransportId, type ResponseEnvelope, type FailurePolicy } from "./generated/contracts.js";
import { failurePolicy } from "./command-policy.js";
import { validReplyContext } from "./command-contracts.js";

export class HubError extends Error {
  readonly policy: FailurePolicy;
  constructor(readonly code: string, message: string, command = "") { super(message); this.policy = failurePolicy(command, code, "remote"); }
}
// Shape validity is not correlation, a command-specific ACK or proof of no effect.
export function responseResult(value: unknown, expectedId: string, request?: ReplyContext): unknown {
  if (!validResponseEnvelope(value) || value.id !== expectedId) throw new Error("Invalid hub response envelope or identity; request not acknowledged");
  if (!value.ok) throw new HubError(value.error.code, value.error.message, request?.command);
  if (request?.command === "list_chats" && !validDiscoveryPage(value.result, request.args)) throw new Error("Invalid chat discovery response; cursor unchanged");
  if (request?.command === "history" && !validHistoryPage(value.result, request.args)) throw new Error("Invalid history response; cursor unchanged");
  if (request && !validStatusLoginReply(request, value.result)) throw new Error("Invalid status/login response; identity or outcome unconfirmed");
  if (request && !validRexReply(request, value.result)) throw new Error("Invalid Rex response; outcome unknown, no automatic retry");
  if (request && !validViewReply(request.command, value.result, request.args)) throw new Error("Invalid live view response; observation unchanged");
  if (request && !validMutationAck(request, value.result)) throw new Error(request.command === "rex_startup" ? "Invalid Rex startup acknowledgement; no input sent" : "Invalid acknowledgement; request outcome unconfirmed");
  if (request && !validReplyContext(request)) throw new Error("Invalid command acknowledgement; request outcome unconfirmed");
  return value.result;
}
// Validate the actual serialized egress, not only its pre-serialization type:
// undefined fields/toJSON can otherwise disappear or change required ACK fields.
export function responseFrame(value: ResponseEnvelope, request?: ReplyContext): Buffer {
  const id = value.id;
  if (!validTransportId(id)) throw new Error("Invalid response identity");
  let code = "invalid_response", message = "Runtime response invalid; inspect the request outcome before retrying";
  try {
    const frame = encodeFrame(value);
    const encoded: unknown = JSON.parse(frame.subarray(4).toString("utf8"));
    if (validResponseEnvelope(encoded) && encoded.id === id && (!encoded.ok || !request || (validReplyContext(request) && validStatusLoginReply(request, encoded.result) && validRexReply(request, encoded.result) && validMutationAck(request, encoded.result) && validViewReply(request.command, encoded.result, request.args) && (request.command !== "list_chats" || validDiscoveryPage(encoded.result, request.args)) && (request.command !== "history" || validHistoryPage(encoded.result, request.args))))) return frame;
  } catch (error) {
    if (error instanceof FrameSizeError) { code = "too_large"; message = "Response exceeds IPC limit"; }
  }
  // Dispatch may already have committed. Do not echo invalid/private contents or
  // retry here, and do not tell callers that a mutation was not executed.
  return encodeFrame({ version: 1, id, ok: false, error: { code, message } } satisfies ResponseEnvelope);
}
