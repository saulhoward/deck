import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DraftStore } from "./drafts.js";
import { clientEnv } from "./client.test.env.js";
const client = fileURLToPath(new URL("./client.js", import.meta.url));
const status = { hubId: "control-hub", mainChatId: "1", chatId: "1", model: {}, tools: "offline" };
async function until(check: () => boolean) { for (let i = 0; i < 600; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error("Status/login client condition timed out"); }
async function savedDrafts(local: Awaited<ReturnType<typeof clientEnv>>) {
  const store = new DraftStore(status.hubId, local.env.DECK_CLIENT_STATE_DIRECTORY);
  await store.save({ kind: "input", chatId: "3", requestId: randomUUID(), text: "PRIVATE_DRAFT", mode: "steer" });
  await store.save({ kind: "task", chatId: "4", requestId: randomUUID(), title: "PRIVATE_DRAFT", machineId: "worker", cwd: "/saved" });
  await store.save({ kind: "instructions", chatId: "5", requestId: randomUUID(), machineId: "worker", cwd: "/saved" });
  return async () => Promise.all((await readdir(store.directory)).sort().map(async (name) => [name, await readFile(join(store.directory, name), "utf8")]));
}
for (const fault of ["wrong_chat", "unsafe", "private", "capability", "lost"]) test(`invalid initial status ${fault} cannot select, render, submit or modify any draft`, { timeout: 10_000 }, async () => {
  const local = await clientEnv(), bytes = await savedDrafts(local), before = await bytes(); const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command } = JSON.parse(Buffer.concat(chunks).toString()); calls.push(command);
    if (fault === "lost") return response.destroy();
    const result = { ...status, ...(fault === "wrong_chat" ? { chatId: "2" } : fault === "unsafe" ? { chatId: "9007199254740992", mainChatId: "9007199254740992" } : fault === "capability" ? { hubGuard: "1" } : { private: "PRIVATE" }) };
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [client, "--port", String(address.port), "--message", "PRIVATE_INPUT"], { env: local.env }); const closed = once(child, "close");
  let output = ""; child.stdout.on("data", (b) => { output += String(b); }); child.stderr.on("data", (b) => { output += String(b); });
  try {
    assert.equal((await closed)[0], 1); assert.deepEqual(calls, ["status"]); assert.deepEqual(await bytes(), before);
    assert.doesNotMatch(output, /PRIVATE|Deck chat|admitted/);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await local.close(); }
});

test("bad selection and changed-hub status retain the prior chat, cursors and drafts", { timeout: 10_000 }, async () => {
  const local = await clientEnv(), bytes = await savedDrafts(local), before = await bytes(); let mode = "initial"; const histories: string[] = [], mutations: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args, hubId } = JSON.parse(Buffer.concat(chunks).toString()); let result: unknown;
    if (command === "status") result = { ...status, chatId: mode === "recover" ? args.chatId ?? "1" : "1", ...(mode === "hub" ? { hubId: "replacement" } : {}) };
    else if (command === "history") { histories.push(args.chatId); assert.equal(hubId, status.hubId); result = { items: [] }; }
    else { mutations.push(command); return response.destroy(); }
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [client, "--port", String(address.port)], { env: local.env }); const closed = once(child, "close"); let output = "", errors = "";
  child.stdout.on("data", (b) => { output += String(b); }); child.stderr.on("data", (b) => { errors += String(b); });
  try {
    await until(() => histories.length > 0); child.stdin.write("/select 2\n"); await until(() => errors.includes("Invalid status/login response"));
    assert.equal(histories.every((id) => id === "1"), true); let length = errors.length;
    mode = "hub"; child.stdin.write("/status\n"); await until(() => errors.length > length); assert.doesNotMatch(output, /replacement/);
    assert.equal(histories.every((id) => id === "1"), true); mode = "recover"; child.stdin.write("/select 2\n"); await until(() => histories.includes("2"));
    child.stdin.end("/exit\n"); assert.equal((await closed)[0], 0, errors);
    assert.deepEqual(mutations, []); assert.deepEqual(await bytes(), before);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await local.close(); }
});

for (const mode of ["wrong_start", "malformed_status", "wrong_login", "secret", "bad_reply", "lost_reply", "done"]) test(`login client ${mode}: pinned identity, bounded views and no automatic answer retry`, { timeout: 10_000 }, async () => {
  const local = await clientEnv(), bytes = await savedDrafts(local), before = await bytes(); let loginId = "", replies = 0, starts = 0, cancels = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args, hubId } = JSON.parse(Buffer.concat(chunks).toString()); let result: unknown;
    if (command === "status") result = status;
    else {
      assert.equal(hubId, status.hubId);
      switch (command) {
        case "login_start": starts++; loginId = args.requestId; result = { status: "pending", id: mode === "wrong_start" ? "other" : loginId, events: [] }; break;
        case "login_status": result = mode === "done" && replies > 0 ? { status: "done", id: loginId, events: [] } : {
          status: "pending", id: mode === "wrong_login" ? "other" : loginId,
          events: mode === "malformed_status" ? [{ type: "progress", message: "PRIVATE", token: "PRIVATE" }] : [{ type: "progress", message: mode === "wrong_login" ? "PRIVATE" : "SIGN_IN_EVENT\u009b" }],
          prompt: { type: mode === "secret" ? "secret" : "manual_code", id: "prompt", message: mode === "secret" ? "PRIVATE_SECRET" : "Code" },
        }; break;
        case "login_reply": replies++; assert.equal(args.answer, "PRIVATE_ANSWER"); assert.equal(args.loginId, loginId); assert.equal(args.promptId, "prompt");
          if (mode === "lost_reply") return response.destroy(); result = mode === "bad_reply" ? { accepted: true, token: "PRIVATE" } : { accepted: true }; break;
        case "login_cancel": cancels++; assert.equal(args.loginId, loginId); result = { cancelled: true }; break;
        default: assert.fail(`Unexpected login command ${command}`);
      }
    }
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [client, "--login", "--port", String(address.port)], { env: local.env }); const closed = once(child, "close"); let output = "", errors = "";
  child.stdout.on("data", (b) => { output += String(b); }); child.stderr.on("data", (b) => { errors += String(b); });
  try {
    if (["bad_reply", "lost_reply", "done"].includes(mode)) { await until(() => output.includes('"Code"')); child.stdin.write("PRIVATE_ANSWER\n"); }
    assert.equal((await closed)[0], mode === "done" ? 0 : 1, errors); assert.equal(starts, 1);
    assert.equal(replies, ["bad_reply", "lost_reply", "done"].includes(mode) ? 1 : 0);
    assert.equal(cancels, ["done", "wrong_start"].includes(mode) ? 0 : 1);
    if (mode === "done") assert.match(output, /sign-in saved on the hub/); else assert.doesNotMatch(output, /sign-in saved/);
    assert.doesNotMatch(output + errors, /PRIVATE|[\x7f-\x9f]/); assert.deepEqual(await bytes(), before);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await local.close(); }
});
