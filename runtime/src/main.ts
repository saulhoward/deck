// Private child entry point. Only Zig opens/owns the inherited writer lock.
import { fstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CompatibilityError, fingerprintImplementation } from "./compatibility.js";
import { startupProviders } from "./providers.js";
import { DeckError, DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { parseRoutes, RoutedFiles } from "./remote-files.js";
import { serveWorkerClients } from "./remote-clients.js";
import { loadCatalog } from "./mcp-tools.js";
import { serveIpc } from "./ipc.js";

async function main() {
  const [path, machineId, cwd, descriptor, mode, modelId, readFd, writeFd, controlFd, nativeExecutable, routesJson, mcpCatalogPath] = process.argv.slice(2);
  const lockFd = Number(descriptor);
  if (!nativeExecutable || !path || !machineId || !cwd || !Number.isSafeInteger(lockFd) || lockFd < 3 || (mode !== "--mock" && mode !== "--chatgpt" && mode !== "--api-key" && mode !== "--auto")) throw new Error("Runtime must be launched by deck serve");
  if (!fstatSync(lockFd).isFile()) throw new Error("Missing inherited writer lock");
  // Upstream's callback bind override must not expose a public listener.
  process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";
  const provider = await startupProviders(mode, join(dirname(path), "auth.json"), machineId, modelId || undefined);
  process.stderr.write(`deck: authentication ${provider.mode === "--mock" ? "mock" : provider.mode === "--api-key" ? "API key (billable)" : "ChatGPT OAuth"}\n`);
  const routes = routesJson ? parseRoutes(routesJson, machineId, [lockFd, Number(readFd), Number(writeFd), Number(controlFd)]) : undefined;
  const local = readFd && writeFd ? new PipeFiles(Number(readFd), Number(writeFd), controlFd ? Number(controlFd) : undefined) : undefined;
  if (routes && !local) throw new Error("Remote routing requires the native launcher");
  let files: PipeFiles | RoutedFiles | undefined = local;
  try { if (routes) files = new RoutedFiles(machineId, local!, routes); }
  catch (error) { await local?.close(); throw error; }
  let runtime: DeckRuntime | undefined;
  const clients: ReturnType<typeof serveWorkerClients>[] = [];
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.stdin.destroy();
    for (const client of clients) client.close();
    await provider.login?.close();
    await runtime?.close();
    await files?.close();
    // Keep lockFd open until process exit, including startup/shutdown failures.
  };
  process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
  try {
    runtime = await DeckRuntime.open(path, {
      ...(routes ? { expectedHubId: routes.hubId } : {}),
      ...(mcpCatalogPath ? {mcpCatalog:await loadCatalog(mcpCatalogPath,machineId,routes)} : {}),
      models: provider.models, model: provider.model, admissionGuard: provider.guard, validateSavedModels: true,
      authentication: provider.mode === "--mock" ? "mock" : provider.mode === "--api-key" ? "api_key" : "chatgpt_oauth",
      implementation: await fingerprintImplementation({ native: nativeExecutable, entry: process.argv[1]!, mode: provider.mode }),
      rexClient: basename(nativeExecutable) === ".deck-wrapped" ? join(dirname(nativeExecutable), "deck") : nativeExecutable,
      binding: { machineId, cwd }, environment: () => undefined, ...(files ? { hostFiles: files } : {}),
    });
    // A failed Harness closes itself. Do not leave a live command process/listener
    // around a dead store. Never echo the failure payload (it can contain input).
    void runtime.harness.closed.then((end) => {
      if (end.reason === "failed") {
        process.stderr.write("deck runtime: store failed; stopping writer\n");
        // The store has already closed. Do not wait on unrelated admission guards.
        closing = true; process.stdin.destroy();
        void (async () => {
          try { await provider.login?.close(); }
          finally { await files?.close(); process.exit(1); }
        })();
      }
    });
    for (const host of routes?.hosts ?? []) if (host.rexClient) clients.push(serveWorkerClients(runtime, host.machineId, host.rexClient, host.clientReadFd!, host.clientWriteFd!, host.launcher === true));
    await serveIpc(runtime, process.stdin, process.stdout, provider.login);
  } finally { await shutdown(); }
}

main().catch((error: unknown) => {
  // Do not echo provider/storage exception text: it may contain input or secrets.
  process.stderr.write(error instanceof DeckError || error instanceof CompatibilityError ? `deck runtime: ${error.message}\n` : "deck runtime: startup or IPC failed\n");
  process.exitCode = 1;
});
