// Test-only Pi probes. Local reads here are NOT Deck's assigned-worker implementation.
import { readFile, rename, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, section, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { bindImplementation, checkCompatibility, stampImplementation } from "./compatibility.js";

export const ORIGINAL = "PROJECT_INSTRUCTIONS_ORIGINAL";
export const CHANGED = "PROJECT_INSTRUCTIONS_CHANGED";
export const IMPLEMENTATION = "a".repeat(64);
export type Probe = "prepare" | "request" | "memo";
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
export async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Instruction probe timed out")), 7000); })]); }
  finally { clearTimeout(timer); }
}
export async function checkpoint(path: string, value: object) {
  await writeFile(`${path}.checkpoint.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.checkpoint.tmp`, `${path}.checkpoint`);
}
export function provider() {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  return { faux, models };
}
export const model = { provider: "faux", modelId: "faux-1" };

// The same code/registry is used before and after SIGKILL. pause only injects the crash window.
export async function openProbe(path: string, projectPath: string, probe: Probe, pause = false): Promise<{ harness: Harness; root: Conversation; faux: ReturnType<typeof fauxProvider>; counts: { reads: number; hooks: number } }> {
  const { faux, models } = provider(); const registry = createRegistry();
  const counts = { reads: 0, hooks: 0 };
  async function read() { counts.reads++; return await readFile(projectPath, "utf8"); }
  async function stop(point: Probe) {
    if (pause && point === probe) {
      await checkpoint(path, { point });
      await new Promise<never>(() => {});
    }
  }
  registry.install(defineExtension({
    name: "test.project-instructions",
    sections: probe === "memo" ? [] : [section("project", async () => { const text = await read(); await stop("prepare"); return text; })],
    hooks: [hook(GenerationTask, { beforeRequest: async (request, api, ctx) => {
      counts.hooks++;
      if (probe !== "memo") { await stop("request"); return undefined; }
      const snapshot = await api.memo<{ text: string }>("project", ctx) ?? await api.memo("project", { text: await read() }, ctx);
      await stop("memo");
      // Hook replacements reach the provider, but are not appended to canonical history.
      return { messages: [...request.messages, { role: "system" as const, content: "", sections: { project: snapshot.text }, timestamp: 0 }] };
    } })],
  }));
  const storage = await openNodeSqliteStorage(path);
  const digest = bindImplementation(IMPLEMENTATION, false);
  try { await checkCompatibility(storage, digest); } catch (error) { await storage.close(context); throw error; }
  const harness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false } } }, context);
  await stampImplementation(harness, digest);
  const root = await harness.root(context, { agent: { model } });
  return { harness, root, faux, counts };
}
