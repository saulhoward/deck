# History

This is the consolidated change and decision record. It replaces the progress reports that were repeated across the former topic documents. For current behavior, use the [README](../README.md) and [Developer guide](DEVELOPER.md). Future work is in the [Roadmap](ROADMAP.md).

Test counts below are **recorded evidence for the named implementation stage**. Earlier counts do not describe a new run of the current tree. No count is a release guarantee or proof of deployment.

## Unreleased source-tree work

The work below records development since `17c2ff9`, including the documentation consolidation and subsequent task-navigation work. The latest worker slice follows `7ec363e`:

### Registered native files/bash workers

- Added explicit private worker initialization and peer/implementation identity projection, plus opt-in hub registry listeners. Both actual data/control socket peers are checked through the local Tailscale daemon and bound to a fresh connection generation.
- Routed native requests by saved machine identity over independent host pipes, preserving exact request bytes, receipt hashes and cancellation IDs. Remote descriptors use evented Node pipes, avoiding filesystem-threadpool starvation.
- Kept Pi, models, credentials, task ownership and scheduling exclusively at the hub. Added a standalone `deck-worker` executable and native-only Nix package.
- Bounded frames, handshake/control traffic, connection backoff and pending transport slots. Lost/malformed replies fence one generation, produce uncertain outcomes and never trigger effect replay or local fallback. Completed original-identity retries consult retained receipts; accepted-without-result stays uncertain.
- Added isolated TCP tests with injected verifier identities for lost replies, receipt preservation, cancellation under saturated result pipes, live-slot refusal, identity/digest mismatch, frame deadlines and independent host progress. Verified actual anonymous pipe inheritance into evented Node sockets. These are not real two-machine Tailscale acceptance evidence.
- A package run exposed a task-lock PTY test racing a quiet background poll. The UI correctly refused the overlapping send. Changed that test to pause polling in command mode and wait for explicit `client idle` before submitting; production behavior and deadlines were unchanged.
- Remote Rex/TUI routing, generic read-only receipt reconciliation, child terminals and jobs remain future work. The selected remote Rex API 9 endpoint is still not enabled for Deck allocation.
- Verified the installed standalone package's local OS-peer projection with the running Tailscale app, read-only and without attempting a connection. Its runtime closure excludes the hub package, Node, Pi and the Zig build compiler; package checks enforce the exclusions.
- No live hub upgrade or remote installation was performed for this implementation slice.

### Hub inspection and Rex-only task participation

- Gave the hub teal bars and hub labels; allocation-verified Rex task clients use slate-blue bars and a task-locked label. Retained canonical `main` IDs/metadata without migration.
- Hub task selection is read-only: no editor/paste, send, retry/discard, stop, instruction import, or settings mutation. Existing task drafts remain intact. `/hub` returns to the hub; `/main` is only a compatibility alias.
- Locked Rex clients against task discovery, creation, switching, and hub return at both the renderer and helper. Pinned client mode and hub-chat identity across private bridge replies. Plain and one-shot paths cannot grant non-Rex task participation; plain task status omits global task inspection.
- Hub `/task` saves/acknowledges creation before a separate Rex-opening request. A lost open reply never recreates the task or retries allocation automatically. Failed allocation leaves a saved task needing explicit recovery, not a standalone task mode.
- Updated native draw/color, draft/role/bridge-fencing, startup, and PTY tests. Updated isolated Rex integration to use actual managed startup for input and replacement rather than unregistered direct clients.
- During validation, the old real-hub creation test exposed live PATH discovery and created one local test Rex session. Removed only that verified test session by full ID and changed the test worker to an isolated PATH. Existing sessions and the live hub were left unchanged. Subsequent integration tests use a private isolated Rex server.
- Built and tested without upgrading the live hub.

### Remote peer and connection-generation foundation

After `82d149b`, added schema-backed explicit peer/host registration, a bounded native Tailscale verifier, and a read-only `remote-check` diagnostic. Added a native gate for fresh connection challenges, exact worker hello matching, and stale cleanup isolation. These do not enable remote transport, route effects, or implement jobs/subagent terminals.

