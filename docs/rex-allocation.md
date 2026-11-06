# Internal Rex allocation foundation

**Internal operator API, not a public terminal integration.** `DeckRuntime.allocateTerminal(...)` now creates a Pi-owned administrative task which calls the assigned native Zig worker and commits a full Rex binding. No hub allocation command, model tool, default Rex server, public draft kind, open/reopen/replacement command or GUI attachment is shipped. A narrow [allocation-bound client startup observation](rex-startup.md) is now implemented; it is historical evidence, not current health. Use the [installed Rex contract](rex-contract.md) for the tested CLI/version and opt-in isolation rules.

## Identity and authority

The trusted embedding must supply an explicit local target: absolute Rex executable, `unix:///ABSOLUTE_SOCKET` URI, expected Rex `host_id` and `instance_id` UUIDs, absolute Deck client and hub port. The hub/chat identity, saved Deck machine/cwd and deterministic display label are captured centrally. URI socket paths are bounded to 100 UTF-8 bytes; TCP, host aliases, query/fragment/percent-encoded locators and ambient/focused targets are not supported. External Rex executable contents are not frozen or attested by the implementation fingerprint.

Only managed **ownerless task chats** are admitted. Main, unmanaged and Pi-owned child conversations refuse; misleading `ChatDoc` metadata cannot override Pi ownership. No new conversation, inference, model input or worker-local Pi runtime is created by allocation. Normal central work need not finish before allocation; ordinary configuration still refuses while its administrative task is unfinished. Native I/O does not hold Deck's admission serializer.

Before any CLI call, one Pi commit records:

- the stable per-chat request identity/hash and administrative `deck.rex-allocation` task;
- exact launch inputs, including worker/cwd, server identities, client path, port and hub/chat IDs;
- the chat's sole allocation-attempt task ID and a generated-once allocation UUID in `RexDoc`/task input, used for client startup correlation.

The returned task ID means **admitted, not allocated or ready**. Identical retries retrieve it, including after settlement or later settings changes; changed launch arguments/original expected binding conflict. Missing native capability is refused before admission. There is currently **one attempt per chat**, even after definite failure, stop or uncertainty. A fresh request ID cannot reset it. This conservative internal restriction avoids creating duplicates while reconciliation/replacement is absent; it is not a finished user recovery experience.

Pi owns scheduling, recovery, stop and results. `RexDoc` is ordinary Pi conversation metadata, not another lifecycle database. `RexRequest` holds identity only. Forks do not inherit these allocation metadata/receipts. Native receipts reuse `worker/operations/<Pi-task-ID>.json`; there is no Rex replay queue or session catalog.

## Native effect boundary

`rex_allocate` is a private native operation, not arbitrary model CLI execution. The worker checks saved machine/cwd and retains the same request-hash/accepted/result receipt used by native file/bash effects. The requested Deck client must resolve to the worker's own executable, or its public `deck` wrapper when the native entry is `.deck-wrapped`. This preserves private packaged Node/runtime paths without giving the caller arbitrary terminal argv.

All CLI calls use direct argv, explicit `--server`, `--autostart=false`, and Rex's two-second timeout. The shared native owned-process runner enforces a four-second wall limit per call, TERM/KILL cancellation, continuously drained combined 64 KiB output and a maximum of four concurrent process slots **shared with bash**. Raw CLI output must be lossless, untruncated UTF-8 and exit zero. No sampled bash preview is published for allocation. The CLI environment is allowlisted (`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`), excluding hub credentials, Rex focus/routing, Deck overrides and Node/loader injection. This does not isolate filesystem credentials or sanitize an independently running Rex daemon's environment. The terminal inherits Rex's environment, not the hub's credential environment.

The worker first queries `server status --json`, requiring API revision 8 and matching endpoint/host/instance. It then issues one creation:

```text
new LABEL --json --cwd SAVED_CWD --shell=none --keep-open -- \
  DECK_CLIENT agent --no-tui --port PORT --task CHAT_ID --hub-id HUB_ID \
    --rex-allocation ALLOCATION_UUID
```

