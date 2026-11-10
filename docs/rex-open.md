# Public local Rex open/reopen (best-effort)

The local workflow now exposes the existing Pi/native Rex adapter through generated, validated hub commands and the plain client. Pi still owns conversations, inference and administrative tasks; Rex owns only terminals. This implements the [reduced best-effort scope](rex-replacement.md), not atomic or exactly-once terminal creation.

## First open

Start a normal Deck hub and create/select an **ownerless task chat** with `/task TITLE` or `/tasks`. Main and owned subagent chats cannot be allocated terminals by this workflow.

With Rex already running locally:

```sh
deck rex open --task CHAT_ID
deck rex status --task CHAT_ID
```

The default Deck port is 52800; use `--port N` for another hub. `/rex open` also works directly in a selected plain task chat, with no target flags.

First open resolves `rex` from the **hub/native worker's PATH**, not the client's PATH or a shell alias. Only absolute PATH directories are searched; empty/relative entries never search the task workspace. A bounded `rex --autostart=false --timeout 2s server status --json` read discovers Rex's local Unix endpoint and host/instance UUIDs. This is Rex's per-account local socket (including its normal local directory environment overrides), not a guessed TCP port, remote home host or focused terminal. The worker strips `REX_SERVER`, `REX_HOME` and focus/credential overrides. Missing Rex, a stopped server, unsupported API or malformed/non-Unix discovery fails before admitting a terminal task. **Deck does not autostart Rex.** Start the local Rex app/server yourself if needed.

All target overrides are optional and independent:

```sh
deck rex open --task CHAT_ID --server unix:///absolute/path/to/rex.sock
# Optional: --rex /absolute/path/to/rex --host-id REX_HOST_UUID --instance-id REX_INSTANCE_UUID
```

Omitted executable/server fields use the same local defaults; omitted IDs are discovered. Supplied IDs must match the observed server (use Rex's UUIDs, not Deck's machine ID). A complete explicit target remains supported. Percent-encoded paths such as `Application%20Support` are accepted; the decoded socket path still has a 100-byte limit, with no TCP/host aliases or URI query/fragment.

Use `./result/bin/deck` for the built package or `./zig-out/bin/deck` for a checkout build. The client executable launched inside Rex is selected by the hub/native launcher, not by caller-supplied argv. No provider credentials are forwarded to Rex.

`open` returns promptly with a Pi task ID and `status:"admitted",completion:"not_waited"`. That is **not** an allocation, startup or readiness receipt. `status` reads the latest attempt and full binding after settlement; `inspect` separately samples native presence. Commands print JSON plus explanatory text. They do not attach/focus a Rex GUI; use Rex directly with the returned session/window/block IDs.

## Subsequent opens and reads

```sh
deck rex open --task CHAT_ID --port 52800
deck rex reopen --task CHAT_ID --port 52800
deck rex status --task CHAT_ID --port 52800
deck rex inspect --task CHAT_ID --port 52800
```

`open` and `reopen` are aliases for the same explicit operation. In a selected plain task chat, use `/rex open`, `/rex reopen`, `/rex status` (or `/rex`) and `/rex inspect`. Optional first-open target flags may also be supplied to `deck agent`. Later opens use the saved target, without resolving PATH or the default server again—even if the environment changes. Partial overrides on a saved task must match its retained fields. There is no label-based discovery, automatic daemon start, host fallback or server migration; supplying a different saved target refuses. `status` and `inspect` never resolve defaults or create terminals.

Behavior:

| Current observation | Open/reopen behavior |
| --- | --- |
| No prior attempt | Resolves local defaults plus optional overrides; admits creation of a new session/client with the resolved explicit target. |
| Creation still pending | Reports busy; does not launch another attempt. |
| Saved client running | Returns `reused`; no new terminal or task. This does not prove responsiveness, current chat selection or connectivity. |
| Saved client exited / terminal missing | Admits a new window/client in the saved session; retains the old terminal if it still exists. |
| Saved session missing | Admits a new session/client. |
| Pending native process, unavailable, changed server, malformed/inconclusive inspection | Reports an error rather than treating it as absence. |
| Earlier attempt failed/aborted/uncertain with no current binding | An explicit new open admits a new session attempt. The old outcome need not be reconciled first. |

A new client uses the port of the current command and pins the same hub/chat. A reused running client is **not** retargeted to a new port: exit/close it explicitly in Rex if it needs replacement. The native adapter verifies the explicit server identity and only launches the hub's own Deck client. API compatibility remains the tested explicit set 8 and 10.

## Status, history and uncertainty

`rex_status` reports the latest task's state/result as `unallocated|pending|allocated|not_allocated|uncertain|aborted`, with a nullable current `binding` and nullable `previousBinding`. Bindings are creation provenance with `readiness:"not_checked"`, not presence/health. The last known older binding remains visible after a failed replacement; older attempts, inputs and results remain in Pi task records and native receipts. The latest-only startup slot is cleared for each new attempt, not maintained as a ledger of every prior startup. Existing receipt reconciliation can leave a binding alongside an original uncertain/aborted task outcome; status does not rewrite that outcome.

