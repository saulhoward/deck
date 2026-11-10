import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { tailUnits } from "./view-text.js";
function preview(chatId: string, text: string, attempt = 1) {
  return { version: 1, chatId, provisional: true, runTaskId: "42", generation: { text: tailUnits(text, 2048), attempt, phase: "generating", ...(text.length > 2048 ? { textClipped: true } : {}) }, tools: [{ taskId: "43", name: "bash", text: text.startsWith("STALE_") ? "STALE_SELECTION_BASH" : chatId === "2" ? "BASH_SECOND" : "BASH_ACTIVE\x1b[31m" }] };
}
async function waitFor(condition: () => boolean) {
  for (let index = 0; index < 600; index++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("Expected client progress not observed");
}

test("plain previews are bounded/sanitized snapshots; outages, replacements and stale selection cannot suppress final history", { timeout: 20_000 }, async () => {
  let text = "FIRST_PARTIAL\x1b[31m"; let attempt = 1; let polls = 0; let failed = false; let failNext = false; let settled = false; let stopCalls = 0;
  let holdOld = false; let releaseOld: (() => void) | undefined;
  const final = "FINAL_CANONICAL_" + "f".repeat(5000) + "_END";
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; args: Record<string, unknown> };
    if (command === "stop") stopCalls++;
    const reply = (result: unknown) => response.end(JSON.stringify({ version: 1, id, ok: true, result }));
    if (command === "status") { reply({ chatId: args.chatId ?? "1", mainChatId: "1", hubId: "progress-client", model: {}, tools: "offline" }); return; }
    assert.equal(command, "history"); assert.equal(args.includeProgress, true); assert.equal(args.includeInstructions, true); polls++;
    if (failNext) { failNext = false; failed = true; response.writeHead(503); response.end(); return; }
    const chatId = String(args.chatId);
    if (holdOld && chatId === "1") {
      holdOld = false;
      releaseOld = () => reply({ items: [], progress: preview("1", "STALE_SELECTION_MUST_NOT_PRINT"), instructions: { version: 1, chatId: "1", source: { machineId: "STALE_SELECTION_INSTRUCTION_SOURCE", cwd: "/old", path: "AGENTS.md", sha256: "a".repeat(64), bytes: 1, taskId: "9" }, import: null } }); return;
    }
    reply({
      items: chatId === "1" && settled && args.after === "0" ? [{ id: 1, kind: "pi.assistant", model: [{ content: [{ type: "text", text: final }] }] }] : [],
      progress: chatId === "2" ? preview("2", "SECOND_CHAT") : settled ? { version: 1, chatId, provisional: true } : preview(chatId, text, attempt),
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const local = await clientEnv();
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)], { env: local.env });
  const closed = once(client, "close"); let output = ""; let errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); }); client.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    await waitFor(() => polls >= 3); assert.equal((output.match(/FIRST_PARTIAL/g) ?? []).length, 1);
    assert.equal((output.match(/BASH_ACTIVE/g) ?? []).length, 1); assert.match(output, /bash output preview \(provisional snapshot\)/);
    failNext = true; await waitFor(() => failed && errors.includes("Hub unavailable")); await waitFor(() => errors.includes("Hub reconnected"));
    assert.equal((output.match(/FIRST_PARTIAL/g) ?? []).length, 1);
    text = "REPLACED_PREVIEW"; await waitFor(() => output.includes("REPLACED_PREVIEW"));
    attempt = 2; await waitFor(() => output.includes('"attempt":2')); assert.equal((output.match(/REPLACED_PREVIEW/g) ?? []).length, 2);
    text = "HEAD_MUST_CLIP" + "x".repeat(10_000) + "TAIL_PREVIEW";
    await waitFor(() => output.includes("TAIL_PREVIEW")); assert.match(output, /"textClipped":true/); assert.doesNotMatch(output, /HEAD_MUST_CLIP/);
    settled = true; await waitFor(() => output.includes(final) && output.includes("bash output preview cleared"));
    assert.equal((output.match(/BASH_ACTIVE/g) ?? []).length, 1);
    const before = polls; await waitFor(() => polls >= before + 2); assert.equal((output.match(/FINAL_CANONICAL_/g) ?? []).length, 1);
    holdOld = true; await waitFor(() => !!releaseOld);
    client.stdin.write("/select 2\n"); await waitFor(() => output.includes("Selected chat 2"));
    const sendOld = releaseOld!; releaseOld = undefined; sendOld(); await waitFor(() => output.includes("SECOND_CHAT") && output.includes("BASH_SECOND"));
    client.stdin.end("/exit\n"); assert.equal((await closed)[0], 0, errors);
    assert.doesNotMatch(output, /PRIVATE_|HIDDEN_|STALE_SELECTION_|\x1b/); assert.equal(stopCalls, 0);
    const lines = output.split("\n").filter((line) => line.startsWith("assistant preview ("));
    assert.ok(lines.every((line) => line.length < 16 * 1024)); assert.ok(lines.every((line) => line.includes("provisional snapshot")));
  } finally {
    releaseOld?.(); if (client.exitCode === null && client.signalCode === null) client.kill(); await closed;
    await local.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const detach of ["exit", "SIGINT"] as const) test(`blocked stdout backpressures preview polling; ${detach} drops display bytes without stopping Pi`, { timeout: 10_000 }, async () => {
  let polls = 0; let stopCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; args: Record<string, unknown> };
    if (command === "stop") stopCalls++;
    if (command === "status") { response.end(JSON.stringify({ version: 1, id, ok: true, result: { chatId: "1", mainChatId: "1", hubId: "progress-backpressure", model: {}, tools: "offline" } })); return; }
    assert.equal(command, "history"); polls++;
    response.end(JSON.stringify({ version: 1, id, ok: true, result: {
      items: polls === 2 ? [{ id: 1, kind: "pi.assistant", model: [{ content: [{ type: "text", text: "x".repeat(500_000) }] }] }] : [],
      progress: polls === 1 ? { version: 1, chatId: "1", provisional: true } : preview(String(args.chatId), `snapshot-${polls}`),
      instructions: { version: 1, chatId: String(args.chatId), source: null, import: { taskId: String(polls), state: "running" } },
    } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const local = await clientEnv();
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)], { env: local.env });
  const closed = once(client, "close"); let errors = ""; client.stderr.on("data", (chunk) => { errors += String(chunk); });
  // Never consume stdout until the child has detached. Its OS pipe fills.
  try {
    await waitFor(() => polls >= 2); await new Promise((resolve) => setTimeout(resolve, 1200)); assert.equal(polls, 2);
    const exited = once(client, "exit");
    if (detach === "SIGINT") client.kill("SIGINT"); else client.stdin.end("/exit\n");
    const timer = setTimeout(() => client.kill("SIGKILL"), 1500);
    try { assert.equal((await exited)[0], 0, errors); }
    finally { clearTimeout(timer); client.stdout.resume(); }
    assert.equal((await closed)[0], 0, errors); assert.equal(stopCalls, 0); assert.equal(errors, "");
  } finally {
    client.stdout.resume(); if (client.exitCode === null && client.signalCode === null) client.kill(); await closed;
    await local.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
