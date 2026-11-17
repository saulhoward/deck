import assert from "node:assert/strict";
import test from "node:test";
import { flattenParts, projectEntry, sanitizeText } from "./tui-content.js";
import { validTuiEntry, validTuiPart, type HistoryEntry, type TuiEntry } from "./generated/contracts.js";

const text = (text: string) => ({ type: "text", text });
const thinking = { type: "thinking", thinking: "SECRET_REASONING", thinkingSignature: "SECRET_SIGNATURE" };
const image = { type: "image", data: "SECRET_IMAGE", mimeType: "image/png" };
const assistant = (content: unknown[], extra = {}) => ({ role: "assistant", content, ...extra });
const tool = (toolName: string, output: string, extra = {}) => ({ role: "toolResult", toolName, isError: false, content: [text(output)], ...extra });
function project(entry: Omit<HistoryEntry, "id">): TuiEntry {
  const original: HistoryEntry = { id: 42, kind: "pi.assistant", ...entry };
  const copy = structuredClone(original), result = projectEntry(original);
  assert.deepEqual(original, copy);
  assert.equal(result.id, 42);
  assert.equal(validTuiEntry(result), true);
  assert.ok(result.parts && result.parts.length <= 256);
  assert.equal(result.text, flattenParts(result.parts));
  assert.ok(Buffer.byteLength(result.text) <= 8192);
  assert.ok(result.parts.every(part => part.text.isWellFormed()));
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|\\u001b|\\u009[0bdef]/);
  return result;
}

test("content provenance distinguishes literal bracket text from generated notices and requests", () => {
  const literal = "[non-text content]\n[error]\n[aborted]\n[view clipped]\n[tool requested: bash]\n```\n[literal code]\n```";
  const user = project({ kind: "deck.input", data: { text: literal } });
  assert.deepEqual(user.parts, [{ kind: "text", text: literal }]);
  const result = project({ kind: "pi.assistant", model: [assistant([thinking, text(literal), image, { type: "toolCall", name: "bash", arguments: { command: "SECRET_ARGUMENTS" } }], { stopReason: "error", errorMessage: "SECRET_DIAGNOSTIC", usage: { reasoning: 27, output: 50 } })] });
  assert.deepEqual(result.parts, [{ kind: "text", text: literal }, { kind: "tool_request", toolName: "bash", text: "[tool requested: bash]" }, { kind: "notice", text: "[error]" }]);
  assert.equal(result.thinkingTokens, 27);
  assert.equal(result.text, `${literal}\n[tool requested: bash]\n[error]`);
});

test("hidden blocks add no placeholders, parts, blank separators or lost IDs", () => {
  const hidden = project({ kind: "pi.assistant", model: [assistant([thinking, image, { type: "future", value: "SECRET_FUTURE" }], { usage: { reasoning: 12, output: 30 } })] });
  assert.deepEqual(hidden, { id: 42, role: "assistant", text: "", parts: [], thinkingTokens: 12 });
  const mixed = project({ kind: "pi.assistant", model: [assistant([thinking, text("first"), image, text("last")]), assistant([thinking])] });
  assert.deepEqual(mixed.parts, [{ kind: "text", text: "first" }, { kind: "text", text: "last" }]);
  assert.equal(mixed.text, "first\nlast");
  assert.deepEqual(project({ kind: "pi.assistant", model: [assistant([thinking], { stopReason: "aborted" })] }).parts, [{ kind: "notice", text: "[aborted]" }]);
});

test("agent input provenance is a notice, never part of the message text", () => {
  const result = project({ kind: "deck.input", data: { text: "[error] is literal", requestId: "req", origin: { kind: "task-tool", chatId: "3", taskId: "9", chain: { replyToChatId: "1", replyToRequestId: "parent", hop: 2 } } } });
  assert.equal(result.role, "note");
  assert.deepEqual(result.parts, [{ kind: "notice", text: "[agent chat 3, task 9; request req; reply 1/parent; hop 2/8]" }, { kind: "text", text: "[error] is literal" }]);
  assert.deepEqual(project({ kind: "future.kind", data: { private: "SECRET_DATA" } }).parts, [{ kind: "notice", text: "[future.kind: retained entry, not rendered]" }]);
});

test("every tool-result message projects output only, with headings retained in flat compatibility text", () => {
  const result = project({ kind: "pi.tool-result", model: [tool("bash", "unused", { content: [thinking, text("one"), image, text("two")] }), tool("read", "[non-text content]\n[error]", { isError: true }), tool("bash", "unused", { content: [image] })] });
  assert.deepEqual(result.parts, [{ kind: "tool", toolName: "bash", isError: false, text: "one\ntwo" }, { kind: "tool", toolName: "read", isError: true, text: "[non-text content]\n[error]" }, { kind: "tool", toolName: "bash", isError: false, text: "" }]);
  assert.equal(result.text, "bash\none\ntwo\nread (error)\n[non-text content]\n[error]\nbash\n");
});

test("large bash output retains sanitized Unicode tail rows without clipping labels in output", () => {
  const rows = Array.from({ length: 8 }, (_, i) => `last ${i + 1}: 界 é 👩🏽‍💻`).join("\n");
  const output = "PREFIX_MUST_BE_OMITTED\n" + "🧪".repeat(12000) + "\n\x1b]52;c;SECRET_OSC\x07\x1b[31m" + rows + "\x1b[0m\n\x9dSECRET_C1_OSC\x9c\x1bPSECRET_DCS\x1b\\\x1b]52;c;SECRET_UNTERMINATED";
  const result = project({ kind: "pi.tool-result", model: [tool("bash", output)] });
  assert.equal(result.parts!.length, 1);
  const part = result.parts![0]!;
  assert.equal(part.kind, "tool"); assert.equal(part.clipped, true);
  assert.equal(part.text.trimEnd().split("\n").slice(-8).join("\n"), rows);
  assert.doesNotMatch(part.text, /PREFIX_MUST_BE_OMITTED|\[view clipped\]|\[non-text content\]/);
  assert.equal(part.text.endsWith(rows + "\n"), true);
});

