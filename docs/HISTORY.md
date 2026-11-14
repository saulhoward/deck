# History

This is the consolidated change and decision record. It replaces the progress reports that were repeated across the former topic documents. For current behavior, use the [README](../README.md) and [Developer guide](DEVELOPER.md). Future work is in the [Roadmap](ROADMAP.md).

Test counts below are **recorded evidence for the named implementation stage**. Earlier counts do not describe a new run of the current tree. No count is a release guarantee or proof of deployment.

## GitHub profile installation

The existing `packages.<system>.default` already supports `nix profile add github:saulhoward/deck`; no package alias or custom installer was needed. Checking every advertised default derivation exposed that pinned Nixpkgs 26.11 rejects `x86_64-darwin`. The flake now advertises only `aarch64-darwin`, `aarch64-linux` and `x86_64-linux`, rather than an unevaluable Intel macOS package. Earlier native cross-build evidence does not imply that the full Nix dependency closure is supported. The README now documents direct installation, prerequisites, default-branch versus pinned-revision behavior, controlled upgrades and the worker-only alternative. CI adds a disposable-profile installation of the checked-out default package on its Linux/macOS runners, then invokes both executables and the existing outside-checkout package fixture through the profile path.

A public GitHub install into a disposable profile resolved `packages.aarch64-darwin.default` at `cae2a3a` to the previously validated full artifact, with profile entry name `deck`. Both CLI help checks and the package fixture passed (**1/1**), including private Node/runtime lookup, lazy provider imports without authentication, native tools, history and backup/restore. All three advertised systems passed flake evaluation (no cross-system builds); the native flake check and the new checkout-profile CI sequence passed, including its package fixture **1/1**. No package recipe or runtime changes were required. This records local Darwin-arm64 profile acceptance, not another machine or live provider/Rex acceptance; the operator profile, deployed links and live state were not changed.

## Automatic startup and Rex forwarding

**Implemented after `936a30a`.** `serve` now initializes fresh/default state under uninterrupted writer exclusion, refusing missing identity over an existing store. `deck hub` launches/reuses its managed local Rex session and exits; `--here` keeps direct-terminal use. Normal `deck agent` selects explicit/environment/local coordinator, keeps worker/cwd/terminal on the invoking machine, registers/reuses a detached native worker, and opens a required-problem/optional-description **Create & start** form. Auth selection and the single hub Pi runtime/store remain unchanged.

- Rex API 14 provides the documented forwarding primitive. The temporary test CLI is preview.19, commit `ad5a836cb95bf1685a2b2976762949c44f1d0828`; its downloaded Darwin-arm64 archive was size/SHA-256 verified. No operator install was replaced. Allocation support explicitly adds 14 to 8/10; forwarding accepts exactly 14, not an open-ended minimum revision.
- Native owns authenticated host/account/instance observations, loopback-only session-scoped forwards, eight pinned enrollment slots, generation gates and worker process/receipt lifetime. No Tailscale peer identity is invented for tunnels, and no direct remote HTTP/Tailscale fallback or terminal-scraping bridge exists. Same-host recognition needs authenticated equality, not matching URL strings. Uncertain startup leaves a possibly working daemon intact.
- Private startup records precede effects. Exact stable creation/adoption/input IDs preserve source bytes and omitted/empty description. Guarded native adoption proves the original private root, saved machine/cwd/client, full Rex objects and actual PID before claiming the block for the Pi allocation. The wizard becomes the task TUI in the same process/block; allocation startup verification precedes its one automatic initial-input attempt.
- List/resume resolves saved names to scoped IDs, reuses a running client and refuses replacement over an unconfirmed allocation. Read-only polling never retries a mutation. Recovery retrieves creation without opening/admitting; discard only clears local intent/drafts. Input-attempt markers are fences, not completion receipts. Managed launches and ordinary reopens preserve their client draft root. Native/Node client bridge environments exclude model/vault credentials and loader injection.
- Review fixed borrowed enrollment-body storage, typing lost during the form's initial read-only poll, and stale launch-fence discard after completion/recovery had already removed its index. Existing custom runtime-fixture tests now initialize state before adding unrelated fixture files, consistent with conservative initialization.

Initial focused evidence: `/tmp/deck-startup-new-fault-tests.log` records **five runtime fault/adoption tests passed** and native **78 passed / two opt-in skips (80 total)**. Tests cover lost creation/adoption ACKs, exact explicit retries, restart without mutation-on-poll, binding/claim drift, omitted/empty briefs, native form paste/navigation, no automatic input admission from allocation, and ordinary reopen dropping bootstrap-only authority. `/tmp/deck-startup-expanded-integration.log` records **three isolated API-14 tests passed**: local and remote-selected same-block/PID task startup, single initial input, detach/list/resume, worker reuse, automatic enrollment, assigned-worker reads and native bash cancellation with a final receipt before restart. The cancellation case injects a faux provider into a disposable runtime entry; transport, native effects and deadlines remain production code.

### Automatic startup validation

Final source validation (`/tmp/deck-startup-final-source6.log`) passed **80/80 native tests**, including forwarding and the opt-in verified worker/Rex relay, and **569 runtime/generator tests: 568 passed, one installed-package-only skip, zero failures**. The legacy opt-in relay fixture was updated for explicitly supported API 14, initial Insert mode and the current banner-free TUI. The expanded integration tests also inject the stale launch-fence/index-cleanup crash boundary and verify explicit discard does not stop the client or replay input.

The final Nix build (`/tmp/deck-startup-package4.log`) passed **558 runtime/generator tests: 553 passed, five opt-in skips**, plus outside-checkout installcheck **1/1**. Installed validation (`/tmp/deck-startup-installed-final.log`) passed **564/564 wrapper-mode tests**, with private API-14 cases enabled and no skips, plus **5/5 separate raw-native backup/compatibility fixtures**. Those fixtures intentionally bypass the wrapper's fixed runtime root; they are not five more wrapper-mode passes. Full and native-only worker artifacts:

```text
/nix/store/13d8x1qg3v7fb2d48shxmpv0dz6iqx6y-deck-0.1.0-dev
/nix/store/y2kyjicrvac9jnvj2vgvrj8vscs77jci-deck-worker-0.1.0-dev
```

ReleaseSafe full/worker cross-builds passed for **aarch64-linux, x86_64-linux and x86_64-macos** (`/tmp/deck-startup-cross.log`). The worker closure has no Node, Pi, full Deck package or compiler dependency. Generated-contract/type/format/diff checks and canonical documentation links passed. Both deployed result links stayed on the earlier `936a30a` artifacts throughout validation.

Intermediate full runs had test failures and are not counted as final passes. Test port probes now reserve the hub/enrollment pair outside the usual ephemeral-client range; readiness additionally checks fixture identity. A Nix PTY capture raced rendering, so it now waits for expected text/layout rather than a fixed sleep. Earlier subagent recovery/online-login failures passed focused reruns and the final full suites; no production deadline was raised. The final Nix and installed runs include the corrected PTY synchronization. A later build command timed out during package fixup after its tests passed; the final build was rerun through installcheck, not counted as complete from that timeout.

