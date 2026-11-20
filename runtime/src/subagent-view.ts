import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import type { DeckRuntime } from "./deck.js";
import { ChatDoc } from "./chat-doc.js";
import { lookupAgentName } from "./agent-names.js";
import { DeckError } from "./deck-error.js";
import type { SubagentViewArgs, SubagentViewReply } from "./generated/contracts.js";
import { subagentReadArgs } from "./subagent-view-contracts.js";

// No tx.doc calls: even failed lookup must not initialize metadata/claims. Pi
// ownership is immutable; Deck hints alone are never read authority. Recheck on
// EVERY read request, including polls using a previously resolved child ID.
export async function subagentView(runtime: DeckRuntime, args: SubagentViewArgs, read: (command: string, args: Record<string, unknown>) => Promise<unknown>): Promise<SubagentViewReply> {
  const refuse = () => new DeckError("not_found", "No coherent direct subagent with that name/ID for this parent");
  const parent = await runtime.chat(args.chatId);
  const id = args.name === undefined ? args.childId : await lookupAgentName(runtime.harness, args.name, context);
  if (id === undefined) throw refuse();
  const child = await runtime.chat(String(id));
  const verify = async () => {
    const owned = await runtime.harness.commit(async tx => {
      const record = await tx.conversation(child.id), owner = record?.owner;
      return owner?.conversationId === parent.id && (await tx.task(owner.taskId))?.conversationId === parent.id ? owner : undefined;
    }, context);
    if (!owned) throw refuse();
    const [saved, binding, agent, parentAgent] = await Promise.all([
      runtime.harness.snapshot(ChatDoc, child.id, context), runtime.harness.snapshot(ChatDoc, parent.id, context), runtime.harness.snapshot(AgentDoc, child.id, context), runtime.harness.snapshot(AgentDoc, parent.id, context),
    ]);
    if (!saved || !binding || saved.kind !== "subagent" || saved.parentChatId !== args.chatId || saved.ownerTaskId !== String(owned.taskId) || saved.machineId !== binding.machineId || saved.cwd !== binding.cwd || agent?.cwd !== saved.cwd || parentAgent?.cwd !== binding.cwd) throw refuse();
  };
  const childId = String(child.id);
  await verify();
  const result = await read(args.operation, subagentReadArgs(args, childId));
  // Suppress even a completed read if the saved binding became incoherent while
  // sampling. Never release private data under a stale child-scope check.
  await verify();
  return { hubId: runtime.hubId, parentChatId: args.chatId, childId, operation: args.operation, ...(args.name === undefined ? {} : { name: args.name }), result };
}
