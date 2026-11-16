import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";
import { hubCommand } from "./hub-client.js";
import { TuiSession, validReply } from "./tui-session.js";
import type { HistoryEntry, TuiRequest, TuiSnapshot } from "./generated/contracts.js";

const hubId = "tui-history-budget", answer = "Latest answer after the large tool results", followup = "Follow-up answer remains visible";
async function fixture(count = 96) {
  const local = await clientEnv(), requests: any[] = [];
  const payload = "\x1b]52;c;DO_NOT_RENDER\x07\x1b[31m" + "🧪".repeat(2200);
  // Nonconsecutive canonical IDs, unknown kinds and multibyte tool output.
  const retained: HistoryEntry[] = Array.from({ length: count }, (_, i) => ({
    id: (i + 1) * 3,
    ...(i % 10 === 0 ? { kind: "future.kind", data: { retained: true } } : {
      kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: `tool ${i + 1}\n${payload}` }] }],
    }),
  }));
  const append = (text: string, response: string) => {
    const id = retained.at(-1)!.id + 3;
    retained.push({ id, kind: "deck.input", data: { text } }, { id: id + 3, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: response }], stopReason: "stop" }] });
  };
  append("Complex task request", answer);
  const activity = { chatId: "1", busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false, agentStatus: { state: "done", taskId: "9" } };
  const progress = { version: 1, chatId: "1", provisional: true };
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()); requests.push(value);
    const { id, command, args } = value; let result;
    if (command === "status") result = { hubId, hubGuard: 1, mainChatId: "1", chatId: "1", model: { provider: "mock", modelId: "echo" }, tools: "offline" };
    else if (command === "history") {
      const eligible = retained.filter(entry => args.before === undefined || entry.id < Number(args.before)).reverse();
      const items = eligible.slice(0, args.limit);
      result = { items, ...(eligible.length > items.length ? { next: String(items.at(-1)!.id) } : {}), activity, progress };
    } else if (command === "activity") result = activity;
    else if (command === "progress") result = progress;
    else if (command === "admit") { append(args.text, followup); result = { submissionId: "9" }; }
    else assert.fail(`Unexpected TUI command ${command}`);
    response.end(JSON.stringify({ version: 1, id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const session = new TuiSession((name, args, expected) => hubCommand(address.port, name, args, expected), undefined, undefined, local.env.DECK_CLIENT_STATE_DIRECTORY);
  let id = 0;
  const act = (action: TuiRequest["action"], args: Partial<TuiRequest> = {}) => session.handle({ version: 1, id: String(++id), action, ...args });
  return { local, port: address.port, requests, retained, activity, act, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await local.close(); } };
}
function bounded(snapshot: TuiSnapshot) {
  assert.ok(snapshot.entries.length > 0 && snapshot.entries.length <= 80);
  assert.ok(snapshot.entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0) <= 128 * 1024);
  assert.ok(snapshot.entries.every(entry => Buffer.byteLength(entry.text) <= 8192 && entry.text.isWellFormed()));
  const wire = JSON.stringify({ version: 1, id: "check", ok: true, snapshot });
  assert.ok(Buffer.byteLength(wire) <= 1024 * 1024);
  assert.ok(validReply(JSON.parse(wire), "check", hubId, "1", "poll"));
  assert.doesNotMatch(wire, /\[view budget\]|DO_NOT_RENDER|\\u001b/);
}

