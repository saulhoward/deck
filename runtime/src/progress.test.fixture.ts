import { writeFile, rename } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DeckRuntime } from "./deck.js";
const [path] = process.argv.slice(2) as [string];
const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } }); const models = createModels(); models.setProvider(faux.provider);
const runtime = await DeckRuntime.open(path, {
  models, model: { provider: "faux", modelId: "faux-1" }, implementation: "a".repeat(64),
  binding: { machineId: "host", cwd: "/saved" }, environment: () => undefined,
  hostFiles: { call: async () => { throw new Error("No effects expected"); } },
});
faux.setResponses([fauxAssistantMessage("OLD_PARTIAL_".repeat(1000))]);
const submission = await runtime.admit(String(runtime.main.id), { requestId: "original", text: "Start", mode: "followUp" });
for (;;) {
  const progress = await runtime.progress(String(runtime.main.id));
  if ("generation" in progress && progress.generation?.text) {
    await writeFile(`${path}.checkpoint.tmp`, JSON.stringify({ submissionId: String(submission.id), text: progress.generation.text }), { mode: 0o600 });
    await rename(`${path}.checkpoint.tmp`, `${path}.checkpoint`); break;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
setInterval(() => {}, 1000);
