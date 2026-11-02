import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DraftStore } from "./drafts.js";
import { clientEnv } from "./client.test.env.js";
const entry = fileURLToPath(new URL("./client.js", import.meta.url));
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Client condition timed out");
}

for (const kind of ["input", "task"] as const) test(`SIGKILL recovery preserves ${kind} identity and original arguments across port/binding changes`, { timeout: 15_000 }, async (t) => {
  const local = await clientEnv(); const store = new DraftStore("durable-hub", local.env.DECK_CLIENT_STATE_DIRECTORY);
  const calls: Record<string, unknown>[] = []; const effects = new Set<string>();
  let binding = { machineId: "offline-original", cwd: "/original" };
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { command, args } = JSON.parse(Buffer.concat(chunks).toString()) as { command: string; args: Record<string, unknown> };
    let result: unknown = {};
    if (command === "status") result = { hubId: "durable-hub", chatId: args.chatId ?? "1", mainChatId: "1", model: {}, tools: "offline", binding };
    else if (command === "history") result = { items: [] };
    else {
      assert.equal(command, kind === "input" ? "admit" : "create_task");
      calls.push(args); effects.add(String(args.requestId));
      // This must already exist before even the first network request.
      const saved = (await store.load(String(args.requestId))).request;
      assert.equal(saved.chatId, "2"); assert.equal(saved.kind, kind);
      if (calls.length === 1) return; // Commit happened; acknowledgement is lost.
      result = kind === "input" ? { submissionId: "10" } : { chatId: "3" };
    }
    response.end(JSON.stringify({ ok: true, result }));
  });
  const listen = async () => { server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port; };
  let port = await listen();
  const clients: ReturnType<typeof spawn>[] = [];
  const launch = () => {
    const child = spawn(process.execPath, [entry, "--port", String(port), "--task", "2"], { env: local.env }); clients.push(child);
    const closed = once(child, "close"); let output = ""; let errors = "";
    child.stdout!.on("data", (chunk) => { output += String(chunk); }); child.stderr!.on("data", (chunk) => { errors += String(chunk); });
    return { child, closed, output: () => output, errors: () => errors };
  };
  t.after(async () => { for (const child of clients) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; } server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close(); });
  const first = launch(); await waitFor(() => first.output().includes("Deck chat"));
  first.child.stdin!.write(kind === "input" ? "Original input\n" : "/task Original task\n");
  await waitFor(() => calls.length === 1); first.child.kill("SIGKILL"); await first.closed;
  assert.equal((await store.list()).length, 1);
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  binding = { machineId: "changed-host", cwd: "/changed" }; port = await listen();
  const second = launch(); await waitFor(() => second.output().includes("Recovered"));
  assert.equal(calls.length, 1); // Recovery alone never resends.
  second.child.stdin!.end("/select 1\n/retry\n/exit\n");
  assert.equal((await second.closed)[0], 0, second.errors());
  assert.match(second.errors(), /Retry or discard/);
  assert.deepEqual(calls[1], calls[0]); assert.equal(effects.size, 1);
  if (kind === "task") { assert.equal(calls[1]!.machineId, "offline-original"); assert.equal(calls[1]!.cwd, "/original"); }
  assert.deepEqual(await store.list(), []);
});

test("one-shot malformed ACK remains recoverable; new one-shot text cannot replace it; discard never sends", { timeout: 10_000 }, async () => {
  const local = await clientEnv(); const store = new DraftStore("ack-hub", local.env.DECK_CLIENT_STATE_DIRECTORY); let admitted = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { command } = JSON.parse(Buffer.concat(chunks).toString()) as { command: string };
    if (command === "admit") admitted++;
    response.end(JSON.stringify({ ok: true, result: command === "status" ? { hubId: "ack-hub", mainChatId: "1", chatId: "1", model: {}, tools: "offline" } : command === "history" ? { items: [] } : {} }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const run = async (args: string[], input?: string) => {
    const child = spawn(process.execPath, [entry, "--port", String(address.port), ...args], { env: local.env }); const closed = once(child, "close");
    let errors = ""; child.stdout.resume(); child.stderr.on("data", (chunk) => { errors += String(chunk); }); child.stdin.end(input);
    return { code: (await closed)[0], errors };
  };
  try {
    assert.equal((await run(["--message", "Original"])).code, 1); assert.equal(admitted, 1);
    const saved = await store.list(); assert.equal(saved.length, 1);
    assert.equal((await run(["--message", "Replacement"])).code, 1); assert.equal(admitted, 1);
    assert.equal((await run([], "/discard\n/exit\n")).code, 0); assert.equal(admitted, 1); assert.deepEqual(await store.list(), []);
    // Failure to save must prevent any admission, including an interactive /retry.
    const child = spawn(process.execPath, [entry, "--port", String(address.port)], { env: local.env }); const closed = once(child, "close"); let output = ""; let errors = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); }); child.stderr.on("data", (chunk) => { errors += String(chunk); });
    await waitFor(() => output.includes("Deck chat")); await chmod(local.env.DECK_CLIENT_STATE_DIRECTORY, 0o755);
    child.stdin.end("Must not send\n/retry\n/exit\n"); assert.equal((await closed)[0], 0); assert.match(errors, /must be private/); assert.equal(admitted, 1);
    await chmod(local.env.DECK_CLIENT_STATE_DIRECTORY, 0o700); assert.deepEqual(await store.list(), []);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close(); }
});
