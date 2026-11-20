import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { configure, defineTask } from "@earendil-works/pi-durable";
import type { DeckRuntime } from "./deck.js";
import { ChatDoc } from "./chat-doc.js";
import { assignSubagentName } from "./agent-names.js";
const ownerTask = defineTask<{}, { phase: "blocked" }, null>({ name: "test.subagent-view-owner", version: 1, initial: () => ({ phase: "blocked" }), phases: { blocked: async () => {} }, abort: async () => {} });
export async function namedChildren(runtime: DeckRuntime, parentId: string, count = 1) {
  const parent = await runtime.chat(parentId);
  return parent.commit(async tx => {
    const binding = await tx.doc(ChatDoc, parent.id);
    const owner = await tx.createTask(ownerTask, {}, { ownership: { kind: "conversation" } });
    const children = [];
    for (let i = 0; i < count; i++) {
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
      await configure(tx, child.id, { cwd: binding.cwd });
      const saved = await tx.doc(ChatDoc, child.id);
      Object.assign(saved, { kind: "subagent", title: `Helper ${i}`, brief: { description: `Task ${i}` }, machineId: binding.machineId, cwd: binding.cwd, parentChatId: parentId, ownerTaskId: String(owner) });
      await assignSubagentName(tx, child.id, saved, binding);
      children.push({ chatId: String(child.id), name: saved.agentName! });
    }
    return children;
  }, context);
}
