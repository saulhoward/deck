import { DeckRuntime, type RuntimeOptions } from "./deck.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
export function setup(overrides: Partial<RuntimeOptions> = {}) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }, { id: "faux-2", reasoning: true }] }); const models = createModels(); models.setProvider(faux.provider);
  const options: RuntimeOptions = {
    implementation: "a".repeat(64), models, model: { provider: "faux", modelId: "faux-1" },
    binding: { machineId: "a".repeat(32), cwd: "/saved" }, environment: () => undefined,
    hostFiles: { call: async () => { throw new Error("No native effects expected"); } }, ...overrides,
  };
  return { faux, options, open: (path: string) => DeckRuntime.open(path, options) };
}
