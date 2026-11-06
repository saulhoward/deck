# Instruction capture: Pi 1.4.0 contract proof

**Status: executable contract proof; an explicit import is now available through the [plain client and hub API](instruction-import.md).** Deck still does not discover or automatically load `AGENTS.md`, and has no general public settings command. Admission capture version 3 remains an observation, not a frozen prompt bundle. See [settings](settings.md) and [implementation plan](implementation-plan.md).

## What the tests establish

These tests exercise actual Pi scheduling and provider-facing messages with a faux provider, not just hashes or a mocked scheduler. `getCurrentSystemPrompt()` replays positional system-message changes before assertions; finding old instructions somewhere in the entire transcript would not prove they are currently applied.

| Boundary | Observed behavior |
| --- | --- |
| Stored explicit instructions | Pi actually sends the configured text to the provider. Deck's busy configuration guard keeps it unchanged for queued follow-ups, steering and subsequent post-tool requests. |
| Workspace changes | A model's worker-backed read can return new file text while the system instructions remain the previously stored text. Workspace text is not automatically refreshed into instructions. |
| Idle configuration | A later explicit idle update changes the effective system instructions for new input. Retrying an admitted old request still returns its original receipt. |
| Foreground child | Pi copies the parent's stored instructions. The child uses them despite changed project files, and retains them after a later idle parent update. Independent ownerless tasks have a different inheritance policy; this does not establish project instructions for them. |
| Prepared request | Pi has committed the rendered system sections before `beforeRequest`. A raw Pi configuration change at that point does not alter that prepared request, but can affect the next request in the same input's tool loop. Raw mutation deliberately bypasses Deck's guard and is unsupported as a Deck settings interface. |
| Provider retry | A retry prepares again and can render different dynamic sections for the same logical input. Prepared-request capture is not whole-input capture. |
| Section error | With no previous section, Pi can proceed without it. A failed refresh can proceed with its previously shown text. Errors are reported, not ordinarily fatal. |
| `beforeRequest` error | Pi reports the extension error and can still call the provider without the intended replacement. Throwing does not implement required-file/offline/capture enforcement. Cancellation is a separate path; these tests concern ordinary failures. |
| Hook replacement | Returned replacement messages reach the provider but are not appended to canonical history. They are not by themselves a durable instruction record. |
| Task memo | A committed memo survives a process crash and can prevent a reread by that live generation task. Pi discards memos when deciding the task outcome. A memo alone is not retained settled provenance. |
| Compaction | Pi's summarizer makes its own model request without invoking generation `beforeRequest` hooks. A generation hook does not cover all inference. |

### Crash windows

The recovery tests SIGKILL child processes at explicit checkpoints:

1. **During section rendering, before prepared prompt commit:** after the source changes, recovery rereads and uses the new text. The previously read text was not yet fixed canonically.
2. **After prepared prompt commit, inside `beforeRequest`:** recovery sends the committed section even after its source file is deleted, without another section read.
3. **After a task memo commit, before hook return:** recovery reuses the memo even after source deletion. Hook-injected text reaches the provider, but is absent from canonical history after settlement.
4. **Deck with active and queued submissions:** unchanged-implementation recovery uses the stored explicit instructions despite changed workspace text and different startup binding defaults. Original submission IDs and instruction-hash observations remain unchanged; busy reconfiguration is still rejected.

Sources:

- `runtime/src/instructions.test.ts`: seven pipeline/guard/negative-contract tests.
- `runtime/src/instructions-recovery.test.ts`: four SIGKILL/recovery tests.
- `runtime/src/instructions.test.fixture.ts` and `instructions.test.support.ts`: crash probes using public Pi APIs, with the compatibility check/stamp before SQLite Harness resume.
- Existing [subagent](subagents.md), [settings](settings.md) and [compatibility](recovery-compatibility.md) tests cover additional inheritance, reservation-gap, cancellation/draining and original-build boundaries.

