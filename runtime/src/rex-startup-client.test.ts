import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DraftStore } from "./drafts.js";
import { clientEnv } from "./client.test.env.js";
const allocation = "12345678-1234-1234-1234-123456789abc"; const block = `block:${allocation}`;
for (const mode of ["unbound", "matched", "old_hub", "wrong_chat", "bad_history", "refused", "malformed_ack", "lost_ack", "wrong_allocation", "wrong_block", "wrong_ack_chat", "numeric_task", "unsafe_task", "extra_ack", "non_historical", "live_claim", "conflict_observation", "unregistered"]) test(`Rex client startup ${mode}: native block identity and checks before any input`, { timeout: 10_000 }, async () => {
  let startups = 0; let admits = 0; let acknowledged = false; const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; hubId: string; args: Record<string, unknown> }; calls.push(value.command);
    assert.equal(value.hubId, "expected-hub");
    const reply = (result: object) => response.end(JSON.stringify({ version: 1, id: value.id, ok: true, result }));
    const fail = () => response.end(JSON.stringify({ version: 1, id: value.id, ok: false, error: { code: "conflict", message: "Startup refused" } }));
    if (value.command === "status") reply({ hubId: "expected-hub", hubGuard: 1, ...(mode === "old_hub" ? {} : { rexStartup: 1 }), chatId: mode === "wrong_chat" ? "3" : "2", mainChatId: "1", provider: "faux", model: { provider: "faux", modelId: "faux-1" }, tools: "native-files + bash" });
    else if (value.command === "history") { if (mode === "bad_history") fail(); else reply({ items: [] }); }
    else if (value.command === "rex_startup") {
      startups++; assert.deepEqual(value.args, { chatId: "2", allocationId: allocation, blockId: block });
      assert.deepEqual(calls, ["status", "history", "rex_startup"]);
      await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(admits, 0);
      if (mode === "refused") fail();
      else if (mode === "lost_ack") response.destroy();
      else {
        acknowledged = true;
        const ack: Record<string, unknown> = { version: 1, taskId: "8", chatId: "2", allocationId: allocation, blockId: mode === "malformed_ack" ? "other" : block, registered: true, observation: mode === "matched" ? "matched" : "unbound", historical: true, live: "not_checked" };
        if (mode === "wrong_allocation") ack.allocationId = "00000000-0000-0000-0000-000000000000";
        if (mode === "wrong_block") ack.blockId = "block:00000000-0000-0000-0000-000000000000";
        if (mode === "wrong_ack_chat") ack.chatId = "3";
        if (mode === "numeric_task") ack.taskId = 8;
        if (mode === "unsafe_task") ack.taskId = "9007199254740992";
        if (mode === "extra_ack") ack.private = "PRIVATE_ACK";
        if (mode === "non_historical") ack.historical = false;
        if (mode === "live_claim") ack.live = "running";
        if (mode === "conflict_observation") ack.observation = "conflict";
        if (mode === "unregistered") ack.registered = false;
        reply(ack);
      }
    } else if (value.command === "admit") { assert.equal(acknowledged, true); admits++; reply({ submissionId: "9" }); }
    else assert.fail("Unexpected startup command");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const local = await clientEnv();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port), "--hub-id", "expected-hub", "--task", "2", "--rex-allocation", allocation], { env: { ...local.env, REX_BLOCK: block } });
  const closed = once(child, "close"); let output = ""; let errors = ""; child.stdout.on("data", (chunk) => { output += String(chunk); }); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    // This pipe is bounded by the OS; the client must not consume/send it while
    // registration is pending or refused. No draft/auto-submit on a failed start.
    child.stdin.end("USER_INPUT\n/exit\n");
    const success = mode === "unbound" || mode === "matched";
    assert.equal((await closed)[0], success ? 0 : 1, errors); assert.equal(admits, success ? 1 : 0);
    assert.equal(startups, ["old_hub", "wrong_chat", "bad_history"].includes(mode) ? 0 : 1);
    assert.equal(output.includes("Rex startup registered"), success); assert.doesNotMatch(output + errors, /PRIVATE_ACK/);
    if (!success && !["old_hub", "wrong_chat", "bad_history", "refused", "lost_ack"].includes(mode)) assert.match(errors, /Invalid Rex startup acknowledgement; no input sent/);
    assert.deepEqual(await new DraftStore("expected-hub", local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; await local.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

for (const mode of ["missing_block", "short_block", "missing_hub", "missing_task", "one_shot", "login", "block_newline", "task_newline", "unsafe_selection"]) test(`Rex startup ${mode} refuses locally without contacting a hub`, async () => {
  const local = await clientEnv();
  const args = ["--port", "1", "--rex-allocation", allocation, ...(mode === "missing_hub" ? [] : ["--hub-id", "hub"]), ...(mode === "missing_task" ? [] : ["--task", mode === "task_newline" ? "2\n" : mode === "unsafe_selection" ? "9007199254740992" : "2"]), ...(mode === "one_shot" ? ["--message", "MUST_NOT_SEND"] : []), ...(mode === "login" ? ["--login"] : [])];
  const child = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), ...args], { env: { ...local.env, REX_BLOCK: mode === "missing_block" ? "" : mode === "short_block" ? "block:short" : mode === "block_newline" ? `${block}\n` : block } });
  let error = ""; child.stdout.resume(); child.stderr.on("data", (chunk) => { error += String(chunk); }); child.stdin.end();
  try { assert.equal((await once(child, "close"))[0], 1); assert.match(error, mode === "task_newline" ? /Unknown client option/ : /Rex startup requires/); }
  finally { await local.close(); }
});
