import assert from "node:assert/strict";
import { spawn as rawSpawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { clientEnv } from "./client.test.env.js";
const local = await clientEnv();
after(() => local.close());
const spawn = (command: string, args: string[]) => rawSpawn(command, args, { env: local.env });

test("older history retries preserve cursors, polling stays independent and selection discards stale history", { timeout: 20_000 }, async () => {
  const older: string[] = [];
  let mainPolls = 0;
  let holdNextPoll = false;
  let held: ServerResponse | undefined;
  const entry = (id: number, text: string) => ({ id, kind: "deck.input", data: { text } });
  const ids = new WeakMap<ServerResponse, string>();
  const send = (response: ServerResponse, result: unknown) => response.end(JSON.stringify({ version: 1, id: ids.get(response), ok: true, result }));
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; args: Record<string, unknown> };
    ids.set(response, id);
    response.setHeader("content-type", "application/json");
    if (command === "status") return void send(response, { chatId: args.chatId ?? "1", mainChatId: "1", hubId: "test-history", model: {}, tools: "offline" });
    assert.equal(command, "history");
    if (args.before) {
      older.push(String(args.before));
      if (older.length === 1) return void response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "runtime_failed", message: "Temporary history error" } }));
      const pages: Record<string, unknown> = {
        "101": { items: [entry(100, "older100"), entry(99, "older99\u001b[31m")], next: "99" },
        "99": { items: [entry(98, "oldest98")] },
        "203": { items: [entry(202, "task older")] },
        "103": { items: [entry(102, "reselected older")] },
      };
      assert.ok(pages[String(args.before)], `Unexpected cursor ${args.before}`);
      return void send(response, pages[String(args.before)]);
    }
    if (args.chatId === "2") return void send(response, args.after === undefined ? { items: [entry(203, "task recent")], next: "203" } : { items: [] });
    mainPolls++;
    if (holdNextPoll) { holdNextPoll = false; held = response; return; }
    if (args.after !== undefined) return void send(response, { items: Number(args.after) < 104 ? [entry(104, "new104")] : [] });
    send(response, mainPolls === 1 ? { items: [entry(103, "recent103"), entry(102, "recent102"), entry(101, "recent101")], next: "101" } : { items: [entry(104, "new104"), entry(103, "recent103")], next: "103" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)]);
  const closed = once(client, "close");
  let output = ""; let errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); });
  client.stderr.on("data", (chunk) => { errors += String(chunk); });
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Client did not reach expected state: ${output}\n${errors}`);
  };
  try {
    await waitFor(() => output.includes("Older retained history"));
    client.stdin.write("/older\n"); await waitFor(() => errors.includes("Temporary history error"));
    client.stdin.write("/older\n"); await waitFor(() => output.includes("More retained history"));
    await waitFor(() => output.includes("new104"));
    client.stdin.write("/older\n/older\n"); await waitFor(() => output.includes("No older history"));
    assert.equal((output.match(/you: recent103/g) ?? []).length, 1);
    assert.equal((output.match(/you: older100/g) ?? []).length, 1);
    assert.ok(output.indexOf("you: older99") < output.indexOf("you: older100"));
    holdNextPoll = true; await waitFor(() => held !== undefined);
    client.stdin.write("/select 2\n/older\n/main\n/older\n/exit\n");
    await waitFor(() => output.includes("Selected chat 2"));
    send(held!, { items: [entry(999, "STALE POLL MUST NOT DISPLAY")], next: "999" }); held = undefined;
    assert.equal((await closed)[0], 0, errors);
    assert.deepEqual(older, ["101", "101", "99", "203", "103"]);
    assert.doesNotMatch(output, /STALE POLL|\x1b/);
    assert.match(output, /task older/); assert.match(output, /reselected older/);
  } finally {
    if (held) send(held, { items: [] });
    if (client.exitCode === null && client.signalCode === null) client.kill();
    await closed;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("plain history reduces page size on frame overflow without advancing its cursor", { timeout: 10_000 }, async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; args: Record<string, unknown> };
    let result: unknown;
    if (command === "status") result = { chatId: "1", mainChatId: "1", hubId: "test-history", model: {}, tools: "offline" };
    else {
      assert.equal(command, "history"); requests.push(args);
      if (args.limit !== 1) return void response.end(JSON.stringify({ version: 1, id, ok: false, error: { code: "too_large", message: "Response exceeds IPC limit" } }));
      if (args.after !== undefined) return void response.end(JSON.stringify({ version: 1, id, ok: true, result: { items: [] } }));
      result = { items: [{ id: args.before ? 1 : 2, kind: "deck.input", data: { text: args.before ? "old small page" : "recent small page" } }], ...(args.before ? {} : { next: "2" }) };
    }
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)]);
  const closed = once(client, "close");
  let output = ""; let errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); });
  client.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    client.stdin.end("/older\n/older\n/exit\n");
    assert.equal((await closed)[0], 0, errors);
    assert.deepEqual(requests.filter((args) => !args.before).map((args) => args.limit).slice(0, 7), [100, 50, 25, 12, 6, 3, 1]);
    assert.deepEqual(requests.filter((args) => args.before).map((args) => [args.before, args.limit]), [100, 50, 25, 12, 6, 3, 1].map((limit) => ["2", limit]));
    assert.match(output, /recent small page/); assert.match(output, /old small page/); assert.match(output, /No older history/);
    assert.equal(errors, "");
  } finally {
    if (client.exitCode === null && client.signalCode === null) client.kill(); await closed;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
