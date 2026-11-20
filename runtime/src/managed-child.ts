import { defineDocFamily, type Agent, type AgentState, type ConversationRecord } from "@earendil-works/pi-durable";
import type { TaskBrief } from "./generated/contracts.js";
import { briefInstructions } from "./task-brief.js";
import { DeckError } from "./deck-error.js";

// Not the ordinary task_create namespace. Receipt, conversation and Deck metadata
// commit together: no reservation can be mistaken for a completed creation.
export const ManagedChildRequest = defineDocFamily<{ hash: string; chatId: number }, string>({
  kind: "deck.managed-child-request", version: 1, scope: "session", family: true,
  initial: hash => ({ hash, chatId: 0 }), checkpointWhen: () => true,
});

// Session-wide namespace pins each open ID to its original parent/child/session.
// The receipt and child's allocation task commit atomically, including reuse.
export const ManagedChildOpenRequest = defineDocFamily<{ hash: string; taskId: number; status: "admitted" | "reused" }, string>({
  kind: "deck.managed-child-open-request", version: 1, scope: "session", family: true,
  initial: hash => ({ hash, taskId: 0, status: "admitted" }), checkpointWhen: () => true,
});

type Relation = { kind: "main" | "task" | "subagent"; managedParentChatId?: string };
export function independentDeckChat(record: ConversationRecord | undefined, metadata: Relation | undefined, mainId: number): boolean {
  return !!record && !record.owner && !!metadata && (metadata.kind === "task" || (metadata.kind === "main" && record.id === mainId));
}

export function assertManagedMessageRelation(sourceId: string, source: Relation, targetId: string, target: Relation): void {
  if ((source.managedParentChatId !== undefined || target.managedParentChatId !== undefined)
    && source.managedParentChatId !== targetId && target.managedParentChatId !== sourceId) {
    throw new DeckError("invalid", "Managed children may exchange agent messages only with their parent or direct managed children");
  }
}

// Freeze the complete enabled surface, not just Agent.tools (the offered model
// subset). In particular, retain nested-call and deferred tools, and enabled
// model-only tools omitted by modelTools. The stored filter establishes which
// extension tools are enabled; the resolved arrays include wrapped tools. Pin
// both selections to arrays so future defaults cannot broaden the snapshot.
export function managedAgentSnapshot(agent: Agent, saved: AgentState, title: string, brief: TaskBrief, cwd: string): AgentState {
  const available = [...new Set([
    ...agent.extensions.flatMap(extension => (extension.tools ?? []).map(tool => tool.name)),
    ...agent.tools.map(tool => tool.name), ...agent.callable.map(tool => tool.name), ...agent.deferred.map(tool => tool.name),
  ])];
  const filter = saved.tools;
  const tools = Array.isArray(filter) ? [...new Set(filter)].filter(name => available.includes(name))
    : available.filter(name => !filter?.remove.includes(name));
  return {
    ...(agent.model ? { model: { ...agent.model } } : {}), thinkingLevel: agent.thinkingLevel,
    extensions: agent.extensions.map(extension => extension.name), tools,
    modelTools: agent.tools.map(tool => tool.name), cwd, instructions: briefInstructions(title, brief),
  };
}
