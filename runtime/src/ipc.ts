import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Readable, Writable } from "node:stream";
import { ChatDoc, DeckError, type DeckRuntime } from "./deck.js";
import type { Login } from "./login.js";
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from "./protocol.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeckError("invalid", "Expected object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 200_000) throw new DeckError("invalid", `Invalid ${name}`);
  return value;
}

async function dispatch(runtime: DeckRuntime, request: Record<string, unknown>, login?: Login): Promise<unknown> {
  const args = object(request.args ?? {});
  switch (request.command) {
    case "login_start": if (!login) throw new DeckError("invalid", "ChatGPT login requires the hub's default ChatGPT mode"); return login.start(text(args.requestId, "requestId"));
    case "login_status": return login?.snapshot() ?? { status: "unsupported" };
    case "login_cancel": {
      if (!login) throw new DeckError("invalid", "Login unsupported in this mode");
      return login.cancel(text(args.loginId, "loginId"));
    }
    case "login_reply": {
      if (!login) throw new DeckError("invalid", "Login unsupported in this mode");
      return login.answer(text(args.loginId, "loginId"), text(args.promptId, "promptId"), text(args.answer, "answer"));
    }
    case "status": {
      const chat = args.chatId === undefined ? runtime.main : await runtime.chat(text(args.chatId, "chatId"));
      return { implementation: runtime.implementation, hubId: runtime.hubId, mainChatId: String(runtime.main.id), chatId: String(chat.id), binding: await runtime.harness.snapshot(ChatDoc, chat.id, context), activity: await runtime.harness.inspect(context), provider: (await chat.agent(context)).model?.provider, model: (await chat.agent(context)).model, tools: runtime.localFiles ? "native-files + bash" : "offline" };
    }
    case "activity": return runtime.activity(args.chatId === undefined ? String(runtime.main.id) : text(args.chatId, "chatId"));
    case "progress": return runtime.progress(args.chatId === undefined ? String(runtime.main.id) : text(args.chatId, "chatId"));
    case "list_chats": {
      if (args.limit !== undefined && typeof args.limit !== "number") throw new DeckError("invalid", "Invalid limit");
      return runtime.listChats({ ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.after === undefined ? {} : { after: text(args.after, "after") }) });
    }
    case "create_task": {
      const chat = await runtime.createTask(text(args.title, "title"), { machineId: text(args.machineId, "machineId"), cwd: text(args.cwd, "cwd") }, text(args.requestId, "requestId"));
      return { chatId: String(chat.id) };
    }
    case "admit": {
      if (args.mode !== "steer" && args.mode !== "followUp") throw new DeckError("invalid", "Invalid admission mode");
      const submission = await runtime.admit(text(args.chatId, "chatId"), { requestId: text(args.requestId, "requestId"), text: text(args.text, "text"), mode: args.mode });
      return { submissionId: String(submission.id) };
    }
    case "history": {
      if (args.limit !== undefined && typeof args.limit !== "number") throw new DeckError("invalid", "Invalid limit");
      if (args.includeActivity !== undefined && typeof args.includeActivity !== "boolean") throw new DeckError("invalid", "Invalid includeActivity");
      if (args.includeProgress !== undefined && typeof args.includeProgress !== "boolean") throw new DeckError("invalid", "Invalid includeProgress");
      const id = text(args.chatId, "chatId");
      const page = await runtime.history(id, { ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.before === undefined ? {} : { before: text(args.before, "before") }), ...(args.after === undefined ? {} : { after: text(args.after, "after") }) });
      const canonical = { ...page, ...(args.includeActivity ? { activity: await runtime.activity(id) } : {}) };
      if (!args.includeProgress) return canonical;
      const combined = { ...canonical, progress: await runtime.progress(id) };
      // Optional previews must never make an otherwise fitting history page fail.
      // Canonical oversize pages still get the usual too_large/adaptive retry path.
      try { encodeFrame({ version: PROTOCOL_VERSION, id: request.id, ok: true, result: combined }); }
      catch { return canonical; }
      return combined;
    }
    case "stop": {
      const chat = await runtime.chat(text(args.chatId, "chatId"));
      // Pi owns cancellation and draining. Do not hold the command pipe while an
      // already-issued native effect drains; this receipt is a request, not idle.
      void chat.abort(context).catch(() => { process.stderr.write("deck runtime: stop failed; inspect activity\n"); });
      return { requested: true };
    }
    default: throw new DeckError("invalid", "Unknown command");
  }
}

// Admission returns promptly; long-running stop commands cannot monopolize the input loop.
// Bound both concurrent commands and the output queue. Pipe closure never means abort.
export async function serveIpc(runtime: DeckRuntime, input: Readable, output: Writable, login?: Login): Promise<void> {
  const decoder = input.pipe(new FrameDecoder());
  const fail = (error: Error) => { decoder.destroy(error); };
  input.on("error", fail);
  output.on("error", fail);
  const active = new Set<Promise<void>>();
  let writes: Promise<void> = Promise.resolve();
  const send = (value: unknown) => {
    let frame: Buffer;
    try { frame = encodeFrame(value); }
    catch { frame = encodeFrame({ version: 1, id: object(value).id, ok: false, error: { code: "too_large", message: "Response exceeds IPC limit" } }); }
    const write = writes.then(() => new Promise<void>((resolve, reject) => {
      output.write(frame, (error) => error ? reject(error) : resolve());
    }));
    writes = write;
    return write;
  };
  try {
    for await (const value of decoder) {
      const request = object(value);
      if (request.version !== PROTOCOL_VERSION || typeof request.id !== "string" || !request.id || request.id.length > 200) throw new DeckError("invalid", "Invalid IPC envelope or version");
      if (active.size >= 16) {
        await send({ version: 1, id: request.id, ok: false, error: { code: "busy", message: "Too many outstanding commands" } });
        continue;
      }
      const job = (async () => {
        let response;
        try { response = { version: 1, id: request.id, ok: true, result: await dispatch(runtime, request, login) }; }
        catch (error) { response = { version: 1, id: request.id, ok: false, error: { code: error instanceof DeckError ? error.code : "runtime_failed", message: error instanceof DeckError ? error.message : "Runtime command failed" } }; }
        await send(response);
      })();
      active.add(job);
      // Keep a rejection handler attached even before EOF joins outstanding commands.
      void job.then(() => active.delete(job), () => { active.delete(job); input.destroy(); });
    }
    await Promise.all(active);
    await writes;
  } finally {
    input.unpipe(decoder);
    input.off("error", fail);
    output.off("error", fail);
    decoder.destroy();
  }
}
