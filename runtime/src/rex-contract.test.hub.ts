// Test-only central Pi/faux server. Files below are test gates, not production
// hub-local effects. No provider credentials/network calls or model tool calls.
import { fstatSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { RexTarget } from "./rex-allocation.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { fingerprintImplementation } from "./compatibility.js";
import { DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { serveIpc } from "./ipc.js";
const args = process.argv.slice(2); if (!fstatSync(Number(args[3])).isFile()) throw new Error("No writer lock");
const directory = dirname(args[0]!); const exists = async (path: string) => access(path).then(() => true, () => false);
const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
const respond: FauxResponseFactory = async () => {
  faux.appendResponses([respond]);
  if (await exists(join(directory, "gate-enabled"))) {
    await writeFile(join(directory, "generation-started"), "");
    while (!await exists(join(directory, "gate-released"))) await new Promise((resolve) => setTimeout(resolve, 25));
    return fauxAssistantMessage("DETACHED_WORK_FINISHED (faux; no provider inference)");
  }
  return fauxAssistantMessage("Deck prototype response (faux; no inference performed).");
};
faux.setResponses([respond]);
const files = new PipeFiles(Number(args[6]), Number(args[7]), Number(args[8]));
const runtime = await DeckRuntime.open(args[0]!, { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
  implementation: await fingerprintImplementation({ native: args[9]!, entry: process.argv[1]!, mode: "--mock" }),
  rexClient: basename(args[9]!) === ".deck-wrapped" ? join(dirname(args[9]!), "deck") : args[9]!,
  binding: { machineId: args[1]!, cwd: args[2]! }, hostFiles: { call: async (...request) => {
    const result = await files.call(...request);
    if (request[2] === "rex_allocate" && result.ok && process.env.DECK_REX_ALLOC_REQUEST && await exists(process.env.DECK_REX_ALLOC_REQUEST)) {
      // Test gate: force registration to beat native-result apply. Production
      // allocation does not wait for client startup or change its effect result.
      const plan = JSON.parse(String(request[3].plan)) as { chatId: string };
      const control = JSON.parse(await readFile(process.env.DECK_REX_ALLOC_REQUEST, "utf8")) as { chatId: string; loseReply?: boolean };
      if (control.chatId !== plan.chatId) return result;
      const deadline = performance.now() + 5000; let startup;
      do { startup = await runtime.terminalStartup(plan.chatId); if (startup.observation !== "not_observed") break; await new Promise((resolve) => setTimeout(resolve, 25)); } while (performance.now() < deadline);
      if (startup.observation !== "unbound") throw new Error("Early startup not observed");
      await writeFile(`${process.env.DECK_REX_ALLOC_REQUEST}.early`, JSON.stringify(startup));
      if (control.loseReply) return { ok: false, code: "effect_uncertain", output: "Test-only lost creation reply" };
    }
    return result;
  } }, environment: () => undefined,
});
let closing = false;
// Optional one-shot test control, never a production command or another writer.
if (process.env.DECK_REX_ALLOC_REQUEST) void (async () => {
  const path = process.env.DECK_REX_ALLOC_REQUEST!;
  while (!closing && !await exists(path)) await new Promise((resolve) => setTimeout(resolve, 25));
  if (closing) return;
  const request = JSON.parse(await readFile(path, "utf8")) as { chatId: string; target: RexTarget; loseReply?: boolean };
  const taskId = await runtime.allocateTerminal(request.chatId, "internal-allocation", request.target);
  const task = await runtime.harness.waitForTask(taskId, context);
  const duplicate = await runtime.allocateTerminal(request.chatId, "internal-allocation", request.target);
  await writeFile(`${path}.result`, JSON.stringify({ taskId, duplicate, outcome: task.state.outcome, binding: await runtime.terminalBinding(request.chatId), startup: await runtime.terminalStartup(request.chatId) }));
  if (request.loseReply) {
    while (!closing && !await exists(`${path}.reconcile`)) await new Promise((resolve) => setTimeout(resolve, 25));
    if (closing) return;
    const reconciliationTaskId = await runtime.reconcileTerminal(request.chatId, "explicit-reconciliation");
    const reconciled = await runtime.harness.waitForTask(reconciliationTaskId, context);
    await writeFile(`${path}.reconciled`, JSON.stringify({ taskId, reconciliationTaskId, outcome: reconciled.state.outcome, originalOutcome: (await runtime.harness.waitForTask(taskId, context)).state.outcome, binding: await runtime.terminalBinding(request.chatId), startup: await runtime.terminalStartup(request.chatId) }));
  }
  const historical = (async () => {
    while (!closing && !await exists(`${path}.inspect`)) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!closing) await writeFile(`${path}.inspect.result`, JSON.stringify(await runtime.terminalStartup(request.chatId)));
  })().catch(() => { process.stderr.write("Rex historical test read failed\n"); });
  // Repeated fresh reads, never another durable operation or public mutation API.
  for (let index = 0; !closing; index++) {
    const read = `${path}.presence.${index}`;
    while (!closing && !await exists(read)) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!closing) await writeFile(`${read}.result`, JSON.stringify({ presence: await runtime.inspectTerminal(request.chatId), startup: await runtime.terminalStartup(request.chatId), binding: await runtime.terminalBinding(request.chatId) }));
  }
  await historical;
})().catch(() => { process.stderr.write("Rex allocation test control failed\n"); });
async function shutdown() { if (closing) return; closing = true; process.stdin.destroy(); await runtime.close(); await files.close(); }
process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
try { await serveIpc(runtime, process.stdin, process.stdout); } finally { await shutdown(); }
