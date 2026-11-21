// Pi 1.4.0 compatibility boundary. Native effects are supplied by the hub, never inferred here.
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { agentStatus } from "./agent-status.js";
import { validAgentName, validAgentRune, type SubagentSnapshot } from "./generated/contracts.js";
import { sameSelection } from "./model-settings-contracts.js";
import { validSetModelSettingsArgs, type ModelRef, type ModelSelection, type ModelSettingsSnapshot, type ModelSettingsAck, type SetModelSettingsArgs } from "./generated/contracts.js";
import { AgentDoc, createRegistry, configure as configureAgent, defineDoc, defineDocFamily, Harness, LiveDoc, InboxDoc, type ConversationId, type Conversation, type AgentChange, type Cursor, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { instructionSnapshot, projectInstructionTask } from "./instructions-view.js";
import { projectProgress } from "./progress.js";
import { configurationIdle, importingInstructions, instructionHash, instructionImport, IMPORT_KIND, InstructionRequest, InstructionSourceDoc, type InstructionImportResult } from "./instruction-import.js";
import { RexInspector } from "./rex-inspection.js";
import { rexReconciliation, RexReconcileRequest, allocationRequest, type ReconcileResult } from "./rex-reconciliation.js";
import { validOpenManagedChildArgs, validOpenArgs, validAdoptArgs, validResolvedTarget } from "./rex-open-contracts.js";
import { validRexAllocationPlan, validRexAllocationReceiptQuery, type OpenManagedChildArgs, type OpenManagedChildAck, type RexOpenArgs, type RexOpenAck, type RexAdoptArgs, type RexAdoptAck, type RexStatusSnapshot, type ChatListPage, type ActivitySnapshot } from "./generated/contracts.js";
import { prefixUnits } from "./view-text.js";
import { REX_KIND, rexAllocation, RexDoc, RexRequest, rexCoherent, rexTarget, rexUuid, rexBlock, rexStartup, type RexInput, type RexTarget, type RexResult } from "./rex-allocation.js";
import { bindImplementation, checkCompatibility, defaultImplementation, stampImplementation } from "./compatibility.js";
import { nativeFiles, type HostFiles } from "./host-files.js";
import { foregroundSubagent } from "./subagent.js";
import { taskControl } from "./task-control.js";
import { taskTools } from "./task-tools.js";
import { McpGrantsDoc, extensionName, grantKey, profileGrant, mcpExtensions } from "./mcp-tools.js";
import { validCatalog } from "./mcp-contracts.js";
import { validMcpGrantArgs, type McpCatalog, type McpGrantArgs, type McpGrantSnapshot } from "./generated/contracts.js";
import { projectToolInventory } from "./tool-inventory.js";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { ChatDoc, type Binding } from "./chat-doc.js";
import { DeckError } from "./deck-error.js";
export { ChatDoc, DeckError, type Binding };
import { validHosts } from "./host-inventory.js";
import { briefFields, briefInstructions, validBriefBinding } from "./task-brief.js";
import { validManagedChildProblem } from "./mutation-contracts.js";
import { validChain, type MessageChain } from "./message-causality.js";
import { validMachineIdentity, type TaskBrief, type HostInventory } from "./generated/contracts.js";
import { ManagedChildRequest, ManagedChildOpenRequest, managedAgentSnapshot, independentDeckChat, assertManagedMessageRelation } from "./managed-child.js";
import { assignAgentName, agentNameFields } from "./agent-names.js";
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
function positiveId(id: string, kind: string): number {
  const value = Number(id);
  if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(value)) throw new DeckError("invalid", `Invalid ${kind} ID`);
  return value;
}
function chatId(id: string): ConversationId { return positiveId(id, "conversation") as ConversationId; }
export type Input = { requestId: string; text: string; mode: "steer" | "followUp"; origin?: { kind: "task-tool"; chatId: string; taskId: string; chain?: MessageChain } };
import { AsyncLocalStorage } from "node:async_hooks";
import { workerIdle } from "./worker-handoff.js";

export type RuntimeOptions = {
  models: Models;
  model: { provider: string; modelId: string };
  binding: Binding;
  environment: (binding: Binding) => ExecutionEnv | undefined;
  hostFiles?: HostFiles;
  mcpCatalog?: McpCatalog;
  // Trusted native registration scope; checked before any recovered work resumes.
  expectedHubId?: string;
  // Trusted launcher supplies its own Deck wrapper, never public caller argv.
  rexClient?: string;
  admissionGuard?: () => Promise<void>;
  validateSavedModels?: boolean;
  authentication?: "mock" | "api_key" | "chatgpt_oauth";
  // Trusted embedded callers identify injected code; production main fingerprints
  // the actual runtime/dependency closure, Node and native executable.
  implementation?: string;
};

type RuntimeConfig = {
  hubId: string;
  implementation: string;
  models: Models;
  defaultModel: ModelRef;
  host: HostFiles | undefined;
  machineId: string;
  rexClient: string | undefined;
  authentication: RuntimeOptions["authentication"];
  admissionGuard: RuntimeOptions["admissionGuard"];
};
type InstalledExtensions = {
  importInstructions: ReturnType<typeof instructionImport>["task"];
  allocate: ReturnType<typeof rexAllocation>["task"];
  reconcile: ReturnType<typeof rexReconciliation>["task"];
  catalog: McpCatalog;
  mcp: ReturnType<typeof mcpExtensions>;
};

