// Creation intent -> durable task ACK -> exact native bootstrap adoption ->
// allocation verification. The renderer never becomes a hub/task authority.
import { randomUUID } from "node:crypto";
import { DraftStore } from "./drafts.js";
import { hubCommand } from "./hub-client.js";
import { launcherCommand } from "./launcher-client.js";
import { StartupFiles, finishStartup } from "./agent-storage.js";
import { briefFields, validBrief, validBriefBinding } from "./task-brief.js";
import { validSafePiId } from "./mutation-contracts.js";
import { validRexReply } from "./rex-open-contracts.js";
import { validAgentStartupDraft, validAgentWizardRequest, validRexAdoptAck, type AgentStartupDraft, type AgentWizardRequest, type AgentWizardResponse, type LauncherRequest, type RexBootstrapRecord, type RexAdoptAck, type RexStatusSnapshot } from "./generated/contracts.js";
export function validWizardRequest(value: unknown): value is AgentWizardRequest {
  return validAgentWizardRequest(value) && (value.action === "create" ? typeof value.problem === "string" && !!value.problem.trim() && validBrief({ problem: value.problem, ...(value.description === undefined ? {} : { description: value.description }) }) : value.problem === undefined && value.description === undefined);
}
function title(problem: string): string {
  let value = "";
  for (const char of problem.split("\n", 1)[0]!.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim()) {
    if (Buffer.byteLength(value + char) > 200) break;
    value += char;
  }
  return value || "New task";
}
export async function startupDraft(record: RexBootstrapRecord, files: StartupFiles): Promise<AgentStartupDraft | undefined> {
  const form = await files.read("form.json");
  if (form === undefined) return;
  if (!validAgentStartupDraft(form) || form.bootstrapId !== record.id || form.hubId !== record.hubId || form.machineId !== record.machineId || form.cwd !== record.cwd || !form.problem.trim() || !validBriefBinding(form.title, form.cwd) || !validBrief(briefFields(form))) throw new Error("Invalid exact startup draft; nothing replayed");
  return form;
}
export type WizardTransport = { hub: (command: string, args: Record<string, unknown>) => Promise<any>; launcher: (request: LauncherRequest) => Promise<any> };
export function wizardTransport(record: RexBootstrapRecord, signal: AbortSignal): WizardTransport {
  return {
    hub: (command, args) => hubCommand(record.port, command, args, record.hubId, signal),
    launcher: request => {
      if (!record.workerSocket) throw new Error("No selected worker");
      return launcherCommand({ hubId: record.hubId, machineId: record.machineId, socket: record.workerSocket }, request, signal);
    },
  };
}
export class AgentWizard {
  private phase: AgentWizardResponse["phase"] = "form";
  private notice = "Nothing created or submitted. Review the fields, then choose Create & start.";
  private ready: AgentWizardResponse["ready"];
  constructor(readonly record: RexBootstrapRecord, readonly files: StartupFiles, private readonly transport: WizardTransport) {
    if (!record.binding) throw new Error("Bootstrap has no verified terminal");
  }
  private async creation(form: AgentStartupDraft): Promise<string> {
    const saved = await this.files.read("created.json");
    if (saved !== undefined) {
      const value = saved as { requestId?: unknown; chatId?: unknown };
      if (!validSafePiId(value.chatId) || value.requestId !== form.creationId || JSON.stringify(value) !== JSON.stringify({ requestId: value.requestId, chatId: value.chatId })) throw new Error("Invalid creation receipt");
      return value.chatId;
    }
    const brief = briefFields(form), args = { requestId: form.creationId, title: form.title, cwd: form.cwd, ...brief };
    const ack = this.record.workerSocket
      ? await this.transport.launcher({ version: 1, id: randomUUID(), command: "launch_create", args })
      : await this.transport.hub("create_task_brief", { ...args, machineId: form.machineId });
    if (!validSafePiId(ack.chatId) || JSON.stringify(briefFields(ack.brief ?? {})) !== JSON.stringify(brief)) throw new Error("Invalid exact creation acknowledgement");
    await this.files.publish("created.json", { requestId: form.creationId, chatId: ack.chatId });
    return ack.chatId;
  }
  private async adoption(form: AgentStartupDraft, chatId: string): Promise<RexAdoptAck> {
    let ack = await this.files.read("adopted.json");
    if (ack === undefined) {
      const args = { chatId, requestId: form.adoptionId, port: this.record.port, target: this.record.target, bootstrap: { id: this.record.id, root: this.record.draftRoot, blockId: this.record.binding!.blockId } };
      ack = this.record.workerSocket
        ? (await this.transport.launcher({ version: 1, id: randomUUID(), command: "launch_adopt", args })).ack
        : await this.transport.hub("rex_adopt", args);
      if (!validRexReply({ command: "rex_adopt", args, hubId: form.hubId }, ack)) throw new Error("Invalid adoption acknowledgement");
      await this.files.publish("adopted.json", ack);
    }
    if (!validRexAdoptAck(ack) || ack.chatId !== chatId || ack.hubId !== form.hubId || ack.requestId !== form.adoptionId || !validSafePiId(ack.taskId)) throw new Error("Invalid adoption receipt");
    return ack;
  }
  private async verify(form: AgentStartupDraft, ack: RexAdoptAck): Promise<void> {
    const status: RexStatusSnapshot = this.record.workerSocket
      ? (await this.transport.launcher({ version: 1, id: randomUUID(), command: "launch_inspect", args: { chatId: ack.chatId } })).status
      : await this.transport.hub("rex_status", { chatId: ack.chatId });
    if (!validRexReply({ command: "rex_status", args: { chatId: ack.chatId }, hubId: form.hubId }, status) || status.taskId !== ack.taskId) throw new Error("Allocation observation unavailable");
    if (status.status === "pending") { this.phase = "waiting"; this.notice = "Task created; waiting for its exact terminal allocation. No problem input admitted yet."; return; }
    const b = status.binding, native = this.record.binding!, target = this.record.target;
    if (status.status !== "allocated" || !b || b.machineId !== form.machineId || b.cwd !== form.cwd || b.blockId !== native.blockId || b.windowId !== native.windowId || b.sessionId !== native.sessionId || b.server !== target.server || b.hostId !== target.hostId || b.instanceId !== target.instanceId) throw new Error("Allocation is unconfirmed; no replacement or input");
    this.ready = { chatId: ack.chatId, allocationId: ack.allocationId, inputId: form.inputId };
    this.phase = "ready"; this.notice = "Task and allocation verified. Registering this terminal before initial input.";
  }
  private async advance(form: AgentStartupDraft): Promise<void> {
    const chatId = await this.creation(form);
    // Save before allocation too: if the form terminal dies, an explicit resume
    // can recover this same input with :retry. Saving is never admission.
    await new DraftStore(form.hubId, this.record.draftRoot).save({ kind: "input", chatId, requestId: form.inputId, text: form.problem, mode: "steer" });
    const ack = await this.adoption(form, chatId);
    await this.verify(form, ack);
  }
  async recoverCreation(): Promise<string> {
    const form = await startupDraft(this.record, this.files);
    if (!form || await this.files.read("discarded.json") !== undefined || await this.files.read("completed.json") !== undefined) throw new Error("No unresolved creation intent");
    const chatId = await this.creation(form);
    await new DraftStore(form.hubId, this.record.draftRoot).save({ kind: "input", chatId, requestId: form.inputId, text: form.problem, mode: "steer" });
    await this.files.publish("recovered.json", { version: 1, chatId, inputId: form.inputId });
    await finishStartup(this.record);
    return chatId; // Never adopt/open a terminal or admit the initial problem.
  }
  async handle(request: AgentWizardRequest): Promise<AgentWizardResponse> {
    if (!validWizardRequest(request)) throw new Error("Invalid creation form");
    let saved = false;
    try {
      let form = await startupDraft(this.record, this.files);
      saved = !!form;
      if (await this.files.read("discarded.json") !== undefined) {
        this.phase = "blocked"; this.notice = "Startup request discarded. Work was not cancelled. Detach; use --list / --resume to inspect any created task.";
      } else if (request.action === "create") {
        if (form) throw new Error("Exact startup draft already exists");
        form = { version: 1, bootstrapId: this.record.id, hubId: this.record.hubId, machineId: this.record.machineId, cwd: this.record.cwd, creationId: randomUUID(), adoptionId: randomUUID(), inputId: randomUUID(), title: title(request.problem!), problem: request.problem!, ...(request.description === undefined ? {} : { description: request.description }) };
        await this.files.publish("form.json", form); saved = true;
        await this.advance(form);
      } else if (request.action === "retry") {
        if (!form) throw new Error("No exact draft to retry");
        await this.advance(form); // Same creation/adoption/input identities only.
      } else if (request.action === "discard") {
        await this.files.publish("discarded.json", { version: 1 });
        if (form) await new DraftStore(form.hubId, this.record.draftRoot).remove(form.inputId);
        await finishStartup(this.record);
        this.phase = "blocked"; this.notice = "Startup request discarded locally; created tasks and admitted work were not cancelled. Detach to inspect.";
      } else if (this.phase === "waiting" && form) {
        const ack = await this.files.read("adopted.json");
        if (!validRexAdoptAck(ack) || ack.requestId !== form.adoptionId || ack.hubId !== form.hubId) throw new Error("No verified allocation admission");
        await this.verify(form, ack); // Read-only polling; never creation/adoption.
      } else if (form && this.phase === "form") {
        this.phase = "blocked"; this.notice = "Exact saved startup request found. Retry explicitly, or discard locally; no automatic replay.";
      }
    } catch {
      this.phase = "blocked";
      this.notice = "Startup outcome unconfirmed. Exact requests retained where saved. Retry uses their original identities; detach never stops work. No replacement or input replayed.";
    }
    return { version: 1, id: request.id, phase: this.phase, notice: this.notice, saved, ...(this.phase === "ready" && this.ready ? { ready: this.ready } : {}) };
  }
}
