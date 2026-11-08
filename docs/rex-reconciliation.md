# Explicit Rex creation-provenance reconciliation (internal)

`DeckRuntime.reconcileTerminal(chatId, requestId, signal?, expectedBinding?)` now admits a Pi-owned administrative task that can recover a **previously unbound creation binding from an exact retained native success**. It never creates, runs, replaces, closes, discovers or adopts Rex objects. There is no public hub/model/client command, automatic allocation retry or new reconciliation admission on reconnect. Pi recovery may resume the same already-admitted read, as described below.

This is deliberately narrower than complete uncertain-create reconciliation or reopen. Without independently trustworthy creation evidence, the original attempt stays unresolved and pinned. In particular, a matching startup claim, label, process name, sole live-list match or running process cannot establish creation provenance.

## Saved intent and authority

Admission is serialized with other Deck mutations. It commits the stable request receipt, original allocation task ID, original saved worker/cwd, exact reconstructed native request bytes and the new conversation-owned `deck.rex-reconciliation` task before reading the worker. The returned task ID means **admitted**, not reconciled or healthy.

- Only the original managed ownerless task with coherent saved worker/cwd is eligible.
- The original allocation task must be settled and match this chat/hub/allocation UUID. Main, owned/unmanaged chats, absent/mismatched intent and host/cwd drift refuse.
- A known full binding refuses a new reconciliation request; use [fresh inspection](rex-inspection.md), not a repair that overwrites it.
- One reconciliation may be unfinished per chat. Other chats/admissions continue while worker I/O runs. Configuration stays busy while the administrative task is unfinished.
- Identical request IDs return the original reconciliation task before later coherence/capability checks. An altered original expected binding conflicts. The optional signal is an admission guard; after admission, normal Pi conversation stop owns cancellation.

`RexDoc.taskId` remains the **original allocation task**. Its optional `reconciliationTaskId` points to the current reconciliation intent/result; when repair succeeds it supplies the separate provenance link for that binding. Prior attempts/results remain canonical Pi tasks, not another lifecycle catalog. No receipt or original outcome is rewritten, even if that original outcome says uncertain or aborted.

## Read-only native receipt boundary

The new private native operation `rex_allocation_receipt` bypasses acceptance/result publication. It reads the original allocation receipt, not a Rex server. Its lookup correlation ID is the reconciliation Pi task ID, separate from the original effect ID. It never executes the embedded request and never stores a native receipt for the lookup.

Generated JSON Schema contracts define the lookup query, SHA-256/state, and reply. The opaque embedded request must decode as exactly `rex_allocate` for the original positive safe-integer task ID, assigned machine and saved absolute cwd, with a valid original plan. Other operations, target/path tricks, changed version/ID/host/cwd, malformed or oversized inputs refuse without effect dispatch.

The worker computes SHA-256 over those **exact original request bytes**, opens only `worker/operations/<original-id>.json` on its existing private journal, and requires a hash match. This establishes request equality, not worker authentication, tamper-proof storage or cryptographic attestation; the private native journal remains trusted local state. Reads use no-follow/nonblocking open, regular-file checks and the existing 1 MiB receipt bound. Queries allow at most 128 KiB of embedded request bytes (256 KiB encoded query); the whitelisted reply is at most 16 KiB. A symlink, nonregular/oversized/malformed/unreadable receipt is inconclusive. File reads drain like other native reads; there is no subprocess, Rex CLI call, progress stream, daemon startup, credential forwarding or host fallback.

Only retained `ok:true`, `code:"allocated"`, lossless/untruncated, schema-valid creation output is positive proof. Native projection strips creation extensions and all private errors. TypeScript validates the reply, operation ID, exact expected request hash, state/creation consistency and every original plan identity, including the new allocation UUID when present. The binding's task ID is the **original native allocation ID**, not the reconciliation ID.

The original request is reconstructed from the immutable Pi input using the existing native envelope serialization. That is not a canonical-JSON migration or a lossless typed-record round trip. If historical encoding differs and the original hash cannot be reproduced, the result stays conflict/unresolved; never rewrite the receipt, guess alternate encodings or dispatch the old request to find out. Original receipt bytes remain untouched.