export class DeckRuntime {
  private readonly workerPauses = new Map<string, string>();
  private requireWorkerAdmission(machine: string) { if (this.workerPauses.has(machine)) throw new DeckError("busy", "Worker upgrade in progress; input was not admitted"); }
  private async mutableChat(id: string) {
    const chat = await this.chat(id);
    const binding = await this.harness.snapshot(ChatDoc, chat.id, context);
    if (binding) this.requireWorkerAdmission(binding.machineId);
    return chat;
  }
  pauseWorker(machine: string, id: string) {
    return this.serial(async () => {
      const existing = this.workerPauses.get(machine);
      if (existing && existing !== id) throw new DeckError("busy", "Another worker transition owns admission");
      this.workerPauses.set(machine, id);
    });
  }
  workerDrained(machine: string, id: string) {
    return this.serial(async () => {
      if (this.workerPauses.get(machine) !== id) throw new DeckError("conflict", "Worker transition changed");
      return this.harness.commit(() => workerIdle(this.storage, machine), context);
    });
  }
  resumeWorker(machine: string, id: string) {
    return this.serial(async () => {
      if (this.workerPauses.has(machine) && this.workerPauses.get(machine) !== id) throw new DeckError("conflict", "Worker transition changed");
      this.workerPauses.delete(machine);
    });
  }
  private tail: Promise<unknown> = Promise.resolve();
  private readonly commandGuard = new AsyncLocalStorage<() => Promise<void>>();
  async guardedCommand<T>(guard: () => Promise<void>, fn: () => Promise<T>): Promise<T> {
    return this.commandGuard.run(guard, async () => { await guard(); const value = await fn(); await guard(); return value; });
  }
  requestStop(id: string): Promise<void> {
    return this.serial(async () => { const chat = await this.chat(id); void chat.abort(context).catch(() => { process.stderr.write("deck runtime: stop failed; inspect activity\n"); }); });
  }
  private readonly inspector: RexInspector;
  private constructor(
    readonly harness: Harness, readonly main: Conversation,
    private readonly storage: import("@earendil-works/pi-durable").Storage,
    private readonly config: RuntimeConfig, private readonly extensions: InstalledExtensions,
  ) { this.inspector = new RexInspector(this, config.host); }

