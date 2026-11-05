import { writeFile, rename } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { DeckRuntime } from "./deck.js";
const [path] = process.argv.slice(2) as [string];
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const runtime = await DeckRuntime.open(path, {
  models, model: { provider: "faux", modelId: "faux-1" }, implementation: "a".repeat(64),
  binding: { machineId: "saved-host", cwd: "/saved" }, environment: () => undefined,
  hostFiles: { call: async () => { throw new Error("No effects expected"); } },
});
faux.setResponses([async () => {
  await writeFile(`${path}.checkpoint.tmp`, "running", { mode: 0o600 }); await rename(`${path}.checkpoint.tmp`, `${path}.checkpoint`);
  return await new Promise(() => {});
}]);
setInterval(() => {}, 1000);
await (await runtime.admit(String(runtime.main.id), { requestId: "original", text: "PRIVATE_WORK_SENTINEL", mode: "followUp" })).wait(context);
