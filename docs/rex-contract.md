# Installed Rex contract and local workflow evidence

Deck can run its ordinary chat client inside Rex. An [internal Pi/native allocation foundation](rex-allocation.md) now persists intent, native receipts and full-ID bindings; [public local allocation/open/reopen](rex-open.md) is now implemented on a best-effort basis. Responsive-client health checks are not implemented. [Internal fresh inspection](rex-inspection.md) now samples exact saved objects without mutation or retained read receipts. [Allocation-bound startup observations](rex-startup.md) are now implemented and remain historical, not liveness claims. This opt-in test validates the installed CLI, the internal production effect path and the public best-effort open/reopen path. Pi still owns all conversations, inference, submissions and execution; Rex owns only its sessions, windows and terminal processes. No worker-local Pi runtime or transcript mirror is needed.

## Evidence and reproduction

Locally exercised on **aarch64-darwin**: historical Rex `0.0.1793377904-ge6592f`, commit `e6592f74969959db77f1f84261901ef599a025cf`, API revision **8**, and newly installed Rex `0.0.1793645657-gd018d2`, API revision **10**. The adapter supports this explicit revision set, not all versions ≥8; unknown/intermediate versions still fail closed. This is version-specific evidence, not a supported cross-platform/version matrix, GUI validation or a live provider test. The API 10 discovery initially failed the unchanged API-8-only allocation gate; compatibility was added only alongside renewed production-path and negative guard checks. See [replacement decision](rex-replacement.md).

```sh
nix develop
npm run build
nix build path:.
DECK_TEST_REX="/absolute/path/to/rex" \
  DECK_TEST_BINARY="$PWD/result/bin/deck" \
  node --test runtime/dist/rex-contract.test.js
```

Rex remains externally installed. The normal test suite skips this opt-in test; it neither downloads Rex nor connects to the operator's daemon. Both variables are required. `DECK_TEST_BINARY` may also point to a matching checkout build; the test supplies its runtime/Node paths.

The test starts a separate Rex server with:

- a short private temporary root, explicit Unix socket (0600), state directory and empty Lua config;
- `--restore=false`, no tailnet listeners and bounded session/block/window counts;
- an allowlisted environment with a scratch HOME/client cache and no provider credentials;
- explicit `--server unix:///...`, `--autostart=false` and bounded requests on every CLI call.

It creates only scratch sessions, executes an inert argv-reporting Node fixture and normal `deck agent --no-tui` clients, and cleans up that private server. A separate scratch Zig HTTP hub runs a test-only central Pi/faux entry. Its filesystem gate lets the test hold a generation while destroying its Rex session; those test readers are not production hub-local tools. No user sessions, live Deck store, API keys, OAuth, external provider requests or Rex server restart are involved.

The final case uses the production Pi task/native worker/client registration, forces startup before native-result apply, then deliberately drops the creation reply. The original task settles uncertain/unbound despite historical startup. An explicit [hash-matched receipt reconciliation](rex-reconciliation.md) recovers the full binding without replaying creation or changing that outcome, observing the `unbound` → `matched` join. It checks the saved binding/receipt, no model input/duplicate creation, then inspects the production path while running, after exit, after exact block removal and after session destruction. Fresh states remain separate from the unchanged historical startup/full binding, no read receipts appear and canonical history remains empty; responsive-client health is still unchecked. Files: `runtime/src/rex-contract.test.ts`, `rex-contract.test.fixture.ts`, `rex-contract.test.hub.ts`.

## Observed CLI contracts

Creation uses argv, not an interpolated shell command:

```text
rex --server unix:///SOCKET --autostart=false --timeout 2s \
  new LABEL --json --cwd CWD --shell=none --keep-open -- /absolute/deck agent --no-tui --port PORT --task CHAT_ID
```

This is an observed external CLI shape, **not** a new Deck command. Avoid ambient/default server, focused-block or label resolution in an adapter.

- `new --json` returns `{session_id,initial_windows:[{window_id,block_ids:[...],revision}]}`. Full IDs currently have `session:`, `window:` and `block:` UUID forms. Store complete IDs, never their display suffixes.
- `session.new_window` advertises only session ID, window label, layout and focus (declared closed, not proof that additional fields are rejected), with no idempotency or expected-revision/process-state guard. `block.close` likewise has no such guard. API 10's `session.create` ignores invented `expected_revision`/`idempotency_key` fields despite declaring `additionalProperties:false`: two identical scratch requests create distinct sessions. Metadata closure is not guard enforcement. This is not an atomic inspect-and-replace contract; Deck's public replacement is explicitly best-effort and sends no invented guard fields.
- `run --session FULL_ID --focus=false --json ...` creates a new window/block and returns `{window_id,block_ids:[...],...}`. It does **not** return a singular `block_id`. Replacing an exited client this way creates new Rex IDs while retaining the same Pi chat.
- `--shell=none` preserves literal argv, including spaces, newlines, quotes, Unicode, option-looking values and shell metacharacters. The supplied cwd is honored. No injected test file appears. This avoids login-shell evaluation; it is not a sandbox or a guarantee that a real Rex daemon's ambient environment contains no secrets.
- A terminal outlives the CLI connection that created it. Fresh scoped CLI connections see the same full session/window/block IDs and child PID after all three labels change. The scratch child receives its full block ID through `REX_BLOCK`; no full environment dump is needed.
- Scoped `block inspect ... --json` supplies block/window identity and flavor. `block call process --session SID --block BID` supplies `child` and `last_exit`. Optional `child`, `foreground` and `last_exit` can be omitted as well as null (after a client exit, the installed response omits `child`/`foreground`). Absent/null exit data while running **or when no child was started** is not client readiness; no running child or completed exit record means pending. `--keep-open` retains the block after the child exits; the fixture's exit code 7 remains visible and its startup counter stays at one.
- The native exact-ID `api call session.view` reports missing sessions with exit 3 and scoped `status=404 code=session_not_found` stderr; CLI `session inspect` only reports target-resolution prose. Fresh production inspection recognizes only the exact native failure after server verification, not generic errors/live-list absence. `session.view` contains placed blocks; `session.list_blocks` also contains detached blocks, so both scoped views are cross-checked. See [bounded adapter and limits](rex-inspection.md).
- Process inspection intentionally does not reveal the full argument vector. `argv0`, executable/script and labels cannot prove that an existing client selected a particular chat. The adapter must retain its original launch intent rather than reconstruct it from process display metadata.

