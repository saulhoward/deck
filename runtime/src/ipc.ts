import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Readable, Writable } from "node:stream";
import { ChatDoc, DeckError, type DeckRuntime } from "./deck.js";
import type { Login } from "./login.js";
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from "./protocol.js";
import { responseFrame } from "./responses.js";
import { validRequestEnvelope, type ResponseEnvelope } from "./generated/contracts.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeckError("invalid", "Expected object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 200_000) throw new DeckError("invalid", `Invalid ${name}`);
  return value;
}

async function dispatch(runtime: DeckRuntime, request: Record<string, unknown>, login?: Login): Promise<unknown> {
  if (request.hubId !== undefined) {
    if (typeof request.hubId !== "string" || !request.hubId || request.hubId.length > 200) throw new DeckError("invalid", "Invalid expected hub identity");
    if (request.hubId !== runtime.hubId) throw new DeckError("conflict", "Hub identity changed; reconnect to the intended hub. No command applied");
  }
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
      return { implementation: runtime.implementation, hubId: runtime.hubId, hubGuard: 1, rexStartup: 1, mainChatId: String(runtime.main.id), chatId: String(chat.id), binding: await runtime.harness.snapshot(ChatDoc, chat.id, context), activity: await runtime.harness.inspect(context), provider: (await chat.agent(context)).model?.provider, model: (await chat.agent(context)).model, tools: runtime.localFiles ? "native-files + bash" : "offline" };
    }
    case "rex_startup": {
      if (request.hubId !== runtime.hubId) throw new DeckError("invalid", "Rex startup requires an explicit expected hub identity");
      if (Object.keys(args).some((key) => !["chatId", "allocationId", "blockId"].includes(key))) throw new DeckError("invalid", "Invalid Rex startup arguments");
      return runtime.registerTerminalStartup(text(args.chatId, "chatId"), text(args.allocationId, "allocationId"), text(args.blockId, "blockId"));
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
    case "import_instructions": {
      if (Object.keys(args).some((key) => !["chatId", "requestId", "machineId", "cwd"].includes(key))) throw new DeckError("invalid", "Instruction import accepts only a saved chat/binding and request ID; path is fixed to AGENTS.md");
      const chatId = text(args.chatId, "chatId"); const requestId = text(args.requestId, "requestId");
      const taskId = await runtime.importInstructions(chatId, requestId, undefined, { machineId: text(args.machineId, "machineId"), cwd: text(args.cwd, "cwd") });
      return { chatId, requestId, taskId: String(taskId), admitted: true, completion: "not_waited" };
    }
    case "instruction_status": {
      if (Object.keys(args).some((key) => !["chatId", "taskId"].includes(key))) throw new DeckError("invalid", "Invalid instruction status arguments");
      return runtime.instructionsStatus(args.chatId === undefined ? String(runtime.main.id) : text(args.chatId, "chatId"), args.taskId === undefined ? undefined : text(args.taskId, "taskId"));
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
      if (args.includeInstructions !== undefined && typeof args.includeInstructions !== "boolean") throw new DeckError("invalid", "Invalid includeInstructions");
      const id = text(args.chatId, "chatId");
      const page = await runtime.history(id, { ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.before === undefined ? {} : { before: text(args.before, "before") }), ...(args.after === undefined ? {} : { after: text(args.after, "after") }) });
      const canonical = { ...page, ...(args.includeActivity ? { activity: await runtime.activity(id) } : {}) };
      if (!args.includeProgress && !args.includeInstructions) return canonical;
      const combined = { ...canonical, ...(args.includeProgress ? { progress: await runtime.progress(id) } : {}), ...(args.includeInstructions ? { instructions: await runtime.instructionsStatus(id) } : {}) };
      // Optional previews/instruction samples never make fitting canonical history fail.
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
  const send = (value: ResponseEnvelope) => {
    const frame = responseFrame(value);
    const write = writes.then(() => new Promise<void>((resolve, reject) => {
      output.write(frame, (error) => error ? reject(error) : resolve());
    }));
    writes = write;
    return write;
  };
  try {
    for await (const value of decoder) {
      const request = object(value);
      if (!validRequestEnvelope(request)) throw new DeckError("invalid", "Invalid IPC envelope or version");
      if (active.size >= 16) {
        await send({ version: 1, id: request.id, ok: false, error: { code: "busy", message: "Too many outstanding commands" } });
        continue;
      }
      const job = (async () => {
        let response: ResponseEnvelope;
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
