// Semantic adapters for the migrated public mutations, not a command registry or
// second source of wire shapes. Other commands keep their existing checks.
import { validBrief, validBriefBinding } from "./task-brief.js";
import { validAdmitArgs, validAdmitAck, validCreateTaskArgs, validCreateTaskBriefArgs, validCreateTaskAck, validInstructionImportArgs, validInstructionImportAck, validStopArgs, validStopAck, validRexStartupArgs, validRexStartupAck, validTransportId, validPiId, type StopArgs, type RexStartupArgs, type AdmitArgs, type CreateTaskArgs, type CreateTaskBriefArgs, type InstructionImportArgs, type RequestEnvelope } from "./generated/contracts.js";

export type ReplyContext = Pick<RequestEnvelope, "command" | "args" | "hubId">;
export const validSafePiId = (value: unknown): value is string => validPiId(value) && Number.isSafeInteger(Number(value));
export function validMutationArgs(command: "admit", value: unknown): value is AdmitArgs;
export function validMutationArgs(command: "create_task", value: unknown): value is CreateTaskArgs;
export function validMutationArgs(command: "create_task_brief", value: unknown): value is CreateTaskBriefArgs;
export function validMutationArgs(command: "import_instructions", value: unknown): value is InstructionImportArgs;
export function validMutationArgs(command: "stop", value: unknown): value is StopArgs;
export function validMutationArgs(command: "rex_startup", value: unknown): value is RexStartupArgs;
export function validMutationArgs(command: string, value: unknown): boolean;
export function validMutationArgs(command: string, value: unknown): boolean {
  switch (command) {
    // Keep the existing runtime UTF-16 caps in addition to schema code-point
    // bounds. This migration does not widen admission or reinterpret saved bytes.
    case "admit": return validAdmitArgs(value) && validSafePiId(value.chatId) && value.requestId.length <= 200 && value.text.length <= 200_000;
    case "create_task": return validCreateTaskArgs(value) && value.requestId.length <= 200 && [value.title, value.machineId, value.cwd].every((text) => text.length <= 200_000);
    case "create_task_brief": return validCreateTaskBriefArgs(value) && value.requestId.length <= 200 && value.machineId.length <= 200_000 && validBriefBinding(value.title, value.cwd) && (value.problem !== undefined || value.description !== undefined) && validBrief({ ...(value.problem === undefined ? {} : { problem: value.problem }), ...(value.description === undefined ? {} : { description: value.description }) });
    case "import_instructions": return validInstructionImportArgs(value) && validSafePiId(value.chatId) && value.requestId.length <= 200 && [value.machineId, value.cwd].every((text) => text.length <= 200_000);
    case "stop": return validStopArgs(value) && validSafePiId(value.chatId);
    case "rex_startup": return validRexStartupArgs(value) && validSafePiId(value.chatId);
    default: return true; // Not validation/permission for an unmigrated command.
  }
}
export function validMutationAck(request: ReplyContext, value: unknown): boolean {
  if (!validMutationArgs(request.command, request.args)) return false;
  switch (request.command) {
    case "admit": return validAdmitAck(value) && validSafePiId(value.submissionId);
    case "create_task": return validCreateTaskAck(value) && validSafePiId(value.chatId) && value.brief === undefined;
    case "create_task_brief": {
      if (!validCreateTaskAck(value) || !validSafePiId(value.chatId)) return false;
      const original = request.args as CreateTaskBriefArgs;
      return validBrief(value.brief) && value.brief.problem === original.problem && value.brief.description === original.description;
    }
    case "import_instructions": {
      const original = request.args as InstructionImportArgs;
      return validInstructionImportAck(value) && validSafePiId(value.chatId) && validSafePiId(value.taskId) && value.chatId === original.chatId && value.requestId === original.requestId;
    }
    case "stop": return validStopAck(value); // Requested only, never drained/idle.
    case "rex_startup": {
      const original = request.args as RexStartupArgs;
      return validTransportId(request.hubId) && request.hubId.length <= 200 && validRexStartupAck(value) && validSafePiId(value.chatId) && validSafePiId(value.taskId) && value.chatId === original.chatId && value.allocationId === original.allocationId && value.blockId === original.blockId;
    }
    default: return true;
  }
}