Initial read-only checks against the installed Tailscale 1.98.2 macOS app validated self-node `whois` projection and refusal of a changed node pin. That initial check contacted no other machine and did not validate a two-machine link.

After the operator supplied a remote Rex endpoint, HTTPS certificate verification and explicit Rex server status succeeded over Tailscale. The endpoint reported API 9. A uniquely named disposable session ran only OS/tool-path checks: Darwin arm64, with Rex available but Deck, Tailscale, and Nix absent from the terminal's PATH. The probe session was removed by its returned full ID; existing sessions were not changed and no software was installed.

The real peer response omitted Tailscale's legacy `MachineAuthorized` field. Updated verification to require a running local backend and accept that documented omission without treating it as approval; explicit denial, malformed values, identity drift, and expired keys still refuse. Added regression tests and verified correct/wrong pins against the selected peer. The Rex peer is not yet a registered Deck worker, and API 9 remains outside Deck's allocation allowlist pending the remaining contract tests. No Tailscale settings or live hub changed.

### Zig TUI

- Added a scrolling chat view, multiline Vim-style editor, bounded history, help, and status bars.
- Selected libvaxis/vxfw for Zig rendering and terminal handling, with pinned uucode support.
- Added a client-only TypeScript bridge that reuses HTTP validation and draft storage. It opens no Pi store.
- Preserved exact saved-request retries, unsaved-prompt warnings, safe detach, and `--no-tui`.
- Added Unicode, paste, resize, malformed-pipe, recovery, and real-PTY tests. Disabled unsolicited OSC 52 clipboard handling.
- Kept fast background polls visually quiet. Slow polls show waiting after 500 ms; explicit actions and failures remain immediate.

### Model and thinking settings

- Added hub catalog and idle-only `model_settings` / `set_model_settings` contracts.
- Added the TUI `/model` picker and Shift-Tab thinking cycle without submitting or losing the prompt.
- Used medium defaults where supported and off for non-reasoning models. Preserved saved choices across restart.
- Added expected-selection concurrency checks, canonical ownership checks, and read-back after uncertain replies without mutation replay.
- Confirmed that `serve --model` is only a bootstrap default. New tasks inherit main's current saved choices.

### Terminal title and status

- Added title `Δ - {dirName}` from the client launch directory.
- Used Vaxis's existing OSC 7501 support with scoped `id=deck` and `app=deck`; no terminal-library patch was needed.
- Added opt-in read-only status from canonical Pi tasks and assistant outcomes.
- Kept stale/unknown observations distinct from idle, done, and error. Stop ACKs do not imply completion.
- Added change-only reporting, in-memory acknowledgement, initial-result baselines, title/status cleanup, and PTY checks.

### Task navigation and Rex-managed TUI startup

- Added `/tasks`, `/task TITLE`, `/select ID`, and `/main` to the TUI. Task pages are bounded and selection validates the exact requested chat before changing either bridge pin.
- Protected unsent prompt text by refusing switching/creation until it is sent or cleared. Unresolved requests also block switching. No extra editor store or transcript cache was added.
- Reused save-before-send task drafts and exact retries. A creation ACK reports the new ID without submitting input or switching the current chat.
- Added selected-task Rex status, explicit inspection, and best-effort open/reopen. Lost open replies never cause automatic retry; reads do not create terminals.
- Switched managed Rex launches to the TUI. The helper verifies hub/chat/history and allocation-bound native startup before enabling renderer input. Failure closes the helper rather than replaying registration.
- Added schema fixtures, native selection/cursor/scope checks, task/draft/creation-loss tests, startup fault tests, and PTY task/Rex controls. Extended the real mock-hub test to prove task input stays separate from main.
- Validated managed TUI startup, exit, replacement, and session recreation against an isolated installed Rex API 10 server. Remote hosts, child terminals, and jobs remain the next stages.

### Documentation consolidation

- Replaced the 34 topic documents with `DEVELOPER.md`, `ROADMAP.md`, and this file.
- Rewrote the README around the current main-chat → task-chat → review → detach/reopen workflow.
- Removed obsolete proposed commands and repeated implementation reports from current instructions.
- Used shorter sentences and consistent terms. Kept recovery, trust, and unverified-integration limits explicit.
- Preserved third-party license notices. This documentation change does not modify runtime behavior or deploy a hub.

