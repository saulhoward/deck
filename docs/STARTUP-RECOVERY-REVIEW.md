# Startup and recovery review

## Targeted repairs

- **Idle native pipes occupied the filesystem threadpool.** The local `PipeFiles` result reader used `fs.ReadStream`. An idle pipe consumed a libuv worker indefinitely, competing with implementation hashing and storage. With `UV_THREADPOOL_SIZE=1`, filesystem startup deadlocked. Local and remote pipes now both use evented sockets. A subprocess regression checks filesystem progress and closure without peer EOF with a one-thread pool.
- **Recovery fixtures timed dependency hashing rather than the fault boundary.** Message, task-control and subagent fixtures inject fake providers and faulting tool implementations. Parent and child now use matching explicit test implementation identities, as other injected fixtures already do. Production startup and compatibility tests still fingerprint actual code. Checkpoint and cancellation deadlines are unchanged.
- **Receipt directories inherited unsafe umasks.** Under `umask 0002`, native startup created group-writable journal directories that offline backup correctly rejected. Newly created hub and standalone-worker journal directories now request mode `0700`. Existing directories are not silently chmodded; an existing insecure state still requires operator review. Backup validation remains strict.
- **Small builders were oversubscribed.** Two simultaneous Zig compilations exhausted memory on a 2 GB builder; four runtime test files could each start additional processes. Nix now serializes executable compilation with an explicit `-Dserial=true` build dependency and runs test files one at a time (`-j1` alone still allowed overlapping compiler subprocesses with the pinned toolchain). Tests still exercise concurrent effects and cancellation internally. The development `npm test` default remains four files; small development machines can use `node --test --test-concurrency=1 runtime/dist/*.test.js scripts/*.test.mjs` after building.

## Validation

On the x86_64-linux machine that reported the failures, the full sandboxed `nix build . --no-link --keep-failed -L` completed successfully with the pinned toolchain. Contracts, Zig tests and TypeScript checks passed. The runtime/generator suite reported **554 passed, five expected opt-in/package-only skips, zero failures or cancellations (559 total)**. The installed-package smoke test passed **1/1**, outside the checkout without Node on PATH. The new one-thread-pool regression failed against the original local-pipe implementation and passed after the fix.

These results do not establish the power-loss guarantees or stalled-writer behavior proposed below, or substitute for the opt-in real Rex/two-machine acceptance gates.

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