## Atomic apply and results

The task rechecks original allocation intent, current reconciliation pointer, absent binding and ownerless saved-worker authority before I/O and again in the invocation-bound apply commit. Apply atomically saves the full historical creation binding and completed reconciliation result. An intervening competing intent/binding or settings drift refuses apply. Stop drains an issued read and prevents its late result from applying; it does not undo the original external allocation.

Results:

- `reconciled`: full binding plus `{source:"native_retained_creation", operationId, requestHash}` proof. This is **creation provenance only**, with `readiness:"not_checked"`.
- `unresolved`: bounded reason `missing`, `accepted`, `not_allocated`, `conflict`, `inconclusive`, `unavailable` or `authority_changed`. No binding is applied.
- `aborted`: this administrative invocation settled after stop; its late evidence cannot repair the binding.

A missing receipt means **missing evidence**, not no external effect. Acceptance-only remains uncertain. Even a retained known pre-create refusal does not reset the one-allocation-attempt restriction. A later **explicit new reconciliation request** can repeat this read after the previous reconciliation settles; it cannot reissue allocation. Same-ID retrieval never starts another reconciliation.

Fresh inspection accepts either the original completed allocated result or the exact separately linked successful reconciliation proof. It checks the original intent and saved scope in either case. Clearing/corrupting the proof link makes inspection conflict, not discover or adopt another object.

Historical startup is not changed by repair: a matching saved native-block claim becomes `matched` when strong creation evidence supplies its binding; a conflicting claim remains diagnostic conflict. A stopped original allocation task stays stopped/aborted. No input, model generation, owned child, conversation or terminal is started or revived. Repair remains useful if the original Rex objects have since exited/disappeared, because it recovers historical identity, **not current existence**. Inspect separately.

## Recovery and evidence

Pi resumes the same admitted reconciliation task after crash, under the normal implementation-compatibility gate. Before apply, rereading the native receipt is safe and creates no effect/read receipt. After apply, same-ID recovery returns the settled result without a native call. There is no secondary recovery queue.

Automated coverage includes:

- exact retained proof, original uncertain **and aborted** outcomes, preserved startup/history, same-ID retrieval/conflict, no fresh-ID allocation reset and separate fresh inspection;
- missing/acceptance-only/refused/conflicting/malformed/private/oversized evidence, wrong scope/hash, offline worker and symlink refusal;
- competing requests, independent admissions, configuration busy, authority drift across I/O, cancellation/draining and broken proof links;
- actual native receipts produced by the allocator, rejected embedded mutation/ID/host/cwd/version requests, unchanged journal bytes/inventory and no extra Rex calls;
- SIGKILL after admission, after receipt read/before apply and after apply. Recovery uses the same Pi task, preserves the original uncertain outcome and issues only the original single creation.

The explicit opt-in [installed Rex API 8 contract](rex-contract.md) now drops a real production allocation reply after native success/client startup, verifies the unbound uncertain state, explicitly reconciles the exact native receipt, then inspects the same running/exited/missing-terminal/missing-session identities. No new terminal/input/inference or read receipt appears; original task outcome and historical startup remain distinct. This evidence is isolated aarch64-darwin only, not live-provider, operator sessions, remote, GUI or server-restoration support.

## Replacement remains a separate boundary

The installed API 8 `session.new_window` advertises only `session_id`, `window_label`, `layout`, `focus` and rejects additional properties. Neither it nor `session.create` advertises an idempotency key or expected revision/process-state guard; `block.close` also lacks such a guard. The isolated metadata check is evidence about these advertised methods, **not proof that arbitrary inspect-then-create is atomic** or that no future safe mechanism is possible.

Consequently this slice does **not** add a replacement API or allow replacement from a sampled exit/missing result. A supported identity-bound/conditional mutation strategy and explicit race/uncertain-replacement contract still need implementation before relaxing allocation attempts. Preserve original provenance and unknown replacement effects; observing an old client running can never clear an unknown replacement. Public save-before-send allocation/open/reopen, session recreation and remote/TUI work remain separate.
