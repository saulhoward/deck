import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DraftStore, type Draft } from "./drafts.js";
import { InstructionsDisplay, validInstructionId } from "./instructions-view.js";
import { ProgressDisplay } from "./progress.js";
import { loginClient } from "./login-client.js";
import { HubError } from "./responses.js";
import { hubCommand } from "./hub-client.js";
import { validMutationArgs } from "./mutation-contracts.js";
import { validRexUuid } from "./generated/contracts.js";
import { validDiscoveryPage } from "./discovery-contracts.js";
import { validHistoryPage } from "./history-contracts.js";
import { validOpenArgs } from "./rex-open-contracts.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hub response");
  return value as ObjectValue;
}
// Plain mode never interprets terminal control sequences from retained messages.
function plain(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function renderHistory(items: unknown[], descending = true) {
  for (const raw of descending ? items.slice().reverse() : items) {
    const entry = object(raw);
    if (entry.kind === "deck.input") {
      const data = object(entry.data); const origin = data.origin && typeof data.origin === "object" && !Array.isArray(data.origin) ? object(data.origin) : {};
      const sender = origin.kind === "task-tool" ? `agent chat ${plain(String(origin.chatId))}` : "you";
      stdout.write(`${sender}: ${plain(String(data.text))}\n`);
    }
    else if (entry.kind === "pi.assistant" && Array.isArray(entry.model)) {
      for (const rawMessage of entry.model) {
        const msg = object(rawMessage);
        if (msg.stopReason === "error" || msg.stopReason === "aborted") stdout.write(`assistant ${msg.stopReason}: ${plain(String(msg.errorMessage ?? "Generation interrupted"))}\n`);
        if (Array.isArray(msg.content)) for (const rawPart of msg.content) {
          const part = object(rawPart);
          if (part.type === "text") stdout.write(`assistant: ${plain(String(part.text))}\n`);
          else if (part.type === "toolCall") stdout.write(`tool requested: ${plain(JSON.stringify(String(part.name)))}\n`);
        }
      }
    } else if (entry.kind === "pi.tool-result" && Array.isArray(entry.model)) {
      for (const rawMessage of entry.model) {
        const msg = object(rawMessage);
        const details = msg.details && typeof msg.details === "object" && !Array.isArray(msg.details) ? object(msg.details) : {};
        const summary = { ...(typeof details.code === "string" ? { code: details.code.slice(0, 120) } : {}), ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}), ...(details.truncated === true ? { truncated: true } : {}) };
        stdout.write(`tool ${plain(JSON.stringify(String(msg.toolName)))} result (${msg.isError ? "error" : "ok"}) ${plain(JSON.stringify(summary))}:\n`);
        if (Array.isArray(msg.content)) {
          const text = plain(msg.content.map((raw) => { const part = object(raw); return part.type === "text" ? String(part.text) : "[non-text tool output omitted]"; }).join("\n"));
          if (text.length > 8192) stdout.write("[display clipped to tool output tail; canonical history retains full result]\n");
          stdout.write(`${text.slice(-8192)}\n`);
        }
      }
    }
  }
}

