# Startup and recovery review

## Targeted repairs

- **Idle native pipes occupied the filesystem threadpool.** The local `PipeFiles` result reader used `fs.ReadStream`. An idle pipe consumed a libuv worker indefinitely, competing with implementation hashing and storage. With `UV_THREADPOOL_SIZE=1`, filesystem startup deadlocked. Local and remote pipes now both use evented sockets. A subprocess regression checks filesystem progress and closure without peer EOF with a one-thread pool.
- **Recovery fixtures timed dependency hashing rather than the fault boundary.** Message, task-control and subagent fixtures inject fake providers and faulting tool implementations. Parent and child now use matching explicit test implementation identities, as other injected fixtures already do. Production startup and compatibility tests still fingerprint actual code. Checkpoint and cancellation deadlines are unchanged.
- **Receipt directories inherited unsafe umasks.** Under `umask 0002`, native startup created group-writable journal directories that offline backup correctly rejected. Newly created hub and standalone-worker journal directories now request mode `0700`. Existing directories are not silently chmodded; an existing insecure state still requires operator review. Backup validation remains strict.
- **Small builders were oversubscribed.** Two simultaneous Zig compilations exhausted memory on a 2 GB builder; four runtime test files could each start additional processes. Nix now serializes executable compilation with an explicit `-Dserial=true` build dependency and runs test files one at a time (`-j1` alone still allowed overlapping compiler subprocesses with the pinned toolchain). Tests still exercise concurrent effects and cancellation internally. The development `npm test` default remains four files; small development machines can use `node --test --test-concurrency=1 runtime/dist/*.test.js scripts/*.test.mjs` after building.

## Validation

On the x86_64-linux machine that reported the failures, the full sandboxed `nix build . --no-link --keep-failed -L` completed successfully with the pinned toolchain. Contracts, Zig tests and TypeScript checks passed. The runtime/generator suite reported **554 passed, five expected opt-in/package-only skips, zero failures or cancellations (559 total)**. The installed-package smoke test passed **1/1**, outside the checkout without Node on PATH. The new one-thread-pool regression failed against the original local-pipe implementation and passed after the fix.

These results do not establish the power-loss guarantees or stalled-writer behavior proposed below, or substitute for the opt-in real Rex/two-machine acceptance gates.

## Enrollment follow-up

Two additional Linux enrollment failures were reproduced and repaired:

- The registry directory used Zig's default `O_PATH` handle. File creation/rename succeeded, but the required parent-directory fsync failed with `BADF`, before the enrollment acknowledgement and link startup. Enrollment now opens a readable directory handle. The registry format and durability ordering are unchanged.
- A reconnecting worker could reach enrollment before the runtime finished cold startup. The five-second private registration handshake then expired and permanently fenced its slot. Each automatic-client pipe now sends a schema-validated `RexRuntimeReady` record after runtime opening. Native validates all eight records and their hub identity before accepting enrollment. Registration/frame deadlines are unchanged; this is not a general startup timeout or IPC supervision redesign.

Validation for this follow-up is separate from the earlier full Nix build above. On Linux, the native suite passed **81 tests with one optional skip**, the two focused native regressions passed in ReleaseSafe as well as Debug, and **45 focused runtime tests passed**. These include isolated API-14 local/remote-selected startup, same-daemon backup/restore reconnect, assigned-worker reads/cancellation, shared contracts, and a default-suite native test holding readiness beyond the existing handshake deadline. Removing the readiness gate reproduces premature disconnection; the old directory handle reproduces the fsync failure. Strict focused TypeScript checking passed. Full-project TypeScript exceeded the constrained 512 MiB heap; a fresh full Nix/package build and macOS/two-machine acceptance were not performed. No live hub or retained operator state was changed.

## Client-update contact follow-up

Automatic startup can now dispatch through the existing worker's verified original client when the invoking client path/build changes. This removes the manual old-Nix-path workaround without changing version-1 pins, receipts, allocations or the worker process. It deliberately retains the old client/UI. Unknown/raw older runtime environments, missing/changed packages, identity drift and unconfirmed session creation still refuse; there is no version-string compatibility assumption, download or metadata repair.

Linux validation passed **87 native tests with one optional skip** and **19 focused runtime tests**, including native verification, the fake-Rex/private-lock refusal regression, and isolated API-14 local/remote create/list/resume. Focused strict TypeScript, contracts and formatting checks passed. The remote test also passed with a real older full Nix package that predates this dispatch code and has a different native digest. The original installed executable fails the new regression with its build/client conflict. This does not establish macOS/two-machine acceptance or a full Nix build for this follow-up. No operator hub, worker or retained state was changed.

**Still unimplemented:** explicit worker protocol/receipt compatibility negotiation and live daemon upgrading. Existing daemons cannot acknowledge a handoff. A future rollout must establish custody of active/accepted/uncertain work, drain admission, preserve identities/allocations/receipts, durably transfer ownership, and fence old connection generations. Failed/unsupported handoff must leave the old worker intact; contact must never replay an effect or overwrite an uncertain receipt. Retaining and dispatching the old client is a safe contact path, not evidence that this protocol exists.