Final storage review added bounded/private `rex-workers.json` to offline backups and excludes the private `client` directory without traversal, including its independent worker/draft state. Unpublished native metadata temporaries are never promoted to registrations. Focused backup/enrollment checks passed **17/17** (`/tmp/deck-startup-backup-integration.log`); the final installed suite repeats backup/restore into a new directory, exact registration preservation, same-daemon reconnect and no native effect replay. The original hub is stopped before serving the restored copy; no divergent writers or live state were used.

These tests use private Unix Rex servers on one Darwin machine, not actual HTTPS/two-machine forwarding. Historical API-10/Tailscale acceptance is not evidence for the new transport. The operator preview.18/API-13 installation, deployed links and live state were untouched during implementation and validation. Live provider/vault/OAuth authorization, Linux TUI/runtime and new real-network acceptance remain separate gates. Commit/push/local deployment was separately authorized afterward; upgrading operator Rex or starting the live hub was not.

## TUI interaction and identity refinement

**Implemented after `b4542bb`.** Canonical main now has the fixed saved identity `hub` / `hub-v1`, preserving its former name claim and all task names, ordinals, runes and routing IDs. Its terminal title is `Δ - hub`, independent of workspace. Chat uses inline first-line markers (green `•` for user, only the agent rune for answers), without names or entry numbers. The sidebar centers agent names and subtitles; the hub has no subtitle and its fixed label does not animate. Input starts in Insert mode without the old prompt/mode banner. Footer model/thinking is right-aligned and colon entry lives bottom-left. All TUI slash commands have become colon commands; plain mode retains its separate existing line-command syntax. Normal-mode Space then `t`, `m` or `n` invokes the guarded task picker, model picker or new-task composer.

Normal-mode `v` hands the restored terminal to `$EDITOR` with the current unlocked prompt in a temporary private file. It retains the same bridge, scope and draft state, submits nothing, and applies successful valid output as one exact undoable edit. An owned foreground editor group receives terminal signals; failure or suspension preserves the old prompt. The client reclaims terminal modes/group, removes temporary files and resumes fresh observations. Pending requests, saved drafts and read-only inspection refuse editing. This is local OS-user execution, not a sandbox or remote editor; editor-managed backups/daemonized processes and SIGKILL cleanup are outside the guarantee.

Validation: native **69 passed / one opt-in Rex skip**; full source runtime/generator suite **549 total / 547 passed / two opt-in skips / zero failures**. PTY tests cover exact inline geometry, centered sidebar labels, right-aligned footer/command entry, initial Insert mode, literal slash input, all three leaders and authority guards. External-editor PTYs verify foreground/canonical TTY handoff, quoted argv/private files, successful exact output, nonzero/missing editor, oversized/invalid output, symlink/FIFO refusal, Ctrl-C, suspension and SIGTERM, prompt preservation and cleanup. Name tests cover the root-only rename, old-name reservation, stable tasks/runes and unchanged history. An older MCP-detach fixture was updated to press Esc before `:q`; the final full run verifies detach/reopen still leaves in-flight MCP work/grants unchanged. Evidence: `/tmp/deck-tui-refine-full.log` (native gates), `/tmp/deck-tui-refine-final-full.log` (final runtime suite). These are local Darwin/mock and injected-peer tests, not Linux terminal, live-provider or two-machine acceptance.

The full Nix package repeated **549 tests / 547 passed / two opt-in skips**, plus outside-checkout installcheck **1/1**. Installed TUI/naming/workspace/package checks passed **52/52**. Full and worker packages built; aarch64-linux, x86_64-linux and x86_64-macos cross-builds passed (compilation, not runtime acceptance). Evidence: `/tmp/deck-tui-refine-nix-tests.log`, `/tmp/deck-tui-refine-installed.log`, `/tmp/deck-tui-refine-cross.log`. Full artifact: `/nix/store/sy6ihnkrplwkz440q8qwj3msjd27pscy-deck-0.1.0-dev`; worker artifact: `/nix/store/rwgriwkdvv6ap48i15kbqa7afxqy2nx4-deck-worker-0.1.0-dev`.

Deployment links, running hub and live state were unchanged during implementation and validation; commit/push/local deployment was separately requested afterward.

## Vesper TUI and persisted agent runes

**Implemented and validated on 2026-11-14, after `6a6ad11`.** The TUI now uses a Vesper-derived near-black/gray/white palette, with green user headings and orange identity highlights. Main chat and input are centered at at most 80 terminal columns. The two-row composer expands while typing, sits between full main-pane rules, and has a two-line directory/branch and model/thinking footer. The right identity sidebar automatically collapses below 112 columns; `:sidebar-toggle` overrides it locally, including in narrow panes. Hidden sidebars move the identity to the footer. The sidebar stays otherwise empty. A bounded runic name reveal/pulse is display-only; retained names, message labels and terminal titles never animate.

Enter sends/creates from the prompt, Shift-Enter inserts a newline, and Insert Ctrl-J remains a fallback for terminals without enhanced keyboard events. Picker/command Enter and literal bracketed paste retain their own meanings. Reads wait for a quiet typing interval, but an already-issued request is never cancelled/queued/replayed. Markdown formatting covers headings, emphasis/code, lists/quotes/links and aligned/wrapped Unicode tables; narrow tables stack. Tool/note data stays plain, no HTML/images are executed/fetched, and durable message/draft bytes remain exact. Local git display reads bounded repository/worktree metadata only when the current directory is the displayed local workspace; remote/missing metadata is unknown, not inferred.

Each non-hub agent receives a persisted rune from an immutable 86-symbol Runic bank, cycling only after exhaustion. The canonical hub receives Δ without consuming a runic ordinal. Assignment and rollback share the creation transaction; retries/restarts retain symbols, and startup backfills missing runes without changing existing names, bindings, history or execution. Status/discovery/launcher/task tools and TUI projections carry the additive field. Agent headings and OSC titles use the symbol. Wire generation now supports closed bounded literal-string enums as native strings, retaining native enums for identifier-only sets.

Validation: native **67 passed / one opt-in Rex skip**; full Nix runtime/generator suite **536 total / 534 passed / two opt-in skips / zero failures**, plus outside-checkout smoke **1/1**. Installed name/workspace, TUI/task-authority and package checks passed **39/39**, no skips. PTY coverage includes sidebar thresholds/override, empty sidebar padding, centered Markdown/tables, prompt growth, exact Enter/Shift-Enter submission, named/rune headings, allocation-bound runic OSC titles, read-only/task locks, lost-ACK drafts, detach/reopen, and signal cleanup. Native tests exercise small/zero/extreme panes, safe cells, table wrapping and bounded/stale animation. Initial old-layout assertions and a vxfw u16 surface-area overflow were fixed before these final passes; the test driver's cached screen parsing avoids repeated full-capture work, not longer production/test deadlines.

