# Model task creation and messaging

`deck.task-control` adds `task_create` and `task_message`. It is installed by default, separately from the read-only `deck.task-inspection` extension. Explicitly selecting inspection alone does not grant mutation. Both tools are currently model-callable only, not nested-tool APIs.

## Tool contracts

### `task_create {title}`

Creates one persistent **ownerless** task conversation without submitting input or starting generation. Title is nonblank and at most 200 characters. The task inherits the calling chat's saved machine ID/cwd, including an offline assignment; it never chooses another host or accepts a model-supplied binding. Its model/reasoning follow main's saved choices at creation, matching existing user-facing task creation. This is not a full copy of the caller's agent/instructions/extensions and does not settle full settings snapshot semantics.

The result contains `chatId`, stable internal `requestId`, `createdOrRecovered: true`, `started: false`, and `ownership: "ownerless"`. `started: false` describes this creation operation, not the task's current activity on a later replay. Existing creation receipts return the original task. Listing/searching before creating is still useful: a separate new tool call with the same title is intentionally a separate creation.

### `task_message {chatId, text, mode?}`

Admits a nonblank message of at most 8,192 characters to **another existing Deck task**. Rejects the calling chat, main, owned subagent chats, unmanaged/missing chats and unsupported modes. Default `followUp` uses Pi's FIFO follow-up policy; `steer` joins at a tool boundary. The target retains its saved model/host/cwd. Offline effects remain offline; messaging can still start central inference and never reassigns work.

The result contains `chatId`, `submissionId`, stable internal `requestId`, `mode`, `admitted: true`, and `completion: "not_waited"`. This acknowledges durable Pi admission only—not generation completion, effect success or delivery of an answer to the caller. Use inspection tools or select the task to observe its progress. There is no automatic result reporter or polling loop.

Messages carry immutable `origin: {kind: "task-tool", chatId, taskId}` metadata, included in the admission conflict hash. Target model input also has an explicit agent-origin header rather than silently impersonating a direct human request. Plain history labels these as `agent chat ID`, and model history projections expose the source chat. The original text is retained separately. This is local provenance/presentation, not remote authentication or a prompt-injection security boundary. HTTP/user drafts do not accept a caller-supplied origin field.

## Ownership, cancellation and retries

These operations are **not subagents**. Created tasks and target runs are independent/ownerless. Stopping or failing the caller does not delete a created task, withdraw an admitted target message, or cancel target effects. Stop the selected target explicitly if required. Automatic acknowledgements relayed between tasks are discouraged; there is no cycle detector or orchestration scheduler. The separate [foreground subagent](subagents.md) tool implements Pi ownership/cancellation links and waits for a child answer; use that contract when scoped delegation is intended.

Each tool derives its request identity from the globally stable Pi tool-task ID: `deck-tool:<taskId>:create` or `deck-tool:<taskId>:message`. Model-supplied tool-call IDs, titles and arbitrary retry counters are not identities. Creation uses Deck's existing atomic conversation/receipt commit; messaging uses the existing admission reservation plus idempotent Pi submission. No side database, lifecycle state machine or outbox is introduced. The public adapter still rejects conflicting arguments/settings drift and retrieves already-admitted receipts despite later auth failure.

Both tools declare replay safe because repeating the **same Pi task** finds the retained receipt/submission. This is process-crash deduplication, not exactly-once/power-loss or provider-call guarantees. A **new** tool call has a new Pi task ID and can create another task or admit the same text again. After an ambiguous interrupted result, inspect first; do not manufacture a fresh call as a purported safe retry.

Cancellation is checked before issuing and when entering the serialized mutation line. Admissions also check after credential admission guards and before Pi submit; creation checks before conversation creation. Work not yet committed can be prevented, including requests queued behind another admission. An issued commit may finish despite cancellation. Cancellation between reservation and submit can leave an unadmitted reservation, never a fabricated ACK. Committed independent work is not rolled back to simulate cancellation.

These model mutations do not use the client's draft cache. Their durable recovery owner is Pi's tool-task record and the existing Pi receipts. The single-user hub still has no per-chat ACLs: enabling task control authorizes the model to create tasks and send work to other tasks in this store. Keep separate trust domains in separate stores. Adding this default extension changes resolved selections and can trigger `settings_changed` for an older unadmitted reservation; see [settings](settings.md).

## Validation

Faux model tests use the actual Pi pipeline to create with an offline caller binding, message a target, receive admission without awaiting the target answer, and stop the still-running caller without cancelling target work. Invalid/self/main/unmanaged targets and invalid payloads produce tool errors without target admissions. Cancellation tests cover mutations queued behind a credential guard. Provenance is checked in canonical input, target model context, history projection and plain rendering.

Fault subprocesses stop **after** creation/admission commits but **before** the source tool result is saved, then receive SIGKILL. Reopening the same SQLite store replays the original Pi tool task, recovering the original task/submission ID without duplicate conversations or target inputs. The message case reopens with an unavailable admission guard and still retrieves the admitted receipt. Installed-package checks verify both tool definitions. All automated inference is faux; live model use of these new tools remains unverified.

For a manual scratch-store test, ask: “Use task_list to check for Task-control smoke. If absent, use task_create to create it. Use task_message to ask it to reply with TASK_CONTROL_OK. Report the chat ID and admission receipt, not a claim that it has finished.” Then select that ID and verify one agent-labeled input and the eventual answer. Do not blindly repeat a creation/message call if its outcome is ambiguous. To test ownership, send a foreground sleep to a target, stop the caller while the target runs, and explicitly stop the target afterward.
