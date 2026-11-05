# Prototype implementation plan

Build one vertical slice at a time. Keep Pi as the only conversation/execution store; do not introduce a scheduler, replicated transcripts, or task lifecycle state machine.

## Phase 1 — runtime contracts (in progress)

- [x] One version-pinned Pi adapter with main/task/foreground-subagent conversations and persisted host bindings.
- [x] Durable request identity and conflicting retry detection; retained model/reasoning/binding capture (limitations below).
- [x] Exercise native steer/follow-up/abort, SQLite reopen, separate task context, host affinity, and no offline fallback with a faux provider.
- [x] Bounded length-prefixed JSON frame codec, tested against split UTF-8, malformed and oversized frames.
- [x] Wire the codec to inherited stdio with versioned command validation and bounded concurrent commands/backpressure.
- [ ] Add per-request transport cancellation when an actual long-running command needs it (`stop` already invokes Pi abort).
- [ ] Validate provider OAuth, Rex CLI and Tailscale identity on installed dependencies before claiming support.

### Contract findings and remaining limits

`runtime/src/deck.ts` is an internal adapter, not a service entry point. Its caller must provide exclusive store ownership. Production file tools use a narrow native adapter on dedicated inherited pipes to the local Zig worker; broader environment tests still inject Pi's Node environment as a stand-in. Native bash now uses owned process groups with a dedicated cancellation channel. Remote workers are unavailable. Never run two adapters over the same store.

Pi 1.4.0 exposes `Conversation.submit(draft)` but no public `submit(tx, draft)`. The adapter first commits an immutable request capture reservation in a Pi document, then admits with the same Pi request ID. A reservation is **not** an acknowledgement. A retry repairs a crash between those commits; a committed Pi submission deduplicates a lost ACK. Metadata is also attached to the eventual input entry. This uses no internal Pi imports and no second database.

New version-3 captures explicitly label admission-time observations: model/reasoning, agent/tool cwd, extension/tool names, native-tool mode, an instruction hash and startup implementation identity. They do not snapshot instruction files or freeze a worktree. The implementation gate fingerprints actual runtime/dependency/Node/native bytes and refuses changed-code recovery while any canonical work remains; version-2/older captures keep their original weaker checks. The adapter now rejects configuration while Pi tasks/inbox remain and refuses reservation-gap repair after observed settings drift; admitted receipts and legacy capture bytes remain stable. Pi still resolves requests/phases at use time, so full per-input pinning remains a Phase 2 boundary before public configuration. See [settings semantics](settings.md). Pending reservations are retried by the client, not independently scheduled. Task creation now uses a durable request ID and an atomic conversation/receipt commit; retries and conflicting arguments are tested across reopen.

Native FIFO and abort behavior passed: follow-ups place one at a time; steering joins at a tool boundary; abort withdraws queued input. No extra queue is needed. The supervised runtime now serves private IPC; writer-lock survival after supervisor death is tested. Foreground subagent ownership now has automated Pi/faux and crash-recovery coverage; live delegation, live ChatGPT OAuth/account eligibility, Rex, Tailscale, and the TUI remain unvalidated; the API-key local workflow has user-reported manual validation. Provider/login integration now has offline fake-provider contract coverage.

## Phase 2 — local working slice (in progress)

