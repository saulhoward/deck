import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DraftStore } from "./drafts.js";

test("plain /rex commands preserve a saved input and detach a stalled open without stop or replay", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-rex-plain-")), hubId = randomUUID(), requestId = randomUUID();
  const drafts = new DraftStore(hubId, root);
  await drafts.save({ kind: "input", chatId: "2", requestId, text: "MUST_NOT_SEND", mode: "steer" });
  const file = join(drafts.directory, `${requestId}.json`), before = await readFile(file);
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += String(chunk);
    const request = JSON.parse(text); calls.push(request.command);
    if (request.command === "rex_open") return; // Hold the read until client detach.
    const result = request.command === "status" ? { hubId, hubGuard: 1, rexOpen: 1, chatId: "2", mainChatId: "1", provider: "faux", model: {}, tools: "offline" }
      : request.command === "history" ? { items: [] }
      : { version: 1, hubId, chatId: "2", taskId: null, status: "unallocated", binding: null, previousBinding: null, bestEffort: true };
    res.end(JSON.stringify({ version: 1, id: request.id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--no-tui", "--task", "2", "--port", String(address.port)], { env: { ...process.env, DECK_CLIENT_STATE_DIRECTORY: root } });
  const closed = once(child, "close"); let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const until = async (ready: () => boolean) => { for (let i = 0; i < 300; i++) { if (ready()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Plain Rex condition not observed"); };
  try {
    await until(() => calls.includes("history")); child.stdin.write("/rex status\n");
    await until(() => stdout.includes('"status":"unallocated"')); child.stdin.write("/rex open\n");
    await until(() => calls.includes("rex_open")); child.kill("SIGINT"); await closed;
    assert.deepEqual(calls.filter((c) => c !== "history"), ["status", "rex_status", "rex_open"]);
    assert.deepEqual(await readFile(file), before); assert.doesNotMatch(stdout + stderr, /MUST_NOT_SEND/);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["admitted", "reused", "lost", "wrong_chat", "wrong_request", "private", "unsafe", "no_capability"]) test(`Rex client ${mode}: no draft changes, input or automatic retry`, { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-rex-client-")), hubId = randomUUID();
  const drafts = new DraftStore(hubId, root), requestId = randomUUID();
  await drafts.save({ kind: "input", chatId: "2", requestId, text: "MUST_NOT_SEND", mode: "steer" });
  const file = join(drafts.directory, `${requestId}.json`), before = await readFile(file);
  const calls: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += String(chunk);
    const request = JSON.parse(text); calls.push(request);
    let result: Record<string, unknown>;
    if (request.command === "status") result = { hubId, hubGuard: 1, rexOpen: mode === "no_capability" ? 0 : 1, chatId: "2", mainChatId: "1" };
    else {
      assert.equal(request.command, "rex_open"); assert.equal(request.hubId, hubId); assert.equal(request.args.chatId, "2");
      if (mode === "lost") { res.destroy(); return; }
      result = { version: 1, chatId: mode === "wrong_chat" ? "3" : "2", requestId: mode === "wrong_request" ? randomUUID() : request.args.requestId, taskId: mode === "unsafe" ? "9007199254740992" : "9", status: mode === "reused" ? "reused" : "admitted", completion: "not_waited", bestEffort: true, ...(mode === "private" ? { secret: "PRIVATE_PAYLOAD" } : {}) };
    }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ version: 1, id: request.id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--rex-command", "open", "--task", "2", "--port", String(address.port)], { env: { ...process.env, DECK_CLIENT_STATE_DIRECTORY: root } });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const [code] = await once(child, "close");
    assert.equal(code, ["admitted", "reused"].includes(mode) ? 0 : 1, stderr);
    assert.deepEqual(calls.map((r) => r.command), mode === "no_capability" ? ["status"] : ["status", "rex_open"]);
    assert.doesNotMatch(stdout + stderr, /PRIVATE_PAYLOAD|MUST_NOT_SEND/);
    if (mode === "admitted") assert.match(stdout, /not yet allocated\/ready/);
    if (mode === "reused") assert.match(stdout, /no new terminal requested/);
    if (mode === "lost") assert.match(stderr, /may duplicate/);
    assert.deepEqual(await readFile(file), before); assert.equal((await drafts.list()).length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
