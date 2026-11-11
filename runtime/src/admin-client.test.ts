import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";

async function until(check: () => boolean) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Admin client condition timed out"); }
for (const mode of ["false", "truthy", "extra", "lost"] as const) test(`plain stop ${mode} ACK: no success display, saved request or automatic retry; explicit stop remains available`, { timeout: 10_000 }, async () => {
  const local = await clientEnv(); const stops: unknown[] = []; let repaired = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args, hubId } = JSON.parse(Buffer.concat(chunks).toString());
    const reply = (result: unknown) => response.end(JSON.stringify({ version: 1, id, ok: true, result }));
    if (command === "status") return void reply({ hubId: "admin-hub", mainChatId: "2", chatId: "2", model: {}, tools: "offline" });
    if (command === "history") return void reply({ items: [] });
    assert.equal(command, "stop"); assert.equal(hubId, "admin-hub"); stops.push(args);
    if (!repaired && mode === "lost") return response.destroy();
    reply(repaired ? { requested: true } : mode === "false" ? { requested: false } : mode === "truthy" ? { requested: 1 } : { requested: true, drained: true, private: "PRIVATE_ACK" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port), "--task", "2"], { env: local.env }); const closed = once(client, "close"); let output = "", errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); }); client.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    await until(() => output.includes("Deck chat")); client.stdin.write("/stop\n"); await until(() => !!errors);
    assert.equal(stops.length, 1); assert.doesNotMatch(output, /Stop requested/); assert.doesNotMatch(errors, /draft retained|PRIVATE_ACK/);
    if (mode !== "lost") assert.match(errors, /Invalid acknowledgement; request outcome unconfirmed/);
    client.stdin.write("/retry\n"); await until(() => errors.includes("No unacknowledged input to retry")); assert.equal(stops.length, 1);
    assert.deepEqual(await new DraftStore("admin-hub", local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
    repaired = true; client.stdin.end("/stop\n/exit\n"); assert.equal((await closed)[0], 0, errors);
    assert.deepEqual(stops, [{ chatId: "2" }, { chatId: "2" }]); assert.equal((output.match(/Stop requested for selected work/g) ?? []).length, 1);
    assert.match(output, /effects are still draining/); assert.doesNotMatch(output, /PRIVATE_ACK/);
  } finally { if (client.exitCode === null && client.signalCode === null) client.kill("SIGKILL"); await closed; server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close(); }
});

test("acknowledged stop leaves an existing unacknowledged input draft intact and never resubmits it", { timeout: 10_000 }, async () => {
  const local = await clientEnv(); const store = new DraftStore("admin-hub", local.env.DECK_CLIENT_STATE_DIRECTORY); const requestId = randomUUID();
  await store.save({ kind: "input", chatId: "2", requestId, text: "UNACKNOWLEDGED_INPUT", mode: "steer" }); const before = await store.load(requestId); let stops = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString()); let result: unknown;
    if (command === "status") result = { hubId: "admin-hub", mainChatId: "2", chatId: "2", model: {}, tools: "offline" };
    else if (command === "history") result = { items: [] };
    else { assert.equal(command, "stop"); assert.deepEqual(args, { chatId: "2" }); stops++; result = { requested: true }; }
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port), "--task", "2"], { env: local.env }); const closed = once(client, "close"); let output = "", errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); }); client.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    client.stdin.end("/stop\n/exit\n"); assert.equal((await closed)[0], 0, errors); assert.equal(stops, 1);
    assert.match(output, /Stop requested/); assert.match(errors, /Detached with an unresolved draft/);
    assert.deepEqual(await store.load(requestId), before); assert.equal((await store.list()).length, 1);
    assert.doesNotMatch(output + errors, /UNACKNOWLEDGED_INPUT/);
  } finally { if (client.exitCode === null && client.signalCode === null) client.kill("SIGKILL"); await closed; server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close(); }
});