The probe sections use **test-only Node filesystem reads** to isolate Pi's behavior. The Deck effect test injects an assigned-worker stand-in and forbids a hub environment fallback. Neither is a production project-file reader or remote-worker validation. No external provider calls are involved.

## Rejected shortcuts

Do not implement project instruction capture by:

- hashing a file while leaving the prompt to reread its current contents;
- throwing from a prompt section or request hook and assuming inference stopped;
- using `beforeRequest` replacements plus a task memo as the only retained source record;
- swapping a shared conversation's settings around queued submissions;
- installing a hub-local file reader when the saved worker is unavailable;
- treating a generation hook as a policy boundary for compaction or every future inference path;
- adding another request scheduler, execution store or transcript mirror.

## Smallest safe production target

The **explicit, idle-only, per-conversation import** into Pi's stored `AgentDoc.instructions` is now implemented with real native read/receipt, public client and recovery tests; see [its contract and limits](instruction-import.md). It is not automatic per-input discovery or general settings configuration, and does not make arbitrary dynamic extensions reproducible.

The boundary established by this proof is:

1. The operator explicitly asks to import exactly `AGENTS.md` at the conversation's saved worker/cwd. No parent-directory traversal, global search, include directives, fallback host or automatic refresh. First bound the accepted UTF-8 instruction text to 32 KiB, within the existing native read limit. Missing/offline/invalid/oversized source fails without applying partial settings or starting inference.
2. Treat this as a configuration operation, not model input. Admit one replay-safe Pi administrative task only when canonical tasks and inbox are idle. Serialize this admission with ordinary Deck admissions. While it remains unfinished, reject new unadmitted model input/configuration; retrieving existing receipts must still work. Do not hold the Deck mutation line while waiting on worker I/O.
3. Perform the read through the saved worker and its retained operation receipt, using the Pi task identity. Fix the **returned bytes**, not a claim of an atomic worktree revision. Recovery must reuse the accepted read result rather than silently reread a changed source. Cancellation drains an issued read and must not subsequently apply configuration.
4. Atomically apply those exact instruction bytes through public Pi `configure(tx, ...)`, record source host/cwd/path/hash provenance in Pi, and finish the administrative task. Recheck the task's authority and canonical absence of other work/inbox inside that commit. This privileged apply must account for its own task, unlike the ordinary adapter guard that rejects every unfinished task. No second settings lifecycle tracker is needed.
5. Make replacement semantics explicit: importing replaces explicitly configured agent instructions; it must not accidentally append duplicate project text or erase unrelated choices. A later manual instruction change must invalidate/update the source label. Stored instructions may contain sensitive workspace text; a hash does not make that text anonymous, and normal Pi storage/backups are not encrypted.
6. Subsequent admitted work and foreground children use that stored text. File changes have no effect until another explicit idle import. Independent task creation must retain its documented separate inheritance policy rather than silently gaining project instructions. Public load/reload UX must expose that scope.
7. Before exposing a command, prove native assigned-host reads, offline/error/oversize refusal, stop/drain, crash after read and after apply, same-ID/lost-ACK recovery and save-before-send client identity. Native/internal and public client identity/recovery/presentation tests now pass. Reuse Pi tasks, native receipts and client draft machinery, not another replay loop.

This is a smaller contract than per-input instruction bundles: queued work does not get a private agent, and active work cannot switch to a newer imported version. Future automatic discovery, multi-file precedence, per-input bundles, ownerless-task defaults and full settings/provider capture need separate policies and tests. No new capture version or stronger provenance is fabricated for existing input entries.

## Run the focused proof

```sh
nix develop -c sh -c 'npm run check && npm run build && node --test runtime/dist/instructions.test.js runtime/dist/instructions-recovery.test.js'
```

Test/probe files are excluded from the installed runtime. The later import adds a production Pi task definition and explicit public client/API commands, but no model tool or automatic loader; its runtime/registry changes follow the normal idle-only deployment and implementation-compatibility policy.