## Rex backwards-compatibility policy

Rex revision N supports APIs 0 through N. Deck now uses feature minimums instead of release allowlists: API 8+ for terminal discovery/allocation/inspection and API 14+ for automatic startup/forwarding. Required identity, endpoint, ownership and response-shape checks remain in place. API revisions are validated as unsigned JSON integers (numeric strings are not coerced). There is no new idempotency assumption, effect replay, metadata rewrite or worker replacement. Pinned older clients/daemons keep their compiled checks; a new profile alone does not update them.

Linux validation passed **88 native tests with one optional skip** and **54 focused runtime/integration tests** in the final combined run. Fake-CLI cases cover API 9, 16 and a future revision, too-old/missing/malformed/string revisions, scoped launcher contact, retained receipts, cancellation and crash recovery without repeated creation. The API-16 allocation regression fails against the prior executable. Real isolated Rex tests used the available **API-14** binary, including forwarding, local/remote startup, task TUI/adoption, same-daemon reconnect and managed hub clients. Focused strict TypeScript, contracts and formatting checks passed. Two earlier cold runs timed out on the public fixture's initial status request before any Rex operation; its isolated rerun and final combined run passed with the original deadlines. Full-project TypeScript/emission at a 256 MiB heap exceeded memory; focused checking passed at 512 MiB. No fresh full Nix build, real API-16/macOS acceptance or operator service upgrade was performed.

## Follow-up 1: complete the power-loss durability protocol

**Priority: high. This review does not fix this gap.**

`src/worker.zig` saves ordinary file/bash/Rex acceptance and result receipts by syncing the temporary file and renaming it, without syncing the journal directory. `src/state.zig` likewise does not consistently sync directory publication. `runtime/src/backup.ts` syncs payload and manifest files, but not all directories before publishing a completed backup or activating a restore.

Atomic rename and file fsync are not enough to guarantee directory-entry persistence across power loss. In particular, losing a native acceptance/result receipt can remove evidence needed to avoid repeating an external effect. The MCP receipt path already syncs its directory; the ordinary receipt path needs the same guarantee. These are code-review findings, not a reproduced power-loss incident. Process SIGKILL tests do not establish this guarantee.

Proposed sequence:

1. Specify the durable acceptance, completion, backup-publication and restore-activation boundaries. Preserve existing request hashes and receipt formats.
2. Reuse a small native atomic-publication helper: private temporary file, file fsync, atomic publication, then parent-directory fsync through a readable directory descriptor. Never dispatch an effect before acceptance publication completes. Treat post-effect persistence failures as uncertain, never as permission to replay.
3. Apply equivalent ordering to backup and restore: sync payload directories bottom-up before publishing the manifest; make the restore marker durable before copying; sync restored payloads and config publication before removing the marker; sync the directory after marker removal. Include newly created parent entries in the protocol.
4. Add injected failures at write, file sync, rename/link, directory sync and activation boundaries. Assert that failed artifacts never become runnable and retained receipts are never rewritten or inferred from temporary files.
5. Add a disposable VM/filesystem power-cut test. Keep process-crash coverage, but report it separately from power-loss durability.

Do not weaken the backup permission checks or automatically repair uncertain receipts to make these tests pass.

## Follow-up 2: explicit readiness and bounded supervision

**Priority: medium. This review does not redesign the hub transport.**

`src/hub.zig` handles an IPC exchange synchronously. Its polling loop notices writer death, but has no reply deadline for a living, stalled writer. That can block subsequent HTTP commands, including a stop request. Listener/PID availability also precedes runtime fingerprinting and store readiness. This is an existing documented limitation, not evidence that the current test failures replayed or corrupted tasks.

Proposed sequence:

1. Define a private, correlated readiness response emitted only after compatibility validation, store initialization and recovery setup. Distinguish starting, ready, draining and failed observations.
2. Give startup and individual IPC requests separate finite budgets. On an expired request, fence the connection and preserve uncertainty; do not resend mutations or automatically restart the writer.
3. Replace the single blocking exchange with a bounded response reader and correlated pending requests, or explicitly fail the hub on an exchange timeout. Preserve independent native cancellation and writer-lock ownership through drainage.
4. Test a child that remains alive but never replies, a partial frame, delayed readiness, shutdown during startup, and a lost response after a committed mutation. Verify bounded client failure and no replay.

## Scaling consideration: startup work

Production startup currently fingerprints the complete dependency tree on every new process. The reviewed checkout covered about 12,700 dependency files (about 80 MB), before Node/native binaries and runtime files. It also scans conversations for metadata backfill and saved-model validation. These costs grow independently of the operation a startup test is exercising.

A later optimization should preserve the compatibility gate rather than skip it: consider a verified build-time manifest for immutable Nix payloads, keep byte validation for mutable checkouts, and use versioned, transactional migration progress for one-time metadata backfills. Do not replace actual code identity with package version strings or an unvalidated persistent cache. Review how a bug-fix upgrade can safely drain or migrate unfinished work before changing the current conservative upgrade policy.
