// Pi 1.4.0 compatibility boundary. Native effects are supplied by the hub, never inferred here.
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, configure as configureAgent, defineDoc, defineDocFamily, Harness, LiveDoc, InboxDoc, type ConversationId, type Conversation, type AgentChange, type Cursor } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { projectProgress } from "./progress.js";
import { bindImplementation, checkCompatibility, defaultImplementation, stampImplementation } from "./compatibility.js";
import { nativeFiles, type HostFiles } from "./host-files.js";
import { foregroundSubagent } from "./subagent.js";
import { taskControl } from "./task-control.js";
import { taskTools } from "./task-tools.js";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export type Binding = { machineId: string; cwd: string };
type Chat = { kind: "main" | "task" | "subagent"; title: string; machineId: string; cwd: string; parentChatId?: string; ownerTaskId?: string };
export const ChatDoc = defineDoc<Chat>({
  kind: "deck.chat", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ kind: "main", title: "Main", machineId: "", cwd: "" }), checkpointWhen: () => true,
});
// A reservation is not an ACK. A crash between this commit and submit is repaired by retrying
// the same Pi request ID. Pi 1.4.0 has no public submit(tx, draft) API.
const Admission = defineDocFamily<{ hash: string; capture: string }, { hash: string; capture: string }>({
  kind: "deck.admission", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  initial: (seed) => seed, checkpointWhen: () => true,
});
const TaskRequest = defineDocFamily<{ hash: string; chatId: number }, string>({
  kind: "deck.task-request", version: 1, scope: "session", family: true,
  initial: (hash) => ({ hash, chatId: 0 }), checkpointWhen: () => true,
});
const Identity = defineDoc<{ id: string }>({ kind: "deck.identity", version: 1, scope: "session", initial: () => ({ id: randomUUID() }), checkpointWhen: () => true });
export class DeckError extends Error {
  constructor(public readonly code: "conflict" | "offline" | "not_found" | "invalid" | "auth_required" | "busy" | "settings_changed", message: string) { super(message); }
}
function positiveId(id: string, kind: string): number {
  const value = Number(id);
  if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(value)) throw new DeckError("invalid", `Invalid ${kind} ID`);
  return value;
}
function chatId(id: string): ConversationId { return positiveId(id, "conversation") as ConversationId; }
export type Input = { requestId: string; text: string; mode: "steer" | "followUp"; origin?: { kind: "task-tool"; chatId: string; taskId: string } };
export type RuntimeOptions = {
  models: Models;
  model: { provider: string; modelId: string };
  binding: Binding;
  environment: (binding: Binding) => ExecutionEnv | undefined;
  hostFiles?: HostFiles;
  admissionGuard?: () => Promise<void>;
  validateSavedModels?: boolean;
  // Trusted embedded callers identify injected code; production main fingerprints
  // the actual runtime/dependency closure, Node and native executable.
  implementation?: string;
};

export class DeckRuntime {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(readonly harness: Harness, readonly main: Conversation, private readonly guard: () => Promise<void>, readonly localFiles: boolean, readonly hubId: string, readonly implementation: string) {}

