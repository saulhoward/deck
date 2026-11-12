import * as wire from "./generated/contracts.js";

export type { NativeRequest, NativeResponse, NativeOperation, NativeResult, NativeProgress } from "./generated/contracts.js";
const bytes = (s: string, cap: number) => Buffer.byteLength(s, "utf8") <= cap;
const path = (s: string) => bytes(s, 4096) && !s.includes("\0");
const safeId = (s: string) => /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s));
export function validCancellationId(s: string): boolean {
  if (!/^[1-9]\d{0,19}$/.test(s)) return false;
  const id = BigInt(s);
  return id <= BigInt(Number.MAX_SAFE_INTEGER) || (id >= 1n << 63n && id < 1n << 64n);
}
export function validNativeRequest(value: unknown): value is wire.NativeRequest {
  if (!wire.validNativeRequest(value) || !value.cwd.startsWith("/") || !path(value.cwd) || value.machineId.length > 200_000) return false;
  const { id, operation, args } = value;
  if (operation === "bash_progress") return wire.validNativeProgressArgs(args) && safeId(args.target) && id === `progress:${args.target}`;
  if (!validCancellationId(id)) return false;
  const ephemeral = operation === "rex_inspect" || operation === "rex_resolve" || operation === "link_status";
  if (ephemeral !== (BigInt(id) >= 1n << 63n)) return false;
  switch (operation) {
    case "link_status": return Object.keys(args).length === 0;
    case "read": return wire.validNativeReadArgs(args) && path(args.path);
    case "write": return wire.validNativeWriteArgs(args) && path(args.path) && bytes(args.content, 128 * 1024);
    case "edit": return wire.validNativeEditArgs(args) && path(args.path) && args.oldText.length > 0 && bytes(args.oldText, 128 * 1024) && bytes(args.newText, 128 * 1024);
    case "bash": return wire.validNativeBashArgs(args) && !args.command.includes("\0");
    default: {
      if (!wire.validNativePlanArgs(args) || !bytes(args.plan, operation === "rex_allocation_receipt" ? 256 * 1024 : 16 * 1024)) return false;
      let plan: unknown; try { plan = JSON.parse(args.plan); } catch { return false; }
      switch (operation) {
        case "rex_allocate": return wire.validRexAllocationPlan(plan) && safeId(plan.chatId);
        case "rex_inspect": return wire.validRexInspectionQuery(plan);
        case "rex_resolve": return wire.validRexTargetOptions(plan);
        case "rex_allocation_receipt": return wire.validRexAllocationReceiptQuery(plan) && safeId(plan.operationId) && bytes(plan.request, 128 * 1024);
      }
    }
  }
}
export function validNativeReply(request: wire.NativeRequest, value: unknown): value is wire.NativeResponse {
  if (!wire.validNativeResponse(value) || value.id !== request.id) return false;
  if (request.operation === "bash_progress") return value.result === undefined && value.progress !== undefined && bytes(value.progress.output, 2048);
  if (value.progress !== undefined || !value.result) return false;
  return validNativeResult(request.operation, value.result);
}
export function validNativeResult(operation: wire.NativeOperation, value: unknown): value is wire.NativeResult {
  if (!wire.validNativeResult(value) || operation === "bash_progress") return false;
  if (operation === "link_status" && value.ok) return value.code === "link_status" && ["connected", "offline"].includes(value.output) && value.exitCode == null && value.truncated !== true;
  const shell = operation === "bash";
  const rex = operation.startsWith("rex_");
  if (!bytes(value.output, shell ? 64 * 1024 + 256 : rex ? 16 * 1024 : 128 * 1024)) return false;
  if (!shell && (value.exitCode != null || value.truncated === true)) return false;
  const success = operation === "rex_allocate" ? "allocated" : operation === "rex_inspect" ? "rex_inspected" : operation === "rex_resolve" ? "rex_resolved" : operation === "rex_allocation_receipt" ? "rex_receipt" : "ok";
  if (value.ok) return (value.code === success || (!rex && value.code === undefined)) && (!shell || value.exitCode === 0);
  // Failed processes can have produced effects, even with a confirmed exit code.
  // Unknown failure codes remain displayable but never imply safe replay.
  return !["ok", "allocated", "rex_inspected", "rex_resolved", "rex_receipt", "link_status"].includes(value.code ?? "") && (!shell || value.exitCode !== 0 || value.code !== "exit_nonzero");
}
