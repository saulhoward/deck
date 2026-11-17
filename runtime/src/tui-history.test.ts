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
import { flattenParts } from "./tui-content.js";
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
  for (const entry of snapshot.entries) {
    assert.ok(entry.parts && entry.parts.length <= 256);
    assert.equal(entry.text, flattenParts(entry.parts));
    assert.ok(entry.parts.every(part => part.text.isWellFormed() && Buffer.byteLength(part.text) <= 8192));
  }
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
    assert.ok(first.entries.some(entry => entry.parts?.some(part => part.kind === "tool" && part.clipped)));
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
    // Hidden-only entries still occupy canonical cursor positions, including
    // positions at byte-limited page boundaries.
    for (let i = 2; i < count; i += 6) f.retained[i] = { id: f.retained[i]!.id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }], usage: { reasoning: 7, output: 10 } }] };
    const original = JSON.stringify(f.retained), seen: number[] = [];
    let hidden = 0;
    let page = await f.act("poll");
    assert.equal(f.requests.at(-1).args.limit, 80); assert.equal(f.retained.length < 80, count === 60);
    // The byte budget shortens even a server page with no continuation cursor.
    assert.equal(page.hasOlder, true);
    for (let visits = 0; ; visits++) {
      assert.ok(visits < f.retained.length, "older cursor must make progress"); bounded(page);
      seen.push(...page.entries.slice().reverse().map(entry => entry.id));
      hidden += page.entries.filter(entry => entry.parts?.length === 0 && entry.text === "" && entry.thinkingTokens === 7).length;
      assert.doesNotMatch(JSON.stringify(page), /PRIVATE_REASONING|\[non-text content\]/);
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
    assert.equal(hidden, Math.ceil((count - 2) / 6));
    const latest = await f.act("latest"); bounded(latest);
    assert.equal(latest.historical, false); assert.equal(latest.entries.at(-1)!.text, answer);
    assert.equal(f.requests.at(-1).args.before, undefined);
    assert.equal(JSON.stringify(f.retained), original);
    assert.ok(f.requests.every(request => ["status", "history", "activity", "progress"].includes(request.command)));
  } finally { await f.close(); }
});

test("TUI wire budget also paginates many tiny parts without skipping hidden canonical IDs", async () => {
  const local = await clientEnv();
  try {
    const retained = Array.from({ length: 83 }, (_, i) => ({ id: (i + 1) * 5, kind: i % 10 === 0 ? "pi.assistant" : "pi.tool-result", model: i % 10 === 0 ? [{ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }] }] : Array.from({ length: 256 }, () => ({ role: "toolResult", toolName: "bash", isError: false, content: [] })) }));
    const session = new TuiSession(async (name, args) => {
      if (name === "status") return { hubId, hubGuard: 1, mainChatId: "1", chatId: "1", model: { provider: "mock", modelId: "echo" }, tools: "offline" };
      assert.equal(name, "history");
      const eligible = retained.filter(entry => args.before === undefined || entry.id < Number(args.before)).reverse(), items = eligible.slice(0, Number(args.limit));
      return { items, ...(eligible.length > items.length ? { next: String(items.at(-1)!.id) } : {}) };
    }, undefined, undefined, local.env.DECK_CLIENT_STATE_DIRECTORY);
    let sequence = 0;
    const act = (action: "poll" | "older") => session.handle({ version: 1, id: String(++sequence), action });
    let page = await act("poll");
    assert.equal(page.hasOlder, true);
    const seen: number[] = [];
    for (;;) {
      bounded(page);
      assert.doesNotMatch(JSON.stringify(page), /PRIVATE_REASONING/);
      seen.push(...page.entries.slice().reverse().map(entry => entry.id));
      if (!page.hasOlder) break;
      page = await act("older");
    }
    assert.deepEqual(seen, retained.slice().reverse().map(entry => entry.id));
  } finally { await local.close(); }
});