  get hubId() { return this.config.hubId; }
  get implementation() { return this.config.implementation; }
  get localFiles() { return !!this.config.host; }
  get localMachineId() { return this.config.machineId; }
  get rexClient() { return this.config.rexClient; }
  get authentication() { return this.config.authentication; }

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
    if (options.hostFiles) registry.install(nativeFiles(options.hostFiles, options.binding.machineId));
    const importer = instructionImport(options.hostFiles); registry.install(importer.extension);
    const rex = rexAllocation(options.hostFiles); registry.install(rex.extension);
    const reconciler = rexReconciliation(options.hostFiles); registry.install(reconciler.extension);
    const baseExtensions = registry.snapshot().installed();
    const catalog: McpCatalog = options.mcpCatalog === undefined ? {version:1,profiles:[]} : structuredClone(options.mcpCatalog);
    if(!validCatalog(catalog) || (catalog.profiles.length && !options.hostFiles)) throw new DeckError("invalid","Invalid MCP catalog or missing native host");
    const installed = options.hostFiles ? mcpExtensions(catalog, options.hostFiles, current, options.binding.machineId) : [];
    for(const extension of installed) registry.install(extension);
    const baseImplementation = bindImplementation(options.implementation ?? await defaultImplementation(), !!options.hostFiles);
    const implementation = catalog.profiles.length ? createHash("sha256").update(JSON.stringify(["deck.mcp.v1",baseImplementation,catalog])).digest("hex") : baseImplementation;
    const storage = await openNodeSqliteStorage(path);
    try { await checkCompatibility(storage, implementation); }
    catch (error) { await storage.close(context); throw error; }
    const harness = await Harness.open(storage, {
      models: options.models, registry,
      settings: { steeringMode: "all", followUpMode: "one-at-a-time", extensions: baseExtensions },
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
        init: async (tx, id) => {
          const metadata = await tx.doc(ChatDoc, id);
          Object.assign(metadata, { machineId: options.binding.machineId, cwd: options.binding.cwd });
          await assignAgentName(tx, id, metadata, undefined, true);
        },
      });
      // Upgrade Deck conversations before recovered work resumes. Do not create
      // Deck metadata for unmanaged Pi conversations or rewrite history/receipts.
      // Parents precede children in creation order, so backfilled parent names are
      // available before deriving a child's prefix. Snapshots stay outside commits.
      const { assignSubagentName } = await import("./agent-names.js");
      let namesCursor: Cursor | undefined;
      do {
        const page = await harness.commit(tx => tx.scanConversations({ order: "ascending" }, 100, namesCursor), context);
        for (const record of page.items) {
          const saved = await harness.snapshot(ChatDoc, record.id, context);
          if (!saved) continue;
          if (saved.kind === "subagent") {
            const owner = record.owner;
            if (!owner) continue; // Forged/legacy display hints do not prove ownership.
            const parent = await harness.snapshot(ChatDoc, owner.conversationId, context);
            await harness.commit(async tx => {
              const metadata = await tx.doc(ChatDoc, record.id);
              if (metadata.parentChatId !== String(owner.conversationId) || metadata.ownerTaskId !== String(owner.taskId)
                || (await tx.task(owner.taskId))?.conversationId !== owner.conversationId) return;
              await assignSubagentName(tx, record.id, metadata, parent ?? {});
            }, context);
          } else {
            await harness.commit(async tx => assignAgentName(tx, record.id, await tx.doc(ChatDoc, record.id), undefined, record.id === main.id), context);
          }
        }
        namesCursor = page.next;
      } while (namesCursor);
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
      runtime = new DeckRuntime(harness, main, storage, {
        hubId, implementation, models: options.models, defaultModel: { ...options.model },
        host: options.hostFiles, machineId: options.binding.machineId, rexClient: options.rexClient,
        authentication: options.authentication, admissionGuard: options.admissionGuard,
      }, { importInstructions: importer.task, allocate: rex.task, reconcile: reconciler.task, catalog, mcp: installed });
      harness.resume();
      return runtime;
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }

  // Serializes only admission/configuration commits, never generation or host effects.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const guard = this.commandGuard.getStore();
    const result = this.tail.then(async () => {
      await guard?.();
      // Scope this command's admission, not Pi-owned work it may schedule.
      return this.commandGuard.exit(fn);
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async chat(id: string): Promise<Conversation> {
    const chat = await this.harness.conversation(chatId(id), context);
    if (!chat) throw new DeckError("not_found", "Unknown conversation");
    return chat;
  }

  async listChats({ limit = 50, after, includeObservations = false }: { limit?: number; after?: string; includeObservations?: boolean } = {}): Promise<ChatListPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DeckError("invalid", "Chat page limit must be an integer from 1 to 100");
    // Pi 1.4.0's ID-ordered scan cursor stays behind this adapter. The wire continuation
    // is the last scanned conversation ID, including records without Deck metadata.
    const cursor = after === undefined ? undefined : { after: chatId(after), order: "ascending" };
    const page = await this.harness.commit((tx) => tx.scanConversations({ order: "ascending" }, limit, cursor), context);
    const items: ChatListPage["items"] = [];
    for (const record of page.items) {
      const metadata = await this.harness.snapshot(ChatDoc, record.id, context);
      let observation: { activity: "busy" | "idle" | "unknown"; rexState: string } | undefined;
      if (metadata && includeObservations) {
        observation = { activity: "unknown", rexState: "unknown" };
        try { const activity = await this.activity(String(record.id)); observation.activity = activity.busy || activity.queued > 0 ? "busy" : "idle"; } catch { /* Unknown is not idle. */ }
        try { observation.rexState = (await this.terminalStatus(String(record.id))).status; } catch { /* Saved allocation observation only, not terminal health. */ }
      }
      if (metadata) items.push({ ...observation, ...agentNameFields(metadata), chatId: String(record.id), kind: metadata.kind, title: metadata.title, machineId: metadata.machineId, cwd: metadata.cwd, ...(metadata.managedParentChatId ? { managedParentChatId: metadata.managedParentChatId } : {}), ...(metadata.parentChatId ? { parentChatId: metadata.parentChatId } : {}), ...(metadata.ownerTaskId ? { ownerTaskId: metadata.ownerTaskId } : {}), ...(metadata.brief ? { brief: metadata.brief } : {}) });
    }
    return { items, ...(page.next ? { next: String(page.items.at(-1)!.id) } : {}) };
  }

  private mcpActive=0;
  async mcpCall<T>(work:()=>Promise<T>):Promise<T> { this.mcpActive++; try { return await work(); } finally { this.mcpActive--; } }
  mcpBindingAllowed(profile: import("./generated/contracts.js").McpProfile, taskMachine: string): boolean {
    return validMachineIdentity(taskMachine) && (profile.machineId===taskMachine || (profile.workspace==="fixed" && profile.machineId===this.localMachineId));
  }
  mcpCatalog(): McpCatalog { return structuredClone(this.extensions.catalog); }
  // Serialize with grant/configuration changes so the public surface and saved
  // grant revision cannot be spliced across a concurrent control request.
  toolInventory(id: string) {
    return this.serial(async () => {
      const chat = await this.chat(id);
      const agent = await chat.agent(context);
      const binding = await this.harness.snapshot(ChatDoc, chat.id, context);
      const grants = await this.harness.snapshot(McpGrantsDoc, chat.id, context);
      return projectToolInventory(String(chat.id), agent, this.extensions.catalog, grants?.profiles ?? [], this.localMachineId, binding?.machineId, profile => this.mcpBindingAllowed(profile, binding?.machineId ?? ""), {
        ...(binding?.loadedSkills?.length ? { loadedSkills: binding.loadedSkills } : {}), ...(binding?.userAgentsMdHash ? { agentsMdLoaded: true } : {}),
      });
    });
  }
  async toolProfiles(id: string): Promise<McpGrantSnapshot> {
    const chat=await this.chat(id); const grants=await this.harness.snapshot(McpGrantsDoc,chat.id,context);
    return {chatId:id,revision:grants?.revision??0,profiles:grants?.profiles.map(g=>({...g}))??[]};
  }
  setToolProfiles(args: McpGrantArgs): Promise<McpGrantSnapshot> {
    return this.serial(async()=>{
      if(!validMcpGrantArgs(args)) throw new DeckError("invalid","Invalid MCP grant change");
      const chat=await this.mutableChat(args.chatId); const agent=await chat.agent(context);
      return chat.commit(async tx=>{
        const record=await tx.conversation(chat.id), binding=await tx.doc(ChatDoc,chat.id), saved=await tx.doc(McpGrantsDoc,chat.id);
        if(!record || record.owner || binding.kind==="subagent") throw new DeckError("invalid","Only independent chats can change MCP grants");
        if(this.mcpActive!==0 || !await configurationIdle(tx,chat.id)) throw new DeckError("busy","Stop/drain work before changing MCP grants");
        if(saved.revision!==args.expectedRevision) throw new DeckError("settings_changed","MCP grants changed; observe before another change");
        const selected=[]; const keys=new Set<string>();
        for(const grant of args.profiles) {
          const key=grantKey(grant); const profile=this.extensions.catalog.profiles.find(p=>grantKey(profileGrant(p))===key);
          if(keys.has(key) || !profile || !this.mcpBindingAllowed(profile,binding.machineId)) throw new DeckError("invalid","MCP profile/host/revision is not approved for this binding");
          keys.add(key); selected.push(this.extensions.mcp.find(e=>e.name===extensionName(profile))!);
        }
        if(selected.reduce((count,e)=>count+(e.tools?.length??0),0)>64) throw new DeckError("invalid","At most 64 MCP tools can be granted to one conversation");
        if(JSON.stringify(saved.profiles)!==JSON.stringify(args.profiles)) {
          if(saved.revision>=Number.MAX_SAFE_INTEGER) throw new DeckError("invalid","MCP grant revision exhausted; no change applied");
          await configureAgent(tx,chat.id,{extensions:[...agent.extensions.filter(e=>!e.name.startsWith("deck.mcp.")),...selected]});
          saved.profiles=args.profiles.map(g=>({...g})); saved.revision++;
        }
        return {chatId:args.chatId,revision:saved.revision,profiles:saved.profiles.map(g=>({...g}))};
      },context);
    });
  }

  async hosts(): Promise<HostInventory> {
    const sampledAtMs = Date.now();
    const items: HostInventory["items"] = [];
    if (this.localMachineId && validMachineIdentity(this.localMachineId)) items.push({ machineId: this.localMachineId, kind: "local", rex: !!this.rexClient, connection: "local" });
    items.push(...(await this.config.host?.registeredHosts?.() ?? []));
    const inventory = { sampledAtMs, items };
    if (!validHosts(inventory)) throw new DeckError("invalid", "Invalid registered-host inventory");
    return inventory;
  }
  async legacyCreatedTask(title: string, binding: Binding, requestId: string): Promise<Conversation | undefined> {
    const saved = await this.harness.snapshot(TaskRequest, requestId, context);
    const hash = createHash("sha256").update(JSON.stringify([title, binding.machineId, binding.cwd])).digest("hex");
    return saved?.chatId && saved.hash === hash ? this.chat(String(saved.chatId)) : undefined;
  }
  async hasLegacyMessageReceipt(id: string, input: Input): Promise<boolean> {
    // Recovery only: never turn a legacy reservation without a submission into
    // fresh unbudgeted agent input. Exact hashes retain their old provenance.
    if (!input.origin || input.origin.chain !== undefined) return false;
    const chat = await this.chat(id);
    const existing = await chat.commit(tx => tx.submissionByRequest(chat.id, input.requestId), context);
    if (!existing || existing.type !== "input") return false;
    const reservation = await this.harness.snapshot(Admission, chat.id, input.requestId, context);
    return reservation?.hash === createHash("sha256").update(JSON.stringify([input.text, input.mode, input.origin])).digest("hex");
  }
  async registeredTarget(machineId: string): Promise<boolean> {
    return (await this.hosts()).items.some(h => h.machineId === machineId);
  }

  createTask(title: string, binding: Binding, requestId: string = randomUUID(), signal?: AbortSignal, suppliedBrief: TaskBrief = {}): Promise<Conversation> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      this.requireWorkerAdmission(binding.machineId);
      if (!title.trim() || !binding.machineId || !binding.cwd.startsWith("/")) throw new DeckError("invalid", "Task needs a title, host and absolute cwd");
      if (!requestId || requestId.length > 200) throw new DeckError("invalid", "Invalid task request ID");
      const brief = briefFields(suppliedBrief); const hasBrief = Object.keys(brief).length > 0;
      if (hasBrief && !validBriefBinding(title, binding.cwd)) throw new DeckError("invalid", "Brief creation requires bounded title and cwd");
      // Preserve every historical title-only request hash; presence of even an empty
      // brief field opts into a new identity, without rewriting old receipts.
      const hash = createHash("sha256").update(JSON.stringify(hasBrief ? ["deck.task-create.v2", title, binding.machineId, binding.cwd, brief] : [title, binding.machineId, binding.cwd])).digest("hex");
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
        agent: { ...(agent.model ? { model: agent.model } : {}), thinkingLevel: agent.thinkingLevel, cwd: binding.cwd, ...(hasBrief ? { instructions: briefInstructions(title, brief) } : {}) },
        init: async (tx, id) => {
          const metadata = await tx.doc(ChatDoc, id);
          Object.assign(metadata, { machineId: binding.machineId, cwd: binding.cwd, title, kind: "task", ...(hasBrief ? { brief } : {}) });
          await assignAgentName(tx, id, metadata);
          (await tx.doc(TaskRequest, requestId, hash)).chatId = id;
        },
      }, context);
    });
  }

  createManagedChild(parentId: string, title: string | undefined, requestId: string, suppliedBrief: TaskBrief = {}, signal?: AbortSignal): Promise<Conversation> {
    const guard = this.commandGuard.getStore();
    return this.serial(async () => {
      signal?.throwIfAborted();
      const parent = await this.chat(parentId);
      if (typeof requestId !== "string" || !requestId || requestId.length > 200 || !requestId.isWellFormed()) throw new DeckError("invalid", "Invalid managed child request ID");
      const binding = await this.harness.snapshot(ChatDoc, parent.id, context);
      const record = await this.harness.commit(tx => tx.conversation(parent.id), context);
      if (!independentDeckChat(record, binding, this.main.id) || !binding) throw new DeckError("invalid", "Managed children require canonical main or an independent task parent, including a managed parent");
      this.requireWorkerAdmission(binding.machineId);
      if ((title !== undefined && typeof title !== "string") || !binding.machineId || !validBriefBinding(title ?? "child", binding.cwd)) throw new DeckError("invalid", "Managed child needs a bounded title and coherent parent binding");
      if (title === undefined && !validManagedChildProblem(suppliedBrief)) throw new DeckError("invalid", "Problem-only managed child needs a nonblank problem (at most 2048 UTF-8 bytes) and exactly empty description, without overrides");
      const brief = briefFields(suppliedBrief);
      // Do not change the historical explicit-title hash, even when it happens
      // to equal an allocated name. Mode is pinned before any name allocation.
      const hash = createHash("sha256").update(JSON.stringify(title === undefined
        ? ["deck.managed-child-create.problem.v1", parentId, brief]
        : ["deck.managed-child-create.v1", parentId, title, brief])).digest("hex");
      const prior = await this.harness.snapshot(ManagedChildRequest, requestId, context);
      if (prior) {
        if (prior.hash !== hash) throw new DeckError("conflict", "Managed child request ID already used with different arguments");
        if (prior.chatId) return this.chat(String(prior.chatId));
      }
      // Resolve outside the commit; verify the stored choices again inside it.
      // Tool discovery/import may update Pi's agent outside Deck's serial line.
      const saved = await this.harness.snapshot(AgentDoc, parent.id, context);
      const agent = await parent.agent(context);
      if (agent.cwd !== binding.cwd) throw new DeckError("invalid", "Parent agent cwd differs from its saved binding");
      const snapshot = managedAgentSnapshot(agent, saved ?? {}, title ?? "", brief, binding.cwd);
      await guard?.();
      signal?.throwIfAborted();
      const createdId = await this.harness.commit(async tx => {
        // All table reads precede createConversation (Pi rejects read-after-write).
        const currentRecord = await tx.conversation(parent.id);
        const currentBinding = await tx.doc(ChatDoc, parent.id);
        const currentAgent = await tx.doc(AgentDoc, parent.id);
        const grants = await tx.doc(McpGrantsDoc, parent.id);
        const receipt = await tx.doc(ManagedChildRequest, requestId, hash);
        if (receipt.hash !== hash) throw new DeckError("conflict", "Managed child request ID already used with different arguments");
        if (receipt.chatId) return receipt.chatId;
        if (!independentDeckChat(currentRecord, currentBinding, this.main.id)) throw new DeckError("invalid", "Managed child parent is not independent");
        if (JSON.stringify(currentAgent) !== JSON.stringify(saved ?? {}) || currentBinding.machineId !== binding.machineId || currentBinding.cwd !== binding.cwd) throw new DeckError("settings_changed", "Parent settings changed during managed child creation; retry the same request");
        signal?.throwIfAborted();
        const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const metadata = await tx.doc(ChatDoc, created.id);
        Object.assign(metadata, { kind: "task", brief, managedParentChatId: parentId, machineId: binding.machineId, cwd: binding.cwd });
        await assignAgentName(tx, created.id, metadata);
        // Name claim, canonical title, immutable instructions and receipt all
        // commit with the child. Replays return above without consuming a name.
        metadata.title = title ?? metadata.agentName!;
        Object.assign(await tx.doc(AgentDoc, created.id), snapshot, { instructions: briefInstructions(metadata.title, brief) });
        Object.assign(await tx.doc(McpGrantsDoc, created.id), { revision: grants.revision, profiles: grants.profiles.map(grant => ({ ...grant })) });
        receipt.chatId = created.id;
        return created.id;
      }, context);
      return this.chat(String(createdId));
    });
  }

  admit(id: string, input: Input, signal?: AbortSignal) {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (!input.requestId || input.requestId.length > 200 || !input.text.trim() || !["steer", "followUp"].includes(input.mode)) {
        throw new DeckError("invalid", "Input needs requestId, text and a supported mode");
      }
      const origin = input.origin === undefined ? undefined : { kind: input.origin.kind, chatId: input.origin.chatId, taskId: input.origin.taskId, ...(input.origin.chain === undefined ? {} : { chain: input.origin.chain }) };
      if (origin) {
        if (origin.kind !== "task-tool") throw new DeckError("invalid", "Unsupported input origin");
        positiveId(origin.chatId, "origin conversation"); positiveId(origin.taskId, "origin task");
        if (origin.chain !== undefined && (!validChain(origin.chain) || origin.chain.hop < 1)) throw new DeckError("invalid", "Invalid message provenance");
      }
      const chat = await this.mutableChat(id);
      const target = await this.harness.snapshot(ChatDoc, chat.id, context);
      const source = origin ? await this.harness.snapshot(ChatDoc, chatId(origin.chatId), context) : undefined;
      const existing = await chat.commit(async (tx) => {
        const record = await tx.conversation(chat.id);
        if (!record || record.owner || target?.kind === "subagent") throw new DeckError("invalid", "Owned chats accept input only through their owning tool; inspect or stop them instead");
        if (origin) {
          const sender = await tx.conversation(chatId(origin.chatId));
          if (!source || !target || !independentDeckChat(sender, source, this.main.id) || !independentDeckChat(record, target, this.main.id)) throw new DeckError("invalid", "Agent messages require independent Deck source and target chats");
          assertManagedMessageRelation(origin.chatId, source, id, target);
        }
        const existing = await tx.submissionByRequest(chat.id, input.requestId);
        // Check before resolving the agent: the import applies outside this serial
        // admission line, so a later-only check could capture pre-apply instructions.
        if (!existing && await importingInstructions(tx, chat.id)) throw new DeckError("busy", "Conversation is importing instructions; wait for its Pi task to settle");
        return existing;
      }, context);
      signal?.throwIfAborted();
      if (!existing) await this.config.admissionGuard?.();
      signal?.throwIfAborted();
      const hash = createHash("sha256").update(JSON.stringify(origin ? [input.text, input.mode, origin] : [input.text, input.mode])).digest("hex");
      const agent = await chat.agent(context);
      const capture = await chat.commit(async (tx) => {
        if (!existing && await importingInstructions(tx, chat.id)) throw new DeckError("busy", "Conversation is importing instructions; wait for its Pi task to settle");
        const binding = await tx.doc(ChatDoc, chat.id);
        if (!existing && agent.cwd !== binding.cwd) throw new DeckError("invalid", "Agent cwd differs from its saved tool binding");
        // An admission observation, not a per-input override of Pi's later request resolution.
        const mcpGrants=await tx.doc(McpGrantsDoc,chat.id);
        const observations = {
          ...(mcpGrants.profiles.length ? {mcp:{revision:mcpGrants.revision,profiles:mcpGrants.profiles}} : {}),
          semantics: "observed-at-reservation", pi: "1.4.0", nativeTools: this.localFiles,
          model: agent.model ? { provider: agent.model.provider, modelId: agent.model.modelId } : null,
          thinkingLevel: agent.thinkingLevel, cwd: agent.cwd,
          binding: { machineId: binding.machineId, cwd: binding.cwd },
          extensions: agent.extensions.map((extension) => extension.name),
          tools: agent.tools.map((tool) => tool.name), callable: agent.callable.map((tool) => tool.name),
          deferred: agent.deferred.map((tool) => tool.name),
          ...(binding.userAgentsMdHash ? { userAgentsMdHash: binding.userAgentsMdHash } : {}),
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
        type: "input", content: origin ? `[Message from agent chat ${origin.chatId}, tool task ${origin.taskId}; not a direct human message${origin.chain ? `; provenance ${JSON.stringify({ requestId: input.requestId, ...origin.chain })}` : ""}]\n${input.text}` : input.text, requestId: input.requestId, whenBusy: input.mode,
        entry: { kind: "deck.input", data: { text: input.text, requestId: input.requestId, mode: input.mode, capture, ...(origin ? { origin } : {}) } },
      }, context);
    });
  }

  // Internal operator API only. Returns durable admission to a Pi task, not application
  // success. Callers keep requestId across lost replies and inspect/wait on that task.
  importInstructions(id: string, requestId: string, signal?: AbortSignal, expectedBinding?: Binding, source?: "user"): Promise<TaskId<InstructionImportResult>> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new DeckError("invalid", "Invalid instruction import request ID");
      const chat = await this.mutableChat(id);
      return chat.commit(async (tx) => {
        const receipt = await tx.doc(InstructionRequest, chat.id, requestId, null);
        if (receipt.taskId) {
          const original = (await tx.task(receipt.taskId as TaskId))?.input as { binding?: Binding; source?: "user" } | undefined;
          if (source !== original?.source) throw new DeckError("conflict", "Instruction request ID already used for another source");
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
        const taskId = await tx.createTask(this.extensions.importInstructions, { ...(source ? { source } : {}), binding: { machineId: binding.machineId, cwd: binding.cwd }, previousHash: instructionHash(agent.instructions) }, { ownership: { kind: "conversation" } });
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
      const chat = await this.mutableChat(id);
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
        signal?.throwIfAborted();
        const taskId = await this.createTerminalAllocation(tx, chat.id, current, saved, replacement?.sessionId);
        receipt.taskId = taskId;
        return taskId;
      }, context);
    });
  }

  // Shared admission path: always a new Pi task/allocation for this conversation.
  // Supplying a session is an exact Rex run intent, never a new-session fallback.
  private async createTerminalAllocation(tx: Tx, id: ConversationId, binding: Binding, target: RexTarget, sessionId?: string): Promise<TaskId<RexResult>> {
    const doc = await tx.doc(RexDoc, id);
    const plan = { ...target, chatId: String(id), hubId: this.hubId, label: `deck-${this.hubId.slice(0, 8)}-chat-${id}`, allocationId: randomUUID(), ...(sessionId ? { sessionId } : {}) };
    if (Buffer.byteLength(JSON.stringify(plan)) > 16 * 1024) throw new DeckError("invalid", "Rex launch intent is too large");
    const taskId = await tx.createTask(this.extensions.allocate, { binding: { machineId: binding.machineId, cwd: binding.cwd }, plan }, { ownership: { kind: "conversation" } });
    if (doc.binding) doc.previousBinding = doc.binding;
    delete doc.binding; delete doc.startup; delete doc.reconciliationTaskId;
    doc.taskId = taskId; doc.allocationId = plan.allocationId;
    return taskId;
  }

  // First claim of an already-running, native-provenanced wizard block. The
  // native worker checks its private record, exact process and saved task host.
  // Exact retries retrieve the same Pi allocation task; they do not re-adopt.
  async adoptTerminal(args: RexAdoptArgs): Promise<RexAdoptAck> {
    if (!validAdoptArgs(args) || !this.rexClient || !this.localFiles) throw new DeckError("invalid", "Invalid bootstrap adoption");
    const chat = await this.chat(args.chatId);
    const binding = await this.harness.snapshot(ChatDoc, chat.id, context);
    if (!binding || binding.kind !== "task") throw new DeckError("invalid", "Bootstrap adoption requires a saved task");
    const remote = binding.machineId === this.localMachineId ? undefined : this.config.host?.rexClientFor?.(binding.machineId);
    if (binding.machineId !== this.localMachineId && !remote) throw new DeckError("offline", "Assigned worker lacks a registered client; no fallback");
    const target = rexTarget({ ...args.target, client: remote?.executable ?? this.rexClient, port: args.port, bootstrap: args.bootstrap, clientState: args.bootstrap.root, ...(remote ? { workerSocket: remote.socket } : {}) });
    const taskId = await this.allocateTerminal(args.chatId, args.requestId, target, undefined, { machineId: binding.machineId, cwd: binding.cwd });
    const task = await this.harness.getTask(taskId, context);
    const input = task?.input as RexInput | undefined;
    if (!input?.plan.allocationId || input.plan.bootstrap?.id !== args.bootstrap.id || input.plan.bootstrap.blockId !== args.bootstrap.blockId) throw new DeckError("conflict", "Bootstrap admission unconfirmed");
    return { version: 1, hubId: this.hubId, chatId: args.chatId, requestId: args.requestId, taskId: String(taskId), allocationId: input.plan.allocationId };
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
    const machine = (await this.harness.snapshot(ChatDoc, chat.id, context))?.machineId;
    if (!machine) throw new DeckError("invalid", "Task has no saved execution binding");
    const remote = machine === this.localMachineId ? undefined : this.config.host?.rexClientFor?.(machine);
    if (machine !== this.localMachineId && !remote) throw new DeckError("offline", "Assigned worker lacks a registered task client; no local fallback");
    const saved = rexTarget({ ...target, client: remote?.executable ?? this.rexClient, port: args.port, ...(remote ? { workerSocket: remote.socket } : {}) });
    // An ordinary explicit reopen creates a new terminal, never another claim
    // on the original creation wizard (which may have exited long ago).
    delete saved.bootstrap;
    const ack = (taskId: number, status: RexOpenAck["status"]): RexOpenAck => ({ version: 1, chatId: args.chatId, requestId: args.requestId, taskId: String(taskId), status, completion: "not_waited", bestEffort: true });
    // Retrieving an admitted request does not inspect/create or rewrite its plan.
    const receipt = await this.harness.snapshot(RexRequest, chat.id, args.requestId, context);
    if (receipt?.taskId) return ack(await this.allocateTerminal(args.chatId, args.requestId, saved), "admitted");
    if (prior && prior.state.status !== "terminal") throw new DeckError("busy", "Rex creation is still pending; inspect status before another attempt");
    if (args.confirmedOnly && prior && !doc?.binding && (prior.state.status !== "terminal" || prior.state.outcome.status !== "completed" || (prior.state.outcome.result as RexResult)?.status !== "not_allocated")) throw new DeckError("conflict", "Previous Rex allocation is unconfirmed; inspect/reconcile it before an explicit new attempt. Resume did not create a terminal");
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

  // Parent-scoped opening is not rex_open on a foreign chat. It derives the
  // entire destination from confirmed parent provenance and never adopts context.
  openManagedChild(args: OpenManagedChildArgs): Promise<OpenManagedChildAck> {
    const guard = this.commandGuard.getStore();
    return this.serial(async () => {
      if (!validOpenManagedChildArgs(args)) throw new DeckError("invalid", "Invalid managed child open arguments");
      const parent = await this.chat(args.chatId), child = await this.chat(args.childId);
      if (parent.id === child.id) throw new DeckError("invalid", "Managed child open requires a direct child");
      if (!this.rexClient || !this.localFiles) throw new DeckError("offline", "Same-session child opening requires a verified parent Rex binding and native launcher; no fallback");
      const capture = async () => {
        const records = await this.harness.commit(async tx => [await tx.conversation(parent.id), await tx.conversation(child.id)], context);
        const parentBinding = await this.harness.snapshot(ChatDoc, parent.id, context);
        const childBinding = await this.harness.snapshot(ChatDoc, child.id, context);
        const parentAgent = await this.harness.snapshot(AgentDoc, parent.id, context);
        const childAgent = await this.harness.snapshot(AgentDoc, child.id, context);
        const parentRex = await this.harness.snapshot(RexDoc, parent.id, context);
        const childRex = await this.harness.snapshot(RexDoc, child.id, context);
        if (!independentDeckChat(records[0], parentBinding, this.main.id) || !independentDeckChat(records[1], childBinding, this.main.id)
          || !parentBinding || !childBinding || childBinding.kind !== "task" || childBinding.managedParentChatId !== args.chatId
          || childBinding.machineId !== parentBinding.machineId || childBinding.cwd !== parentBinding.cwd
          || parentAgent?.cwd !== parentBinding.cwd || childAgent?.cwd !== childBinding.cwd) throw new DeckError("invalid", "Same-session open requires an independent parent and direct managed child with matching saved host/cwd");
        const parentTask = parentRex?.taskId ? await this.harness.getTask(parentRex.taskId as TaskId, context) : undefined;
        const original = parentTask?.input as RexInput | undefined, binding = parentRex?.binding;
        if (!binding || !parentTask || parentTask.kind !== REX_KIND || parentTask.conversationId !== parent.id || !original || !validRexAllocationPlan(original.plan)
          || original.plan.chatId !== args.chatId || original.plan.hubId !== this.hubId || original.plan.allocationId !== parentRex?.allocationId
          || original.binding.machineId !== parentBinding.machineId || original.binding.cwd !== parentBinding.cwd
          || binding.chatId !== args.chatId || binding.hubId !== this.hubId || binding.taskId !== String(parentTask.id)
          || binding.machineId !== parentBinding.machineId || binding.cwd !== parentBinding.cwd
          || binding.server !== original.plan.server || binding.hostId !== original.plan.hostId || binding.instanceId !== original.plan.instanceId) throw new DeckError("conflict", "Parent has no verified saved Rex binding; same-session child open refused (including --here without Rex); no new-session fallback");
        this.requireWorkerAdmission(parentBinding.machineId);
        return { parentBinding, childBinding, parentCwd: parentAgent.cwd, childCwd: childAgent.cwd, parentRex, childRex, original, binding };
      };
      const before = await capture(), { parentBinding, original, binding } = before;
      const destination = { executable: original.plan.executable, server: binding.server, hostId: binding.hostId, instanceId: binding.instanceId, sessionId: binding.sessionId };
      // Client executable/socket changes do not change an already admitted intent.
      // Parent, child, saved host/cwd, target, session and caller port DO.
      const hash = createHash("sha256").update(JSON.stringify(["deck.managed-child-open.v1", this.hubId, args.chatId, args.childId, args.port, parentBinding.machineId, parentBinding.cwd, destination])).digest("hex");
      const ack = (taskId: number, status: RexOpenAck["status"]): OpenManagedChildAck => ({ parentChatId: args.chatId, childId: args.childId, ack: { version: 1, chatId: args.childId, requestId: args.requestId, taskId: String(taskId), status, completion: "not_waited", bestEffort: true } });
      const receipt = await this.harness.snapshot(ManagedChildOpenRequest, args.requestId, context);
      if (receipt) {
        if (receipt.hash !== hash) throw new DeckError("conflict", "Managed child open ID already names another parent, child or Rex session");
        if (receipt.taskId) return ack(receipt.taskId, receipt.status);
      }
      const sample = await this.inspectTerminal(args.chatId);
      if (sample.status !== "sampled" || sample.taskId !== String(before.parentRex.taskId) || !sample.observation
        || !["running", "exited", "missing_terminal"].includes(sample.observation.state)
        || sample.observation.scope.sessionId !== binding.sessionId) throw new DeckError("conflict", "Parent Rex session is unavailable or unconfirmed; no child terminal requested");
      let reuse = false;
      if (before.childRex?.taskId) {
        const task = await this.harness.getTask(before.childRex.taskId as TaskId, context), input = task?.input as RexInput | undefined;
        if (!task || task.state.status !== "terminal") throw new DeckError("busy", "Child Rex creation is still pending; no new attempt requested");
        // Never migrate a child's existing attempt from a different session,
        // including an unconfirmed allocation which may already have run.
        if (task.kind !== REX_KIND || task.conversationId !== child.id || !input || !validRexAllocationPlan(input.plan)
          || input.plan.chatId !== args.childId || input.plan.hubId !== this.hubId || input.plan.allocationId !== before.childRex.allocationId || input.plan.sessionId !== binding.sessionId
          || input.binding.machineId !== parentBinding.machineId || input.binding.cwd !== parentBinding.cwd
          || (["executable", "server", "hostId", "instanceId"] as const).some(key => input.plan[key] !== destination[key])) throw new DeckError("conflict", "Child Rex attempt does not belong to the parent's saved session");
        if (before.childRex.binding) {
          const childSample = await this.inspectTerminal(args.childId);
          if (childSample.status !== "sampled" || !childSample.observation || childSample.observation.scope.sessionId !== binding.sessionId
            || !["running", "exited", "missing_terminal"].includes(childSample.observation.state)) throw new DeckError("conflict", "Child Rex state is unconfirmed; no new terminal requested");
          reuse = childSample.observation.state === "running";
        } else if (task.state.outcome.status !== "completed" || (task.state.outcome.result as RexResult)?.status !== "not_allocated") throw new DeckError("conflict", "Previous child Rex allocation is unconfirmed; inspect/reconcile before an explicit new attempt");
      }
      const remote = parentBinding.machineId === this.localMachineId ? undefined : this.config.host?.rexClientFor?.(parentBinding.machineId);
      if (parentBinding.machineId !== this.localMachineId && !remote) throw new DeckError("offline", "Assigned worker lacks a current registered client; no local fallback");
      const target = rexTarget({ ...destination, client: remote?.executable ?? this.rexClient, port: args.port,
        ...(remote ? { workerSocket: remote.socket } : {}), ...(original.plan.clientState ? { clientState: original.plan.clientState } : {}) });
      // Inspection is a sample, not an admission lease. Preserve the outer scope
      // across serial's context exit and recheck it after all awaited native reads.
      if (JSON.stringify(await capture()) !== JSON.stringify(before)) throw new DeckError("conflict", "Parent/child Rex binding changed before admission; no terminal requested");
      await guard?.();
      return child.commit(async tx => {
        const parentRecord = await tx.conversation(parent.id), childRecord = await tx.conversation(child.id);
        const currentParent = await tx.doc(ChatDoc, parent.id), currentChild = await tx.doc(ChatDoc, child.id);
        const parentAgent = await tx.doc(AgentDoc, parent.id), childAgent = await tx.doc(AgentDoc, child.id);
        const parentRex = await tx.doc(RexDoc, parent.id), childRex = await tx.doc(RexDoc, child.id);
        if (!independentDeckChat(parentRecord, currentParent, this.main.id) || !independentDeckChat(childRecord, currentChild, this.main.id)
          || JSON.stringify(currentParent) !== JSON.stringify(before.parentBinding) || JSON.stringify(currentChild) !== JSON.stringify(before.childBinding)
          || parentAgent.cwd !== before.parentCwd || childAgent.cwd !== before.childCwd
          || JSON.stringify(parentRex) !== JSON.stringify(before.parentRex) || JSON.stringify(childRex) !== JSON.stringify(before.childRex ?? { taskId: 0 })) throw new DeckError("conflict", "Parent/child relation or Rex target changed before allocation");
        this.requireWorkerAdmission(parentBinding.machineId);
        const receipt = await tx.doc(ManagedChildOpenRequest, args.requestId, hash);
        if (receipt.hash !== hash) throw new DeckError("conflict", "Managed child open request identity changed");
        if (receipt.taskId) return ack(receipt.taskId, receipt.status);
        const taskId = reuse ? childRex.taskId : await this.createTerminalAllocation(tx, child.id, currentChild, target, binding.sessionId);
        receipt.taskId = taskId; receipt.status = reuse ? "reused" : "admitted";
        return ack(taskId, receipt.status);
      }, context);
    });
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
      const chat = await this.mutableChat(id);
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
        const taskId = await tx.createTask(this.extensions.reconcile, { allocationTaskId: doc.taskId, binding: { machineId: current.machineId, cwd: current.cwd }, request }, { ownership: { kind: "conversation" } });
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
    const models = this.config.models.getModels().flatMap((model) => {
      const thinkingLevels = getSupportedThinkingLevels(model);
      return thinkingLevels.length ? [{ provider: model.provider, modelId: model.id, name: prefixUnits(model.name, 160), thinkingLevels, defaultThinkingLevel: clampThinkingLevel(model, "medium") }] : [];
    }).sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
    if (models.length > 256) throw new DeckError("too_large", "Model catalog exceeds client limit");
    const selection = this.selection(await this.harness.snapshot(AgentDoc, chat.id, context) ?? {});
    return { hubId: this.hubId, chatId: id, selection, defaultModel: { ...this.config.defaultModel }, models };
  }

  setModelSettings(args: SetModelSettingsArgs): Promise<ModelSettingsAck> {
    return this.serial(async () => {
      if (!validSetModelSettingsArgs(args)) throw new DeckError("invalid", "Invalid model settings");
      const chat = await this.mutableChat(args.chatId);
      const saved = await this.harness.snapshot(ChatDoc, chat.id, context);
      if (!saved || !["main", "task"].includes(saved.kind)) throw new DeckError("invalid", "Only ownerless Deck chats can change model settings");
      return chat.commit(async (tx) => {
        const binding = await tx.doc(ChatDoc, chat.id);
        const record = await tx.conversation(chat.id);
        if (!record || record.owner || binding.kind === "subagent") throw new DeckError("invalid", "Owned subagents inherit their owner's settings");
        if (!await configurationIdle(tx, chat.id)) throw new DeckError("busy", "Conversation has unfinished work; wait for it to settle before changing model/thinking");
        const agent = await tx.doc(AgentDoc, chat.id);
        if (!sameSelection(this.selection(agent), args.expected)) throw new DeckError("conflict", "Model settings changed; refresh before choosing again");
        const model = this.config.models.getModel(args.selection.provider, args.selection.modelId);
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
      const chat = await this.mutableChat(id);
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
  private async subagents(parentId: ConversationId): Promise<SubagentSnapshot> {
    // Ownership, not Deck's display hints, defines the scope. Scan once; never
    // refill a sparse page with a global scan or walk an unbounded child tree.
    const page = await this.harness.commit(async (tx) => {
      const scanned = await tx.scanConversations({ ownerConversationId: parentId, order: "descending" }, 16);
      const items = []; let hasMore = !!scanned.next;
      for (const record of scanned.items) {
        const owner = record.owner;
        if (!owner || owner.conversationId !== parentId || (await tx.task(owner.taskId))?.conversationId !== parentId) { hasMore = true; continue; }
        items.push(record);
      }
      return { items, hasMore };
    }, context);
    const result: SubagentSnapshot = { chatId: String(parentId), items: [], hasMore: page.hasMore };
    for (const record of page.items) {
      // snapshot is deliberately outside commit: tx.doc would create metadata
      // on unmanaged Pi children, and snapshot itself must not nest a commit.
      const metadata = await this.harness.snapshot(ChatDoc, record.id, context);
      if (!metadata || metadata.kind !== "subagent" || metadata.parentChatId !== String(parentId) || metadata.ownerTaskId !== String(record.owner!.taskId) || typeof metadata.title !== "string" || !metadata.title.isWellFormed()) {
        result.hasMore = true; continue;
      }
      const item: SubagentSnapshot["items"][number] = {
        chatId: String(record.id), title: prefixUnits(metadata.title, 160),
        ...(validAgentName(metadata.agentName) ? { agentName: metadata.agentName } : {}),
        ...(validAgentRune(metadata.agentRune) && metadata.agentRune !== "Δ" ? { agentRune: metadata.agentRune } : {}),
      };
      try {
        const inbox = await this.harness.snapshot(InboxDoc, record.id, context);
        item.status = await this.harness.commit(tx => agentStatus(tx, record.id, (inbox?.items.length ?? 0) > 0), context);
      } catch { /* An unavailable status is unknown (absent), never invented idle. */ }
      result.items.push(item);
    }
    // Immutable ownership makes separate document/status samples safe to scope;
    // their observations can still be superseded by concurrent child work.
    return result;
  }

  async activity(id: string, includeAgentStatus = false, includeSubagents = false): Promise<ActivitySnapshot> {
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
      ...(includeSubagents ? { subagents: await this.subagents(chat.id) } : {}),
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
