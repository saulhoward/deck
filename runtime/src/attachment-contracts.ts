// Explicit launcher-owned task attachment, never an impersonated Rex block.
import { validClientRequest } from "./command-contracts.js";
import { validSafePiId } from "./mutation-contracts.js";
import type { RequestEnvelope } from "./generated/contracts.js";
const allowed = new Set(["status", "history", "activity", "progress", "instruction_status", "model_settings", "set_model_settings", "rex_status", "rex_inspect", "admit", "stop", "import_instructions"]);
export function attachedRequest(body: string, chatId: string, hubId?: string): RequestEnvelope | undefined {
  try {
    if (!validSafePiId(chatId) || Buffer.byteLength(body) > 128 * 1024) return;
    const request: unknown = JSON.parse(body);
    if (!validClientRequest(request) || !allowed.has(request.command) || (request.args as Record<string, unknown>)?.chatId !== chatId || !request.hubId || (hubId !== undefined && request.hubId !== hubId)) return;
    return request;
  } catch { return; }
}
