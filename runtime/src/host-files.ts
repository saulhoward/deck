import { createReadStream, createWriteStream } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { ChatDoc, type Binding } from "./deck.js";

type Args = Record<string, string | number | undefined>;
export type FileResult = { ok: boolean; output: string; code?: string; exitCode?: number | null; truncated?: boolean };
export type ShellProgress = { output: string; truncated: boolean; lossyUtf8: boolean };
export interface HostFiles { call(binding: Binding, id: string, operation: string, args: Args, signal?: AbortSignal, onProgress?: (progress: ShellProgress) => void): Promise<FileResult>; }
type Pending = { reject: (error: Error) => void } & ({ kind: "result"; resolve: (result: FileResult) => void } | { kind: "progress"; resolve: (result: ShellProgress) => void });

export class PipeFiles implements HostFiles {
  private readonly reader;
  private readonly writer;
  private readonly control;
  private readonly pending = new Map<string, Pending>();
  private failed = false;
  private closing: Promise<void> | undefined;
  private readonly decoder = new FrameDecoder();
  constructor(readFd: number, writeFd: number, controlFd?: number) {
    this.reader = createReadStream("", { fd: readFd, autoClose: true });
    this.writer = createWriteStream("", { fd: writeFd, autoClose: true });
    this.control = controlFd === undefined ? undefined : createWriteStream("", { fd: controlFd, autoClose: true });
    const fail = () => {
      if (this.failed) return;
      this.failed = true;
      for (const item of this.pending.values()) item.reject(new Error("effect_uncertain: worker connection lost; issued effects may have happened"));
      this.pending.clear(); this.close();
    };
    this.control?.on("error", fail);
    this.writer.on("error", fail); this.reader.on("error", fail);
    const decoder = this.reader.pipe(this.decoder);
    void (async () => {
      try {
        for await (const raw of decoder) {
          const value = raw as { version?: unknown; id?: unknown; result?: FileResult; progress?: ShellProgress };
          if (value.version !== 1 || typeof value.id !== "string") throw new Error("Invalid worker response");
          const pending = this.pending.get(value.id);
          if (!pending) throw new Error("Unexpected worker response");
          if (pending.kind === "progress") {
            const sample = value.progress;
            if (value.result !== undefined || typeof sample?.output !== "string" || Buffer.byteLength(sample.output) > 2048 || typeof sample.truncated !== "boolean" || typeof sample.lossyUtf8 !== "boolean") throw new Error("Invalid worker progress");
            this.pending.delete(value.id); pending.resolve({ output: sample.output, truncated: sample.truncated, lossyUtf8: sample.lossyUtf8 });
          } else {
            if (value.progress !== undefined || typeof value.result?.ok !== "boolean" || typeof value.result.output !== "string") throw new Error("Invalid worker result");
            this.pending.delete(value.id); pending.resolve(value.result);
          }
        }
      } catch { /* Fail closed, never resend an issued effect. */ }
      finally { fail(); }
    })();
  }
  private sample(binding: Binding, target: string): Promise<ShellProgress> | undefined {
    const id = `progress:${target}`;
    if (this.failed || [...this.pending.values()].filter((item) => item.kind === "progress").length >= 4 || this.pending.has(id)) return;
    const frame = encodeFrame({ version: 1, id, ...binding, operation: "bash_progress", args: { target } });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "progress", resolve, reject });
      this.writer.write(frame, (error) => {
        if (error) { this.pending.get(id)?.reject(new Error("Progress unavailable")); this.pending.delete(id); }
      });
    });
  }
  async call(binding: Binding, id: string, operation: string, args: Args, signal?: AbortSignal, onProgress?: (progress: ShellProgress) => void): Promise<FileResult> {
    signal?.throwIfAborted();
    const processOperation = operation === "bash" || operation === "rex_allocate" || operation === "rex_inspect";
    if (processOperation && !this.control) throw new Error("offline: process cancellation channel unavailable");
    if (this.failed) throw new Error("offline: local worker unavailable");
    if ([...this.pending.values()].filter((item) => item.kind === "result").length >= 16 || this.pending.has(id)) throw new Error("busy: native operation capacity reached");
    const frame = encodeFrame({ version: 1, id, ...binding, operation, args });
    let ended = false;
    const timer = operation === "bash" && onProgress ? setInterval(() => {
      if (ended || signal?.aborted) return;
      void this.sample(binding, id)?.then((sample) => {
        if (!ended && !signal?.aborted) { try { onProgress(sample); } catch { /* Presentation cannot change an effect's outcome. */ } }
      }, () => {});
    }, 500) : undefined;
    try { return await new Promise<FileResult>((resolve, reject) => {
      const cancel = () => {
        if (!processOperation) return;
        const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(id));
        this.control!.write(bytes);
      };
      const clean = () => signal?.removeEventListener("abort", cancel);
      this.pending.set(id, { kind: "result", resolve: (result) => { clean(); resolve(result); }, reject: (error) => { clean(); reject(error); } });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      this.writer.write(frame, (error) => {
        if (error) { this.pending.get(id)?.reject(new Error("effect_uncertain: failed to send native operation")); this.pending.delete(id); }
      });
    }); } finally { ended = true; clearInterval(timer); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const streams: { closed: boolean; once(event: "close", listener: () => void): unknown; destroy(): unknown }[] = [this.writer, this.reader, this.decoder, ...(this.control ? [this.control] : [])];
    this.closing = Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
      if (stream.closed) resolve(); else stream.once("close", resolve);
    }))).then(() => {});
    // Closing the request/control writers wakes Zig, which closes its result writer
    // after draining. Await all closes before process.exit: fs.read on the inherited
    // result pipe occupies a libuv thread, and forced exit can otherwise deadlock.
    for (const stream of streams) stream.destroy();
    return this.closing;
  }
}