async function main() {
  let login = false;
  let rexCommand: string | undefined;
  const rexTarget: Record<string, string> = {};
  let port = 52800; let selected: string | undefined; let message: string | undefined; let expectedHubId: string | undefined; let rexAllocationId: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--no-tui") continue;
    if (arg === "--login") { login = true; continue; }
    const value = args[++i];
    if (!value) throw new Error("Missing option value");
    if (arg === "--port" && /^\d+$/.test(value)) port = Number(value);
    else if (arg === "--task" && /^[1-9]\d*$/.test(value)) selected = value;
    else if (arg === "--message") message = value;
    else if (arg === "--hub-id" && value.length <= 200) expectedHubId = value;
    else if (arg === "--rex-allocation" && validRexUuid(value)) rexAllocationId = value;
    else if (arg === "--rex-command" && ["open", "reopen", "status", "inspect"].includes(value)) rexCommand = value;
    else if (arg === "--rex") rexTarget.executable = value;
    else if (arg === "--server") rexTarget.server = value;
    else if (arg === "--host-id") rexTarget.hostId = value;
    else if (arg === "--instance-id") rexTarget.instanceId = value;
    else throw new Error("Unknown client option");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const target = Object.keys(rexTarget).length ? rexTarget : undefined;
  if (target && !validOpenArgs({ chatId: selected ?? "1", requestId: randomUUID(), port, target })) throw new Error("Invalid Rex override: --rex must be absolute, --server a local Unix URL, and optional host/instance IDs full UUIDs");
  if ((rexCommand && (!selected || login || message !== undefined || rexAllocationId)) || (target && (login || rexAllocationId))) throw new Error("Rex commands require --task and cannot combine login, input or startup");
  const requireHubGuard = expectedHubId !== undefined;
  const rexBlockId = process.env.REX_BLOCK;
  if (rexAllocationId && (!expectedHubId || !selected || login || message !== undefined || !validMutationArgs("rex_startup", { chatId: selected, allocationId: rexAllocationId, blockId: rexBlockId }))) throw new Error("Rex startup requires an explicit hub/task and native full REX_BLOCK; no input sent");
  const transport = new AbortController();
  let detached = false;
  const command = async (name: string, args: ObjectValue = {}) => object(await hubCommand(port, name, args, expectedHubId, transport.signal));
  const historyPage = async (args: ObjectValue, limit: number) => {
    for (;;) {
      try {
        const request = { ...args, limit };
        const page = await command("history", request);
        if (!validHistoryPage(page, request)) throw new Error("Invalid history response; cursor unchanged");
        return { page, limit };
      }
      catch (error) {
        if (!(error instanceof HubError) || error.policy.action !== "reduce_page" || limit === 1) throw error;
        limit = Math.max(1, Math.floor(limit / 2));
      }
    }
  };
  const status = await command("status", !login && selected ? { chatId: selected } : {});
  selected ??= String(status.mainChatId);
  if (typeof status.hubId !== "string") throw new Error("Hub lacks draft identity; restart the updated hub");
  if (expectedHubId && (status.hubId !== expectedHubId || (requireHubGuard && status.hubGuard !== 1))) throw new Error("Expected hub identity/guard unavailable; no input sent");
  if (rexAllocationId && (status.rexStartup !== 1 || status.chatId !== selected)) throw new Error("Rex startup capability/selected chat unavailable; no input sent");
  expectedHubId = status.hubId;
  if (login) return loginClient(command);
  const runRex = async (action: string) => {
    if (status.hubGuard !== 1 || status.rexOpen !== 1) throw new Error("Hub lacks public Rex capability; no terminal requested");
    if (!["open", "reopen", "status", "inspect"].includes(action)) throw new Error("Use /rex open, /rex reopen, /rex status or /rex inspect");
    const opening = action === "open" || action === "reopen";
    if (opening) stdout.write("Rex open is best-effort: a lost reply or concurrent open may leave duplicates. No automatic retry; inspect Rex before repeating.\n");
    let result: ObjectValue;
    try { result = await command(opening ? "rex_open" : `rex_${action}`, { chatId: selected, ...(opening ? { requestId: randomUUID(), port, ...(target ? { target } : {}) } : {}) }); }
    catch (error) {
      if (opening && !detached) process.stderr.write("Rex open not acknowledged; an attempt may still have been admitted or created a terminal. Explicitly opening again may duplicate it. Existing chat drafts are unchanged.\n");
      throw error;
    }
    if (detached) return;
    stdout.write(`${plain(JSON.stringify(result))}\n`);
    if (opening) stdout.write(result.status === "reused" ? "Saved client observed running; no new terminal requested. This does not focus a GUI or prove client responsiveness.\n" : `Rex attempt admitted, not yet allocated/ready. Use /rex status or deck rex status --task ${selected} --port ${port}.\n`);
  };
  if (rexCommand) return runRex(rexCommand);
  const drafts = new DraftStore(status.hubId);
  let active: Draft | undefined;
  const restore = async () => {
    for (const saved of (await drafts.list()).filter((draft) => draft.chatId === selected)) {
      try { active = (await drafts.load(saved.requestId)).request; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (active && !detached) stdout.write(`Recovered ${active.kind} draft ${active.requestId} for chat ${active.chatId}. /retry resends the original request; /discard forgets it locally. /drafts lists saved drafts.\n`);
  };
  const deliver = async (draft: Draft) => {
    await drafts.save(draft); // Never send until the complete private record is published.
    const { kind, chatId, ...args } = draft;
    const ack = await command(kind === "input" ? "admit" : kind === "task" ? "create_task" : "import_instructions", kind === "task" ? args : { chatId, ...args });
    // command() checked the generated command-specific ACK and its semantic
    // identity/range guards; transport success alone never permits removal.
    await drafts.remove(draft.requestId);
    return ack;
  };
  await restore();
  if (message !== undefined) {
    if (active) throw new Error("Saved draft exists for this chat; reconnect interactively and /retry or /discard first");
    active = { kind: "input", chatId: selected, requestId: randomUUID(), text: message, mode: "steer" };
    try { const ack = await deliver(active); active = undefined; stdout.write(`${JSON.stringify(ack)}\n`); }
    catch (error) { process.stderr.write("Request not acknowledged or local cleanup incomplete. Reconnect to recover the saved request; nothing is sent if saving fails.\n"); throw error; }
    return; // Detach after durable admission, never wait/abort on behalf of the client.
  }
  stdout.write(`Deck chat ${selected} — ${plain(String(status.provider))} ${plain(JSON.stringify(status.model))}, ${plain(String(status.tools))}. /help for commands.\n`);
  let newerAfter = "0";
  let selection = 0;
  let lastActivity: string | undefined;
  const previews = new ProgressDisplay(plain);
  const instructions = new InstructionsDisplay();
  let olderBefore: string | undefined;
  let historyLoaded = false;
  let recentLimit = 100; let olderLimit = 100;
  let polling: Promise<void> | undefined;
  const history = (): Promise<void> => {
    if (polling) return polling;
    const chatId = selected; const revision = selection;
    polling = (async () => {
      const ascending = historyLoaded;
      const result = await historyPage({ chatId, includeActivity: true, includeProgress: true, includeInstructions: true, ...(ascending ? { after: newerAfter } : {}) }, recentLimit);
      if (revision !== selection || detached) return;
      const { page } = result; recentLimit = result.limit;
      // The whole page (including rendered payloads) was checked before output.
      const ids = page.items.map((entry) => entry.id);
      renderHistory(page.items, !ascending);
      if (ids.length) newerAfter = String(ascending ? ids.at(-1)! : ids[0]!);
      if (!historyLoaded) {
        olderBefore = typeof page.next === "string" ? page.next : undefined;
        historyLoaded = true;
        if (olderBefore) stdout.write("Older retained history: /older\n");
      }
      if (page.activity !== undefined) {
        const activity = object(page.activity); const key = JSON.stringify(activity);
        if (key !== lastActivity && (lastActivity !== undefined || activity.busy || activity.queued || activity.compactions || activity.compactionFailed)) stdout.write(`activity: ${plain(key)}\n`);
        lastActivity = key;
      }
      const preview = previews.render(page.progress, chatId!);
      if (preview) stdout.write(preview);
      const instructionLine = instructions.render(page.instructions, chatId!);
      if (instructionLine) stdout.write(instructionLine);
      // One poll owns at most one bounded history page + preview. Do not keep
      // queuing snapshots if the terminal/pipe consumer stops reading.
      if (stdout.writableNeedDrain) await once(stdout, "drain", { signal: transport.signal });
    })().finally(() => { polling = undefined; });
    return polling;
  };
  const loadSelectedHistory = async () => {
    await history();
    // A prior selection's in-flight poll may have just been discarded.
    if (!historyLoaded) await history();
  };
  await history();
  // Input stays paused until startup checks and the allocation-bound observation
  // ACK complete. No one-shot submission, automatic retry, or new draft identity.
  if (rexAllocationId) {
    // command() validates generated ACK shape and exact saved identities. This
    // creates no draft/replay queue and still proves no current client health.
    await command("rex_startup", { chatId: selected, allocationId: rexAllocationId, blockId: rexBlockId });
    stdout.write("Rex startup registered (historical observation, not current health).\n");
  }
  const editor = createInterface({ input: stdin, output: stdout, terminal: false });
  let connected = true;
  const timer = setInterval(() => {
    void history().then(() => {
      if (!connected && !detached) process.stderr.write("Hub reconnected.\n");
      connected = true;
    }, () => {
      if (connected && !detached) process.stderr.write("Hub unavailable; new input cannot be acknowledged.\n");
      connected = false;
    });
  }, 500);
  let chatCursor: string | undefined;
  const select = async (id: string) => {
    selected = id; selection++; lastActivity = undefined; previews.reset(); instructions.reset(); newerAfter = "0"; olderBefore = undefined; historyLoaded = false; recentLimit = 100; olderLimit = 100;
    stdout.write(`Selected chat ${plain(id)}.\n`);
    await restore();
  };
  const requireAcknowledged = () => {
    if (active) throw new Error("Retry or discard your unacknowledged request first");
  };
  const createTask = async () => {
    const task = await deliver(active!);
    active = undefined;
    if (detached) return;
    await select(String(task.chatId)); await loadSelectedHistory();
  };
  const importInstructions = async () => {
    const draft = active!;
    const ack = await deliver(draft); active = undefined;
    if (detached) return;
    stdout.write(`Instruction import admitted: task ${ack.taskId}. Application not yet confirmed; /instructions ${ack.taskId} checks its result.\n`);
    // The task ID is now discoverable from Pi even after detach; the acknowledged
    // local draft is not kept as an execution/result queue.
    const revision = selection;
    try {
      const snapshot = await command("instruction_status", { chatId: draft.chatId, taskId: ack.taskId });
      if (!detached && revision === selection) {
        const line = new InstructionsDisplay().render(snapshot, draft.chatId, true);
        if (!line) throw new Error("Invalid instruction status");
        stdout.write(line);
      }
    } catch { if (!detached) process.stderr.write(`Import admitted; result unavailable. /instructions ${ack.taskId} checks it without another read.\n`); }
  };
  const detach = () => {
    if (detached) return;
    detached = true; editor.close(); clearInterval(timer); transport.abort();
    const blockedOutput = stdout.writableNeedDrain;
    if (active) process.stderr.write("Detached with an unresolved draft; work may already be admitted. Reconnect for /retry; saving must have succeeded to recover it.\n");
    if (blockedOutput) {
      // Node intentionally does not close standard stdout on destroy(); a pending
      // pipe write can otherwise keep this detached client alive indefinitely.
      // This process owns no execution. Save-before-send prevents this attempt
      // sending before publication; earlier ambiguous admissions keep their IDs.
      stdout.destroy(); setImmediate(() => process.exit(process.exitCode ?? 0));
    }
  };
  process.once("SIGINT", detach);
  try {
    for await (const line of editor) {
      if (detached) break;
      const text = line.trim();
      if (!text) continue;
      try {
        if (text === "/exit") break;
        if (text === "/help") { stdout.write("/status /activity /stop /older /tasks [more] /select CHAT_ID /main /task TITLE /instructions [load|TASK_ID] /rex [open|reopen|status|inspect] /draft /drafts /recover REQUEST_ID /retry /discard [REQUEST_ID] /exit\nEnter submits or steers. /instructions load replaces stored explicit instructions with saved-worker AGENTS.md, only while idle; admission is not application. /instructions reads source/task status without loading. Switching detaches without stopping other chats. Ctrl+C detaches. Answer previews are sampled/provisional; retained history is authoritative. This is plain line mode, not TUI.\n"); continue; }
        if (text === "/draft") {
          if (!active) throw new Error("No active unacknowledged draft");
          const preview = plain(JSON.stringify(active));
          stdout.write(`${preview.slice(0, 8192)}${preview.length > 8192 ? " [display clipped; saved request is unchanged]" : ""}\n`); continue;
        }
        if (text === "/drafts") { for (const saved of await drafts.list()) stdout.write(`${plain(JSON.stringify(saved))}\n`); continue; }
        if (text.startsWith("/recover ")) {
          const recovered = (await drafts.load(text.slice(9).trim())).request;
          if (recovered.chatId !== selected) throw new Error(`Draft belongs to chat ${recovered.chatId}; open that chat first`);
          if (active) await drafts.save(active);
          active = recovered;
          stdout.write(`Recovered ${active.kind} draft ${active.requestId}; /retry resends it unchanged.\n`); continue;
        }
        if (text === "/older") {
          if (!historyLoaded) await loadSelectedHistory();
          if (!olderBefore) { stdout.write("No older history.\n"); continue; }
          const revision = selection;
          const result = await historyPage({ chatId: selected, before: olderBefore }, olderLimit);
          if (revision !== selection || detached) continue;
          const { page } = result; olderLimit = result.limit;
          stdout.write(`Older history for chat ${plain(selected)} (oldest first within this page):\n`);
          renderHistory(page.items);
          olderBefore = typeof page.next === "string" ? page.next : undefined;
          stdout.write(olderBefore ? "More retained history: /older\n" : "Beginning of retained history.\n"); continue;
        }
        if (text === "/tasks" || text === "/tasks more") {
          if (text === "/tasks more" && !chatCursor) { stdout.write("No more chats; /tasks refreshes the list.\n"); continue; }
          const args = { limit: 25, ...(text === "/tasks more" ? { after: chatCursor } : {}) };
          const page = await command("list_chats", args);
          // Validate/narrow the entire page before rendering or cursor advancement.
          if (!validDiscoveryPage(page, args)) throw new Error("Invalid chat discovery response; cursor unchanged");
          for (const item of page.items) {
            stdout.write(`${item.chatId === selected ? "*" : " "} ${plain(JSON.stringify(item))}\n`);
          }
          chatCursor = page.next;
          stdout.write(chatCursor ? "More chats: /tasks more\n" : "End of chat list.\n"); continue;
        }
        if (text === "/main" || text.startsWith("/select ")) {
          requireAcknowledged();
          const id = text === "/main" ? String(status.mainChatId) : text.slice(8).trim();
          const next = await command("status", { chatId: id });
          await select(String(next.chatId)); await loadSelectedHistory(); continue;
        }
        if (text === "/rex" || text.startsWith("/rex ")) { await runRex(text === "/rex" ? "status" : text.slice(5).trim()); continue; }
        if (text === "/activity") { stdout.write(`activity: ${plain(JSON.stringify(await command("activity", { chatId: selected })))}\n`); continue; }
        if (text === "/status") { stdout.write(`${plain(JSON.stringify(await command("status", { chatId: selected })))}\n`); continue; }
        if (text === "/stop") { await command("stop", { chatId: selected }); stdout.write("Stop requested for selected work; /status shows whether effects are still draining.\n"); continue; }
        if (text === "/discard" || text.startsWith("/discard ")) {
          const id = text === "/discard" ? active?.requestId : text.slice(9).trim();
          if (id) { await drafts.remove(id); if (active?.requestId === id) active = undefined; }
          continue;
        }
        if (text === "/instructions load") {
          requireAcknowledged();
          const binding = object((await command("status", { chatId: selected })).binding);
          active = { kind: "instructions", chatId: selected, requestId: randomUUID(), machineId: String(binding.machineId), cwd: String(binding.cwd) };
          await importInstructions(); continue;
        }
        if (text === "/instructions" || text.startsWith("/instructions ")) {
          const taskId = text === "/instructions" ? undefined : text.slice(14).trim();
          if (taskId !== undefined && !validInstructionId(taskId)) throw new Error("Use /instructions, /instructions load or /instructions TASK_ID");
          const revision = selection; const chatId = selected;
          const snapshot = await command("instruction_status", { chatId, ...(taskId ? { taskId } : {}) });
          if (!detached && revision === selection) {
            const line = new InstructionsDisplay().render(snapshot, chatId, true);
            if (!line) throw new Error("Invalid instruction status; application not confirmed");
            stdout.write(line);
          }
          continue;
        }
        if (text === "/retry" && active?.kind === "instructions") { await importInstructions(); continue; }
        if (text === "/retry" && active?.kind === "task") { await createTask(); continue; }
        if (text.startsWith("/task ")) {
          requireAcknowledged();
          const binding = object((await command("status", { chatId: selected })).binding);
          active = { kind: "task", chatId: selected, requestId: randomUUID(), title: text.slice(6), machineId: String(binding.machineId), cwd: String(binding.cwd) };
          await createTask(); continue;
        }
        if (text.startsWith("/") && text !== "/retry") throw new Error("Unknown command; use /help");
        if (text !== "/retry") {
          if (active) throw new Error("Unacknowledged request retained: /retry or /discard before sending new text");
          active = { kind: "input", chatId: selected, requestId: randomUUID(), text, mode: "steer" };
        }
        if (!active) throw new Error("No unacknowledged input to retry");
        await deliver(active); active = undefined;
        await history();
      } catch (error) { if (detached) break; process.stderr.write(`${plain(error instanceof Error ? error.message : "Request failed")}${active ? "; draft retained, use /retry (saving must succeed before send)" : ""}\n`); }
    }
  } finally { detach(); process.off("SIGINT", detach); }
}

main().catch((error: unknown) => { process.stderr.write(`deck agent: ${plain(error instanceof Error ? error.message : "Hub unavailable")}\n`); process.exitCode = 1; });
