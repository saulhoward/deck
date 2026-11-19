import { defineDoc } from "@earendil-works/pi-durable";
import type { AgentNameMetadata } from "./agent-names.js";
import type { TaskBrief } from "./generated/contracts.js";

export type Binding = { machineId: string; cwd: string };
type Chat = Binding & AgentNameMetadata & {
  kind: "main" | "task" | "subagent";
  title: string;
  parentChatId?: string;
  ownerTaskId?: string;
  brief?: TaskBrief;
};

export const ChatDoc = defineDoc<Chat>({
  kind: "deck.chat", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ kind: "main", title: "Main", machineId: "", cwd: "" }), checkpointWhen: () => true,
});
