import { validMessageContentPage } from "./message-content-contracts.js";
import { validSubagentViewReply } from "./subagent-view-contracts.js";
import { validAgentNameQuery } from "./generated/contracts.js";
// Client-only adapter: shared HTTP validation and existing local drafts, no Pi
// session, store, execution or replay loop. The renderer owns presentation.
import { displayText, projectEntry, flattenParts, entryBytes } from "./tui-content.js";
export { displayText, thinkingUsage } from "./tui-content.js";
import { validInventoryFields } from "./tool-inventory-contracts.js";
import { localGitBranch } from "./tui-workspace.js";
import { canParticipate, requireParticipation, requireNavigation, requireCreation, inspectOnly } from "./client-access.js";
import type { HistoryPage, TuiClientMode } from "./generated/contracts.js";
import { validAgentStatus, validSubagents } from "./view-contracts.js";
import { validRexReply } from "./rex-open-contracts.js";
import { sameSelection, validModelSettingsSnapshot } from "./model-settings-contracts.js";
import { randomUUID } from "node:crypto";
import { DraftStore, type Draft } from "./drafts.js";
import { hubCommand } from "./hub-client.js";
import { HubError } from "./responses.js";
import { validInventoryToolName, validMachineIdentity, validRexUuid, validTuiRequest, validTuiResponse, type TuiRequest, type TuiSnapshot, type TuiEntry, type TuiResponse } from "./generated/contracts.js";
import { validManagedChildProblem, validManagedParent, validSafePiId, validMutationArgs } from "./mutation-contracts.js";

import { validTaskTarget } from "./task-target.js";
import { validForm, validBrief, taskCreationCommand, taskCreationArgs } from "./task-brief.js";
import { validHosts } from "./host-inventory.js";

// Client-local proof: no mutation draft was reserved or command submitted.
// Never use a remote error code or missing receipt to infer this outcome.
export class TuiRequestNotSent extends Error {}

