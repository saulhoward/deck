import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DeckRuntime } from "./deck.js";
import { checkpoint, gate, IMPLEMENTATION, model, openProbe, provider, type Probe } from "./instructions.test.support.js";

const [path, projectPath, mode] = process.argv.slice(2) as [string, string, Probe | "stored"];
setInterval(() => {}, 1000);
if (mode === "stored") {
  const { faux, models } = provider(); const entered = gate();
  const runtime = await DeckRuntime.open(path, {
    models, model, implementation: IMPLEMENTATION, binding: { machineId: "saved-worker", cwd: dirname(projectPath) },
    environment: () => { throw new Error("No local fallback expected"); }, hostFiles: { call: async () => { throw new Error("No effects expected"); } },
  });
  // Test-only seeding of explicit instructions. There is no production project-file loader.
  await runtime.configure(String(runtime.main.id), { instructions: await readFile(projectPath, "utf8") });
  faux.setResponses([async () => { entered.release(); return await new Promise<never>(() => {}); }]);
  const first = await runtime.admit(String(runtime.main.id), { requestId: "first", text: "First", mode: "followUp" });
  await entered.promise;
  const queued = await runtime.admit(String(runtime.main.id), { requestId: "queued", text: "Queued", mode: "followUp" });
  await checkpoint(path, { firstId: String(first.id), queuedId: String(queued.id) });
  await first.wait(context);
} else {
  const { root } = await openProbe(path, projectPath, mode, true);
  await (await root.submit({ requestId: "original", type: "input", content: "Start" }, context)).wait(context);
}
