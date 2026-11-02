# Settings observations and safe configuration

## What Pi actually fixes

Pi 1.4.0 stores per-conversation choices in `pi.agent`, but resolves them against the current registry and host settings at use time. A prepared model request fixes its model/prompt/offered tools for that request. The next request can see new choices; tool phases resolve their agent separately. Host run policy is not persisted by Pi. A queued submission does **not** carry a private frozen agent/settings bundle.

Deck therefore does not claim that its admission metadata pins every later generation, tool implementation or workspace file. This remains a deliberate boundary before exposing settings over HTTP/CLI. The runtime adapter's `configure()` method is internal; there is still no wire configuration command or `/model` command.

## Observation contract

New `deck.input.data.capture` strings contain JSON version 2 with `semantics: "observed-at-reservation"`. They record:

- the pinned Pi API version and whether native tools are installed;
- resolved model, thinking level and agent cwd;
- saved tool-host machine ID/cwd;
- selected extension names and ordered model/callable/deferred tool names;
- SHA-256 of explicitly configured agent instructions, or null when absent.

These are choices observed at the initial reservation, before Pi submission. They are neither a rendered system prompt nor a code/content snapshot. Hashing instructions avoids duplicating their text into admission metadata; it does not anonymize low-entropy contents, and Pi's own agent/transcript can retain the instructions themselves. Credentials are not capture inputs.

Deck does not currently discover/load project instruction files such as `AGENTS.md`, hash extension implementation code, snapshot provider defaults, or freeze a worktree. A model can still read workspace files through tools. Names and a Pi version are provenance, not proof of identical implementation code or provider behavior across restarts.

## Reservation repair

A reservation is not an ACK. Pi submission still uses the same durable request ID, with ACK only after Pi commits it. If a process dies between reservation and submission, retry must match the reserved text/mode **and** its observed choices. A changed observation yields `settings_changed` without submitting or replacing the reservation. Restore the original choices, or explicitly discard the local draft and start a new request ID. Discard never cancels already admitted work. No independent reservation replay loop is introduced.

For an already admitted input, retry returns its original Pi receipt even after settings changes or authentication failure; it never silently starts new work or rewrites the old capture. Pre-versioned captures remain byte-for-byte unchanged. Their repair can check only the model/thinking/full chat binding they originally recorded; new fields are not fabricated retroactively.

This comparison protects the reservation/submit gap, not every later generation. Once admitted, Pi's canonical work resumes with its supported resolution semantics. Upgrading runtime code or changing registry/policy outside Deck is not a per-input reproducibility guarantee.

## Internal configuration boundary

`DeckRuntime.configure()` serializes with Deck admissions. Inside one Pi commit it rejects changes while the conversation has any pending, running, waiting, sleeping or completing task, or queued inbox input. This includes parked/unregistered and background work, even if the activity presentation looks idle. The task/inbox checks and Pi `configure(tx, ...)` update are atomic; there is no parallel execution tracker. Stop acknowledgement is not clearance: effects must actually drain before configuration succeeds. Terminal tasks and historical failures do not permanently lock configuration.

The method also rejects clearing/moving the agent cwd away from its saved host binding. Task host/cwd reassignment needs its own future explicit contract; a Pi agent cwd update must not silently change prompt location while native effects still use another saved directory. New admissions reject such a mismatch if external code changed Pi directly. Raw Harness mutations bypass this adapter policy and are not a supported Deck settings interface.

## Validation and remaining work

Tests cover observed field/hash content, unchanged receipt/capture after idle configuration, unadmitted drift refusal across reopen and repair after restoring instructions, legacy reservation repair, active/queued task rejection, rejection while stopped file effects drain, authoritative pending-task checks despite idle activity, cwd coherence, and configured-vs-unread project instructions in a faux model request.

Full captured settings/files semantics remain unfinished: choose an explicit generation-boundary snapshot/compatibility policy, resolve project-local file reads centrally through assigned workers, define extension/code/policy versions and upgrades, and test pending recovery before introducing public configuration or jobs. Do not implement these by swapping agents around queued inputs or adding a second scheduler.
