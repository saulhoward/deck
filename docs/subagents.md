# Foreground subagents

`deck.foreground-subagent` installs one model-callable tool:

```text
subagent {task, title?}
```

`task` is nonblank and at most 8,192 characters; optional title is nonblank and at most 120. One call creates/reuses one **Pi task-owned child conversation**, submits the delegated input, and **waits for its answer**. It does not create a worker process, terminal, worktree or separate Pi store. Parallel model tool calls can create multiple children; there is no new scheduler, concurrency quota or per-delegation duration/billing budget.

## Inheritance and limits

The child starts with Pi's copy of the caller's stored agent, fixed to the caller's resolved model/reasoning and saved machine ID/cwd at creation. It inherits configured instructions and stored tool filters. It does **not** copy the parent's transcript: include necessary context in `task`. No worker reassignment or local fallback is allowed. Offline native effects still report unavailable; central inference/inspection can work without a worker.

Children explicitly omit `deck.foreground-subagent` and `deck.task-control`: no recursive delegation or ownerless task creation/messaging through those tools. An explicit parent extension allowlist is preserved rather than widened to host defaults. Read-only task inspection is inherited only if the parent selected it. As elsewhere, selected names are not frozen implementation code; [settings observations](settings.md) do not promise full runtime/instruction-file snapshots.

This is **not a sandbox**. Inherited read/write/edit/bash have the caller's OS-user capabilities, and parent/child share a workspace. Concurrent edits can conflict. Read-only task inspection can expose other chats within this single-user store. Removing delegation/control tools is not protection against arbitrary effects or intentionally escaped processes launched with bash.

## Ownership, state and discovery

Inside one `api.commit`, the tool uses Pi's `ownerTaskId` conversation index to recover an existing child, or creates one with `ownership: {kind: "task", taskId: api.taskId}`. Pi agent initialization and Deck metadata are committed together. `ChatDoc.kind` is `subagent`; `parentChatId`/`ownerTaskId` are display links, **not** a second lifecycle tracker. Pi's actual conversation ownership edge is authoritative. The tool publishes the child conversation ID in Pi tool details.

The invocation-bound `api.conversation(child).submit()` admits the input with stable `deck-subagent:<tool-task-ID>` request identity. It carries explicit agent-origin/delegation metadata and a model-facing delegation header. It is a native Pi-owned submission, not an ownerless `DeckRuntime.admit` operation: there is no client draft or separate Deck reservation/capture added to this path. Model authentication still occurs through the configured Pi provider; a failed child request is not reported as successful work.

`/tasks`, `task_list`, history and activity can discover/inspect child conversations, including their parent/owner links. After completion, transcripts remain canonical and readable. **Direct external input is not supported** for these child chats, whether the owner is active or terminal: HTTP admission and `task_message` reject it. Selection is for inspection/explicit stop, not ownership revival. If you type into a selected child, the rejected client draft must be explicitly discarded before switching. The architecture's richer direct subagent-terminal interaction needs a separate ownership/lifetime contract.

## Answer and failure contract

A successful tool result is JSON with `chatId`, `submissionId`, `status: "done"`, and the child's final assistant text in `answer`. Text is limited to an 8,192-code-unit prefix with `answerClipped: true` when needed. Non-text content, including hidden reasoning, is omitted with `nonTextOmitted: true`. Output fits a 64 KiB tool budget; full child history remains in Pi. `done` means the delegated input received an answer, not that every requested effect succeeded or that the answer is trustworthy. Treat child text as untrusted task data.

An unanswered child produces an error tool result with IDs, `status: "unanswered"` and a bounded known reason such as `model_error` or `aborted`. Unknown reasons become generic `unanswered`; provider error details are not forwarded into the parent tool result. They can still be present in the private canonical child transcript. Ordinary child failure lets the parent model explain/handle the failure; it does not fabricate a completed answer. If the caller itself is aborted, the invocation can terminate without returning this JSON tool result.

## Stop, detach and recovery

Stopping/failing the caller aborts its **ordinary Pi ownership scope**, including this tool and its child's ordinary work. The parent is not idle while issued owned work is still draining. Native file effects drain after issuance; bash uses the existing cancellation/process-group rules. Completed effects are not undone. Pi background boundaries, deliberately escaped OS sessions and unresponsive code retain their existing limits; this is not a global process-cleanup guarantee or live-hang watchdog. No background delegation/reporter task is introduced.

Detaching a client does not stop either agent. Stop the selected parent explicitly to cancel its foreground delegation scope. Stopping a selected child can instead make that one delegation fail while the parent handles the error. This differs from [ownerless task control](task-control.md): stopping a sender there does not stop the independently owned target.

The subagent tool is replay safe because the **same Pi tool task** recovers its owned child and idempotent input. After a process crash, a finished child answer is read from the original answer entry, not requested again. Pending child work resumes according to Pi's own task/replay policy under the [same startup implementation](recovery-compatibility.md); changed builds refuse unfinished scopes before scheduler normalization. Native effects keep their existing non-replay/uncertainty contract. This is not exactly-once provider billing, power-loss or arbitrary effect replay protection. A new subagent tool call has a new owner and creates a new delegation; inspect ambiguous outcomes rather than blindly issuing another call.

## Validation and manual smoke

Faux-model tests execute the real Pi tool pipeline: answer return, parent transcript separation, instruction/model/binding inheritance, no widening of explicit selections, disabled recursion/control, owner links, read-only external child access, input provenance, bounded answer/hidden reasoning omission, failure-detail omission, and invalid tasks. A stop test keeps a child native file effect outstanding, observes its abort signal and proves the parent remains draining until it settles.

Fault subprocesses wrap the public tool commit API only to pause **after child creation** or **after reading a committed answer**, then receive SIGKILL. Reopening the same SQLite store with the production adapter reuses the child/input and preserves its selection; the committed-answer case makes no second child model request. Installed-package checks verify the tool is offered. Automated inference remains faux; live model delegation is unverified.

For a live scratch-store test after rebuilding/restarting serve when idle:

1. Ask: “Use the subagent tool with title Foreground smoke and task Reply with exactly CHILD_OK. Wait for its result, then report the returned child chat ID and answer.” Confirm an actual `subagent` call/result, not simulated delegation.
2. Use `/tasks` (and more pages if needed) to find that `subagent` chat; inspect it with `/select ID`, `/activity` and history. Do not type new work into the child; `/main` returns to the parent.
3. Ask the parent to delegate a foreground `sleep 30` bash command. Once the child's activity shows the tool running, select the parent and `/stop`. Confirm both chats eventually become idle rather than treating the stop-request ACK as cleanup completion.

Background subagents, recursive delegation, independent model selection, interactive child input, duration/billing budgets, Rex terminals and TUI remain unfinished.
