# Explicit project-instruction import

**Implemented through the plain client and hub API; not a model tool or automatic discovery.** `DeckRuntime.importInstructions(chatId, requestId, signal?)` admits a Pi administrative task that reads `AGENTS.md` through the saved native worker and replaces that conversation's explicitly configured instructions. It does not submit model input or run inference. This follows the [Pi contract proof](instruction-capture.md); automatic discovery and per-input settings bundles remain unsupported.

## Plain client

In `deck agent --no-tui`:

```text
/instructions                 # read current source + latest import task; no reload
/instructions load            # explicitly replace instructions from saved-worker AGENTS.md
/instructions TASK_ID         # read a particular import receipt in this chat
```

Loading replaces explicitly configured instruction text; it is not append/merge and is allowed only when the selected chat is idle. It does not traverse directories, accept a different filename or run inference. `--message` always submits model text: do not use it to invoke these slash commands. There is no startup loading flag.

Before sending, the client saves a private `instructions` draft with the original chat, UUID and full saved host/cwd. `/retry` resends those exact arguments. Recovery never automatically sends; failed saves block initial send/retry, malformed ACKs or local cleanup failures preserve the draft, and discard does not cancel or undo a possibly admitted import. An unadmitted binding mismatch returns `settings_changed`; restore the original binding or explicitly discard and begin a new request. Conflicting binding arguments for an already-admitted ID return `conflict`. See [draft recovery](client-drafts.md).

A valid admission ACK prints the Pi task ID and **“Application not yet confirmed.”** The draft is then removed, not kept as a result/execution queue. A read-only result query and recent polling show the canonical task state/result; detach never stops it. On reconnect, `/instructions` discovers the latest import without a local completion cache. Use the printed task ID for an older receipt if another client has since imported. `/stop` requests cancellation of selected work; wait for the import task to settle.

The internal adapter still requires exclusive store ownership. Never open another adapter against a running hub to invoke it; public commands go through that hub.

## Admission and authority

- The target must be a managed ownerless main/task chat with coherent saved machine/cwd and a native worker adapter. Owned subagents reject external imports. Independent task creation does not automatically inherit these instructions; foreground children inherit the parent's stored instructions and source provenance.
- Admission serializes with ordinary Deck admission/configuration. One Pi commit checks canonical pending/running/waiting/sleeping/completing tasks and `InboxDoc`, then creates a conversation-owned `deck.import-instructions` task and an identity receipt in `deck.instruction-request`. Parked/background/draining work counts. No second queue or execution tracker exists.
- `requestId` is required, nonempty and at most 200 code units, scoped to the target chat. The source path is fixed, so replay has no mutable path arguments. The returned Pi task ID acknowledges administrative task admission, **not** successful application. Reuse it via the same request ID; inspect/wait through Pi for its result.
- While the import is unfinished, new unadmitted model input and configuration/import attempts for that chat reject with `busy`. The check happens before resolving agent choices, preventing an apply/observation race. Existing admitted receipts and the original import receipt remain retrievable. Unrelated chats can continue.
- Waiting for worker I/O does not hold Deck's mutation line. Pi owns scheduling, cancellation and recovery. Selected-chat generation/activity is not an administrative-task completion receipt; use the import task result, not a missing preview or generation slot.

## Exact content boundary

The task requests exactly `{operation:"read", args:{path:"AGENTS.md"}}` at its saved worker/cwd, with the **Pi task ID** as the native operation ID. There is no hub filesystem fallback, parent-directory search, global/include discovery or dynamic prompt hook. Standard native read semantics apply, including following symlinks; the cwd is not a sandbox, and the recorded path is the requested pathname, not an attested inode/realpath.

Accepted instructions are the exact returned UTF-8 text, at most **32 KiB encoded bytes**, with no NUL, lossy surrogate conversion or truncation. Empty text is allowed and explicitly replaces instructions with an empty string. No trimming, automatic append or merging takes place. The worker's underlying bounded regular-file read still has its existing 128 KiB limit.

**Administrative admission does not fix file bytes.** If the process dies before issuing the read, the first issued read on recovery can observe newer workspace text. Once the worker has retained the result, recovery repeats the identical request/operation ID and obtains those retained bytes, not the current file. Accepted-but-unfinished receipts yield `effect_uncertain` and do not cause a new read or application. This fixes returned bytes, not an atomic worktree revision under concurrent file edits.

After reading, one Pi task commit:

1. Rechecks saved binding/cwd, the previous instruction hash and absence of other unfinished tasks/inbox. The importer can exclude only its own task from the idle check; unsupported raw Harness mutations can cause refusal rather than overwrite.
2. Applies the exact text using public Pi `configure(tx, ...)`, leaving other agent choices unchanged.
3. Records `deck.instruction-source` provenance `{machineId,cwd,path,sha256,bytes,taskId}` and the task's terminal result atomically with those instructions.

