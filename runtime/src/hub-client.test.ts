import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { hubCommand, HubCallError } from "./hub-client.js";
import { HubError } from "./responses.js";
import { MAX_FRAME_BYTES } from "./protocol.js";

test("bounded client transport refuses oversized, invalid, redirected, lost and uncorrelated replies without retry", { timeout: 15_000 }, async () => {
  let mode = "ok", count = 0, redirected = 0;
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/redirect") { redirected++; response.end("{}"); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()); requests.push(value); count++;
    const reply = { version: 1, id: value.id, ok: true, result: { submissionId: "9" } };
    if (mode === "ok") { response.end(JSON.stringify(reply)); return; }
    if (mode === "large-header") { response.writeHead(200, { "content-length": MAX_FRAME_BYTES + 1 }); response.end("PRIVATE"); return; }
    if (mode === "large-chunked") { response.writeHead(200); response.write('"'); response.end("x".repeat(MAX_FRAME_BYTES)); return; }
    if (mode === "utf8") { response.end(Buffer.from([0xff])); return; }
    if (mode === "truncated") { response.writeHead(200, { "content-length": 1000 }); response.write("{"); setImmediate(() => response.destroy()); return; }
    if (mode === "redirect") { response.writeHead(307, { location: "/redirect" }); response.end("PRIVATE"); return; }
    if (mode === "http-error") { response.writeHead(503); response.end("PRIVATE"); return; }
    if (mode === "lost") { response.destroy(); return; }
    if (mode === "aborted") { response.writeHead(200); response.write("{"); return; }
    if (mode === "wrong-id") reply.id = "wrong";
    if (mode === "unknown-error") { response.end(JSON.stringify({ version: 1, id: value.id, ok: false, error: { code: "future_error", message: "Outcome unconfirmed" } })); return; }
    if (mode === "too-large-error") { response.end(JSON.stringify({ version: 1, id: value.id, ok: false, error: { code: "too_large", message: "Outcome unconfirmed" } })); return; }
    response.end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const args = { chatId: "1", requestId: "saved", mode: "steer", text: "original" };
  try {
    assert.deepEqual(await hubCommand(address.port, "admit", args, "hub"), { submissionId: "9" });
    for (mode of ["large-header", "large-chunked", "utf8", "truncated", "redirect", "http-error", "lost", "aborted", "wrong-id", "unknown-error", "too-large-error"]) {
      const before = count; const abort = new AbortController();
      const timer = mode === "aborted" ? setTimeout(() => abort.abort(), 100) : undefined;
      try {
        await assert.rejects(hubCommand(address.port, "admit", args, "hub", abort.signal), (error: unknown) => {
          assert.ok(error instanceof HubCallError || error instanceof HubError);
          assert.equal(error.policy.action, "retry_saved"); assert.equal(error.policy.outcome, "unconfirmed");
          assert.equal(error.policy.automaticMutationRetry, false); assert.equal(error.policy.preserveDrafts, true);
          assert.doesNotMatch(error.message, /PRIVATE/); return true;
        });
      } finally { clearTimeout(timer); }
      assert.equal(count, before + 1); assert.deepEqual(requests.at(-1).args, args); assert.equal(requests.at(-1).hubId, "hub");
    }
    assert.equal(redirected, 0);
    assert.equal(new Set(requests.map((request) => request.id)).size, requests.length);
    const before = count;
    for (const [command, invalid] of [["future_command", {}], ["admit", { ...args, text: "\ud800" }], ["admit", { ...args, text: "\u0000".repeat(200_000) }], ["admit", { ...args, chatId: "9007199254740992" }]] as const) {
      await assert.rejects(hubCommand(address.port, command, invalid, "hub"), (error: unknown) => {
        assert.ok(error instanceof HubCallError); assert.equal(error.policy.outcome, "not_sent"); return true;
      });
    }
    assert.equal(count, before);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