test("TUI view budget preserves newest answers and follow-ups after large tool results", async () => {
  const f = await fixture();
  try {
    const original = JSON.stringify(f.retained);
    const first = await f.act("poll");
    assert.equal(first.entries.at(-1)!.text, answer);
    assert.equal(first.entries.at(-2)!.text, "Complex task request");
    assert.ok(first.entries.length < 80); assert.equal(first.hasOlder, true); bounded(first);
    assert.ok(first.entries.some(entry => entry.text.includes("[view clipped]")));
    assert.equal(first.activityKnown, true); assert.equal(first.busy, false); assert.equal(first.agentStatus!.state, "done");
    assert.equal(JSON.stringify(f.retained), original);
    const held = structuredClone(first.entries);
    assert.deepEqual((await f.act("poll", { hold: true })).entries, held);
    assert.deepEqual(f.requests.slice(-2).map(request => request.command), ["activity", "progress"]);
    assert.equal((await f.act("poll")).entries.at(-1)!.text, answer);
    const text = "What happened?\n  Preserve my follow-up 🧪\n";
    const sent = await f.act("send", { text }); assert.equal(sent.draft, null);
    const next = await f.act("poll"); bounded(next);
    assert.equal(next.entries.at(-1)!.text, followup); assert.equal(next.entries.at(-2)!.text, text);
    assert.equal(f.requests.filter(request => request.command === "admit").length, 1);
    assert.equal(f.requests.find(request => request.command === "admit").args.text, text);
    assert.deepEqual(await new DraftStore(hubId, f.local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
    assert.equal(JSON.stringify(f.retained.slice(0, -2)), original);
    assert.ok(f.requests.every(request => ["status", "history", "activity", "progress", "admit"].includes(request.command)));
  } finally { await f.close(); }
});

test("TUI displays reported thinking counts without exposing reasoning or changing history", async () => {
  const f = await fixture(1);
  try {
    f.retained.at(-1)!.model = [{ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING", thinkingSignature: "PRIVATE_SIGNATURE", redacted: true }, { type: "text", text: answer }], usage: { reasoning: 27, output: 50 }, stopReason: "stop" }];
    const original = JSON.stringify(f.retained), page = await f.act("poll");
    bounded(page);
    assert.equal(page.entries.at(-1)!.thinkingTokens, 27);
    assert.doesNotMatch(page.entries.at(-1)!.text, /\[thinking:/);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE_REASONING|PRIVATE_SIGNATURE/);
    assert.equal(JSON.stringify(f.retained), original);
  } finally { await f.close(); }
});

test("TUI thinking metadata omits zero/missing counts and keeps literal answer text separate", async () => {
  const f = await fixture(1);
  try {
    const literal = "Example: [thinking: 0 tokens]\n```\n[thinking: 27 tokens]\n```";
    for (const usage of [undefined, { reasoning: 0, output: 50 }, { reasoning: 1, output: 50 }]) {
      f.retained.at(-1)!.model = [{ role: "assistant", content: [{ type: "text", text: literal }], usage, stopReason: "stop" }];
      const original = JSON.stringify(f.retained), page = await f.act("poll");
      assert.equal(page.entries.at(-1)!.text, literal);
      assert.equal(page.entries.at(-1)!.thinkingTokens, usage?.reasoning || undefined);
      assert.equal(JSON.stringify(f.retained), original); bounded(page);
    }
    f.retained.at(-1)!.model = [2, 3].map(reasoning => ({ role: "assistant", content: [{ type: "text", text: "Answer" }], usage: { reasoning, output: 10 } }));
    assert.equal((await f.act("poll")).entries.at(-1)!.thinkingTokens, 5);
    f.retained.at(-1)!.model = [1, 2].map(() => ({ role: "assistant", content: [{ type: "text", text: "Answer" }], usage: { reasoning: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER } }));
    assert.equal((await f.act("poll")).entries.at(-1)!.thinkingTokens, undefined);
  } finally { await f.close(); }
});

test("TUI view budget cannot hide a retained generation failure", async () => {
  const f = await fixture();
  try {
    f.retained.at(-1)!.model = [{ role: "assistant", content: [{ type: "text", text: "Generation failed" }], stopReason: "error" }];
    f.activity.agentStatus.state = "error";
    const original = JSON.stringify(f.retained), page = await f.act("poll"); bounded(page);
    assert.equal(page.entries.at(-1)!.text, "Generation failed\n[error]");
    assert.equal(page.agentStatus!.state, "error"); assert.equal(page.busy, false);
    assert.equal(JSON.stringify(f.retained), original);
  } finally { await f.close(); }
});

for (const count of [60, 96]) test(`TUI byte-limited older pages expose every retained ID (${count} older entries)`, async () => {
  const f = await fixture(count);
  try {
    const original = JSON.stringify(f.retained), seen: number[] = [];
    let page = await f.act("poll");
    assert.equal(f.requests.at(-1).args.limit, 80); assert.equal(f.retained.length < 80, count === 60);
    // The byte budget shortens even a server page with no continuation cursor.
    assert.equal(page.hasOlder, true);
    for (let visits = 0; ; visits++) {
      assert.ok(visits < f.retained.length, "older cursor must make progress"); bounded(page);
      seen.push(...page.entries.slice().reverse().map(entry => entry.id));
      if (!page.hasOlder) break;
      const oldest = page.entries[0]!.id;
      page = await f.act("older"); assert.equal(page.historical, true);
      assert.equal(f.requests.at(-1).args.before, String(oldest));
      assert.ok(page.entries.at(-1)!.id < oldest);
      const entries = structuredClone(page.entries);
      page = await f.act("poll"); assert.deepEqual(page.entries, entries);
      assert.deepEqual(f.requests.slice(-2).map(request => request.command), ["activity", "progress"]);
    }
    assert.deepEqual(seen, f.retained.slice().reverse().map(entry => entry.id));
    assert.equal(new Set(seen).size, seen.length);
    const latest = await f.act("latest"); bounded(latest);
    assert.equal(latest.historical, false); assert.equal(latest.entries.at(-1)!.text, answer);
    assert.equal(f.requests.at(-1).args.before, undefined);
    assert.equal(JSON.stringify(f.retained), original);
    assert.ok(f.requests.every(request => ["status", "history", "activity", "progress"].includes(request.command)));
  } finally { await f.close(); }
});

const binary = process.env.DECK_TEST_BINARY;
test("real PTY: large retained tool output cannot hide the latest answer or a new follow-up", { skip: !binary, timeout: 20_000 }, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined, closed: Promise<any[]> | undefined;
  try {
    const driver = fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url));
    child = spawn("python3", [driver, resolve(binary!), "agent", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } });
    closed = once(child, "close"); let output = "", errors = "";
    child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { errors += String(chunk); });
    child.stdin!.end(JSON.stringify([{ wait: answer }, { wait: "output truncated after 8 lines" }, { keys: "What happened?" }, { keys: "\r" }, { wait: "Input admitted" }, { wait: followup }, { keys: "\x1b" }, { keys: ":q\r" }]));
    assert.equal((await closed)[0], 0, errors);
    const result = JSON.parse(output); assert.equal(result.restored, true);
    const terminal = Buffer.from(result.output, "base64").toString(); assert.doesNotMatch(terminal, /\[view budget\]|DO_NOT_RENDER/);
    const admits = f.requests.filter(request => request.command === "admit"); assert.equal(admits.length, 1); assert.equal(admits[0].args.text, "What happened?");
    assert.ok(f.requests.every(request => ["status", "history", "activity", "progress", "admit"].includes(request.command)));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed; await f.close();
  }
});
