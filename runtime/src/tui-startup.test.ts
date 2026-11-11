import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";

const allocation = "12345678-1234-4234-8234-123456789abc";
const block = `block:${allocation}`;
for (const mode of ["matched", "unbound", "hub_chat", "old_hub", "wrong_hub", "wrong_chat", "bad_history", "lost_ack", "wrong_block", "unsafe_task", "live_claim", "private_ack"]) {
  test(`TUI allocation-bound startup ${mode}: input follows verified registration, never retries startup`, { timeout: 10_000 }, async () => {
    const local = await clientEnv(); const calls: string[] = []; let registered = false;
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks).toString()); calls.push(value.command);
      assert.equal(value.hubId, "expected-hub");
      const reply = (result: object) => response.end(JSON.stringify({ version: 1, id: value.id, ok: true, result }));
      if (value.command === "status") reply({ hubId: mode === "wrong_hub" ? "another-hub" : "expected-hub", hubGuard: 1, ...(mode === "old_hub" ? {} : { rexStartup: 1 }), mainChatId: mode === "hub_chat" ? "2" : "1", chatId: mode === "wrong_chat" ? "3" : "2", tools: "offline" });
      else if (value.command === "history") reply(mode === "bad_history" ? { items: [{ id: "1" }] } : { items: [] });
      else if (value.command === "rex_startup") {
        assert.deepEqual(calls, ["status", "history", "rex_startup"]);
        assert.deepEqual(value.args, { chatId: "2", allocationId: allocation, blockId: block });
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(calls.includes("admit"), false);
        if (mode === "lost_ack") { response.destroy(); return; }
        const ack = { version: 1, taskId: mode === "unsafe_task" ? "9007199254740992" : "8", chatId: "2", allocationId: allocation, blockId: mode === "wrong_block" ? `block:${"0".repeat(8)}-0000-0000-0000-000000000000` : block, registered: true, observation: mode === "unbound" ? "unbound" : "matched", historical: true, live: mode === "live_claim" ? "running" : "not_checked", ...(mode === "private_ack" ? { secret: "PRIVATE_ACK" } : {}) };
        registered = true; reply(ack);
      } else if (value.command === "admit") { assert.ok(registered); reply({ submissionId: "9" }); }
      else assert.fail(`Unexpected command ${value.command}`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const child = spawn(process.execPath, [fileURLToPath(new URL("./tui-bridge.js", import.meta.url)), "--port", String(address.port), "--hub-id", "expected-hub", "--task", "2", "--rex-allocation", allocation], { env: { ...local.env, REX_BLOCK: block } });
    const closed = once(child, "close"); let errors = ""; child.stderr.on("data", (v) => { errors += v; });
    const decoder = child.stdout.pipe(new FrameDecoder()); const replies: any[] = []; decoder.on("data", (r) => { replies.push(r); if (r.id === "2") child.stdin.end(); });
    try {
      // Even queued private frames cannot run before the historical startup ACK.
      child.stdin.write(encodeFrame({ version: 1, id: "1", action: "poll" }));
      child.stdin.write(encodeFrame({ version: 1, id: "2", action: "send", text: "INPUT_AFTER_REGISTRATION" }));
      await closed;
      const success = mode === "matched" || mode === "unbound";
      assert.equal(replies.length, success ? 2 : 0); assert.equal(calls.filter((c) => c === "admit").length, success ? 1 : 0);
      assert.equal(calls.filter((c) => c === "rex_startup").length, ["hub_chat", "old_hub", "wrong_hub", "wrong_chat", "bad_history"].includes(mode) ? 0 : 1);
      if (success) { assert.equal(replies[0].ok, true); assert.match(replies[0].snapshot.notice, /Rex startup registered/); }
      assert.doesNotMatch(errors + JSON.stringify(replies), /PRIVATE_ACK/);
      assert.deepEqual(await new DraftStore("expected-hub", local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill(); await closed;
      server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await local.close();
    }
  });
}

for (const mode of ["missing_block", "short_block", "missing_hub", "missing_task"]) {
  test(`TUI startup ${mode} refuses before any connection`, async () => {
    const local = await clientEnv();
    const child = spawn(process.execPath, [fileURLToPath(new URL("./tui-bridge.js", import.meta.url)), "--port", "1", "--rex-allocation", allocation, ...(mode === "missing_hub" ? [] : ["--hub-id", "expected-hub"]), ...(mode === "missing_task" ? [] : ["--task", "2"])], { env: { ...local.env, REX_BLOCK: mode === "missing_block" ? "" : mode === "short_block" ? "block:short" : block } });
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    try { assert.equal((await once(child, "close"))[0], 2); }
    finally { await local.close(); }
  });
}