Artifact: `result-vesper` → `/nix/store/2lhkg39gg25l55fqgi9hjr3b4jjpvcl0-deck-0.1.0-dev`. Evidence: `/tmp/deck-vesper-final-native.log`, `/tmp/deck-vesper-full-suite.log`, `/tmp/deck-vesper-nix-tests.log`, `/tmp/deck-vesper-installed.log`; wide/narrow PTY text captures in `/tmp/deck-vesper-full.log`. These are local Darwin/package/mock-provider tests, not a new real-Tailscale, Linux terminal/font or live-provider acceptance. The running hub, deployment links, registration and live state were not changed. No commit/push/deployment occurred during this validation.

## Default credentials, 1Password bootstrap and offline OAuth login

**Implemented and validated on 2026-11-13, after `d6c3673`.** Real `deck serve` now resolves optional private `~/.config/deck/.env` references, then selects an environment OpenAI API key or stored ChatGPT OAuth. The old `--api-key` spelling remains an alias. The chosen method is reported at startup/status and remains fixed for that runtime. Missing credentials and failed refresh refuse before Pi opens/resumes; OAuth refresh receives a 30-second resolution signal. Stored API-key records are not a startup source. Explicit OAuth login remains available even while the current runtime uses an API key.

- The pre-lock helper accepts only bounded, owned-private reference mappings, passes their validated snapshot to `op run --no-masking` as environment references, and execs the native hub after resolution. It does not let `op` reread arbitrary mutable dotenv assignments. Keys do not enter argv or Deck's credential file; op session/service/Connect tokens are removed before the hub handoff. Missing/failed op authorization never falls back. Mock, client, worker and login entry points do not resolve references. This is not a sandbox or output-redaction guarantee.
- `deck login openai` acquires the native state lock for an offline, auth-only interaction without a Harness. If the lock is held, it verifies the selected state's machine against the running loopback hub and pins its hub ID before using existing login RPCs. Wrong/missing hubs never authorize a second credential writer. Bare `deck login` remains an alias. SIGINT/SIGTERM cancellation uses the existing bounded login state, not transcript/admission machinery.
- Native testing found Darwin SETEXEC applies CLOEXEC before inherited-file actions. The login handoff now clears CLOEXEC only at the quiescent replacement boundary. Tests verify continued writer exclusion, no lock leakage into Node subprocesses, no Pi store creation and release on exit. The initial failed fixture run is not counted as a pass.

Final validation: **16/16** focused authentication/login tests; native suite **65 passed / one opt-in Rex skip**; final Nix runtime/generator suite **534 total / 532 passed / two opt-in skips / zero failures**, plus outside-checkout installcheck **1/1**. Installed authentication, TUI and package checks passed **30/30**, no skips. Logs: `/tmp/deck-op-final-focused.log`, `/tmp/deck-op-full.log`, `/tmp/deck-op-nix-tests.log`, `/tmp/deck-op-installed.log`. The final artifact is retained through `result-credentials`: `/nix/store/vznnyhdd2dgiib34wmskw3fhf6sysj0s-deck-0.1.0-dev`.

Tests used a fake op executable, fake OAuth credentials/providers, isolated state and loopback hubs. They did not read a real vault, trigger biometric authorization, perform live provider login/refresh, or validate Linux/Rex interactive authentication. 1Password setup and unattended service authorization remain operator responsibilities; MCP credentials keep their existing separate contract. No production credentials/configuration were changed, no live hub was restarted, and no commit/push/deployment occurred during this validation.

## Stable task agent names

**Implemented and validated on 2026-11-13, after `24554be`.** Hub, independent-task and child-agent metadata now retain `agentName` and `agentNameAlgorithm`. The immutable `wintermute-v1` word banks generate lowercase compounds, then numeric suffixes after 100 pairs. A central Pi transaction reserves each name across algorithm versions and advances a shared ordinal; task creation and naming commit or roll back together. Retries/restarts preserve names, children get their own names, and existing Deck metadata is backfilled before work resumes without changing history, briefs, bindings, creation hashes or receipts. Unmanaged Pi conversations remain unmanaged.

Names are human-readable identities **within a hub store**, not globally unique IDs or routing/authorization keys. The versioned registry in `runtime/src/agent-names.ts` allows new algorithms without renaming existing agents. Status, discovery and launcher metadata expose the name/version. The TUI labels answers with the saved name instead of `assistant` and includes names in its task picker; canonical message roles and numeric chat IDs remain unchanged. Binding projection was narrowed to machine/cwd so passing full parent metadata cannot copy the parent's name.

Validation on the final implementation:

- Four new naming tests cover 10,000 unique generated names, frozen examples, suffixes/bounds, concurrent creation, duplicate request recovery, transactional rollback, cross-version collisions, restart stability, paginated legacy backfill, unmanaged conversations and TUI projections. Existing child/launcher/settings tests now assert name preservation. Shared generated-contract fixtures reject invalid display names in both languages.
- Native suite: **65 passed, one opt-in Rex skip**. Final focused runtime/contract/launcher/child/TUI suite: **31/31**, including real PTY checks that the saved name labels the mock answer and survives detach/reopen (`/tmp/deck-agent-names-final-focused.log`).
- Full Nix build: **524 runtime/generator tests, 522 passed, two opt-in skips, zero failures**, plus outside-checkout installed smoke **1/1** (`/tmp/deck-agent-names-nix-tests.log`). Package retained through `result-agent-names`: `/nix/store/3r1xjq4k1d12ngsqykvlacqmwizsp41f-deck-0.1.0-dev`.
- Installed TUI/package checks: **14/14**, zero skips (`/tmp/deck-agent-names-installed.log`). Generated-contract, TypeScript, formatting and diff checks passed.

These are local source/package/PTY checks, not a fresh two-machine or live-provider acceptance run. Validation was completed before commit/push or production deployment; no production state was migrated or service restarted during validation.

## Phase 4 remote launcher

**Implemented and validated on 2026-11-13, after `148b9fc`.** The explicitly approved remote bootstrap slice passed its source, installed and fresh two-machine gates. This is not deployment, general remote hub access or a per-human ACL system.

- Added the ordered `launcher` worker capability, explicit worker opt-in and trusted native runtime-route permission. It requires the approved Rex client/socket. Task and launcher scopes are mutually exclusive on the existing independently verified client channel; correlation includes authority and generation. No new network listener, worker inference runtime, execution queue or transcript replica was added.
- Added client-only `deck agent --launch-from ABS_WORKER_DIRECTORY` with bounded list, explicit confirmed create/open, inspection and private draft recovery. It never infers a task from cwd/labels/`REX_BLOCK`, enrolls a worker, selects another host, supplies executable/endpoint overrides, changes MCP grants or opens hub/child conversations. Local, inspector and managed task-client behavior remains separate.
- Creation uses machine-namespaced durable IDs and preserves exact briefs/bindings, including omitted versus empty fields. Save → create → exact ACK → clear → separate saved Rex request remains explicit. Creation starts no generation or grants. Creation retry recovers without opening; uncertain open drafts cannot be retried. Normal pinned task/allocation/block startup still precedes input, and opening never resets existing grants.
- Review added an explicit canonical-main exclusion to listing, even under misleading task metadata; opening already refused it. A regression assertion covers that case. The final artifacts below were rebuilt and the complete fresh real-machine sequence repeated after that change.

