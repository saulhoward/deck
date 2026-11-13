import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Readable, Writable } from "node:stream";
import { ChatDoc, DeckError, type DeckRuntime } from "./deck.js";
import { agentNameFields } from "./agent-names.js";
import { briefFields } from "./task-brief.js";
import { validMcpArgs } from "./mcp-api.js";
import { validHostArgs } from "./host-inventory.js";
import { validModelSettingsArgs } from "./model-settings-contracts.js";
import type { SetModelSettingsArgs } from "./generated/contracts.js";
import { validStatusLoginArgs } from "./status-login-contracts.js";
import { validOpenArgs, validRexReadArgs } from "./rex-open-contracts.js";
import type { Login } from "./login.js";
import { encodeFrame, FrameDecoder, FrameSizeError, PROTOCOL_VERSION } from "./protocol.js";
import { responseFrame } from "./responses.js";
import { validDiscoveryArgs } from "./discovery-contracts.js";
import { validHistoryArgs } from "./history-contracts.js";
import { validLiveArgs, validInstructionArgs } from "./view-contracts.js";
import { validMutationArgs, type ReplyContext } from "./mutation-contracts.js";
import { validRequestEnvelope, type ResponseEnvelope } from "./generated/contracts.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeckError("invalid", "Expected object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 200_000) throw new DeckError("invalid", `Invalid ${name}`);
  return value;
}

