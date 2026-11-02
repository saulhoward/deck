import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";

test("plain client deduplicates activity transitions and renders bounded sanitized tool results without arguments", { timeout: 15_000 }, async () => {
  let phase = "generating"; let polls = 0;
  const activity = (chatId: string) => ({ chatId, busy: chatId === "1" && phase !== "idle", queued: 0,
    tools: phase === "tools" && chatId === "1" ? [{ callId: "call", name: "bash", status: "running", taskId: "3", nested: false }] : [], omittedTools: 0, compactions: 0, compactionFailed: false });
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { command, args } = JSON.parse(Buffer.concat(chunks).toString()) as { command: string; args: Record<string, unknown> };
    let result: unknown;
    if (command === "status") result = { chatId: args.chatId ?? "1", mainChatId: "1", hubId: "test-activity", model: {}, tools: "native-files + bash" };
    else if (command === "activity") result = activity(String(args.chatId));
    else {
      assert.equal(command, "history"); assert.equal(args.includeActivity, true); polls++;
      result = { activity: activity(String(args.chatId)), items: args.chatId !== "1" || args.after !== undefined ? [] : [
        { id: 2, kind: "pi.tool-result", model: [{ toolName: "bash", isError: true, details: { code: "effect_uncertain", exitCode: 7, truncated: true }, content: [{ type: "text", text: "HEAD_MUST_CLIP" + "x".repeat(10_000) + "\u001b[31mTAIL_SENTINEL" }] }] },
        { id: 1, kind: "pi.assistant", model: [{ content: [{ type: "toolCall", name: "bash", arguments: { command: "SECRET_ARGUMENTS" } }] }] },
      ] };
    }
    response.end(JSON.stringify({ ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const local = await clientEnv();
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)], { env: local.env });
  const closed = once(client, "close"); let output = ""; let errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); }); client.stderr.on("data", (chunk) => { errors += String(chunk); });
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.fail(`Expected client state not reached: ${errors}`);
  };
  try {
    await waitFor(() => polls >= 3);
    assert.equal((output.match(/activity:/g) ?? []).length, 1);
    phase = "tools"; await waitFor(() => output.includes('"status":"running"'));
    phase = "idle"; await waitFor(() => output.includes('"busy":false'));
    client.stdin.end("/activity\n/select 2\n/exit\n");
    assert.equal((await closed)[0], 0, errors);
    assert.equal((output.match(/activity:/g) ?? []).length, 4);
    assert.equal((output.match(/TAIL_SENTINEL/g) ?? []).length, 1);
    assert.equal((output.match(/tool requested:/g) ?? []).length, 1);
    assert.match(output, /result \(error\)/); assert.match(output, /effect_uncertain/); assert.match(output, /"exitCode":7/);
    assert.match(output, /display clipped/); assert.doesNotMatch(output, /HEAD_MUST_CLIP|SECRET_ARGUMENTS|\x1b/);
    assert.equal(errors, "");
  } finally {
    if (client.exitCode === null && client.signalCode === null) client.kill(); await closed;
    await local.close();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