export function nativeFiles(host: HostFiles) {
  const run = async (operation: string, args: Args, api: ToolExecutionApi, context: Context) => {
    context.abortSignal?.throwIfAborted();
    const binding = await api.snapshot(ChatDoc, api.conversationId, context);
    if (!binding?.machineId) throw new Error("offline: conversation has no assigned worker");
    context.abortSignal?.throwIfAborted();
    let latest: ShellProgress | undefined; let publishing: Promise<void> | undefined; let ended = false; let disabled = false; let observed: string | undefined;
    // One commit in flight and one replacement sample, never a promise/output queue.
    const publish = () => {
      if (publishing || !latest || ended || disabled || context.abortSignal?.aborted) return;
      publishing = (async () => {
        while (latest && !ended && !context.abortSignal?.aborted) {
          const value = latest; latest = undefined;
          await api.details({ kind: "deck.bash-progress", version: 1, provisional: true, operationId: String(api.taskId), ...value }, context);
        }
      })().catch(() => { disabled = true; latest = undefined; }).finally(() => {
        publishing = undefined;
        // A sample can arrive between the loop's exit and this finally microtask.
        publish();
      });
    };
    const progress = (sample: ShellProgress) => {
      if (ended || disabled || context.abortSignal?.aborted || typeof sample.output !== "string" || !sample.output || Buffer.byteLength(sample.output) > 2048 || typeof sample.truncated !== "boolean" || typeof sample.lossyUtf8 !== "boolean") return;
      const value = { output: sample.output, truncated: sample.truncated, lossyUtf8: sample.lossyUtf8 };
      const fingerprint = JSON.stringify(value);
      if (fingerprint === observed) return;
      observed = fingerprint; latest = value; publish();
    };
    let result: FileResult;
    try { result = await host.call({ machineId: binding.machineId, cwd: binding.cwd }, String(api.taskId), operation, args, context.abortSignal, operation === "bash" ? progress : undefined); }
    finally { ended = true; latest = undefined; await publishing; }
    return { output: [{ type: "text" as const, text: result.output }], isError: !result.ok, details: { host: binding.machineId, operationId: String(api.taskId), code: result.code ?? "ok", exitCode: result.exitCode ?? null, truncated: result.truncated ?? false } };
  };
  return defineExtension({ name: "deck.native-files", tools: [
    defineTool({ name: "bash", description: "Run bash on the assigned worker. Timeout defaults to 60 seconds, maximum 300. Returns a bounded 64 KiB combined output tail and exit status. Foreground process group is terminated on cancellation, timeout or shell exit. Do not automatically retry uncertain effects.", parameters: Type.Object({ command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }), execute: (args, api, ctx) => run("bash", args, api, ctx) }),
    defineTool({ name: "read", description: "Read a UTF-8 text file on the assigned worker (at most 128 KiB). Binary/images are unsupported.", parameters: Type.Object({ path: Type.String() }), execute: (args, api, ctx) => run("read", args, api, ctx) }),
    defineTool({ name: "write", description: "Write UTF-8 text on the assigned worker, replacing the file. At most 128 KiB. Parent directories must exist.", parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: (args, api, ctx) => run("write", args, api, ctx) }),
    defineTool({ name: "edit", description: "Replace exactly one literal occurrence of oldText in a UTF-8 file on the assigned worker. Rejects zero or multiple matches; no fuzzy matching. At most 128 KiB.", parameters: Type.Object({ path: Type.String(), oldText: Type.String({ minLength: 1 }), newText: Type.String() }), execute: (args, api, ctx) => run("edit", args, api, ctx) }),
  ] });
}
