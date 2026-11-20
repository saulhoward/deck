# Read-only subagent navigation protocol

## Renderer bridge (v1)

- `TuiRequest.action = "subagent"` requires `text`: 1–64 ASCII characters, matching `[A-Za-z][A-Za-z0-9-]{0,63}`. It takes no other action fields. Lookup is globally case-insensitive, but authorization permits **only direct Pi-owned children of the selected parent**. Lookup uses persisted name claims, not the bounded sidebar. Historical name aliases remain usable.
- `TuiRequest.action = "parent"` takes no action fields. It is valid only while inspecting a child.
- A successful child snapshot has `kind: "subagent"`, `inspectParentChatId: <parent Pi ID>`, `chatId: <child Pi ID>`, and `draft: null`. `clientMode` remains `hub` or `task`; it never changes on navigation. `hubChatId` remains unchanged.
- `subagent` while inspecting resolves a sibling relative to `inspectParentChatId`, never a grandchild. `parent` returns to that ID and removes `inspectParentChatId`. Failed lookup/scope/response validation leaves selection unchanged.
- Allowed child actions: poll, older, latest, models (read-only), subagent, parent; hub mode may also explicitly select another chat. All mutation/creation/Rex actions are rejected before transport. A task client cannot use arbitrary select/tasks/hosts navigation.
- Pending saved parent input/import or uncertain writable-parent settings block entry. Child drafts are never listed or loaded. Returning revalidates parent status, including attachment worker/kind checks, then reads only parent drafts. Child views never sample the local Git workspace.
- The TS bridge now tracks `inspectParentChatId` for reply correlation. Its attached transport closes over an **immutable original parent chat ID**, not the changing renderer chat ID.

## Hub read command

Request envelope requires the explicit current `hubId` and `command: "subagent_view"`.

```json
{"chatId":"PARENT","name":"ds001","operation":"status"}
```

After resolution, reads use:

```json
{"chatId":"PARENT","childId":"CHILD","operation":"history","options":{"limit":80,"includeActivity":true,"includeAgentStatus":true,"includeSubagents":true,"includeProgress":true}}
```

`args` is closed. Exactly one of `name` or `childId` is required. `operation` is one of `status`, `history`, `activity`, `progress`, `model_settings`—there is no effect/mutation operation. `options` is optional and cannot contain `chatId`:

- history: existing validated `limit`, `before`, `after`, `includeActivity`, `includeAgentStatus`, `includeSubagents`, `includeProgress`, `includeInstructions`;
- activity: `includeAgentStatus`, `includeSubagents`;
- status/progress/model_settings: empty or omitted.

Reply result:

```json
{"hubId":"HUB","parentChatId":"PARENT","childId":"CHILD","name":"ds001","operation":"status","result":{}}
```

`name` is present iff requested and echoes the exact query; resolved-ID replies omit it. `result` is the existing operation-specific result, scoped to `CHILD`, not `PARENT`. Status is task-safe (no global activity inspection), and its binding must identify a subagent owned by the parent. Both egress and client ingress validate wrapper identity/operation/selector and the nested operation's existing semantic result contract. Responses remain under the 1 MiB transport cap; oversized subagent history receives the existing explicit reduce-page policy.

Every read request, including reads using an already resolved child ID, checks canonical Pi conversation ownership, the owning task's conversation, and coherent child/parent ChatDoc + AgentDoc bindings. Checks run before sampling and again before releasing its result. There are no `tx.doc` calls, creation, migration, scheduling, stop or settings mutations in this adapter. Tests compare complete SQLite table samples before/after successful reads and misses.

## Worker and attachment scope

The existing `taskCommand` equality guard (`args.chatId === scope.chatId`) is **unchanged**. The command is added to Rex and explicit attachment read allowlists; its `args.chatId` is always the original parent task. Existing allocation/block/worker/binding/startup guards still run. A revoked parent allocation revokes derived reads and return observations too. Ordinary commands with a child's chat ID remain forbidden. Attached launcher requests retain their parent outer scope and validate the nested command/reply twice. No general child-chat transport authority was added.

## Name contract

`AgentName` retains lowercase legacy/algorithm identifiers and adds canonical uppercase two-letter child IDs with positive, minimum-three-digit, non-wrapping decimal sequences (`HU001`, `DS010`, `WW999`, `WW1000`). Mixed-case display identifiers, `XX000`, and overpadded `XX0001` remain invalid. `AgentNameQuery` independently permits case-insensitive queries. The generator gained bounded string-only `anyOf` support (alongside existing nullable unions), with executable TS and Zig parity tests; generated Zig remains a nonnullable string alias.

## Regression coverage

Runtime tests cover durable naming and migration, case-folded lookup beyond the 16-child sidebar window, canonical ownership, mutation blocking, parent/sibling transitions, saved drafts/settings, failed-first-read rollback, revoked allocations and attachment guards. Native fixtures exercise wrapper/nested semantic parity and HTTP error correlation. Renderer and real PTY tests cover paired sidebar rows, rune-free identities, case-insensitive navigation, read-only child history, pagination, return, unsent prompts, resize and bounded overflow.