### Phase 4 validation

- Final native run, including isolated Rex API 10 and the installed launcher/TUI through verified-loopback worker routes: **66/66 passed** (`/tmp/deck-phase4-native-current.log`). Native coverage also tests missing approval, double authority, oversized launcher requests, exact forwarding, generation loss and forged cross-authority replies. Injected-peer tests are separate from production Tailscale acceptance.
- Final Nix runtime/generator suite: **520 total, 518 passed, two opt-in skips, zero failures**, plus outside-checkout installcheck **1/1** (`/tmp/deck-phase4-nix-final.log`). Eight launcher cases cover authority, exact briefs, private drafts/configuration, owner/cwd/canonical-main refusal, serialized rechecks, grant preservation, malformed ACKs, lost creation/open responses and restart recovery.
- Final installed regression run: **525/525**, no skips (`/tmp/deck-phase4-installed-final.log`). The **5/5** backup/compatibility fixtures ran separately against the raw installed native executable (`/tmp/deck-phase4-raw-final.log`), because the wrapper intentionally fixes the runtime root and is not the native code fingerprint. These are distinct evidence layers, not five additional wrapper-mode passes.
- Full/worker Nix packages and current-system aarch64-darwin flake checks passed. Worker closure contains Bash/readline/ncurses/libiconv, not Node, Pi or Zig. Both native binaries cross-compiled for **x86_64-linux, aarch64-linux and x86_64-macos** (`/tmp/deck-phase4-cross.log`); this is compilation, not runtime acceptance. Generated-contract, TypeScript, formatting and diff checks passed.
- Earlier fixture/command mistakes and intermediate runs are not counted as final passes. No production deadline was raised. The earlier full real-machine run at `/private/tmp/dp4-05c6h2hi` and its artifacts are superseded by the post-review run below.

Accepted final artifacts are retained through `result-launcher-final` and `result-launcher-final-worker`:

```text
/nix/store/yiasgd5m5cj48nhz0mjfvsc3rb5brjjk-deck-0.1.0-dev
/nix/store/0v0bxcbn655h23k3qlp117m2k1ssrrgc-deck-worker-0.1.0-dev
```

### Phase 4 two-machine acceptance

**Passed 2026-11-13 at 06:15:15 UTC, including cleanup.** Evidence is retained at `/private/tmp/dp4f-4ja04twf`. New stores, identities, registrations, profiles, drafts, scopes and a dedicated administration session were used. Administration/transfer used Rex; Deck used production Tailscale peer verification on all three channels. A verified immutable Rex application archive was restaged, not its old server state. No prior request IDs, allocations or process IDs were reused as authority.

- Hub OS node `nAzfeEZRBg11CNTRL` (`100.81.92.116`), worker OS node `nwPG27uaH611CNTRL` (`100.84.23.117`), user `7579044732280396`; Darwin arm64 pair. New hub `aa2e2ca6-f27c-4118-99d1-86468e8a8c8e`, hub machine `a42d330cf450bf987ccdc5c14eb4c162`, worker machine `2d1ea352df4443648b826f2466e09955`. Approval pinned `files,bash,rex,mcp,launcher`, the final binary digest and installed client/socket.
- Actual native SHA-256: hub `06d600f15e3ce28c81ca6c279dbc19eac218c6cb61a2146010b40f04d94a8bac`; standalone worker `9ddd4ada9de1c60113b8ff004a7f66489e1dc18a9e00202b4e94a8567986be63`. The installed runtime/client and native binaries were used without a substitute runtime entry or verification bypass.
- Missing launcher approval prevented the client endpoint from becoming available. After explicit approval, task **11** was created with an exact Unicode/empty/multiline brief. A byte-preserving private Unix fault injector withheld its creation ACK. The private draft survived worker/hub restart; explicit retry returned the same task and bytes, cleared that draft, and did not open Rex or generate input.
- Lost open and startup ACKs retained uncertainty: operation **21** was admitted once, the managed TUI became fenced, attempted input was not admitted, and neither open nor startup was automatically resent. Inspection remained available; retrying the open draft refused. After explicit inspection/discard and closing the fenced TUI, a new deliberate open **23** completed normal startup.
- One explicit remote TUI input produced one central mock generation. Its captured configuration and model-facing tools contained the selected worker profile and fixed-cwd hub service, at grant revision **1**. Reconnect and detach/reopen preserved history, machine/cwd and grants. The worker had no Pi process or SQLite execution store. This run exposed both approved aliases and ran a native discovery-only probe; it did **not** repeat MCP `tools/call` effects or use a live model provider. Phase 3 remains the separate real MCP-effect evidence.
- Normal `--new ... --confirm` created task **40**, separately admitted open **49** and reached its managed task-locked TUI with empty grants and no generation. Main/nonexistent/other-host tasks and a wrong hub were refused. Task **51** remained created when its unsupported API-9/HTTPS Rex default refused opening; no terminal was requested and no fallback occurred.
- Worker loss left the existing TUI process alive and stale. An offline creation attempt was not sent and created no draft/task. Reconnect did not replay it, change grants or add input. A later deliberate detach/reopen **59** recovered the same conversation/history. Exactly four worker operation receipts—**21, 23, 49, 59**—remain for the four intentional opens, not automatic terminal replay.
- Private Rex API 10 (`0.0.1793645657-gd018d2`) used a new Unix endpoint, host `cd9d6790-ea48-4b18-93dd-cea3999db1bf`, instance `cc543fd7-c8f2-476f-af8f-23e27046b57b`, no tailnet and no restored sessions. Owned TUIs, workers, fault injectors, private Rex and administration session were stopped; the socket was removed, hub listeners closed, Pi exited and the existing writer lock was reacquired. The operator API-9 server retained PID **84040**, host/instance/start time/version and its original session count. Existing deployment links, registrations, credentials and production services were untouched.

Evidence includes `acceptance-summary.json`, `fixture-sha256.json`, `final-run.log`, `exact-creation-draft.json`, the `proxy-*-proof.json` records, `creation-recovery-result.json`, `lost-open-inspection.json`, `lost-startup-screen.txt`, refusal results, `tui-input-history.json`, `reconnect-proof.json`, final history/grants/status, retained worker receipts, process proofs, `remote-cleanup.json`, `admin-cleanup.json` and `operator-server-preserved.json`. Helpers and saved IDs/PIDs are historical, run-specific evidence—not safely rerunnable instructions.

This accepts the narrow launcher workflow on the recorded pair, not Linux/x86_64 runtime support, GUI focus/desktop behavior, live-provider/MCP-service access, HTTP/OAuth, child terminals or scheduling. Acceptance was completed before commit/push. No production enrollment or production deployment occurred.

## Native stdio MCP (Phases 2/3)

