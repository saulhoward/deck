import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DraftStore, type Draft } from "./drafts.js";
import { loginClient } from "./login-client.js";

type ObjectValue = Record<string, unknown>;
class HubError extends Error {
  constructor(readonly code: unknown, message: string) { super(message); }
}
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
    if (entry.kind === "deck.input") stdout.write(`you: ${plain(String(object(entry.data).text))}\n`);
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
  let port = 52800; let selected: string | undefined; let message: string | undefined;
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
    else throw new Error("Unknown client option");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const transport = new AbortController();
  let detached = false;
  const command = async (name: string, args: ObjectValue = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/command`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, id: randomUUID(), command: name, args }),
      signal: AbortSignal.any([transport.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error(`Hub HTTP ${response.status}`);
    const envelope = object(await response.json());
    if (!envelope.ok) { const error = object(envelope.error); throw new HubError(error.code, String(error.message)); }
    return object(envelope.result);
  };
  const historyPage = async (args: ObjectValue, limit: number) => {
    for (;;) {
      try { return { page: await command("history", { ...args, limit }), limit }; }
      catch (error) {
        if (!(error instanceof HubError) || error.code !== "too_large" || limit === 1) throw error;
        limit = Math.max(1, Math.floor(limit / 2));
      }
    }
  };
  if (login) return loginClient(command);
  const status = await command("status", selected ? { chatId: selected } : {});
  selected ??= String(status.mainChatId);
  if (typeof status.hubId !== "string") throw new Error("Hub lacks draft identity; restart the updated hub");
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
    const ack = await command(kind === "input" ? "admit" : "create_task", kind === "input" ? { chatId, ...args } : args);
    const id = ack[kind === "input" ? "submissionId" : "chatId"];
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("Invalid acknowledgement; draft retained");
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
  let olderBefore: string | undefined;
  let historyLoaded = false;
  let recentLimit = 100; let olderLimit = 100;
  let polling: Promise<void> | undefined;
  const history = (): Promise<void> => {
    if (polling) return polling;
    const chatId = selected; const revision = selection;
    polling = (async () => {
      const ascending = historyLoaded;
      const result = await historyPage({ chatId, includeActivity: true, ...(ascending ? { after: newerAfter } : {}) }, recentLimit);
      if (revision !== selection || detached) return;
      const { page } = result; recentLimit = result.limit;
      if (!Array.isArray(page.items)) throw new Error("Invalid history");
      const ids = page.items.map((raw: unknown) => Number(object(raw).id));
      let previous = ascending ? Number(newerAfter) : Infinity;
      for (const id of ids) {
        if (!Number.isSafeInteger(id) || id < 1 || (ascending ? id <= previous : id >= previous)) throw new Error("Invalid history order; hub must support forward catch-up");
        previous = id;
      }
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
    })().finally(() => { polling = undefined; });
    return polling;
  };
  const loadSelectedHistory = async () => {
    await history();
    // A prior selection's in-flight poll may have just been discarded.
    if (!historyLoaded) await history();
  };
  await history();
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
    selected = id; selection++; lastActivity = undefined; newerAfter = "0"; olderBefore = undefined; historyLoaded = false; recentLimit = 100; olderLimit = 100;
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
  const detach = () => {
    if (detached) return;
    detached = true; editor.close(); clearInterval(timer); transport.abort();
    if (active) process.stderr.write("Detached with an unresolved draft; work may already be admitted. Reconnect for /retry; saving must have succeeded to recover it.\n");
  };
  process.once("SIGINT", detach);
  try {
    for await (const line of editor) {
      if (detached) break;
      const text = line.trim();
      if (!text) continue;
      try {
        if (text === "/exit") break;
        if (text === "/help") { stdout.write("/status /activity /stop /older /tasks [more] /select CHAT_ID /main /task TITLE /draft /drafts /recover REQUEST_ID /retry /discard [REQUEST_ID] /exit\nEnter submits or steers. Switching detaches without stopping other chats. Ctrl+C detaches. This is plain line mode, not TUI.\n"); continue; }
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
          if (!Array.isArray(page.items)) throw new Error("Invalid history");
          stdout.write(`Older history for chat ${plain(selected)} (oldest first within this page):\n`);
          renderHistory(page.items);
          olderBefore = typeof page.next === "string" ? page.next : undefined;
          stdout.write(olderBefore ? "More retained history: /older\n" : "Beginning of retained history.\n"); continue;
        }
        if (text === "/tasks" || text === "/tasks more") {
          if (text === "/tasks more" && !chatCursor) { stdout.write("No more chats; /tasks refreshes the list.\n"); continue; }
          const page = await command("list_chats", { limit: 25, ...(text === "/tasks more" ? { after: chatCursor } : {}) });
          if (!Array.isArray(page.items)) throw new Error("Invalid chat list");
          for (const raw of page.items) {
            const item = object(raw);
            stdout.write(`${item.chatId === selected ? "*" : " "} ${plain(JSON.stringify(item))}\n`);
          }
          chatCursor = typeof page.next === "string" ? page.next : undefined;
          stdout.write(chatCursor ? "More chats: /tasks more\n" : "End of chat list.\n"); continue;
        }
        if (text === "/main" || text.startsWith("/select ")) {
          requireAcknowledged();
          const id = text === "/main" ? String(status.mainChatId) : text.slice(8).trim();
          const next = await command("status", { chatId: id });
          await select(String(next.chatId)); await loadSelectedHistory(); continue;
        }
        if (text === "/activity") { stdout.write(`activity: ${plain(JSON.stringify(await command("activity", { chatId: selected })))}\n`); continue; }
        if (text === "/status") { stdout.write(`${plain(JSON.stringify(await command("status", { chatId: selected })))}\n`); continue; }
        if (text === "/stop") { await command("stop", { chatId: selected }); stdout.write("Stop requested for selected work; /status shows whether effects are still draining.\n"); continue; }
        if (text === "/discard" || text.startsWith("/discard ")) {
          const id = text === "/discard" ? active?.requestId : text.slice(9).trim();
          if (id) { await drafts.remove(id); if (active?.requestId === id) active = undefined; }
          continue;
        }
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
