import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { ChatDoc, type DeckRuntime } from "./deck.js";
import { briefFields, validForm } from "./task-brief.js";
import { messageCausality, toolMessageOrigin, MAX_MESSAGE_HOPS } from "./message-causality.js";

// Separate from inspection: read-only tool selection never grants mutation.
export function taskControl(runtime: () => DeckRuntime) {
  const outputLimits = { maxBytes: 4096, maxLines: 1 };
  const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const sender = async (api: ToolExecutionApi, context: Context) => {
    const source = runtime(); const metadata = await source.harness.snapshot(ChatDoc, api.conversationId, context);
    const record = await source.harness.commit(tx => tx.conversation(api.conversationId), context);
    if (!metadata || metadata.kind === "subagent" || !record || record.owner) throw new Error("Calling chat must be an independent Deck chat");
    return { source, metadata };
  };
  const message = async (args: { chatId: string; text: string; mode?: "steer" | "followUp" }, api: ToolExecutionApi, context: Context, hub: boolean) => {
    context.abortSignal?.throwIfAborted(); const { source, metadata } = await sender(api, context);
    const chat = await source.chat(args.chatId);
    if (chat.id === api.conversationId) throw new Error("task_message cannot message the calling chat");
    const target = await source.harness.snapshot(ChatDoc, chat.id, context);
    const record = await source.harness.commit(tx => tx.conversation(chat.id), context);
    if (!record || record.owner || !args.text.isWellFormed() || Buffer.byteLength(args.text) > 8192) throw new Error("Messaging requires an independent target and text up to 8192 UTF-8 bytes");
    if (hub ? metadata.kind !== "task" || chat.id !== source.main.id : chat.id === source.main.id || target?.kind !== "task") throw new Error(hub ? "hub_message requires an independent task" : "task_message requires another existing Deck task, not main or an unmanaged chat");
    const requestId = `deck-tool:${api.taskId}:message`, mode = args.mode ?? "followUp";
    const legacy = { kind: "task-tool" as const, chatId: String(api.conversationId), taskId: String(api.taskId) };
    const origin = !hub && await source.hasLegacyMessageReceipt(args.chatId, { requestId, text: args.text, mode, origin: legacy }) ? legacy : await toolMessageOrigin(api, context);
    const submission = await source.admit(args.chatId, { requestId, text: args.text, mode, origin }, context.abortSignal);
    return result({ chatId: args.chatId, submissionId: String(submission.id), requestId, mode, origin, admitted: true, completion: "not_waited" });
  };
  return defineExtension({ name: "deck.task-control", hooks: [messageCausality(runtime)], tools: [
    defineTool({
      name: "task_create", replay: "safe", callers: ["model"], outputLimits,
      description: "Create a persistent ownerless task without generation or Rex. Default: caller's saved host/cwd and hub's model/reasoning. Only the hub model may explicitly choose machineId AND cwd from host_list; offline registered hosts remain valid, with no fallback or enrollment. Optional problem/description form an immutable creation-time instruction snapshot. A NEW tool call creates a NEW task; inspect ambiguous outcomes before retrying. Use task_message separately to start work.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), problem: Type.Optional(Type.String({ maxLength: 2048 })), description: Type.Optional(Type.String({ maxLength: 8192 })), machineId: Type.Optional(Type.String({ pattern: "^[0-9a-f]{32}$" })), cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }),
      execute: async (args, api, context) => {
        context.abortSignal?.throwIfAborted(); const { source, metadata } = await sender(api, context);
        if (!metadata.machineId) throw new Error("Calling chat has no saved Deck tool binding");
        if (args.machineId !== undefined && (api.conversationId !== source.main.id || !await source.registeredTarget(args.machineId))) throw new Error("Only the hub can select an explicitly registered host");
        const binding = args.machineId === undefined ? metadata : { machineId: args.machineId, cwd: args.cwd! };
        const requestId = `deck-tool:${api.taskId}:create`;
        if (!validForm({ ...args })) {
          // Old model titles were bounded in UTF-16 units, not UTF-8 bytes.
          // Read an already committed title-only receipt; never create new work
          // outside today's byte bounds or repair an uncommitted legacy draft.
          const old = Object.keys(args).length === 1 ? await source.legacyCreatedTask(args.title, binding, requestId) : undefined;
          if (!old) throw new Error("Invalid task title, brief or paired host/cwd");
          return result({ chatId: String(old.id), requestId, createdOrRecovered: true, started: false, ownership: "ownerless" });
        }
        const chat = await source.createTask(args.title, { machineId: binding.machineId, cwd: binding.cwd }, requestId, context.abortSignal, briefFields(args));
        return result({ chatId: String(chat.id), requestId, createdOrRecovered: true, started: false, ownership: "ownerless" });
      },
    }),
    defineTool({
      name: "task_message", replay: "safe", callers: ["model"], outputLimits,
      description: `Admit text to another existing independent task; returns admission, NOT an answer. Rejects main, children and self. Defaults to followUp; steer joins at a tool boundary. Preserves target host/model and authoritative sender/reply provenance. Agent chains stop at ${MAX_MESSAGE_HOPS} hops; another tool call does not reset them. Never automatically relay ACKs. Same Pi tool-task replay deduplicates; a NEW call is a NEW message. Caller stop does not cancel admitted target work.`,
      parameters: Type.Object({ chatId: Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 16 }), text: Type.String({ minLength: 1, maxLength: 8192 }), mode: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")])) }),
      execute: (args, api, context) => message(args, api, context, false),
    }),
    defineTool({
      name: "hub_message", replay: "safe", callers: ["model"], outputLimits,
      description: `Explicitly report from an independent task to the hub as follow-up input. Wakes/queues hub work; this is not a passive notification or returned answer. Sender, reply correlation and the ${MAX_MESSAGE_HOPS}-hop causal budget are assigned by Deck, not model arguments. Never echo ACKs or automatically forward status. Same-call replay deduplicates; a new call is a new message.`,
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 8192 }) }),
      execute: (args, api, context) => message({ ...args, chatId: String(runtime().main.id), mode: "followUp" }, api, context, true),
    }),
  ] });
}
