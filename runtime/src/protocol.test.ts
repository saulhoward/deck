import assert from "node:assert/strict";
import test from "node:test";
import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "./protocol.js";

async function decode(chunks: Buffer[]) {
  const decoder = new FrameDecoder();
  const result = (async () => { const values: unknown[] = []; for await (const value of decoder) values.push(value); return values; })();
  for (const chunk of chunks) decoder.write(chunk);
  decoder.end();
  return result;
}

test("IPC handles split headers, UTF-8 split across chunks, and coalesced frames", async () => {
  const values = [{ version: 1, id: "a", text: "👩🏽‍💻 café" }, { version: 1, id: "b" }];
  const frames = Buffer.concat(values.map(encodeFrame));
  assert.deepEqual(await decode([...frames].map((byte) => Buffer.from([byte]))), values);
  assert.deepEqual(await decode([frames]), values);
});

test("IPC rejects oversize, zero, truncated, non-object, malformed JSON and invalid UTF-8 frames", async () => {
  const oversize = Buffer.alloc(4); oversize.writeUInt32BE(MAX_FRAME_BYTES + 1);
  for (const chunks of [[oversize], [Buffer.alloc(4)], [Buffer.from([0, 0])], [encodeFrame({}).subarray(0, 5)], [encodeFrame(null)], [Buffer.from([0, 0, 0, 1, 0xff])], [Buffer.from([0, 0, 0, 1, 0x7b])]]) {
    await assert.rejects(decode(chunks));
  }
  assert.throws(() => encodeFrame({ text: "x".repeat(MAX_FRAME_BYTES) }));
});
