# Installed Rex contract (not a public Deck integration)

Deck can run its ordinary chat client inside Rex. An [internal Pi/native allocation foundation](rex-allocation.md) now persists intent, native receipts and full-ID bindings; **public allocation/open/reopen and current health checks are not implemented yet**. [Allocation-bound startup observations](rex-startup.md) are now implemented and remain historical, not liveness claims. This opt-in test validates the installed CLI and that internal production effect path. Pi still owns all conversations, inference, submissions and execution; Rex owns only its sessions, windows and terminal processes. No worker-local Pi runtime or transcript mirror is needed.

## Evidence and reproduction

Locally exercised on **aarch64-darwin**, Rex `0.0.1793377904-ge6592f`, commit `e6592f74969959db77f1f84261901ef599a025cf`, API revision **8**. This is version-specific evidence, not a supported cross-platform/version matrix, GUI validation or a live provider test.

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

The final case uses the production Pi task/native worker/client registration, forcing startup before native-result apply and observing the `unbound` → `matched` join. It checks the saved binding/receipt, no model input/duplicate creation, then exits the client and verifies the observation stays historical with current health unchecked. Files: `runtime/src/rex-contract.test.ts`, `rex-contract.test.fixture.ts`, `rex-contract.test.hub.ts`.

## Observed CLI contracts

Creation uses argv, not an interpolated shell command:

```text
rex --server unix:///SOCKET --autostart=false --timeout 2s \
  new LABEL --json --cwd CWD --shell=none --keep-open -- /absolute/deck agent --no-tui --port PORT --task CHAT_ID
```

This is an observed external CLI shape, **not** a new Deck command. Avoid ambient/default server, focused-block or label resolution in an adapter.

- `new --json` returns `{session_id,initial_windows:[{window_id,block_ids:[...],revision}]}`. Full IDs currently have `session:`, `window:` and `block:` UUID forms. Store complete IDs, never their display suffixes.
- `run --session FULL_ID --focus=false --json ...` creates a new window/block and returns `{window_id,block_ids:[...],...}`. It does **not** return a singular `block_id`. Replacing an exited client this way creates new Rex IDs while retaining the same Pi chat.
- `--shell=none` preserves literal argv, including spaces, newlines, quotes, Unicode, option-looking values and shell metacharacters. The supplied cwd is honored. No injected test file appears. This avoids login-shell evaluation; it is not a sandbox or a guarantee that a real Rex daemon's ambient environment contains no secrets.
- A terminal outlives the CLI connection that created it. Fresh scoped CLI connections see the same full session/window/block IDs and child PID after all three labels change. The scratch child receives its full block ID through `REX_BLOCK`; no full environment dump is needed.
- Scoped `block inspect ... --json` supplies block/window identity and flavor. `block call process --session SID --block BID` supplies `child` and `last_exit`. `last_exit` is null while running **or when no child was started**, so null alone is not client readiness. `--keep-open` retains the block after the child exits; the fixture's exit code 7 remains visible and its startup counter stays at one.
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

## Minimum boundary before shipping allocation

Further slices must retain these boundaries rather than introduce another execution catalog:

1. Commit allocation identity and exact launch intent in Pi before a native effect. Pi owns the administrative task, ownership, cancellation and result. Save the public client's request identity before sending; admission is not a ready terminal.
2. Route only through the assigned worker and an explicit Rex server. Capture/verify server identity; no default/focused-target resolution, offline host fallback, automatic daemon startup or silent redirection.
3. Native code owns bounded argv-based CLI execution and an acceptance/result receipt under the stable Pi operation ID. Do not forward hub credentials. Retained success can repair a lost Pi apply, but is not proof that the external objects still exist.
4. Atomically retain full server/session/window/block binding and the task result in Pi. No second task/session lifecycle database. Reopen verifies exact IDs in their scope and actual client readiness; an exited client needs an explicit replacement operation.
5. An accepted operation without a trustworthy creation result remains **uncertain**, even if a startup claim exists. The [allocation-bound native-block observation](rex-startup.md) can inform future exact-server/object inspection or explicit operator reconciliation, but is not sole adoption authority. Neither labels nor process names authorize automatic adoption/recreation; do not invent a retry loop.
6. Keep direct owned-child input disabled until its Pi ownership/lifetime contract is separately defined. Opening a view must not revive ownership, infer task success or start a second executor.

The [internal allocator](rex-allocation.md) now implements Pi intent/task/result ownership, native saved-worker receipts/cancellation, full-ID binding and conservative no-replay recovery. It does not ship the entire minimum boundary above: current readiness/health inspection beyond the historical startup observation, uncertain-create reconciliation, public import-like drafts, explicit replacement, server-restart restoration, GUI attachment/focus, remote Rex/Tailscale routing and package/tool discovery remain separate implementation/validation work.
