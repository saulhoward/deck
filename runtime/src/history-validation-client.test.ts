import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";

const entry = (id: number, text = "INVALID_PAGE_MUST_NOT_RENDER") => ({ id, kind: "deck.input", data: { text } });
async function until(check: () => boolean) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("History client condition timed out"); }

test("invalid history pages never partially render or advance either cursor, and leave saved mutations untouched", { timeout: 15_000 }, async () => {
  const local = await clientEnv(), store = new DraftStore("history-validation", local.env.DECK_CLIENT_STATE_DIRECTORY), requestId = randomUUID();
  await store.save({ kind: "input", chatId: "1", requestId, text: "SAVED_INPUT_MUST_NOT_REPLAY", mode: "steer" });
  const saved = await store.load(requestId);
  const olderRequests: unknown[] = [], forwardRequests: unknown[] = [], mutations: string[] = [];
  const badOlder: unknown[] = [
    { items: [{ ...entry(9), data: null }, entry(8)], next: "8" }, // Reverse rendering used to print 8 before failing on 9.
    { items: [entry(9), entry(9)], next: "9" },
    { items: [entry(8), entry(9)], next: "9" },
    { items: [entry(10)], next: "10" },
    { items: [entry(9)], next: "8" },
    { items: [entry(9)], next: null },
    { items: [{ ...entry(9), id: "9" }] },
    { items: [entry(9)], private: "PRIVATE_HISTORY" },
    "lost",
  ];
  const badForward: unknown[] = [
    { items: [entry(11), { ...entry(12), data: null }] },
    { items: [entry(11)], next: "12" },
    { items: [{ ...entry(11), id: "11" }] },
    "lost",
  ];
  let releaseForward = false, badForwardIndex = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id, command, args, hubId } = JSON.parse(Buffer.concat(chunks).toString());
    const reply = (result: unknown) => response.end(JSON.stringify({ version: 1, id, ok: true, result }));
    if (command === "status") return void reply({ hubId: "history-validation", mainChatId: "1", chatId: "1", model: {}, tools: "offline" });
    if (command !== "history") { mutations.push(command); response.destroy(); return; }
    assert.equal(hubId, "history-validation");
    if (args.before !== undefined) {
      olderRequests.push(args.before);
      const bad = badOlder[olderRequests.length - 1];
      if (bad === "lost") return response.destroy();
      return void reply(bad ?? { items: [entry(9, "RECOVERED_OLDER")] });
    }
    if (args.after === undefined) return void reply({ items: [entry(10, "INITIAL")], next: "10" });
    forwardRequests.push(args.after);
    if (!releaseForward || args.after === "13") return void reply({ items: [] });
    const bad = badForward[badForwardIndex++];
    if (bad === "lost") return response.destroy();
    reply(bad ?? { items: [{ id: 11, kind: "pi.system" }, entry(13, "RECOVERED_FORWARD")], next: "13" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)], { env: local.env });
  const closed = once(client, "close"); let output = "", errors = "";
  client.stdout.on("data", (chunk) => { output += String(chunk); }); client.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    await until(() => output.includes("Older retained history"));
    for (let i = 0; i < badOlder.length; i++) {
      const previous = errors.length;
      client.stdin.write("/older\n"); await until(() => errors.length > previous);
      assert.equal(olderRequests.length, i + 1); assert.equal(olderRequests.at(-1), "10");
      if (badOlder[i] !== "lost") assert.match(errors.slice(previous), /Invalid history response; cursor unchanged/);
      assert.doesNotMatch(output, /Older history for chat|INVALID_PAGE_MUST_NOT_RENDER/);
    }
    await new Promise((resolve) => setTimeout(resolve, 600)); assert.equal(olderRequests.length, badOlder.length); // No automatic backward replay.
    client.stdin.write("/older\n"); await until(() => output.includes("RECOVERED_OLDER"));
    assert.equal(olderRequests.at(-1), "10");
    releaseForward = true;
    await until(() => output.includes("RECOVERED_FORWARD"));
    await until(() => forwardRequests.includes("13"));
    assert.equal(forwardRequests.filter((id) => id !== "10" && id !== "13").length, 0);
    assert.equal(badForwardIndex, badForward.length + 1);
    assert.equal((output.match(/RECOVERED_FORWARD/g) ?? []).length, 1);
    client.stdin.end("/older\n/exit\n"); assert.equal((await closed)[0], 0, errors);
    assert.match(output, /No older history/);
    assert.doesNotMatch(output + errors, /INVALID_PAGE_MUST_NOT_RENDER|PRIVATE_HISTORY|SAVED_INPUT_MUST_NOT_REPLAY/);
    assert.deepEqual(mutations, []); assert.deepEqual(await store.load(requestId), saved);
  } finally {
    if (client.exitCode === null && client.signalCode === null) client.kill("SIGKILL"); await closed;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await local.close();
  }
});
