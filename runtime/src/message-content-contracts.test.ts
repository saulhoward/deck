import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validClientRequest } from "./command-contracts.js";
import { responseFrame, responseResult } from "./responses.js";
import { validMessageContentArgs, validMessageContentPage } from "./message-content-contracts.js";
import { failurePolicy } from "./command-policy.js";
import { validTuiRequest, validHubCommand, validSubagentViewOperation } from "./generated/contracts.js";

test("shared native/runtime message content request, byte, digest and nested correlation fixtures", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../../src/message_content.test.json", import.meta.url), "utf8"));
  for (const f of fixtures) {
    if (f.repeat) {
      let target = f;
      for (const key of f.repeat.path.slice(0, -1)) target = target[key];
      target[f.repeat.path.at(-1)] = f.repeat.text.repeat(f.repeat.count);
    }
    const before = JSON.stringify(f);
    if (!f.reply) assert.equal(validClientRequest(f.request), f.valid, f.name);
    else {
      if (f.valid) assert.equal(responseResult(f.reply, f.request.id, f.request), f.reply.result, f.name);
      else assert.throws(() => responseResult(f.reply, f.request.id, f.request), f.name);
      const frame = JSON.parse(responseFrame(f.reply, f.request).subarray(4).toString());
      assert.equal(frame.ok, f.valid, f.name);
      if (!f.valid) { assert.equal(frame.error.code, "invalid_response"); assert.equal(frame.result, undefined); }
    }
    assert.equal(JSON.stringify(f), before, f.name);
  }
});
test("public message export wire additions remain optional on the renderer bridge", () => {
  assert.ok(validHubCommand("message_content")); assert.ok(validSubagentViewOperation("message_content"));
  assert.ok(validTuiRequest({ version: 1, id: "a", action: "poll" }));
  assert.ok(validTuiRequest({ version: 1, id: "a", action: "messageContent", entryId: "4", offset: 0 }));
  for (const offset of [-1, 0.5, 16777217, "0"]) assert.equal(validTuiRequest({ version: 1, id: "a", action: "messageContent", entryId: "4", offset }), false);
  for (const value of [null, {}, { chatId: "1", entryId: "2", offset: NaN }, { chatId: "1", entryId: "2", offset: Infinity }]) assert.equal(validMessageContentArgs(value), false);
  const args = { chatId: "1", entryId: "2", offset: 0 };
  for (const text of ["\ud800", "\udfff"]) assert.equal(validMessageContentPage({ ...args, totalBytes: 3, text, sha256: createHash("sha256").update(text).digest("hex") }, args), false);
});
test("message export failures never imply effects or automatic retry", () => {
  for (const source of ["local", "remote", "transport"] as const) for (const code of ["too_large", "invalid_response", "future_error"]) {
    assert.deepEqual(failurePolicy("message_content", code, source), { outcome: source === "local" ? "not_sent" : "read_only", action: source === "local" ? "fix_request" : "retry_read", preserveDrafts: true, automaticMutationRetry: false });
  }
});
