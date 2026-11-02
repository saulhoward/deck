// Private child entry point. Only Zig opens/owns the inherited writer lock.
import { fstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { providers } from "./providers.js";
import { DeckError, DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { serveIpc } from "./ipc.js";

async function main() {
  const [path, machineId, cwd, descriptor, mode, modelId, readFd, writeFd, controlFd] = process.argv.slice(2);
  const lockFd = Number(descriptor);
  if (!path || !machineId || !cwd || !Number.isSafeInteger(lockFd) || lockFd < 3 || (mode !== "--mock" && mode !== "--chatgpt" && mode !== "--api-key")) throw new Error("Runtime must be launched by deck serve");
  if (!fstatSync(lockFd).isFile()) throw new Error("Missing inherited writer lock");
  // Upstream's callback bind override must not expose a public listener.
  if (mode === "--chatgpt") process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";
  const provider = providers(mode, join(dirname(path), "auth.json"), machineId, modelId || undefined);
  const files = readFd && writeFd ? new PipeFiles(Number(readFd), Number(writeFd), controlFd ? Number(controlFd) : undefined) : undefined;
  let runtime: DeckRuntime | undefined;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.stdin.destroy();
    await provider.login?.close();
    await runtime?.close();
    await files?.close();
    // Keep lockFd open until process exit, including startup/shutdown failures.
  };
  process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
  try {
    runtime = await DeckRuntime.open(path, {
      models: provider.models, model: provider.model, admissionGuard: provider.guard, validateSavedModels: true,
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
    await serveIpc(runtime, process.stdin, process.stdout, provider.login);
  } finally { await shutdown(); }
}

main().catch((error: unknown) => {
  // Do not echo provider/storage exception text: it may contain input or secrets.
  process.stderr.write(error instanceof DeckError ? `deck runtime: ${error.message}\n` : "deck runtime: startup or IPC failed\n");
  process.exitCode = 1;
});
