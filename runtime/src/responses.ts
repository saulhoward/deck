import { encodeFrame, FrameSizeError } from "./protocol.js";
import { validResponseEnvelope, validTransportId, type ResponseEnvelope } from "./generated/contracts.js";

export class HubError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
// Shape validity is not correlation, a command-specific ACK or proof of no effect.
export function responseResult(value: unknown, expectedId: string): unknown {
  if (!validResponseEnvelope(value) || value.id !== expectedId) throw new Error("Invalid hub response envelope or identity; request not acknowledged");
  if (!value.ok) throw new HubError(value.error.code, value.error.message);
  return value.result;
}
// Validate the actual serialized egress, not only its pre-serialization type:
// undefined fields/toJSON can otherwise disappear or change required ACK fields.
export function responseFrame(value: ResponseEnvelope): Buffer {
  const id = value.id;
  if (!validTransportId(id)) throw new Error("Invalid response identity");
  let code = "invalid_response", message = "Runtime response invalid; inspect the request outcome before retrying";
  try {
    const frame = encodeFrame(value);
    const encoded: unknown = JSON.parse(frame.subarray(4).toString("utf8"));
    if (validResponseEnvelope(encoded) && encoded.id === id) return frame;
  } catch (error) {
    if (error instanceof FrameSizeError) { code = "too_large"; message = "Response exceeds IPC limit"; }
  }
  // Dispatch may already have committed. Do not echo invalid/private contents or
  // retry here, and do not tell callers that a mutation was not executed.
  return encodeFrame({ version: 1, id, ok: false, error: { code, message } } satisfies ResponseEnvelope);
}
