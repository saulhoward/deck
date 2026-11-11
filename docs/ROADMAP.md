# Roadmap

This file contains planned work, not implemented commands or support claims. Read the [README](../README.md) for the current workflow and the [Developer guide](DEVELOPER.md) for design rules. Completed work and earlier test results are in [History](HISTORY.md).

## Current position

The local prototype has one Pi writer, durable main/task chats, native file/bash tools, saved request drafts, explicit instruction import, and foreground subagents. Local Rex open/reopen, TUI task navigation, Rex-managed TUI startup, chat-scoped model/thinking controls, terminal status, and opt-in registered files/bash workers are implemented.

The [target architecture](DEVELOPER.md#target-interactive-and-scheduled-architecture) keeps all Pi execution and history at the hub. Interactive tasks get named Rex sessions on their execution machines, with named TUI terminals for their subagents. Scheduled jobs and their children use registered hosts without Rex. Jobs reuse their task/chat across runs; each run has its own admission identity and captured file settings.

Remote interactive workflows and jobs remain target requirements, not current support. No delivery dates are set.

## Next implementation sequence

1. **Implemented:** distinct hub presentation, read-only task inspection, hub creation followed by Rex opening, and explicit status/inspection/reopen. Unsent prompts block hub navigation/creation; saved requests retain exact retries.
2. **Implemented:** allocation-bound TUI startup and task-locked Rex clients. No cross-task navigation or non-Rex task participation. Explicit `--no-tui` follows the same role restrictions.
3. **Partial:** registered native files/bash links and worker-only packaging are implemented. Complete real two-machine acceptance, then add a separately authenticated remote TUI path and assigned-host Rex sessions. Do not bypass the remote-client or Rex API 9 gates.
4. Add named subagent TUI terminals inside the parent interactive task's session. Preserve Pi ownership and define direct-input rules separately.
5. Implement per-run file capture and Pi scheduling. Reuse each job's task/chat, give each run its own admission identity, and prove that jobs and their children create no Rex objects.

The sections below define these requirements and the remaining validation work. They are work areas, not a requirement to finish every optional UI improvement before remote support.

## 1. Finish local validation and usability

### Provider access

- [ ] Validate live ChatGPT login, refresh, account access, and inference in a separately approved test account/state directory.
- [ ] Verify failure behavior for revoked grants and unavailable models. Do not fall back to paid keys.
- [ ] Validate live model task inspection, independent task messaging, foreground delegation, and output previews.
- [ ] Keep user-reported API-key results separate from automated and OAuth evidence.

Acceptance: record the tested provider, mode, platform, and limits without exposing credentials. Keep automated tests offline. Live tests require explicit authorization; this plan does not authorize account access.

### Client workflow

- [x] Update CLI help for current TUI task and Rex commands.
- [x] Add task discovery, creation, and read-only selection inside the hub TUI. Preserve unsent editor text and unresolved drafts. Reject stale replies after selection changes.
- [x] Distinguish hub/task colors and labels; require Rex for task participation and lock task clients. Apply the same policy to helper requests and plain clients.
- [x] Show saved Rex allocation, fresh terminal presence, and agent activity as separate facts. Add explicit open/reopen for the selected interactive task.
- [ ] Add Markdown and large-history navigation without unbounded display memory or terminal-control execution.
- [ ] Add richer tool/activity detail with explicit clipping and sensitive-data limits.
- [x] Integrate allocation-bound Rex startup with the TUI and use it for managed interactive task terminals. Keep the plain client as an explicit fallback.
- [ ] Validate actual Rex GUI status display, terminal fonts, tmux, SSH, and nested terminal behavior.
- [ ] Test native runtime/terminal behavior on more macOS/Linux architectures. Cross-compilation alone is not enough.

Acceptance: preserve exact retries, prompt text, safe detach, restored terminal modes, fixed identity checks, and bounded memory. Keep the plain client. Do not create hidden terminals or start inference while browsing.

### Reads and reconnect

- [ ] Design incremental/SSE delivery only with bounded buffers and a clear history watermark. Keep retained history separate from replaceable samples.
- [ ] Define full shell-output artifacts and arbitrary tool partials before claiming lossless output.
- [ ] Add per-request transport cancellation only when a real long-running command needs it.
- [ ] Extend client reconnect and Rex daemon-restoration tests as separate contracts. A client surviving a same-hub restart does not prove server migration or daemon recovery.

Acceptance: disconnect means unavailable/unknown, not idle, absence, or permission to replay. Reconnect restores observation; it does not submit drafts, recreate terminals, or move assignments.

## 2. Define settings and recovery extensions

- [ ] Specify full per-input settings and instruction capture: exact contents, path precedence, required-file failures, timing, retention, and provider coverage.
- [ ] Prove capture for queued input, steering, tool continuation, retry, compaction, child work, and process recovery before general or busy-time configuration.
- [ ] Design automatic project-file discovery separately from the existing explicit `AGENTS.md` import.
- [ ] Define compatible migrations, downgrade refusal, original-build retention, and recovery when the original runtime is unavailable.
- [ ] Add online backup or general repair only with a tested storage and external-effect reconciliation policy.
- [ ] Define retention/cleanup for sensitive transcripts, receipts, drafts, and backups.
- [ ] Investigate provider fast-mode and quota APIs. Show requested/effective settings and unknown/stale quota; do not invent support or percentages.

Acceptance: no agent swapping around queued inputs, hook-only enforcement, second scheduler, or rewritten old captures. Do not turn a settings observation into a claim that files or code were frozen. Preserve expected-selection checks for model changes and idle-only instruction imports.

## 3. Add verified remote effects

Do not expose a remote listener before verified identity exists. The existing loopback trust model is not remote authentication.

**First transport slice implemented:** explicit private worker configuration/approval, actual-socket Tailscale verification on both outbound data/control links, generation fencing, exact saved-host routing, independent cancellation/heartbeat capacity, and a native-only `deck-worker` package. Isolated TCP tests use injected identity verification and cover receipt preservation, lost results, host isolation, and saturated result pipes. This is not a real two-machine Deck test. Earlier Tailscale self-node/selected-peer and HTTPS/Rex probe evidence remains separate; the selected Rex endpoint's API 9 is still not enabled for Deck allocation. Remote Rex and remote client access remain disabled.

- [ ] Validate Tailscale peer verification on selected real test machines. Map actual verified peers to registration, not claimed headers or names.
- [x] Define schema-backed worker registration, capabilities, and connection generation. Runtime inventory remains future work.
- [x] Add outbound files/bash worker links with bounded effects/results and independent control capacity.
- [x] Fence replies and disconnect cleanup by generation. An old connection must not affect its replacement.
- [x] Preserve host/cwd assignments while a worker is offline. Never execute its effects elsewhere as fallback.
- [x] Preserve original operation IDs/bytes and consult retained receipts on explicit original-identity retry; never replay on reconnect.
- [ ] Add a general read-only remote receipt/reconciliation UI without reissuing effects.
- [ ] Test disconnect before/after acceptance, lost results, duplicate/stale replies, identity drift, hub/worker restart, and reconnect backoff.
- [x] Prove host isolation with independent native links and evented remote pipes in isolated tests; repeat on actual machines.
- [x] Package worker-only mode without a Pi runtime or provider credentials.
- [ ] Route Rex creation/inspection through the assigned execution host and verify its saved server identity. Do not treat a remote server option as permission to move a task.
- [ ] Provide verified remote client access to the hub. Rex's connection does not secure Deck's separate chat transport.
- [ ] Test remote task TUI startup, session closure, and explicit reopen of the same conversation without duplicate input or generation.

Acceptance: use verified identity and explicit bindings for every effect. Keep unknown accepted effects uncertain. Worker liveness is not effect completion. Do not add worker Pi stores, transcript replication, or cross-host failover.

## 4. Improve task coordination

- [ ] Add metadata and full-text search over retained conversations. Keep any index derived and rebuildable.
- [ ] Add dispatch-linked answers or background delegation using Pi ownership and tasks, not a new reporting lifecycle.
- [ ] Give interactive subagents named TUI terminals inside their parent task's named Rex session. Store full IDs and preserve Pi child ownership across terminal close/reopen.
- [ ] Define owned-child input and lifetime rules before allowing direct interaction or independent configuration. A terminal view must not revive a finished owner or start another executor.
- [ ] Keep scheduled-job children headless. Child creation must not allocate Rex objects merely because interactive children have terminals.
- [ ] Define delegation duration/cost limits if needed. Do not imply current calls have such budgets.
- [ ] Add timestamped machine capacity/load views after remote registration is trustworthy.

Acceptance: search and inspection do not become model input automatically. Main and task contexts stay separate. A completed assistant turn does not prove a project is complete. A new tool call is not a safe retry of an ambiguous old call.

## 5. Add jobs and monitoring

- [ ] Use Pi durable tasks/sleeps in the hub runtime for scheduling and recovery. Zig can calculate calendar instants. Do not launch a Pi process per job.
- [ ] Reuse each job's persistent Deck task and Pi conversation across runs. Give each occurrence a unique `(job ID, scheduled UTC instant)` admission identity.
- [ ] Capture each run's specified file settings through its assigned host. Define capture timing and failure rules; current admission observations are not file snapshots.
- [ ] Retain each run's captured contents and reuse them on same-run retry/recovery. Later runs can capture newer contents.
- [ ] Commit occurrence metadata, captured-settings references, and admission atomically through a supported Pi path. Do not assume the current input reservation is already that transaction.
- [ ] Run job and child effects through registered host connections. Prove that scheduling, child creation, retries, recovery, and inspection open no Rex sessions or terminals.
- [ ] Define timezone/DST behavior, serialized overlap, coalesced misfires, and bounded catch-up.
- [ ] Keep manual input separate from recurring deadlines. Disabling a job must not pretend to undo accepted work.
- [ ] Add HTTP/web monitoring only after transport identity, same-origin/CSRF rules, and bounded read views are defined.
- [ ] Consider explicit user-service installation and optional runtime secret references as separate operational features. Builds must not install services or sign in.

Acceptance: use one execution owner and one canonical history. An offline worker keeps its assignment. Schedules must not create a parallel queue or bypass settings/effect safety.

## Scope limits

Rex terminal creation remains **best-effort**. Race-free replacement, duplicate-free creation, and recovery of every lost creation reply are not release gates for the local workflow. Preserve exact-object checks and manual cleanup warnings. This exception does not weaken input, file, or shell safety.

The current plan does not include source polling/triage, task-outcome reporting, managed worktrees, browser automation, mobile/push, historical transcript import, embeddings, learning, or automatic cross-host recovery.

For every stage:

1. State the behavior and refusal cases before coding.
2. Extend schemas and semantic tests at the actual boundary.
3. Use scratch state, fake providers, and isolated native services.
4. Record runtime evidence separately from compilation or source review.
5. Deploy only after all hub work has settled, with the prior immutable build retained.
