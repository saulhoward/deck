// Pi 1.4.0 compatibility boundary. Native effects are supplied by the hub, never inferred here.
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { agentStatus } from "./agent-status.js";
import { sameSelection } from "./model-settings-contracts.js";
import { validSetModelSettingsArgs, type ModelRef, type ModelSelection, type ModelSettingsSnapshot, type ModelSettingsAck, type SetModelSettingsArgs } from "./generated/contracts.js";
import { AgentDoc, createRegistry, configure as configureAgent, defineDoc, defineDocFamily, Harness, LiveDoc, InboxDoc, type ConversationId, type Conversation, type AgentChange, type Cursor, type TaskId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { instructionSnapshot, projectInstructionTask } from "./instructions-view.js";
import { projectProgress } from "./progress.js";
import { configurationIdle, importingInstructions, instructionHash, instructionImport, IMPORT_KIND, InstructionRequest, InstructionSourceDoc, type InstructionImportResult } from "./instruction-import.js";
import { RexInspector } from "./rex-inspection.js";
import { rexReconciliation, RexReconcileRequest, allocationRequest, type ReconcileResult } from "./rex-reconciliation.js";
import { validOpenArgs, validResolvedTarget } from "./rex-open-contracts.js";
import { validRexAllocationPlan, validRexAllocationReceiptQuery, type RexOpenArgs, type RexOpenAck, type RexStatusSnapshot, type ChatListPage, type ActivitySnapshot, type KnownCommandErrorCode } from "./generated/contracts.js";
import { prefixUnits } from "./view-text.js";
import { REX_KIND, rexAllocation, RexDoc, RexRequest, rexCoherent, rexTarget, rexUuid, rexBlock, rexStartup, type RexInput, type RexTarget, type RexResult } from "./rex-allocation.js";
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
  constructor(public readonly code: KnownCommandErrorCode, message: string) { super(message); }
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
  // Trusted native registration scope; checked before any recovered work resumes.
  expectedHubId?: string;
  // Trusted launcher supplies its own Deck wrapper, never public caller argv.
  rexClient?: string;
  admissionGuard?: () => Promise<void>;
  validateSavedModels?: boolean;
  // Trusted embedded callers identify injected code; production main fingerprints
  // the actual runtime/dependency closure, Node and native executable.
  implementation?: string;
};