**Implemented and validated on 2026-11-12, after `899fd26`.** Phases 2/3 passed their scoped source, installed and fresh two-machine gates below. Acceptance was completed before commit/push; it is not a deployment or blanket platform/service support claim.

- Added native MCP 2025-06-18 stdio supervision, one isolated process group per invocation/probe, pinned private host profiles and explicit exported catalogs. No Node/Pi plugin execution layer, downloads, ambient credentials, HTTP/OAuth, worker model loop or second transcript store was added.
- Added strict shared schema/JSON/response boundaries, duplicate-key rejection, bounded discovery and output, original argument/result preservation, separate MCP capacity, cancellation and persistent stale-revision fences. Native v2 acceptance precedes launch; exact retries recover evidence, changed bytes/cross-kind IDs conflict, and accepted-null receipts never trigger another execution. Historical native receipts remain unchanged.
- Added central Pi aliases/grants and memoized invocation bindings. Independent tasks start empty; owned children inherit selection. Only the trusted-local explicit-hub API may change idle/drained independent-chat grants. Workers require explicit MCP capability independently of Rex. A task can use its assigned worker and explicitly granted fixed-cwd hub services, never an arbitrary third worker or fallback host.
- Added native export/probe CLI and serve/worker configuration flags. Operator controls are API-only; there is no new TUI grant picker. Configuration and public catalog changes require controlled review/restart/regrant. External profile/catalog/credential files are not included in ordinary state backup; local v2 receipts and stale markers are.

### MCP validation

- Final Nix runtime/generator run: **512 tests, 510 passed, two opt-in skips, zero failures**, plus the outside-checkout installed package check **1/1** (`/tmp/deck-mcp-awake-nix-tests.log`). The suite includes 29 MCP cases covering strict schemas, original literals/results, private pins/credentials, bounded discovery/timeout, cancellation/isolation, stale/backup evidence, grants/withdrawal/inheritance, central Pi recovery and real local PTY detach/reopen.
- Final native run with isolated Rex API 10 explicitly enabled: **65/65 passed** (`/tmp/deck-mcp-current-native.log`). Injected-peer worker-link coverage includes MCP without Rex, lost delivery/exact-byte recovery and refusal before forwarding to unapproved/third hosts. This is separate from the actual Tailscale run below.
- Current installed binaries: **517/517 wrapper-backed tests** (`/tmp/deck-mcp-installed-current.log`) and **5/5 raw installed-native fixture tests** (`/tmp/deck-mcp-installed-raw.log`), no skips. The latter intentionally exercise temporary backup runtimes and code fingerprints: the wrapper overrides the backup fixture root, and hashing the wrapper does not identify the actual native executable. They are not five additional wrapper-mode passes. Installed MCP Pi fixtures resolve the package's actual adapters/dependencies, not checkout substitutes.
- Full/worker Nix builds and local aarch64-darwin flake checks passed. The worker closure contains Bash/readline/ncurses/libiconv, not Node, Pi or the compiler. Both binaries cross-compiled for **x86_64-linux, aarch64-linux and x86_64-macos** (`/tmp/deck-mcp-cross-final2.log`); these are compilation checks, not runtime acceptance on those targets.
- Review added explicit SIGPIPE handling, file **and directory** fsync for published MCP receipts/stale fences, and a Linux `statx` ownership check because Zig 0.17.1 does not expose callable `std.c.fstat` there. Closed stdin becomes EPIPE, not supervisor termination; pinning still does not eliminate executable-path replacement races.
- Earlier failed/aborted attempts are not counted as passes. Installed fixture ESM resolution was corrected; crash tests now observe the existing writer lock becoming free after asynchronous SIGKILL instead of racing a replacement writer. One Nix attempt had three timed-out PTY cancellations; the subsequent run prevented idle system sleep and passed without increasing production deadlines. Source/static, generated-contract, formatting and diff checks passed.

The accepted artifacts are exposed through separate `result-mcp` and `result-mcp-worker` links:

```text
/nix/store/7gsi0h1h6yyk4ssq0wmy7w429x8j6fww-deck-0.1.0-dev
/nix/store/254afmjyf0z3mcdjcfdpyz13jilqs7xs-deck-worker-0.1.0-dev
```

### MCP two-machine acceptance

**Passed 2026-11-12, completed at 22:52:53 UTC.** Fresh evidence is retained at `/private/tmp/dm3-r4koz9a5` on the tested Darwin arm64 pair. No Phase 0 stores, identities, scopes or run scripts were reused. Transfers/administration used a dedicated Rex session; Deck's effects/control/task-client channels used production Tailscale verification, not the injected test verifier.

- Hub OS node `nAzfeEZRBg11CNTRL` (`100.81.92.116`), worker OS node `nwPG27uaH611CNTRL` (`100.84.23.117`), user `7579044732280396`. New hub `6d70e074-398e-44a3-8f5b-4219e2f71e46`; machine IDs `d0458f26af1b02b4c898320bc62339dd` and `ca48661d99c5194423a5d557742dae81`. Worker approval pinned the exact `files,bash,rex,mcp` order and client/socket.
- Actual native executable SHA-256: hub `b0ee4cc1d0f5358f73b27ba0ccb30ded7c6154d1acbefe67358339ac18f9c87d`; worker `7abf24e4e395c6fa3dd8f2f697ad21c82c89db7db2fd1951954b3715079a6199`. Installed native binaries and installed Deck/Pi adapters were used with an external, normally fingerprinted faux-provider entry. Recovery gates paused that fixture before Pi opened until the independently verified native link was ready; production routing, receipt code and deadlines were unchanged.
- New task `11` retained its brief, worker/cwd and grant revision **1**. Read-only calls preceded mutations. Same-named tools on the worker and fixed-cwd hub service observed different workspaces and dummy accounts. Independent ungranted execution and a third-host grant were refused. Fixture credentials did not enter the public catalog or canonical history.
- Worker counter ended at **five intentional mutations**, hub counter at **one**. Detaching the actual remote Rex TUI left invocation **93** alive; explicit release completed it. Reopening preserved grants/environment, and fresh input through the registered task-locked remote TUI produced read operation **138** in central history without another mutation.
- Cancellation of **106** was checked beyond the stop ACK: its owned server exited and retained uncertain evidence, without rollback or replay. SIGKILL cut **114** after acceptance/mutation preserved the exact null receipt across worker/hub restart and surfaced `effect_uncertain`. Completed operation **125** survived lost delivery and reconnect; Pi recovered the exact original result and receipt bytes without a sixth mutation. Offline request **149** refused without using the explicitly granted hub service; reconnect neither accepted/replayed it nor refreshed grants.
- All **21** recorded faux model calls ran at the hub; worker state contained no Pi SQLite store. Node was a separately provisioned disposable server dependency, not a dependency of the worker package. An installed native worker probe also matched schemas with no Rex on PATH and sent no `tools/call`.
- Private Rex **API 10**, `0.0.1793645657-gd018d2`, used a new Unix endpoint/host/instance with tailnet and session restoration disabled. Test TUIs, workers, MCP groups, private Rex, keep-awake helper and administration session were stopped; the worker client socket was removed, hub listeners closed, and the writer lock reacquired. The existing API-9/HTTPS operator server retained its original PID, host, instance and configuration. Existing `result`/`result-worker`, live registrations, provider credentials and production services were unchanged.