export function validRequest(value: unknown): value is TuiRequest {
  if (!validTuiRequest(value)) return false;
  if (["select", "childOpen"].includes(value.action) ? !validSafePiId(value.chatId) : value.chatId !== undefined) return false;
  if (value.action === "messageContent" ? !validSafePiId(value.entryId) || value.offset === undefined : value.entryId !== undefined || value.offset !== undefined) return false;
  if (value.after !== undefined && (!["tasks", "newer"].includes(value.action) || !validSafePiId(value.after))) return false;
  if (value.action === "newer" && value.after === undefined) return false;
  if (value.before !== undefined && (value.action !== "older" || !validSafePiId(value.before))) return false;
  if (value.hold !== undefined && value.action !== "poll") return false;
  if (value.action === "configure" ? value.configuration === undefined : value.configuration !== undefined) return false;
  if (value.taskForm !== undefined) return value.action === "create" && value.text === undefined && value.taskTarget === undefined && validForm(value.taskForm);
  if (value.taskTarget !== undefined) return value.action === "create" && value.text === undefined && validTaskTarget(value.taskTarget);
  if (value.action === "newChild") return validManagedChildProblem({ problem: value.text, description: "" });
  if (value.action === "subagent") return validAgentNameQuery(value.text);
  if (value.action === "send" || value.action === "create") return typeof value.text === "string" && value.text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").length > 0 && Buffer.byteLength(value.text) <= (value.action === "send" ? 16384 : 200);
  return value.text === undefined;
}
export function validReply(value: unknown, id: string, hubId?: string, chatId?: string, action?: TuiRequest["action"], target?: string, after?: string, mode?: TuiClientMode, hubChatId?: string, inspectParentChatId?: string, entryId?: string, offset?: number): value is TuiResponse {
  if (!validTuiResponse(value) || value.id !== id || Buffer.byteLength(JSON.stringify(value)) >= 1024 * 1024) return false;
  if (!value.ok) return true;
  const s = value.snapshot;
  if (action === "newer") {
    if (!validSafePiId(after) || s.newerAfter !== after || typeof s.newerFound !== "boolean") return false;
    if (s.newerNext !== undefined && (!validSafePiId(s.newerNext) || Number(s.newerNext) <= Number(after))) return false;
    if (s.newerFound && (!s.entries.some(isMessage) || s.entries.some(e => e.id <= Number(after)) ||
      (s.newerNext !== undefined && Number(s.newerNext) < s.entries.at(-1)!.id))) return false;
  } else if (s.newerAfter !== undefined || s.newerFound !== undefined || s.newerNext !== undefined) return false;
  if (!validManagedParent(s.chatId, s)) return false;
  if (action === "messageContent" ? !validMessageContentPage(s.messageContent, { chatId: s.chatId, entryId, offset }) : s.messageContent !== undefined) return false;
  if ((action === "models" || action === "configure") && !s.modelSettings) return false;
  const expectedChat = action === "select" ? target : action === "parent" ? inspectParentChatId : action === "subagent" ? undefined : chatId;
  if (action === "parent" && (!inspectParentChatId || s.inspectParentChatId !== undefined)) return false;
  if (action === "subagent" && s.inspectParentChatId !== (inspectParentChatId ?? chatId)) return false;
  if (action !== undefined && !["subagent", "parent", "select"].includes(action) && s.inspectParentChatId !== inspectParentChatId) return false;
  if (s.inspectParentChatId !== undefined && (!validSafePiId(s.inspectParentChatId) || Number(s.inspectParentChatId) >= Number(s.chatId) || s.kind !== "subagent" || s.draft !== null || s.tasks !== undefined || s.hosts !== undefined || s.rex !== undefined || (s.clientMode === "task" && s.inspectParentChatId === s.hubChatId))) return false;
  if (action === "childOpen" && (!validSafePiId(target) || Number(target) <= Number(s.chatId) || s.inspectParentChatId !== undefined || s.kind === "subagent" || !canParticipate(s.clientMode, s.chatId, s.hubChatId))) return false;
  if (action === "select" && (!validSafePiId(target) || s.inspectParentChatId !== undefined)) return false;
  if (!validSafePiId(s.chatId) || (hubId !== undefined && hubId !== s.hubId) || (expectedChat !== undefined && expectedChat !== s.chatId)) return false;
  if (!validSafePiId(s.hubChatId) || (mode !== undefined && s.clientMode !== mode) || (hubChatId !== undefined && s.hubChatId !== hubChatId)) return false;
  if (s.clientMode === "task" && (s.chatId === s.hubChatId || s.tasks !== undefined || s.hosts !== undefined || action === "hosts" || action === "select" || action === "tasks")) return false;
  if (!canParticipate(s.clientMode, s.chatId, s.hubChatId) && s.draft !== null) return false;
  if (s.hosts !== undefined && !validHosts(s.hosts) || action === "hosts" && !s.hosts) return false;
  if (s.brief !== undefined && !validBrief(s.brief)) return false;
  if (action === "tasks" && (!s.tasks || s.tasks.after !== after)) return false;
  if (s.tasks) {
    let previous = Number(s.tasks.after ?? 0);
    if (s.tasks.after !== undefined && !validSafePiId(s.tasks.after)) return false;
    for (const row of s.tasks.items) { if (!validManagedParent(row.chatId, row) || !validSafePiId(row.chatId) || Number(row.chatId) <= previous || (row.parentChatId !== undefined && (!validSafePiId(row.parentChatId) || row.kind !== "subagent" || Number(row.parentChatId) >= Number(row.chatId)))) return false; previous = Number(row.chatId); }
    if (s.tasks.next !== undefined && (!validSafePiId(s.tasks.next) || Number(s.tasks.next) <= Number(s.tasks.after ?? 0) || Number(s.tasks.next) < previous)) return false;
  }
  if ((action === "rexStatus" || action === "rexInspect") && !s.rex) return false;
  if (action === "rexInspect" && !s.rex?.inspection) return false;
  if (s.rex && (!validRexReply({ command: "rex_status", args: { chatId: s.chatId }, hubId: s.hubId }, s.rex.status) || (s.rex.inspection && !validRexReply({ command: "rex_inspect", args: { chatId: s.chatId }, hubId: s.hubId }, s.rex.inspection)))) return false;
  if (!validInventoryFields(s)) return false;
  if (s.agentStatus && !validAgentStatus(s.agentStatus)) return false;
  if (s.subagents !== undefined && !validSubagents(s.subagents, s.chatId)) return false;
  if (s.modelSettings && (!validModelSettingsSnapshot(s.modelSettings) || s.modelSettings.hubId !== s.hubId || s.modelSettings.chatId !== s.chatId)) return false;
  if (s.admittedInputs !== undefined && (s.kind === "subagent" || s.inspectParentChatId !== undefined || !canParticipate(s.clientMode, s.chatId, s.hubChatId) ||
    s.admittedInputs.some(input => Buffer.byteLength(input.text) > entryBytes) || new Set(s.admittedInputs.map(input => input.requestId)).size !== s.admittedInputs.length)) return false;
  if (s.entries.reduce((bytes, item) => bytes + Buffer.byteLength(item.text), 0) > 128 * 1024) return false;
  return s.entries.every((item, i) => Buffer.byteLength(item.text) <= entryBytes &&
    (item.parts === undefined || flattenParts(item.parts) === item.text) &&
    (i === 0 || item.id > s.entries[i - 1]!.id));
}
type Command = (name: string, args: Record<string, unknown>, hubId?: string) => Promise<any>;
const inputAdmittedNotice = "Input admitted; completion not yet confirmed";
const isMessage = (entry: TuiEntry) => entry.role !== "tool" && (entry.parts ? entry.parts.some(part => part.kind === "text" && part.text.length > 0) : entry.role !== "note" && entry.text.length > 0);
export class TuiSession {
  private hubId?: string;
  private chatId?: string;
  private store?: DraftStore;
  private active: Draft | undefined;
  private activeSaved = false;
  private state?: TuiSnapshot;
  private before: string | undefined;
  // Bounded session presentation only, scoped across navigation. Never persisted,
  // replayed, assigned history IDs, or retired by an idle/completion sample.
  private admittedInputs: { chatId: string, requestId: string, text: string }[] = [];
  private observedInput: { chatId: string, requestId: string } | undefined; // A saved input may appear before explicit ACK recovery.
  private liveHead: number | undefined; // Anchor from a live read, never a historical page.
  private pageLimits = { latest: 80, older: 80, newer: 80 };
  private supportsSettings = false;
  private supportsRex = false;
  private supportsStartup = false;
  private supportsBrief = false;
  private supportsManaged = false;
  private supportsManagedOpen = false;
  private supportsManagedProblem = false;
  private supportsHosts = false;
  private startupBlocked = false;
  private attachmentMachine?: string;
  private mode: TuiClientMode = "hub";
  private hubChatId?: string;
  private inspectParentChatId: string | undefined;
  private participates() { return !this.inspectParentChatId && canParticipate(this.mode, this.chatId, this.hubChatId); }
  private binding?: { machineId: string; cwd: string };
  private settingsUncertain = false;
  private localWorkspace = false;
  private gitSampleAt = 0;
  private inventorySampleAt = 0;
  private userImport: string | undefined;
  constructor(private readonly command: Command, private readonly selected?: string, private readonly expectedHub?: string, private readonly draftRoot?: string, private readonly port = 52800) {}
  async registerStartup(allocationId: string, blockId: string | undefined) {
    if (this.state || this.startupBlocked) throw new Error("Rex startup cannot be replayed in this client");
    this.startupBlocked = true;
    const args = { chatId: this.selected, allocationId, blockId };
    if (!this.expectedHub || !validMutationArgs("rex_startup", args)) throw new Error("Rex startup requires a pinned hub/task and native full REX_BLOCK");
    this.mode = "task";
    await this.initialize();
    if (this.chatId === this.hubChatId) throw new Error("Rex task startup cannot target the hub chat");
    if (!this.supportsStartup) throw new Error("Hub lacks Rex startup capability; no input enabled");
    const page = this.renderHistory(await this.history());
    this.state!.entries = page.entries; this.before = page.next; this.state!.hasOlder = !!page.next;
    await this.command("rex_startup", args, this.hubId);
    this.state!.notice = "Rex startup registered (historical observation, not current health).";
    this.startupBlocked = false;
  }
  async registerAttachment(machineId: string, cwd?: string) {
    if (this.state || this.startupBlocked || !validMachineIdentity(machineId) || !validRexUuid(this.expectedHub) || !validSafePiId(this.selected)) throw new Error("Task attachment requires a pinned hub/task/worker");
    this.startupBlocked = true; this.mode = "task"; this.attachmentMachine = machineId;
    await this.initialize();
    if (cwd !== undefined && this.binding?.cwd !== cwd) throw new Error("Created task workspace changed; no input enabled");
    const page = this.renderHistory(await this.history());
    this.state!.entries = page.entries; this.before = page.next; this.state!.hasOlder = !!page.next;
    this.state!.notice = "Attached in this terminal; no Rex allocation changed. Detach does not stop work.";
    this.startupBlocked = false;
  }
  private async initialize() { if (!this.state) await this.selectChat(this.selected); }
  private async selectChat(target?: string, inspectParent?: string, returning = false, resolvedStatus?: any) {
    if (returning && (target !== this.inspectParentChatId || (this.mode === "task" && target !== this.selected))) throw new Error("Invalid parent return scope");
    if (this.state && !inspectParent && !returning) requireNavigation(this.mode);
    if (this.active || this.userImport || (this.participates() && this.settingsUncertain)) throw new Error("Resolve saved requests/settings before switching tasks");
    const status = resolvedStatus ?? await this.command("status", target ? { chatId: target } : {}, this.hubId ?? this.expectedHub);
    if (status.hubGuard !== 1 || (target && status.chatId !== target) || ((this.hubId ?? this.expectedHub) && status.hubId !== (this.hubId ?? this.expectedHub))) throw new Error("Hub/chat identity guard required; selection unchanged");
    if (this.hubChatId !== undefined && status.mainChatId !== this.hubChatId) throw new Error("Hub chat identity changed; selection unchanged");
    if (!inspectParent && this.attachmentMachine && (status.chatId === status.mainChatId || status.binding?.kind !== "task" || status.binding.machineId !== this.attachmentMachine)) throw new Error("Attached task worker/binding changed; no input enabled");
    const store = this.store ?? new DraftStore(status.hubId, this.draftRoot);
    const saved = (inspectParent ? [] : await store.list()).filter((draft) => draft.chatId === status.chatId);
    const writable = !inspectParent && canParticipate(this.mode, status.chatId, status.mainChatId);
    const active = writable && saved[0] ? (await store.load(saved[0].requestId)).request : undefined;
    // Commit the selection only after all fallible reads. No old page, sample,
    // cursor, binding or request can leak into the new chat on a failed switch.
    this.inspectParentChatId = inspectParent;
    this.hubId = status.hubId; this.chatId = status.chatId; this.hubChatId = status.mainChatId; this.store = store;
    this.active = active; this.activeSaved = !!active; this.before = undefined; this.liveHead = undefined; this.userImport = undefined;
    this.pageLimits = { latest: 80, older: 80, newer: 80 };
    this.binding = status.binding && { machineId: status.binding.machineId, cwd: status.binding.cwd };
    this.localWorkspace = !inspectParent && status.binding?.cwd === process.cwd() && (this.mode === "task" || status.machineId === status.binding?.machineId);
    this.gitSampleAt = 0;
    this.supportsRex = !inspectParent && status.rexOpen === 1;
    this.observeManagedCapabilities(status);
    this.supportsBrief = status.taskBrief === 1; this.supportsHosts = status.hostInventory === 1;
    this.supportsStartup = status.rexStartup === 1;
    this.supportsSettings = status.modelSettings === 1; this.settingsUncertain = !inspectParent && this.supportsSettings;
    const notice = inspectParent ? "Read-only subagent inspection. :parent returns to the parent; :subagent NAME selects a sibling." : !writable ? `${inspectOnly}${saved.length ? " Saved requests remain untouched; review them in the Rex client." : ""}` : active ? `Saved ${active.kind} ${active.requestId}: ${active.kind === "instructions" && !active.source ? "use --no-tui to retry workspace instructions, or :discard" : ":retry or :discard"}.${saved.length > 1 ? " Other drafts: --no-tui /drafts." : ""}` : "";
    this.state = { ...(status.binding?.managedParentChatId === undefined ? {} : { managedParentChatId: status.binding.managedParentChatId }), ...(inspectParent ? { inspectParentChatId: inspectParent } : {}), ...(status.binding ? { cwd: displayText(status.binding.cwd, 4096), kind: status.binding.kind, ...(status.binding.agentRune === undefined ? {} : { agentRune: status.binding.agentRune }) } : {}), ...(status.binding?.agentName === undefined ? {} : { agentName: status.binding.agentName }), clientMode: this.mode, hubChatId: this.hubChatId!, hubId: this.hubId!, chatId: this.chatId!, title: this.chatId === this.hubChatId ? "Hub" : displayText(status.binding?.title || `Task ${this.chatId}`, 160), model: displayText(`${status.model?.provider ?? ""}/${status.model?.modelId ?? "unknown model"}`, 160), tools: status.tools, activityKnown: false, busy: false, queued: 0, entries: [], hasOlder: false, historical: false, preview: "", notice, draft: null, ...(status.binding?.brief ? { brief: { ...(status.binding.brief.problem === undefined ? {} : { problem: displayText(status.binding.brief.problem, 2048) }), ...(status.binding.brief.description === undefined ? {} : { description: displayText(status.binding.brief.description, 8192) }) } } : {}) };
    this.inventorySampleAt = Date.now();
    this.inventory(status);
  }
  private async selectSubagent(name: string) {
    if (this.active || this.userImport || (this.participates() && this.settingsUncertain)) throw new Error("Resolve saved requests/settings before inspecting subagents");
    const parent = this.inspectParentChatId ?? this.chatId!;
    const args = { chatId: parent, name, operation: "status" };
    const reply = await this.command("subagent_view", args, this.hubId);
    if (!validSubagentViewReply({ command: "subagent_view", args, hubId: this.hubId }, reply)) throw new Error("Invalid subagent scope; selection unchanged");
    await this.selectChat(reply.childId, parent, false, reply.result);
  }
  private async firstInspectionPage() {
    if (this.supportsSettings) await this.refreshSettings();
    const page = await this.history(), rendered = this.renderHistory(page);
    this.state!.entries = rendered.entries; this.before = rendered.next;
    this.state!.hasOlder = !!rendered.next;
    this.sample(page);
  }
  private async readView(operation: string, args: Record<string, unknown>): Promise<any> {
    if (!this.inspectParentChatId) return this.command(operation, args, this.hubId);
    const { chatId: _child, ...options } = args;
    const scoped = { chatId: this.inspectParentChatId, childId: this.chatId, operation, options };
    const reply = await this.command("subagent_view", scoped, this.hubId);
    if (!validSubagentViewReply({ command: "subagent_view", args: scoped, hubId: this.hubId }, reply)) throw new Error("Invalid subagent read; observation unchanged");
    return reply.result;
  }
  private inventory(status: any) {
    delete this.state!.toolInventory;
    this.state!.toolInventoryStatus = "unavailable";
    if (!validInventoryFields({ chatId: this.chatId!, ...(status.toolInventory === undefined ? {} : { toolInventory: status.toolInventory }), ...(status.toolInventoryStatus === undefined ? {} : { toolInventoryStatus: status.toolInventoryStatus }) })) return;
    if (status.toolInventory !== undefined) {
      this.state!.toolInventory = structuredClone(status.toolInventory);
      this.state!.toolInventoryStatus = "ready";
    } else this.state!.toolInventoryStatus = status.toolInventoryStatus ?? "unsupported";
  }
  private async refreshInventory() {
    if (Date.now() - this.inventorySampleAt < 2000) return;
    this.inventorySampleAt = Date.now();
    // Clear first: any failed/unsupported refresh means unknown, not a replay of
    // formerly available tools. This read never gates participation/settings.
    delete this.state!.toolInventory;
    this.state!.toolInventoryStatus = "unavailable";
    try {
      const status = await this.readView("status", { chatId: this.chatId });
      if (status.hubGuard !== 1 || status.hubId !== this.hubId || status.chatId !== this.chatId || status.mainChatId !== this.hubChatId) return;
      this.observeManagedCapabilities(status);
      this.inventory(status);
    } catch { /* Observation unavailable; no automatic effect or health probe. */ }
  }
  private async refreshSettings() {
    if (!this.supportsSettings) throw new Error("Hub does not advertise model settings; upgrade it only when idle");
    const settings = await this.readView("model_settings", { chatId: this.chatId });
    if (!validModelSettingsSnapshot(settings) || settings.hubId !== this.hubId || settings.chatId !== this.chatId) throw new Error("Invalid model settings; selection unconfirmed");
    this.state!.modelSettings = settings;
    this.state!.model = displayText(`${settings.selection.provider}/${settings.selection.modelId}`, 160);
    this.settingsUncertain = false;
  }
  private async history(before?: string, after?: string) {
    const direction = after !== undefined ? "newer" : before === undefined ? "latest" : "older";
    let limit = this.pageLimits[direction];
    for (;;) {
      try {
        const page = await this.readView("history", { chatId: this.chatId, limit, ...(before ? { before } : {}), ...(after ? { after } : {}), includeActivity: true, includeAgentStatus: true, includeSubagents: true, includeProgress: true });
        this.pageLimits[direction] = limit;
        return page;
      }
      catch (error) { if (!(error instanceof HubError) || error.policy.action !== "reduce_page" || limit === 1) throw error; limit = Math.max(1, Math.floor(limit / 2)); }
    }
  }
  private renderHistory(page: HistoryPage, mode: "poll" | "older" | "latest" = "latest"): { entries: TuiEntry[]; next: string | undefined } {
    const observed = new Set(page.items.flatMap(raw => {
      const data = raw.data as { requestId?: unknown, origin?: unknown } | undefined;
      return raw.kind === "deck.input" && !data?.origin && typeof data?.requestId === "string" ? [data.requestId] : [];
    }));
    if (this.active?.kind === "input" && observed.has(this.active.requestId)) this.observedInput = { chatId: this.chatId!, requestId: this.active.requestId };
    this.admittedInputs = this.admittedInputs.filter(input => input.chatId !== this.chatId || !observed.has(input.requestId));
    let budget = 128 * 1024, wireBudget = 512 * 1024, wantActivity = mode !== "older";
    const entries: TuiEntry[] = []; // newest first until the final reversal
    const append = (entry: TuiEntry) => {
      const bytes = Buffer.byteLength(entry.text), wireBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (entries.length === 80 || bytes > budget || wireBytes > wireBudget) return false;
      budget -= bytes; wireBudget -= wireBytes; entries.push(entry); return true;
    };
    // A long tool run should not push already visible messages out of the chat.
    // Reuse only messages in a *contiguous observed range* of this live chat;
    // never stitch across a gap, selection, historical page or explicit :latest.
    const oldest = page.items.at(-1)?.id, previous = this.liveHead;
    const overlaps = mode === "poll" && page.next && previous !== undefined && page.items.some(e => e.id === previous);
    const carry = overlaps && oldest !== undefined ? this.state!.entries.filter(e => e.id < oldest && isMessage(e)).reverse() : [];
    this.liveHead = mode === "older" ? undefined : page.items[0]?.id;
    const full = () => { entries.reverse(); return { entries, next: String(entries[0]!.id) }; };
    for (const raw of page.items) {
      // Preserve cursor positions but don't spend a second byte budget shipping
      // obsolete results/notices that can't be shown. A note can be an actual
      // agent-origin deck.input message; retain its text and attribution.
      const empty: TuiEntry = { id: raw.id, role: "note", parts: [], text: "" };
      let entry = !wantActivity && raw.kind !== "deck.input" && raw.kind !== "pi.assistant" ? empty : projectEntry(raw);
      if (!isMessage(entry) && !wantActivity) entry = empty;
      if (entry.thinkingTokens || entry.parts?.some(p => p.kind === "tool" || p.text.length > 0)) wantActivity = false;
      if (carry.length && entries.length && !entry.text && !entry.thinkingTokens) continue;
      if (!append(entry)) return full();
    }
    for (const entry of carry) if (!append(entry)) return full();
    return { entries: entries.reverse(), next: carry.length ? this.before : page.next };
  }
  // Forward history is ascending: consume its oldest prefix, never reverse or
  // keep a latest suffix. This read is intentionally nonmutating so a native
  // Esc/click/reversal during transport can discard it without moving the view.
  private async newer(after: string): Promise<TuiSnapshot> {
    const page: HistoryPage = await this.history(undefined, after);
    const entries: TuiEntry[] = [];
    let budget = 128 * 1024, wireBudget = 512 * 1024, next = page.next;
    for (const raw of page.items) {
      const projected = projectEntry(raw);
      const entry: TuiEntry = isMessage(projected) ? projected : { id: raw.id, role: "note", parts: [], text: "" };
      const bytes = Buffer.byteLength(entry.text), wireBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (entries.length === 80 || bytes > budget || wireBytes > wireBudget) {
        next = String(entries.at(-1)!.id); break;
      }
      entries.push(entry); budget -= bytes; wireBudget -= wireBytes;
    }
    const found = entries.some(isMessage);
    return { ...structuredClone(this.state!), ...(found ? { entries, hasOlder: true, historical: !!next } : {}),
      newerAfter: after, newerFound: found, ...(next ? { newerNext: next } : {}) };
  }
  private sample(page: Pick<HistoryPage, "activity" | "progress">) {
    // Absence is unknown, never a fresh replay of an old completion/idle sample.
    delete this.state!.agentStatus;
    delete this.state!.subagents;
    if (page.activity?.subagents) this.state!.subagents = { ...page.activity.subagents, items: page.activity.subagents.items.map((item: import("./generated/contracts.js").SubagentItem) => ({ ...item, title: displayText(item.title, 160).replace(/\n/g, " ") })) };
    if (page.activity?.agentStatus) this.state!.agentStatus = page.activity.agentStatus;
    this.state!.activityKnown = page.activity !== undefined;
    this.state!.busy = page.activity?.busy ?? false;
    this.state!.queued = page.activity?.queued ?? 0;
    const running = (page.activity?.tools ?? []).filter(tool => tool.status === "running").map(tool => tool.name);
    this.state!.activeTools = [...new Set(running.filter(validInventoryToolName))];
    const latest = page.progress?.tools?.at(-1);
    this.state!.preview = displayText(page.progress?.generation?.text || (latest ? `[${latest.name}] ${latest.text}` : running.length ? `[using ${running.at(-1)}]` : ""), 4096);
  }
  private async deliver() {
    requireParticipation(this.mode, this.chatId, this.hubChatId);
    if (!this.active) throw new Error("No pending draft to retry");
    if (this.active.kind === "instructions" && this.active.source !== "user") throw new Error("Use --no-tui to retry workspace instruction requests");
    if (this.active.kind === "task") {
      requireCreation(this.mode, this.chatId, this.hubChatId, this.active.managedParentChatId);
      if (this.active.managedParentChatId !== undefined) {
        if (this.active.title === undefined && !this.supportsManagedProblem) throw new Error("Hub lacks problem-only managed children; saved request unchanged");
        if (!this.supportsManaged || (this.mode === "task" && !this.supportsManagedOpen)) throw new Error("Hub lacks scoped managed children; no request sent");
      } else if (!this.supportsRex) throw new Error("Rex support is required to create a task; no request sent");
    }
    if (this.active.kind === "task" && !this.supportsBrief && (this.active.problem !== undefined || this.active.description !== undefined)) throw new Error("Hub lacks task briefs; no request sent");
    this.activeSaved = false;
    await this.store!.save(this.active); // Must succeed before network; exact original fields.
    this.activeSaved = true;
    const method = this.active.kind === "task" ? taskCreationCommand(this.active) : this.active.kind === "instructions" ? "import_instructions" : "admit";
    const inputText = this.active.kind === "input" ? this.active.text : undefined;
    const { kind, chatId, requestId, ...args } = this.active;
    const managed = this.active.kind === "task" && this.active.managedParentChatId !== undefined;
    const ack = await this.command(method, this.active.kind === "task" ? taskCreationArgs(this.active) : { requestId, ...args, chatId }, this.hubId);
    this.activeSaved = false;
    await this.store!.remove(requestId); this.active = undefined;
    if (kind === "instructions") {
      this.userImport = ack.taskId;
      this.state!.notice = "Loading ~/.codex/AGENTS.md from the assigned machine…";
      await this.observeUserImport();
    } else if (kind === "input") {
      if (this.observedInput?.chatId !== chatId || this.observedInput.requestId !== requestId) {
        this.admittedInputs = [...this.admittedInputs.filter(input => input.chatId !== chatId || input.requestId !== requestId),
          { chatId, requestId, text: displayText(inputText!, entryBytes) }].slice(-16);
      }
      this.state!.historical = false; // The next unheld poll follows the new conversation turn.
      this.state!.notice = inputAdmittedNotice;
    }
    else {
      if (managed && this.mode === "task") {
        try {
          const opened = await this.openChild(String(ack.chatId));
          this.state!.notice = `Child ${ack.chatId} created. ${opened.ack.status === "reused" ? "Child TUI reused" : "Child TUI opening"} in the parent's Rex session and saved directory. No model input submitted.`;
        } catch {
          this.state!.notice = `Child ${ack.chatId} created; same-session Rex open unconfirmed. Inspect Rex, then :child-open ${ack.chatId} for an explicit attempt. Creation will not replay.`;
        }
        return;
      }
      if (managed && !this.supportsRex) {
        this.state!.notice = `Managed child ${ack.chatId} created; no input submitted. :tasks shows its name; attach on its assigned host with deck agent --resume NAME --here.`;
        return;
      }
      // Creation is acknowledged and the exact draft is cleared before this
      // separate best-effort terminal attempt. Losing its reply must not turn
      // the acknowledged creation back into an input/task retry queue.
      try {
        const opened = await this.command("rex_open", { chatId: ack.chatId, requestId: randomUUID(), port: this.port }, this.hubId);
        this.state!.notice = `Task ${ack.chatId} created. ${opened.status === "reused" ? "Rex client reused" : "Rex attempt admitted, not yet ready"}. :select ${ack.chatId} inspects only; participate in Rex.`;
      } catch { this.state!.notice = `Task ${ack.chatId} created; Rex open unconfirmed. :select ${ack.chatId}, inspect Rex, then explicitly open/reopen if needed. No automatic retry.`; }
    }
  }
  private async openChild(childId: string) {
    requireParticipation(this.mode, this.chatId, this.hubChatId);
    if (!this.supportsManagedOpen || !validSafePiId(childId) || Number(childId) <= Number(this.chatId)) throw new Error("Same-session managed child opening unavailable; no request sent");
    return this.command("open_managed_child", { chatId: this.chatId, childId, requestId: randomUUID(), port: this.port }, this.hubId);
  }
  private observeManagedCapabilities(status: any) {
    this.supportsManaged = !this.inspectParentChatId && status.managedChildren === 1;
    this.supportsManagedOpen = !this.inspectParentChatId && status.managedChildOpen === 1;
    this.supportsManagedProblem = !this.inspectParentChatId && status.managedChildProblem === 1;
  }
  private async requireChildProblemCapability() {
    // New creation gets a fresh, pinned observation before reserving an ID.
    // This is not a permission lease and is never a replacement for saved retry.
    const status = await this.command("status", { chatId: this.chatId }, this.hubId);
    if (status.hubGuard !== 1 || status.hubId !== this.hubId || status.chatId !== this.chatId || status.mainChatId !== this.hubChatId ||
      !this.binding || status.binding?.machineId !== this.binding.machineId || status.binding?.cwd !== this.binding.cwd) throw new Error("Parent identity/workspace changed; no child requested");
    this.observeManagedCapabilities(status);
    this.supportsRex = status.rexOpen === 1;
    if (!this.supportsManaged || !this.supportsManagedProblem || status.taskBrief !== 1) throw new Error("Hub lacks problem-only managed children; update the hub before :new-child PROBLEM. No child requested.");
    this.supportsBrief = true;
  }
  private async requireParentTerminal() {
    // Read-only preflight for NEW forms, never a permission lease or a reason to
    // abandon an already saved creation identity. The runtime rechecks at open.
    if (!this.supportsManagedOpen) throw new Error("Hub lacks same-session child opening; no child requested");
    const status = await this.command("rex_status", { chatId: this.chatId }, this.hubId);
    if (status.status !== "allocated" || !status.binding || status.binding.chatId !== this.chatId || status.binding.machineId !== this.binding?.machineId || status.binding.cwd !== this.binding?.cwd) throw new Error("Parent has no confirmed Rex allocation; open the parent in Rex first. No child created and no new-session fallback.");
  }
  private async observeUserImport() {
    if (!this.userImport) return;
    let task: import("./generated/contracts.js").InstructionTaskView | null;
    try { task = (await this.command("instruction_status", { chatId: this.chatId, taskId: this.userImport }, this.hubId)).import; }
    catch {
      // Admission is confirmed. A failed observation must not recreate a draft,
      // reread the file, or prevent history and activity from being refreshed.
      this.state!.notice = `AGENTS.md import ${this.userImport} admitted; result unavailable. Checking status, not retrying the read.`;
      return;
    }
    if (task?.state !== "terminal") return;
    this.userImport = undefined;
    if (task.result?.status === "applied" && task.result.source.path === "~/.codex/AGENTS.md") {
      this.state!.notice = "Loaded ~/.codex/AGENTS.md into this chat.";
      this.inventorySampleAt = 0;
      await this.refreshInventory();
    } else {
      const reason = task.result?.status === "rejected" ? task.result.reason : task.result?.status === "aborted" ? "aborted" : undefined;
      this.state!.notice = reason === "not_found" ? "File not found: ~/.codex/AGENTS.md on the assigned machine." :
        reason ? `Could not load ~/.codex/AGENTS.md: ${reason}.` : `AGENTS.md import ${task.taskId} finished; application not confirmed.`;
    }
  }
  async handle(request: TuiRequest): Promise<TuiSnapshot> {
    if (!validRequest(request)) throw new Error("Invalid renderer request");
    if (request.action !== "subagent" && request.action !== "parent") return this.handleRequest(request);
    // These transitions perform reads only. Commit their local selection only
    // when the entire first view succeeds, not merely the status lookup. A lost
    // history/settings read must not make the next poll jump behind the renderer.
    const previous = { ...this, state: this.state ? structuredClone(this.state) : undefined };
    try { return await this.handleRequest(request); }
    catch (error) { Object.assign(this, previous); throw error; }
  }
  private async handleRequest(request: TuiRequest): Promise<TuiSnapshot> {
    if (!validRequest(request)) throw new Error("Invalid renderer request");
    if (this.startupBlocked) throw new Error("Rex startup unconfirmed; no input enabled");
    await this.initialize();
    let state = this.state!;
    if (this.inspectParentChatId && !["poll", "older", "newer", "latest", "models", "subagent", "parent", "messageContent", ...(this.mode === "hub" ? ["select"] : [])].includes(request.action)) throw new Error("Read-only subagent inspection; :parent to return");
    if (request.action === "select" || request.action === "tasks" || request.action === "hosts") requireNavigation(this.mode);
    if (request.action === "newChild") requireCreation(this.mode, this.chatId, this.hubChatId, this.chatId);
    if (request.action === "create") requireCreation(this.mode, this.chatId, this.hubChatId, request.taskForm?.managedParentChatId);
    if (["send", "retry", "discard", "stop", "configure", "agentsmd", "childOpen"].includes(request.action)) requireParticipation(this.mode, this.chatId, this.hubChatId);
    switch (request.action) {
      case "newer": return this.newer(request.after!);
      case "messageContent": {
        const args = { chatId: this.chatId!, entryId: request.entryId!, offset: request.offset! };
        const page = await this.readView("message_content", args);
        if (!validMessageContentPage(page, args)) throw new Error("Invalid full-message content; export refused");
        // A read of one immutable entry never replaces the viewport, cursor,
        // draft or live samples. Export data exists only in this correlated reply.
        return { ...structuredClone(state), messageContent: page };
      }
      case "subagent":
        await this.selectSubagent(request.text!); await this.firstInspectionPage(); state = this.state!; break;
      case "parent":
        if (!this.inspectParentChatId) throw new Error("Not inspecting a subagent");
        await this.selectChat(this.inspectParentChatId, undefined, true); await this.firstInspectionPage(); state = this.state!; break;
      case "select":
        await this.selectChat(request.chatId); state = this.state!; break;
      case "hosts":
        if (!this.supportsHosts) throw new Error("Hub lacks registered-host inventory");
        state.hosts = await this.command("list_hosts", {}, this.hubId); break;
      case "tasks": {
        const page = await this.command("list_chats", { limit: 25, ...(this.supportsHosts ? { includeObservations: true } : {}), ...(request.after ? { after: request.after } : {}) }, this.hubId);
        if (this.supportsHosts) state.hosts = await this.command("list_hosts", {}, this.hubId);
        state.tasks = { items: page.items.map((row: any) => ({ ...(row.agentRune === undefined ? {} : { agentRune: row.agentRune }), ...(row.agentName === undefined ? {} : { agentName: row.agentName }), chatId: row.chatId, kind: row.kind, title: row.chatId === this.hubChatId ? "Hub" : displayText(row.title, 160), machineId: displayText(row.machineId, 80), cwd: displayText(row.cwd, 256), ...(row.parentChatId ? { parentChatId: row.parentChatId } : {}), ...(row.managedParentChatId ? { managedParentChatId: row.managedParentChatId } : {}), activity: row.activity ?? "unknown", rexState: row.rexState ?? "unknown", connection: state.hosts ? state.hosts.items.find(h => h.machineId === row.machineId)?.connection ?? "unregistered" : "unknown" })), ...(request.after ? { after: request.after } : {}), ...(page.next ? { next: page.next } : {}) };
        break;
      }
      case "newChild": {
        try {
          if (this.active || this.userImport || this.settingsUncertain) throw new Error("Resolve saved requests/settings before creating a child");
          await this.requireChildProblemCapability();
          if (this.mode === "task") await this.requireParentTerminal();
        } catch (error) {
          if (this.active) throw error; // Never dismiss an older unresolved request.
          throw new TuiRequestNotSent(error instanceof Error ? error.message : "Child preflight failed; no request sent");
        }
        // Separate command-owned recovery intent: no prompt bytes or form. The
        // server assigns the permanent name/title atomically with the child.
        this.active = { kind: "task", chatId: this.chatId!, requestId: randomUUID(), managedParentChatId: this.chatId!, problem: request.text!, description: "" };
        this.activeSaved = false;
        await this.deliver(); break;
      }
      case "create": {
        const managed = request.taskForm?.managedParentChatId !== undefined;
        const form = request.taskForm ?? request.taskTarget;
        try {
          if (managed ? !this.supportsManaged : !this.supportsRex) throw new Error(managed ? "Hub lacks managed children; no request sent" : "Rex support is required to create a task; no request sent");
          if (this.active || this.settingsUncertain) throw new Error("Resolve saved requests/settings before creating a task");
          if (managed && this.mode === "task") await this.requireParentTerminal();
          if (!form?.machineId && !this.binding) throw new Error("Saved workspace binding unavailable; no task requested");
          // New form selection uses registered hosts. Legacy :task-at retains its
          // exact arbitrary/offline binding contract and drafts are never retargeted.
          if (request.taskForm?.machineId) {
            if (!this.supportsHosts) throw new Error("Hub lacks registered-host inventory");
            const hosts = await this.command("list_hosts", {}, this.hubId);
            if (!hosts.items.some((h: any) => h.machineId === request.taskForm!.machineId)) throw new Error("Selected host is not registered; no task requested");
          }
          if (!this.supportsBrief && (form?.problem !== undefined || form?.description !== undefined)) throw new Error("Hub lacks task briefs; no request sent");
        } catch (error) {
          if (this.active) throw error; // A refusal cannot clear an older unresolved draft.
          throw new TuiRequestNotSent(error instanceof Error ? error.message : "Creation preflight failed; no child requested");
        }
        this.active = { kind: "task", chatId: this.chatId!, requestId: randomUUID(), title: request.text!, ...(managed ? {} : this.binding!), ...form }; this.activeSaved = false;
        await this.deliver(); break;
      }
      case "childOpen": {
        if (this.active || this.userImport || this.settingsUncertain) throw new Error("Resolve pending requests/settings before opening a child");
        try {
          const opened = await this.openChild(request.chatId!);
          state.notice = `Child ${request.chatId} TUI ${opened.ack.status === "reused" ? "reused" : "opening"} in the parent's Rex session and saved directory. No model input submitted.`;
        } catch (error) {
          throw new Error(`Child Rex open unconfirmed; inspect Rex before another explicit :child-open ${request.chatId}. No automatic retry. ${error instanceof Error ? error.message : ""}`);
        }
        break;
      }
      case "rexStatus":
      case "rexInspect": {
        if (!this.supportsRex) throw new Error("Hub does not advertise Rex support");
        const status = await this.command("rex_status", { chatId: this.chatId }, this.hubId);
        const inspection = request.action === "rexInspect" ? await this.command("rex_inspect", { chatId: this.chatId }, this.hubId) : undefined;
        state.rex = { status, ...(inspection ? { inspection } : {}) }; break;
      }
      case "rexOpen": {
        if (!this.supportsRex) throw new Error("Hub does not advertise Rex support; no terminal requested");
        delete state.rex;
        try {
          const ack = await this.command("rex_open", { chatId: this.chatId, requestId: randomUUID(), port: this.port }, this.hubId);
          state.notice = ack.status === "reused" ? "Rex client observed running; reused, not a responsiveness guarantee." : "Rex attempt admitted, not ready. Press s for status. Best-effort; duplicates need manual cleanup.";
        } catch { throw new Error("Rex open unconfirmed; an attempt may exist. Inspect status/Rex before opening again. No automatic retry."); }
        break;
      }
      case "agentsmd":
        if (!this.binding || this.active || this.userImport || this.settingsUncertain) throw new Error("Resolve pending requests and confirm the binding before importing AGENTS.md");
        this.active = { kind: "instructions", source: "user", requestId: randomUUID(), chatId: this.chatId!, ...this.binding }; this.activeSaved = false;
        await this.deliver(); break;
      case "send":
        if (this.settingsUncertain) throw new Error("Model settings unconfirmed; wait for a fresh observation before submitting");
        if (this.active) throw new Error("Saved request unresolved: :retry or :discard before new input");
        // Reserve in memory first as well: even a disk/send/cleanup failure cannot
        // silently generate a different durable identity on the next action.
        this.active = { kind: "input", chatId: this.chatId!, requestId: randomUUID(), text: request.text!, mode: "steer" }; this.activeSaved = false;
        await this.deliver(); break;
      case "retry":
        if (this.settingsUncertain) throw new Error("Model settings unconfirmed; refresh before retrying input");
        await this.deliver(); break;
      case "models": await this.refreshSettings(); break;
      case "configure": {
        if (!this.supportsSettings || !state.modelSettings) throw new Error("Open :model to read this hub's settings first");
        if (this.settingsUncertain) throw new Error("Previous settings outcome unconfirmed; observe current settings before choosing again");
        if (this.active || (await this.store!.list()).some((d) => d.chatId === this.chatId)) throw new Error("Resolve saved requests before changing model/thinking");
        const change = request.configuration!;
        if (!sameSelection(change.expected, state.modelSettings.selection)) throw new Error("Displayed settings changed; refresh before choosing again");
        this.settingsUncertain = true;
        await this.command("set_model_settings", { chatId: this.chatId, ...change }, this.hubId);
        // Observe after ACK too: another client can change this shared chat.
        await this.refreshSettings();
        state.notice = "Model/thinking settings applied; no input submitted";
        break;
      }
      case "discard":
        if (this.active) { this.activeSaved = false; await this.store!.remove(this.active.requestId); this.active = undefined; }
        state.notice = "Draft discarded locally; already-admitted work was not cancelled"; break;
      case "stop":
        await this.command("stop", { chatId: this.chatId }, this.hubId);
        state.notice = "Stop requested, not a drained/completed receipt"; break;
      case "older": {
        const before = request.before ?? this.before;
        if (!before) { state.notice = "No older history in this view"; break; }
        const page = this.renderHistory(await this.history(before), "older");
        const entries = page.entries;
        this.before = page.next; state.hasOlder = !!page.next;
        if (entries.length === 0) { state.notice = "No older retained history; current view unchanged"; break; }
        state.entries = entries; state.historical = true; break;
      }
      case "latest":
      case "poll": {
        await this.observeUserImport();
        await this.refreshInventory();
        if (this.supportsSettings) await this.refreshSettings();
        if (request.action === "latest" || (!request.hold && !state.historical)) {
          const page = await this.history(), rendered = this.renderHistory(page, request.action);
          state.entries = rendered.entries; this.before = rendered.next; state.hasOlder = !!rendered.next; state.historical = false; this.sample(page);
        } else {
          // Keep a scrolled/history window stable; samples never replace it.
          const activity = await this.readView("activity", { chatId: this.chatId, includeAgentStatus: true, includeSubagents: true });
          const progress = await this.readView("progress", { chatId: this.chatId });
          this.sample({ activity, progress });
        }
        // Admission is a transient acknowledgement, not a durable completion
        // status. A successful fresh view takes over (even if work is ongoing
        // or activity is unavailable); failed reads and other notices stay put.
        if (state.notice === inputAdmittedNotice) state.notice = "";
        break;
      }
    }
    if (this.localWorkspace && Date.now() - this.gitSampleAt >= 2000) {
      this.gitSampleAt = Date.now();
      const branch = await localGitBranch(process.cwd());
      if (branch === undefined) delete state.gitBranch; else state.gitBranch = branch;
    }
    const text = this.active?.kind === "input" ? displayText(this.active.text, 16384) : "";
    const admitted = this.participates() ? this.admittedInputs.filter(input => input.chatId === this.chatId).map(({ requestId, text }) => ({ requestId, text })) : [];
    if (admitted.length) state.admittedInputs = admitted; else delete state.admittedInputs;
    state.settingsPending = this.settingsUncertain;
    state.draft = this.active ? { kind: this.active.kind, requestId: this.active.requestId, saved: this.activeSaved, text, clipped: this.active.kind === "input" && text !== this.active.text } : null;
    return structuredClone(state);
  }
}
export function localSession(port: number, chatId: string | undefined, hubId: string | undefined, signal: AbortSignal, draftRoot?: string): TuiSession {
  return new TuiSession((name, args, expected) => hubCommand(port, name, args, expected, signal), chatId, hubId, draftRoot, port);
}
