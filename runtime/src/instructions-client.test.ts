import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DeckRuntime } from "./deck.js";
import { DraftStore } from "./drafts.js";
import { clientEnv } from "./client.test.env.js";
import { CHANGED, IMPLEMENTATION, model, ORIGINAL, provider } from "./instructions.test.support.js";
const entry = fileURLToPath(new URL("./client.js", import.meta.url));
async function until(check: () => boolean) { for (let i = 0; i < 700; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Instruction client timed out"); }
function launch(port: number, env: NodeJS.ProcessEnv, chatId = "1") {
  const child = spawn(process.execPath, [entry, "--port", String(port), "--task", chatId], { env }); const closed = once(child, "close"); let output = ""; let errors = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); }); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  return { child, closed, output: () => output, errors: () => errors };
}
async function listen(server: ReturnType<typeof createServer>) { server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port; }
async function stop(client: ReturnType<typeof launch>) { if (client.child.exitCode === null && client.child.signalCode === null) { client.child.kill("SIGKILL"); await client.closed; } }

test("SIGKILL after real Pi application/lost ACK: frozen import draft survives port/default changes and retries the same task without rereading", { timeout: 15_000 }, async () => {
  const local = await clientEnv(); const directory = await mkdtemp(join(tmpdir(), "deck-import-client-")); const { models, faux } = provider(); let reads = 0; let bytes = ORIGINAL;
  const binding = { machineId: "original-worker", cwd: directory };
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), { models, model, implementation: IMPLEMENTATION, binding, environment: () => { throw new Error("No fallback"); }, hostFiles: { call: async () => { reads++; return { ok: true, output: bytes }; } } });
  // Exercise import recovery in the writable hub chat. Direct task clients are
  // now read-only unless their allocation-bound Rex startup has succeeded.
  const target = runtime.main; const chatId = String(target.id); const store = new DraftStore(runtime.hubId, local.env.DECK_CLIENT_STATE_DIRECTORY);
  let advertised = binding; let committed = false; let taskId = ""; const imports: Record<string, unknown>[] = []; const clients: ReturnType<typeof launch>[] = [];
  const server = createServer(async (request, response) => {
    let id: string | undefined;
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks).toString()); id = value.id; const { command, args } = value; let result: unknown;
      if (command === "status") result = { hubId: runtime.hubId, chatId: args.chatId ?? chatId, mainChatId: String(runtime.main.id), model: {}, tools: "native-files + bash", binding: advertised };
      else if (command === "history") result = { items: [], instructions: await runtime.instructionsStatus(String(args.chatId)) };
      else if (command === "instruction_status") result = await runtime.instructionsStatus(String(args.chatId), args.taskId);
      else {
        assert.equal(command, "import_instructions"); imports.push(args);
        const saved = (await store.load(args.requestId)).request;
        assert.equal(saved.kind, "instructions"); assert.equal(saved.chatId, chatId);
        assert.equal((saved as { machineId: string }).machineId, binding.machineId);
        const task = await runtime.importInstructions(args.chatId, args.requestId, undefined, { machineId: args.machineId, cwd: args.cwd }); taskId = String(task);
        await runtime.harness.waitForTask(task, context); committed = true;
        if (imports.length === 1) return; // Real atomic application committed; client never gets its ACK.
        result = { taskId, chatId, requestId: args.requestId, admitted: true, completion: "not_waited" };
      }
      response.end(JSON.stringify({ version: 1, id, ok: true, result }));
    } catch { response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "test_failed", message: "Fixture failed" } })); }
  });
  let port = await listen(server);
  try {
    const first = launch(port, local.env, chatId); clients.push(first); await until(() => first.output().includes("Deck chat")); first.child.stdin.write("/instructions load\n");
    await until(() => committed); first.child.kill("SIGKILL"); await first.closed;
    assert.equal((await store.list()).length, 1); assert.equal(reads, 1); bytes = CHANGED;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    advertised = { machineId: "changed-default", cwd: "/changed" }; port = await listen(server);
    const second = launch(port, local.env, chatId); clients.push(second); await until(() => second.output().includes("Recovered instructions draft"));
    assert.equal(imports.length, 1); // Discovery/recovery/status polling never resubmits.
    second.child.stdin.end(`/select 1\n/retry\n/instructions ${taskId}\n/exit\n`);
    assert.equal((await second.closed)[0], 0, second.errors()); assert.match(second.errors(), /Retry or discard/);
    assert.deepEqual(imports[1], imports[0]); assert.equal(reads, 1); assert.equal(faux.state.callCount, 0);
    assert.equal((await target.agent(context)).instructions, ORIGINAL); assert.deepEqual(await store.list(), []);
    assert.match(second.output(), /Instruction import admitted: task/); assert.match(second.output(), /Application not yet confirmed/); assert.match(second.output(), /"status":"applied"/);
    assert.doesNotMatch(second.output(), /PROJECT_INSTRUCTIONS_ORIGINAL|PROJECT_INSTRUCTIONS_CHANGED/);
  } finally { for (const client of clients) await stop(client); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await runtime.close(); await rm(directory, { recursive: true, force: true }); await local.close(); }
});

