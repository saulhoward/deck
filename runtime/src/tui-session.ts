// Client-only adapter: shared HTTP validation and existing local drafts, no Pi
// session, store, execution or replay loop. The renderer owns presentation.
import { displayText, projectEntry, flattenParts, entryBytes } from "./tui-content.js";
export { displayText, thinkingUsage } from "./tui-content.js";
import { validInventoryFields } from "./tool-inventory-contracts.js";
import { localGitBranch } from "./tui-workspace.js";
import { canParticipate, requireParticipation, requireNavigation, requireCreation, inspectOnly } from "./client-access.js";
import type { TuiClientMode } from "./generated/contracts.js";
import { validAgentStatus, validSubagents } from "./view-contracts.js";
import { validRexReply } from "./rex-open-contracts.js";
import { sameSelection, validModelSettingsSnapshot } from "./model-settings-contracts.js";
import { randomUUID } from "node:crypto";
import { DraftStore, type Draft } from "./drafts.js";
import { hubCommand } from "./hub-client.js";
import { HubError } from "./responses.js";
import { validMachineIdentity, validRexUuid, validTuiRequest, validTuiResponse, type TuiRequest, type TuiSnapshot, type TuiEntry, type TuiResponse } from "./generated/contracts.js";
import { validSafePiId, validMutationArgs } from "./mutation-contracts.js";

import { validTaskTarget } from "./task-target.js";
import { validForm, validBrief, taskCreationCommand } from "./task-brief.js";
import { validHosts } from "./host-inventory.js";

