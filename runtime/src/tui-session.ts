// Client-only adapter: shared HTTP validation and existing local drafts, no Pi
// session, store, execution or replay loop. The renderer owns presentation.
import { validAgentStatus } from "./view-contracts.js";
import { validRexReply } from "./rex-open-contracts.js";
import { sameSelection, validModelSettingsSnapshot } from "./model-settings-contracts.js";
import { randomUUID } from "node:crypto";
import { DraftStore, type Draft } from "./drafts.js";
import { hubCommand } from "./hub-client.js";
import { HubError } from "./responses.js";
import { validTuiRequest, validTuiResponse, type TuiRequest, type TuiSnapshot, type TuiEntry, type TuiResponse } from "./generated/contracts.js";
import { validSafePiId, validMutationArgs } from "./mutation-contracts.js";

export function displayText(value: string, bytes: number): string {
  // Keep text, not terminal commands. Never pass provider OSC/CSI/C1 to the TTY.
  const clean = value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
  if (Buffer.byteLength(clean) <= bytes) return clean;
  let result = "", used = 0;
  for (const cp of clean) { const n = Buffer.byteLength(cp); if (used + n > bytes - 16) break; used += n; result += cp; }
  return result + "\n[view clipped]";
}
export function validRequest(value: unknown): value is TuiRequest {
  if (!validTuiRequest(value)) return false;
  if (value.action === "select" ? !validSafePiId(value.chatId) : value.chatId !== undefined) return false;
  if (value.after !== undefined && (value.action !== "tasks" || !validSafePiId(value.after))) return false;
  if (value.hold !== undefined && value.action !== "poll") return false;
  if (value.action === "configure" ? value.configuration === undefined : value.configuration !== undefined) return false;
  if (value.action === "send" || value.action === "create") return typeof value.text === "string" && value.text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").length > 0 && Buffer.byteLength(value.text) <= (value.action === "send" ? 16384 : 200);
  return value.text === undefined;
}
export function validReply(value: unknown, id: string, hubId?: string, chatId?: string, action?: TuiRequest["action"], target?: string, after?: string): value is TuiResponse {
  if (!validTuiResponse(value) || value.id !== id) return false;
  if (!value.ok) return true;
  const s = value.snapshot;
  if ((action === "models" || action === "configure") && !s.modelSettings) return false;
  const expectedChat = action === "select" ? target : chatId;
  if (action === "select" && !validSafePiId(target)) return false;
  if (!validSafePiId(s.chatId) || (hubId !== undefined && hubId !== s.hubId) || (expectedChat !== undefined && expectedChat !== s.chatId)) return false;
  if (s.mainChatId !== undefined && !validSafePiId(s.mainChatId)) return false;
  if (action === "tasks" && (!s.tasks || s.tasks.after !== after)) return false;
  if (s.tasks) {
    let previous = Number(s.tasks.after ?? 0);
    if (s.tasks.after !== undefined && !validSafePiId(s.tasks.after)) return false;
    for (const row of s.tasks.items) { if (!validSafePiId(row.chatId) || Number(row.chatId) <= previous) return false; previous = Number(row.chatId); }
    if (s.tasks.next !== undefined && (!validSafePiId(s.tasks.next) || Number(s.tasks.next) <= Number(s.tasks.after ?? 0) || Number(s.tasks.next) < previous)) return false;
  }
  if ((action === "rexStatus" || action === "rexInspect") && !s.rex) return false;
  if (action === "rexInspect" && !s.rex?.inspection) return false;
  if (s.rex && (!validRexReply({ command: "rex_status", args: { chatId: s.chatId }, hubId: s.hubId }, s.rex.status) || (s.rex.inspection && !validRexReply({ command: "rex_inspect", args: { chatId: s.chatId }, hubId: s.hubId }, s.rex.inspection)))) return false;
  if (s.agentStatus && !validAgentStatus(s.agentStatus)) return false;
  if (s.modelSettings && (!validModelSettingsSnapshot(s.modelSettings) || s.modelSettings.hubId !== s.hubId || s.modelSettings.chatId !== s.chatId)) return false;
  return s.entries.every((item, i) => i === 0 || item.id > s.entries[i - 1]!.id);
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
  private supportsSettings = false;
  private supportsRex = false;
  private supportsStartup = false;
  private startupBlocked = false;
  private binding?: { machineId: string; cwd: string };
  private settingsUncertain = false;
  constructor(private readonly command: Command, private readonly selected?: string, private readonly expectedHub?: string, private readonly draftRoot?: string, private readonly port = 52800) {}
  async registerStartup(allocationId: string, blockId: string | undefined) {
    if (this.state || this.startupBlocked) throw new Error("Rex startup cannot be replayed in this client");
    this.startupBlocked = true;
    const args = { chatId: this.selected, allocationId, blockId };
    if (!this.expectedHub || !validMutationArgs("rex_startup", args)) throw new Error("Rex startup requires a pinned hub/task and native full REX_BLOCK");
    await this.initialize();
    if (!this.supportsStartup) throw new Error("Hub lacks Rex startup capability; no input enabled");
    const page = await this.history();
    this.state!.entries = this.renderEntries(page); this.before = page.next; this.state!.hasOlder = !!page.next;
    await this.command("rex_startup", args, this.hubId);
    this.state!.notice = "Rex startup registered (historical observation, not current health).";
    this.startupBlocked = false;
  }
  private async initialize() { if (!this.state) await this.selectChat(this.selected); }
  private async selectChat(target?: string) {
    if (this.active || this.settingsUncertain) throw new Error("Resolve saved requests/settings before switching tasks");
    const status = await this.command("status", target ? { chatId: target } : {}, this.hubId ?? this.expectedHub);
    if (status.hubGuard !== 1 || (target && status.chatId !== target) || ((this.hubId ?? this.expectedHub) && status.hubId !== (this.hubId ?? this.expectedHub))) throw new Error("Hub/chat identity guard required; selection unchanged");
    const store = this.store ?? new DraftStore(status.hubId, this.draftRoot);
    const saved = (await store.list()).filter((draft) => draft.chatId === status.chatId);
    const active = saved[0] ? (await store.load(saved[0].requestId)).request : undefined;
    // Commit the selection only after all fallible reads. No old page, sample,
    // cursor, binding or request can leak into the new chat on a failed switch.
    this.hubId = status.hubId; this.chatId = status.chatId; this.store = store;
    this.active = active; this.activeSaved = !!active; this.before = undefined;
    this.binding = status.binding && { machineId: status.binding.machineId, cwd: status.binding.cwd };
    this.supportsRex = status.rexOpen === 1;
    this.supportsStartup = status.rexStartup === 1;
    this.supportsSettings = status.modelSettings === 1; this.settingsUncertain = this.supportsSettings;
    const notice = active ? `Saved ${active.kind} ${active.requestId}: :retry or :discard; instruction drafts use --no-tui.${saved.length > 1 ? " Other drafts: --no-tui /drafts." : ""}` : "";
    this.state = { hubId: this.hubId!, chatId: this.chatId!, mainChatId: status.mainChatId, title: displayText(status.binding?.title || (this.chatId === status.mainChatId ? "Main" : `Chat ${this.chatId}`), 160), model: displayText(`${status.model?.provider ?? ""}/${status.model?.modelId ?? "unknown model"}`, 160), tools: status.tools, activityKnown: false, busy: false, queued: 0, entries: [], hasOlder: false, historical: false, preview: "", notice, draft: null };
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
    let limit = 80;
    for (;;) {
      try { return await this.command("history", { chatId: this.chatId, limit, ...(before ? { before } : {}), includeActivity: true, includeAgentStatus: true, includeProgress: true }, this.hubId); }
      catch (error) { if (!(error instanceof HubError) || error.policy.action !== "reduce_page" || limit === 1) throw error; limit = Math.max(1, Math.floor(limit / 2)); }
    }
  }
  private renderEntries(page: any): TuiEntry[] {
    let budget = 128 * 1024;
    return page.items.slice().reverse().map((entry: any): TuiEntry => {
      let role: TuiEntry["role"] = "note", text = "";
      if (entry.kind === "deck.input") {
        role = "user"; text = entry.data.text;
        if (entry.data.origin?.kind === "task-tool") { role = "note"; text = `[agent chat ${entry.data.origin.chatId}, task ${entry.data.origin.taskId}]\n${text}`; }
      }
      else if (entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") {
        role = entry.kind === "pi.assistant" ? "assistant" : "tool";
        text = entry.model.map((message: any) => {
          const parts = (message.content ?? []).map((part: any) => part.type === "text" ? part.text : part.type === "toolCall" ? `[tool requested: ${part.name}]` : "[non-text content]").join("\n");
          return (role === "tool" ? `${message.toolName}${message.isError ? " (error)" : ""}\n` : "") + parts + (message.stopReason === "error" || message.stopReason === "aborted" ? `\n[${message.stopReason}]` : "");
        }).join("\n");
      } else text = `[${entry.kind}: retained entry, not rendered]`;
      text = budget >= 32 ? displayText(text, Math.min(8192, budget)) : "[view budget]"; budget -= Buffer.byteLength(text);
      return { id: entry.id, role, text };
    });
  }
  private sample(page: any) {
    // Absence is unknown, never a fresh replay of an old completion/idle sample.
    delete this.state!.agentStatus;
    if (page.activity?.agentStatus) this.state!.agentStatus = page.activity.agentStatus;
    if (page.activity) { this.state!.activityKnown = true; this.state!.busy = page.activity.busy; this.state!.queued = page.activity.queued; }
    if (page.progress) this.state!.preview = displayText([page.progress.generation?.text ?? "", ...(page.progress.tools ?? []).map((tool: any) => `[${tool.name}] ${tool.text}`)].filter(Boolean).join("\n"), 4096);
  }
  private async deliver() {
    if (!this.active || this.active.kind === "instructions") throw new Error("Use --no-tui to retry saved instruction requests");
    this.activeSaved = false;
    await this.store!.save(this.active); // Must succeed before network; exact original fields.
    this.activeSaved = true;
    const { kind, chatId, requestId, ...args } = this.active;
    const ack = await this.command(kind === "input" ? "admit" : "create_task", { requestId, ...args, ...(kind === "input" ? { chatId } : {}) }, this.hubId);
    this.activeSaved = false;
    await this.store!.remove(requestId); this.active = undefined;
    this.state!.notice = kind === "input" ? "Input admitted; completion not yet confirmed" : `Task ${ack.chatId} created; /select ${ack.chatId} or /tasks to open it. No input submitted.`;
  }
  async handle(request: TuiRequest): Promise<TuiSnapshot> {
    if (!validRequest(request)) throw new Error("Invalid renderer request");
    if (this.startupBlocked) throw new Error("Rex startup unconfirmed; no input enabled");
    await this.initialize();
    let state = this.state!;
    switch (request.action) {
      case "select":
        await this.selectChat(request.chatId); state = this.state!; break;
      case "tasks": {
        const page = await this.command("list_chats", { limit: 25, ...(request.after ? { after: request.after } : {}) }, this.hubId);
        state.tasks = { items: page.items.map((row: any) => ({ chatId: row.chatId, kind: row.kind, title: displayText(row.title, 160), machineId: displayText(row.machineId, 80), cwd: displayText(row.cwd, 256) })), ...(request.after ? { after: request.after } : {}), ...(page.next ? { next: page.next } : {}) };
        break;
      }
      case "create":
        if (this.active || this.settingsUncertain) throw new Error("Resolve saved requests/settings before creating a task");
        if (!this.binding) throw new Error("Saved workspace binding unavailable; no task requested");
        this.active = { kind: "task", chatId: this.chatId!, requestId: randomUUID(), title: request.text!, ...this.binding }; this.activeSaved = false;
        await this.deliver(); break;
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
        if (!this.supportsSettings || !state.modelSettings) throw new Error("Open /model to read this hub's settings first");
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
        const page = await this.history(this.before);
        const entries = this.renderEntries(page);
        this.before = page.next; state.hasOlder = !!page.next;
        if (entries.length === 0) { state.notice = "No older retained history; current view unchanged"; break; }
        state.entries = entries; state.historical = true; break;
      }
      case "latest":
      case "poll": {
        if (this.supportsSettings) await this.refreshSettings();
        if (request.action === "latest" || (!request.hold && !state.historical)) {
          const page = await this.history(); const entries = this.renderEntries(page);
          state.entries = entries; this.before = page.next; state.hasOlder = !!page.next; state.historical = false; this.sample(page);
        } else {
          // Keep a scrolled/history window stable; samples never replace it.
          const activity = await this.command("activity", { chatId: this.chatId, includeAgentStatus: true }, this.hubId);
          const progress = await this.command("progress", { chatId: this.chatId }, this.hubId);
          this.sample({ activity, progress });
        }
        break;
      }
    }
    const text = this.active?.kind === "input" ? displayText(this.active.text, 16384) : "";
    state.settingsPending = this.settingsUncertain;
    state.draft = this.active ? { kind: this.active.kind, requestId: this.active.requestId, saved: this.activeSaved, text, clipped: this.active.kind === "input" && text !== this.active.text } : null;
    return structuredClone(state);
  }
}
export function localSession(port: number, chatId: string | undefined, hubId: string | undefined, signal: AbortSignal): TuiSession {
  return new TuiSession((name, args, expected) => hubCommand(port, name, args, expected, signal), chatId, hubId, undefined, port);
}
