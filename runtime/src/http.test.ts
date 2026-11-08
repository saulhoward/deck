import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const binary = process.env.DECK_TEST_BINARY;
test("loopback hub and plain detached client: admission, security checks, task isolation", { skip: !binary, timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-http-"));
  const env = { ...process.env, DECK_CLIENT_STATE_DIRECTORY: join(directory, "client") };
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0);
  const hub = spawn(binary!, ["serve", "--mock", "--port", String(port), "--directory", directory, "--workspace", directory, "--runtime", resolve("runtime/dist/main.js")]);
  const url = `http://127.0.0.1:${port}/v1/command`;
  const raw = (body: string, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(3000) });
  const command = async (name: string, args = {}) => {
    const response = await raw(JSON.stringify({ version: 1, id: "test", command: name, args }));
    assert.equal(response.status, 200);
    const envelope = await response.json() as { ok: boolean; result: Record<string, unknown> };
    assert.equal(envelope.ok, true); return envelope.result;
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await command("status"); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
    }
    assert.ok(ready);
    assert.equal((await raw("not json")).status, 400);
    assert.equal((await raw('{"version":2}')).status, 400);
    // The public Zig guard and private TS guard consume the same schema.
    for (const envelope of [{ version: 1, id: "id" }, { version: 1, id: "id", command: [] }, { version: 1, id: "🤖".repeat(201), command: "status" }, { version: 1, id: null, command: "status" }]) {
      assert.equal((await raw(JSON.stringify(envelope))).status, 400);
    }
    const unicode = await raw(JSON.stringify({ version: 1, id: "🤖".repeat(200), command: "status", extension: true }));
    assert.equal(unicode.status, 200);
    const echoed = await unicode.json() as { ok: boolean; id: string };
    assert.equal(echoed.ok, true); assert.equal(echoed.id, "🤖".repeat(200));
    // Envelope validation does not replace command/hub authority checks.
    const invalidArgs = await (await raw(JSON.stringify({ version: 1, id: "args", command: "status", args: 42 }))).json() as { ok: boolean; error: { code: string } };
    assert.equal(invalidArgs.ok, false); assert.equal(invalidArgs.error.code, "invalid");
    assert.equal((await raw("{}", { origin: "https://evil.example" })).status, 403);
    const badHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers: { host: "evil.example", "content-length": "2" } }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.on("error", reject); request.end("{}");
    });
    assert.equal(badHost, 403);
    const status = await command("status");
    const idle = await command("activity", { chatId: status.mainChatId });
    assert.equal(idle.chatId, status.mainChatId); assert.equal(idle.busy, false); assert.deepEqual(idle.tools, []);
    const client = spawn(binary!, ["agent", "--no-tui", "--port", String(port), "--message", "Hello from client"], { env });
    let output = ""; client.stdout.on("data", (chunk) => { output += String(chunk); });
    const [code] = await once(client, "close"); assert.equal(code, 0); assert.match(output, /submissionId/);
    let history = "";
    for (let i = 0; i < 100; i++) {
      history = JSON.stringify(await command("history", { chatId: status.mainChatId }));
      if (history.includes("no inference performed")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(history, /Hello from client/); assert.match(history, /no inference performed/);
    const newest = await command("history", { chatId: status.mainChatId, limit: 1, includeActivity: true, includeProgress: true });
    assert.equal((newest.progress as Record<string, unknown>).provisional, true);
    const progress = await command("progress", { chatId: status.mainChatId });
    assert.equal(progress.chatId, status.mainChatId); assert.equal(progress.version, 1); assert.equal(progress.provisional, true);
    assert.equal((newest.activity as Record<string, unknown>).chatId, status.mainChatId);
    assert.equal((newest.items as unknown[]).length, 1); assert.equal(typeof newest.next, "string");
    const previous = await command("history", { chatId: status.mainChatId, limit: 1, before: newest.next });
    assert.equal((previous.items as unknown[]).length, 1);
    assert.ok(Number((previous.items as Record<string, unknown>[])[0]!.id) < Number(newest.next));
    const complete = await command("history", { chatId: status.mainChatId });
    const forward = [];
    let after = "0";
    for (;;) {
      const page = await command("history", { chatId: status.mainChatId, after, limit: 1 });
      forward.push(...(page.items as Record<string, unknown>[]).map((entry) => entry.id));
      if (!page.next) break;
      after = String(page.next);
    }
    assert.deepEqual(forward, (complete.items as Record<string, unknown>[]).map((entry) => entry.id).reverse());
    for (const args of [{ limit: 0 }, { limit: "2" }, { before: "oops" }, { before: 1 }, { after: "-1" }, { after: 0 }, { before: "1", after: "0" }, { includeActivity: "true" }, { includeProgress: "true" }, { includeInstructions: "true" }]) {
      const result = await (await raw(JSON.stringify({ version: 1, id: "bad-history", command: "history", args: { chatId: status.mainChatId, ...args } }))).json() as { ok: boolean; error: { code: string } };
      assert.equal(result.ok, false); assert.equal(result.error.code, "invalid");
    }
    const interactive = spawnSync(binary!, ["agent", "--no-tui", "--port", String(port)], { env, input: "/older\n/activity\n/status\n/exit\n", encoding: "utf8", timeout: 5000 });
    assert.equal(interactive.status, 0);
    assert.match(interactive.stdout, /you: Hello from client/);
    assert.match(interactive.stdout, /assistant: Deck prototype response/);
    assert.match(interactive.stdout, /No older history/);
    const binding = status.binding as Record<string, unknown>;
    const taskArgs = { requestId: "task-create", title: "Separate task", machineId: binding.machineId, cwd: binding.cwd };
    const task = await command("create_task", taskArgs);
    assert.equal((await command("create_task", taskArgs)).chatId, task.chatId);
    await command("admit", { chatId: task.chatId, requestId: "task-request", mode: "followUp", text: "Task-only message" });
    const listed = await command("list_chats", { limit: 1 });
    assert.equal((listed.items as Record<string, unknown>[])[0]!.chatId, status.mainChatId);
    const next = await command("list_chats", { limit: 1, after: listed.next });
    assert.equal((next.items as Record<string, unknown>[])[0]!.title, "Separate task");
    for (const args of [{ limit: 0 }, { limit: "2" }, { after: "oops" }, { after: 1 }]) {
      const result = await (await raw(JSON.stringify({ version: 1, id: "bad-list", command: "list_chats", args }))).json() as { ok: boolean; error: { code: string } };
      assert.equal(result.ok, false); assert.equal(result.error.code, "invalid");
    }
    const switched = spawnSync(binary!, ["agent", "--no-tui", "--port", String(port)], {
      env, input: `/tasks\n/select ${task.chatId}\nTask selected input\n/main\nMain selected input\n/select 999999999\n/status\n/exit\n`, encoding: "utf8", timeout: 5000,
    });
    assert.equal(switched.status, 0, switched.stderr);
    assert.match(switched.stdout, /Separate task/);
    assert.match(switched.stdout, /you: Task-only message/);
    assert.match(switched.stderr, /Unknown conversation/);
    assert.match(switched.stdout, new RegExp(`Selected chat ${task.chatId}`));
    assert.match(switched.stdout, new RegExp(`Selected chat ${status.mainChatId}`));
    const main = JSON.stringify(await command("history", { chatId: status.mainChatId }));
    const taskHistory = JSON.stringify(await command("history", { chatId: task.chatId }));
    assert.doesNotMatch(main, /Task-only message|Task selected input/);
    assert.match(main, /Main selected input/); assert.match(taskHistory, /Task selected input/);
    assert.doesNotMatch(taskHistory, /Main selected input/);
    // Public client -> real HTTP/IPC -> Pi admin task -> Zig read, with no inference.
    await writeFile(join(directory, "AGENTS.md"), "NATIVE_IMPORTED_INSTRUCTIONS");
    const importedChat = await command("create_task", { ...taskArgs, requestId: "import-target", title: "Import target" });
    const importing = spawnSync(binary!, ["agent", "--no-tui", "--port", String(port), "--task", String(importedChat.chatId)], { env, input: "/instructions\n/instructions load\n/instructions\n/exit\n", encoding: "utf8", timeout: 5000 });
    assert.equal(importing.status, 0, importing.stderr); assert.match(importing.stdout, /Application not yet confirmed/); assert.doesNotMatch(importing.stdout, /NATIVE_IMPORTED_INSTRUCTIONS/);
    const importId = /Instruction import admitted: task ([1-9]\d*)\./.exec(importing.stdout)?.[1]; assert.ok(importId);
    let imported: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      imported = await command("instruction_status", { chatId: importedChat.chatId, taskId: importId });
      if ((imported.import as Record<string, unknown>).state === "terminal") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(((imported.import as Record<string, unknown>).result as Record<string, unknown>).status, "applied");
    assert.equal((await command("history", { chatId: importedChat.chatId })).items instanceof Array, true);
    assert.equal(((await command("history", { chatId: importedChat.chatId })).items as unknown[]).length, 0);
    const operations = await readdir(join(directory, "worker", "operations"));
    await writeFile(join(directory, "AGENTS.md"), "CHANGED_NOT_RELOADED");
    assert.deepEqual(await command("instruction_status", { chatId: importedChat.chatId }), imported);
    assert.deepEqual(await readdir(join(directory, "worker", "operations")), operations);
  } finally {
    const closed = once(hub, "close"); hub.kill("SIGTERM"); await closed;
    // The runtime closes on EOF from the supervisor; wait for its inherited pipes to close.
    await rm(directory, { recursive: true, force: true });
  }
});