- [x] Zig `init`: persistent random machine ID, versioned atomic config, private directory, idempotency.
- [x] Nonblocking writer lock inherited by the TS child; foreground runtime supervision.
- [x] Explicit `serve --stdio --mock` development bridge with status/admission/history/task/stop commands; no real provider or local tools implied.
- [x] Integration test: initialization, IPC dedup/conflict, supervisor death, surviving child lock, clean EOF and reopen. Enabled in macOS/Linux CI.
- [x] Zig loopback HTTP command bridge and plain `agent --no-tui` client; admission/history, detach, task selection and retry drafts (now persisted; see Phase 2).
- [x] HTTP integration coverage for malformed requests, Host/Origin rejection, plain-client admission and task isolation.
- [x] Hub-owned OpenAI provider integration, concrete initial model selection and saved-model validation; explicit paid-key opt-in.
- [x] Hub-driven ChatGPT OAuth interaction bridge and private atomic credential store, with offline login/refresh/cancellation/failure tests.
- [ ] Validate live ChatGPT login/refresh and inference with real account access (not performed; no external calls in CI).
- [x] Native local UTF-8 file tools over separate inherited effect pipes; host-affinity enforcement, bounded payloads, exact edits and retained operation receipts/uncertainty tests.
- [x] Prompt stop-request receipt; actual Pi abort/effect draining remains observable independently.
- [x] User-reported live API-key conversation smoke test.
- [x] Bash with explicit process-group ownership, bounded output, timeout, four-slot capacity and independent cancellation; native filesystem cancellation remains drain-only.
- [x] Shell tests: TERM-resistant cancellation, timeout, output flooding/truncation, background-child cleanup, credential-env omission and retained results.
- [x] User reports the live API-key smoke suite passed: native file write/read/exact edit, bash output/cwd/file verification, foreground sleep cancellation, detach/reconnect without cancelling work, and unsent-draft recovery/retry across client exit and hub restart. This does not establish live OAuth/refresh or manual crash-after-commit/lost-ACK coverage; no external provider calls in CI.
- [x] Durable task-creation deduplication with conflicting retry rejection.
- [x] Paginated discovery from Pi conversation records and saved Deck metadata, including offline assignments; plain `/tasks [more]`, `/select CHAT_ID` and `/main` without creating or stopping work. Retries remain pinned to their original chat, and switching with unacknowledged drafts is blocked; tests cover persistence, pagination, client retry routing and actual HTTP task isolation.
- [x] Bounded, fork-aware backward history pagination with stable entry-ID cursors; plain `/older`, independent recent polling, retry-safe cursors and adaptive page-size reduction on frame overflow. Tests cover >100 entries, interleaved IDs, concurrent appends, reopen, forks, stale selection responses and client rendering. System rendering and SSE/incremental token streaming are unfinished; sampled answer previews are covered below.
- [x] Bounded selected-chat activity projection from Pi LiveDoc/InboxDoc; change-only plain-client polling and `/activity`, plus bounded sanitized tool-result rendering from canonical history. Tests cover gated generation/40-tool rounds, queue counts, isolation, omitted arguments, transition deduplication and installed-package rendering. Native bash output remains settlement-only; this is not SSE or an execution tracker.
- [x] Bounded sampled assistant-text previews from Pi LiveDoc, without another stream log or execution tracker. Plain mode prints sanitized, deduplicated provisional snapshots, keeps canonical final history independent, and backpressures polling behind blocked stdout. Tests cover actual Pi/faux streaming/stop, SIGKILL/recovery, omission/bounds, frame-budget fallback, outage/replacement/stale-selection behavior and prompt detach under stdout backpressure. Native/installed checks cover progress API shapes; live provider validation remains pending. See [live progress](live-progress.md); shell/tool partials and SSE remain unfinished.
- [x] Forward committed-entry catch-up from a per-selection watermark, including empty-chat bootstrap, multi-page bursts, transient failures and page-size reduction without gaps. Cursor memory is constant-sized; backward browsing stays independent. Tests cover forward scans/fork ancestry/reopen, 260-entry bursts with nonconsecutive IDs, retry positions, actual HTTP and installed-package APIs.
- [x] Prompt client detach cancels stalled HTTP reads without sending Pi stop; stale/late output is suppressed. Unresolved drafts produce an exit warning; saving must succeed before send, and saved drafts survive client exits.
- [x] Writer failure monitoring in idle HTTP/IPC wait paths, cached single-owner child reaping, nonzero serve exit/listener release and no automatic respawn. Failed Pi Harness closure shuts down the writer without exposing the error payload. Native stream closes are awaited to avoid Node fs.read/forced-exit deadlock. Fault tests cover idle/clean/in-flight death, active-shell cleanup, synthetic Harness failure, port release and store reopen; live hangs and exhaustive storage-failure injection remain unimplemented.
- [x] Private atomic unacknowledged client request cache, scoped by a stable Pi session identity. Input and task requests save before send, preserve IDs/chat/binding through crashes and require explicit retry. Metadata-only discovery, explicit recovery/discard, one-shot replacement refusal, exclusive/conflict-safe publication and no automatic replay. Tests cover process death before ACK, port/binding changes, privacy/corruption, save failure and malformed ACK retention. See [client drafts](client-drafts.md); power-loss, tamper-proof storage and divergent-clone identity are not claimed.
- [x] Narrow settings safety boundary: versioned admission observations, drift refusal for unadmitted reservation repair, and atomic Pi-task/inbox idle checks for internal configuration. Tests cover active/queued/blocked/draining work, cwd coherence, instruction hashing, legacy repair and settings changes across reopen.
- [x] Conservative startup implementation compatibility gate before Harness task normalization/resume: actual runtime/dependency assets/Node/native/entry bytes plus mode/capability identity, bounded canonical work scans and one Pi session stamp. Changed or unversioned implementations refuse unfinished work; idle upgrades preserve receipts/bindings. Version-3 reservations reject code drift; legacy captures remain unchanged. Tests include SIGKILL with untouched restart counters, original-build recovery, global parked/background/submission checks and real native-launcher code-change refusal. See [recovery compatibility](recovery-compatibility.md).
- [x] Offline backup/restore under the inherited writer lock, using SQLite's backup API without Pi open/resume and preserving native receipts/config/identity. Versioned checksummed private artifacts, optional stored credentials, fresh-only restore and config-last/incomplete-marker publication. Tests cover committed WAL, page sizes, unchanged source, corruption/path/bounds/privacy, live/orphaned/admin lock holders, SIGKILL original-build recovery and retained/uncertain effects. Installed smoke serves a restored seeded transcript. See [backup/restore](backup-restore.md); rollback can repeat later external effects, and migration/online-backup policies remain unfinished.
- [ ] Full captured settings/files and compatible migration/downgrade/online-backup policy; SSE/incremental streaming, shell/tool partials and Rex reconnect.
- [x] Package compiled runtime, private Node/Bash and locked production npm closure in Nix, preserving lazy provider assets.
- [x] Post-install smoke check outside the checkout without Node on PATH: init, native file/bash operations, provider SDK asset loading, mock hub/client admission/history. Local arm64-macOS Nix build passed; other platforms remain subject to CI validation.
- [x] Read-only model task inspection via `task_list`, `task_history`, `task_activity`: bounded canonical page scans/title filtering, history projections/cursors and sampled activity, including offline assignments. Real Pi/faux model pipeline tests cover reopen, paging, bounds/error handling, omitted sensitive fields and no effects/target admissions; installed-package checks verify definitions. Live use of these new tools remains unverified. See [task tools](task-tools.md).
- [x] Separate model-facing `task_create`/`task_message` extension: caller-binding ownerless creation, ack-only cross-task admission, Pi tool-task-derived deduplication, explicit agent provenance, cancellation checks before queued mutations/submit, and self/main/unmanaged target rejection. Actual Pi/faux tests include SIGKILL after creation/admission commits but before tool-result settlement, stable receipt recovery without duplicates, caller-stop independence and invalid/cancelled mutations. See [task control](task-control.md); live model validation remains pending.
- [x] Foreground `subagent` tool using Pi task-owned child conversations and invocation-bound input/wait. Inherits binding/agent filters without widening selections; disables recursive delegation and ownerless task control; returns bounded final text with error/omission flags. Canonical owner-index/input deduplication survives SIGKILL after creation or committed answer. Tests cover ordinary cancellation with draining native effects, failure-detail omission, provenance/discovery and read-only external child access. See [subagents](subagents.md); live validation remains pending.
- [ ] Richer search, background delegation/reporters, direct child-input lifetime semantics, full settings/files capture, SSE/tool streaming and Rex integration before treating Phase 2 as complete.

See [runtime IPC](runtime-ipc.md) for the current development entry point and precise limits. No remote listener until identity verification exists.

## Phase 3 — remote effects

Outbound worker connection, host registry, retained native-effect receipts, explicit uncertainty/cancellation and reconnect fault tests. Never reassign offline work.

## Phase 4 — terminal usability

Evaluate a maintained TUI library; add editing, bounded history, Markdown/activity and simple related-work search. Preserve plain-output parity.

## Phase 5 — jobs

Pi durable timers, stable job chats and atomic occurrence admission. Add monitoring only after the interactive slice works.

## Scope discipline

Do not claim an untested integration works. Start with explicit unavailable/unsupported results instead of fallback behavior. No worktree manager, extra database/catalog, custom input queue, or new task state machine. The local slice now supports conversational inference and small native file edits. Help and README must distinguish API-key smoke testing from unverified live OAuth, and must keep remote workers visibly unavailable and document shell/process-group limits. File-effect receipts do not provide exactly-once writes, a sandbox or power-loss guarantees. See [local tools](local-tools.md) for the tested contract.