Evidence includes `acceptance-summary.json`, `fixture-sha256.json`, `remote-final-evidence.json`, `isolated-accounts.json`, `detach-proof.json`, `cancellation-proof.json`, `crash-cut.json`, `recovery-result.json`, `completed-cut.json`, `completed-recovery-result.json`, `offline-result.json`, `tui-input-history.json`, `final-history.json`, `final-grants.json`, `model-proof.json`, `cleanup.json` and `operator-server-preserved.json`. Temporary administration transfer failures were reconciled from retained results/verified bytes, not blind mutation retries. Over-restricting the native supervisor's macOS session environment made Tailscale CLI verification refuse; retaining ordinary OS-session metadata fixed the fixture. MCP server environments remained separately explicit.

This accepts the stdio/assigned-worker slice for this pair, **not** Linux/x86_64 runtime support, live providers/services, HTTP/OAuth, desktop GUI behavior or the Phase 4 remote bootstrap launcher. A test server can return its supplied credential; this is not secret redaction or sandboxing. No commit, push or production deployment occurred.

## Phase 1 hub workflow and coordination

**Implemented and validated on 2026-11-12, after `ed9bf9a`.** This source-tree stage completes all three Phase 1 slices; it is not a commit, deployment or new two-machine/live-service acceptance.

- Added `deck hub` while retaining `deck agent`, normal client/inspection flags and foreground `deck serve`. Hub launches cannot masquerade as allocation-scoped task clients.
- Added bounded, immutable creation briefs, initial task instructions, the separate `/new` JSON composer, `/brief`, and plain-client equivalents. Creation starts no generation. Title-only hashes and old drafts stay unchanged; explicit empty brief fields remain distinct. Brief requests use a separate `create_task_brief` mutation plus exact echoed fields, so old hubs refuse before creation and incomplete ACKs cannot clear drafts or open Rex. Save → create ACK → clear → separate best-effort Rex open remains intact.
- Added bounded registered-host inventory and selection, including offline registered hosts, without enrollment, reassignment or fallback. Native `link_status` is a hub-local observation using a shared high-half read-ID namespace. A timed-out observation stays unknown with one retained correlation per route; late replies are consumed, not reused as fresh health. Task/child grouping changes only bounded-page presentation, never scan order/cursors or task lifecycle.
- Added explicit task-to-hub `hub_message` follow-up input. Sender and target authority uses canonical Pi identity/ownership as well as metadata. Captured model-request cutoffs and memoized causal envelopes preserve provenance and reply correlation through interruption. The eight-hop high-water budget cannot reset through a new tool call, a lower-hop message or later human input not in that model request. Missing provenance fails closed for new forwarding; exact admitted legacy receipts remain recoverable. No ACK/status/answer is automatically relayed. This is not a sandbox or a fan-out quota.
- Kept Pi as the only agent/store/scheduler owner, workers native-only, UI roles pinned, and Rex API 8/10 Unix-only allocation unchanged. No MCP, bootstrap launcher, child terminals or scheduler was added.

### Phase 1 validation

- Full runtime/generator suite: **483 tests, 481 passed, two opt-in integration checks skipped, no failures**. These skips were covered separately below. Coverage includes a scripted hub → task → hub exchange, the eight-hop loop and human reset, cutoff/lower-hop/unknown-provenance refusal, canonical hub identity despite misleading metadata, exact Unicode/empty briefs, host-observation timeout bounds, SIGKILL after modern and legacy admission, old-hub refusal, malformed ACK retention, and real PTY normal/lost-ACK creation flows.
- Native suite with explicitly enabled private Rex integration: **61/61 passed**, uncached execution. Ordinary runs were 60 passed plus that one opt-in skip. Shared TypeScript/Zig fixtures cover forms, byte limits, inventory, brief ACKs and native read contracts.
- Installed-target regression selection: **121/121 passed**, including package smoke, task/relay/worker boundaries, settings, plain creation and real PTY hub/task behavior. Separate installed private Rex contract: **11/11 passed**, API 10, isolated Unix endpoint with no tailnet. These are isolated tests, not real-peer acceptance or GUI-focus guarantees.
- `nix flake check path:.`, full package and native-only worker builds passed on aarch64-darwin. The worker closure has no Node/Pi runtime. Both binaries also cross-compiled for x86_64-linux, aarch64-linux and x86_64-macos; compilation is not runtime evidence for those systems.
- Contract generation/checks, TypeScript, Zig formatting, local documentation links/fences and diff checks passed. Test harness fixes used an atomic recovery checkpoint and distinct Escape/command PTY steps; no production deadline was increased.

Fresh builds are exposed separately as `result-phase1` and `result-phase1-worker`; existing `result`, `result-worker`, deployed services and the retained Phase 0 evidence were not replaced. Source/log verification and build artifacts do not constitute permission to restart a hub or change registered binary/client pins. At that checkpoint, native stdio MCP (Phase 2) was next.

## Phase 0 two-machine acceptance

**Passed on 2026-11-12 for the tested topology.** This is separate operator-run evidence for `ed9bf9a`, not a new implementation, release, or increase in the automated test counts below.

### Topology and provenance

- Two actual Darwin arm64 machines: hub macOS 27.2, worker macOS 27.0.1. Native data, control and task-client channels used production OS Tailscale peer verification with no injected verifier. The worker OS node was distinct from the embedded Rex service node.
- All remote administration and artifact transfer used the operator-approved Rex connection, not SSH or a file-transfer listener. The existing API-9 server remained unchanged and was not used for Deck allocation. With explicit approval, staged the existing tested Deck/client and standalone-worker packages side by side, plus a private signed Rex API-10 bundle with a worker-local Unix socket and Tailscale disabled.
- Tested packages: `/nix/store/0dfailbd9wg94yj6s38r3dwipxx52jfm-deck-0.1.0-dev` and `/nix/store/vh4rv5qk83b9fzbzb6x34nsmy9njkbg1-deck-worker-0.1.0-dev`. The independently compared native worker SHA-256 was `60cc5b49df62ec911378a35f63c96be438bc33e87083d70a2b5603d209870afb`. Private Rex was `0.0.1793645657-gd018d2`, API 10. Deck's runtime/client used packaged Node 24.21.0; a separate remote operator harness used existing Node 24.22.1.
- Used a disposable hub/store, worker identity/registry, workspace, credentials-free mock model and isolated client drafts. The first task input/reconnect/reopen checks used the unmodified installed runtime and TUI. Native fault tests then used a scratch runtime copy with only a scripted faux provider and an explicit original-identity native-receipt probe hook. Production routing, peer checks, scope guards, receipt formats and deadlines were unchanged. The fixture was fingerprinted normally and selected only after the hub was idle.

