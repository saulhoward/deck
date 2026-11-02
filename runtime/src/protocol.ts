import { Transform, type TransformCallback } from "node:stream";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;

// Four-byte unsigned big-endian byte length, followed by UTF-8 JSON. No newline framing.
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) throw new Error("Invalid IPC frame length");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameDecoder extends Transform {
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private body: Buffer | undefined;
  private bodyUsed = 0;
  constructor() { super({ readableObjectMode: true }); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.headerUsed, chunk.length - offset);
          chunk.copy(this.header, this.headerUsed, offset, offset + count);
          this.headerUsed += count; offset += count;
          if (this.headerUsed !== 4) continue;
          const length = this.header.readUInt32BE();
          if (!length || length > MAX_FRAME_BYTES) throw new Error("Invalid IPC frame length");
          this.body = Buffer.alloc(length); this.bodyUsed = 0;
        }
        const count = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
        chunk.copy(this.body, this.bodyUsed, offset, offset + count);
        this.bodyUsed += count; offset += count;
        if (this.bodyUsed === this.body.length) {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(this.body);
          const value: unknown = JSON.parse(text);
          if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("IPC frame must be an object");
          this.push(value);
          this.body = undefined; this.headerUsed = 0;
        }
      }
      done();
    } catch (error) { done(error as Error); }
  }
  override _flush(done: TransformCallback) {
    done(this.headerUsed || this.body ? new Error("Truncated IPC frame") : undefined);
  }
}
