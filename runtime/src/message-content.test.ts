import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { setup } from "./managed-child.test.support.js";
import { namedChildren } from "./subagent-view.test.support.js";
import { ChatDoc } from "./chat-doc.js";
import { dispatch, serveIpc } from "./ipc.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { responseResult } from "./responses.js";
import { messageContent, retainedMessageText } from "./message-content.js";
import { messageContentMaxBytes, validMessageContentPage } from "./message-content-contracts.js";
import { projectEntry, sanitizeText } from "./tui-content.js";
import { launcherResponse } from "./launcher-hub.js";
import type { MessageContentArgs, MessageContentPage, ResponseEnvelope } from "./generated/contracts.js";

function stored(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => ({ name: row.name, rows: db.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all() })); }
  finally { db.close(); }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deck-message-content-")), path = join(root, "pi.sqlite");
  const effects: string[] = [], f = setup({ hostFiles: { call: async (_binding, _id, op) => { effects.push(op); throw new Error("Unexpected effect"); } } });
  const runtime = await f.open(path);
  const append = async (chatId: string, value: EntryDraft) => {
    const chat = await runtime.chat(chatId);
    return chat.commit(tx => tx.appendEntry(chat.id, value), context);
  };
  const input = new PassThrough(), output = new PassThrough(), decoder = output.pipe(new FrameDecoder());
  const iterator = decoder[Symbol.asyncIterator](), serving = serveIpc(runtime, input, output);
  const call = async (args: unknown): Promise<ResponseEnvelope> => {
    const request = { version: 1, id: randomUUID(), command: "message_content", args, hubId: runtime.hubId };
    input.write(encodeFrame(request)); const next = await iterator.next(); assert.equal(next.done, false);
    const reply = next.value as ResponseEnvelope;
    if (reply.ok) responseResult(reply, request.id, request);
    return reply;
  };
  const read = async (args: MessageContentArgs) => { const reply = await call(args); assert.ok(reply.ok, JSON.stringify(reply)); return reply.result as MessageContentPage; };
  return { ...f, root, path, runtime, effects, append, call, read, chatId: String(runtime.main.id), close: async () => { input.end(); await serving; decoder.destroy(); output.destroy(); await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

test("full retained export preserves >8192 bytes and >256 parts, UTF-8 chunks, digest and sanitization without effects", async t => {
  const f = await fixture();
  try {
    const large = "a".repeat(32767) + "🧪日本語".repeat(5000);
    const texts = [large, ...Array.from({ length: 700 }, (_, i) => `visible block ${i} 日本語`), "\x1b]52;c;SECRET_OSC\x07last\ttext\ud800"];
    const visible = texts.map(text => ({ type: "text" as const, text }));
    const msg = fauxAssistantMessage("unused");
    const model = [{ ...msg, content: [{ type: "thinking", thinking: "SECRET_REASONING", thinkingSignature: "SECRET_SIGNATURE" }, ...visible, { type: "toolCall", id: "call", name: "bash", arguments: { command: "SECRET_ARGUMENTS" } }, { type: "image", data: "SECRET_IMAGE", mimeType: "image/png" }], stopReason: "error", errorMessage: "SECRET_DIAGNOSTIC" }] as unknown as EntryDraft["model"];
    const entry = await f.append(f.chatId, { kind: "pi.assistant", model: model! });
    const entryId = String(entry.id), expected = texts.map(sanitizeText).join("\n"), digest = createHash("sha256").update(expected).digest("hex");
    const projected = projectEntry({ id: entry.id, kind: entry.kind, model: entry.model });
    assert.ok(Buffer.byteLength(projected.text) <= 8192); assert.ok(projected.parts!.length <= 256);
    const before = stored(f.path), admit = t.mock.method(f.runtime, "admit"), open = t.mock.method(f.runtime, "openTerminal"), history = t.mock.method(f.runtime, "history", async () => { throw new Error("No latest/page fallback"); });
    let offset = 0, complete = "", chunks = 0;
    for (;;) {
      const args = { chatId: f.chatId, entryId, offset }, page = await f.read(args); chunks++;
      assert.ok(validMessageContentPage(page, args)); assert.equal(page.sha256, digest); assert.equal(page.totalBytes, Buffer.byteLength(expected));
      assert.equal(page.offset, offset); assert.equal(page.chatId, f.chatId); assert.equal(page.entryId, entryId);
      assert.ok(Buffer.byteLength(page.text) <= 32768); assert.ok(page.text.isWellFormed());
      assert.deepEqual(await f.read(args), page, "repeated exact read is stable");
      if (chunks === 1) { assert.equal(Buffer.byteLength(page.text), 32767); assert.equal(page.next, 32767); }
      complete += page.text;
      if (page.next === undefined) break;
      assert.equal(page.next, offset + Buffer.byteLength(page.text)); offset = page.next;
    }
    assert.ok(chunks > 2); assert.equal(complete, expected); assert.doesNotMatch(complete, /SECRET_|view clipped|tool requested/);
    const end = await f.read({ chatId: f.chatId, entryId, offset: Buffer.byteLength(expected) }); assert.equal(end.text, ""); assert.equal(end.next, undefined); assert.equal(end.sha256, digest);
    for (const offset of [32768, 32769, 32770, Buffer.byteLength(expected) + 1]) {
      const reply = await f.call({ chatId: f.chatId, entryId, offset }); assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.error.code, "invalid");
    }
    assert.deepEqual(stored(f.path), before); assert.deepEqual(f.effects, []); assert.equal(f.faux.state.callCount, 0);
    assert.equal(admit.mock.callCount(), 0); assert.equal(open.mock.callCount(), 0); assert.equal(history.mock.callCount(), 0);
  } finally { await f.close(); }
});

test("exact entry identity and conversation scope; no text/latest substitution or non-message leakage", async () => {
  const f = await fixture();
  try {
    const first = await f.append(f.chatId, { kind: "deck.input", data: { text: "original" } });
    const other = await f.runtime.createTask("other", f.options.binding), otherId = String(other.id);
    const foreign = await f.append(otherId, { kind: "deck.input", data: { text: "SECRET_FOREIGN" } });
    await f.append(f.chatId, { kind: "deck.input", data: { text: "newest not original" } });
    assert.equal((await f.read({ chatId: f.chatId, entryId: String(first.id), offset: 0 })).text, "original");
    for (const [chatId, entryId] of [[f.chatId, String(foreign.id)], [otherId, String(first.id)], [f.chatId, "9007199254740991"]]) {
      const reply = await f.call({ chatId, entryId, offset: 0 }); assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.error.code, "not_found"); assert.doesNotMatch(JSON.stringify(reply), /SECRET_FOREIGN/);
    }
    for (const draft of [
      { kind: "pi.tool-result", model: [{ role: "toolResult", content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }] }] },
      { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "SECRET_THINKING" }, { type: "toolCall", name: "bash", arguments: { command: "SECRET_ARGS" } }, { type: "image", data: "SECRET_IMAGE" }] }] },
      { kind: "deck.input", data: { text: "\x1b]52;c;SECRET_OSC\x07" } },
      { kind: "note", data: { text: "SECRET_METADATA" } },
    ]) {
      const entry = await f.append(f.chatId, draft as unknown as EntryDraft), reply = await f.call({ chatId: f.chatId, entryId: String(entry.id), offset: 0 });
      assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.error.code, "not_found"); assert.doesNotMatch(JSON.stringify(reply), /SECRET_/);
    }
    for (const args of [{}, { chatId: f.chatId, entryId: String(first.id) }, { chatId: f.chatId, entryId: String(first.id), offset: 0, text: "forbidden" }, { chatId: f.chatId, entryId: "01", offset: 0 }]) {
      const reply = await f.call(args); assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.error.code, "invalid");
    }
    assert.equal(f.faux.state.callCount, 0); assert.deepEqual(f.effects, []);
  } finally { await f.close(); }
});

