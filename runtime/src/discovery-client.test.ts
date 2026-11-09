import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";

async function until(check: () => boolean) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Discovery client condition timed out"); }
const row = (chatId: string, title = "HIDDEN_INVALID_PAGE") => ({ chatId, kind: "task", title, machineId: "offline-original", cwd: "/saved" });

test("plain discovery validates entire pages, retains the scan cursor after faults, advances across sparse pages, and never replays work", { timeout: 15_000 }, async () => {
  const local = await clientEnv(), store = new DraftStore("discovery-hub", local.env.DECK_CLIENT_STATE_DIRECTORY), requestId = randomUUID();
  await store.save({ kind: "input", chatId: "1", requestId, text: "SAVED_UNACKNOWLEDGED_INPUT", mode: "steer" });
  const before = await store.load(requestId);
  const invalid: unknown[] = [
    { items: [row("6"), { chatId: "7", kind: "task" }], next: "8" },
    { items: [row("6"), { ...row("7"), kind: "other" }], next: "8" },
    { items: [row("6"), { ...row("7"), private: "PRIVATE_METADATA" }], next: "8" },
    { items: [row("9007199254740992")], next: "9007199254740992" },
    { items: [row("6"), row("6")], next: "8" }, { items: [row("7"), row("6")], next: "8" },
    { items: [row("5")], next: "8" }, { items: [row("7")], next: "6" },
    { items: [], next: "5" }, { items: [row("6")], next: null },
    { items: [{ ...row("6"), parentChatId: "1" }] },
    { items: Array.from({ length: 26 }, (_, i) => row(String(i + 6))), next: "32" },
    "lost",
  ];
  const pages: Record<string, unknown>[] = [], mutations: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args, hubId } = JSON.parse(Buffer.concat(chunks).toString());
    const reply = (result: unknown) => response.end(JSON.stringify({ version: 1, id, ok: true, result }));
    if (command === "status") return void reply({ hubId: "discovery-hub", mainChatId: "1", chatId: "1", model: {}, tools: "offline" });
    if (command === "history") return void reply({ items: [] });
    if (command !== "list_chats") { mutations.push(command); response.destroy(); return; }
    assert.equal(hubId, "discovery-hub"); pages.push(args);
    if (pages.length === 1) return void reply({ items: [row("1", "FIRST_VISIBLE")], next: "5" });
    if (pages.length <= invalid.length + 1) {
      const value = invalid[pages.length - 2];
      if (value === "lost") return response.destroy();
      return void reply(value);
    }
    reply(pages.length === invalid.length + 2 ? { items: [], next: "9" } : { items: [row("10", "FINAL_VISIBLE")] });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)], { env: local.env });
  const closed = once(client, "close"); let output = "", errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); }); client.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    await until(() => output.includes("Deck chat")); client.stdin.write("/tasks\n"); await until(() => output.includes("FIRST_VISIBLE"));
    for (let i = 0; i < invalid.length; i++) {
      const previous = errors.length; client.stdin.write("/tasks more\n"); await until(() => errors.length > previous);
      assert.equal(pages.length, i + 2); assert.deepEqual(pages.at(-1), { limit: 25, after: "5" });
      if (invalid[i] !== "lost") assert.match(errors.slice(previous), /Invalid chat discovery response; cursor unchanged/);
      assert.doesNotMatch(output + errors, /HIDDEN_INVALID_PAGE|PRIVATE_METADATA|SAVED_UNACKNOWLEDGED_INPUT/);
    }
    // Let a transport poll occur: it may restore observation, never list/mutate/retry.
    await new Promise((resolve) => setTimeout(resolve, 600)); assert.equal(pages.length, invalid.length + 1);
    const previous = output.length;
    client.stdin.write("/tasks more\n"); await until(() => output.slice(previous).includes("More chats: /tasks more"));
    assert.deepEqual(pages.at(-1), { limit: 25, after: "5" });
    client.stdin.write("/tasks more\n"); await until(() => output.includes("FINAL_VISIBLE"));
    assert.deepEqual(pages.at(-1), { limit: 25, after: "9" });
    client.stdin.end("/tasks more\n/exit\n"); assert.equal((await closed)[0], 0, errors);
    assert.equal(pages.length, invalid.length + 3); assert.match(output, /No more chats/);
    assert.deepEqual(mutations, []); assert.deepEqual(await store.load(requestId), before); assert.equal((await store.list()).length, 1);
    assert.doesNotMatch(output + errors, /HIDDEN_INVALID_PAGE|PRIVATE_METADATA|SAVED_UNACKNOWLEDGED_INPUT/);
  } finally {
    if (client.exitCode === null && client.signalCode === null) client.kill("SIGKILL"); await closed;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close();
  }
});