### Observed checks

| Check | Observation |
| --- | --- |
| Registration and launch | Independently matched worker binary/client/socket pins; all three real-peer channels paired; assigned-host allocation and task-locked TUI startup succeeded |
| Conversation ownership | Direct remote TUI input and mock answer appeared in the central task conversation, not main; no worker Pi store was created |
| Native effects | Write/read/exact-edit/bash executed in the saved remote workspace; local fallback paths remained untouched |
| Cancellation | Task-TUI stop cancelled the running native shell; retained receipt reported exit 143/`cancelled`, and the post-sleep effect was absent |
| Worker and hub reconnect | Same TUI PID and unchanged canonical history survived worker loss and an idle hub restart; fresh reads resumed without input replay |
| Known native receipt | Explicit byte-identical retry returned the original completed bash result without another append; changed-byte reuse of the same ID returned `conflict` |
| Accepted without result | Killed the test worker after a shell append and durable acceptance; restart plus explicit original-ID retry returned `effect_uncertain`, without another append |
| Late completion | Paused only the worker process beyond the unchanged heartbeat deadline while its shell finished; after resume/reconnect the late result was retained, but did not complete a newer request or alter the already-recorded uncertain history |
| Offline/unregistered host | An offline attempt reported that this attempt was not sent; an unregistered saved assignment refused its write without local execution |
| Lost input ACK | A test-only private Unix last-hop proxy dropped one successful admission reply. The real TUI retained its locked exact draft; fresh reads did not resend it. Explicit retry preserved scope/arguments, returned the retained admission and added no duplicate history |
| Scope and identity refusal | Hub-chat access, login, wrong allocation and superseded allocation scope were refused. Wrong executable and wrong peer-user pins never published a usable task-client endpoint; restoring the approved registration reconnected |
| Reopen | Explicit terminal exit/reopen retained the conversation and Rex session, created a new block, registered new startup, and revoked the old scope without replay |

The accepted-without-result receipt intentionally remains uncertain; it was not rewritten as success. Two deliberate loss-test calls each appended once. The later call's completed receipt does not resolve or replace the earlier operation's evidence.

### Evidence, cleanup and limits

Private evidence and retained state are under `/tmp/dp0-ln755f_4` on both machines. The hub-side `acceptance-summary.json`, `final-history.json`, `remote-final-evidence.json`, scope/draft/fault observations, exact operator/RPC request records and runtime fixture describe the run. The worker retains its original `worker.json` and receipts together; immutable package GC roots and the private signed Rex bundle are retained. These helpers contain run-specific identities: a repeat must use fresh scratch state and explicitly approved pins, not clone the store or blindly replay old requests.

All test hubs, workers, task TUIs, the private Rex server, fault proxy and operator-controller session were stopped. The worker socket was removed, and the remote test-process scan was empty. The original API-9 server's instance identity was unchanged. No active profile, existing Deck process, permanent worker service or production registration was replaced.

Staging exposed two operator-harness requirements, not changes to Deck: Rex control requests have a 65,536-byte bound, so transfers used smaller, hash-checked chunks; the copied macOS Rex executable needed its signed app-bundle metadata to satisfy its existing signature. No re-signing, production timeout increase, peer-validation bypass or API allowlist change was used.

This closes Phase 0 for this pair only. It does not validate live provider OAuth/inference, Linux runtime behavior, every crash window, desktop GUI focus, API-9 Deck allocation, MCP, remote bootstrap, child terminals or scheduled jobs. Those remain separate work and acceptance gates.

## Unreleased source-tree work

The work below records development since `17c2ff9`, including the documentation consolidation and subsequent task-navigation work. The files/bash worker slice follows `7ec363e`; the task-relay stage follows `1d4001c`:

### Verified worker-link task clients and assigned-host Rex

- Added an opt-in third, independently peer-verified socket to the existing worker generation, with separate bounded task-client capacity and inherited hub RPC pipes. No additional user login, public HTTP API, worker Pi runtime, transcript replica, or execution queue.
- Added a private worker-local Unix proxy and allocation-scoped hub dispatch. Hub, task, machine/cwd, ownership, allocation, block and approved client/socket are checked before dispatch and again at mutation admission. Status omits global inspection; remote task clients cannot log in, navigate/create tasks, enter the hub chat or allocate replacements.
- Added `worker init --client`, exact registry/hello client configuration matching, and assigned-host Rex resolution/allocation/inspection/receipt routing. Default workers remain files/bash-only. The standalone worker still has no Node/Pi/renderer dependency; the full TUI client is installed separately. API 8/10 and worker-local Unix endpoint gates remain intact; selected API 9/HTTPS access is not enabled.
- Added hub-only `/task-at` JSON targets to both clients, preserving exact host/cwd/title and existing durable creation drafts. Creation ACK precedes separate best-effort Rex opening; lost open replies do not recreate tasks. Existing bindings are never migrated or executed locally as fallback.
- Added real isolated three-channel socket/FIFO tests, including exact forwarding, exhausted client capacity with independent native cancellation, wrong third-socket peer refusal, and stale-generation/scope reply fencing. Hub runtime tests cover scope revocation at serialized admission, role refusal, non-draining stop ACKs, exact lost-ACK drafts and explicit deduplication.
- Added opt-in end-to-end tests using one central Pi store, the actual native transport/Unix proxy, a private Rex API 10 server and a real Zig TUI. Verified managed startup/input, same-PID worker-link reconnect, unchanged canonical history, terminal exit and explicit reopening of the same conversation.
- Initial validation caught terminal-test assumptions (combining Escape/command bytes and expecting quiet polls to erase retained error notices) and an unnecessary change to trusted-local stop dispatch exposed by its test double. Split Escape/readiness, observed actual freshness rather than notice dismissal, and restored the original independent local stop path. A package run also exposed the native cancellation test assuming a fenced request pipe remained writable: it now accepts `EPIPE` as well as EOF teardown, while still requiring the cancelled receipt and no subsequent effect. Production deadlines and no-queue rules were not widened.
- Tightened Unix endpoint ownership: capture its inode once, transfer listener ownership to the relay thread, and preserve replacement files/sockets during cleanup. Native tests now verify cleanup and execute uncached so changing opt-in integration environment cannot reuse a skipped/cached test run.
- This implementation slice left live hub/remote-machine configuration and sessions alone. Its isolated tests inject socket-peer verification; two-machine acceptance was still pending at that stage and was subsequently performed in the separate Phase 0 run above. Named child terminals and captured scheduled jobs remain future work.

### Registered native files/bash workers