test("TUI reply validation enforces flattened provenance, UTF-8 aggregate bounds and legacy compatibility", async () => {
  const f = await fixture(1);
  try {
    const snapshot = await f.act("poll");
    const valid = (value: TuiSnapshot) => validReply({ version: 1, id: "check", ok: true, snapshot: value }, "check", hubId, "1");
    assert.equal(valid(snapshot), true);
    const legacy = structuredClone(snapshot);
    for (const entry of legacy.entries) delete entry.parts;
    assert.equal(valid(legacy), true);
    const wrong = structuredClone(snapshot);
    wrong.entries.at(-1)!.parts = [{ kind: "notice", text: "different projection" }];
    assert.equal(valid(wrong), false);
    const oversized = "🧪".repeat(8192);
    wrong.entries = [{ id: 1, role: "assistant", text: oversized, parts: [{ kind: "text", text: oversized }] }];
    assert.equal(valid(wrong), false);
    wrong.entries = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, role: "assistant", text: "x".repeat(8192), parts: [{ kind: "text", text: "x".repeat(8192) }] }));
    assert.equal(valid(wrong), false);
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
    child.stdin!.end(JSON.stringify([{ wait: answer }, { wait: "bash (×" }, { keys: "What happened?" }, { keys: "\r" }, { wait: "Input admitted" }, { wait: followup }, { keys: "\x1b" }, { keys: ":q\r" }]));
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

test("real PTY: consecutive bash results show one multiplier and only the latest eight lines", { skip: !binary, timeout: 20_000 }, async () => {
  const f = await fixture(1);
  let child: ReturnType<typeof spawn> | undefined, closed: Promise<any[]> | undefined;
  try {
    f.retained.length = 0;
    for (let i = 0; i < 6; i++) {
      f.retained.push({ id: 3 * i + 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "toolCall", name: "bash", id: `call-${i}`, arguments: { command: "PRIVATE_ARGS" } }], usage: { reasoning: 2, output: 10 } }] });
      f.retained.push({ id: 3 * i + 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "image", data: "PRIVATE_IMAGE" }] }] });
      const output = i === 5 ? "PREFIX_OMITTED\n" + "界".repeat(4000) + "\n" + Array.from({ length: 10 }, (_, n) => `latest line ${n + 1}`).join("\n") + "\n" : `old output ${i}`;
      f.retained.push({ id: 3 * i + 3, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: output }] }] });
    }
    f.retained.push({ id: 19, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Final answer" }], stopReason: "error" }] });
    const original = JSON.stringify(f.retained);
    const driver = fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url));
    child = spawn("python3", [driver, resolve(binary!), "agent", "--tui", "--port", String(f.port)], { env: { ...f.local.env, DECK_NODE: process.execPath } });
    closed = once(child, "close"); let output = "", errors = "";
    child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { errors += String(chunk); });
    child.stdin!.end(JSON.stringify([{ wait: "bash (×6)" }, { wait: "[error]" }, { capture: "compact" }, { resize: [40, 60] }, { wait: "bash (×6)" }, { capture: "narrow" }, { keys: "\x1b" }, { keys: ":q\r" }]));
    assert.equal((await closed)[0], 0, errors);
    const result = JSON.parse(output); assert.equal(result.restored, true);
    for (const screen of Object.values(result.screens) as string[]) {
      assert.equal(screen.match(/bash \(×6\)/g)?.length, 1);
      assert.equal(screen.match(/latest line /g)?.length, 8);
      for (let n = 3; n <= 10; n++) assert.ok(screen.includes(`latest line ${n}`));
      assert.match(screen, /\[thinking: 12 tokens\]/);
      assert.match(screen, /Final answer/); assert.match(screen, /\[error\]/);
      assert.doesNotMatch(screen, /old output|PREFIX_OMITTED|tool requested|non-text content|output truncated|PRIVATE_/);
    }
    assert.equal(JSON.stringify(f.retained), original);
    assert.ok(f.requests.every(request => ["status", "history"].includes(request.command)));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed; await f.close();
  }
});