test("multiple large tool results each survive, including the latest bash tail", () => {
  const result = project({ kind: "pi.tool-result", model: [tool("bash", "a".repeat(20000) + "\nfirst tail"), tool("read", "read prefix\n" + "界".repeat(20000)), tool("bash", "b".repeat(20000) + "\nlatest tail 🧪")] });
  assert.equal(result.parts!.length, 3);
  assert.ok(result.parts!.every(part => part.kind === "tool" && part.clipped));
  assert.ok(result.parts![0]!.text.endsWith("first tail"));
  assert.ok(result.parts![1]!.text.startsWith("read prefix"));
  assert.ok(result.parts![2]!.text.endsWith("latest tail 🧪"));
});

test("long literal answers clip with separate notices and cannot hide generation failure", () => {
  for (const stopReason of ["error", "aborted"]) {
    const result = project({ kind: "pi.assistant", model: [assistant([text("[view clipped] literal\n" + "👩🏽‍💻".repeat(4000))], { stopReason, usage: { reasoning: 27, output: 50 } })] });
    assert.equal(result.parts![0]!.kind, "text");
    assert.ok(result.parts![0]!.text.startsWith("[view clipped] literal\n"));
    assert.deepEqual(result.parts!.slice(-2), [{ kind: "notice", text: "[view clipped]" }, { kind: "notice", text: `[${stopReason}]` }]);
    assert.equal(result.thinkingTokens, 27);
    assert.ok(result.text.endsWith(`[view clipped]\n[${stopReason}]`));
  }
});

test("part count and aggregate heading overflow are explicit and preserve late failure", () => {
  const exact = project({ kind: "pi.assistant", model: [assistant(Array.from({ length: 256 }, () => text("a")))] });
  assert.equal(exact.parts!.length, 256);
  assert.ok(exact.parts!.every(part => part.kind === "text"));
  for (const content of [Array.from({ length: 1000 }, () => text("a")), Array.from({ length: 256 }, () => text("x".repeat(100)))]) {
    const result = project({ kind: "pi.assistant", model: [assistant(content, { stopReason: "error" }), assistant([], { stopReason: "aborted" })] });
    assert.ok(result.parts!.some(part => part.kind === "notice" && part.text === "[view clipped]"));
    assert.deepEqual(result.parts!.slice(-2), [{ kind: "notice", text: "[error]" }, { kind: "notice", text: "[aborted]" }]);
  }
  const tools = project({ kind: "pi.tool-result", model: Array.from({ length: 256 }, () => tool("a".repeat(128), "output")) });
  assert.ok(tools.parts!.length < 256);
  assert.deepEqual(tools.parts!.at(-1), { kind: "notice", text: "[view clipped]" });
});

test("sanitization handles complete and unterminated terminal control strings before clipping", () => {
  const dirty = "start\x1b]SECRET_OSC\x07\x9dSECRET_C1_OSC\x9c\x1bPSECRET_DCS\x1b\\\x1b_SECRET_APC\x1b\\\x1b^SECRET_PM\x1b\\\x1bXSECRET_SOS\x1b\\\x9b31mend\x1b[0m\t\x00\r";
  assert.equal(sanitizeText(dirty), "startend    ");
  for (const control of ["\x1b]", "\x9d", "\x1bP", "\x90", "\x1b_", "\x1b^", "\x1bX"]) assert.equal(sanitizeText("safe" + control + "SECRET_\n" + "x".repeat(9000)), "safe");
  assert.equal(sanitizeText("safe\x1b]SECRET_UNTERMINATED\n"), "safe");
  const acrossBlocks = project({ kind: "pi.tool-result", model: [tool("bash", "", { content: [text("safe\x1b]SECRET_START"), text("SECRET_CONTINUED\x07tail")] })] });
  assert.equal(acrossBlocks.parts![0]!.text, "safetail");
  assert.equal(sanitizeText("safe\x1b[31"), "safe");
  assert.equal(sanitizeText("safe\ud800"), "safe�");
});

test("projection budget holds across combinations of Unicode, metadata, and many messages", () => {
  for (const count of [1, 2, 10, 128, 253, 254, 255, 256, 257, 500]) {
    for (const length of [0, 4, 33, 8192]) {
      const model = Array.from({ length: count }, (_, i) => i % 3 === 0 ? tool("bash", "👩🏽‍💻".repeat(length) + `\nTAIL ${i}`) : tool("界".repeat(i % 100), "\\\"\n".repeat(length), { isError: i % 5 === 0, stopReason: i % 17 === 0 ? "error" : "stop" }));
      project({ kind: "pi.tool-result", model });
    }
  }
});


test("part string schema bounds accept the boundary and reject overflow in Unicode code points", () => {
  for (const unit of ["a", "🧪"]) {
    assert.equal(validTuiPart({ kind: "text", text: unit.repeat(8192) }), true);
    assert.equal(validTuiPart({ kind: "text", text: unit.repeat(8193) }), false);
    assert.equal(validTuiPart({ kind: "tool", text: "", toolName: unit.repeat(128) }), true);
    assert.equal(validTuiPart({ kind: "tool", text: "", toolName: unit.repeat(129) }), false);
  }
});
