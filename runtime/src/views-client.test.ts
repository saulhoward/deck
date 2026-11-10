import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DraftStore } from "./drafts.js";
import { clientEnv } from "./client.test.env.js";
async function until(check: () => boolean) { for (let i = 0; i < 600; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Live view client condition timed out"); }

test("malformed live views cannot print private fields, advance history, clear previews, alter drafts or replay work", { timeout: 20_000 }, async () => {
  const local = await clientEnv(), store = new DraftStore("view-client", local.env.DECK_CLIENT_STATE_DIRECTORY), requestId = randomUUID();
  await store.save({ kind: "input", chatId: "1", requestId, text: "SAVED_MUST_NOT_REPLAY", mode: "steer" }); const saved = await store.load(requestId);
  const activity = { chatId: "1", busy: true, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false };
  const progress = { version: 1, chatId: "1", provisional: true, runTaskId: "9", generation: { attempt: 1, phase: "generating", text: "PREVIEW_INITIAL" } };
  const instructions = { version: 1, chatId: "1", source: null, import: { taskId: "9", state: "running" } };
  let mode = "initial", polls = 0; const positions: string[] = [], mutations: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args } = JSON.parse(Buffer.concat(chunks).toString());
    const reply = (result: unknown) => response.end(JSON.stringify({ version: 1, id, ok: true, result }));
    if (command === "status") return void reply({ hubId: "view-client", mainChatId: "1", chatId: "1", model: {}, tools: "offline" });
    if (command === "activity") return void reply({ ...activity, output: "PRIVATE_ACTIVITY" });
    if (command === "instruction_status") return void reply({ ...instructions, import: { taskId: "10", state: "running" } });
    if (command !== "history") { mutations.push(command); response.destroy(); return; }
    polls++; positions.push(args.after ?? "initial");
    if (mode === "lost") return response.destroy();
    const page = {
      items: args.after === undefined ? [{ id: 1, kind: "deck.input", data: { text: "FIRST" } }] : mode !== "initial" && args.after === "1" ? [{ id: 2, kind: "deck.input", data: { text: mode === "recovered" ? "RECOVERED" : "INVALID_PAGE_MUST_NOT_RENDER" } }] : [],
      activity, progress, instructions,
    };
    if (mode === "activity") return void reply({ ...page, activity: { ...activity, tools: [{ callId: "call", name: "bash", status: "running", nested: false, arguments: "PRIVATE_ACTIVITY" }] } });
    if (mode === "progress") return void reply({ ...page, progress: { ...progress, chatId: "2" } });
    if (mode === "instructions") return void reply({ ...page, progress: { version: 1, chatId: "1", provisional: true }, instructions: { ...instructions, import: { taskId: "9", state: "running", outcome: "completed" } } });
    if (mode === "oversized") return void reply({ ...page, progress: { ...progress, generation: { ...progress.generation, text: "x".repeat(2049) } } });
    reply(page);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)], { env: local.env });
  const closed = once(child, "close"); let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); }); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    await until(() => polls >= 2 && output.includes("PREVIEW_INITIAL"));
    for (const failure of ["activity", "progress", "instructions", "oversized", "lost"]) {
      const before = polls; mode = failure;
      await until(() => polls > before); await new Promise((resolve) => setTimeout(resolve, 50));
      assert.doesNotMatch(output, /INVALID_PAGE|PRIVATE_|preview cleared/);
      assert.equal(positions.at(-1), "1"); assert.equal((output.match(/PREVIEW_INITIAL/g) ?? []).length, 1);
    }
    // Explicit read errors do not become mutations or a new draft/retry kind.
    let length = errors.length; child.stdin.write("/activity\n"); await until(() => errors.length > length);
    assert.match(errors.slice(length), /Invalid live view response/);
    length = errors.length; child.stdin.write("/instructions 9\n"); await until(() => errors.length > length);
    assert.match(errors.slice(length), /Invalid live view response/);
    mode = "recovered"; await until(() => output.includes("you: RECOVERED") && positions.includes("2"));
    assert.equal((output.match(/PREVIEW_INITIAL/g) ?? []).length, 1); assert.equal((output.match(/you: RECOVERED/g) ?? []).length, 1);
    child.stdin.end("/exit\n"); assert.equal((await closed)[0], 0, errors);
    assert.doesNotMatch(output + errors, /INVALID_PAGE|PRIVATE_|SAVED_MUST_NOT_REPLAY|preview cleared/);
    assert.deepEqual(mutations, []); assert.deepEqual(await store.load(requestId), saved);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close();
  }
});
