import assert from "node:assert/strict";
import { spawn as rawSpawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { clientEnv } from "./client.test.env.js";
const local = await clientEnv();
after(() => local.close());
const spawn = (command: string, args: string[]) => rawSpawn(command, args, { env: local.env });

const entry = (n: number) => ({ id: n * 3, kind: "deck.input", data: { text: `burst-${n}` } });
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 1000; i++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("Client did not reach expected state");
};

test("empty-chat catch-up drains a burst over multiple pages without gaps or duplicates across outages and frame overflow", { timeout: 20_000 }, async () => {
  const requests: { after: string; limit: number }[] = [];
  const failures = new Set(["0", "300"]);
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; args: Record<string, unknown> };
    let result: unknown;
    if (command === "status") result = { chatId: "1", mainChatId: "1", hubId: "test-catchup", model: {}, tools: "offline" };
    else {
      assert.equal(command, "history");
      if (args.after === undefined) result = { items: [] };
      else {
        const after = String(args.after); const limit = Number(args.limit); requests.push({ after, limit });
        if (failures.delete(after)) return void response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "runtime_failed", message: "Temporary outage" } }));
        if (after === "300" && limit > 50) return void response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "too_large", message: "Response exceeds IPC limit" } }));
        const remaining = Array.from({ length: 260 }, (_, i) => entry(i + 1)).filter((item) => item.id > Number(after));
        const items = remaining.slice(0, limit);
        result = { items, ...(remaining.length > items.length ? { next: String(items.at(-1)!.id) } : {}) };
      }
    }
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)]);
  const closed = once(client, "close"); let output = ""; let errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); }); client.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    await waitFor(() => output.includes("you: burst-260\n"));
    client.stdin.end("/older\n/exit\n"); assert.equal((await closed)[0], 0, errors);
    assert.deepEqual([...output.matchAll(/you: burst-(\d+)\n/g)].map((match) => Number(match[1])), Array.from({ length: 260 }, (_, i) => i + 1));
    assert.deepEqual(requests.slice(0, 5).map((request) => request.after), ["0", "0", "300", "300", "300"]);
    assert.ok(requests.some((request) => request.after === "300" && request.limit === 50));
    assert.match(output, /No older history/); assert.match(errors, /Hub unavailable/); assert.match(errors, /Hub reconnected/);
    assert.doesNotMatch(errors, /Invalid history/);
  } finally {
    if (client.exitCode === null && client.signalCode === null) client.kill(); await closed;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("SIGINT promptly cancels a stalled catch-up request without sending stop or printing late output", { timeout: 10_000 }, async () => {
  let held = false; const commands: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; args: Record<string, unknown> };
    commands.push(command);
    if (command === "history" && args.after !== undefined) { held = true; return; }
    response.end(JSON.stringify({ version: 1, id, ok: true, result: command === "status" ? { chatId: "1", mainChatId: "1", hubId: "test-catchup", model: {}, tools: "offline" } : { items: [] } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)]);
  const closed = once(client, "close"); let output = ""; let errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); }); client.stderr.on("data", (chunk) => { errors += String(chunk); });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitFor(() => held); client.kill("SIGINT");
    const result = await Promise.race([closed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Detach waited for request timeout")), 2000); })]);
    assert.equal(result[0], 0, errors); assert.ok(!commands.includes("stop")); assert.doesNotMatch(output, /you:/); assert.equal(errors, "");
  } finally {
    clearTimeout(timeout);
    if (client.exitCode === null && client.signalCode === null) client.kill(); await closed;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
