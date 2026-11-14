// Readiness/list/resume for the native launcher. The endpoint is already
// selected and pinned; this helper never falls back or starts a runtime.
import { randomUUID } from "node:crypto";
import { hubCommand } from "./hub-client.js";
import { launcherCommand, rexLauncherTarget } from "./launcher-client.js";
import { LauncherDrafts } from "./launcher-drafts.js";
import { validStatusSnapshot, type LauncherRequest, type LauncherTask, type ChatListPage } from "./generated/contracts.js";
import { displayText } from "./tui-session.js";
import { startupIndexes, bootstrapPath, bootstrapRecord, StartupFiles, finishStartup, missing } from "./agent-storage.js";
import { AgentWizard, wizardTransport, startupDraft } from "./agent-wizard.js";
import { DraftStore } from "./drafts.js";
const [kind, selected, action, root, value, ...extra] = process.argv.slice(2);
async function main() {
  if (extra.length || !selected || !root?.startsWith("/") || !["local", "worker"].includes(kind ?? "") || !["ready", "prepare", "list", "resume", "drafts", "discard", "discard-startup", "recover"].includes(action ?? "") || ((action === "resume" || action === "discard" || action === "discard-startup" || action === "recover") !== (value !== undefined))) throw new Error("Invalid agent launch options");
  const port = kind === "local" ? Number(selected) : 52800;
  const remote = kind === "worker" ? await rexLauncherTarget(selected) : undefined;
  const status = remote ? undefined : await hubCommand(port, "status");
  const local = validStatusSnapshot(status) ? status : undefined;
  if (!remote && (!local?.machineId || local.chatId !== local.mainChatId || local.binding?.kind !== "main" || local.binding.machineId !== local.machineId || local.rexAdopt !== 1 || local.taskBrief !== 1)) throw new Error("Local hub lacks automatic task startup; start the matching Deck build");
  const hubId: string = remote?.hubId ?? local!.hubId, machineId: string = remote?.machineId ?? local!.machineId!;
  const launch = async (request: LauncherRequest): Promise<any> => {
    if (!remote) throw new Error("No selected worker");
    return launcherCommand(remote, request);
  };
  const page = async (after?: string): Promise<{ items: LauncherTask[]; next?: string }> => {
    if (remote) return launch({ version: 1, id: randomUUID(), command: "launch_list", args: after ? { after } : {} });
    const result = await hubCommand(port, "list_chats", { limit: 25, ...(after ? { after } : {}) }, hubId) as ChatListPage;
    return { items: result.items.filter((row: any) => row.kind === "task" && !row.parentChatId && row.machineId === machineId), ...(result.next ? { next: result.next } : {}) };
  };
  const first = await page(); // Actual scoped relay handshake, not a PID file.
  if (action === "ready") { process.stdout.write(JSON.stringify({ hubId, machineId })); return; }
  const store = new LauncherDrafts({hubId, machineId}, root);
  const indexes = await startupIndexes(root, hubId, machineId);
  if (action === "prepare") {
    if ((await store.list()).length) throw new Error("Unresolved launcher request exists; use --drafts before a new task");
    for (const index of indexes) {
      const files = new StartupFiles(bootstrapPath(root, index.id));
      const pending = await files.read("form.json").catch(error => { if (missing(error)) return undefined; throw error; });
      if (pending !== undefined && await files.read("completed.json") === undefined && await files.read("discarded.json") === undefined) throw new Error("Unresolved startup request exists; use --drafts, then recover or discard explicitly before a new task");
    }
    return;
  }
  if (action === "drafts") {
    for (const index of indexes) process.stdout.write(`${index.id} startup (inspect original Rex form, or --recover ID --confirm; no automatic replay)\n`);
    for (const draft of await store.list()) process.stdout.write(`${draft.args.requestId} ${draft.command}\n`);
    return;
  }
  if (action === "discard" || action === "discard-startup") {
    const index = indexes.find(index => index.id === value);
    // Native uses discard-startup only for an exact, explicitly confirmed
    // launch fence. Its index may already be gone after completion/recovery.
    if (index || action === "discard-startup") {
      const id = index?.id ?? value!;
      const files = new StartupFiles(bootstrapPath(root, id));
      const record = await bootstrapRecord(root, id, false).catch(error => { if (missing(error)) return undefined; throw error; });
      if (record && (record.hubId !== hubId || record.machineId !== machineId || record.draftRoot !== root)) throw new Error("Invalid startup scope");
      await files.publish("discarded.json", { version: 1 }).catch(error => { if (!missing(error)) throw error; });
      if (record) {
        const form = await startupDraft(record, files);
        if (form) await new DraftStore(hubId, root).remove(form.inputId);
      }
      await finishStartup({ id, hubId, machineId, draftRoot: root });
    } else await store.remove(await store.load(value!));
    process.stdout.write("Startup/launcher draft discarded locally; no task or admitted work cancelled.\n"); return;
  }
  let recoveredChat: string | undefined;
  if (action === "recover") {
    const index = indexes.find(index => index.id === value);
    if (!index) throw new Error("Unresolved startup ID not found on this worker");
    const record = await bootstrapRecord(root, index.id, false);
    if (record.hubId !== hubId || record.machineId !== machineId || record.draftRoot !== root || record.workerSocket !== remote?.socket || (!remote && record.port !== port)) throw new Error("Invalid startup scope");
    recoveredChat = await new AgentWizard(record, new StartupFiles(bootstrapPath(root, record.id)), wizardTransport(record, new AbortController().signal)).recoverCreation();
  }
  const tasks = first.items; let after = first.next;
  for (let count = 1; after; count++) {
    if (count >= 1000) throw new Error("Task listing exceeds page bound; use explicit paginated inspection");
    const next = await page(after); tasks.push(...next.items); after = next.next;
  }
  if (recoveredChat) {
    const task = tasks.find(task => task.chatId === recoveredChat);
    process.stdout.write(`Creation recovered. Initial problem retained as an exact input draft; no terminal or input replayed. If the original creation form is still open, choose Retry there. Otherwise use --resume ${task?.agentName ?? "(find name with --list)"}, then :retry explicitly.\n`);
    return;
  }
  if (action === "list") {
    for (const task of tasks) process.stdout.write(`${task.agentName ?? "(unnamed)"}\t${displayText(task.title, 200)}\t${displayText(task.cwd, 4096)}\n`);
    if (!tasks.length) process.stdout.write("No independent tasks on this worker.\n");
    return;
  }
  const matches = tasks.filter(task => task.agentName === value);
  if (matches.length !== 1) throw new Error("Task name not found uniquely on this worker; use --list. No task or terminal created");
  if ((await store.list()).length) throw new Error("Unresolved launcher request exists. Use --drafts and inspect the task before explicitly discarding that request; no open replayed");
  const task = matches[0]!;
  const request: Extract<LauncherRequest, { command: "launch_open" }> = { version: 1, id: randomUUID(), command: "launch_open", args: { chatId: task.chatId, requestId: randomUUID(), confirmedOnly: true } };
  await store.save(request);
  const ack = remote ? (await launch(request)).ack : await hubCommand(port, "rex_open", { ...request.args, port }, hubId);
  await store.remove(request);
  process.stdout.write(`${task.agentName}: ${ack.status === "reused" ? "existing task client observed; reused" : "terminal attempt admitted; not yet confirmed ready"}. Closing the client does not stop work.\n`);
}
void main().catch(error => {
  // No nested transport/provider diagnostics or request bodies.
  const allowed = error instanceof Error && /^(Invalid agent|Local hub lacks|Task name|Task listing|Unresolved launcher)/.test(error.message);
  process.stderr.write(allowed ? `${error.message}\n` : "Selected hub/worker unavailable or request outcome unconfirmed; exact saved drafts retained. No fallback or automatic replay.\n");
  process.exitCode = 1;
});