- Added explicit private worker initialization and peer/implementation identity projection, plus opt-in hub registry listeners. Both actual data/control socket peers are checked through the local Tailscale daemon and bound to a fresh connection generation.
- Routed native requests by saved machine identity over independent host pipes, preserving exact request bytes, receipt hashes and cancellation IDs. Remote descriptors use evented Node pipes, avoiding filesystem-threadpool starvation.
- Kept Pi, models, credentials, task ownership and scheduling exclusively at the hub. Added a standalone `deck-worker` executable and native-only Nix package.
- Bounded frames, handshake/control traffic, connection backoff and pending transport slots. Lost/malformed replies fence one generation, produce uncertain outcomes and never trigger effect replay or local fallback. Completed original-identity retries consult retained receipts; accepted-without-result stays uncertain.
- Added isolated TCP tests with injected verifier identities for lost replies, receipt preservation, cancellation under saturated result pipes, live-slot refusal, identity/digest mismatch, frame deadlines and independent host progress. Verified actual anonymous pipe inheritance into evented Node sockets. These are not real two-machine Tailscale acceptance evidence.
- A package run exposed a task-lock PTY test racing a quiet background poll. The UI correctly refused the overlapping send. Changed that test to pause polling in command mode and wait for explicit `client idle` before submitting; production behavior and deadlines were unchanged.
- At that stage, remote Rex/TUI routing, generic read-only receipt reconciliation, child terminals and jobs remained future work. The selected remote Rex API 9 endpoint is still not enabled for Deck allocation.
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

The real peer response omitted Tailscale's legacy `MachineAuthorized` field. Updated verification to require a running local backend and accept that documented omission without treating it as approval; explicit denial, malformed values, identity drift, and expired keys still refuse. Added regression tests and verified correct/wrong pins against the selected peer. At that probe stage, no OS worker had been registered. API 9 remains outside Deck's allocation allowlist pending separate contract work. No Tailscale settings or live hub changed during the probe; the later Phase 0 run used a distinct OS-worker identity and private API-10 server.

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

### Native MCP rather than Pi coding-agent extension compatibility

After the task-relay implementation (`ed9bf9a`), the desired workflow was reviewed against the source. The follow-on plan now chooses **native MCP tools**, not reuse of arbitrary Pi coding-agent extensions.

- Preserve one hub-owned Pi Harness/SQLite store, model orchestration and canonical history. A task has a primary chat and optional Pi-owned children; task metadata is not a new execution lifecycle.
- Plan explicit name/problem/description metadata, grouped inspection, a clearer hub client entry point, bounded task-to-hub reporting, and a separately authorized remote create/open launcher. Current task-to-task tools and foreground children remain the baseline.
- Put MCP client transport and server process supervision in Deck's native layer. Pi owns durable invocations. Tool hosts can live on the hub or assigned worker and must not depend on TUI/Rex attachment.
- Bind access to explicit, versioned task tool profiles and grants, not the viewing terminal's Pi installation, cwd or environment. Keep service credentials at the designated tool host and model credentials at the hub; do not automatically import a Pi application's connections or secrets.
- Exclude a Pi plugin loader, lifecycle-hook/UI compatibility, provider-plugin import and worker agent loops. This does not remove internal Pi Durable adapters or rewrite historical fields named `extensions`. MCP servers are separately installed programs and may have their own runtime dependencies.
- Prioritize: real-machine baseline → hub/task coordination → safe one-host stdio MCP → assigned-worker MCP → remote bootstrap. Streamable HTTP/service authentication follows as a separate increment. New child terminals and captured jobs are deferred until the primary interactive workflow is accepted.
- Keep uncertain MCP writes uncertain; neither a JSON-RPC ID, a server annotation nor a local receipt proves external exactly-once execution. No automatic mutation replay, cross-host fallback or opaque Node/plugin shortcut is part of the plan.

This entry records a documentation/design decision, not implementation or new runtime test evidence. The [Roadmap](ROADMAP.md#next-implementation-sequence) supplies focused phase scopes, exclusions and exit gates; the [Developer guide](DEVELOPER.md#target-native-mcp-tools) defines the target boundary. No live machine, account, server or registration was changed by this planning work.

### Interactive terminals and headless jobs

After documentation consolidation, the target architecture was clarified:

- Every chat continues to use the hub's Pi runtime and store.
- An interactive task gets a named Rex session on its execution machine. Its subagents get named terminals inside that session. These terminals use Deck's TUI.
- Closing and explicitly reopening a session retains the existing task conversation; it does not create another agent or replay input.
- Scheduled jobs and their children run through registered host connections without Rex sessions or terminals.
- A job reuses its persistent Deck task and Pi conversation across runs. Each run has a distinct admission identity and captured file settings.

This records a design requirement, not completed remote/job support. It also does not upgrade existing admission observations into full file captures. The [Roadmap](ROADMAP.md#next-implementation-sequence) now prioritizes primary-task coordination and native MCP, while retaining child terminals and captured scheduled runs as later goals.

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
| Worker-link task relay / assigned-host Rex | 58/58 with opt-in Rex; otherwise 57 passed, 1 skipped | 468 total: 466 passed, 2 skipped | Actual isolated sockets/FIFOs, private Rex API 10 and real Zig task TUI; plain/PTY explicit-target creation; both executables cross-built for three targets (compile evidence only); not two-machine evidence |

The recorded stages passed their generated/TypeScript checks and Nix package/flake gates. The separate polling-debounce check passed 37/37 Zig tests and 10/10 targeted TUI tests before model settings were added.

Cross-builds passed for x86_64 macOS, x86_64 Linux, and aarch64 Linux at the migration, completed-foundation, TUI, model-settings, terminal-status, task-navigation, remote-verification-foundation, selected-remote-peer, hub-role, registered-worker, and worker-task-relay stages. These are compilation results, not runtime support claims.

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

The registered-worker builds are `/nix/store/gz0pmppb42qjsx4yas9ldx2pmxdhwjn1-deck-0.1.0-dev` and `/nix/store/0q3yf43c2qqylbip07qd6073xnzlkava-deck-worker-0.1.0-dev`. The preceding hub-role package is retained at `/tmp/deck-before-worker-result`. These are tested development artifacts, not deployment or a real two-machine acceptance claim. Before the task-relay package builds, those worker-stage outputs were retained at `/tmp/deck-before-task-relay-result` and `/tmp/deck-before-task-relay-worker`; building is not a live upgrade.

## Manual evidence

The user reported successful live API-key inference, file write/read/exact edit, bash output/cwd checks, foreground sleep cancellation, detach/reconnect, and unsent-draft recovery across client exit and hub restart. The user also confirmed the default local Rex open workflow.

These automated build/test reports do not establish live ChatGPT OAuth/refresh, model delegation, exhaustive crash windows, real two-machine worker acceptance, or all terminal platforms. The separate [Phase 0 record](#phase-0-two-machine-acceptance) supplies scoped two-machine evidence, not broader provider/platform acceptance. No external provider calls occur in the automated evidence above or the Phase 0 mock-provider run.

## Deployment boundary

The recorded builds and tests did not restart the live hub, alter credentials, or use the user's Rex sessions. Previous immutable packages were retained during development. Build success is not deployment.

The TUI, model settings, and terminal status were still source-tree work at consolidation. Full settings/status behavior needs compatible hub and client builds. Upgrading remains a separate operation after **all hub work** has settled, with the original build available for recovery.