test("exports are sanitized visible text, include agent-origin notice, and reject the whole oversize export", async () => {
  const data = { text: "Visible\tmessage", requestId: "request-1", origin: { kind: "task-tool", chatId: "2", taskId: "3" } };
  assert.equal(retainedMessageText({ kind: "deck.input", data }), "[agent chat 2, task 3]\nVisible    message");
  assert.equal(retainedMessageText({ kind: "deck.input", data: { text: "x".repeat(messageContentMaxBytes) } }).length, messageContentMaxBytes);
  assert.throws(() => retainedMessageText({ kind: "deck.input", data: { text: "x".repeat(messageContentMaxBytes + 1) } }), { code: "too_large" });
  assert.throws(() => retainedMessageText({ kind: "deck.input", data: { text: "\t".repeat(messageContentMaxBytes / 4 + 1) } }), { code: "too_large" }, "limit applies after sanitization");
  const f = await fixture();
  try {
    const entry = await f.append(f.chatId, { kind: "deck.input", data: { text: "x".repeat(messageContentMaxBytes + 1) } });
    for (const offset of [0, 32768]) {
      const reply = await f.call({ chatId: f.chatId, entryId: String(entry.id), offset }); assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.error.code, "too_large"); assert.ok(JSON.stringify(reply).length < 512);
    }
  } finally { await f.close(); }
});

