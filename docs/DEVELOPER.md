# Developer guide

This guide describes implemented behavior unless a section is marked **target design**. Read the [README](../README.md) for the user workflow, the [Roadmap](ROADMAP.md) for planned work, and [History](HISTORY.md) for earlier changes and validation.

## Contents

- [Architecture and ownership](#architecture-and-ownership)
- [Target interactive and scheduled architecture](#target-interactive-and-scheduled-architecture)
- [Source map](#source-map)
- [Build and test](#build-and-test)
- [Wire contracts](#wire-contracts)
- [Admission and drafts](#admission-and-drafts)
- [Settings and instructions](#settings-and-instructions)
- [Tasks and subagents](#tasks-and-subagents)
- [Native effects](#native-effects)
- [Read views and clients](#read-views-and-clients)
- [Rex integration](#rex-integration)
- [Providers and credentials](#providers-and-credentials)
- [Recovery and backup](#recovery-and-backup)
- [Change rules](#change-rules)

## Terms

- **Canonical state:** the authoritative records in Pi, not a client display or sample.
- **Admission:** Pi has accepted a request. The work may still fail or remain unfinished.
- **Receipt:** retained evidence of admission, native acceptance, or a result. Check which kind it records.
- **Deck task:** a persistent work grouping and chat. It is not an individual Pi execution task.
- **Pi execution task:** a unit of execution, such as a generation or tool invocation, owned by Pi.
- **Execution machine:** the assigned host for workspace and native tools, not a separate model runtime.
- **Ownerless task:** an independent task chat. Stopping its sender does not stop it.
- **Drain:** wait for already-issued work to settle after cancellation.
- **Fenced connection:** a failed connection that cannot accept more requests or apply late replies.
- **Atomic commit:** related changes become visible together in one storage transaction.

## Architecture and ownership

Current local implementation:

```text
Zig TUI -> client-only TypeScript helper --+
Plain client / CLI -----------------------+-> loopback HTTP -> Zig hub
                                                              |
                                                        private IPC
                                                              |
                                                   one TypeScript runtime
                                                   one Pi Harness/store
                                                              |
                                                     native effect pipes
                                                              |
                                                       Zig local worker
                                                       files, bash, Rex
```

Pi owns conversations, input queues, generation, tool tasks, checkpoints, and history. Zig owns transport, process supervision, native effects, and the TUI. Rex owns terminals. Registered workers execute native effects. Files/bash is the default; explicitly approved Rex workers also host task-scoped clients through the verified worker link. No worker owns a Pi runtime or transcript store.

Keep these boundaries:

1. Use one Pi writer per state directory. Never open a second Harness against a running hub's store.
2. Send all chat input through the hub. Clients do not run inference or replicate transcripts.
3. Use Pi documents and transactions for Deck metadata. Do not add a task scheduler, execution queue, or task-completion state machine.
4. Run effects only on the saved machine and cwd. An unavailable assignment must not fall back to the hub or another host.
5. Keep detach, stop, process exit, and history deletion separate. A stop reply acknowledges a request, not completed drainage.
6. Preserve request identities and retained bytes. An unknown outcome is not permission to repeat an effect.
7. Treat tool access as trusted-user access, not a sandbox or multi-user permission system.

The hub requires prior `init`. Zig holds a nonblocking exclusive writer lock and passes its descriptor to the Node writer. A surviving child keeps the lock after supervisor death. Shell and Rex children must not inherit it.

Unexpected writer exit or failed Harness closure stops the hub with a nonzero exit. There is no automatic respawn. Process checks detect death, not a live hang. Private-channel closure cancels owned shell groups and drains issued file work where possible.

### Target interactive and scheduled architecture

**Partly implemented:** local and assigned-host managed Rex task clients and verified native workers have isolated tests. Real two-machine acceptance is pending. Scheduled jobs and subagent terminals below remain target design.

Every chat uses the hub. One hub-owned Pi runtime stores conversations and runs interactive agents, scheduled jobs, and their children. Background execution uses Pi tasks in that runtime, not a new process or store for each job. Registered host connections carry native effects to the assigned execution machine. Model credentials stay at the hub.

| Work | Pi execution and history | Workspace and tools | Rex presentation |
| --- | --- | --- | --- |
| Interactive task | Hub | Assigned execution machine | One named session on that machine, with the task's TUI |
| Interactive task's subagent | Hub-owned child conversation | Inherited execution-machine binding | Named TUI terminal inside the parent task's session |
| Scheduled job | Hub background execution; stable job task/chat | Assigned registered host | None |
| Scheduled job's child agent | Hub-owned child execution | Assigned registered host | None |

For interactive work:

- The TUI lists, creates, and switches tasks. It shows saved Rex allocation separately from current terminal presence and agent activity.
- Opening a task in Rex routes through its assigned host and verified Rex server. It does not move the workspace or select an unrelated execution host.
- Task and child terminals run Deck TUI clients of existing hub conversations. They do not run another Pi engine. Labels aid navigation; full IDs establish identity.
- Closing a session does not delete its Deck task or Pi conversation. Explicit reopen restores access to the same chat without replaying input or starting another generation.
- Rex-owned processes can stop when their terminal is destroyed. This does not prove their effects were undone or that the agent completed.
- A child terminal does not change Pi ownership. Direct child input still needs defined input/lifetime rules; a new view alone grants no authority.

For scheduled work:

- Reuse the job's persistent Deck task and Pi conversation across runs. Individual Pi execution tasks and run admission IDs remain distinct.
- Each run has its own durable admission identity and captured file settings. A retry of that run reuses its original identity and captured contents; it does not reread newer files as the same run.
- Capture the specified configuration/instruction files through the assigned host. This is not a whole-worktree snapshot. Define capture timing, precedence, and failure rules before claiming a run is fully captured.
- Jobs and their children open no Rex sessions or terminals. Scheduling, recovery, and history inspection must not create terminal objects.
- Use Pi durable scheduling and ownership. Do not add a second queue, transcript store, or job-execution engine.

Remote task clients use the verified worker link and allocation-scoped hub dispatch. Rex connectivity alone does not authenticate a separate HTTP connection. An offline host keeps its assignment; neither interactive nor scheduled effects fall back to the hub. Current version-3 admission observations are not the required per-run file capture. See the [implementation sequence](ROADMAP.md#next-implementation-sequence).

## Source map

| Path | Responsibility |
| --- | --- |
| `src/main.zig`, `src/state.zig` | CLI, private state, writer lock, supervision, and administrative launch |
| `src/native.zig`, `src/runtime_paths.zig` | Explicit I/O/environment, process helpers, and runtime paths |
| `src/hub.zig` | Loopback HTTP, private command bridge, and reply validation |
| `src/tailscale.zig`, `src/remote*.zig`, `runtime/src/remote-contracts.ts` | Peer verification, private registrations, bounded outbound worker transport, and connection-generation fencing |
| `src/worker.zig`, `src/shell.zig` | Native effects, receipts, capacity, and cancellation |
| `src/rex*.zig` | Rex discovery, endpoint validation, creation, and inspection |
| `src/tui*.zig` | TUI widget, modal editor, client bridge, and terminal status |
| `runtime/src/deck.ts` | Pi adapter, saved chat bindings, admission, and settings |
| `runtime/src/main.ts`, `ipc.ts`, `protocol.ts` | Runtime startup, command dispatch, and framing |
| `runtime/src/host-files.ts`, `runtime/src/remote-files.ts` | Saved-worker tool adapters/routing; no Node filesystem or cross-host fallback |
| `src/worker_main.zig`, `src/remote_worker.zig` | Standalone native-only worker startup; no Pi/model runtime |
| `src/task_relay.zig`, `runtime/src/remote-clients.ts` | Bounded worker-link RPC and hub-side allocation/machine/task scope guards |
| `runtime/src/task-client.ts`, `task-target.ts` | Client-only Unix transport and exact explicit task-target validation |
| `runtime/src/client.ts`, `hub-client.ts`, `drafts.ts` | Plain client, bounded HTTP, and durable request drafts |
| `runtime/src/tui-bridge.ts`, `tui-session.ts` | Client-only adapter reused by the Zig TUI |
| `runtime/src/task-tools.ts`, `task-control.ts`, `subagent.ts` | Model task inspection, independent tasks, and owned delegation |
| `runtime/src/instruction-import.ts`, `instructions-view.ts` | Explicit import task and read-only provenance |
| `runtime/src/progress.ts`, `agent-status.ts` | Bounded live projections from Pi records |
| `runtime/src/rex-*.ts` | Pi-owned Rex attempts, startup, inspection, and receipt repair |
| `runtime/src/providers.ts`, `credentials.ts`, `login*.ts` | Provider mode, private credentials, and transient login |
| `runtime/src/compatibility.ts`, `backup*.ts` | Implementation gate and offline backup/restore |
| `contracts/wire.schema.json` | Authored source for Deck wire shapes |
| `scripts/generate-contracts.mjs` | Deterministic Zig/TypeScript contract generation |
| `src/*.test.json`, `src/*test*.zig`, `runtime/src/*.test.ts` | Shared fixtures, native tests, and runtime/fault tests |
| `scripts/tui-pty-test.py` | Real-PTY input, screen, status, and restoration checks |
| `flake.nix`, `flake.lock`, `build.zig*`, `package*.json` | Toolchain, dependency, build, and package definitions |

Paths in the table are relative to the repository root. Internal adapter methods are not permission to bypass the running hub.

## Build and test

### Pinned tools

Use `nix develop path:.`, not an unrelated system compiler.

| Dependency | Pin |
| --- | --- |
| Zig | 0.17.1, from `pkgs.zig_0_17` |
| Node | 24 |
| Chord, pi-ai, Pi Durable | 1.4.0 |
| TypeScript | 5.9.3 |
| libvaxis/vxfw | `74b7d916c8879e5379f428ea8c4d43d1a1bb061b` |
| uucode | `1fb73433bba5d93366c57f23ff2e9d7939746500` |

`flake.lock`, `package-lock.json`, and `build.zig.zon` contain the exact source and package pins. Vaxis owns terminal negotiation, raw mode, input, rendering, and restoration. Do not build a second terminal stack.

The dev shell and package seed Zig's cache from hash-pinned, unpacked Nix sources. This avoids the observed Zig 0.17.1 archive-root cache mismatch. `zig-pkg/` is generated cache, not vendored source. Python and pyte are test dependencies only. Preserve the notices in `licenses/` verbatim.

### Local checks

Run from the repository root:

```sh
nix develop path:. -c npm ci --ignore-scripts
nix develop path:. -c sh -c '
  zig fmt --check build.zig build.zig.zon src &&
  zig build &&
  zig build test --summary all &&
  npm run check &&
  DECK_TEST_BINARY="$PWD/zig-out/bin/deck" npm test
'
git diff --check
```

`npm run check` verifies generated contracts without rewriting them, then checks TypeScript. `npm test` compiles TypeScript and runs offline tests with four test files at a time. `DECK_TEST_BINARY` enables real Zig supervisor and native-effect tests. Without it, those tests skip. Native test execution is uncached: socket/process tests and opt-in Rex checks depend on the live environment, so an earlier ordinary run cannot substitute for an enabled integration run.

After editing the schema, regenerate and review both outputs:

```sh
nix develop path:. -c npm run contracts:generate
nix develop path:. -c npm run contracts:check
```

Do not hand-edit `src/generated/contracts.zig` or `runtime/src/generated/contracts.ts`.

### Package checks

```sh
nix flake check path:.
nix build path:.
nix build path:.#worker --out-link result-worker
nix develop path:. -c sh -c '
  npm run build &&
  DECK_TEST_BINARY="$PWD/result/bin/deck" \
  DECK_PACKAGE_BINARY="$PWD/result/bin/deck" \
  DECK_TEST_WORKER_BINARY="$PWD/result-worker/bin/deck-worker" \
    node --test --test-concurrency=4 runtime/dist/tui.test.js \
      runtime/dist/tui-tasks.test.js runtime/dist/tui-startup.test.js \
      runtime/dist/remote.test.js runtime/dist/remote-files.test.js \
      runtime/dist/hub-identity.test.js runtime/dist/task-relay.test.js \
      runtime/dist/package.test.js
'
```

The Nix build checks contracts, Zig, TypeScript, and runtime behavior. Its post-install smoke uses a temporary HOME and cwd, with no global Node on PATH. It tests the packaged runtime, native tools, drafts, history, and backup/restore without provider calls.

The package installs the Zig executable, compiled runtime, complete locked production npm packages, private Node, and Bash. Complete packages preserve lazy SDK imports and assets. It excludes development dependencies and compiled Deck tests. The wrapper sets `DECK_RUNTIME_ROOT` and `DECK_NODE`. Checkout binaries instead use `runtime/dist` relative to cwd and Node on PATH. `serve --runtime PATH` is an explicit development override.

Keep the source allowlist and `npmDepsHash` in `flake.nix` current. When intentionally changing the npm lockfile, update its fixed hash and repeat recovery tests. Never replace a fixed hash with unrestricted downloads.

For an installed Rex check, supply an explicit executable:

```sh
nix develop path:. -c sh -c '
  npm run build &&
  DECK_TEST_BINARY="$PWD/result/bin/deck" \
  DECK_TEST_REX="/absolute/path/to/rex" \
    node --test runtime/dist/rex-contract.test.js
'
```

That suite creates an isolated server with private scratch state, an empty config, no restore, no tailnet listener, and no provider credentials. Do not point tests at a user's Rex server. Normal tests do not connect to it.

For compilation checks on other targets:

```sh
nix develop path:. -c sh -c '
  for target in x86_64-linux-gnu aarch64-linux-gnu x86_64-macos; do
    zig build -Dtarget="$target" --prefix "/tmp/deck-cross-$target" || exit 1
  done
'
```

Cross-builds do not prove runtime or terminal support. CI runs Nix and development checks on its available Ubuntu and macOS runners. Use scratch state and fake providers for automated tests. Keep test evidence separate from live integration claims.

## Wire contracts

### Schema and semantics

`contracts/wire.schema.json` is the single source for Deck-owned shapes. The generator supports a bounded subset of JSON Schema Draft 2020-12: local nonrecursive references, objects, bounded arrays and integers, strings, constants, enums, nullable pairs, and discriminated object unions. Unsupported keywords or shapes fail generation.

Generated types are not sufficient validation. Validate at client send, command dispatch, serialized egress, native forwarding, and client ingress. Add semantic checks for:

- Exact transport, hub, chat, request, and task identities.
- Ownership, saved host/cwd, and supported capabilities.
- Safe IDs, ordering, cursor position, and state/result consistency.
- UTF-8 byte limits and existing UTF-16 limits, in addition to schema code-point limits.
- Effect uncertainty, retained hashes, and permitted retry behavior.

Keep unknown-field policies explicit. Some legacy arguments and Pi records accept extensions; closed snapshots and ACKs reject them. Do not turn malformed data into a valid observation by coercing, trimming, or inventing defaults. External Rex JSON needs its own bounded adapter; Deck's schema is not the Rex API.

Generated typed codecs are views, not lossless archive codecs. They can omit extensions or normalize some optional values. Forward original validated bytes and retain original request hashes, receipts, and captures. Never re-encode stored data merely to make it fit a new type.

### Transport

Private IPC uses a four-byte unsigned big-endian length followed by UTF-8 JSON. Bodies are objects, from 1 byte to 1 MiB. Invalid UTF-8/JSON, incomplete frames, and incompatible envelopes close the connection. Stdout is protocol-only. Use generic diagnostics on stderr; do not log rejected payloads or private errors.

A request envelope has `version:1`, a transport `id`, `command`, and command arguments. It may carry the expected `hubId`. A reply has the same version and ID, boolean `ok`, and exactly one of `result` or `error`. An envelope success still requires command-specific result validation. Serialization failure can occur after a commit; `invalid_response` is not rollback evidence.

The HTTP endpoint is `POST /v1/command` on `127.0.0.1:52800`, with an optional port override. It requires exact `Host: 127.0.0.1:PORT` and rejects every Origin-bearing request. Headers are limited to 8 KiB and bodies to 1 MiB. Socket I/O timeouts are three seconds. There is no browser or remote-authentication support.

The shared client rejects redirects and bounds streamed response bytes before JSON parsing, regardless of Content-Length. Its deadline is ten seconds. Detach aborts client HTTP, not Pi work. Private IPC permits 16 active commands; the native HTTP bridge handles round trips serially. Inference and native effects continue independently.

`hubId` prevents silent redirection after port reuse; it is not authentication. Restored copies retain the same identity. Capabilities such as `hubGuard`, `rexStartup`, `rexOpen`, and `modelSettings` are advertised explicitly. Missing capability fields do not mean support.

### Remote verification foundation

The verifier and diagnostic are shared by the opt-in [files/bash transport](#registered-filesbash-workers). The diagnostic alone never enables connectivity. The chat API remains loopback-only. Optional task-client traffic uses the verified worker link described below; there is no separate user login or general remote hub-client API.

`RemoteRegistry` is an explicit local operator file for one hub. Up to 64 entries pin a Deck machine ID to a stable Tailscale node ID and exact decimal user ID. Node names, DNS names, tags, headers, public keys, and peer-supplied `verified` flags grant no authority. A worker registration additionally pins an implementation digest and ordered capabilities (`files`, `bash`, `rex`). A client-only registration omits both. Duplicate node/machine IDs and registrations without a role are refused. Tailscale ownership is machine-level authority, not an OS-user login; do not grant client access to an untrusted node.

The native verifier calls an explicit absolute Tailscale executable. It first requires `status --json --peers=false` to report a running backend with a valid local identity, then calls `whois --json IP:PORT`. It accepts direct Tailscale IPv4/IPv6 literals only, strips ambient routing/auth/loader variables, and bounds each capture to 64 KiB and four seconds. It checks the exact host address, stable node ID, matching numeric node/profile owner, and key expiry. The legacy peer `MachineAuthorized` field is optional in Tailscale's API; an explicit false or malformed value is refused, but absence is not approval. Access still requires exact operator registration. User IDs remain exact unsigned 64-bit decimal strings. Private daemon fields and diagnostics are not returned. Unknown/malformed/lost evidence fails closed.

A read-only diagnostic compares that observation with a private registry file:

```sh
deck remote-check --registry /absolute/private/registry.json \
  --machine MACHINE_ID --tailscale /absolute/path/to/tailscale \
  --peer TAILSCALE_IP:PORT
```

Example client-only diagnostic registry (reserved role metadata, **not enabled remote client access**; replace every identity with independently verified values):

```json
{
  "version": 1,
  "hubId": "EXPECTED_DECK_HUB_ID",
  "hosts": [{
    "machineId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "peer": { "nodeId": "nEXAMPLE", "userId": "123" },
    "client": true
  }]
}
```

The file must be regular, at most 64 KiB, without group/other permissions; a final symlink is refused. This command does not edit registrations, start Tailscale, log in, create a Pi store, or send a worker effect. Success says `connection: "not_checked"`: the supplied address is a diagnostic target, not evidence of an authenticated incoming socket or a worker connection.

The native connection gate is wired into the worker listener. Its boot nonce and monotonic sequence produce fresh challenges. A worker hello must match the verified peer, hub, machine, challenge, implementation, and capabilities. A live slot cannot be silently replaced; additional sockets are closed rather than adopted. Invalid handshakes fence their attempted slot; stale replies and cleanup cannot affect a replacement or another host. Both ends supply freshly verified identity from `getpeername` on each actual connected socket, never the diagnostic result, a cached sample, or the hello itself. These slots are connection bookkeeping, not Pi task state or an execution queue.

### Registered files/bash workers

See the [operator setup](../README.md#register-a-filesbash-worker). `deck-worker` is a standalone native executable; the Nix `worker` output excludes the hub, Node, Pi, renderer, and provider libraries. The full package also contains it. `deck worker` exposes the same commands in the full executable, but that is a different implementation digest: approve and run the exact binary you identified.

`worker init` creates a new private directory, a random machine ID, and `worker.json` containing exact hub ID, hub peer and direct Tailscale `hubAddress`. Invalid options are rejected before creating the directory. It refuses existing directories rather than silently reenrolling. `identity` reads local-daemon OS identity and hashes the actual executable; these self-reported values need independent operator approval, not automatic adoption or an attestation claim. `peer` projects just the local OS peer with exact decimal user strings. `run` holds an exclusive `writer.lock` and opens only native receipts at `operations/<id>.json`: no Harness, transcript, model, provider credentials, scheduler, or inbound worker listener. Do not retarget pins or clone a worker directory to run another writer.

The hub's `--workers` private registry additionally specifies `listen` on each worker entry: a hub-side literal Tailscale IP and a distinct nonzero port. Up to eight worker entries are supported, each with exactly ordered `files,bash`, or `files,bash,rex` plus an approved `rexClient` pair; the broader registry schema retains up to 64 diagnostic/future-role entries. Files/bash-only workers continue to refuse every Rex operation. Registries are immutable for the process lifetime. Revocation/changes require a controlled restart, not silent replacement. Tailscale ACLs should restrict these ports to the approved nodes. The hub checks the registry's `hubId` against its durable Pi identity before resuming work. `--workers` cannot be combined with `--stdio` or a custom runtime entry point.

A worker establishes outbound data and control TCP connections to its assigned listener. Both sockets independently verify the actual peer through the local Tailscale daemon. The data challenge/hello pins hub, machine, implementation, capabilities, optional client/socket pair and connection generation; subsequent channel headers bind the same generation and verified peer. Rex workers pair a third independently verified client socket before requests flow. No channel accepts HTTP; task RPC is confined to that optional third channel and hub-side allocation scope. OS-machine authority is not OS-user authentication; the hello fingerprint is a compatibility pin, not hardware attestation.

Each host owns independent inherited native request/result/control pipes and one serialized gate owner. TypeScript routes by the exact saved `machineId`, using evented `uv_pipe` sockets for remote descriptors rather than occupying the filesystem threadpool. No labels, client PATH, default host, or current terminal can retarget a binding. Unregistered/offline hosts return `offline` without sending this attempt; that does not disprove effects from an earlier attempt, including before a hub restart. Remote Rex operations are rejected in both the router and worker unless the exact Rex/client registration was approved. Discovery, allocation, inspection and receipt lookup then use the assigned host's native implementation. The hub selects the registered client path/socket; native allocation checks them against worker config before invoking Rex. Existing API 8/10 and Unix-endpoint checks are unchanged; selected API 9/HTTPS probe evidence is not permission to widen them.

The transport keeps at most 20 in-flight/result slots per host (16 effects plus four progress samples upstream), with 1 MiB frames; it never persists a second execution queue. Connect is bounded to four seconds, handshake frames to 4 KiB/five seconds, and each additional channel pairing to 20 seconds. Network frame reads/writes use absolute five-second deadlines, including partial progress; captures keep the verifier's existing limits. Control heartbeats run independently at one second with a five-second loss threshold. Cancellation uses its own bounded fixed-size records and retains a 16-ID cancellation ring across reconnection. Result backpressure cannot block control delivery. File/progress requests have a 30-second transport deadline; bash has its requested/default timeout plus five seconds. These deadlines establish uncertainty, **not rollback or file-effect drainage**.

Requests cross the network with their original bytes and IDs, preserving native hashes/receipt encodings. A lost, malformed, wrong-ID, or timed-out connection fences that generation; issued calls return `effect_uncertain`, pending transport bytes are dropped, and no effect is replayed. The worker cancels process groups and drains its existing native work before its reconnect loop proceeds. Backoff is 1, 2, 4 … up to 30 seconds; it reconnects sockets only. Reconnect does not make an old result healthy or complete. Explicit same-identity requests consult original receipts: completed matches return the retained result, changed bytes conflict, accepted-without-result stays uncertain, and corrupt receipts are not permission to execute. A general read-only receipt/reconciliation UI remains future work; there is no automatic reissue after reconnect.

Worker shutdown/connection loss does not prove that accepted file effects finished or were undone. Stop and settle all hub work and independently resolve remote uncertainty before upgrades. Keep worker configuration and receipts together when backing up; the hub's backup cannot capture a remote worker directory. Never delete a held lock or run divergent restored clones. Approving a new binary digest is an explicit operator change. Retain immutable builds; do not overwrite a running executable.

Tests cover real isolated loopback sockets with **injected verifier identities**, exact-byte lost-result recovery, cancellation under result pressure, host isolation, identity/digest refusal, and stale generation contracts. These are not a real two-machine Tailscale/Deck acceptance test. The earlier selected-peer HTTPS/Rex API 9 probe remains separate evidence, not support for that endpoint.

### Worker-link task clients

See [operator setup](../README.md#enable-assigned-host-rex-task-clients). `worker init --client ABSOLUTE_DECK` explicitly adds `rexClient: {executable,socket}` to worker configuration; the socket is derived as `DIRECTORY/client.sock`. It does not install software, create a hub/store, contact Rex, or enroll anything. Existing workers can be changed only while stopped, preserving their identities and receipts. The full client is a separate installation; the native-only worker package retains its Node/Pi/renderer-free closure. The `client` registration boolean remains reserved diagnostic metadata, not permission for general remote hub commands.

`src/task_relay.zig` supplies an ephemeral, framed RPC channel, not another executor. It binds a third outbound socket to the already approved peer/implementation/configuration and the same fresh link generation. Both ends verify `getpeername` through their local Tailscale daemon for this socket too. The effects/control streams and capacity remain independent. The worker publishes a mode-0600 Unix socket only inside its private state directory after successful pairing. It refuses existing non-socket paths, removes only its stale socket under the held worker lock, and closes/unlinks the endpoint on session loss. No inbound worker TCP listener or remote HTTP listener is added.

Each worker allows eight task-client sockets/outstanding correlations, one request per local connection, with 1 MiB framed limits and no execution retries. Framing/flush deadlines remain absolute five seconds; clients abandon an unanswered call after ten seconds, and a worker fences a still-unanswered relay after fifteen seconds. The native hub keeps accepted in-flight calls, including partial private-pipe forwarding, until the original hub reply arrives: a detached request may already have applied or may still be admitted. This is bounded volatile transport, not a second durable command queue. Reconnect never resends it. Replies retain original generation, correlation and scope; old replies are consumed/discarded, not routed to successor sockets. All private RPC descriptors are preflighted against local/native/control descriptors and inherited only by the hub runtime. Local pipe corruption fences that host; network loss fences that generation and preserves native uncertainty.

`runtime/src/remote-clients.ts` uses the existing runtime/dispatch, not loopback HTTP. The inherited route supplies the authoritative machine ID. A request must name the current managed ownerless task, coherent machine/cwd, hub, allocation, full Rex block, and approved client/socket from the retained allocation plan. Only status/history/startup are allowed before startup registration. Remaining reads, input, stop, import and idle-only model configuration require matching startup. Login, task creation/listing/switching, hub chat access, and Rex replacement are refused. Remote status omits global Pi inspection and opaque provider model parameters. Native and TS bridges continue to pin hub/task/client mode.

Authorization runs before dispatch, after dispatch before releasing results, and again inside serialized mutation admission. Async-local guards are removed around actual Pi-owned execution so they do not become inherited authority/lifetime restrictions on background work. `stop` still acknowledges a request, not drainage. Replacing an allocation or changing approved client paths invalidates old task scope. Already admitted work is not rolled back by detach or revocation.

`runtime/src/task-client.ts` is a client-only bounded Unix transport with no store, inference, retry, redirects or provider login. Both TUI and plain launch paths require explicit hub/task/allocation and native `REX_BLOCK` with `--worker-socket`; they register startup before accepting input. A failed initial startup exits, not restarts. Existing live clients can resume fresh reads after worker reconnection; mutations/settings remain uncertain until explicit recovery. Only the existing draft store retains exact pending input on the client.

Hub `/task-at {"machineId":"32 hex ID","cwd":"/absolute/path","title":"Task"}` adds explicit creation targets to the existing draft/ACK/open sequence in both clients. It does not migrate existing chats or change `/task` defaults. JSON preserves paths/titles with spaces without shell parsing. The existing TUI command-line bound remains 256 UTF-8 bytes with command paste disabled; longer targets use the plain client. Both bridge validators reject mixed actions, noncanonical machine IDs, relative/NUL/oversized paths and oversized titles; task clients and read-only task inspectors cannot use it.

Opt-in native integration (`DECK_TEST_REX` and `DECK_TEST_BINARY`, after `npm run build`) exercises actual inherited FIFOs, hub dispatch/Pi, all three loopback sockets with injected verification, the worker-local Unix proxy, native Rex allocation/inspection, a private supported Rex server and the real Zig TUI. It covers task-locked startup/input, same-process client reconnect, exact history preservation, and explicit same-conversation reopening. Ordinary tests cover wrong third-socket peers, stale reply fencing, role/scope refusal at admission, exact lost-ACK drafts and explicit deduplication. None of this substitutes for real two-machine acceptance.

### Commands

Use the schema and `runtime/src/ipc.ts` for exact fields. The local command surface is:

| Group | Commands | Meaning |
| --- | --- | --- |
| Inspection | `status`, `list_chats`, `history`, `activity`, `progress`, `instruction_status` | Read saved state or bounded samples |
| Saved mutations | `admit`, `create_task`, `import_instructions` | Durable input, conversation creation, or import-task admission |
| Control | `stop` | Request scoped abort; ACK is exactly `{requested:true}` |
| Settings | `model_settings`, `set_model_settings` | Read catalog/selection or commit an idle-only selection |
| Login | `login_start`, `login_status`, `login_reply`, `login_cancel` | Manage one transient hub-owned login |
| Rex | `rex_open`, `rex_status`, `rex_inspect` | Explicit best-effort open and separate status/inspection |
| Internal startup | `rex_startup` | Record allocation-bound historical client startup |

Model settings and public Rex operations require an explicit expected hub ID. Startup registration has its own exact allocation/block checks. `serve --stdio --mock` exposes the framed bridge for development, without an HTTP listener. It is not line-oriented JSON.

### IDs and failure policy

Transport IDs are not durable request IDs. Pi conversation, submission, task, and ordinary native-operation IDs use canonical positive decimal strings within JavaScript's safe-integer range. History entry IDs remain numbers; cursors are strings. `after:"0"` is the history start sentinel.

Fresh native Rex inspect/resolve IDs use the high half of unsigned 64-bit values. Progress IDs are `progress:TARGET`. Cancellation uses eight-byte big-endian numeric records in approved namespaces. Reject zero, leading zeros, unsafe gaps, and overflow where the contract forbids them.

Shared Zig/TypeScript failure policies always preserve drafts and forbid automatic mutation retry:

| Failure context | Next action |
| --- | --- |
| Local validation before send | Fix the request; only this path proves it was not sent |
| Read | Retry the read; retain the cursor |
| Validated history `too_large` | Reduce the page at the same cursor, down to one entry |
| Saved input/task/import | Explicitly retry original bytes, or review a conflict/settings change |
| Rex open | Inspect the attempt and terminal before a new explicit attempt |
| Login | Observe the existing interaction; do not replay an unconfirmed answer |
| Stop or settings change | Observe state; any new action must be explicit |
| Unknown well-shaped error | Inspect the outcome; do not infer rollback or non-execution |

Malformed, duplicate, unsolicited, miscorrelated, or lost native replies permanently fence the adapter: reject issued work as uncertain and refuse new calls. Late replies cannot restore success. There is no automatic reconnect/resend. An invalid private command reply also stops the out-of-sync bridge rather than forwarding an ACK.

## Admission and drafts

Pi 1.4.0 has no public transaction-bound `submit(tx, draft)`. Deck first commits an immutable capture reservation, then submits with the same durable request ID. A reservation is not an ACK. An explicit retry repairs the gap or retrieves the existing Pi submission. Changed arguments conflict.

Version-3 captures use `semantics:"observed-at-reservation"`. They record model/thinking, agent and worker cwd, selected extensions/tools, instruction hash, native-tool mode, Pi version, and startup implementation identity. They do not freeze a prompt, provider behavior, tool code during execution, or workspace files.

An unadmitted reservation with changed observed settings returns `settings_changed`. Restore the original choices or explicitly discard the local draft and start a new request. Already admitted requests keep their original receipt, even after settings or authentication changes. Version-2 and older captures retain their original bytes and weaker checks.

Task creation commits its conversation and receipt together. Instruction import commits an administrative task and request receipt together. These differ from input's reservation/submit gap.

`DraftStore` saves input, task, and instruction requests before sending. It uses private temporary files, fsync, and exclusive hard-link publication. Existing IDs must have identical validated payloads. Save failure prevents initial send and retry. Only a validated command ACK plus successful local cleanup clears the active draft.

Default client state is `~/Library/Application Support/deck/client` on macOS, or `$XDG_STATE_HOME/deck/client` on Linux, with `~/.local/state/deck/client` as fallback. `DECK_CLIENT_STATE_DIRECTORY` selects an absolute alternate root. Drafts use `drafts/<SHA-256 of hubId>/<request UUID>.json`, 0700 directories, and 0600 files. Records are bounded to 1 MiB; discovery permits at most 1,000 records.

Drafts are plaintext request data, not an execution queue. Reconnect never sends them. Multiple clients can retry the same identity but share local discard effects. Corrupt or insecure records fail closed; do not edit IDs to repair them. A legacy draft rejected by new validation stays byte-identical and unsent. A draft that never reached disk is lost if the client dies.

## Settings and instructions

### Model selection

Settings live in Pi's existing agent document. Main uses the startup model only when created. New tasks inherit main's current model/thinking; saved chats retain their choices. Pi supplies supported thinking levels and a medium-based default. Non-reasoning models use off.

`model_settings` returns `{hubId,chatId,selection,defaultModel,models}`. A selection contains `provider`, `modelId`, and `thinkingLevel`. The catalog has at most 256 models and seven supported levels. Expose only names, IDs, levels, and defaults, not SDK metadata, headers, or credentials. Catalog membership is not account entitlement.

`set_model_settings` takes `{chatId,expected,selection}`. In one configuration transaction, verify managed main/task metadata, canonical ownerless status, no unfinished tasks/inbox, and the expected selection. Refuse stale choices with `conflict`, unfinished work with `busy`, and unsupported choices/ownership with `invalid`. Preserve unrelated agent fields. A legacy saved selection can remain readable even if the current catalog cannot offer it.

The client reads back after an unconfirmed mutation; it does not resend it. Input and further settings changes stay blocked until a fresh observation. This is idle-only configuration, not a deferred queue or per-input settings bundle. General `configure()` remains internal. Cwd changes cannot silently disagree with saved effect bindings.

### Instruction import

The public import reads exactly `AGENTS.md` on the saved worker/cwd. It accepts at most 32 KiB of exact UTF-8 text with no NUL. Empty text is valid. There is no parent search, include expansion, automatic refresh, or fallback reader.

One Pi administrative task owns the read and application:

1. Check ownerless main/task authority and no unfinished tasks/inbox. Commit the import task and request receipt.
2. Block new unadmitted input/configuration for that chat while import remains unfinished. Other chats and old receipts remain available.
3. Read with the Pi task ID as the native operation ID. Admission does not capture file bytes. A first read after recovery can see changed text; a retained read result fixes the returned bytes.
4. Recheck binding, previous instruction hash, task authority, and absence of other work inside the apply transaction.
5. Replace stored explicit instructions and commit source provenance plus the terminal task result atomically.

Source provenance records machine, cwd, `AGENTS.md`, SHA-256, byte count, and task ID. Hashes are not encryption. A retained old `applied` result does not prove its text is still current. Read-only status omits instruction contents and private errors; clipped host/cwd labels are display data, never routing authority.

Stop drains an issued read and prevents later application by that invocation. It cannot undo an already committed import. Acceptance without a native result remains uncertain; do not reread under a new identity automatically.

Do not implement required instruction policy by throwing from a Pi prompt hook. Tests show ordinary hook/section errors can fail open, retries can re-render sections, hook-only replacements need not enter canonical history, task memos disappear at settlement, and generation hooks do not cover compaction. Full per-input capture needs a separate design.

## Tasks and subagents

Read-only model tools `task_list`, `task_history`, and `task_activity` read canonical Pi state. Title search is bounded and paginated. They do not create documents, wake agents, or submit inspected history as input. This single-user store has no per-chat ACLs.

`task_create` makes an ownerless task without input. It inherits the caller's saved machine/cwd and main's model/thinking, not the caller's full instructions or transcript. `task_message` targets another managed ownerless task, not self, main, or an owned child. Default mode is `followUp`; `steer` is explicit. It returns admission only and adds agent-origin provenance.

Request IDs derive from the stable Pi tool-task ID. Replaying that same task retrieves its receipt. A new tool call has a new ID and may repeat work. Cancellation can prevent an uncommitted operation, but cannot undo independent target work after commit. Stopping the sender does not stop that target.

`subagent` uses Pi's task-ownership edge and owner index to create or recover one child. Its input ID is `deck-subagent:<tool-task-ID>`. Input goes through the invocation-bound Pi handle, not a fabricated host reservation or client draft. The child inherits stored instructions, model/thinking, filters, and binding, but not transcript context. It cannot recursively delegate or use independent task-control tools.

The tool waits for an answer. It returns bounded final text and omission flags, or a generic unanswered result with IDs. Success means an assistant answer exists, not that every effect succeeded. Child output is untrusted data. Parent cancellation aborts ordinary owned work and waits for issued effects to drain. Background boundaries and escaped processes retain their limits.

External clients can inspect or stop children. They cannot admit input, import instructions, or independently configure a child's model. Canonical Pi ownership, not display metadata, decides authority. Child history remains readable after settlement.

## Native effects

### Tools and limits

| Tool | Contract |
| --- | --- |
| `read {path}` | Regular UTF-8 file, at most 128 KiB; no binary/image or paging support |
| `write {path,content}` | Create/replace a regular UTF-8 file, at most 128 KiB; parent must exist |
| `edit {path,oldText,newText}` | One nonempty exact match; reject zero/multiple matches; result at most 128 KiB |
| `bash {command,timeout?}` | Nonempty NUL-free command; integer timeout 1–300 seconds, default 60 |

Cwd must be absolute. Paths and cwd are limited to 4,096 UTF-8 bytes with no NUL. Relative paths, absolute paths, `..`, and ordinary symlinks follow OS rules. These are not confinement checks. No production environment RPC or Pi hub-local filesystem fallback exists.

File work uses one native worker thread. Bash and Rex processes share bounded native process capacity; at most four process slots are available. There are 16 pending effect/result slots and four ephemeral progress-read slots. Keep cancellation independent of full command/result pipes.

### Receipts and cancellation

Pi saves tool intent before native dispatch. The worker verifies the saved machine and validates the operation before accepting it. Receipt files live at `worker/operations/<operation-id>.json` under state. Acceptance is synced before effects; the final result is then retained. Hash the exact original request bytes.

- Matching completed duplicates return the original result without execution.
- Changed bytes under the same ID conflict.
- Acceptance without a final result means `effect_uncertain`.
- Corrupt or contradictory receipts do not become success or absence. Do not rewrite them to repair execution.

Files and receipts cannot form one atomic transaction. Writes may be partial on failure, and a crash can occur after mutation but before result persistence. These rules do not provide exactly-once effects, power-loss guarantees, or protection from concurrent external edits. Keep the Pi store and native journal together; do not reset one while reusing the other.

Issued file operations drain rather than interrupt. File/bash tools use Pi's non-replay-safe policy, so recovery does not automatically repeat interrupted effects. Explicit duplicate native requests may retrieve retained results; that is not permission to issue a new mutation ID.

Bash runs `bash --noprofile --norc -c` with `/dev/null` stdin and a new POSIX process group. Output drains continuously into a 64 KiB combined tail. Nonzero exit is an error. Truncation and lossy UTF-8 are marked. There is no full-output artifact or strict cross-stream ordering guarantee.

The shell omits `OPENAI_API_KEY` and `BASH_ENV` from its inherited environment, but can still read user-accessible secrets. This is not credential isolation. Cancellation sends TERM to the group, then KILL after 250 ms if needed. Leader exit also cleans up ordinary background group members. New sessions, service-manager children, kernel stalls, and hard supervisor death are outside a complete cleanup guarantee.

Native schemas also bound Rex plans/queries to 16 KiB and receipt lookup to a 256 KiB query with at most 128 KiB of original request bytes. Validate operation-specific fields, exact reply identity, and payload kind. A decoding superset does not permit mixed-operation arguments.

## Read views and clients

### History and samples

`history` uses Pi's fork-aware scan. Limits are 1–100 entries. Default and `before` pages are newest-first; `after` pages are oldest-first. Bounds are exclusive. `next` must equal the final row ID in scan order. Empty history cannot advance. Unknown Pi kinds remain in cursor accounting even when not rendered.

`list_chats` instead returns the last **scanned** conversation ID. An empty filtered page can advance. Validate the whole page, all supplied attachments, scope, ordering, and counts before output or cursor changes. Invalid/lost reads preserve cursors and drafts. Only a validated frame-size error permits page reduction; never skip an oversized entry.

Plain mode starts from a recent tail and then catches up forward from its validated watermark. Older browsing has an independent cursor. Selection/client restart loads a new bounded tail; no delivery cursor is saved. The TUI holds a bounded page instead of lossless forward catch-up.

Activity, progress, and instruction status are separate samples, not one atomic revision. Activity omits tool arguments/output. Progress exposes a 2,048 UTF-16-unit assistant tail and at most four 512-unit bash tails. It omits hidden reasoning, generic tool details, and private errors. Missing previews do not prove idle or completion. Optional attachments may be omitted to fit a valid history frame.

Bash samples come from a 2 KiB native tail updated at most every 250 ms. The adapter polls at most once per 500 ms and coalesces Pi detail publication. Samples create no receipts or second output log. Final history/results remain authoritative. Sanitize display projections without changing stored content. Sanitization does not remove secrets.

Global `status.activity` differs from selected-chat activity. Its outer view bounds tasks and submissions to 4,096 each; inner Pi records remain opaque. An invalid/oversized global read fails rather than truncating work into a false idle claim.

### TUI boundary

The TUI helper uses HTTP and `DraftStore`; it opens no Pi store. Its closed generated bridge uses 1 MiB frames, strict UTF-8, exact transport/hub/chat correlation, and owned strings. One request may be outstanding. Invalid, unsolicited, duplicate, or lost replies permanently fence it. There is no helper restart, action queue, or mutation replay.

The hub client can select another chat only through an explicit request with an exact target ID. Both bridge endpoints check that target before changing their chat pin. A failed selection keeps the old chat. Selection reads status and saved drafts before replacing the page, samples, cursor, binding, and terminal-status baseline. It creates no input or stop request.

`clientMode` (`hub` or `task`) is pinned from launch, not inferred from a display label or selected chat. `hubChatId` is pinned by the initial validated status; both bridge endpoints reject subsequent role/root identity drift. The durable/API name `main` is retained without migration; the UI calls it **hub**. Hub bars are teal, task bars slate-blue. Task mode requires successful allocation-bound startup and cannot select the hub, list other chats, or create tasks. Even forged renderer requests are refused by the helper. Mode changes cannot be obtained by selecting a chat.

Hub-selected tasks are read-only. The editor/paste, send, retry/discard, stop, and configuration paths refuse; task drafts are not activated or removed. The hub can read task history/settings/Rex state and explicitly open/reopen Rex, but cannot participate without its verified task client. Direct `--task` launches and plain clients obey the same policy. This is a client interaction policy, **not authentication of the trusted-local HTTP API**; Pi-owned task tools and internal admission continue to use their existing authority.

`/tasks` shows one bounded page of at most 25 chats. Labels are clipped display data, not routing bindings. Sparse pages can advance by last-scanned cursor. `/hub` returns to the hub chat (`/main` remains a compatibility alias, also forbidden in task mode). `/task TITLE` is hub-chat-only: save the exact ordinary task draft, obtain creation ACK, remove that draft, then issue a separate best-effort `rex_open` using the returned chat ID and client port. Stay on the hub and submit no input. If opening fails or loses its ACK, retain the created chat and report the uncertain terminal attempt; no automatic retry or standalone participation fallback. Creation itself still retries only by explicit original title/binding/identity. An unavailable Rex capability refuses before creating a draft. Switching/creation refuses unsent editor text or unresolved requests; there is no extra per-chat editor store.

The editor has a 16 KiB UTF-8 limit and 32 snapshots per undo/redo stack. Paste applies atomically as literal text. Only new editor input normalizes CR/CRLF to LF and tabs to four spaces. Saved requests remain unchanged. System clipboard allocation is disabled before OSC 52 parsing.

The rendered page has at most 80 entries, about 128 KiB of text, 8,192 bytes per entry, and a 4,096-byte preview. The surface is capped at 240×120 cells. Display checks reject terminal controls, bidi overrides, isolated zero-width text, and pathological graphemes. Vaxis supplies grapheme and negotiated-width behavior.

`draft.saved` means confirmed cache publication, not admission. `LOCKED UNSAVED` must not permit quiet prompt loss. Input and task drafts support exact retry in the TUI; instruction-import drafts still use plain mode. Polls pause during commands, paste, model/task pickers, and the Rex panel. Fast routine polls do not redraw transport state; slow polls become visible after 500 ms. Explicit actions and fencing show immediately.

### Terminal status

`src/tui_status.zig` uses Vaxis's [OSC 7501 implementation](https://www.superlogical.com/rex/docs/build/program-status), protocol revision 0.4. Use one record, `id=deck`, `app=deck`. The title is `Δ - <client launch directory basename>`, at most 192 UTF-8 bytes after control/direction sanitization. It is not the saved workspace, process name, shell name, or Rex session label.

`activity` opts in with `includeAgentStatus:true`; history also needs `includeActivity:true`. Ordinary callers keep their prior response and read cost. The projection reads canonical tasks, latest generation, and a matching assistant outcome entry without creating Pi documents. Task/outcome reads share a transaction; the inbox sample is independent.

| Indicator | Evidence |
| --- | --- |
| `working` | Unfinished tasks or queued input, including parked/background/draining work |
| `done` | New settled generation with a canonical assistant answer and no unfinished work observed |
| `error` | Latest generation failed, faulted, or orphaned, with no unfinished work observed |
| `idle` | No unfinished work, or the displayed outcome was acknowledged; settled cancellation is not success |
| `blocked` | Saved/unconfirmed input or a fenced client needs user action; central work may continue |
| Clear | Missing, failed, unavailable, uncertain-settings, or at least five-second-old observation |

Only fresh validated poll/latest observations refresh status. ACKs, cached settings, and older pages do not. Send/retry/stop invalidates the old sample instead of inferring a new state. Initial completed history is not announced as unread; initial failure remains visible. Interaction acknowledges results in memory. Repeated polls do not reannounce the same outcome.

Reports are change-only, with fixed messages and no invented percentages, prompts, output, or error details. Cleanup clears only Deck's record and pops its title stack before terminal restoration. Normal errors and TERM/HUP/INT run cleanup; SIGKILL cannot. Plain clients emit no OSC status. Terminal support determines title restoration and GUI display.

## Rex integration

Public open/reopen supports managed ownerless tasks. Main and owned children refuse. Pi saves the launch intent and administrative task before native creation. The launch uses trusted executable argv, `--shell=none`, exact hub/chat identity, and `--tui`, not typed shell text. The client-only helper verifies initial status, drafts, history, and `rex_startup` before returning any renderer snapshot. A refused, malformed, or lost startup ACK closes the helper and fences the UI; it does not replay registration or enable input. Allocation-bound plain-client launches remain supported with the same startup and task-lock rules; an ordinary direct task launch is read-only.

First open resolves missing target fields on the assigned worker. PATH search uses absolute directories only. Bounded `rex --autostart=false --timeout 2s server status --json` discovers a local Unix endpoint plus host/instance UUIDs. Strip ambient remote/focus routing overrides; do not autostart or use TCP. Later opens use the saved target without discovery; supplied overrides must match it.

Endpoints allow valid percent-encoded UTF-8, with 307 encoded characters and 100 decoded socket-path bytes. Compare decoded identities without changing retained spelling or hashes. Tested API revisions are explicitly 8 and 10; do not accept arbitrary newer revisions.

The TUI `/rex` panel uses existing public status/inspection contracts with exact hub/chat scope at both bridge endpoints. Reads refresh only on explicit actions. Open/reopen uses the client's current hub port and a new explicit attempt identity. Lost replies require inspection, not automatic resend. Existing input/task/import drafts are unchanged.

Keep these facts separate:

| Fact | What it proves |
| --- | --- |
| Admission | Pi accepted an attempt; completion was not awaited |
| Creation binding | A retained native result supplied full server/session/window/block IDs; readiness is not checked |
| Startup registration | The allocation-bound client once verified its hub/chat and registered native `REX_BLOCK`; not current health |
| Fresh inspection | A bounded non-atomic sample of exact objects and process presence; not responsive-client readiness |
| Receipt reconciliation | Hash-matched retained creation evidence repaired provenance; not current existence |

Startup generates an allocation UUID before effects. The launched client verifies hub guard, startup capability, chat, saved drafts, and initial history before registration and input. Early registration can join a later binding. Bad/lost ACKs fail startup; they do not authorize recreation or new input.

Inspection uses the saved worker and full IDs. It checks server identity around scoped session, block, and process reads. `session.view` and `session.list_blocks` distinguish placed and detached blocks. Only verified native `session_not_found` evidence proves a missing session. Wrong placement/host/flavor, duplicate IDs, changed revisions, generic errors, timeouts, or malformed output are conflict/inconclusive, not absence. Missing child and exit fields mean pending, not ready or exited.

Recheck Pi authority after I/O, including binding changes that return to the same value. Cancelled/stale replies cannot authorize replacement. Inspection and target resolution use ephemeral IDs, bounded shared capacity, and no read receipts, Pi tasks, or health store.

Open reuses an observed running client. It creates a new window for an exited/missing terminal, or a new session for a missing session. `open` and `reopen` are aliases. New attempts preserve prior binding/results and clear only the latest startup slot. A reused client is not retargeted to a new port.

**Inspect-then-create is not atomic.** Rex API 10 ignored invented conditional/idempotency fields in tests. Concurrent or explicit later attempts can leave duplicates. Do not send invented guard fields, adopt by label, automatically retry, or destroy possibly running terminals. Manual cleanup is an accepted local limit, not a weaker file/bash/input guarantee.

Internal reconciliation admits a separate Pi task, reads the original native receipt and exact request hash, then applies matching creation proof. It calls no Rex mutation and preserves the original uncertain/aborted result. Missing or acceptance-only evidence stays unresolved. This is not a public repair command. Public open can start a new explicit attempt after uncertainty without replaying the old accepted operation.

## Providers and credentials

Inference and model credentials stay on the hub. Production modes register OpenAI chat models or the mock provider, not every installed Pi provider. Validate saved model/provider choices before resume. Mock and real stores are not silently converted.

Default ChatGPT mode requires OAuth and ignores ambient paid keys. API-key mode is an explicit billing choice and rejects stored OAuth. Wrong credential types fail on every read/refresh. Refresh failure preserves prior credentials and does not change auth mode.

The private plaintext `auth.json` store serializes reads/writes/refreshes under the one writer. It validates permissions and bounds, then publishes a synced 0600 temporary file by rename. This is not keychain encryption or isolation from the same OS user. Never put tokens in prompts, captures, source, derivations, arguments, or logs.

Login interactions are transient, not transcript entries. The callback binds `127.0.0.1:1455`. Abandoned flows expire after ten minutes. Views whitelist up to 16 public events and bounded prompt/options data; entered answers and tokens are omitted. The plain client refuses secret-entry prompts.

`login_reply` acknowledges delivery, not saved credentials. Report success only after a valid matching `done` observation. Cancellation is not logout and cannot prove a racing callback saved nothing. Pin the hub and interaction; never replay an unconfirmed answer automatically. Live OAuth/refresh still needs separate validation.

## Recovery and backup

### State layout

The default hub root is `~/Library/Application Support/deck` on macOS. Linux uses `$XDG_STATE_HOME/deck`, or `~/.local/state/deck`. `--directory` overrides it. Config and state currently share this root.

```text
config.json                    persistent machine identity
session.sqlite                 Pi conversations and Deck documents
writer.lock                    shared native/writer exclusion
auth.json                      optional private provider credentials
worker/operations/*.json       native acceptance/result receipts
```

Directories are private. `init` validates existing identities and refuses unsupported versions rather than resetting them. Lock filenames can remain after exit; only OS lock ownership decides whether another writer may start.

### Implementation gate

Before `Harness.open` can normalize or resume work, Deck checks `deck.implementation` under the writer lock. The SHA-256 covers production runtime/dependency contents, Node bytes/version/platform, native executable, entry script, auth mode, and native-tool mode. It excludes Deck tests, install paths, mtimes, credentials, and workspace files. Declared dependency traversal is bounded to 1,000 packages, 20,000 files, and 512 MiB.

Matching identity may resume. Changed or unversioned implementations refuse if canonical unfinished tasks or queued/placed submissions exist anywhere in the store. Parked, background, and owned-child work count. Refusal does not open the Harness or consume restart retries. An idle store can adopt a new stamp. Unknown/malformed stamp formats refuse even when idle.

Keep the original immutable build GC-rooted, for example by linking its exact store path with `nix-store --add-root /path/to/retained-build --realise /nix/store/ORIGINAL-DECK-PACKAGE`. Record the state directory and original mode. Do not upgrade based on a selected-chat activity sample. If refused, use the original build to finish or explicitly resolve all work. There is no force-resume or general repair command.

The gate is not code attestation, a workspace snapshot, or protection from editing checkout code during execution. It opens Pi's storage adapter before checking; a future adapter could perform schema changes on open. Pi upgrades still need tested migration/downgrade policy and backups.

### Offline backup and restore

Both commands hold the shared writer lock and never open the Pi Harness, resume tasks, or replay effects. A live or surviving writer blocks them. Arrange a secure authenticated restart before stopping a hub whose key exists only in process memory.

Backup format 1 contains `manifest.json` and a `files/` tree. It includes config, a standalone SQLite snapshot, published native receipts, and optional stored credentials. SQLite's backup API incorporates committed WAL without rewriting the source. The synced manifest records path, size, and SHA-256 and is published last by exclusive hard link.

Exclude locks, WAL/SHM sidecars, unpublished temporaries, and known logs. Refuse unknown state files instead of silently omitting possible authoritative data. Workspace files, runtime packages, client drafts, ambient credentials, and Rex objects are outside the backup.

Bounds are 10,000 included files, 512 MiB payload, and a 2 MiB manifest. Roots must be private and user-owned. Read paths must be allowed regular files/directories, not symlinks or devices. New files/directories use 0600/0700. Reject source/destination overlap and existing outputs. Trusted parents must already exist. Hard-link support is required.

Restore creates a new private destination, locks it, and writes `.restore-incomplete`. It validates paths, duplicates, versions, sizes, hashes, and database integrity before publishing config last and removing the marker. On failure, keep the partial directory offline and restore to another new destination. Do not run old `init` on partial restores; older binaries do not understand the marker.

Before serving a restored image:

1. Keep one recovery copy. Identities and bindings are unchanged; do not run divergent clones as separate hubs.
2. Use the required original implementation for unfinished work. Restore does not bypass the startup gate.
3. Reconcile effects performed after the backup. Rollback forgets later receipts and submissions but cannot undo files, processes, model calls, or charges.
4. Inspect client drafts separately before retry. They are outside the backup but still refer to the restored hub identity.
5. Restore provider access securely. Copied OAuth tokens may be stale; environment-only keys are not backed up.

Hashes detect corruption, not a malicious rewrite of both payload and manifest. Backups are not encrypted. SQLite quick-check is not full Pi semantic validation. This is same-machine offline recovery, not workspace relocation, online backup, exactly-once rollback, or a complete disaster-recovery policy.

## Change rules

- Add schema changes first, then generated outputs, semantic guards, and shared positive/negative fixtures.
- Test the actual serialized boundary and post-commit failure, not only in-memory types.
- Test save failure, lost ACK, stale identity, cancellation before/after acceptance, and unchanged retry bytes where relevant.
- Keep retained records compatible. Do not normalize old hashes, IDs, captures, receipts, or draft formats as a side effect.
- Use Pi public APIs. Keep owned-child authority and saved-host routing explicit.
- Use scratch state, fake providers, and isolated Rex servers. Do not alter live credentials, restart a live hub, or widen deadlines to make tests pass.
- Treat building and deployment as separate actions. Code/native/dependency changes can change the implementation fingerprint.
- Keep user instructions in the README, current engineering rules here, future work in the Roadmap, and previous evidence in History. Use short sentences, active voice, and one meaning per term. Preserve legal notices verbatim.