`rex_inspect` returns the existing bounded read-only snapshot with exact scope, sample timing and native observation. Neither read creates a terminal or model input. Reads are observations, not leases or an atomic combined lifecycle view.

The public client does **not** create a new durable Rex draft kind or automatically retry. A malformed/lost open reply may hide an admitted task or a successful Rex creation. Check `status`, `inspect` and Rex itself before explicitly opening again. **A new attempt may leave duplicate/orphaned terminals; cleanup is manual.** An unknown accepted native operation is never reissued to implement the new attempt: it gets a new Pi task/native operation identity. Repeating an already-admitted request ID with the same launch arguments retrieves its task rather than creating again. A reused observation is not a durable mutation receipt.

No automatic cleanup destroys old or possibly running terminals. No terminal open/reopen submits model input, repeats drafts, changes conversation/history/workspace, stops Pi work or grants direct input to an owned child. Existing input/task/import drafts and file/bash replay rules are unchanged. Server restart/migration, GUI focus/attachment, remote workers and responsive-client health remain separate work.

## Wire contracts

All three commands require the expected envelope `hubId` and a positive safe string `chatId`. Normal clients verify the hub identity/guard and `rexOpen:1` capability before sending. The closed command shapes in `contracts/wire.schema.json` are:

- `rex_open {chatId,requestId,port,target?}`: UUID request ID, current hub port, optional closed `RexTargetOptions` target with independently optional `executable,server,hostId,instanceId` fields (nonnullable). Discovery returns a generated, fully specified `RexOpenTarget` before admission. Returns a closed `RexOpenAck` with exact chat/request echoes, safe task ID, `admitted|reused`, `completion:"not_waited"` and `bestEffort:true`.
- `rex_status {chatId}`: closed `RexStatusSnapshot`, including current and previous binding projections.
- `rex_inspect {chatId}`: existing generated `RexInspectionSnapshot`, additionally correlated to the public request's hub/chat and checked for time/observation/exit consistency.

Private `rex_resolve` reads use the same ephemeral high-half correlation namespace and four-read cap as inspection, plus the native process slots shared with bash. They create no receipt, Pi work, terminal or readiness cache. The raw CLI result is projected to the four validated target fields; private server status/diagnostics are not exposed. Native allocation still verifies the captured identity before creation. Decoded Unix paths are compared for identity, while old retained endpoint spellings/receipts remain unchanged.

Validation covers client pre-send, private dispatch, actual serialized egress, native forwarding and client ingress. Private/unrecognized fields and malformed replies never become success or trigger redispatch. The native launch plan adds optional nonnullable `sessionId`; absent means new session, present means `rex run --session FULL_ID`. No invented Rex guard fields are sent and no terminal close command is added.

## Tests

Default-discovery coverage includes missing PATH binaries, partial overrides, wrong host/instance guards, unsupported API/non-Unix/malformed discovery, secret/routing environment exclusion, no admission/receipts on failed discovery, and saved-target reuse without rediscovery. Shared TS/Zig endpoint fixtures cover percent encoding, UTF-8, invalid escapes, decoded size limits and legacy spelling equivalence. The real-Rex suite now opens with **no target flags**, using an isolated PATH/runtime directory and a socket path containing spaces.

Default-discovery validation on aarch64-darwin: pinned Zig/TS/generated checks, `nix flake check path:.` and package build passed; **327 tests, 325 passed, two opt-in skipped**. Installed package smoke passed **1/1** and isolated installed Rex API 10 passed **11/11**, with no deadline widening or live-hub/user-session changes. The shared shape corpus now has 327 cases, plus 19 Unix-endpoint cases and the existing public Rex semantic corpus.

Shared generated shape and TS/Zig semantic fixtures cover the new commands and optional session plan. Pi/faux tests exercise reuse, exited/missing objects, new attempts after uncertainty, preserved prior results/bindings and no input/inference. Native fake-Rex tests exercise actual CLI → HTTP → Pi → Zig creation/new-window paths and forwarding rejection. Client faults preserve existing draft bytes without replay after malformed/lost replies; plain `/rex` commands also preserve an active input draft and detach a stalled open without sending stop. An opt-in isolated installed-Rex test exercises actual client startup, reuse, exit replacement, missing terminal/session recreation and unchanged canonical history. These are ordinary-path/error contracts, not race-free or lost-reply recovery guarantees.

Original public-workflow aarch64-darwin validation (before default discovery) passed: pinned Zig formatting/build/tests, TypeScript/generated checks, `nix flake check path:.`, and `nix build path:.`. Final package suite: **326 tests, 324 passed, two opt-in skipped**. Separately, installed-package smoke passed **1/1**, and isolated installed Rex **API 10** (`0.0.1793645657-gd018d2`) passed **11/11**, including the public workflow. The shared shape corpus has 315 cases, plus 15 public Rex semantic cases. API 8 evidence for the new workflow is fake-native/current code plus historical CLI contracts, not a fresh installed API 8 run. No live hub upgrade, provider calls, user Rex sessions or other-platform claim; existing deadlines were not widened.