## Commit history

Dates and IDs refer to the repository history, not release tags.

| Date | Commit | Main changes |
| --- | --- | --- |
| 2026-11-10 | `82d149b` | Added Zig TUI, model/thinking controls, terminal status, task navigation, managed Rex TUI startup, and consolidated guides |
| 2026-11-10 | `17c2ff9` | Completed local native/client contracts, bounded HTTP, and shared failure policy; added local Rex defaults and status/login contracts; migrated to Zig 0.17.1 |
| 2026-11-09 | `7a74d74` | Added validated history/live views and public best-effort Rex open/reopen |
| 2026-11-09 | `18a8d8b` | Extended mutation/administrative ACK and chat-discovery contracts, generated arrays, and client fault tests |
| 2026-11-08 | `6234ba7` | Added schema generation, exact-object Rex inspection, and retained-creation receipt reconciliation |
| 2026-11-05 | `87ba104` | Added explicit instruction import, sampled bash previews, internal Rex allocation, and startup registration |
| 2026-11-05 | `544b8ac` | Added task control, foreground subagents, implementation recovery guards, live progress, and offline backup/restore |
| 2026-11-02 | `aad1522` | Guarded idle settings changes and unadmitted reservation repair against drift |
| 2026-11-02 | `30b0b4a` | Built the local hub/client prototype, durable chats/drafts, providers, native tools, and supervision |
| 2026-11-01 | `57d14cb` | Bootstrapped Deck and documented central Pi ownership |

Git retains the committed versions of the removed documents. The unreleased details are summarized above and in the current developer guide.

## Design decisions

### Central Pi, not replicated worker conversations

An early proposal placed Pi runtimes on workers and copied transcripts into a hub archive. Deck rejected that topology. One hub-owned Harness/store owns every conversation and model call; workers supply host effects.

Direct task chat means selecting that task's conversation through the hub. It does not mean independent inference during a hub outage. This removes transcript replication, per-worker model credentials, duplicate conversation identities, and a second admission authority.

