// Public-Pi fault fixture: suspend the real tool immediately after an atomic child
// creation or after reading its committed answer, before returning the tool result.
import { writeFile, rename } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, type EntryRecord, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { bindImplementation, checkCompatibility, defaultImplementation, stampImplementation } from "./compatibility.js";
import { ChatDoc } from "./deck.js";
import { nativeFiles } from "./host-files.js";
import { foregroundSubagent } from "./subagent.js";
const [step, path] = process.argv.slice(2) as [string, string];
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const delegation = foregroundSubagent(defineExtension({ name: "deck.task-control" }));
const tool = delegation.tools![0] as ToolRegistration;
const registry = createRegistry(); registry.install(CodingTools);
registry.install(nativeFiles({ call: async () => { throw new Error("No effects expected"); } }));
registry.install(defineExtension({ name: delegation.name, tools: [{ ...tool, execute: async (args, api, context) => {
  const wrapped: ToolExecutionApi = { ...api, async commit(change, context) {
    const value = await api.commit(change, context);
    const entry = value && typeof value === "object" && "kind" in value ? value as unknown as EntryRecord : undefined;
    if ((step === "created" && typeof value === "number") || (step === "answered" && entry?.kind === "pi.assistant")) {
      await writeFile(`${path}.checkpoint.tmp`, JSON.stringify({ chatId: String(entry?.conversationId ?? value), ownerTaskId: String(api.taskId) }), { mode: 0o600 });
      await rename(`${path}.checkpoint.tmp`, `${path}.checkpoint`);
      await new Promise(() => {});
    }
    return value;
  } };
  return tool.execute(args, wrapped, context);
} }] }));
const storage = await openNodeSqliteStorage(path);
const implementation = bindImplementation(await defaultImplementation(), true);
await checkCompatibility(storage, implementation);
const harness = await Harness.open(storage, { models, registry, env: () => undefined }, context);
await stampImplementation(harness, implementation);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: "/saved" }, init: async (tx, id) => { Object.assign(await tx.doc(ChatDoc, id), { machineId: "host", cwd: "/saved" }); } });
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("subagent", { task: "CHILD_TASK", title: "Recovered helper" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("CHILD_ANSWER"),
]);
setInterval(() => {}, 1000);
await (await root.submit({ type: "input", requestId: "start", content: "Start" }, context)).wait(context);
