# Allocation-bound Rex client startup (internal)

The [internal allocator](rex-allocation.md) now records a **historical client startup observation** in Pi. A successful Rex creation is still not a ready/live terminal, and a startup observation is not a heartbeat, lease, delivery receipt or proof of current selection/health. Public allocation, reopen/replacement and uncertain-create adoption remain unavailable.

## Three pieces of evidence

1. **Intent before effects.** Admission generates an allocation UUID once and saves it in the Pi task input and optional `RexDoc.allocationId`, atomically with the allocation task/request identity. Same-ID retries retrieve the original task/UUID. It is a correlation identifier, not a provider credential or authentication secret.
2. **Native creation result.** The saved-worker operation retains full server/host/instance/session/window/block IDs. The bounded native launch argv appends `--rex-allocation UUID` to the ordinary hub-pinned Deck client. The native result echoes that UUID and Pi checks it before applying. The existing binding and immutable task result remain creation provenance with `readiness:"not_checked"`.
3. **Client startup.** Only an opted-in client reads the full native `REX_BLOCK` supplied by Rex. There is no caller-specified block option or label/process-name lookup. The client requires explicit `--hub-id` and `--task`, rejects login/one-shot input, verifies the initial hub guard, startup capability and selected chat, reads saved drafts and initial canonical history, then registers before consuming interactive input. Missing/short block IDs, old/wrong hubs, failed history, refused/malformed/lost ACKs fail startup without submitting input. No automatic retry, replacement or inference is attempted.

The worker passes literal argv, never a shell-expanded `$REX_BLOCK`. Rex supplies the native block environment to the actual child. Hub provider credentials are not forwarded; the UUID is not an authentication mechanism in this trusted single-user system.

## Internal observation command

Updated `status` advertises `rexStartup:1`. `rex_startup` requires an explicit matching top-level `hubId` plus exactly:

```json
{"chatId":"CHAT_ID","allocationId":"UUID","blockId":"block:UUID"}
```

The existing HTTP/IPC bounds and Host/Origin rules still apply. This is a narrow observation command, **not** an allocation/adoption command or a model tool. Its stable identity already exists in Pi and the native launch argv, so it needs no new local draft or durable replay queue. A transport correlation ID is not that identity.

One serialized Pi commit checks the allocation task's kind/conversation and exact UUID/hub/chat, authoritative ownerless task ownership, and saved worker/cwd against the launch input/current agent binding. It records only `RexDoc.startup:{blockId}`. A duplicate identical observation is idempotent; another block or an existing binding mismatch conflicts and cannot overwrite evidence. Changed binding/ownership refuses without recording. Registration does not create/run/stop a task, alter instructions, submit model input or contact Rex. Authentication/model capability drift does not turn it into inference.

A valid ACK echoes the chat, allocation, block and task identities, `registered:true`, and the bounded snapshot below. A client accepts only `unbound`/`matched` ACKs with the exact identities, version and historical/not-checked markers. It then enters the ordinary line editor. Input remains paused/bounded by the existing OS transport while startup waits, rather than accumulating an application replay buffer.

## Order-independent join, not a lifecycle catalog

`terminalStartup(chatId)` reads Pi metadata without Rex I/O and returns:

- `version:1`, `chatId`, optional allocation `taskId`;
- `historical:true`, `live:"not_checked"`;
- `observation:"not_observed" | "unbound" | "matched" | "conflict"`.

`not_observed` is absence of a saved startup claim, **not** proof the client did not start. `unbound` means a correlated startup was saved but no trustworthy native binding has been applied. `matched` joins the observed native block with the independently retained binding. `conflict` means an early observation and later native evidence disagree. Native creation truth is not discarded or rewritten by an early conflicting observation. Neither registration nor the projection promotes an uncertain native operation to success.

Registration can precede native-result retention/apply. The intent is already committed, so its observation is saved independently; atomic native binding/result apply later makes the projection `matched`. If native creation is uncertain, the observation stays `unbound`, the original Pi result stays uncertain and fresh-ID creation is still forbidden. A late observation after stop can diagnose a surviving client but never revives the aborted task or claims creation was undone. There is no reset/reconciliation/replacement API yet.

No heartbeat timer, client lifecycle table, output log, transcript mirror or second scheduler is added. Exiting, changing selection, disconnecting, destroying a Rex session, or restoring an old backup does not erase/reinterpret this historical event. A `matched` observation can remain after the client exits. Current readiness/health and exact-object reconciliation need separate authoritative inspection, not an age heuristic or a reused label.

## Recovery and compatibility

The optional metadata/launch fields preserve old settled bindings/receipts; legacy allocations lack the UUID and cannot register retrospectively. Old ordinary clients still work; a new opted-in client fails closed against a hub missing `rexStartup:1`. Changed-code recovery of unfinished work still requires the original immutable implementation. No force-resume/migration is introduced.

SIGKILL after the startup commit but before native apply/client ACK preserves the observation. Original-task recovery reuses the retained native result, joins the same block, and does not call Rex again. Lost ACK can leave a saved historical observation even though the client failed startup. Backup preserves this Pi metadata, not the client/Rex objects; divergent source/restored clones sharing identity remain unsupported.

## Validation

Pi/faux tests cover registration before/after bind, idempotence, no new tasks/history/inference, wrong/absent/legacy intent, conflicting blocks, raw worker/cwd drift, authoritative ownership, uncertainty and post-stop observations. Wire tests enforce hub pinning and exact argument scope. Spawned-client tests cover capability/chat/history/identity checks, paused input until valid ACK, refused/malformed/lost ACKs and no input/draft submission on failure. Native recovery adds a SIGKILL window after the observation commit and before binding/apply.

The explicit opt-in installed Rex test forces a real client registration to arrive **before** native-result apply, observes `unbound` then `matched`, verifies the retained full-ID binding with no inference/duplicate creation, exits the client, and confirms the snapshot remains historical with `live:"not_checked"`. This uses only the isolated private Unix server/central Pi-faux hub and the observed aarch64-darwin Rex API 8 version. No live provider, user sessions, remote worker, GUI or server-restoration claim is made.