test("captured subagent message reads retain parent attachment authority and recheck ownership on every page", async t => {
  const f = await fixture();
  try {
    const parent = await f.runtime.createTask("attached parent", f.options.binding), parentId = String(parent.id);
    const [child] = await namedChildren(f.runtime, parentId), [foreign] = await namedChildren(f.runtime, f.chatId);
    const entry = await f.append(child!.chatId, { kind: "deck.input", data: { text: "child message ".repeat(5000) } });
    const foreignEntry = await f.append(foreign!.chatId, { kind: "deck.input", data: { text: "SECRET_FOREIGN" } });
    const inner = (command: string, args: object) => ({ version: 1, id: "read", command, args, hubId: f.runtime.hubId });
    const attached = async (request: ReturnType<typeof inner>) => {
      const outer = JSON.parse(await launcherResponse(f.runtime, f.options.binding.machineId, true, { connectionId: "a".repeat(64), id: "b".repeat(64), launcher: { hubId: f.runtime.hubId }, body: JSON.stringify({ version: 1, id: randomUUID(), command: "launch_task", args: { chatId: parentId, body: JSON.stringify(request) } }) }));
      if (!outer.ok) return outer;
      const reply = JSON.parse(outer.result.body); if (reply.ok) responseResult(reply, "read", request); return reply;
    };
    const args = { chatId: parentId, childId: child!.chatId, operation: "message_content", options: { entryId: String(entry.id), offset: 0 } };
    const before = stored(f.path), admit = t.mock.method(f.runtime, "admit"), open = t.mock.method(f.runtime, "openTerminal");
    const first = await attached(inner("subagent_view", args)); assert.equal(first.ok, true); assert.equal(first.result.result.chatId, child!.chatId); assert.equal(first.result.parentChatId, parentId);
    const secondArgs = { ...args, options: { ...args.options, offset: first.result.result.next } }, second = await attached(inner("subagent_view", secondArgs));
    assert.ok(second.ok); assert.equal(second.result.result.sha256, first.result.result.sha256); assert.equal(second.result.result.totalBytes, first.result.result.totalBytes);
    for (const request of [
      inner("message_content", { chatId: child!.chatId, entryId: String(entry.id), offset: 0 }),
      inner("message_content", { chatId: parentId, entryId: String(entry.id), offset: 0 }),
      inner("subagent_view", { ...args, childId: foreign!.chatId, options: { entryId: String(foreignEntry.id), offset: 0 } }),
      inner("subagent_view", { ...args, options: { entryId: String(foreignEntry.id), offset: 0 } }),
      inner("subagent_view", { ...args, operation: "admit" }),
    ]) {
      const reply = await attached(request).catch(error => { assert.match(String(error), /Invalid launcher request/); return { ok: false }; });
      assert.equal(reply.ok, false); assert.doesNotMatch(JSON.stringify(reply), /SECRET_FOREIGN/);
    }
    assert.deepEqual(stored(f.path), before); assert.equal(admit.mock.callCount(), 0); assert.equal(open.mock.callCount(), 0); assert.deepEqual(f.effects, []); assert.equal(f.faux.state.callCount, 0);
    const selected = await f.runtime.chat(child!.chatId);
    await selected.commit(async tx => { (await tx.doc(ChatDoc, selected.id)).ownerTaskId = "1"; }, context);
    assert.equal((await attached(inner("subagent_view", secondArgs))).ok, false, "captured child ID is not a reusable grant");
  } finally { await f.close(); }
});

test("UTF-8 byte offsets work across all codepoint widths, and captured read results are suppressed after ownership drift", async () => {
  const f = await fixture();
  try {
    for (const cp of ["é", "日", "🧪"]) {
      const width = Buffer.byteLength(cp);
      for (let cut = 1; cut < width; cut++) {
        const prefix = "x".repeat(32768 - cut), text = prefix + cp + "tail";
        const entry = await f.append(f.chatId, { kind: "deck.input", data: { text } });
        const args = { chatId: f.chatId, entryId: String(entry.id), offset: 0 };
        const page = await messageContent(f.runtime, args);
        assert.equal(page.text, prefix); assert.equal(page.next, prefix.length);
        const tail = await messageContent(f.runtime, { ...args, offset: page.next! });
        assert.equal(tail.text, cp + "tail"); assert.equal(tail.sha256, page.sha256);
        for (let byte = 1; byte < width; byte++) await assert.rejects(messageContent(f.runtime, { ...args, offset: prefix.length + byte }), { code: "invalid" });
      }
    }
    const [child] = await namedChildren(f.runtime, f.chatId), selected = await f.runtime.chat(child!.chatId);
    const entry = await f.append(child!.chatId, { kind: "deck.input", data: { text: "SECRET_AFTER_DRIFT" } });
    const { subagentView } = await import("./subagent-view.js");
    await assert.rejects(subagentView(f.runtime, { chatId: f.chatId, childId: child!.chatId, operation: "message_content", options: { entryId: String(entry.id), offset: 0 } }, async (_command, args) => {
      const page = await messageContent(f.runtime, args as MessageContentArgs);
      await selected.commit(async tx => { (await tx.doc(ChatDoc, selected.id)).parentChatId = "999999"; }, context);
      return page;
    }), { code: "not_found" });
  } finally { await f.close(); }
});