export class DeckRuntime {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly inspector: RexInspector;
  private constructor(readonly harness: Harness, readonly main: Conversation, private readonly guard: () => Promise<void>, readonly localFiles: boolean, readonly hubId: string, readonly implementation: string, private readonly instructionTask: ReturnType<typeof instructionImport>["task"], private readonly rexTask: ReturnType<typeof rexAllocation>["task"], private readonly reconcileTask: ReturnType<typeof rexReconciliation>["task"], private readonly models: Models, private readonly defaultModel: ModelRef, host?: HostFiles, readonly rexClient?: string) { this.inspector = new RexInspector(this, host); }

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
    const importer = instructionImport(options.hostFiles); registry.install(importer.extension);
    const rex = rexAllocation(options.hostFiles); registry.install(rex.extension);
    const reconciler = rexReconciliation(options.hostFiles); registry.install(reconciler.extension);
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
      if (options.expectedHubId !== undefined) {
        const identity = await harness.commit(async (tx) => (await tx.doc(Identity)).id, context);
        if (identity !== options.expectedHubId) throw new DeckError("conflict", "Remote registry belongs to a different hub; work was not resumed");
      }
      await stampImplementation(harness, implementation);
      const initialModel = options.models.getModel(options.model.provider, options.model.modelId);
      const main = await harness.root(context, {
        agent: { model: options.model, thinkingLevel: initialModel ? clampThinkingLevel(initialModel, "medium") : "medium", cwd: options.binding.cwd },
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
      runtime = new DeckRuntime(harness, main, options.admissionGuard ?? (async () => {}), !!options.hostFiles, hubId, implementation, importer.task, rex.task, reconciler.task, options.models, { provider: options.model.provider, modelId: options.model.modelId }, options.hostFiles, options.rexClient);
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

  async listChats({ limit = 50, after }: { limit?: number; after?: string } = {}): Promise<ChatListPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DeckError("invalid", "Chat page limit must be an integer from 1 to 100");
    // Pi 1.4.0's ID-ordered scan cursor stays behind this adapter. The wire continuation
    // is the last scanned conversation ID, including records without Deck metadata.
    const cursor = after === undefined ? undefined : { after: chatId(after), order: "ascending" };
    const page = await this.harness.commit((tx) => tx.scanConversations({ order: "ascending" }, limit, cursor), context);
    const items: ChatListPage["items"] = [];
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
      const existing = await chat.commit(async (tx) => {
        const existing = await tx.submissionByRequest(chat.id, input.requestId);
        // Check before resolving the agent: the import applies outside this serial
        // admission line, so a later-only check could capture pre-apply instructions.
        if (!existing && await importingInstructions(tx, chat.id)) throw new DeckError("busy", "Conversation is importing instructions; wait for its Pi task to settle");
        return existing;
      }, context);
      signal?.throwIfAborted();
      if (!existing) await this.guard();
      signal?.throwIfAborted();
      const hash = createHash("sha256").update(JSON.stringify(origin ? [input.text, input.mode, origin] : [input.text, input.mode])).digest("hex");
      const agent = await chat.agent(context);
      const capture = await chat.commit(async (tx) => {
        if (!existing && await importingInstructions(tx, chat.id)) throw new DeckError("busy", "Conversation is importing instructions; wait for its Pi task to settle");
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

  // Internal operator API only. Returns durable admission to a Pi task, not application
  // success. Callers keep requestId across lost replies and inspect/wait on that task.
  importInstructions(id: string, requestId: string, signal?: AbortSignal, expectedBinding?: Binding): Promise<TaskId<InstructionImportResult>> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new DeckError("invalid", "Invalid instruction import request ID");
      const chat = await this.chat(id);
      return chat.commit(async (tx) => {
        const receipt = await tx.doc(InstructionRequest, chat.id, requestId, null);
        if (receipt.taskId) {
          const original = (await tx.task(receipt.taskId as TaskId))?.input as { binding?: Binding } | undefined;
          if (expectedBinding && (original?.binding?.machineId !== expectedBinding.machineId || original?.binding?.cwd !== expectedBinding.cwd)) throw new DeckError("conflict", "Instruction import ID already used with another binding");
          return receipt.taskId as TaskId<InstructionImportResult>;
        }
        const binding = await tx.doc(ChatDoc, chat.id); const agent = await tx.doc(AgentDoc, chat.id);
        if (!binding || !["main", "task"].includes(binding.kind) || (await tx.conversation(chat.id))?.owner) throw new DeckError("invalid", "Instruction imports require a managed ownerless chat");
        if (!binding.machineId || !binding.cwd.startsWith("/") || agent?.cwd !== binding.cwd) throw new DeckError("invalid", "Instruction import requires a coherent saved tool binding");
        if (expectedBinding && (expectedBinding.machineId !== binding.machineId || expectedBinding.cwd !== binding.cwd)) throw new DeckError("settings_changed", "Saved instruction host/cwd changed; discard the draft explicitly before starting a new import");
        if (!this.localFiles) throw new DeckError("offline", "Instruction import requires the assigned native worker");
        if (!await configurationIdle(tx, chat.id)) throw new DeckError("busy", "Conversation has unfinished work; stop/drain it before importing instructions");
        signal?.throwIfAborted();
        const taskId = await tx.createTask(this.instructionTask, { binding: { machineId: binding.machineId, cwd: binding.cwd }, previousHash: instructionHash(agent.instructions) }, { ownership: { kind: "conversation" } });
        receipt.taskId = taskId; return taskId;
      }, context);
    });
  }

  // Legacy internal admission retains its one-attempt rule. Only explicit public
  // open/reopen opts into a new attempt; accepted native operations never replay.
  allocateTerminal(id: string, requestId: string, target: RexTarget, signal?: AbortSignal, expectedBinding?: Binding, replacement?: { priorTaskId: number; sessionId?: string }): Promise<TaskId<RexResult>> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new DeckError("invalid", "Invalid Rex allocation request ID");
      let saved: RexTarget;
      try { saved = rexTarget(target); } catch { throw new DeckError("invalid", "Rex allocation needs an explicit local target and client"); }
      const hash = createHash("sha256").update(JSON.stringify([id, this.hubId, saved])).digest("hex");
      const chat = await this.chat(id);
      return chat.commit(async (tx) => {
        const receipt = await tx.doc(RexRequest, chat.id, requestId, hash);
        if (receipt.hash !== hash) throw new DeckError("conflict", "Rex allocation request ID reused with different launch arguments");
        if (receipt.taskId) {
          const original = (await tx.task(receipt.taskId as TaskId))?.input as { binding: Binding } | undefined;
          if (expectedBinding && (original?.binding.machineId !== expectedBinding.machineId || original?.binding.cwd !== expectedBinding.cwd)) throw new DeckError("conflict", "Rex allocation request ID reused with another host/cwd");
          return receipt.taskId as TaskId<RexResult>;
        }
        if (!await rexCoherent(tx, chat.id)) throw new DeckError("invalid", "Rex allocation requires a managed ownerless task with a coherent saved worker/cwd");
        const current = await tx.doc(ChatDoc, chat.id);
        if (expectedBinding && (current.machineId !== expectedBinding.machineId || current.cwd !== expectedBinding.cwd)) throw new DeckError("settings_changed", "Saved Rex worker/cwd changed");
        if (!this.localFiles) throw new DeckError("offline", "Rex allocation requires the assigned native worker");
        const doc = await tx.doc(RexDoc, chat.id);
        if (doc.taskId && !replacement) throw new DeckError("conflict", "This chat already has a Rex allocation attempt; use explicit open/reopen for a new attempt");
        if (replacement && doc.taskId !== replacement.priorTaskId) throw new DeckError("conflict", "Rex attempt changed; inspect before opening again");
        if (doc.taskId && (await tx.task(doc.taskId as TaskId))?.state.status !== "terminal") throw new DeckError("busy", "Rex creation is still pending; inspect status before another attempt");
        const plan = { ...saved, chatId: id, hubId: this.hubId, label: `deck-${this.hubId.slice(0, 8)}-chat-${id}`, allocationId: randomUUID(), ...(replacement?.sessionId ? { sessionId: replacement.sessionId } : {}) };
        if (Buffer.byteLength(JSON.stringify(plan)) > 16 * 1024) throw new DeckError("invalid", "Rex launch intent is too large");
        signal?.throwIfAborted();
        const taskId = await tx.createTask(this.rexTask, { binding: { machineId: current.machineId, cwd: current.cwd }, plan }, { ownership: { kind: "conversation" } });
        if (doc.binding) doc.previousBinding = doc.binding;
        delete doc.binding; delete doc.startup; delete doc.reconciliationTaskId;
        doc.taskId = taskId; doc.allocationId = plan.allocationId; receipt.taskId = taskId;
        return taskId;
      }, context);
    });
  }

  // Best-effort explicit terminal management, not a model tool or replay loop.
  async openTerminal(args: RexOpenArgs): Promise<RexOpenAck> {
    if (!validOpenArgs(args)) throw new DeckError("invalid", "Invalid Rex open arguments");
    if (!this.rexClient || !this.localFiles) throw new DeckError("offline", "Public Rex open requires the native hub launcher");
    const chat = await this.chat(args.chatId);
    const doc = await this.harness.snapshot(RexDoc, chat.id, context);
    const prior = doc?.taskId ? await this.harness.getTask(doc.taskId as TaskId, context) : undefined;
    const original = prior?.input as RexInput | undefined;
    if (original && args.target && (["executable", "server", "hostId", "instanceId"] as const).some((key) => args.target![key] !== undefined && args.target![key] !== original.plan[key])) throw new DeckError("conflict", "Rex target differs from the saved attempt; server migration is not supported");
    // Only first open resolves defaults. Never silently retarget saved attempts
    // after PATH/default server changes, nor resolve on the client's computer.
    const target = original?.plan ?? (validResolvedTarget(args.target) ? args.target : await this.inspector.resolveTarget(args.chatId, args.target ?? {}));
    const saved = rexTarget({ ...target, client: this.rexClient, port: args.port });
    const ack = (taskId: number, status: RexOpenAck["status"]): RexOpenAck => ({ version: 1, chatId: args.chatId, requestId: args.requestId, taskId: String(taskId), status, completion: "not_waited", bestEffort: true });
    // Retrieving an admitted request does not inspect/create or rewrite its plan.
    const receipt = await this.harness.snapshot(RexRequest, chat.id, args.requestId, context);
    if (receipt?.taskId) return ack(await this.allocateTerminal(args.chatId, args.requestId, saved), "admitted");
    if (prior && prior.state.status !== "terminal") throw new DeckError("busy", "Rex creation is still pending; inspect status before another attempt");
    let sessionId: string | undefined;
    if (doc?.binding) {
      const sample = await this.inspectTerminal(args.chatId);
      if (sample.status !== "sampled" || !sample.observation) throw new DeckError("conflict", "Rex inspection unavailable or changed; no new terminal requested");
      const state = sample.observation.state;
      if (state === "running") return ack(doc.taskId, "reused");
      if (state === "exited" || state === "missing_terminal") sessionId = doc.binding.sessionId;
      else if (state !== "missing_session") throw new DeckError("conflict", "Rex terminal is pending, unavailable or inconclusive; no new terminal requested");
    }
    const taskId = await this.allocateTerminal(args.chatId, args.requestId, saved, undefined, undefined, { priorTaskId: doc?.taskId ?? 0, ...(sessionId ? { sessionId } : {}) });
    return ack(taskId, "admitted");
  }

  async terminalStatus(id: string): Promise<RexStatusSnapshot> {
    const chat = await this.chat(id);
    const doc = await this.harness.snapshot(RexDoc, chat.id, context);
    const task = doc?.taskId ? await this.harness.getTask(doc.taskId as TaskId, context) : undefined;
    let status: RexStatusSnapshot["status"] = "unallocated";
    if (task) {
      status = "pending";
      if (task.state.status === "terminal") {
        const outcome = task.state.outcome;
        const result = outcome.status === "completed" ? outcome.result as RexResult : undefined;
        status = result && ["allocated", "not_allocated", "uncertain", "aborted"].includes(result.status) ? result.status : outcome.status === "aborted" ? "aborted" : "uncertain";
      }
    }
    // Like other live views these reads are samples, not an atomic health lease.
    // A binding commit observed after our document sample needs another read.
    if (status === "allocated" && !doc?.binding) status = "pending";
    return { version: 1, hubId: this.hubId, chatId: id, taskId: task ? String(task.id) : null, status, binding: doc?.binding ?? null, previousBinding: doc?.previousBinding ?? null, bestEffort: true };
  }

  // Explicit internal provenance repair only. Never creates/replaces Rex objects.
  reconcileTerminal(id: string, requestId: string, signal?: AbortSignal, expectedBinding?: Binding): Promise<TaskId<ReconcileResult>> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new DeckError("invalid", "Invalid Rex reconciliation request ID");
      const hash = createHash("sha256").update(JSON.stringify([id, this.hubId])).digest("hex");
      const chat = await this.chat(id);
      return chat.commit(async (tx) => {
        const receipt = await tx.doc(RexReconcileRequest, chat.id, requestId, hash);
        if (receipt.hash !== hash) throw new DeckError("conflict", "Rex reconciliation identity changed");
        if (receipt.taskId) {
          const input = (await tx.task(receipt.taskId as TaskId))?.input as { binding: Binding } | undefined;
          if (expectedBinding && (input?.binding.machineId !== expectedBinding.machineId || input?.binding.cwd !== expectedBinding.cwd)) throw new DeckError("conflict", "Rex reconciliation request ID reused with another host/cwd");
          return receipt.taskId as TaskId<ReconcileResult>;
        }
        if (!await rexCoherent(tx, chat.id)) throw new DeckError("invalid", "Rex reconciliation requires the original ownerless task worker/cwd");
        const current = await tx.doc(ChatDoc, chat.id); const doc = await tx.doc(RexDoc, chat.id);
        if (expectedBinding && (current.machineId !== expectedBinding.machineId || current.cwd !== expectedBinding.cwd)) throw new DeckError("settings_changed", "Saved Rex worker/cwd changed");
        if (!this.localFiles) throw new DeckError("offline", "Rex reconciliation requires the assigned native worker");
        if (doc.binding) throw new DeckError("conflict", "Rex binding is already known; use fresh inspection, not reconciliation");
        const original = doc.taskId ? await tx.task(doc.taskId as TaskId) : undefined;
        const input = original?.input as RexInput | undefined;
        if (!original || original.kind !== REX_KIND || original.conversationId !== chat.id || !input?.binding || !validRexAllocationPlan(input.plan) || input.plan.chatId !== id || input.plan.hubId !== this.hubId || (input.plan.allocationId ?? undefined) !== doc.allocationId || input.binding.machineId !== current.machineId || input.binding.cwd !== current.cwd) throw new DeckError("conflict", "Rex reconciliation needs the original saved allocation intent");
        if (original.state.status !== "terminal") throw new DeckError("busy", "Wait for the original Rex allocation task to settle");
        if (doc.reconciliationTaskId && (await tx.task(doc.reconciliationTaskId as TaskId))?.state.status !== "terminal") throw new DeckError("busy", "Rex reconciliation already in progress");
        const request = allocationRequest(doc.taskId, input);
        if (!validRexAllocationReceiptQuery({ operationId: String(doc.taskId), request }) || Buffer.byteLength(request) > 128 * 1024) throw new DeckError("invalid", "Rex reconciliation intent is too large");
        signal?.throwIfAborted();
        const taskId = await tx.createTask(this.reconcileTask, { allocationTaskId: doc.taskId, binding: { machineId: current.machineId, cwd: current.cwd }, request }, { ownership: { kind: "conversation" } });
        doc.reconciliationTaskId = taskId; receipt.taskId = taskId; return taskId;
      }, context);
    });
  }

  // Fresh read only, internal trusted operator API. No allocation or health write.
  inspectTerminal(id: string, signal?: AbortSignal) { return this.inspector.inspect(id, signal); }

  async terminalBinding(id: string) {
    const chat = await this.chat(id);
    return (await this.harness.snapshot(RexDoc, chat.id, context))?.binding;
  }

  // Startup observation only: never adopts objects, restarts work, or reports
  // current health. The client uses its native REX_BLOCK, not a block argv flag.
  registerTerminalStartup(id: string, allocationId: string, blockId: string) {
    return this.serial(async () => {
      if (!rexUuid(allocationId) || !rexBlock(blockId)) throw new DeckError("invalid", "Invalid Rex startup identity");
      const chat = await this.chat(id);
      return chat.commit(async (tx) => {
        const doc = await tx.doc(RexDoc, chat.id);
        const task = doc.taskId ? await tx.task(doc.taskId as TaskId) : undefined;
        const input = task?.input as RexInput | undefined;
        if (!task || task.kind !== REX_KIND || task.conversationId !== chat.id || doc.allocationId !== allocationId || input?.plan.allocationId !== allocationId || input.plan.hubId !== this.hubId || input.plan.chatId !== id) throw new DeckError("conflict", "Rex startup does not match the saved allocation intent");
        if (!await rexCoherent(tx, chat.id, input.binding)) throw new DeckError("settings_changed", "Rex startup requires the original ownerless task worker/cwd");
        if ((doc.startup && doc.startup.blockId !== blockId) || (doc.binding && doc.binding.blockId !== blockId)) throw new DeckError("conflict", "Rex startup block conflicts with saved allocation evidence");
        doc.startup = { blockId };
        return { ...rexStartup(id, doc), allocationId, blockId, registered: true as const };
      }, context);
    });
  }

  async terminalStartup(id: string) {
    const chat = await this.chat(id);
    return rexStartup(id, await this.harness.snapshot(RexDoc, chat.id, context));
  }

  async instructionSource(id: string) {
    const chat = await this.chat(id);
    const source = (await this.harness.snapshot(InstructionSourceDoc, chat.id, context))?.source;
    return source && source.sha256 === instructionHash((await chat.agent(context)).instructions) ? source : undefined;
  }

  async instructionsStatus(id: string, taskId?: string) {
    const chat = await this.chat(id);
    const task = await chat.commit(async (tx) => {
      if (taskId === undefined) return (await tx.scanTasks({ conversationId: chat.id, kind: IMPORT_KIND, order: "descending" }, 1)).items[0];
      const task = await tx.task(positiveId(taskId, "instruction task") as TaskId);
      if (!task || task.conversationId !== chat.id || task.kind !== IMPORT_KIND) throw new DeckError("not_found", "Unknown instruction import in selected chat");
      return task;
    }, context);
    return instructionSnapshot(String(chat.id), await this.instructionSource(id), projectInstructionTask(task));
  }

  private selection(agent: Pick<AgentChange, "model" | "thinkingLevel">): ModelSelection {
    if (!agent.model) throw new DeckError("invalid", "Chat has no selected model");
    return { provider: agent.model.provider, modelId: agent.model.modelId, thinkingLevel: agent.thinkingLevel ?? "off" };
  }

  async modelSettings(id: string): Promise<ModelSettingsSnapshot> {
    const chat = await this.chat(id);
    // Registered chat catalog only: no network refresh, credential/header exposure
    // or claim that the account is entitled to every catalog entry.
    const models = this.models.getModels().flatMap((model) => {
      const thinkingLevels = getSupportedThinkingLevels(model);
      return thinkingLevels.length ? [{ provider: model.provider, modelId: model.id, name: prefixUnits(model.name, 160), thinkingLevels, defaultThinkingLevel: clampThinkingLevel(model, "medium") }] : [];
    }).sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
    if (models.length > 256) throw new DeckError("too_large", "Model catalog exceeds client limit");
    const selection = this.selection(await this.harness.snapshot(AgentDoc, chat.id, context) ?? {});
    return { hubId: this.hubId, chatId: id, selection, defaultModel: { ...this.defaultModel }, models };
  }

  setModelSettings(args: SetModelSettingsArgs): Promise<ModelSettingsAck> {
    return this.serial(async () => {
      if (!validSetModelSettingsArgs(args)) throw new DeckError("invalid", "Invalid model settings");
      const chat = await this.chat(args.chatId);
      const saved = await this.harness.snapshot(ChatDoc, chat.id, context);
      if (!saved || !["main", "task"].includes(saved.kind)) throw new DeckError("invalid", "Only ownerless Deck chats can change model settings");
      return chat.commit(async (tx) => {
        const binding = await tx.doc(ChatDoc, chat.id);
        const record = await tx.conversation(chat.id);
        if (!record || record.owner || binding.kind === "subagent") throw new DeckError("invalid", "Owned subagents inherit their owner's settings");
        if (!await configurationIdle(tx, chat.id)) throw new DeckError("busy", "Conversation has unfinished work; wait for it to settle before changing model/thinking");
        const agent = await tx.doc(AgentDoc, chat.id);
        if (!sameSelection(this.selection(agent), args.expected)) throw new DeckError("conflict", "Model settings changed; refresh before choosing again");
        const model = this.models.getModel(args.selection.provider, args.selection.modelId);
        if (!model || !getSupportedThinkingLevels(model).includes(args.selection.thinkingLevel)) throw new DeckError("invalid", "Model or thinking level is not supported by this hub");
        // Keep model extensions intact when changing only thinking. No cwd,
        // instructions, bindings, prior captures or outstanding inputs are rewritten.
        await configureAgent(tx, chat.id, {
          ...(agent.model?.provider === args.selection.provider && agent.model?.modelId === args.selection.modelId ? {} : { model: { provider: args.selection.provider, modelId: args.selection.modelId } }),
          thinkingLevel: args.selection.thinkingLevel,
        });
        return { hubId: this.hubId, chatId: args.chatId, selection: { ...args.selection } };
      }, context);
    });
  }

  configure(id: string, change: AgentChange) {
    return this.serial(async () => {
      const chat = await this.chat(id);
      return chat.commit(async (tx) => {
        // Query Pi's authoritative work records, not a second execution tracker. This
        // includes pending/parked/background work and effects still draining after stop.
        if (!await configurationIdle(tx, chat.id)) throw new DeckError("busy", "Conversation has unfinished work; stop/drain it before configuring");
        const binding = await tx.doc(ChatDoc, chat.id);
        if (change.cwd !== undefined && change.cwd !== binding.cwd) throw new DeckError("invalid", "Configure cannot move or clear the saved tool-host cwd");
        await configureAgent(tx, chat.id, change);
        if (change.instructions !== undefined) delete (await tx.doc(InstructionSourceDoc, chat.id)).source;
      }, context);
    });
  }
  async progress(id: string) {
    const chat = await this.chat(id);
    return projectProgress(String(chat.id), await this.harness.snapshot(LiveDoc, chat.id, context));
  }
  async activity(id: string, includeAgentStatus = false): Promise<ActivitySnapshot> {
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
      ...(includeAgentStatus ? { agentStatus: await chat.commit((tx) => agentStatus(tx, chat.id, (inbox?.items.length ?? 0) > 0), context) } : {}),
      ...(live?.run ? { runTaskId: String(live.run.taskId) } : {}),
      ...(live?.generation ? { generation: { attempt: live.generation.attempt, phase: live.generation.retry ? "retrying" : live.generation.deferred ? "deferred" : "generating" } } : {}),
      tools: tools.slice(0, 32).map((tool) => ({ callId: prefixUnits(tool.callId, 128), name: prefixUnits(tool.name, 80), status: tool.status, ...(tool.taskId === undefined ? {} : { taskId: String(tool.taskId) }), nested: "parentTaskId" in tool })),
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