The test uses `rex send` only to simulate a **human** typing an ownerless task message or `/exit`. Production model orchestration must use Pi admission/task tools, not type prompts into terminal editors.

## Creation is not idempotent or ready

The discovered `session.create` input schema advertises only `label` and `initial_windows`, with no idempotency key or caller-selected session ID. The probe deliberately discards a creation response for lookup, then enumerates its private server. One matching label can be found. Repeating the same creation makes a **different session with the same label**; label-based inspection then rejects as ambiguous.

This is a simulated lost ACK, not a tested production crash-reconciler. It establishes that **blind retry is unsafe**, not that a sole label match is authoritative provenance. Labels can also be renamed or copied. Zero matches does not prove that creation never happened: the object could have been renamed, closed or lost with its server. A single matching label does not prove it is the intended conversation.

Likewise a successful creation ACK is not application readiness. The existing client reconnects after losing a previously established hub connection, retaining its Rex child PID and Pi identity. But a **new** client exits with code 1 when its initial status request cannot reach the hub. Its keep-open Rex block still exists and does not restart itself when the hub comes back. The internal allocator now has an explicit [historical startup registration](rex-startup.md); it still must not call a block currently healthy because creation or registration once succeeded.

## Central ownership proved

The actual client selects an existing ownerless Pi task. Simulated typed input appears only in that task's canonical history, never main's. Restarting the scratch hub while globally idle preserves its hub/chat IDs; the original Rex client reconnects without creating another terminal or conversation.

After `/exit`, an explicitly created replacement block reads the same history without starting work. Separately, the test admits a held faux generation, destroys the entire Rex session and observes unfinished canonical Pi tasks/submissions still present. Releasing the test gate produces the final answer in the original chat, with no extra conversation. Rex destruction is therefore not Pi stop. This does not promise survival of native effects actually owned by a destroyed terminal.

Owned subagents remain externally inspection/stop-only. These tests do not widen their admission or lifetime semantics.

## Public workflow evidence

The opt-in suite now also calls public `rex_open`/`rex_status`/`rex_inspect` and the installed `deck rex open` CLI. It proves ordinary running-client reuse, a new window after exit, missing-terminal replacement in the same session, and missing-session recreation, with successful client startup and unchanged canonical history. Fresh aarch64-darwin installed Rex API 10 validation passed **11/11**; no live provider or user sessions were involved. This does not prove race-free or lost-reply-safe replacement; duplicate/manual-cleanup risk is accepted. See [usage and scope](rex-open.md).

## Retained boundaries for the best-effort local workflow

The user has [descoped Rex race prevention and lost-reply recovery](rex-replacement.md). Conditional/idempotent native mutation, broader uncertain-create reconciliation and exhaustive replacement crash/race tests are no longer shipping prerequisites. Concurrent opens or explicit retries after unknown outcomes may leave duplicates for manual cleanup. Further slices retain these narrower boundaries rather than introduce another execution catalog:

1. Keep allocation/launch intent and administrative tasks/results in Pi. Admission is not a ready terminal. A new save-before-send Rex client recovery/discard workflow is not required; existing model-input/import drafts remain unchanged.
2. Route only through the assigned worker and an explicit Rex server. Capture/verify server identity; no default/focused-target resolution, offline host fallback, automatic daemon startup or silent redirection.
3. Native code owns bounded argv-based CLI execution and an acceptance/result receipt under the stable Pi operation ID. Do not forward hub credentials. Retained success can repair a lost Pi apply, but is not proof that the external objects still exist.
4. Retain full server/session/window/block IDs from successful replies and keep earlier known bindings/results as history. No second task/session lifecycle database. Reopen samples exact IDs and reuses an observed running client or explicitly creates a replacement for an observed exited/missing client/session. Process presence is not responsive-client readiness; no new health protocol is required.
5. An accepted operation without a trustworthy creation result remains **uncertain**, even if a startup claim exists. The user may explicitly make a new terminal attempt without resolving that outcome, accepting duplicate/manual-cleanup risk. Do not erase the unknown outcome, adopt by label/process name, automatically retry creation or destroy possibly running terminals as cleanup.
6. Keep direct owned-child input disabled until its Pi ownership/lifetime contract is separately defined. Opening a view must not revive ownership, infer task success or start a second executor.

The [internal allocator](rex-allocation.md) implements Pi intent/task/result ownership, native saved-worker receipts/cancellation, full-ID binding and conservative no-replay recovery. Public open/reopen and explicit additional attempts are now implemented over that adapter. Only the explicit public path relaxes the legacy one-attempt-per-chat rule; old native operations/receipts remain unchanged. Responsive-client health, broader uncertain-create reconciliation, crash-recoverable Rex client drafts, server-restart restoration, GUI attachment/focus and remote Rex/Tailscale routing are not prerequisites for this narrower local workflow.
