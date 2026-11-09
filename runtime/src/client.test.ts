import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";

test("plain chat switching pins retries, blocks switching unacknowledged drafts and pages discovery", { timeout: 10_000 }, async () => {
  const admissions: Record<string, unknown>[] = [];
  const creations: Record<string, unknown>[] = [];
  const pages: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const envelope = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; args: Record<string, unknown> };
    const args = envelope.args;
    let result: unknown = {};
    let failed = false;
    switch (envelope.command) {
      case "status": result = { chatId: args.chatId ?? "1", mainChatId: "1", hubId: "test-client", provider: "faux", model: {}, tools: "offline", binding: { machineId: "host", cwd: "/work" } }; break;
      case "history": result = { items: [] }; break;
      case "list_chats": {
        pages.push(args);
        result = args.after ? { items: [{ chatId: "2", kind: "task", title: "Saved task\u001b[31m", machineId: "offline", cwd: "/task" }] } : { items: [{ chatId: "1", kind: "main", title: "Main", machineId: "host", cwd: "/work" }], next: "1" };
        break;
      }
      case "admit": admissions.push(args); failed = admissions.length === 1; result = { submissionId: "1" }; break;
      case "create_task": creations.push(args); failed = creations.length === 1; result = { chatId: "2" }; break;
      default: assert.fail(`Unexpected command ${envelope.command}`);
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ version: 1, id: envelope.id, ...(failed ? { ok: false, error: { code: "runtime_failed", message: "Simulated lost acknowledgement" } } : { ok: true, result }) }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const local = await clientEnv();
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--no-tui", "--port", String(address.port)], { env: local.env });
  let output = ""; let errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); });
  client.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    const closed = once(client, "close");
    client.stdin.end("First input\n/select 2\n/main\n/tasks\n/tasks more\n/tasks more\n/retry\n/select 2\nTask input\n/main\nMain input\n/task New task\n/select 1\n/main\n/retry\n/main\n/exit\n");
    assert.equal((await closed)[0], 0, errors);
    assert.deepEqual(admissions.map((args) => args.chatId), ["1", "1", "2", "1"]);
    assert.deepEqual(admissions[0], admissions[1]);
    assert.deepEqual(creations[0], creations[1]);
    assert.equal(creations.length, 2);
    assert.equal(creations[0]!.cwd, "/work");
    assert.deepEqual(pages, [{ limit: 25 }, { limit: 25, after: "1" }]);
    assert.equal((errors.match(/Retry or discard/g) ?? []).length, 4);
    assert.match(output, /Saved task/); assert.doesNotMatch(output, /\x1b/);
    assert.match(output, /No more chats/); assert.match(output, /Selected chat 2/);
  } finally {
    if (client.exitCode === null && client.signalCode === null) client.kill();
    await local.close();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