export function validRequest(value: unknown): value is TuiRequest {
  if (!validTuiRequest(value)) return false;
  if (value.action === "select" ? !validSafePiId(value.chatId) : value.chatId !== undefined) return false;
  if (value.after !== undefined && (value.action !== "tasks" || !validSafePiId(value.after))) return false;
  if (value.hold !== undefined && value.action !== "poll") return false;
  if (value.action === "configure" ? value.configuration === undefined : value.configuration !== undefined) return false;
  if (value.taskForm !== undefined) return value.action === "create" && value.text === undefined && value.taskTarget === undefined && validForm(value.taskForm);
  if (value.taskTarget !== undefined) return value.action === "create" && value.text === undefined && validTaskTarget(value.taskTarget);
  if (value.action === "send" || value.action === "create") return typeof value.text === "string" && value.text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").length > 0 && Buffer.byteLength(value.text) <= (value.action === "send" ? 16384 : 200);
  return value.text === undefined;
}
export function validReply(value: unknown, id: string, hubId?: string, chatId?: string, action?: TuiRequest["action"], target?: string, after?: string, mode?: TuiClientMode, hubChatId?: string): value is TuiResponse {
  if (!validTuiResponse(value) || value.id !== id || Buffer.byteLength(JSON.stringify(value)) >= 1024 * 1024) return false;
  if (!value.ok) return true;
  const s = value.snapshot;
  if ((action === "models" || action === "configure") && !s.modelSettings) return false;
  const expectedChat = action === "select" ? target : chatId;
  if (action === "select" && !validSafePiId(target)) return false;
  if (!validSafePiId(s.chatId) || (hubId !== undefined && hubId !== s.hubId) || (expectedChat !== undefined && expectedChat !== s.chatId)) return false;
  if (!validSafePiId(s.hubChatId) || (mode !== undefined && s.clientMode !== mode) || (hubChatId !== undefined && s.hubChatId !== hubChatId)) return false;
  if (s.clientMode === "task" && (s.chatId === s.hubChatId || s.tasks !== undefined || s.hosts !== undefined || action === "hosts" || action === "select" || action === "tasks" || action === "create")) return false;
  if (!canParticipate(s.clientMode, s.chatId, s.hubChatId) && s.draft !== null) return false;
  if (s.hosts !== undefined && !validHosts(s.hosts) || action === "hosts" && !s.hosts) return false;
  if (s.brief !== undefined && !validBrief(s.brief)) return false;
  if (action === "tasks" && (!s.tasks || s.tasks.after !== after)) return false;
  if (s.tasks) {
    let previous = Number(s.tasks.after ?? 0);
    if (s.tasks.after !== undefined && !validSafePiId(s.tasks.after)) return false;
    for (const row of s.tasks.items) { if (!validSafePiId(row.chatId) || Number(row.chatId) <= previous || (row.parentChatId !== undefined && (!validSafePiId(row.parentChatId) || row.kind !== "subagent" || Number(row.parentChatId) >= Number(row.chatId)))) return false; previous = Number(row.chatId); }
    if (s.tasks.next !== undefined && (!validSafePiId(s.tasks.next) || Number(s.tasks.next) <= Number(s.tasks.after ?? 0) || Number(s.tasks.next) < previous)) return false;
  }
  if ((action === "rexStatus" || action === "rexInspect") && !s.rex) return false;
  if (action === "rexInspect" && !s.rex?.inspection) return false;
  if (s.rex && (!validRexReply({ command: "rex_status", args: { chatId: s.chatId }, hubId: s.hubId }, s.rex.status) || (s.rex.inspection && !validRexReply({ command: "rex_inspect", args: { chatId: s.chatId }, hubId: s.hubId }, s.rex.inspection)))) return false;
  if (!validInventoryFields(s)) return false;
  if (s.agentStatus && !validAgentStatus(s.agentStatus)) return false;
  if (s.subagents !== undefined && !validSubagents(s.subagents, s.chatId)) return false;
  if (s.modelSettings && (!validModelSettingsSnapshot(s.modelSettings) || s.modelSettings.hubId !== s.hubId || s.modelSettings.chatId !== s.chatId)) return false;
  if (s.entries.reduce((bytes, item) => bytes + Buffer.byteLength(item.text), 0) > 128 * 1024) return false;
  return s.entries.every((item, i) => Buffer.byteLength(item.text) <= entryBytes &&
    (item.parts === undefined || flattenParts(item.parts) === item.text) &&
    (i === 0 || item.id > s.entries[i - 1]!.id));
}
type Command = (name: string, args: Record<string, unknown>, hubId?: string) => Promise<any>;
export class TuiSession {
  private hubId?: string;
  private chatId?: string;
  private store?: DraftStore;
  private active: Draft | undefined;
  private activeSaved = false;
  private state?: TuiSnapshot;
  private before: string | undefined;
  private pageLimits = { latest: 80, older: 80 };
  private supportsSettings = false;
  private supportsRex = false;
  private supportsStartup = false;
  private supportsBrief = false;
  private supportsHosts = false;
  private startupBlocked = false;
  private attachmentMachine?: string;
  private mode: TuiClientMode = "hub";
  private hubChatId?: string;
  private participates() { return canParticipate(this.mode, this.chatId, this.hubChatId); }
  private binding?: { machineId: string; cwd: string };
  private settingsUncertain = false;
  private localWorkspace = false;
  private gitSampleAt = 0;
  private inventorySampleAt = 0;
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
  private async selectChat(target?: string) {
    if (this.state) requireNavigation(this.mode);
    if (this.active || (this.participates() && this.settingsUncertain)) throw new Error("Resolve saved requests/settings before switching tasks");
    const status = await this.command("status", target ? { chatId: target } : {}, this.hubId ?? this.expectedHub);
    if (status.hubGuard !== 1 || (target && status.chatId !== target) || ((this.hubId ?? this.expectedHub) && status.hubId !== (this.hubId ?? this.expectedHub))) throw new Error("Hub/chat identity guard required; selection unchanged");
    if (this.hubChatId !== undefined && status.mainChatId !== this.hubChatId) throw new Error("Hub chat identity changed; selection unchanged");
    if (this.attachmentMachine && (status.chatId === status.mainChatId || status.binding?.kind !== "task" || status.binding.machineId !== this.attachmentMachine)) throw new Error("Attached task worker/binding changed; no input enabled");
    const store = this.store ?? new DraftStore(status.hubId, this.draftRoot);
    const saved = (await store.list()).filter((draft) => draft.chatId === status.chatId);
    const writable = canParticipate(this.mode, status.chatId, status.mainChatId);
    const active = writable && saved[0] ? (await store.load(saved[0].requestId)).request : undefined;
    // Commit the selection only after all fallible reads. No old page, sample,
    // cursor, binding or request can leak into the new chat on a failed switch.
    this.hubId = status.hubId; this.chatId = status.chatId; this.hubChatId = status.mainChatId; this.store = store;
    this.active = active; this.activeSaved = !!active; this.before = undefined;
    this.pageLimits = { latest: 80, older: 80 };
    this.binding = status.binding && { machineId: status.binding.machineId, cwd: status.binding.cwd };
    this.localWorkspace = status.binding?.cwd === process.cwd() && (this.mode === "task" || status.machineId === status.binding?.machineId);
    this.gitSampleAt = 0;
    this.supportsRex = status.rexOpen === 1;
    this.supportsBrief = status.taskBrief === 1; this.supportsHosts = status.hostInventory === 1;
    this.supportsStartup = status.rexStartup === 1;
    this.supportsSettings = status.modelSettings === 1; this.settingsUncertain = this.supportsSettings;
    const notice = !writable ? `${inspectOnly}${saved.length ? " Saved requests remain untouched; review them in the Rex client." : ""}` : active ? `Saved ${active.kind} ${active.requestId}: :retry or :discard; instruction drafts use --no-tui.${saved.length > 1 ? " Other drafts: --no-tui /drafts." : ""}` : "";
    this.state = { ...(status.binding ? { cwd: displayText(status.binding.cwd, 4096), kind: status.binding.kind, ...(status.binding.agentRune === undefined ? {} : { agentRune: status.binding.agentRune }) } : {}), ...(status.binding?.agentName === undefined ? {} : { agentName: status.binding.agentName }), clientMode: this.mode, hubChatId: this.hubChatId!, hubId: this.hubId!, chatId: this.chatId!, title: this.chatId === this.hubChatId ? "Hub" : displayText(status.binding?.title || `Task ${this.chatId}`, 160), model: displayText(`${status.model?.provider ?? ""}/${status.model?.modelId ?? "unknown model"}`, 160), tools: status.tools, activityKnown: false, busy: false, queued: 0, entries: [], hasOlder: false, historical: false, preview: "", notice, draft: null, ...(status.binding?.brief ? { brief: { ...(status.binding.brief.problem === undefined ? {} : { problem: displayText(status.binding.brief.problem, 2048) }), ...(status.binding.brief.description === undefined ? {} : { description: displayText(status.binding.brief.description, 8192) }) } } : {}) };
    this.inventorySampleAt = Date.now();
    this.inventory(status);
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
      const status = await this.command("status", { chatId: this.chatId }, this.hubId);
      if (status.hubGuard !== 1 || status.hubId !== this.hubId || status.chatId !== this.chatId || status.mainChatId !== this.hubChatId) return;
      this.inventory(status);
    } catch { /* Observation unavailable; no automatic effect or health probe. */ }
  }
  private async refreshSettings() {
    if (!this.supportsSettings) throw new Error("Hub does not advertise model settings; upgrade it only when idle");
    const settings = await this.command("model_settings", { chatId: this.chatId }, this.hubId);
    if (!validModelSettingsSnapshot(settings) || settings.hubId !== this.hubId || settings.chatId !== this.chatId) throw new Error("Invalid model settings; selection unconfirmed");
    this.state!.modelSettings = settings;
    this.state!.model = displayText(`${settings.selection.provider}/${settings.selection.modelId}`, 160);
    this.settingsUncertain = false;
  }
  private async history(before?: string) {
    const direction = before === undefined ? "latest" : "older";
    let limit = this.pageLimits[direction];
    for (;;) {
      try {
        const page = await this.command("history", { chatId: this.chatId, limit, ...(before ? { before } : {}), includeActivity: true, includeAgentStatus: true, includeSubagents: true, includeProgress: true }, this.hubId);
        this.pageLimits[direction] = limit;
        return page;
      }
      catch (error) { if (!(error instanceof HubError) || error.policy.action !== "reduce_page" || limit === 1) throw error; limit = Math.max(1, Math.floor(limit / 2)); }
    }
  }
  private renderHistory(page: any): { entries: TuiEntry[]; next: string | undefined } {
    let budget = 128 * 1024, wireBudget = 512 * 1024;
    const entries: TuiEntry[] = [];
    // History arrives newest-first. Spend the view budget in that order so
    // older tool output cannot hide new input, answers or failure markers.
    for (const entry of page.items) {
      const projected = projectEntry(entry);
      const bytes = Buffer.byteLength(projected.text);
      // Parts duplicate the flat compatibility text and add JSON overhead. A
      // separate wire budget prevents many tiny parts escaping the frame cap.
      const wireBytes = Buffer.byteLength(JSON.stringify(projected)) + 1;
      if (bytes > budget || wireBytes > wireBudget) break;
      budget -= bytes; wireBudget -= wireBytes; entries.push(projected);
    }
    // The first entry always fits. If the display window is smaller than the
    // validated page, :older must start before its oldest displayed ID, not
    // skip the omitted entries using the server's farther-back cursor.
    const next = entries.length < page.items.length ? String(entries.at(-1)!.id) : page.next;
    return { entries: entries.reverse(), next };
  }
  private sample(page: any) {
    // Absence is unknown, never a fresh replay of an old completion/idle sample.
    delete this.state!.agentStatus;
    delete this.state!.subagents;
    if (page.activity?.subagents) this.state!.subagents = { ...page.activity.subagents, items: page.activity.subagents.items.map((item: import("./generated/contracts.js").SubagentItem) => ({ ...item, title: displayText(item.title, 160).replace(/\n/g, " ") })) };
    if (page.activity?.agentStatus) this.state!.agentStatus = page.activity.agentStatus;
    this.state!.activityKnown = page.activity !== undefined;
    this.state!.busy = page.activity?.busy ?? false;
    this.state!.queued = page.activity?.queued ?? 0;
    this.state!.preview = page.progress ? displayText([page.progress.generation?.text ?? "", ...(page.progress.tools ?? []).map((tool: any) => `[${tool.name}] ${tool.text}`)].filter(Boolean).join("\n"), 4096) : "";
  }
  private async deliver() {
    requireParticipation(this.mode, this.chatId, this.hubChatId);
    if (!this.active || this.active.kind === "instructions") throw new Error("Use --no-tui to retry saved instruction requests");
    if (this.active.kind === "task") {
      requireCreation(this.mode, this.chatId, this.hubChatId);
      if (!this.supportsRex) throw new Error("Rex support is required to create a task; no request sent");
    }
    if (this.active.kind === "task" && !this.supportsBrief && (this.active.problem !== undefined || this.active.description !== undefined)) throw new Error("Hub lacks task briefs; no request sent");
    this.activeSaved = false;
    await this.store!.save(this.active); // Must succeed before network; exact original fields.
    this.activeSaved = true;
    const method = this.active.kind === "task" ? taskCreationCommand(this.active) : "admit";
    const { kind, chatId, requestId, ...args } = this.active;
    const ack = await this.command(method, { requestId, ...args, ...(kind === "input" ? { chatId } : {}) }, this.hubId);
    this.activeSaved = false;
    await this.store!.remove(requestId); this.active = undefined;
    if (kind === "input") {
      this.state!.historical = false; // The next unheld poll follows the new conversation turn.
      this.state!.notice = "Input admitted; completion not yet confirmed";
    }
    else {
      // Creation is acknowledged and the exact draft is cleared before this
      // separate best-effort terminal attempt. Losing its reply must not turn
      // the acknowledged creation back into an input/task retry queue.
      try {
        const opened = await this.command("rex_open", { chatId: ack.chatId, requestId: randomUUID(), port: this.port }, this.hubId);
        this.state!.notice = `Task ${ack.chatId} created. ${opened.status === "reused" ? "Rex client reused" : "Rex attempt admitted, not yet ready"}. :select ${ack.chatId} inspects only; participate in Rex.`;
      } catch { this.state!.notice = `Task ${ack.chatId} created; Rex open unconfirmed. :select ${ack.chatId}, inspect Rex, then explicitly open/reopen if needed. No automatic retry.`; }
    }
  }
  async handle(request: TuiRequest): Promise<TuiSnapshot> {
    if (!validRequest(request)) throw new Error("Invalid renderer request");
    if (this.startupBlocked) throw new Error("Rex startup unconfirmed; no input enabled");
    await this.initialize();
    let state = this.state!;
    if (request.action === "select" || request.action === "tasks" || request.action === "hosts") requireNavigation(this.mode);
    if (request.action === "create") requireCreation(this.mode, this.chatId, this.hubChatId);
    if (["send", "retry", "discard", "stop", "configure"].includes(request.action)) requireParticipation(this.mode, this.chatId, this.hubChatId);
    switch (request.action) {
      case "select":
        await this.selectChat(request.chatId); state = this.state!; break;
      case "hosts":
        if (!this.supportsHosts) throw new Error("Hub lacks registered-host inventory");
        state.hosts = await this.command("list_hosts", {}, this.hubId); break;
      case "tasks": {
        const page = await this.command("list_chats", { limit: 25, ...(this.supportsHosts ? { includeObservations: true } : {}), ...(request.after ? { after: request.after } : {}) }, this.hubId);
        if (this.supportsHosts) state.hosts = await this.command("list_hosts", {}, this.hubId);
        state.tasks = { items: page.items.map((row: any) => ({ ...(row.agentRune === undefined ? {} : { agentRune: row.agentRune }), ...(row.agentName === undefined ? {} : { agentName: row.agentName }), chatId: row.chatId, kind: row.kind, title: row.chatId === this.hubChatId ? "Hub" : displayText(row.title, 160), machineId: displayText(row.machineId, 80), cwd: displayText(row.cwd, 256), ...(row.parentChatId ? { parentChatId: row.parentChatId } : {}), activity: row.activity ?? "unknown", rexState: row.rexState ?? "unknown", connection: state.hosts ? state.hosts.items.find(h => h.machineId === row.machineId)?.connection ?? "unregistered" : "unknown" })), ...(request.after ? { after: request.after } : {}), ...(page.next ? { next: page.next } : {}) };
        break;
      }
      case "create": {
        if (!this.supportsRex) throw new Error("Rex support is required to create a task; no request sent");
        if (this.active || this.settingsUncertain) throw new Error("Resolve saved requests/settings before creating a task");
        const form = request.taskForm ?? request.taskTarget;
        if (!form?.machineId && !this.binding) throw new Error("Saved workspace binding unavailable; no task requested");
        // New form selection uses registered hosts. Legacy :task-at retains its
        // exact arbitrary/offline binding contract and drafts are never retargeted.
        if (request.taskForm?.machineId) {
          if (!this.supportsHosts) throw new Error("Hub lacks registered-host inventory");
          const hosts = await this.command("list_hosts", {}, this.hubId);
          if (!hosts.items.some((h: any) => h.machineId === request.taskForm!.machineId)) throw new Error("Selected host is not registered; no task requested");
        }
        if (!this.supportsBrief && (form?.problem !== undefined || form?.description !== undefined)) throw new Error("Hub lacks task briefs; no request sent");
        this.active = { kind: "task", chatId: this.chatId!, requestId: randomUUID(), title: request.text!, ...this.binding!, ...form }; this.activeSaved = false;
        await this.deliver(); break;
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
        if (!this.before) { state.notice = "No older history in this view"; break; }
        const page = this.renderHistory(await this.history(this.before));
        const entries = page.entries;
        this.before = page.next; state.hasOlder = !!page.next;
        if (entries.length === 0) { state.notice = "No older retained history; current view unchanged"; break; }
        state.entries = entries; state.historical = true; break;
      }
      case "latest":
      case "poll": {
        await this.refreshInventory();
        if (this.supportsSettings) await this.refreshSettings();
        if (request.action === "latest" || (!request.hold && !state.historical)) {
          const page = await this.history(), rendered = this.renderHistory(page);
          state.entries = rendered.entries; this.before = rendered.next; state.hasOlder = !!rendered.next; state.historical = false; this.sample(page);
        } else {
          // Keep a scrolled/history window stable; samples never replace it.
          const activity = await this.command("activity", { chatId: this.chatId, includeAgentStatus: true, includeSubagents: true }, this.hubId);
          const progress = await this.command("progress", { chatId: this.chatId }, this.hubId);
          this.sample({ activity, progress });
        }
        break;
      }
    }
    if (this.localWorkspace && Date.now() - this.gitSampleAt >= 2000) {
      this.gitSampleAt = Date.now();
      const branch = await localGitBranch(process.cwd());
      if (branch === undefined) delete state.gitBranch; else state.gitBranch = branch;
    }
    const text = this.active?.kind === "input" ? displayText(this.active.text, 16384) : "";
    state.settingsPending = this.settingsUncertain;
    state.draft = this.active ? { kind: this.active.kind, requestId: this.active.requestId, saved: this.activeSaved, text, clipped: this.active.kind === "input" && text !== this.active.text } : null;
    return structuredClone(state);
  }
}
export function localSession(port: number, chatId: string | undefined, hubId: string | undefined, signal: AbortSignal, draftRoot?: string): TuiSession {
  return new TuiSession((name, args, expected) => hubCommand(port, name, args, expected, signal), chatId, hubId, draftRoot, port);
}
