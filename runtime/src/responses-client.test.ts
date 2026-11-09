import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore, type Draft } from "./drafts.js";

async function until(check: () => boolean) { for (let i = 0; i < 700; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Response client condition timed out"); }
for (const kind of ["input", "task", "instructions"] as const) test(`${kind} drafts survive invalid response envelopes; only an explicit same-argument retry clears them`, { timeout: 30_000 }, async () => {
  const local = await clientEnv(); const store = new DraftStore("response-hub", local.env.DECK_CLIENT_STATE_DIRECTORY);
  const clients: ReturnType<typeof spawn>[] = [];
  const calls: { id: string; args: Record<string, unknown> }[] = [];
  let mode = "wrong-id";
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; args: Record<string, unknown> };
    const reply = (result: unknown) => response.end(JSON.stringify({ version: 1, id, ok: true, result }));
    if (command === "status") return void reply({ hubId: "response-hub", chatId: args.chatId ?? "1", mainChatId: "1", model: {}, tools: "native-files", binding: { machineId: "saved-worker", cwd: "/saved" } });
    if (command === "history") return void reply({ items: [] });
    if (command === "instruction_status") return void reply({ version: 1, chatId: "1", source: null, import: { taskId: "9", state: "running" } });
    assert.equal(command, kind === "input" ? "admit" : kind === "task" ? "create_task" : "import_instructions");
    // Simulate a committed effect with a damaged/lost response. Its saved identity
    // must exist on both sends, and no malformed reply may cause automatic retry.
    assert.equal((await store.load(String(args.requestId))).request.kind, kind);
    calls.push({ id, args });
    let result: Record<string, unknown> = kind === "input" ? { submissionId: "9" } : kind === "task" ? { chatId: "2" } : { taskId: "9", chatId: "1", requestId: args.requestId, admitted: true, completion: "not_waited" };
    if (calls.length % 2 === 1) {
      const field = kind === "input" ? "submissionId" : kind === "task" ? "chatId" : "taskId";
      if (mode === "numeric-ack") result = { ...result, [field]: 9 };
      if (mode === "unsafe-ack") result = { ...result, [field]: "9007199254740992" };
      if (mode === "extra-ack") result = { ...result, private: "PRIVATE_EXTRA_ACK" };
      if (mode === "wrong-import-chat") result = { ...result, chatId: "3" };
      if (mode === "wrong-import-request") result = { ...result, requestId: "other-request" };
    }
    let envelope: Record<string, unknown> = { version: 1, id, ok: true, result };
    if (calls.length % 2 === 1) {
      if (mode === "wrong-id") envelope.id = "different-transport-id";
      if (mode === "missing-version") delete envelope.version;
      if (mode === "missing-id") delete envelope.id;
      if (mode === "truthy-ok") envelope.ok = "true";
      if (mode === "mixed-payloads") envelope.error = { code: "invalid", message: "PRIVATE_MIXED_PAYLOAD" };
      if (mode === "missing-result") delete envelope.result;
      if (mode === "malformed-error") envelope = { version: 1, id, ok: false, error: { message: "PRIVATE_MALFORMED_ERROR" } };
    }
    response.end(JSON.stringify(envelope));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    for (mode of ["wrong-id", "missing-version", "missing-id", "truthy-ok", "mixed-payloads", "missing-result", "malformed-error", "numeric-ack", "unsafe-ack", "extra-ack", ...(kind === "instructions" ? ["wrong-import-chat", "wrong-import-request"] : [])]) {
      const before = calls.length;
      const client: ReturnType<typeof spawn> = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)], { env: local.env }); clients.push(client);
      const closed: Promise<unknown[]> = once(client, "close"); let output = "", errors = "";
      client.stdout!.on("data", (chunk) => { output += String(chunk); }); client.stderr!.on("data", (chunk) => { errors += String(chunk); });
      await until(() => output.includes("Deck chat"));
      client.stdin!.write(kind === "input" ? "Original input\n" : kind === "task" ? "/task Original task\n" : "/instructions load\n");
      await until(() => errors.includes("draft retained"));
      assert.equal(calls.length, before + 1); assert.equal((await store.list()).length, 1);
      assert.match(errors, /not acknowledged|Invalid acknowledgement/); assert.doesNotMatch(errors, /PRIVATE/);
      assert.doesNotMatch(output, /Selected chat 2|Instruction import admitted/);
      client.stdin!.end("/retry\n/exit\n"); assert.equal((await closed)[0], 0, errors);
      assert.equal(calls.length, before + 2); assert.deepEqual(calls[before]!.args, calls[before + 1]!.args);
      // A fresh transport ID is not a new durable mutation identity.
      assert.notEqual(calls[before]!.id, calls[before + 1]!.id); assert.deepEqual(await store.list(), []);
    }
  } finally {
    for (const client of clients) if (client.exitCode === null && client.signalCode === null) { const closed = once(client, "close"); client.kill("SIGKILL"); await closed; }
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close();
  }
});

for (const kind of ["input", "task", "instructions"] as const) test(`${kind} legacy draft failing new wire validation stays byte-identical and is never sent or silently repaired`, { timeout: 10_000 }, async () => {
  const local = await clientEnv(); const store = new DraftStore("legacy-wire-hub", local.env.DECK_CLIENT_STATE_DIRECTORY);
  const requestId = randomUUID(), base = { chatId: "1", requestId };
  // The existing local draft format accepted lone surrogate escapes. Do not
  // migrate/normalize its bytes into a different request under the same ID.
  const draft: Draft = kind === "input" ? { ...base, kind, text: "\ud800", mode: "steer" } : kind === "task" ? { ...base, kind, title: "\ud800", machineId: "saved-host", cwd: "/saved" } : { ...base, kind, machineId: "\ud800", cwd: "/saved" };
  await store.save(draft);
  const before = await store.load(requestId), path = join(store.directory, `${requestId}.json`), bytes = await readFile(path); let mutations = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command } = JSON.parse(Buffer.concat(chunks).toString());
    if (!["status", "history"].includes(command)) mutations++;
    response.end(JSON.stringify({ version: 1, id, ok: true, result: command === "status" ? { hubId: "legacy-wire-hub", chatId: "1", mainChatId: "1", model: {}, tools: "native-files", binding: { machineId: "saved-host", cwd: "/saved" } } : { items: [] } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)], { env: local.env }); const closed = once(client, "close"); let errors = "";
  client.stdout.resume(); client.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    client.stdin.end("/retry\n/exit\n"); assert.equal((await closed)[0], 0, errors);
    assert.match(errors, /Invalid mutation arguments; no request sent/); assert.equal(mutations, 0);
    assert.deepEqual(await store.load(requestId), before); assert.deepEqual(await readFile(path), bytes); assert.equal((await store.list()).length, 1);
  } finally { if (client.exitCode === null && client.signalCode === null) client.kill("SIGKILL"); await closed; server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close(); }
});
