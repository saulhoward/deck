import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { ChatDoc, type DeckRuntime } from "./deck.js";

// Separate from the inspection extension: explicitly selecting read-only tools
// must not silently grant task mutation on upgrade.
export function taskControl(runtime: () => DeckRuntime) {
  const outputLimits = { maxBytes: 4096, maxLines: 1 };
  const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  return defineExtension({ name: "deck.task-control", tools: [
    defineTool({
      name: "task_create", replay: "safe", callers: ["model"], outputLimits,
      description: "Create one persistent ownerless Deck task chat, without starting generation. Inherits the calling chat's saved host/cwd, even if offline, and main's saved model/reasoning. No host reassignment. Returns its chat ID; use task_message separately to start work. Not a subagent: stopping the caller does not delete/stop the created task. Pi replay deduplicates this exact tool task; a NEW tool call is a NEW creation, so inspect existing tasks before retrying an ambiguous result.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }) }),
      execute: async (args, api, context) => {
        context.abortSignal?.throwIfAborted();
        const source = runtime();
        const binding = await source.harness.snapshot(ChatDoc, api.conversationId, context);
        if (!binding?.machineId) throw new Error("Calling chat has no saved Deck tool binding");
        context.abortSignal?.throwIfAborted();
        const requestId = `deck-tool:${api.taskId}:create`;
        const chat = await source.createTask(args.title, { machineId: binding.machineId, cwd: binding.cwd }, requestId, context.abortSignal);
        // Once issued, the Pi commit may finish despite caller cancellation. Never
        // delete independently owned work to manufacture rollback semantics.
        return result({ chatId: String(chat.id), requestId, createdOrRecovered: true, started: false, ownership: "ownerless" });
      },
    }),
    defineTool({
      name: "task_message", replay: "safe", callers: ["model"], outputLimits,
      description: "Durably admit text to another existing Deck task, returning its submission receipt immediately, NOT its answer or completion. Default mode followUp queues behind active work; steer joins at a tool boundary. Rejects main, subagent, self and unmanaged chats. Target retains its own host/model; never falls back to the caller's worker. Not a subagent: caller stop/failure does not cancel admitted target work. Do not automatically relay acknowledgements between tasks. Pi replay deduplicates this exact tool task; a NEW tool call is a NEW message, so inspect an ambiguous outcome before retrying.",
      parameters: Type.Object({ chatId: Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 16 }), text: Type.String({ minLength: 1, maxLength: 8192 }), mode: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")])) }),
      execute: async (args, api, context) => {
        context.abortSignal?.throwIfAborted();
        const source = runtime();
        if (!await source.harness.snapshot(ChatDoc, api.conversationId, context)) throw new Error("Calling chat is not a Deck chat");
        const chat = await source.chat(args.chatId);
        if (chat.id === api.conversationId) throw new Error("task_message cannot message the calling chat");
        const metadata = await source.harness.snapshot(ChatDoc, chat.id, context);
        if (metadata?.kind !== "task") throw new Error("task_message requires another existing Deck task, not main or an unmanaged chat");
        context.abortSignal?.throwIfAborted();
        const requestId = `deck-tool:${api.taskId}:message`;
        const mode = args.mode ?? "followUp";
        const submission = await source.admit(args.chatId, { requestId, text: args.text, mode, origin: { kind: "task-tool", chatId: String(api.conversationId), taskId: String(api.taskId) } }, context.abortSignal);
        return result({ chatId: args.chatId, submissionId: String(submission.id), requestId, mode, admitted: true, completion: "not_waited" });
      },
    }),
  ] });
}
