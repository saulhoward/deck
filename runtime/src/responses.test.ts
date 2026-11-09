import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { DeckRuntime } from "./deck.js";
import { validResponseEnvelope, type ResponseEnvelope } from "./generated/contracts.js";
import { serveIpc } from "./ipc.js";
import { encodeFrame, MAX_FRAME_BYTES } from "./protocol.js";
import { HubError, responseFrame, responseResult } from "./responses.js";

const success = { version: 1, id: "exact-id", ok: true, result: { submissionId: "9" } };
const failure = { version: 1, id: "exact-id", ok: false, error: { code: "future_code", message: "Read the original outcome" } };
const unpack = (frame: Buffer): unknown => {
  assert.equal(frame.readUInt32BE(), frame.length - 4);
  const value: unknown = JSON.parse(frame.subarray(4).toString("utf8"));
  assert.ok(validResponseEnvelope(value)); return value;
};

test("response envelopes require exact transport identity before exposing results or errors", () => {
  assert.deepEqual(responseResult(success, "exact-id"), success.result);
  // Payloads remain opaque at this boundary. They are not command-specific ACKs.
  assert.equal(responseResult({ ...success, result: null }, "exact-id"), null);
  assert.throws(() => responseResult(failure, "exact-id"), (error) => error instanceof HubError && error.code === "future_code" && error.message === failure.error.message);
  for (const value of [null, [], { ok: true, result: success.result }, { ...success, version: 2 }, { ...success, id: "other-id" }, { ...success, ok: 1 }, { ...success, error: failure.error }, { ...failure, result: {} }, { ...failure, id: "other-id" }, { ...failure, error: { message: "PRIVATE_INVALID_MESSAGE" } }]) {
    assert.throws(() => responseResult(value, "exact-id"), (error) => error instanceof Error && !(error instanceof HubError) && /not acknowledged/.test(error.message) && !error.message.includes("PRIVATE"));
  }
  assert.throws(() => responseResult(success, "EXACT-ID"), /not acknowledged/);
});

test("serialized response egress rejects missing/toJSON/private errors and separates oversized output", () => {
  assert.deepEqual(unpack(responseFrame(success as ResponseEnvelope)), success);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const value of [
    { ...success, result: undefined }, { ...success, result: circular }, { ...success, result: 1n },
    { ...success, toJSON: () => ({ ...success, id: "another-id" }) },
    { ...success, toJSON: () => { throw new Error("PRIVATE_SERIALIZER_FAILURE"); } },
    { ...failure, error: { code: "bad-code", message: "PRIVATE_INVALID_ERROR" } },
    { ...failure, error: { code: "invalid", message: "x".repeat(4097) } },
  ]) {
    const frame = responseFrame(value as ResponseEnvelope);
    assert.deepEqual(unpack(frame), { version: 1, id: "exact-id", ok: false, error: { code: "invalid_response", message: "Runtime response invalid; inspect the request outcome before retrying" } });
    assert.doesNotMatch(frame.toString(), /PRIVATE/);
  }
  const oversized = unpack(responseFrame({ ...success, result: "x".repeat(MAX_FRAME_BYTES) } as ResponseEnvelope));
  assert.deepEqual(oversized, { version: 1, id: "exact-id", ok: false, error: { code: "too_large", message: "Response exceeds IPC limit" } });
});

test("invalid post-commit IPC egress returns correlated uncertainty, never dispatches again", async () => {
  let commits = 0;
  const runtime = { hubId: "hub", registerTerminalStartup: async () => { commits++; return undefined; } } as unknown as DeckRuntime;
  const input = new PassThrough(), output = new PassThrough(); const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const serving = serveIpc(runtime, input, output);
  input.end(encodeFrame({ version: 1, id: "original-id", command: "rex_startup", hubId: "hub", args: { chatId: "2", allocationId: "11111111-1111-4111-8111-111111111111", blockId: "block:11111111-1111-4111-8111-111111111111" } }));
  await serving;
  assert.equal(commits, 1);
  assert.deepEqual(unpack(Buffer.concat(chunks)), { version: 1, id: "original-id", ok: false, error: { code: "invalid_response", message: "Runtime response invalid; inspect the request outcome before retrying" } });
  input.destroy(); output.destroy();
});
