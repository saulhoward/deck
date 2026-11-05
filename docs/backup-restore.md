# Offline backup and restore

Deck can create a private, bounded backup of an **offline** state directory and restore it into a **new** directory. These commands never open Pi Harness, run migrations through Pi's storage adapter, resume/cancel work, submit inference or replay native effects.

```sh
# First stop serve using a safe authenticated restart path. Stop ACK/UI idle
# is not enough: the actual shared writer lock must have been released.
deck backup --directory /path/to/state --output /path/to/new-backup

# Optional: also copy stored auth.json, if present. Never includes ambient keys.
deck backup --directory /path/to/state --output /path/to/another-new-backup \
  --include-credentials

# Does not overwrite even an empty existing directory. Parent must exist.
deck restore --from /path/to/new-backup --directory /path/to/new-state

# Only after checking the recovery/rollback conditions below, explicitly serve
# the restored directory using the required original implementation and mode.
```

`backup` defaults to the usual state directory when `--directory` is omitted. Restore requires an explicit destination. Neither command stops a running hub for you. A live writer, surviving Pi child or other administrative command holding `writer.lock` makes the command fail before copying state. Both the Zig supervisor and its Node administrative child hold the inherited lock; supervisor death alone cannot expose a mixed snapshot. **Never delete the lock file** to force ownership.

If authentication exists only in the serving process environment, stopping it can lose the only available copy. Arrange a secure restart path first. `--include-credentials` copies only the stored credential file, not process environment variables, keychain contents or provider-side account state. No keys/codes should be pasted into chat, command arguments or logs.

## Contents and consistency

A backup is a directory containing `manifest.json` and a `files/` tree. Format 1 records each file's path, byte size and SHA-256. The completion manifest is fsynced and exclusively hard-linked into place **last**. Missing/malformed manifests are not complete backups. Existing output paths are never overwritten, and output inside the source directory is refused.

Included:

- `config.json`, preserving the random machine identity;
- `session.sqlite`, when present, including all canonical Pi conversations, instructions, IDs, submissions, checkpoints, Deck identity/captures/implementation stamp;
- published `worker/operations/*.json` receipts, including accepted-but-unfinished operations;
- `auth.json` only with explicit inclusion and when present.

SQLite's **backup API** incorporates committed WAL pages. Only the new snapshot is normalized to a standalone rollback-journal database and checked with `PRAGMA quick_check`; the source database/WAL is not checkpointed or rewritten. Pi is never opened. Native receipts/config/optional credentials cannot change through another cooperating Deck process while the shared writer lock is held. An initialized store without a Pi database can also be backed up.

Excluded: `writer.lock`, SQLite WAL/SHM sidecars, unpublished receipt/config/credential temporaries, known serve logs and macOS directory metadata. Unknown state files/directories cause refusal rather than silent omission of possibly newer authoritative data. This is deliberately conservative; it is not an arbitrary directory archiver. The workspace, installed runtime, executables, client draft cache, Rex sessions and external effects are **not** included.

Bounds: at most 10,000 included files, 512 MiB total payload, 2 MiB manifest. Copy/hash operations use fixed-size buffers. Directory listings are also bounded; excessive ignored temporaries/logs can cause refusal. Source/backup roots must be user-owned and private; read directories/files must be user-owned, not group/world-writable, and regular files/directories rather than symlinks or special devices. Stored credentials and manifests/config reads require private files. New directories/files are 0700/0600. Parent directories must already exist and be trusted against path replacement. Source/destination overlap is refused. Hard links are required for completion/config publication.

The filesystem permission boundary is not a sandbox against the same OS user replacing paths during execution. Hashes detect corruption but are not signatures: an attacker who can change payloads and the manifest can recompute them. SQLite quick-check is not exhaustive Pi schema/semantic validation. There is no encryption, remote backup service, cleanup policy or power-loss guarantee.

## Restore and incomplete destinations

Restore creates a fresh private destination, takes its writer lock and writes `.restore-incomplete` before copying payloads. Manifest versions, allowed paths, duplicate names, sizes, hashes and database integrity are checked. The destination config is staged privately and published only after every payload is verified/synced; the incomplete marker is then removed. No state is copied over existing data.

Updated `init`, `serve` and `backup` refuse any incomplete-restore marker, including one left after a process crash. Failure can leave a private partial directory; keep it offline and restore again into another **new** directory. There is no automatic completion/repair or recursive cleanup of a failed destination. A lost completion reply is ambiguous: inspect the destination/marker instead of overwriting it.

Config-last publication also prevents older `serve` implementations from opening an image whose payload is only partly copied. **Older binaries do not know the marker**, however: never run an old `init` against a failed/partial restore. Only use the old serving implementation after successful restore completion. The marker is an administrative publication guard, not another task lifecycle or recovery scheduler.

## Before serving restored state

1. **Retain the original immutable build and mode.** The canonical implementation stamp is copied unchanged. Unfinished work still requires that exact implementation under the [compatibility gate](recovery-compatibility.md). The backup does not include that runtime or provide cross-version migration. A different build may make the backup without resuming it; this does not authorize changed-code execution afterward.
2. **Reconcile rollback with the external world.** An old image forgets later submissions, model calls and native receipts, but cannot undo files/processes/provider charges. Resuming an older checkpoint or retrying a client draft can repeat work performed after the backup. The receipt uncertainty rule only protects operations represented in the restored image. There is **no exactly-once guarantee across rollback**. If the source ran after the backup, review/reconcile before explicitly serving the image.
3. **Use one recovery copy, not parallel clones.** Restored hub/machine/conversation identities and saved host/cwd bindings are unchanged. This is same-machine recovery, not worker reassignment or automatic workspace relocation. Do not run the source and restored copies as independent hubs with the same identity. Ensure original workspaces/effect hosts are correct; there is no fallback or automatic path rewrite. Escaped processes/workspace mutations are not made quiescent by the database lock.
4. **Resolve credentials and drafts separately.** Authenticated provider mode and credentials must still be available; restored OAuth tokens may have become stale. Copying credentials does not verify refresh/account access. Client drafts live outside the backup and share the restored hub identity, so examine them and the rollback boundary before `/retry`. Recovery never auto-submits a draft.

Backup/restore is a conservative recovery primitive, **not** a complete migration, downgrade, online snapshot or disaster-recovery policy. Even the normal storage adapter may perform schema work before the compatibility gate; future Pi upgrades still need separately tested policies and retained original builds.

## Validation

Automated checks cover SQLite WAL-only committed data and non-default page sizes, unchanged source DB/WAL, bounded copies, private permissions, optional/excluded credentials, receipt preservation, malformed manifests, path traversal/duplicates, symlinks, oversized files, corrupt databases and incomplete publication. Native tests cover active/orphaned Pi writers, administrative children retaining locks after supervisor death, interrupted restore rejection and retained/uncertain native effects not being replayed. A SIGKILL Pi fixture verifies pending task/checkpoint preservation, changed-code refusal and original-build recovery of the same input/capture. The installed-package smoke backs up/restores a seeded store, then serves and browses the restored canonical history with the private packaged Node outside the checkout. No real inference or credentials are used; local platform evidence remains arm64 macOS, with other platforms subject to CI.
