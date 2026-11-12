// Disposable SIGKILL fixture. Never use this against an existing store.
import { writeFile, rename } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DeckRuntime } from "./deck.js";
const [path, mode] = process.argv.slice(2);
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const runtime = await DeckRuntime.open(path!, { models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: "a".repeat(32), cwd: "/saved" }, environment: () => undefined, hostFiles: { call: async () => { throw new Error("No native effect expected"); }, registeredHosts: async () => [{ machineId: "b".repeat(32), kind: "worker", rex: false, connection: "offline" }] } });
const task = await runtime.createTask("Reporter", { machineId: "b".repeat(32), cwd: "/remote" });
const admit = runtime.admit.bind(runtime);
runtime.admit = async (id, input, signal) => {
  // Simulate the historical message envelope for the compatibility case. This
  // changes fixture input only; the normal admission hash/receipt path is used.
  if (mode === "legacy" && input.origin) input = { ...input, origin: { kind: "task-tool", chatId: input.origin.chatId, taskId: input.origin.taskId } };
  const receipt = await admit(id, input, signal);
  if (input.origin && input.text === "RECOVERY_REPORT") {
    await writeFile(`${path}.checkpoint.tmp`, JSON.stringify({ target: id, sender: input.origin.chatId, submissionId: String(receipt.id), input }), { flush: true });
    await rename(`${path}.checkpoint.tmp`, `${path}.checkpoint`);
    await new Promise(() => {}); // Parent kills us after the target commit, before source tool ACK.
  }
  return receipt;
};
faux.setResponses([() => fauxAssistantMessage(fauxToolCall(mode === "legacy" ? "task_message" : "hub_message", mode === "legacy" ? { chatId: String(task.id), text: "RECOVERY_REPORT" } : { text: "RECOVERY_REPORT" }), { stopReason: "toolUse" }), () => fauxAssistantMessage("Received")]);
await runtime.admit(String(mode === "legacy" ? runtime.main.id : task.id), { requestId: "human-report", text: "Start", mode: "followUp" });
setInterval(() => {}, 1000);
