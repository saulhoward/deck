// Offline maintenance under the native hub writer lock. Do not open a Harness:
// even Conversation.abort() can start scheduling or invoke old task handlers.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, type Cursor, type DocumentAddress, type Page, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { savedImplementation, unfinishedSubmissions, unfinishedTasks } from "./compatibility.js";
import { DeckError } from "./deck-error.js";
import { validRexUuid } from "./generated/contracts.js";

async function* records<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>) {
  let cursor: Cursor | undefined;
  do {
    const page = await scan(cursor);
    yield* page.items;
    cursor = page.next;
  } while (cursor);
}
async function current(storage: Storage, address: DocumentAddress) {
  const record = await storage.findDocument(address, "current", context);
  if (!record) return undefined;
  const doc = await storage.document(record.id, "current", context);
  if (doc?.version !== 1) throw new DeckError("invalid", "Unsupported force-start document version; nothing discarded");
  return doc;
}

export async function discardUnfinished(storage: Storage, expectedHubId?: string) {
  await savedImplementation(storage); // Force abandons recognized work; it is not a schema downgrade.
  const identity = await current(storage, { kind: "deck.identity", scope: { kind: "session" } });
  if ((identity && !validRexUuid(identity.value.id)) || (expectedHubId && identity?.value.id !== expectedHubId)) {
    throw new DeckError("conflict", "Hub identity differs from worker registry; nothing discarded");
  }
  const writes: StorageWrite[] = [];
  let tasks = 0, submissions = 0;
  const reason = "discarded_by_force_start", endedAt = Date.now();
  for (const status of unfinishedTasks) {
    for await (const task of records(c => storage.scanTasks({ status }, 100, c, context))) {
      if (task.state.status !== status) throw new Error("Unexpected task status");
      // As in Pi terminal settlement: keep identity/input/ownership and an already
      // decided completing outcome, not runnable checkpoints, memos or restart marks.
      const { memos, restarts, abortReason, state, ...rest } = task;
      const outcome = state.status === "completing" ? state.outcome : { status: "aborted" as const, reason };
      writes.push({ type: "task", value: { ...rest, abortRequested: rest.abortRequested || state.status !== "completing", endedAt, state: { status: "terminal", outcome } } });
      for await (const doc of records(c => storage.scanDocuments({ scope: { kind: "task", taskId: task.id }, at: "current" }, 100, c, context))) {
        writes.push({ type: "document.retire", id: doc.id });
      }
      tasks++;
    }
  }
  for (const status of unfinishedSubmissions) {
    for await (const submission of records(c => storage.scanSubmissions({ status }, 100, c, context))) {
      if (submission.status !== status) throw new Error("Unexpected submission status");
      writes.push({ type: "submission", value: { ...submission, status: "unanswered", reason } });
      submissions++;
    }
  }
  // Discard queued payloads as well as their scheduling records. A stale pi.live.run
  // would still reject new input; an old inbox could place discarded input on the NEXT run.
  for await (const chat of records(c => storage.scanConversations({}, 100, c, context))) {
    const scope = { kind: "conversation" as const, conversationId: chat.id };
    const inbox = await current(storage, { kind: InboxDoc.definition.kind, scope });
    if (inbox) {
      if (!Array.isArray(inbox.value.items)) throw new DeckError("invalid", "Unsupported Pi inbox; nothing discarded");
      if (inbox.value.items.length) writes.push({ type: "document.change", id: inbox.record.id, content: { kind: "base", version: 1, value: { ...inbox.value, items: [] } } });
    }
    const live = await current(storage, { kind: LiveDoc.definition.kind, scope });
    if (live) {
      const { run, generation, tools, nestedTools, compactions, ...retained } = live.value;
      if (Object.keys(retained).length !== Object.keys(live.value).length) writes.push({ type: "document.change", id: live.record.id, content: { kind: "base", version: 1, value: retained } });
    }
  }
  // One atomic Pi storage commit, not one commit per page. On a crash, a normal
  // restart must see either the entire old work graph or no discarded work at all.
  if (writes.length) await storage.commit(writes, context);
  return { tasks, submissions };
}
