# Settings observations and safe configuration

## What Pi actually fixes

Pi 1.4.0 stores per-conversation choices in `pi.agent`, but resolves them against the current registry and host settings at use time. A prepared model request fixes its model/prompt/offered tools for that request. The next request can see new choices; tool phases resolve their agent separately. Host run policy is not persisted by Pi. A queued submission does **not** carry a private frozen agent/settings bundle.

Deck therefore does not claim that its admission metadata pins every later generation, tool implementation or workspace file. This remains a deliberate boundary before exposing general settings over HTTP/CLI. The runtime adapter's `configure()` method is internal; the only public configuration slice is the explicitly idle-only [instruction import](instruction-import.md), not a general settings or `/model` command.

## Observation contract

New `deck.input.data.capture` strings contain JSON version 3 with `semantics: "observed-at-reservation"`. They record:

- the pinned Pi API version and whether native tools are installed;
- resolved model, thinking level and agent cwd;
- saved tool-host machine ID/cwd;
- selected extension names and ordered model/callable/deferred tool names;
- SHA-256 of explicitly configured agent instructions, or null when absent;
- the writer's startup implementation digest, used by the [recovery compatibility gate](recovery-compatibility.md).

These are choices observed at the initial reservation, before Pi submission. They are neither a rendered system prompt nor a code/content snapshot. Hashing instructions avoids duplicating their text into admission metadata; it does not anonymize low-entropy contents, and Pi's own agent/transcript can retain the instructions themselves. Credentials are not capture inputs.

Deck does not automatically discover/load project instruction files such as `AGENTS.md`, snapshot provider defaults, or freeze a worktree. An [explicit idle-only import](instruction-import.md) is now available through the plain client/hub API, not as a model tool or automatic loader. A model can still read workspace files through tools. The startup implementation digest now covers Deck code and its declared installed dependency closure, Node and the local native executable; unfinished work cannot resume under a different digest. This is not code attestation or provider/workspace reproducibility. New extensions change observed selections and code identity; an older unadmitted observation can consequently fail repair with `settings_changed`, rather than silently adopting the new selection.

## Reservation repair

A reservation is not an ACK. Pi submission still uses the same durable request ID, with ACK only after Pi commits it. If a process dies between reservation and submission, retry must match the reserved text/mode **and** its observed choices. A changed observation yields `settings_changed` without submitting or replacing the reservation. Restore the original choices, or explicitly discard the local draft and start a new request ID. Discard never cancels already admitted work. No independent reservation replay loop is introduced.

For an already admitted input, retry returns its original Pi receipt even after settings changes or authentication failure; it never silently starts new work or rewrites the old capture. Legacy version-2 and pre-versioned captures remain byte-for-byte unchanged. Version 2 checks its original observations but has no implementation identity; pre-versioned repair checks only its original model/thinking/full chat binding. New provenance is not fabricated retroactively.

Owned subagent inputs use Pi's invocation-bound submission path rather than Deck's host reservation path; they retain delegation provenance and Pi agent state, not a fabricated host capture. See [foreground subagents](subagents.md).

This comparison protects the reservation/submit gap, not every later generation. Once admitted, Pi's canonical work resumes with its supported resolution semantics, subject to the startup implementation gate. Idle upgrades preserve historical receipts; new version-3 reservations refuse code drift before submission. Mutating loaded code or registry/policy outside Deck is not a supported per-input reproducibility mechanism.

## Internal configuration boundary

`DeckRuntime.configure()` serializes with Deck admissions. Inside one Pi commit it rejects changes while the conversation has any pending, running, waiting, sleeping or completing task, or queued inbox input. This includes parked/unregistered and background work, even if the activity presentation looks idle. The task/inbox checks and Pi `configure(tx, ...)` update are atomic; there is no parallel execution tracker. Stop acknowledgement is not clearance: effects must actually drain before configuration succeeds. Terminal tasks and historical failures do not permanently lock configuration.

The method also rejects clearing/moving the agent cwd away from its saved host binding. Task host/cwd reassignment needs its own future explicit contract; a Pi agent cwd update must not silently change prompt location while native effects still use another saved directory. New admissions reject such a mismatch if external code changed Pi directly. Raw Harness mutations bypass this adapter policy and are not a supported Deck settings interface.

## Validation and remaining work

Tests cover observed field/hash content, unchanged receipt/capture after idle configuration, unadmitted drift refusal across reopen and repair after restoring instructions, legacy reservation repair, active/queued task rejection, rejection while stopped file effects drain, authoritative pending-task checks despite idle activity, cwd coherence, and configured-vs-unread project instructions in a faux model request.

The [instruction-capture contract proof](instruction-capture.md) now exercises the actual provider-facing system prompt for queued inputs, steering, tool continuations, foreground children and SIGKILL recovery. It also proves important negative boundaries: request hooks/section renders fail open on ordinary errors, failed sections can retain old text, retries reprepare dynamic sections, hook-only replacements are not canonical history, task memos disappear at settlement, and generation hooks do not cover compaction. These tests do not add production project-file discovery or a loading command.

The [explicit import](instruction-import.md) now reads through the assigned native worker, records durable source identity and applies exact bytes atomically with its Pi task result. Ordinary new admissions block before resolving settings while that task remains unfinished; unrelated chats and existing receipts continue. Native crash/read/error/stop and installed-package tests cover this boundary. The plain client now saves its original binding/request ID before send, recovers a lost ACK with the same task and renders bounded read-only task/source snapshots without treating admission as application. Full per-input bundles, file precedence and settings/provider capture remain unfinished, as do compatible migrations/retained-build operations beyond the conservative startup gate. Do not implement them by swapping agents around queued inputs or adding a second scheduler.
