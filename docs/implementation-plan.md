# Prototype implementation plan

Build one vertical slice at a time. Keep Pi as the only conversation/execution store; do not introduce a scheduler, replicated transcripts, or task lifecycle state machine.

## Phase 1 — runtime contracts (in progress)

- [x] One version-pinned Pi adapter with main/task conversations and persisted host bindings.
- [x] Durable request identity and conflicting retry detection; retained model/reasoning/binding capture (limitations below).
- [x] Exercise native steer/follow-up/abort, SQLite reopen, separate task context, host affinity, and no offline fallback with a faux provider.
- [x] Bounded length-prefixed JSON frame codec, tested against split UTF-8, malformed and oversized frames.
- [x] Wire the codec to inherited stdio with versioned command validation and bounded concurrent commands/backpressure.
- [ ] Add per-request transport cancellation when an actual long-running command needs it (`stop` already invokes Pi abort).
- [ ] Validate provider OAuth, Rex CLI and Tailscale identity on installed dependencies before claiming support.

### Contract findings and remaining limits

`runtime/src/deck.ts` is an internal adapter, not a service entry point. Its caller must provide exclusive store ownership. Production file tools use a narrow native adapter on dedicated inherited pipes to the local Zig worker; broader environment tests still inject Pi's Node environment as a stand-in. Native bash now uses owned process groups with a dedicated cancellation channel. Remote workers are unavailable. Never run two adapters over the same store.

Pi 1.4.0 exposes `Conversation.submit(draft)` but no public `submit(tx, draft)`. The adapter first commits an immutable request capture reservation in a Pi document, then admits with the same Pi request ID. A reservation is **not** an acknowledgement. A retry repairs a crash between those commits; a committed Pi submission deduplicates a lost ACK. Metadata is also attached to the eventual input entry. This uses no internal Pi imports and no second database.

Capture currently includes model, reasoning and host/cwd only, not project instruction files or extension versions. It records the admission choices but does not pin generation settings across a later `configure` call: Pi resolves choices at request preparation. Full captured settings semantics remain a Phase 2 boundary to implement/test before exposing configuration over the API. Pending reservations are retried by the client, not independently scheduled. Task creation now uses a durable request ID and an atomic conversation/receipt commit; retries and conflicting arguments are tested across reopen.

Native FIFO and abort behavior passed: follow-ups place one at a time; steering joins at a tool boundary; abort withdraws queued input. No extra queue is needed. The supervised runtime now serves private IPC; writer-lock survival after supervisor death is tested. Subagent ownership, live provider/account access, Rex, Tailscale, and the terminal remain unvalidated. Provider/login integration now has offline fake-provider contract coverage.

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
- [ ] Live model-driven file/bash smoke test; no external provider calls in CI.
- [x] Durable task-creation deduplication with conflicting retry rejection.
- [x] Paginated discovery from Pi conversation records and saved Deck metadata, including offline assignments; plain `/tasks [more]`, `/select CHAT_ID` and `/main` without creating or stopping work. Retries remain pinned to their original chat, and switching with unacknowledged drafts is blocked; tests cover persistence, pagination, client retry routing and actual HTTP task isolation.
- [x] Bounded, fork-aware backward history pagination with stable entry-ID cursors; plain `/older`, independent recent polling, retry-safe cursors and adaptive page-size reduction on frame overflow. Tests cover >100 entries, interleaved IDs, concurrent appends, reopen, forks, stale selection responses and client rendering. System rendering and partial streaming are unfinished.
- [x] Bounded selected-chat activity projection from Pi LiveDoc/InboxDoc; change-only plain-client polling and `/activity`, plus bounded sanitized tool-result rendering from canonical history. Tests cover gated generation/40-tool rounds, queue counts, isolation, omitted arguments, transition deduplication and installed-package rendering. Native bash output remains settlement-only; this is not SSE or an execution tracker.
- [x] Forward committed-entry catch-up from a per-selection watermark, including empty-chat bootstrap, multi-page bursts, transient failures and page-size reduction without gaps. Cursor memory is constant-sized; backward browsing stays independent. Tests cover forward scans/fork ancestry/reopen, 260-entry bursts with nonconsecutive IDs, retry positions, actual HTTP and installed-package APIs.
- [x] Prompt client detach cancels stalled HTTP reads without sending Pi stop; stale/late output is suppressed. Unresolved drafts produce an exit warning; saving must succeed before send, and saved drafts survive client exits.
- [x] Writer failure monitoring in idle HTTP/IPC wait paths, cached single-owner child reaping, nonzero serve exit/listener release and no automatic respawn. Failed Pi Harness closure shuts down the writer without exposing the error payload. Native stream closes are awaited to avoid Node fs.read/forced-exit deadlock. Fault tests cover idle/clean/in-flight death, active-shell cleanup, synthetic Harness failure, port release and store reopen; live hangs and exhaustive storage-failure injection remain unimplemented.
- [x] Private atomic unacknowledged client request cache, scoped by a stable Pi session identity. Input and task requests save before send, preserve IDs/chat/binding through crashes and require explicit retry. Metadata-only discovery, explicit recovery/discard, one-shot replacement refusal, exclusive/conflict-safe publication and no automatic replay. Tests cover process death before ACK, port/binding changes, privacy/corruption, save failure and malformed ACK retention. See [client drafts](client-drafts.md); power-loss, tamper-proof storage and divergent-clone identity are not claimed.
- [ ] Settings capture semantics, live SSE/partial output and Rex reconnect.
- [x] Package compiled runtime, private Node/Bash and locked production npm closure in Nix, preserving lazy provider assets.
- [x] Post-install smoke check outside the checkout without Node on PATH: init, native file/bash operations, provider SDK asset loading, mock hub/client admission/history. Local arm64-macOS Nix build passed; other platforms remain subject to CI validation.
- [ ] Complete model-facing task orchestration/search, subagents, settings, live history/activity and Rex integration before treating Phase 2 as complete. Client task discovery alone does not implement orchestration.

See [runtime IPC](runtime-ipc.md) for the current development entry point and precise limits. No remote listener until identity verification exists.

## Phase 3 — remote effects

Outbound worker connection, host registry, retained native-effect receipts, explicit uncertainty/cancellation and reconnect fault tests. Never reassign offline work.

## Phase 4 — terminal usability

Evaluate a maintained TUI library; add editing, bounded history, Markdown/activity and simple related-work search. Preserve plain-output parity.

## Phase 5 — jobs

Pi durable timers, stable job chats and atomic occurrence admission. Add monitoring only after the interactive slice works.

## Scope discipline

Do not claim an untested integration works. Start with explicit unavailable/unsupported results instead of fallback behavior. No worktree manager, extra database/catalog, custom input queue, or new task state machine. The local slice now supports conversational inference and small native file edits. Help and README must distinguish API-key smoke testing from unverified live OAuth, and must keep remote workers visibly unavailable and document shell/process-group limits. File-effect receipts do not provide exactly-once writes, a sandbox or power-loss guarantees. See [local tools](local-tools.md) for the tested contract.