A crash after that commit returns the original terminal task without another native read. File edits have no effect until a new explicit idle import with a new request ID. Manual adapter configuration of instructions clears the current source label, even for an identical string; other setting changes retain it. Source history is rewindable alongside the agent, and each import's terminal Pi result retains its own source metadata. `instructionSource(chatId)` is an advisory read that checks the source hash against currently resolved instructions; it is not execution authority or a cross-document atomic status snapshot.

## Results and stop

Normal Pi-completed task results are one of:

- `{status:"applied",source:{...}}`;
- `{status:"rejected",reason}` with bounded reason `offline`, `unavailable`, `read_failed`, `effect_uncertain`, `invalid`, `too_large`, `settings_changed` or `busy`;
- `{status:"aborted"}`.

`rejected` is an unsuccessful import, not successful configuration. Read errors never become instructions or leak worker error text in this result. An unexpected Pi/store failure can still produce a failed/parked task or close the writer; inspect the canonical task rather than assuming every admission reaches a normal result. There is no automatic retry loop.

Conversation stop aborts the task. An issued read drains before the task releases its authority, and its result cannot subsequently be applied. Pi's invocation-bound commit checks close the abort/apply race. Stop does not undo an import already atomically applied. A new request ID is a new explicit import, including after a rejected/aborted operation; replaying the old ID retrieves the old result rather than refreshing the file.

Instructions are potentially sensitive workspace text stored in Pi and native read receipts, and included in normal state backups. Hashes are neither anonymity nor encryption. The [startup compatibility gate](recovery-compatibility.md), original-build retention and [backup rollback hazards](backup-restore.md) still apply.

## Public status contract

`import_instructions {chatId,requestId,machineId,cwd}` requires the original full saved binding and returns `{chatId,requestId,taskId,admitted:true,completion:"not_waited"}`. These are the only arguments; the path is fixed. The client validates all receipt identities/flags before removing its draft.

`instruction_status {chatId?,taskId?}` defaults to main/latest, returns a version-1 `{chatId,source,import}` snapshot and performs no import or document creation. Explicit task IDs must belong to that chat and have the import task kind. `source` is current imported provenance, or null when absent/unmatched. The selected `import` is a canonical task record projection, or null: task ID, Pi state, optional abort mark, terminal outcome and bounded normal result. No task inputs/checkpoints/memos, instruction contents or error payloads are exposed. Source host/cwd labels are clipped to 80/256 code units with `labelsClipped:true`; IDs/hashes remain complete. Do not route work using clipped display labels.

The arguments, snapshot and nested source/task/result variants now use [generated closed live-view contracts](live-view-contracts.md) at private egress, native forwarding and client ingress. Explicit chat/task echoes, safe IDs, UTF-16 caps and state/result consistency are checked before rendering; malformed wire samples are rejected rather than sanitized into valid observations. Domain projection still whitelists private stored fields and marks invalid provenance/results omitted, without rewriting records. Label clipping now avoids splitting surrogate pairs.

The plain client samples this on recent history polls (`includeInstructions:true`), validates it again and prints changed complete JSON snapshots with JSON-escaped labels. It holds one bounded fingerprint, resets it on selection and ignores stale responses. Optional snapshots are omitted if they would overflow otherwise fitting canonical history. Missing samples, outages and activity/preview clearing do not establish completion. `/instructions` explicitly refreshes even an empty state.

**Current source and an import receipt are different facts.** An older task's `applied` result remains true after a newer import or manual instruction update; it does not prove that its text is still current. A null source does not prove that all agent instructions are empty. Invalid/unsupported source or completed-result projections are marked omitted rather than claiming application. Snapshot fields are sampled separately, not an atomic cross-document revision or event log.

## Validation and remaining work

`runtime/src/instruction-import.test.ts` covers actual model prompt use, child provenance, independent-task scope, receipt recovery after idle auth/capability changes, blocked admission before settings resolution, unrelated work, stop/drain, active/parked/background checks, binding/instruction drift, cancellation and failure/byte boundaries.

`runtime/src/instruction-import-native.test.ts` uses real Zig pipes/receipts, SIGKILL at pre-read, retained-read and post-apply windows, original task identity, changed workspace files, native missing/non-UTF8/oversized/offline/uncertain reads and no fallback/inference. The installed package smoke imports through its packaged native adapter before backing up/restoring the store, then performs another import through the packaged plain client/HTTP bridge and verifies the new hash and empty draft cache.

`instructions-wire.test.ts` covers ACK/result separation, binding drift/conflicts, scoped/read-only projection, privacy, display validation/bounds and history-frame fallback. `instructions-client.test.ts` SIGKILLs a client after real Pi application but before ACK, then changes port/advertised defaults and verifies same-task/no-reread recovery. It also covers malformed ACKs, cleanup/save failures, pending-not-applied rendering, discard without mutation and detach without stop. Native HTTP tests exercise the actual plain client/IPC/Zig read without inference.

No external provider calls are involved; manual live-provider validation remains pending. Automatic discovery, general provider/settings configuration, file precedence and per-input bundles remain separate work.
