// Subprocess fault fixture; excluded from installed payload with other *.test.* files.
import { writeFile, rename } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DeckRuntime } from "./deck.js";
const [kind, path] = process.argv.slice(2) as [string, string];
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const runtime = await DeckRuntime.open(path, { models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: "host", cwd: "/saved" }, environment: () => undefined, hostFiles: { call: async () => { throw new Error("No native effects expected"); } } });
setInterval(() => {}, 1000);
if (kind === "create") {
  const create = runtime.createTask.bind(runtime);
  runtime.createTask = async (...args) => {
    const chat = await create(...args);
    await writeFile(`${path}.checkpoint.tmp`, JSON.stringify({ chatId: String(chat.id) }), { mode: 0o600 });
    await rename(`${path}.checkpoint.tmp`, `${path}.checkpoint`);
    await new Promise(() => {}); return chat;
  };
  faux.setResponses([fauxAssistantMessage(fauxToolCall("task_create", { title: "Created once" }), { stopReason: "toolUse" })]);
} else {
  const target = await runtime.createTask("Target", { machineId: "offline", cwd: "/remote" }, "seed-target");
  const admit = runtime.admit.bind(runtime);
  runtime.admit = async (...args) => {
    const submission = await admit(...args);
    if (args[0] === String(target.id)) {
      await writeFile(`${path}.checkpoint.tmp`, JSON.stringify({ chatId: String(target.id), submissionId: String(submission.id) }), { mode: 0o600 });
      await rename(`${path}.checkpoint.tmp`, `${path}.checkpoint`);
      await new Promise(() => {});
    }
    return submission;
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("task_message", { chatId: String(target.id), text: "TARGET", mode: "steer" }), { stopReason: "toolUse" }),
    async () => { await new Promise(() => {}); return fauxAssistantMessage("Unreachable before kill"); },
  ]);
}
await (await runtime.admit(String(runtime.main.id), { requestId: "start", text: "Start", mode: "followUp" })).wait(context);