export async function dispatch(runtime: DeckRuntime, request: Record<string, unknown>, login?: Login, taskClient = false): Promise<unknown> {
  if (request.hubId !== undefined) {
    if (typeof request.hubId !== "string" || !request.hubId || request.hubId.length > 200) throw new DeckError("invalid", "Invalid expected hub identity");
    if (request.hubId !== runtime.hubId) throw new DeckError("conflict", "Hub identity changed; reconnect to the intended hub. No command applied");
  }
  const args = object(request.args ?? {});
  if (!validStatusLoginArgs(String(request.command), args)) throw new DeckError("invalid", "Invalid status/login arguments");
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
      const saved = await runtime.harness.snapshot(ChatDoc, chat.id, context);
      const model = (await chat.agent(context)).model;
      // Project Deck metadata without rewriting retained documents. Pi model
      // parameters and global inspection records remain compatible opaque data.
      const binding = saved && { ...agentNameFields(saved), machineId: saved.machineId, cwd: saved.cwd, kind: saved.kind, title: saved.title, ...(saved.parentChatId === undefined ? {} : { parentChatId: saved.parentChatId }), ...(saved.ownerTaskId === undefined ? {} : { ownerTaskId: saved.ownerTaskId }), ...(saved.brief ? { brief: saved.brief } : {}) };
      return { implementation: runtime.implementation, hubId: runtime.hubId, hubGuard: 1, modelSettings: 1, taskBrief: 1, ...(taskClient ? {} : { hostInventory: 1 }), rexStartup: 1, rexOpen: runtime.rexClient && runtime.localFiles ? 1 : 0, mainChatId: String(runtime.main.id), chatId: String(chat.id), binding, ...(taskClient ? {} : { activity: await runtime.harness.inspect(context) }), provider: model?.provider, model: taskClient && model ? { provider: model.provider, modelId: model.modelId } : model, tools: runtime.localFiles ? "native-files + bash" : "offline" };
    }
    case "model_settings":
    case "set_model_settings": {
      if (request.hubId !== runtime.hubId || !validModelSettingsArgs(String(request.command), args)) throw new DeckError("invalid", "Model settings require a selected chat and explicit hub identity");
      return request.command === "model_settings" ? runtime.modelSettings(text(args.chatId, "chatId")) : runtime.setModelSettings(args as SetModelSettingsArgs);
    }
    case "rex_open": {
      if (request.hubId !== runtime.hubId || !validOpenArgs(args)) throw new DeckError("invalid", "Rex open requires valid arguments and explicit hub identity");
      return runtime.openTerminal(args);
    }
    case "rex_status":
    case "rex_inspect": {
      if (request.hubId !== runtime.hubId || !validRexReadArgs(args)) throw new DeckError("invalid", "Rex reads require a selected chat and explicit hub identity");
      return request.command === "rex_status" ? runtime.terminalStatus(args.chatId) : runtime.inspectTerminal(args.chatId);
    }
    case "rex_startup": {
      if (request.hubId !== runtime.hubId) throw new DeckError("invalid", "Rex startup requires an explicit expected hub identity");
      if (!validMutationArgs("rex_startup", args)) throw new DeckError("invalid", "Invalid Rex startup arguments");
      return runtime.registerTerminalStartup(args.chatId, args.allocationId, args.blockId);
    }
    case "activity":
    case "progress": {
      if (!validLiveArgs(args)) throw new DeckError("invalid", "Invalid live view arguments");
      const id = args.chatId ?? String(runtime.main.id);
      return request.command === "activity" ? runtime.activity(id, args.includeAgentStatus === true) : runtime.progress(id);
    }
    case "mcp_catalog":
    case "tool_profiles":
    case "set_tool_profiles": {
      if(taskClient || request.hubId!==runtime.hubId || !validMcpArgs(request.command,args)) throw new DeckError("invalid","MCP configuration requires the hub control surface, valid arguments and explicit hub identity");
      return request.command==="mcp_catalog" ? runtime.mcpCatalog() : request.command==="tool_profiles" ? runtime.toolProfiles(String(args.chatId)) : runtime.setToolProfiles(args as unknown as import("./generated/contracts.js").McpGrantArgs);
    }
    case "list_hosts": {
      if (!validHostArgs("list_hosts", args)) throw new DeckError("invalid", "Host inventory takes no arguments");
      return runtime.hosts();
    }
    case "list_chats": {
      if (!validDiscoveryArgs(args)) throw new DeckError("invalid", "Invalid chat discovery arguments");
      return runtime.listChats({ ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.after === undefined ? {} : { after: args.after }) });
    }
    case "create_task": {
      if (!validMutationArgs("create_task", args)) throw new DeckError("invalid", "Invalid task creation arguments");
      const chat = await runtime.createTask(args.title, { machineId: args.machineId, cwd: args.cwd }, args.requestId);
      return { chatId: String(chat.id) };
    }
    case "create_task_brief": {
      if (!validMutationArgs("create_task_brief", args)) throw new DeckError("invalid", "Invalid task brief creation arguments");
      const brief = briefFields(args);
      const chat = await runtime.createTask(args.title, { machineId: args.machineId, cwd: args.cwd }, args.requestId, undefined, brief);
      return { chatId: String(chat.id), brief };
    }
    case "import_instructions": {
      if (!validMutationArgs("import_instructions", args)) throw new DeckError("invalid", "Instruction import accepts only a saved chat/binding and request ID; path is fixed to AGENTS.md");
      const { chatId, requestId } = args;
      const taskId = await runtime.importInstructions(chatId, requestId, undefined, { machineId: args.machineId, cwd: args.cwd });
      return { chatId, requestId, taskId: String(taskId), admitted: true, completion: "not_waited" };
    }
    case "instruction_status": {
      if (!validInstructionArgs(args)) throw new DeckError("invalid", "Invalid instruction status arguments");
      return runtime.instructionsStatus(args.chatId ?? String(runtime.main.id), args.taskId);
    }
    case "admit": {
      if (!validMutationArgs("admit", args)) throw new DeckError("invalid", "Invalid admission arguments");
      const submission = await runtime.admit(args.chatId, { requestId: args.requestId, text: args.text, mode: args.mode });
      return { submissionId: String(submission.id) };
    }
    case "history": {
      if (!validHistoryArgs(args)) throw new DeckError("invalid", "Invalid history arguments");
      const id = args.chatId;
      const page = await runtime.history(id, { ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.before === undefined ? {} : { before: args.before }), ...(args.after === undefined ? {} : { after: args.after }) });
      const canonical = { ...page, ...(args.includeActivity ? { activity: await runtime.activity(id, args.includeAgentStatus === true) } : {}) };
      if (!args.includeProgress && !args.includeInstructions) return canonical;
      const combined = { ...canonical, ...(args.includeProgress ? { progress: await runtime.progress(id) } : {}), ...(args.includeInstructions ? { instructions: await runtime.instructionsStatus(id) } : {}) };
      // Optional previews/instruction samples never make fitting canonical history fail.
      // Canonical oversize pages still get the usual too_large/adaptive retry path.
      try { encodeFrame({ version: PROTOCOL_VERSION, id: request.id, ok: true, result: combined }); }
      catch (error) {
        if (error instanceof FrameSizeError) return canonical;
        throw new DeckError("invalid_response", "Runtime response invalid; observation unchanged");
      }
      return combined;
    }
    case "stop": {
      if (!validMutationArgs("stop", args)) throw new DeckError("invalid", "Invalid stop arguments");
      // Remote scope is checked again inside admission. Keep trusted-local stop
      // independent of other admission requests; neither path waits for drainage.
      if (taskClient) await runtime.requestStop(args.chatId);
      else {
        const chat = await runtime.chat(args.chatId);
        void chat.abort(context).catch(() => { process.stderr.write("deck runtime: stop failed; inspect activity\n"); });
      }
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
  const send = (value: ResponseEnvelope, request?: ReplyContext) => {
    const frame = responseFrame(value, request);
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
        await send(response, request);
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
