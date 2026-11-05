# Startup implementation compatibility

Deck now uses a conservative rule: **unfinished Pi work resumes only under the same implementation identity**. An idle store can adopt another implementation. This protects process recovery, not full per-input reproducibility or code attestation.

## Implementation identity

Production `serve` fingerprints:

- compiled Deck runtime files, excluding Deck `*.test.*` support files;
- the actual installed declared production dependency graph, including present optional/peer dependencies, package contents and lazy assets;
- the Node executable bytes/version, platform and architecture;
- the actual Zig executable supplied by the native launcher and the Node entry script;
- the selected auth/provider mode (`--mock`, `--chatgpt`, `--api-key`) and whether native tools are installed.

SHA-256 inputs include relative file names, contents and dependency edges, not installation paths or mtimes. Byte-identical installations can be relocated; version strings alone do not establish compatibility. Changes to documentation/assets inside a dependency can conservatively change the identity too. There is no semantic-compatibility override.

Fingerprint reads are bounded to 20,000 files, 512 MiB and 1,000 dependency packages, with bounded file concurrency. Missing required dependencies and unsupported package asset symlinks fail startup; dependency-root symlinks are resolved. Only declared dependencies are traversed, not every development package in node_modules. This adds startup I/O but no network requests/downloads.

The identity is stored in one Pi session document, `deck.implementation`, and exposed as a digest in `status.implementation`. It contains no task list, scheduler or transcript copy. Credentials, workspace files and environment secrets are not fingerprint inputs. A trusted embedded caller that injects its own code must supply its own implementation identity; production main computes the real closure instead of accepting a client-supplied digest.

## Startup gate

While the native writer lock is held, and before exposing admission handles:

1. Open Pi's public storage adapter and read the existing compatibility document.
2. If its supported identity matches, proceed.
3. Otherwise, inspect bounded canonical scans for unfinished tasks (`pending`, `running`, `waiting`, `sleeping`, `completing`) and queued/placed submissions across **all** conversations. Parked, background and owned-child work count; presentation-level busy/idle does not decide this.
4. If any work remains, fail with a constant diagnostic and close storage. No Harness is opened and no task/inference/native effect is resumed. The saved identity is not replaced.
5. If idle, open the Harness and commit the new stamp through Pi before root initialization/resume.

The gate runs **before `Harness.open`**, not merely before `resume`: Pi opening can normalize running records and increment restart counters. Rejected upgrades therefore do not consume those retries. Zig never writes Pi tables; all gate reads use public storage methods and all stamp writes use a Pi transaction.

An unversioned legacy store is adopted only when idle. Pending legacy work must first be resolved with its original pre-gate build; Deck cannot retroactively establish which code created it. Unknown/malformed stamp formats reject startup even while idle, rather than silently treating them as a supported downgrade.

## Reservation and receipt behavior

New host admission captures are version 3 and include the writer's implementation identity alongside the existing [settings observations](settings.md). An unsubmitted reservation is not executing Pi work, so it does not block an idle upgrade. However, retrying that reservation under another implementation returns `settings_changed` without submitting. Restore the original implementation/choices to repair the same ID, or explicitly discard the draft and create a new request.

Already admitted, settled requests keep their original receipts/capture bytes and remain retrievable after an idle upgrade, including when authentication is unavailable. Legacy version-2/pre-versioned captures retain only their original weaker checks; no code provenance is fabricated. Owned subagent input uses its Pi handle rather than a host capture, but unfinished child work is still covered by the store-wide startup gate.

## Operating and upgrading

Prefer upgrading when `status.activity` has **no unfinished tasks or submissions**, not merely when selected-chat activity looks idle. A stop ACK is only a request: wait for owned effects to drain. Keep the previous immutable Nix package GC-rooted until work has settled and the upgrade is verified.

If startup refuses:

- Restart the original package/runtime, Node and native binary, using its original mode and saved state directory.
- Let work finish or explicitly stop/resolve it there, including parked/background work. Do not blindly replay uncertain external effects.
- Once the whole store is idle, start the new package. Historical conversations and bindings remain intact.

There is deliberately no force-resume flag, automatic cancellation, migration execution, respawn or fallback to another host. If the original build is unavailable, recovery needs an explicit audited migration/restore procedure; there is not yet a supported general repair command. Never delete `writer.lock` or edit the compatibility document to bypass the gate.

The supervisor can exit before its surviving writer releases the inherited lock. Await that writer/lock release before launching a replacement. A refusal is not evidence that the lock file is stale.

## Boundaries and remaining work

This policy detects startup implementation changes; it does not freeze files against edits while a writer is running. Use the immutable installed runtime for reliable recovery. Mutating checkout code/dependencies during execution, custom loaders, undeclared dynamically loaded plugins, system libraries and arbitrary workspace executables are outside this guarantee. The digest recorded at reservation is the writer's startup identity, not a fresh code scan for every input.

Bash/Git/tool environment, provider-side behavior, instruction discovery/content snapshots and workspace state are not pinned. Full settings/file capture, explicit compatible migrations, online backup/general repair policy and remote-worker version negotiation remain unfinished. [Offline backup/restore](backup-restore.md) now copies the canonical stamp/checkpoints and native receipts without opening Pi; restore itself never resumes work and does not bypass the gate or reconcile external effects after rollback. Pi remains pinned at 1.4.0. The gate necessarily opens the public storage adapter to read its records: it is **not** a guard against a future storage adapter performing schema changes while opening. Pi/schema upgrades still require separately tested backup/migration/downgrade policies.

Tests cover content changes without version changes, dependency assets and cycles, relocation, test/dev-file exclusion, mode/native differences, idle receipt preservation, global parked/background work, legacy queued/placed submissions, malformed/future stamps, version-3 drift refusal/repair and weaker version-2 preservation. A SIGKILL fixture proves repeated mismatched opens leave running checkpoints/restart counters unchanged and the original implementation recovers the same input. A real Zig launcher test changes compiled code under an unchanged package version, observes startup refusal, then restores the bytes and successfully reopens. Installed-package smoke checks verify the exposed digest. Automated inference remains faux.