Creation must return one full `session:UUID`, one `window:UUID`, and one `block:UUID`. Explicit `block ls --session FULL_ID --json --short=false` verifies the block's window, local Rex host and shell flavor. A second status query verifies the server identity again. No labels, process display, focused targets, `rex send`, daemon startup or host fallback establish provenance.

Only then does the native worker retain a bounded, whitelisted creation result. An invocation-bound Pi commit rechecks saved chat/worker/cwd and allocation identity, then atomically saves `RexDoc.binding` and terminal task result. The binding contains full server/host/instance/session/window/block IDs, Pi hub/chat/task identity, saved machine/cwd and `readiness:"not_checked"`. Exact launch inputs remain in the Pi task. `terminalBinding()` reads this creation provenance without Rex I/O; it does **not** assert that objects or processes still exist.

## Outcomes, cancellation and recovery

- `allocated`: native creation evidence was retained and atomically bound in Pi. **Not client readiness**, current health or successful inference.
- `not_allocated`: a known pre-create refusal (`invalid`, `offline`, `unavailable`, `cancelled`). No retry/reset UI yet.
- `uncertain`: an accepted native receipt lacks a result; creation/verification failed after issuing `new`; a result is malformed, scoped incorrectly or conflicts; the transport failed; or authority drift prevents applying a possibly earlier effect. CLI stderr/private errors are not copied into Pi outcomes.
- `aborted`: Pi stop settled the invocation without applying a binding. It does **not** mean Rex creation was prevented or undone. Issued CLI work drains/cancels through the native control channel; Rex may already have accepted creation on its independent connection. No automatic session destruction occurs.

Before the first native acceptance, recovery may issue the first creation. An accepted operation without a trustworthy result stays uncertain and is **never reissued**. A retained successful creation repairs a crash before Pi apply without calling Rex again; an already-committed binding/result needs no native call. Stop and raw authority drift cannot fabricate a successful binding. All attempt identities remain pinned, including uncertainty/abort, so repeated old IDs or newly generated IDs cannot silently create replacement sessions. Missing label/session/process observations never authorize adoption or recreation.

Ordinary clients now pin the hub ID learned at startup in subsequent command envelopes; updated hubs reject a mismatched top-level `hubId` before dispatch. The internal `--hub-id` launch option also requires a matching initial identity and advertised `hubGuard:1`, failing closed against an old/incorrect hub before input. This prevents accidental port reuse from redirecting an existing client; it is **not authentication** and cannot distinguish divergent source/restored clones that improperly share an identity. Legacy clients/envelopes remain accepted, and old hubs do not implement this guard.

## Evidence and next boundary

Automated Pi/faux tests cover admission/deduplication/conflicts, ownership/cwd/capability checks, no inference, bounded/private result projection, uncertainty, raw drift and cancellation. Native fixtures exercise explicit argv/server scope, credential exclusion, host/server mismatch, malformed/flooded output, accepted-unsettled receipts, owned-process cancellation alongside independent file I/O, and SIGKILL before native issue, during uncertain creation, after native result retention, after startup observation commit and after Pi apply. Identity tests cover wrong initial hubs/old capabilities and a replaced port preserving the original local draft without sending to the other hub.

The explicit opt-in installed Rex test now also exercises **this production allocation task/native operation** against the private Rex server. It verifies a real full-ID binding/receipt, an early native-block startup registration joined after apply, no canonical input/inference or duplicate session, and historical-not-health semantics after client exit. Evidence remains the observed aarch64-darwin Rex version/API 8; no live provider, user sessions, GUI or server-restoration evidence is claimed.

Before public allocation/reopen, extend the [historical startup observation](rex-startup.md) with authoritative exact-object readiness/inspection/reconciliation, explicit replacement semantics and save-before-send client drafts. Preserve owned-child inspection/stop-only semantics. Unknown creation cannot be fixed by blindly retrying or adopting the only matching label. Server restart, remote workers/Rex/Tailscale, discovery and GUI attachment remain deferred. Backup preserves Pi intent/bindings/native receipts, **not** Rex objects or external effects; restoring never implicitly creates a terminal, and rollback can forget later effects.