  static async open(path: string, options: RuntimeOptions): Promise<DeckRuntime> {
    let runtime: DeckRuntime | undefined;
    const registry = createRegistry();
    registry.install(CodingTools);
    const current = () => {
      if (!runtime) throw new Error("Deck runtime is not ready");
      return runtime;
    };
    registry.install(taskTools(current));
    const control = taskControl(current);
    registry.install(control);
    registry.install(foregroundSubagent(control));
    if (options.hostFiles) registry.install(nativeFiles(options.hostFiles));
    const implementation = bindImplementation(options.implementation ?? await defaultImplementation(), !!options.hostFiles);
    const storage = await openNodeSqliteStorage(path);
    try { await checkCompatibility(storage, implementation); }
    catch (error) { await storage.close(context); throw error; }
    const harness = await Harness.open(storage, {
      models: options.models, registry,
      settings: { steeringMode: "all", followUpMode: "one-at-a-time" },
      env: async ({ conversationId, read }) => {
        if (options.hostFiles) return undefined; // Native adapter resolves saved binding itself; never use a hub-local environment.
        const binding = await read.snapshot(ChatDoc, conversationId, context);
        if (!binding?.machineId) throw new DeckError("offline", "Conversation has no assigned tool host");
        const env = options.environment({ machineId: binding.machineId, cwd: binding.cwd });
        if (!env) throw new DeckError("offline", `Assigned worker ${binding.machineId} is unavailable`);
        return env;
      },
    }, context);
    try {
      await stampImplementation(harness, implementation);
      const main = await harness.root(context, {
        agent: { model: options.model, cwd: options.binding.cwd },
        init: async (tx, id) => { Object.assign(await tx.doc(ChatDoc, id), options.binding); },
      });
      if (options.validateSavedModels) {
        let cursor: Cursor | undefined;
        do {
          const page = await harness.commit((tx) => tx.scanConversations({}, 100, cursor), context);
          for (const record of page.items) {
            const agent = await (await harness.conversation(record.id, context))!.agent(context);
            if (!agent.model || !options.models.getModel(agent.model.provider, agent.model.modelId)) throw new DeckError("invalid", "Saved model is unavailable in this runtime mode; use the original mode/state directory");
          }
          cursor = page.next;
        } while (cursor);
      }
      const hubId = await harness.commit(async (tx) => (await tx.doc(Identity)).id, context);
      // Bind Deck tool callbacks before recovered Pi tool tasks can run.
      runtime = new DeckRuntime(harness, main, options.admissionGuard ?? (async () => {}), !!options.hostFiles, hubId, implementation);
      harness.resume();
      return runtime;
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }

  // Serializes only admission/configuration commits, never generation or host effects.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }

  async chat(id: string): Promise<Conversation> {
    const chat = await this.harness.conversation(chatId(id), context);
    if (!chat) throw new DeckError("not_found", "Unknown conversation");
    return chat;
  }

  async listChats({ limit = 50, after }: { limit?: number; after?: string } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DeckError("invalid", "Chat page limit must be an integer from 1 to 100");
    // Pi 1.4.0's ID-ordered scan cursor stays behind this adapter. The wire continuation
    // is the last scanned conversation ID, including records without Deck metadata.
    const cursor = after === undefined ? undefined : { after: chatId(after), order: "ascending" };
    const page = await this.harness.commit((tx) => tx.scanConversations({ order: "ascending" }, limit, cursor), context);
    const items = [];
    for (const record of page.items) {
      const metadata = await this.harness.snapshot(ChatDoc, record.id, context);
      if (metadata) items.push({ chatId: String(record.id), kind: metadata.kind, title: metadata.title, machineId: metadata.machineId, cwd: metadata.cwd, ...(metadata.parentChatId ? { parentChatId: metadata.parentChatId } : {}), ...(metadata.ownerTaskId ? { ownerTaskId: metadata.ownerTaskId } : {}) });
    }
    return { items, ...(page.next ? { next: String(page.items.at(-1)!.id) } : {}) };
  }

  createTask(title: string, binding: Binding, requestId: string = randomUUID(), signal?: AbortSignal): Promise<Conversation> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (!title.trim() || !binding.machineId || !binding.cwd.startsWith("/")) throw new DeckError("invalid", "Task needs a title, host and absolute cwd");
      if (!requestId || requestId.length > 200) throw new DeckError("invalid", "Invalid task request ID");
      const hash = createHash("sha256").update(JSON.stringify([title, binding.machineId, binding.cwd])).digest("hex");
      const existing = await this.main.commit(async (tx) => {
        const receipt = await tx.doc(TaskRequest, requestId, hash);
        if (receipt.hash !== hash) throw new DeckError("conflict", "Task request ID already used with different arguments");
        return receipt.chatId;
      }, context);
      if (existing) return this.chat(String(existing));
      const agent = await this.main.agent(context);
      signal?.throwIfAborted();
      return this.harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { ...(agent.model ? { model: agent.model } : {}), thinkingLevel: agent.thinkingLevel, cwd: binding.cwd },
        init: async (tx, id) => {
          Object.assign(await tx.doc(ChatDoc, id), { ...binding, title, kind: "task" });
          (await tx.doc(TaskRequest, requestId, hash)).chatId = id;
        },
      }, context);
    });
  }

  admit(id: string, input: Input, signal?: AbortSignal) {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (!input.requestId || input.requestId.length > 200 || !input.text.trim() || !["steer", "followUp"].includes(input.mode)) {
        throw new DeckError("invalid", "Input needs requestId, text and a supported mode");
      }
      const origin = input.origin === undefined ? undefined : { kind: input.origin.kind, chatId: input.origin.chatId, taskId: input.origin.taskId };
      if (origin) {
        if (origin.kind !== "task-tool") throw new DeckError("invalid", "Unsupported input origin");
        positiveId(origin.chatId, "origin conversation"); positiveId(origin.taskId, "origin task");
      }
      const chat = await this.chat(id);
      if ((await this.harness.snapshot(ChatDoc, chat.id, context))?.kind === "subagent") throw new DeckError("invalid", "Subagent chats accept input only through their owning tool; inspect or stop them instead");
      const existing = await chat.commit((tx) => tx.submissionByRequest(chat.id, input.requestId), context);
      signal?.throwIfAborted();
      if (!existing) await this.guard();
      signal?.throwIfAborted();
      const hash = createHash("sha256").update(JSON.stringify(origin ? [input.text, input.mode, origin] : [input.text, input.mode])).digest("hex");
      const agent = await chat.agent(context);
      const capture = await chat.commit(async (tx) => {
        const binding = await tx.doc(ChatDoc, chat.id);
        if (!existing && agent.cwd !== binding.cwd) throw new DeckError("invalid", "Agent cwd differs from its saved tool binding");
        // An admission observation, not a per-input override of Pi's later request resolution.
        const observations = {
          semantics: "observed-at-reservation", pi: "1.4.0", nativeTools: this.localFiles,
          model: agent.model ? { provider: agent.model.provider, modelId: agent.model.modelId } : null,
          thinkingLevel: agent.thinkingLevel, cwd: agent.cwd,
          binding: { machineId: binding.machineId, cwd: binding.cwd },
          extensions: agent.extensions.map((extension) => extension.name),
          tools: agent.tools.map((tool) => tool.name), callable: agent.callable.map((tool) => tool.name),
          deferred: agent.deferred.map((tool) => tool.name),
          instructionsHash: agent.instructions === undefined ? null : createHash("sha256").update(agent.instructions).digest("hex"),
        };
        const capture = JSON.stringify({ version: 3, ...observations, implementation: this.implementation });
        const legacyV2 = JSON.stringify({ version: 2, ...observations });
        const reservation = await tx.doc(Admission, chat.id, input.requestId, { hash, capture });
        if (reservation.hash !== hash) throw new DeckError("conflict", "Request ID was already used with different input");
        // Repair the reservation/submit gap only under the same observed choices. Already
        // admitted receipts remain retrievable after settings/auth changes. Legacy captures
        // retain only their originally recorded observations, not invented code provenance.
        const legacy = JSON.stringify({ model: agent.model, thinkingLevel: agent.thinkingLevel, binding });
        if (!existing && reservation.capture !== capture && reservation.capture !== legacyV2 && reservation.capture !== legacy) throw new DeckError("settings_changed", "Unadmitted request settings or implementation changed; restore the original choices/build or explicitly discard and submit a new request");
        return reservation.capture;
      }, context);
      // Cancellation can leave a reservation, never a fabricated admission ACK.
      signal?.throwIfAborted();
      // ACK only after Pi has committed the submission. The capture remains unchanged on retry.
      return chat.submit({
        type: "input", content: origin ? `[Message from agent chat ${origin.chatId}, tool task ${origin.taskId}; not a direct human message]\n${input.text}` : input.text, requestId: input.requestId, whenBusy: input.mode,
        entry: { kind: "deck.input", data: { text: input.text, requestId: input.requestId, mode: input.mode, capture, ...(origin ? { origin } : {}) } },
      }, context);
    });
  }

  configure(id: string, change: AgentChange) {
    return this.serial(async () => {
      const chat = await this.chat(id);
      return chat.commit(async (tx) => {
        // Query Pi's authoritative work records, not a second execution tracker. This
        // includes pending/parked/background work and effects still draining after stop.
        for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
          if ((await tx.scanTasks({ conversationId: chat.id, status }, 1)).items.length) throw new DeckError("busy", "Conversation has unfinished work; stop/drain it before configuring");
        }
        if ((await tx.doc(InboxDoc, chat.id)).items.length) throw new DeckError("busy", "Conversation has queued input; resolve it before configuring");
        const binding = await tx.doc(ChatDoc, chat.id);
        if (change.cwd !== undefined && change.cwd !== binding.cwd) throw new DeckError("invalid", "Configure cannot move or clear the saved tool-host cwd");
        await configureAgent(tx, chat.id, change);
      }, context);
    });
  }
  async progress(id: string) {
    const chat = await this.chat(id);
    return projectProgress(String(chat.id), await this.harness.snapshot(LiveDoc, chat.id, context));
  }
  async activity(id: string) {
    const chat = await this.chat(id);
    const [live, inbox] = await Promise.all([
      this.harness.snapshot(LiveDoc, chat.id, context), this.harness.snapshot(InboxDoc, chat.id, context),
    ]);
    const primary = live?.tools ?? []; const nested = live?.nestedTools ?? [];
    const tools = [...primary.slice(0, 32), ...nested.slice(0, Math.max(0, 32 - primary.length))];
    // Deliberately omit arguments, partial messages, output, details and retry errors.
    // This is a bounded presentation of Pi's committed state, not another execution tracker.
    return {
      chatId: String(chat.id), busy: !!live?.run, queued: inbox?.items.length ?? 0,
      ...(live?.run ? { runTaskId: String(live.run.taskId) } : {}),
      ...(live?.generation ? { generation: { attempt: live.generation.attempt, phase: live.generation.retry ? "retrying" : live.generation.deferred ? "deferred" : "generating" } } : {}),
      tools: tools.slice(0, 32).map((tool) => ({ callId: tool.callId.slice(0, 128), name: tool.name.slice(0, 80), status: tool.status, ...(tool.taskId === undefined ? {} : { taskId: String(tool.taskId) }), nested: "parentTaskId" in tool })),
      omittedTools: Math.max(0, primary.length + nested.length - 32), compactions: live?.compactions?.length ?? 0, compactionFailed: !!live?.compactionFailure,
    };
  }

  async history(id: string, { limit = 100, before, after }: { limit?: number; before?: string; after?: string } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DeckError("invalid", "History page limit must be an integer from 1 to 100");
    if (before !== undefined && after !== undefined) throw new DeckError("invalid", "Choose before or after, not both");
    const order = after === undefined ? "descending" : "ascending";
    const position = after ?? before;
    const cursor = position === undefined ? undefined : { after: after === "0" ? 0 : positiveId(position, "entry"), order };
    const page = await (await this.chat(id)).entries({ order }, limit, cursor, context);
    return { items: page.items, ...(page.next ? { next: String(page.items.at(-1)!.id) } : {}) };
  }
  async stop(id: string) { await (await this.chat(id)).abort(context); }
  async close() { await this.tail; await this.harness.close(context); }
}