for (const failure of ["malformed-ack", "cleanup"] as const) test(`import ${failure} preserves its identity; explicit discard never cancels or reloads`, { timeout: 15_000 }, async () => {
  const local = await clientEnv(); const store = new DraftStore("import-ack", local.env.DECK_CLIENT_STATE_DIRECTORY); const calls: Record<string, unknown>[] = []; const clients: ReturnType<typeof launch>[] = [];
  let repaired = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString()); let result: unknown;
    if (command === "status") result = { hubId: "import-ack", chatId: "1", mainChatId: "1", model: {}, tools: "native-files + bash", binding: { machineId: "worker", cwd: "/work" } };
    else if (command === "history") result = { items: [] };
    else if (command === "instruction_status") result = { version: 1, chatId: "1", source: null, import: { taskId: "9", state: "running" } };
    else {
      assert.equal(command, "import_instructions"); calls.push(args); assert.equal((await store.load(args.requestId)).request.kind, "instructions");
      if (failure === "cleanup" && !repaired) await chmod(local.env.DECK_CLIENT_STATE_DIRECTORY, 0o755);
      result = { chatId: "1", taskId: "9", requestId: !repaired && failure === "malformed-ack" ? "wrong" : args.requestId, admitted: true, completion: "not_waited" };
    }
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  const port = await listen(server);
  try {
    const first = launch(port, local.env); clients.push(first); await until(() => first.output().includes("Deck chat")); first.child.stdin.write("/instructions load\n");
    await until(() => first.errors().includes("draft retained")); await chmod(local.env.DECK_CLIENT_STATE_DIRECTORY, 0o700);
    const saved = await store.list(); assert.equal(saved.length, 1);
    assert.doesNotMatch(first.output(), /Instruction import admitted/);
    first.child.stdin.end("/exit\n"); await first.closed;
    repaired = true;
    const second = launch(port, local.env); clients.push(second); await until(() => second.output().includes("Recovered instructions"));
    second.child.stdin.end("/instructions load\n/retry\n/exit\n"); assert.equal((await second.closed)[0], 0, second.errors());
    assert.deepEqual(calls[1], calls[0]); assert.deepEqual(await store.list(), []);
    assert.match(second.output(), /"state":"running"/); assert.doesNotMatch(second.output(), /"status":"applied"/);
    await store.save({ kind: "instructions", chatId: "1", requestId: saved[0]!.requestId, machineId: "worker", cwd: "/work" });
    const third = launch(port, local.env); clients.push(third); await until(() => third.output().includes("Recovered instructions"));
    third.child.stdin.end("/discard\n/instructions\n/exit\n"); await third.closed; assert.equal(calls.length, 2); assert.deepEqual(await store.list(), []);
  } finally { await chmod(local.env.DECK_CLIENT_STATE_DIRECTORY, 0o700); for (const client of clients) await stop(client); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close(); }
});

test("import save failure blocks initial send and retry; detach with a stalled ACK never sends stop", { timeout: 15_000 }, async () => {
  const local = await clientEnv(); let imports = 0; let stops = 0; const clients: ReturnType<typeof launch>[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const { id, command } = JSON.parse(Buffer.concat(chunks).toString());
    if (command === "import_instructions") { imports++; return; }
    if (command === "stop") stops++;
    response.end(JSON.stringify({ version: 1, id, ok: true, result: command === "status" ? { hubId: "save-fail", chatId: "1", mainChatId: "1", model: {}, tools: "native-files + bash", binding: { machineId: "worker", cwd: "/work" } } : { items: [] } }));
  });
  const port = await listen(server);
  try {
    const first = launch(port, local.env); clients.push(first); await until(() => first.output().includes("Deck chat")); await chmod(local.env.DECK_CLIENT_STATE_DIRECTORY, 0o755);
    first.child.stdin.write("/instructions load\n/retry\n"); await until(() => first.errors().split("must be private").length >= 3); assert.equal(imports, 0);
    await chmod(local.env.DECK_CLIENT_STATE_DIRECTORY, 0o700); first.child.stdin.write("/retry\n"); await until(() => imports === 1);
    first.child.kill("SIGINT"); await first.closed; assert.equal(stops, 0);
    const saved = await new DraftStore("save-fail", local.env.DECK_CLIENT_STATE_DIRECTORY).list(); assert.equal(saved.length, 1); assert.equal(saved[0]!.kind, "instructions");
    assert.match(first.errors(), /Detached with an unresolved draft/);
  } finally { await chmod(local.env.DECK_CLIENT_STATE_DIRECTORY, 0o700); for (const client of clients) await stop(client); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close(); }
});