The source comparison with `jessfraz/agent` used commit [`7147c1c`](https://github.com/jessfraz/agent/tree/7147c1c21a736eafc7d9e6b3769f5c548630e6bd). A later review of the renamed `jessfraz/beep-boop` used [`8466b59`](https://github.com/jessfraz/beep-boop/tree/8466b59dfd5073ddbe01dc63669817a7aaa41b20). These were source reviews, not executed deployment evidence. Deck kept lessons about exact-object inspection, validated contracts, and identity-preserving reconnect. It did not adopt source triage, task-outcome reporting, or the broader automation product.

### Interactive terminals and headless jobs

After documentation consolidation, the target architecture was clarified:

- Every chat continues to use the hub's Pi runtime and store.
- An interactive task gets a named Rex session on its execution machine. Its subagents get named terminals inside that session. These terminals use Deck's TUI.
- Closing and explicitly reopening a session retains the existing task conversation; it does not create another agent or replay input.
- Scheduled jobs and their children run through registered host connections without Rex sessions or terminals.
- A job reuses its persistent Deck task and Pi conversation across runs. Each run has a distinct admission identity and captured file settings.

This records a design requirement, not completed remote/job support. It also does not upgrade existing admission observations into full file captures. The [Roadmap](ROADMAP.md#next-implementation-sequence) separates local TUI work, remote host transport, child terminals, and scheduled runs.

### Pi primitives before new machinery

Tests confirmed Pi's steering, one-at-a-time follow-up, abort, and owned-child behavior. Deck did not add a separate FIFO queue or task lifecycle. Task metadata groups work; Pi submissions and outcomes describe execution.

Pi 1.4.0 lacks public transaction-bound input submission. Deck therefore uses a reservation followed by same-ID submission, with drift checks for explicit repair. An admission capture is an observation, not a frozen per-input agent.

Instruction tests also ruled out prompt-hook shortcuts. Ordinary hook/section failures can fail open; retries can prepare again; memo and hook-only data do not supply permanent settled provenance; compaction bypasses generation hooks. Deck chose explicit idle-only import into stored instructions instead of claiming automatic file capture.

### Schema-first boundaries

Deck chose authored JSON Schema with generated Zig/TypeScript types and validators, rather than generating the authoritative schema from one implementation language. Semantic guards remain responsible for ownership, identity, byte limits, and replay safety. Generated views do not replace retained bytes or define a complete Pi archive format.

### Rex remains best-effort

Isolated tests established literal argv, stable full IDs, keep-open behavior, exact native missing-object evidence, normal hub-connected clients, and independent central Pi execution.

API 10 accepted invented `expected_revision` and `idempotency_key` creation fields without enforcing them. Repeated creation produced distinct sessions. Metadata that says an object is closed did not prove conditional creation.

The local scope therefore permits explicit best-effort replacement and manual duplicate cleanup. It does not promise atomic inspect-and-create or recovery of every lost creation reply. This exception is limited to terminal management. Input deduplication, file/bash uncertainty, retained receipts, and no automatic replay remain unchanged.

### Toolchain and terminal library

Zig moved from 0.15.2 to stable 0.17.1. The migration adopted explicit `std.Io`, process initialization, descriptor inheritance, and child reaping without changing wire/hash/receipt formats. Node stayed on 24 and Pi dependencies stayed on 1.4.0.

Vaxis was selected at `74b7d916c8879e5379f428ea8c4d43d1a1bb061b`, which explicitly supports Zig 0.17.1. Tuile was reviewed at `efb5cb736c73a50f4c8d22e12d2887cf2bd38bac`; its older Zig/Crossterm integration was a poorer fit. This was not a general benchmark.

A reproduced Zig archive-cache root mismatch led to seeding package caches from fixed unpacked Nix sources. No source vendoring, compiler patch, or runtime dependency download was added. Vaxis already supported OSC 7501, so terminal status needed no dependency change.

## Recorded automated evidence

All rows below describe prior scratch-state validation on **aarch64-darwin**, using mock/faux providers. Runtime totals include the listed opt-in skips. Counts describe each stage and are not additive.

| Stage | Zig tests | Runtime suite | Separate installed checks |
| --- | --- | --- | --- |
| Administrative/schema slice | Passed | 257 total: 255 passed, 2 skipped | Package 1/1; isolated Rex API 8 10/10 |
| Discovery/history | Passed | 292 total: 290 passed, 2 skipped | Package 1/1; isolated Rex API 10 10/10 |
| Live views | Passed | 308 total: 306 passed, 2 skipped | Package 1/1; isolated Rex API 10 10/10 |
| Public Rex open/reopen | Passed | 326 total: 324 passed, 2 skipped | Package 1/1; isolated Rex API 10 11/11 |
| Local Rex defaults | Passed | 327 total: 325 passed, 2 skipped | Package 1/1; isolated Rex API 10 11/11 |
| Status/login and Zig migration | 18/18 at migration | 356 total: 354 passed, 2 skipped | Package 1/1; isolated Rex API 10 11/11 |
| Completed client foundations | 28/28 | 382 total: 380 passed, 2 skipped | Package 1/1; isolated Rex API 10 11/11 |
| First TUI | 36/36 | 392 total: 390 passed, 2 skipped | TUI + package 11/11; isolated Rex API 10 11/11 |
| Model settings | 38/38 | 400 total: 398 passed, 2 skipped | TUI + package 13/13; isolated Rex API 10 11/11 |
| Terminal status | 40/40 | 402 total: 400 passed, 2 skipped | TUI + package 14/14; isolated Rex API 10 11/11 |
| Task navigation and Rex TUI startup | 42/42 | 422 total: 420 passed, 2 skipped | TUI/startup + package 34/34; isolated Rex API 10 11/11 |
| Remote verification foundation | 46/46 | 439 total: 437 passed, 2 skipped | Remote/TUI/startup + package 51/51; isolated Rex API 10 11/11 |
| Selected remote Rex peer verification | 47/47 | 448 total: 446 passed, 2 skipped | Remote/TUI/startup + package 60/60; isolated local Rex API 10 11/11; separate remote API 9 probe as described above |
| Hub inspection and Rex task lock | 48/48 | 456 total: 454 passed, 2 skipped | Installed remote/TUI/startup + package 68/68; isolated Rex API 10 11/11; three cross-builds |
| Registered files/bash worker transport | 55/55 | 462 total: 460 passed, 2 skipped | Installed remote/worker/hub identity/TUI + package 78/78; isolated local Rex API 10 11/11; hub and worker cross-builds for three targets |

The recorded stages passed their generated/TypeScript checks and Nix package/flake gates. The separate polling-debounce check passed 37/37 Zig tests and 10/10 targeted TUI tests before model settings were added.

Cross-builds passed for x86_64 macOS, x86_64 Linux, and aarch64 Linux at the migration, completed-foundation, TUI, model-settings, terminal-status, task-navigation, remote-verification-foundation, selected-remote-peer, hub-role, and registered-worker stages. These are compilation results, not runtime support claims.

Important validation details:

- Crash tests covered surviving writer locks, input reservation gaps, lost ACKs, retained/uncertain effects, original-build recovery, imports, and owned delegation.
- An orphan-writer fixture was corrected to separate supervisor SIGKILL from Node-owned stdin EOF. It then proved that the surviving writer still answered and excluded a second writer.
- PTY tests used rendered-screen/status waits rather than assuming raw terminal diffs or sleeps proved readiness. They checked input, resize, Unicode, drafts, detach, and terminal restoration.
- One TUI package run hit an existing four-second Rex-open HTTP timeout. The isolated test and unchanged package rerun passed. Deadlines were not widened.
- Installed Rex API 10 was `0.0.1793645657-gd018d2`. API 8 has earlier installed evidence; newer public-workflow API 8 coverage was fake-native/historical, not a new installed run.
- The terminal-status package was `/nix/store/y4r6hhjl9g5ki3gj0gzp5sgwcn64i4xm-deck-0.1.0-dev`.
- The task-navigation package is `/nix/store/d606fqp6yyr8l4f9yr1ka46zc7g5xsnf-deck-0.1.0-dev`. The prior build was retained at `/tmp/deck-before-task-navigation-result`. These identify development builds, not published releases or permanent GC-root guarantees.
- The remote-verification foundation package is `/nix/store/v3yspah0j4hm81mc0bk0gik59n64hfb8-deck-0.1.0-dev`; the prior task-navigation build was retained at `/tmp/deck-before-remote-boundary-result`. This package does not enable remote connectivity.
- The selected-peer verifier update is `/nix/store/64wbmzbkhy5vygw0ldskib3k5pw2q8ja-deck-0.1.0-dev`. Its predecessor was retained at `/tmp/deck-before-remote-peer-result`. It still does not enable remote Deck links or Rex API 9 allocation.

The registered-worker builds are `/nix/store/gz0pmppb42qjsx4yas9ldx2pmxdhwjn1-deck-0.1.0-dev` and `/nix/store/0q3yf43c2qqylbip07qd6073xnzlkava-deck-worker-0.1.0-dev`. The preceding hub-role package is retained at `/tmp/deck-before-worker-result`. These are tested development artifacts, not deployment or a real two-machine acceptance claim.

## Manual evidence

The user reported successful live API-key inference, file write/read/exact edit, bash output/cwd checks, foreground sleep cancellation, detach/reconnect, and unsent-draft recovery across client exit and hub restart. The user also confirmed the default local Rex open workflow.

These reports do not establish live ChatGPT OAuth/refresh, model delegation, exhaustive crash windows, remote workers, or all terminal platforms. No external provider calls occur in the automated evidence above.

## Deployment boundary

The recorded builds and tests did not restart the live hub, alter credentials, or use the user's Rex sessions. Previous immutable packages were retained during development. Build success is not deployment.

The TUI, model settings, and terminal status were still source-tree work at consolidation. Full settings/status behavior needs compatible hub and client builds. Upgrading remains a separate operation after **all hub work** has settled, with the original build available for recovery.
