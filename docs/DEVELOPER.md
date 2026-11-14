# Developer guide

This guide describes implemented behavior unless a section is marked **target design**. Read the [README](../README.md) for the user workflow, the [Roadmap](ROADMAP.md) for planned work, and [History](HISTORY.md) for earlier changes and validation.

## Contents

- [Architecture and ownership](#architecture-and-ownership)
- [Target interactive and scheduled architecture](#target-interactive-and-scheduled-architecture)
- [Target native MCP tools](#target-native-mcp-tools)
- [Automatic startup and enrollment](#automatic-startup-and-enrollment)
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
- **Tool host:** the hub or a registered worker running Deck's native MCP client and its approved server processes/connections. Not a TUI or an agent runtime.
- **Tool profile:** an explicitly approved, versioned selection of MCP servers, tool grants, execution configuration and local credential references. Attaching a terminal does not select or change it.
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

Deck embeds `pi-durable` and `pi-ai`, not the full Pi coding-agent application. Its explicitly installed Pi Durable extension definitions are internal adapters, not a loader for user Pi plugins. The target integration surface is native MCP, not compatibility with Pi CLI extensions, hooks, commands, custom UI or provider plugins. Neither an existing Pi session nor `.pi` configuration grants Deck tools or credentials.

Keep these boundaries:

1. Use one Pi writer per state directory. Never open a second Harness against a running hub's store.
2. Send all chat input through the hub. Clients do not run inference or replicate transcripts.
3. Use Pi documents and transactions for Deck metadata. Do not add a task scheduler, execution queue, or task-completion state machine.
4. Run effects only on the saved machine and cwd. An unavailable assignment must not fall back to the hub or another host.
5. Keep detach, stop, process exit, and history deletion separate. A stop reply acknowledges a request, not completed drainage.
6. Preserve request identities and retained bytes. An unknown outcome is not permission to repeat an effect.
7. Treat tool access as trusted-user access, not a sandbox or multi-user permission system.

`serve` initializes fresh/default state while continuously holding the actual nonblocking exclusive writer lock, then passes its descriptor to the Node writer. Existing identity is retained; existing store contents without identity refuse. Fresh client-only state is allowed. Explicit `init` remains available, but is not required. A surviving child keeps the lock after supervisor death. Shell and Rex children must not inherit it.

Unexpected writer exit or failed Harness closure stops the hub with a nonzero exit. There is no automatic respawn. Process checks detect death, not a live hang. Private-channel closure cancels owned shell groups and drains issued file work where possible.

### Target interactive and scheduled architecture

**Target design, partly implemented.** Local and assigned-host managed Rex task clients and verified native workers have isolated tests. A separate [two-machine Darwin arm64 acceptance run](HISTORY.md#phase-0-two-machine-acceptance) passed with actual Tailscale peers, mock providers and a private Rex API 10 server. Phase 1 adds creation briefs, grouped inspection, registered-host selection and bounded task-to-hub messaging. Native stdio MCP and task grants have source/installed coverage and separate [fresh two-machine acceptance](HISTORY.md#mcp-two-machine-acceptance) on the recorded Darwin arm64 pair; this does not broaden platform or live-service claims. Automatic remote bootstrap is implemented with separate API-14 isolated evidence; scheduled jobs and subagent terminals below remain planned.

Every chat uses the hub. One hub-owned Pi runtime stores conversations and runs interactive agents, scheduled jobs, and their children. Background execution uses Pi tasks in that runtime, not a new process or store for each job. Registered host connections carry native effects to the assigned execution machine. Model credentials stay at the hub.

| Work | Pi execution and history | Workspace and tools | Rex presentation |
| --- | --- | --- | --- |
| Interactive task | Hub | Assigned execution machine; explicitly granted hub/worker MCP profiles | One named session on that machine, with the task's TUI |
| Interactive task's subagent | Hub-owned child conversation | Inherited binding and tool grants, never broader authority | Named TUI terminal inside the parent task's session |
| Scheduled job | Hub background execution; stable job task/chat | Assigned registered host and captured tool-profile references | None |
| Scheduled job's child agent | Hub-owned child execution | Inherited binding and grants | None |

For interactive work:

- The hub TUI lists saved tasks and their children, creates tasks, and switches read-only inspection. A task has a stable ID, title/name, problem statement, description, one primary conversation and optional owned children. These are metadata, not a second task-completion lifecycle. Connectivity, terminal presence, queued work and activity are separate observations; offline tasks remain visible.
- Creation saves the task brief without starting generation. The brief reaches model context through an explicit recorded input/configuration path, never a hidden prompt edit. Human input and agent-origin messages share that task's primary conversation, with distinct provenance.
- Hub and primary task agents coordinate through durable tools. `hub_message` is explicit follow-up input, with recorded reply correlation and an eight-hop causal limit. Admission acknowledgements and status samples never forward themselves as model input. TUI task locks do not remove the agent's explicitly granted coordination tools.
- `deck hub` opens the control client; `deck serve` remains a foreground service managed externally. Explicit `deck agent --launch-from ABS_WORKER_DIRECTORY` bootstrap requests creation/opening through a separately launcher-approved worker. It neither weakens allocation-bound task RPC nor reinterprets existing inspector launches or grants general hub access.
- Opening a task in Rex routes through its assigned host and verified Rex server. It does not move the workspace or select an unrelated execution host.
- Task and child terminals run Deck TUI clients of existing hub conversations. They do not run another Pi engine. Labels aid navigation; full IDs establish identity.
- Closing a session does not delete its Deck task or Pi conversation. Explicit reopen restores access to the same chat without replaying input or starting another generation.
- Rex-owned processes can stop when their terminal is destroyed. This does not prove their effects were undone or that the agent completed.
- A child terminal does not change Pi ownership. Direct child input still needs defined input/lifetime rules; a new view alone grants no authority. Keep current foreground delegation while the primary-task/MCP workflow is built. Independent child model selection is not implied by model controls in primary task TUIs.

For scheduled work:

- Reuse the job's persistent Deck task and Pi conversation across runs. Individual Pi execution tasks and run admission IDs remain distinct.
- Each run has its own durable admission identity and captured file settings. A retry of that run reuses its original identity and captured contents; it does not reread newer files as the same run.
- Capture the specified configuration/instruction files through the assigned host. This is not a whole-worktree snapshot. Define capture timing, precedence, and failure rules before claiming a run is fully captured.
- Jobs and their children open no Rex sessions or terminals. Scheduling, recovery, and history inspection must not create terminal objects.
- Use Pi durable scheduling and ownership. Do not add a second queue, transcript store, or job-execution engine.

Remote task clients use the verified worker link and allocation-scoped hub dispatch. Rex connectivity alone does not authenticate a separate HTTP connection. An offline host keeps its assignment; neither interactive nor scheduled effects fall back to the hub. Current version-3 admission observations are not the required per-run file capture. See the [implementation sequence](ROADMAP.md#next-implementation-sequence).

## Target native MCP tools

**Stdio implemented; Phases 2/3 accepted for the recorded test scope.** The native client, private profile loader, public catalogs, per-conversation grants and assigned-worker routing are implemented. The [operator workflow](../README.md#native-stdio-mcp) uses native export/probe commands and trusted-local hub API controls, not a new TUI picker. HTTP/OAuth and arbitrary Pi-plugin compatibility remain outside this implementation.

### Ownership and execution

```text
Hub Pi conversation -> durable Pi tool invocation
                              |
                    Deck native effect boundary
                         /                \
             Zig MCP host on hub     verified worker link
                      |                       |
               approved server       Zig MCP host on worker
                                              |
                                       approved server
                         \                /
                       result retained at hub
```

The TypeScript adapter projects approved tool definitions into Pi and binds invocations to their conversation and Pi tool-task IDs. Zig owns MCP JSON-RPC transport, server subprocess/connection lifetime, limits and native receipts. This is an additional native effect capability, not a worker agent loop, transcript replica, scheduler or Pi-extension host. Tool hosts live independently of Rex/TUI attachment. Grant changes and catalog browsing do not launch servers. Each invocation or explicit probe launches its approved server; startup itself may have effects. Server processes must not inherit the hub writer lock or unrelated descriptors. The hub keeps canonical invocation history; workers keep only their native configuration and receipt evidence.

The same MCP client component serves hub-local and worker-hosted tools. Worker effects reuse the existing verified effect/control channels; MCP adds no general command HTTP endpoint, worker Harness or task-client execution authority. MCP wire framing is its own protocol, not Deck's length-prefixed framing. Pin and test the supported protocol revision and advertised feature subset rather than assuming every server is compatible.

MCP server binaries and their dependencies are operator-installed. Some servers need Node/Python or external services; that does not add those runtimes to the native worker's mandatory closure. Do not install packages, execute project-supplied configuration, discover Pi extensions or start another `pi` process as a tool-loading shortcut. Arbitrary Pi hooks, custom TUI widgets and provider plugins are non-goals. Existing internal Pi Durable adapters and historical capture fields called `extensions` remain valid; this decision does not rewrite them.

### Profiles, grants and credentials

- Use explicit Deck-owned, private configuration. A profile identifies its tool host, server ID, transport, executable/argv/cwd or endpoint, approved tools, schema/configuration revision, limits, and local credential references. Pin an immutable build identity or approved digest for stdio programs; for HTTP, pin the authenticated endpoint and approved contract, not a fictitious remote executable digest. A deliberate configuration import may be added later; merely finding a `.pi` file is never approval.
- A task's saved workspace binding and tool-profile grants determine access. Hub-hosted shared services can be granted explicitly alongside assigned-worker services; there is no implicit union of every host's tools. Children inherit no broader grants. A TUI's cwd, PATH, logged-in Pi session or attachment location grants nothing.
- Keep model credentials at the hub. Resolve MCP service credentials on the designated tool host; do not forward raw environment maps or copy tokens into task records, tool definitions or logs. Do not inherit model secrets into server processes by default. Bearer/OAuth service authorization is separate from Deck's worker authentication and model-provider login.
- Identify invocations by source host, profile revision, server/tool identity and schema digest, not a display name alone. Avoid collisions between identically named tools/accounts on different hosts. Expose only the approved catalog to each conversation and recheck authority at invocation admission.
- Configuration/catalog changes are explicit, versioned operations with expected-revision checks. Initially require affected conversations to be idle and relevant calls drained. Reject stale/withdrawn tools; do not hot-replace an in-flight definition, silently rebind a server, or fall back to another host/account. Reconnect observes state; it does not add tool grants.

### Invocation and recovery contract

1. Validate the complete request, tool/schema revision, saved host/cwd and grant before native dispatch. Define supported JSON Schema keywords and bounds; refuse unsupported schemas instead of dropping constraints. Server annotations such as read-only/idempotent are hints, not authority to replay.
2. Persist the Pi invocation identity and exact validated request/configuration references. Before contacting an MCP server, persist native acceptance under an operation-specific receipt format. Keep existing native receipt identities/encodings intact; JSON-RPC request IDs alone provide correlation, not idempotency.
3. Execute once, validate/correlate the response and retain the result. An explicit identical retry consults that receipt; changed bytes/configuration conflict. Accepted-without-result remains uncertain. A server may have applied an external effect before a crash; a local journal cannot guarantee exactly-once execution at the service.
4. Reconnect, timeout and process restart must not resend an uncertain call. Disable generic library retries for effects. Do not enable automatic read retries merely from an untrusted server annotation. Cancellation is a request, not proof of rollback or completed drainage.
5. Bound each host/server's pending calls, schemas, messages, outputs, progress and deadlines. Reserve independent native control/cancellation capacity. Malformed, duplicate, stale-generation or wrong-ID responses cannot complete another call. Unsolicited server requests get a defined refusal, not arbitrary callback execution.
6. Keep display truncation separate from retained data. The first release supports explicitly bounded text/structured tool results; oversize or unsupported results are reported as such, never as successful empty output or proof that a dispatched effect was not sent. Define artifact retention separately before supporting large/binary results or claiming lossless output.

MCP progress is provisional. Tool protocol errors, service-declared tool failures, transport loss and unknown external outcomes are distinct. No private payloads or credentials should appear in diagnostics. Server instructions, descriptions and returned content remain untrusted tool data, not permission to mutate Deck policy. Returned service data can itself be sensitive and reaches hub history/model context; native MCP is not a sandbox or a guarantee of automatic secret removal. Per-call cancellation must not silently kill a shared server and unrelated calls; if the server must be fenced, report uncertainty for every affected invocation.

### Stdio implementation contract (Phases 2/3)

The implemented protocol is MCP **2025-06-18**, newline-delimited UTF-8 JSON-RPC 2.0 (not Deck framing). The first implementation uses **one isolated server process per invocation/probe**, not a shared mutable server pool. Its native tool host persists independently of TUI attachment; an invocation owns only its own process group. This intentionally trades connection reuse for isolation of cwd, credentials, cancellation and failures. It does not claim persistent server-session semantics.

- A private, explicit host configuration binds a machine ID and at most eight profiles. Each profile pins an absolute executable SHA-256, argv, fixed absolute cwd or the literal `$TASK`, optional dependency-file pins and an explicit restricted environment. Secret file references are host-local and hash-pinned. Configuration is loaded once per host start; changing it requires a controlled drained restart. Nothing is found through project/Pi configuration. Public exported catalogs contain only host/profile/revision, workspace mode and approved tool descriptors, never launch paths, environment or secret references. A profile revision hashes its complete native configuration representation.
- Each profile approves at most 16 tools. Each schema is at most 16 KiB, depth eight and 256 schema nodes; objects are closed with at most 32 properties. Supported keywords are `type`, `properties`, `required`, `additionalProperties:false`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `enum`, `title` and `description`. Types are object, bounded array, string, finite safe-range number/integer, boolean and null. No references, combinators, patterns, coercion, defaults or ignored validation keywords. Output schemas use the same subset. Input/output schema roots must be objects; arrays require `maxItems` at most 64. Arguments are bounded to 32 KiB and encoded as a single-line JSON object: CR/LF framing characters are refused, while validated literal bytes and escapes are forwarded without normalization. Original tool RPC replies are bounded to 64 KiB. General JSON is limited to depth 32, 8,192 nodes, safe finite numbers and 65,536-byte strings; duplicate object keys, including escaped aliases, are refused.
- Wire messages are at most 256 KiB. Discovery is at most 16 pages / 64 tools per page / 256 distinct tools / 1 MiB aggregate, with unique names and non-repeating bounded cursors. Approved input/output schemas must match the server structurally; unapproved tools are never projected. Server instructions/descriptions/annotations cannot add grants. Observed catalog-change notifications or approved-schema drift persist `mcp-<revision>.stale` in the native journal. They fence new work for that revision across restarts until explicit review/new revision, not automatic refresh. Already-retained identical receipts are consulted first. Buffered notifications/extra replies are drained before call dispatch/completion; this does not claim observation of notifications a terminated server would have sent later.
- Initialization has a three-second budget, discovery five seconds, and a tool call twenty seconds, within a 25-second total process budget. Existing worker transport deadlines stay unchanged. At most 64 unsolicited messages / 1 MiB aggregate are processed; stderr drainage is capped at 1 MiB. Only ping is serviced; unsupported requests get JSON-RPC `-32601`, `Unsupported client method`. No sampling, roots, elicitation, resources, prompts, logging subscriptions, HTTP or OAuth are advertised. Stderr is independently drained and never copied into diagnostics/history.
- Two MCP process slots per host are separate from the existing four native process slots; cancellation/heartbeat capacity remains independent. The Node boundary permits two outstanding MCP results and 16 ordinary results, with progress sharing the unchanged 20-request aggregate cap. Cancellation never stops another invocation. After `tools/call` dispatch, malformed/oversize/unsupported results, wrong/duplicate IDs, cancellation, timeout or process/link loss are uncertain, not proof of rollback. No server annotation authorizes retry.
- MCP uses `{version:2,kind:"mcp",hash,result}` acceptance/result records in the existing native operation-ID namespace. Acceptance is privately written/fsynced and exclusively linked before launch; completed results are atomically published. Publication fsyncs the journal directory as well as file contents, including new stale-marker names. Unpublished `*.mcp-tmp` names are not receipts or backup content. Cross-kind ID reuse conflicts; old receipts are neither converted nor overwritten. Exact original request bytes identify retries. Acceptance precedes process launch; a missing result after acceptance never causes re-execution. The validated original JSON-RPC result bytes, including supported text/structured service data, are retained rather than silently truncated or normalized.
- Public catalogs are explicitly approved at hub startup. Pi profile grants are per-conversation, changed only by a trusted-local, expected-revision, idle-only operation. Model tools cannot enroll profiles or change grants. Independent task creation starts with no MCP grants; owned children inherit no more than the parent's grants. All worker profiles require that exact assigned host, including fixed-cwd worker profiles; fixed-cwd hub service profiles are separate explicit grants. Third-worker selection is refused by grants, runtime routing, native link forwarding and worker execution. Invocations memoize host/profile/schema/binding references and recheck grants at admission. Worker MCP capability is an explicit registration opt-in, independent of Rex.

Cleanup closes stdin, attempts cancellation, gives a 100 ms grace period, signals only the invocation's process group and reaps the child. SIGPIPE is explicitly ignored so a closed server pipe cannot terminate the hub. This is not an OS sandbox, race-free executable-path pinning, or a claim that Darwin automatically kills descendants after supervisor SIGKILL. Tests clean up only their own fresh groups.

Private configs are at most 1 MiB; executable/dependency pins at most 256 MiB each, checked under the process deadline before launch. Config, catalog and credential files must be owner-only regular files, with final-component symlinks refused. Credentials are at most 4 KiB and hash-checked for each invocation. Environment entries reject `LD_*`, `DYLD_*`, `DECK_*`, `PI_*`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONHOME`, `BASH_ENV`, `ENV` and `OPENAI_API_KEY`. No parent environment is inherited by MCP servers; server runtimes may add their own platform metadata. The native supervisor's ordinary OS-session environment is separate (for example, the macOS Tailscale CLI needs its session context). Private-file ownership uses Linux `statx` UID metadata or `fstat` on the other supported compile targets; unavailable ownership evidence refuses configuration.

`McpGrantsDoc` stores the conversation's ordered profile references and revision; configuration updates also change its Pi extension selection in the same transaction. The base extension selection is captured **before** installing MCP adapters, so newly discovered definitions are not defaults. Tools validate arguments before upstream coercion, memoize `deck.mcp-invocation.v1` plan/binding data, and re-observe grants before native dispatch. Changed catalogs affect the implementation fingerprint; incompatible unfinished work cannot resume under a replacement definition. Exported catalog rows must remain unchanged when combining hosts; change the private profile and regenerate/regrant rather than editing a public descriptor under an old revision.

The [History](HISTORY.md#native-stdio-mcp-phases-23) separates isolated, installed, cross-compilation and real-machine evidence. The recorded Phase 3 gate used new disposable state, actual Tailscale verification and installed adapters with a faux-provider entry; the contracts alone are not evidence for another host/build.

### Deliberately narrow first release

The implemented surface is initialization/version negotiation, bounded paginated `tools/list`, approved `tools/call`, correlated responses and invocation-owned server shutdown over stdio. Support notifications only as specified; catalog-change notifications mark the catalog stale until an explicit refresh/review. All methods need finite deadlines and output limits. Unknown features fail clearly.

Do not initially advertise sampling, elicitation, arbitrary server-initiated operations, prompts, resources/subscriptions, or custom UI. No server may create an independent Deck model loop. These require separate designs if later needed; native MCP does not mean implementing the whole protocol at once.

Streamable HTTP follows the stdio/worker milestone: authenticated endpoint identity, TLS, session/correlation rules, redirects refused by default and deliberate retry behavior must be tested first. Start with explicitly provisioned service credentials. OAuth is a separate increment only when required by a selected integration; no silent reuse of a Pi application's live connection or credential format. Live Slack or other service tests require explicit account/scope approval and disposable test targets. MCP HTTP support does not change Rex's separate API/Unix-endpoint gates.

## Automatic startup and enrollment

`serve` defaults to the platform state directory and port 52800. Initialization, identity loading and the runtime handoff share one uninterrupted writer lock. A missing identity over an existing SQLite store is damage/restore work, not permission to assign a new machine. Real-provider 1Password bootstrap still happens before locking; provider selection and credential failures still precede Pi resume.

`deck hub` keeps a private `client/hubs/<hubId>/session.json` and launcher lock. It observes canonical hub/machine identity and actual Rex object/process state, then reuses a running client or replaces only definitively exited/missing objects. The saved pending flag precedes creation; uncertain presence/ACKs fence later launches. The hub has its own launcher, never a task allocation. `--here` retains direct-terminal behavior, and the selected client root follows the managed client.

Normal `deck agent` selects explicit `--hub`, then `DECK_HUB_REX_HOST`, otherwise local; `--local` ignores the environment. Authenticated `whoami` host/account equality, not URL spelling, determines whether an explicit remote is this host. Worker/TUI/cwd remain on the invoking machine. Invalid/unavailable remote selection never switches to local. Normal startup requires exactly **Rex API 14**. Advanced allocation independently supports exactly **8/10/14**; a higher number is not implicit compatibility.

### Transport and worker lifetime

Native `rex_forward.zig` owns session-scoped foreground `rex forward open` processes, loopback binds and byte streams. It validates bounded HTTPS coordinator endpoints (or explicit Unix test endpoints), authenticates host/account/instance before and after opening, and kills only owned tunnel children. It never scrapes terminal text or uses a direct Tailscale/unauthenticated remote HTTP fallback. Rex host access is the remote trust boundary; local loopback remains trusted-local access. It does not invent Tailscale peer attestations for tunnel sockets. Legacy actual-socket peer verification remains separate and unchanged.

Automatic serve mode has eight permanent pinned registration slots and five pipe pairs per slot. Enrollment binds `127.0.0.1:port+1` (65534 when the hub port is 65535); per-worker link listeners use ephemeral loopback ports. Native registration is saved in `rex-workers.json` under writer exclusion. Machine/build/ordered capabilities/client/socket are pinned, duplicate/local machines refuse, and a failed runtime metadata handshake fences that slot for the process lifetime. Delayed ACKs cannot register another worker. Runtime routes use evented pipes and the existing generation gate, native effects, receipts and task/launcher relay—not a new execution engine. Offline inventory remains visible. Explicit `--workers` selects the legacy inventory instead; the two managers do not overlap.

The client root contains `workers/<sha256([authenticated host, account, port])>`. A connection launcher lock plus the worker's actual writer lock serialize startup; readiness is a real scoped relay exchange, never PID-file liveness. `rex-connection.json` retains host/account/hub/client/build pins, transport session identity and a diagnostic PID. The detached native daemon calls `setsid`, ignores terminal stdio, and survives TUI closure. An uncertain-start daemon is left intact because it may own work. Session creation intent is saved before Rex; missing-session proof is required to replace it. No daemon replacement, identity reset, pin rewrite, receipt removal or uncertain-effect replay occurs automatically. Current automatic capabilities are files/bash/Rex/launcher; worker MCP still requires the explicit approved setup. No worker Pi store, inference or model credentials are introduced.

### Form, adoption and recovery

The native form and client-only Node helper share a bounded correlated bridge. Problem is nonblank and at most 2,048 UTF-8 bytes; optional description is at most 8,192. Omission differs from empty. Cwd is visible and fixed. Enter navigates, Shift-Enter/Ctrl-J inserts text, Ctrl-E controls description presence, and only **Create & start**/Ctrl-S authorizes mutation. Initial read-only polling does not swallow typing. Paste/external editing never submits or interprets commands.

Before any Rex mutation, save a startup index and per-hub/machine launch fence. Native `rex_bootstrap.zig` saves private provenance, creates the form terminal and records its exact session/window/block/PID. The helper verifies its native parent PID and `REX_BLOCK`. A form saves stable creation/adoption/input IDs and exact brief bytes before sending. Creation ACK is validated before saving the ordinary input draft and admitting adoption.

`rex_adopt` / scoped `launch_adopt` reuse Pi's allocation task. Native adoption requires the private original root/record, matching machine/cwd/client/socket/hub/port/target, authenticated Rex identity, exact live block/process and a single chat/allocation claim. Missing/foreign/changed records cannot authorize an arbitrary terminal. The wizard observes the matching public allocation before the native parent rechecks its claim and enters the existing task TUI **without replacing the process or block**. `rex_startup` verification precedes initial input. Normal reopen removes bootstrap-only authority but preserves the client draft root.

Private startup metadata lives under `client/startups`: `<UUID>.json` indexes, per-scope `.lock`/`.pending.json` launch fences, and `<UUID>/{record,form,created,adopted,input-attempt,completed,discarded,recovered}.json` stages. Directories/files are owned 0700/0600, bounded and no-follow; immutable stages use fsynced exclusive publication. These are client recovery metadata, not a queue, transcript replica or task lifecycle. `input-attempt.json` is an attempt fence, not completion evidence. A crash or lost ACK never automatically resubmits input.

`--list` and `--resume NAME` resolve independent same-worker chats to IDs. Resume saves its open request and uses `confirmedOnly`; an unconfirmed allocation cannot trigger another creation. Unknown open outcomes retain the request for inspection, not retry. `--recover ID --confirm` retrieves the exact creation and retains its initial input draft without opening/admitting; retry the original form if still present, otherwise resume and explicitly `:retry`. `--discard ID --confirm` removes only local intent/drafts, including a stale launch fence after index cleanup; possible tasks/sessions/work remain. Read-only wizard polls never advance a saved uncertain mutation. All actual execution history and allocation/receipt authority remain at the hub/native effect boundary.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/main.zig`, `src/state.zig` | CLI, private state, writer lock, supervision, and administrative launch |
| `src/native.zig`, `src/runtime_paths.zig` | Explicit I/O/environment, process helpers, and runtime paths |
| `src/hub.zig` | Loopback HTTP, private command bridge, and reply validation |
| `src/tailscale.zig`, `src/remote*.zig`, `runtime/src/remote-contracts.ts` | Peer verification, private registrations, bounded outbound worker transport, and connection-generation fencing |
| `src/worker.zig`, `src/shell.zig` | Native effects, receipts, capacity, and cancellation |
| `src/mcp_*.zig`, `runtime/src/mcp-*.ts` | Native stdio supervision/profiles/receipts; strict schemas, central Pi tool adapters and hub-only grants |
| `src/rex*.zig` | Rex discovery, forwarding, enrollment, native worker transport, terminal creation/adoption and inspection |
| `src/agent_startup.zig`, `src/hub_session.zig`, `src/private_store.zig` | Managed selection, worker/session lifetime and private native recovery metadata |
| `src/agent_form*.zig`, `runtime/src/agent-{wizard,storage,control-main}*.ts` | Creation form, exact client startup stages and list/resume/recovery |
| `runtime/src/rex-routes.ts`, `startup-status.ts` | Dynamic pinned native routes and client-only canonical readiness observation |
| `src/tui*.zig` | TUI widget, Vesper theme/layout, Markdown cells, modal editor, bridge and terminal status |
| `runtime/src/deck.ts` | Pi adapter, saved chat bindings, admission, and settings |
| `runtime/src/main.ts`, `ipc.ts`, `protocol.ts` | Runtime startup, command dispatch, and framing |
| `runtime/src/host-files.ts`, `runtime/src/remote-files.ts` | Saved-worker tool adapters/routing; no Node filesystem or cross-host fallback |
| `src/worker_main.zig`, `src/remote_worker.zig` | Standalone native-only worker startup; no Pi/model runtime |
| `src/task_relay.zig`, `runtime/src/remote-clients.ts` | Bounded worker-link RPC; mutually exclusive task/launcher authority and correlated replies |
| `runtime/src/launcher-{contracts,hub}.ts` | Closed launcher requests/ACKs and hub-side approved-machine/ownerless-task guards |
| `runtime/src/launcher-{client,drafts,main}.ts` | Client-only configured Unix transport, exact private unacknowledged requests and explicit bootstrap CLI |
| `runtime/src/task-client.ts`, `task-target.ts` | Client-only Unix transport and exact explicit task-target validation |
| `runtime/src/client.ts`, `hub-client.ts`, `drafts.ts` | Plain client, bounded HTTP, and durable request drafts |
| `runtime/src/tui-bridge.ts`, `tui-session.ts`, `tui-workspace.ts` | Client-only adapter and bounded local git display observation |
| `runtime/src/task-tools.ts`, `task-control.ts`, `subagent.ts` | Model task inspection, independent tasks, and owned delegation |
| `runtime/src/agent-names.ts` | Versioned name algorithms, central transactional sequence and permanent name reservations |
| `runtime/src/instruction-import.ts`, `instructions-view.ts` | Explicit import task and read-only provenance |
| `runtime/src/progress.ts`, `agent-status.ts` | Bounded live projections from Pi records |
| `runtime/src/rex-*.ts` | Pi-owned Rex attempts, startup, inspection, and receipt repair |
| `runtime/src/providers.ts`, `credentials.ts`, `login*.ts` | Startup auth selection, private OAuth credentials, online/offline login |
| `runtime/src/auth-bootstrap*.ts` | Pre-lock 1Password reference validation and process handoff |
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

New-flow integration is opt-in and uses a separately supplied API-14 Rex binary, private Unix servers and disposable state:

```sh
DECK_TEST_REX_FORWARD=/absolute/test/rex \
DECK_TEST_BINARY="$PWD/zig-out/bin/deck" \
  nix develop path:. -c node --test --test-concurrency=1 \
    runtime/dist/agent-startup.test.js runtime/dist/rex-enrollment.test.js
DECK_TEST_REX_FORWARD=/absolute/test/rex nix develop path:. -c zig build test
```

`DECK_TEST_REX` separately enables the older allocation/managed-hub contract suite. Neither opt-in upgrades an operator Rex installation. Private Unix “remote-selected” tests are not actual HTTPS/two-machine acceptance. The enrollment fixture injects only a disposable faux provider to exercise native bash cancellation; production deadlines and transport code are unchanged.

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

`contracts/wire.schema.json` is the single source for Deck-owned shapes. The generator supports a bounded subset of JSON Schema Draft 2020-12: local nonrecursive references, objects, bounded arrays and integers, strings, constants, enums, nullable pairs, and discriminated object unions. Unsupported keywords or shapes fail generation. Identifier-only string enums become Zig enums; bounded literal string enums (including `AgentRune`) become validated `[]const u8` values, with the same closed-membership guards in both languages.

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

`worker init` creates a new private directory, a random machine ID, and `worker.json` containing exact hub ID, hub peer and direct Tailscale `hubAddress`. Invalid options are rejected before creating the directory. It refuses existing directories rather than silently reenrolling. `identity` reads local-daemon OS identity and hashes the actual executable; these self-reported values need independent operator approval, not automatic adoption or an attestation claim. `peer` projects just the local OS peer with exact decimal user strings. `run` holds an exclusive `writer.lock` and opens only native receipts at `operations/<id>.json`: no Harness, transcript, model, provider credentials, scheduler, or inbound worker TCP listener. Do not retarget pins or clone a worker directory to run another writer.

The hub's `--workers` private registry additionally specifies `listen` on each worker entry: a hub-side literal Tailscale IP and a distinct nonzero port. Up to eight worker entries are supported, each with exactly ordered `files,bash`, or `files,bash,rex` plus an approved `rexClient` pair; the broader registry schema retains up to 64 diagnostic/future-role entries. Files/bash-only workers continue to refuse every Rex operation. Registries are immutable for the process lifetime. Revocation/changes require a controlled restart, not silent replacement. Tailscale ACLs should restrict these ports to the approved nodes. The hub checks the registry's `hubId` against its durable Pi identity before resuming work. `--workers` cannot be combined with `--stdio` or a custom runtime entry point.

A worker establishes outbound data and control TCP connections to its assigned listener. Both sockets independently verify the actual peer through the local Tailscale daemon. The data challenge/hello pins hub, machine, implementation, capabilities, optional client/socket pair and connection generation; subsequent channel headers bind the same generation and verified peer. Rex workers pair a third independently verified client socket before requests flow. No channel accepts HTTP; task RPC is confined to that optional third channel and hub-side allocation scope. OS-machine authority is not OS-user authentication; the hello fingerprint is a compatibility pin, not hardware attestation.

Each host owns independent inherited native request/result/control pipes and one serialized gate owner. TypeScript routes by the exact saved `machineId`, using evented `uv_pipe` sockets for remote descriptors rather than occupying the filesystem threadpool. No labels, client PATH, default host, or current terminal can retarget a binding. Unregistered/offline hosts return `offline` without sending this attempt; that does not disprove effects from an earlier attempt, including before a hub restart. Remote Rex operations are rejected in both the router and worker unless the exact Rex/client registration was approved. Discovery, allocation, inspection and receipt lookup then use the assigned host's native implementation. The hub selects the registered client path/socket; native allocation checks them against worker config before invoking Rex. Allocation supports only API 8/10/14 and local Unix endpoints. Coordinator forwarding is a distinct API-14 transport; historical API-9/HTTPS probes are not allocation acceptance.

The transport keeps at most 20 in-flight/result slots per host (16 effects plus four progress samples upstream), with 1 MiB frames; it never persists a second execution queue. Connect is bounded to four seconds, handshake frames to 4 KiB/five seconds, and each additional channel pairing to 20 seconds. Network frame reads/writes use absolute five-second deadlines, including partial progress; captures keep the verifier's existing limits. Control heartbeats run independently at one second with a five-second loss threshold. Cancellation uses its own bounded fixed-size records and retains a 16-ID cancellation ring across reconnection. Result backpressure cannot block control delivery. File/progress requests have a 30-second transport deadline; bash has its requested/default timeout plus five seconds. These deadlines establish uncertainty, **not rollback or file-effect drainage**.

Requests cross the network with their original bytes and IDs, preserving native hashes/receipt encodings. A lost, malformed, wrong-ID, or timed-out connection fences that generation; issued calls return `effect_uncertain`, pending transport bytes are dropped, and no effect is replayed. The worker cancels process groups and drains its existing native work before its reconnect loop proceeds. Backoff is 1, 2, 4 … up to 30 seconds; it reconnects sockets only. Reconnect does not make an old result healthy or complete. Explicit same-identity requests consult original receipts: completed matches return the retained result, changed bytes conflict, accepted-without-result stays uncertain, and corrupt receipts are not permission to execute. A general read-only receipt/reconciliation UI remains future work; there is no automatic reissue after reconnect.

Worker shutdown/connection loss does not prove that accepted file effects finished or were undone. Stop and settle all hub work and independently resolve remote uncertainty before upgrades. Keep worker configuration and receipts together when backing up; the hub's backup cannot capture a remote worker directory. Never delete a held lock or run divergent restored clones. Approving a new binary digest is an explicit operator change. Retain immutable builds; do not overwrite a running executable.

Tests cover real isolated loopback sockets with **injected verifier identities**, exact-byte lost-result recovery, cancellation under result pressure, host isolation, identity/digest refusal, and stale generation contracts. Separately, [Phase 0](HISTORY.md#phase-0-two-machine-acceptance) exercised actual Tailscale peers on two Darwin arm64 hosts, including wrong peer/implementation pins, native effects/cancellation, accepted-without-result recovery, late completion after fencing and no fallback. Native verification and deadlines were unchanged. The API 9 operator endpoint remains unsupported for Deck allocation.

### Worker-link task clients

See [operator setup](../README.md#enable-assigned-host-rex-task-clients). `worker init --client ABSOLUTE_DECK` explicitly adds `rexClient: {executable,socket}` to worker configuration; the socket is derived as `DIRECTORY/client.sock`. It does not install software, create a hub/store, contact Rex, or enroll anything. Existing workers can be changed only while stopped, preserving their identities and receipts. The full client is a separate installation; the native-only worker package retains its Node/Pi/renderer-free closure. The `client` registration boolean remains reserved diagnostic metadata, not permission for general remote hub commands.

`src/task_relay.zig` supplies an ephemeral, framed RPC channel, not another executor. It binds a third outbound socket to the already approved peer/implementation/configuration and the same fresh link generation. Both ends verify `getpeername` through their local Tailscale daemon for this socket too. The effects/control streams and capacity remain independent. The worker publishes a mode-0600 Unix socket only inside its private state directory after successful pairing. It refuses existing non-socket paths, removes only its stale socket under the held worker lock, and closes/unlinks the endpoint on session loss. No inbound worker TCP listener or remote HTTP listener is added.

Each worker allows eight task-client sockets/outstanding correlations, one request per local connection, with 1 MiB framed limits and no execution retries. Framing/flush deadlines remain absolute five seconds; clients abandon an unanswered call after ten seconds, and a worker fences a still-unanswered relay after fifteen seconds. The native hub keeps accepted in-flight calls, including partial private-pipe forwarding, until the original hub reply arrives: a detached request may already have applied or may still be admitted. This is bounded volatile transport, not a second durable command queue. Reconnect never resends it. Replies retain original generation, correlation and scope; old replies are consumed/discarded, not routed to successor sockets. All private RPC descriptors are preflighted against local/native/control descriptors and inherited only by the hub runtime. Local pipe corruption fences that host; network loss fences that generation and preserves native uncertainty.

`runtime/src/remote-clients.ts` uses the existing runtime/dispatch, not loopback HTTP. The inherited route supplies the authoritative machine ID. A request must name the current managed ownerless task, coherent machine/cwd, hub, allocation, full Rex block, and approved client/socket from the retained allocation plan. Only status/history/startup are allowed before startup registration. Remaining reads, input, stop, import and idle-only model configuration require matching startup. Login, task creation/listing/switching, hub chat access, and Rex replacement are refused. Remote status omits global Pi inspection and opaque provider model parameters. Native and TS bridges continue to pin hub/task/client mode.

Authorization runs before dispatch, after dispatch before releasing results, and again inside serialized mutation admission. Async-local guards are removed around actual Pi-owned execution so they do not become inherited authority/lifetime restrictions on background work. `stop` still acknowledges a request, not drainage. Replacing an allocation or changing approved client paths invalidates old task scope. Already admitted work is not rolled back by detach or revocation.

`runtime/src/task-client.ts` is a client-only bounded Unix transport with no store, inference, retry, redirects or provider login. Both TUI and plain launch paths require explicit hub/task/allocation and native `REX_BLOCK` with `--worker-socket`; they register startup before accepting input. A failed initial startup exits, not restarts. Existing live clients can resume fresh reads after worker reconnection; mutations/settings remain uncertain until explicit recovery. Only the existing draft store retains exact pending input on the client.

Hub `:task-at {"machineId":"32 hex ID","cwd":"/absolute/path","title":"Task"}` adds explicit creation targets to the existing draft/ACK/open sequence (plain mode retains `/task-at`). It does not migrate existing chats or change title-only task defaults. JSON preserves paths/titles with spaces without shell parsing. The existing TUI command-line bound remains 256 UTF-8 bytes with command paste disabled; longer targets use the plain client. Both bridge validators reject mixed actions, noncanonical machine IDs, relative/NUL/oversized paths and oversized titles; task clients and read-only task inspectors cannot use it.

Opt-in native integration (`DECK_TEST_REX` and `DECK_TEST_BINARY`, after `npm run build`) exercises actual inherited FIFOs, hub dispatch/Pi, all three loopback sockets with injected verification, the worker-local Unix proxy, native Rex allocation/inspection, a private supported Rex server and the real Zig TUI. It covers task-locked startup/input, same-process client reconnect, exact history preservation, and explicit same-conversation reopening. Ordinary tests cover wrong third-socket peers, stale reply fencing, role/scope refusal at admission, exact lost-ACK drafts and explicit deduplication. The separate [two-machine record](HISTORY.md#phase-0-two-machine-acceptance) adds real-peer startup, same-process reconnect, lost-input-ACK recovery, scope refusal/revocation and explicit reopen. Keep the packaged mock-runtime checks distinct from its test-only scripted-provider and last-hop fault-injection fixtures; no production guard was disabled.

### Remote bootstrap launcher

Phase 4 adds an opt-in bootstrap authority on the existing independently verified client channel. It is **not** a task allocation scope or general command API. `launcher` is the last ordered worker capability, requires a registered Rex client, and must match explicit `launcher: true` worker configuration. Hub and worker independently check the declared/approved capability; runtime routes carry a trusted native boolean. Removing approval requires controlled restart/review, not an RPC or catalog change.

`TaskClientRequest` / `TaskRelayFrame` carry exactly one of `scope` (existing managed task authority) or `launcher: {hubId}`. Generated types describe the alternatives; semantic adapters enforce exclusivity. Native pending correlations include authority as well as request ID and link generation. Changed authority, stale generations, missing approval and oversized requests refuse; reconnect does not replay. Launcher request bodies are limited to 128 KiB within the existing 1 MiB frames, eight shared client slots, 10-second client deadline and 15-second relay fence. No new listener, execution queue, scheduler or transcript store is introduced.

The dedicated `launcherResponse` handler accepts only `launch_list`, `launch_create`, `launch_open` and `launch_inspect`. The inherited route supplies the machine; the request cannot choose one. It checks the explicit hub, canonical Pi ownership, `ChatDoc.kind === "task"`, assigned machine and coherent saved `AgentDoc.cwd`. Main, owned/child, incoherent and other-host chats refuse. Mutation guards are rechecked at serialized admission/allocation. List scans 25 conversations and filters that page; an empty page can still have a next cursor. Titles are presentation only, never identity or creation arguments.

Creation uses the existing atomic `createTask` contract with a separate `launcher:<machineId>:<UUID>` namespace. Historical task hashes/receipts are unchanged. Exact brief fields—including omitted versus empty—and original cwd/title values are acknowledged and checked against retained creation metadata. Creation starts no generation or MCP grants; existing grants are never reset by opening. `launch_open` delegates to the existing best-effort Rex admission path, with the approved worker socket/client and normal startup handshake. Its legacy port field is not a new remote HTTP endpoint. The launcher cannot supply target overrides, change bindings, log in, admit task input or configure tools.

`launcher-main.js` is a client-only native entry selected only by the explicit `deck agent --launch-from ...` prefix. It does not open a Harness or load a provider. It reads a private owned worker configuration and contacts its existing Unix endpoint. Local/inspector/task CLI behavior remains unchanged; `REX_BLOCK`, cwd and labels grant nothing. Permission is for the approved OS machine, not a per-human ACL; native tools retain their OS-user authority.

Private drafts preserve the complete create/open request before dispatch. An exact validated creation ACK clears only that draft, then a separately saved open request may be sent. Creation recovery is explicit and never automatically opens. An invalid/lost open reply leaves its draft; retrying an open draft is refused. Inspection is read-only; discarding only removes local uncertainty. Subsequent explicit opening may create another terminal/supersede its old scope: this does not make Rex creation race-free or eliminate orphan risk. Storage is under `launcher-drafts/<SHA256([hubId,machineId])>` in the normal client-state root, not in Pi history or ordinary hub backups.

Coverage includes exact Unicode/empty briefs, changed-byte conflicts, grant preservation, owner/cwd refusal and admission-time rechecks, private configuration/drafts, lost ACKs/restart recovery and native scope/generation correlation. The enabled private Rex fixture now also runs the actual launcher CLI through native verified-loopback routes, receives central task input, and verifies normal startup. The separate [real-machine record](HISTORY.md#phase-4-remote-launcher) uses production Tailscale verification and installed artifacts; injected-peer tests are not that acceptance.

### Commands

Use the schema and `runtime/src/ipc.ts` for exact fields. The local command surface is:

| Group | Commands | Meaning |
| --- | --- | --- |
| Inspection | `status`, `list_chats`, `history`, `activity`, `progress`, `instruction_status` | Read saved state or bounded samples |
| Saved mutations | `admit`, `create_task`, `create_task_brief`, `import_instructions` | Durable input, conversation creation, or import-task admission |
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

## Hub workflow contracts

`deck hub` launches/reuses its managed local Rex session and exits; `--here` is the direct client entry point. Neither is a service installer. Explicit direct modes preserve normal client options and `--task` read-only inspection, but refuses allocation startup/worker-socket flags. Rex still launches `deck agent` with its pinned allocation identity. `deck serve` stays foreground under an explicitly configured external service manager; build, service restart and deployment remain separate actions.

### Briefs and creation

The schema owns `TaskBrief`, `TaskCreationForm`, `CreateTaskBriefArgs` and extended target fields. `title` is the human-supplied task title; the separate `agentName` is assigned by the hub, not accepted from the creation form. New forms/model tools enforce UTF-8 byte limits: title 200, problem 2,048, description 8,192, cwd 4,096 with no NUL and a leading `/`. An explicit form target requires both cwd and a canonical 32-hex machine ID. Unknown form fields and partial targets refuse. The TUI reuses its single 16 KiB editor for raw JSON, separately from the unchanged 256-byte/no-paste command line. JSON escaping counts toward that editor bound. It cannot open the composer over unsent text, unresolved drafts or uncertain settings. Host browsing does not discard them either.

Briefs are **creation-only immutable metadata**, not a metadata-edit or input mutation. Supplied fields become initial stored agent instructions, with their creation snapshot in `ChatDoc`; they do not start a generation. A later explicit instruction import can replace active instructions without changing the brief or old context. Legacy title-only tasks have no invented problem/description. `:brief` is a bounded read-only TUI view, available during inspection and in task clients.

Title-only creation retains its original `[title,machineId,cwd]` receipt hash and legacy API bounds. Presence of either brief field, including an empty string, uses a version-tagged tuple containing the exact values in fixed field order. No whitespace, Unicode or payload normalization is applied. Historical model titles outside the new UTF-8 bound may recover an already-created exact legacy receipt, but cannot create new work under the narrower form contract. Existing drafts remain readable; task drafts now retain optional brief fields. `taskBrief:1` in status is required before a client sends brief fields. Such drafts deterministically use the distinct `create_task_brief` command, so even an older hub encountered after a stale capability read refuses before creation instead of ignoring the fields. Legacy `create_task` still ignores its old extension fields and retains its exact behavior. A brief-bearing creation ACK must also echo the exact supplied fields; an incomplete/mismatched ACK is unconfirmed and cannot clear the draft or trigger Rex open.

Creation still follows save → create → validated ACK → clear exact draft → separate best-effort Rex open. Lost opening never resurrects creation. Lost creation keeps the original request ID/fields; there is no automatic retry. The native composer remains locked with its text until explicit retry/discard. No second per-chat editor store or submission queue was added.

### Stable agent names

`ChatDoc` retains `agentName` and `agentNameAlgorithm` for the hub, independent tasks and owned children. Naming, reservation and conversation metadata commit atomically. Independent creation retries recover the original conversation/name; child recovery uses Pi's existing ownership index. Children do not inherit the parent's name, and binding projection copies only machine/cwd. Names do not enter creation request hashes, instructions, message provenance or authority checks. Titles, briefs, canonical numeric IDs and model-facing `assistant` roles remain unchanged.

`runtime/src/agent-names.ts` owns the immutable algorithm registry and current selection. `wintermute-v1` concatenates a lowercase first-bank word (winter, frost, ash, glass, iron, pale, midnight, static, dust, hollow) with a second-bank word (mute, blind, lock, watch, drift, born, spill, cut, fold, wire). The zero-based global ordinal selects pair `(ordinal % 100) * 37 % 100`, first bank indexed by quotient and second by remainder. Each block of 100 visits every pair once; subsequent blocks append `-2`, `-3`, etc. This is deterministic allocation, not a random or globally unique name service.

Pi session documents `deck.agent-name-cursor` and the `deck.agent-name-claim` family share a monotonic ordinal and permanent reservations across algorithm versions. Allocation skips occupied names, bounded to 1,024 attempts, and refuses invalid output or numeric exhaustion rather than duplicating a name. Failed creation rolls back both sequence and reservation. Uniqueness is within one hub store; backups retain it, while different hubs may reuse the same labels. To evolve naming, add a new immutable algorithm ID/implementation and change the current selection. Never edit a released vocabulary/permutation or recompute saved task names. Canonical main is the explicit exception: fixed `hub` / `hub-v1` replaces its former generated name on startup, retaining its old permanent claim. Fresh hubs reserve `hub` without consuming a generated-name ordinal. Both cursors remain monotonic; other chats are not renamed. Existing saved versions remain readable even when not selected.

Startup backfills missing names in bounded conversation pages before `harness.resume()`, under the existing implementation-compatibility gate. It does not fabricate Deck metadata for unmanaged Pi conversations, generate input, rewrite history, or alter bindings/briefs/receipts. Saved invalid or conflicting identities fail closed. `ChatDoc` keeps its additive version-1 shape. Status, discovery and launcher metadata expose the name/version; the TUI snapshot/picker carries the name and rune. Wire fields remain optional for older responses, with neutral unnamed/dot display fallbacks when absent. Names are bounded to 64 lowercase ASCII letters/digits/hyphens, beginning with a letter, and validated in both generated codecs. Upgrade hub/client binaries together as usual; this is not permission to restart active incompatible work.

`agentRune` is additive metadata in the same transaction as naming/creation. The independent session doc `deck.agent-rune-cursor` version 1 allocates the frozen runic-v1 bank: U+16A0–U+16EA followed by U+16EE–U+16F8 (86 assigned letters/numerals, excluding punctuation and unassigned code points). Advance once per non-hub assignment and cycle only after the bank is exhausted; the name algorithm/collision loop does not consume extra runes. The canonical root ID always receives Δ and does not advance this cursor. Existing assignments are validated and never recomputed. Rollback includes rune allocation; children never inherit a parent's rune. Bounded startup backfill assigns missing symbols without rewriting names, history or bindings. Runes are presentation labels, not globally unique IDs, grants or routing. Shared schema fixtures enforce the closed symbol bank.

### Inventory and grouped inspection

`list_hosts` / model `host_list` return at most nine items: one local machine and eight registered worker routes. Rows contain only machine ID, local/worker role, Rex-client approval and sampled connection (`local`, `connected`, `offline`, `unknown`), plus a sampling timestamp. They expose no peer credentials, sockets or enrollment controls. Status advertises `hostInventory:1`. Both reply boundaries reject duplicate IDs, invalid role/connection combinations and malformed counters.

Native `link_status` is a hub-local observation of an existing verified route. It uses the shared high-half-u64 read-ID allocator, empty arguments and a closed result, never a worker request, journal entry or effect slot. The TypeScript adapter has a two-second observation budget and at most one outstanding sample per route. Timeout/failure means **unknown**; correlation remains retained until its late reply is consumed. Repeated reads do not accumulate probes or reuse late results as fresh health. Connected is only a sample, not a lease or effect guarantee. No existing network deadline was widened.

`:hosts` in the TUI selects a registered machine for a new form, leaving cwd empty for explicit entry. A form or the hub model may choose an offline registered host. Task models retain inherited creation defaults and cannot explicitly choose another host. The trusted-local legacy `:task-at` (`/task-at` in plain mode) / `create_task` path still permits arbitrary saved offline bindings; it does not enroll a worker or enable fallback. Registrations remain immutable for the running hub.

The native and plain task views group parents/children **within each page**, with explicit parent IDs for references outside the page. Wire order stays ascending; the scan cursor is never derived from display order. TUI pages contain at most 25 rows; the existing API maximum remains 100. Optional `includeObservations` reads central activity and saved Rex allocation; host inventory supplies the separate connection column. These reads neither inspect a live terminal automatically nor define task completion. Old hubs continue to render unknown observations. Owned children remain read-only and cannot gain independent direct input or model settings through a new view.

### Message provenance and recovery

Agent message text is bounded to 8,192 UTF-8 bytes. Both tools use the stable `deck-tool:TOOL_TASK_ID:message` admission key. Sender chat/tool IDs come from Pi's execution API, not arguments. An envelope records root human chat/request, hop (0–8 internally), and reply-to chat/request. It is included in canonical input metadata, the receiver's model-visible provenance prefix and bounded inspection. Reply-to identifies the selected causal input; it does not claim that a final answer completed that request. Exact retries preserve this envelope; changed content, mode or provenance conflicts. A new tool call has a new request ID, not implicit retry authority.

A generation hook records causality at **that model request's committed history cutoff**. It scans at most 100 pages of 100 canonical entries, newest first. Since the most recent direct human input it takes the highest observed agent hop, so a lower-hop message cannot reset a chain. Fresh human input starts hop zero, but input arriving after the cutoff cannot alter an older pending tool call. Missing/invalid provenance or an exhausted bounded scan fails closed for new forwarding. The outbound envelope is memoized on the Pi tool task before admission; each forwarding edge increments once, and hop eight cannot forward again. A retained legacy admission can still recover its exact old envelope without synthesizing a new budget; an unadmitted legacy reservation cannot become unbudgeted new input.

This limits causal depth, not fan-out, provider turns or arbitrary OS-user code. Native tools are not a sandbox. Pi still owns all scheduling, queues, task records and recovery. Owned children have the entire task-control extension removed. No ACK, final answer, status observation or terminal event automatically becomes input, and stopping a sender does not undo or stop admitted work in another ownerless conversation.

## Tasks and subagents

Read-only model tools `task_list`, `task_history`, and `task_activity` read canonical Pi state. Title search is bounded and paginated. They do not create documents, wake agents, or submit inspected history as input. This single-user store has no per-chat ACLs.

`task_create` makes an ownerless task without input. It inherits the caller's saved machine/cwd and main's model/thinking, not the caller's full instructions or transcript. Only the hub model may explicitly choose a registered machine and cwd. `task_message` targets another managed ownerless task, not self, main, or an owned child. Default mode is `followUp`; `steer` is explicit. `hub_message` targets main from an independent task and always uses `followUp`. Both return admission only, with authoritative agent-origin and reply provenance. See the [Phase 1 contracts](#hub-workflow-contracts) for causal limits and recovery.

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

File work uses one native worker thread. Bash and Rex processes share bounded native process capacity; at most four process slots are available. There are 16 ordinary pending effect/result slots, two additional MCP result slots and up to four ephemeral progress-read slots, all sharing an aggregate cap of 20 outstanding requests. Keep cancellation independent of full command/result pipes.

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

`clientMode` (`hub` or `task`) is pinned from launch, not inferred from a display label or selected chat. `hubChatId` is pinned by the initial validated status; both bridge endpoints reject subsequent role/root identity drift. The durable/API kind `main` is retained without migration; the UI calls it **hub**. Both roles use the same monochrome Vesper chrome; authority is never indicated solely by color. Task mode requires successful allocation-bound startup and cannot select the hub, list other chats, or create tasks. Even forged renderer requests are refused by the helper. Mode changes cannot be obtained by selecting a chat.

Hub-selected tasks are read-only. The editor/paste, send, retry/discard, stop, and configuration paths refuse; task drafts are not activated or removed. The hub can read task history/settings/Rex state and explicitly open/reopen Rex, but cannot participate without its verified task client. Direct `--task` launches and plain clients obey the same policy. This is a client interaction policy, **not authentication of the trusted-local HTTP API**; Pi-owned task tools and internal admission continue to use their existing authority.

`:tasks` shows one bounded page of at most 25 chats. Labels are clipped display data, not routing bindings. Sparse pages can advance by last-scanned cursor. `:hub` returns to the hub chat (`:main` remains a compatibility alias, also forbidden in task mode). `:task TITLE` is hub-chat-only: save the exact ordinary task draft, obtain creation ACK, remove that draft, then issue a separate best-effort `rex_open` using the returned chat ID and client port. Stay on the hub and submit no input. If opening fails or loses its ACK, retain the created chat and report the uncertain terminal attempt; no automatic retry or standalone participation fallback. Creation itself still retries only by explicit original title/binding/identity. An unavailable Rex capability refuses before creating a draft. Switching/creation refuses unsent editor text or unresolved requests; there is no extra per-chat editor store.

The editor has a 16 KiB UTF-8 limit and 32 snapshots per undo/redo stack. Paste applies atomically as literal text. Typed/pasted editor input normalizes CR/CRLF to LF and tabs to four spaces; external editor results retain exact bytes. Saved requests remain unchanged. System clipboard allocation is disabled before OSC 52 parsing.

The rendered page has at most 80 entries, about 128 KiB of text, 8,192 bytes per entry, and a 4,096-byte preview. The surface is capped at 512×120 cells (below vxfw's u16 area limit), with zero-size/very small pane guards. Display checks reject terminal controls, bidi overrides, isolated zero-width text, and pathological graphemes. Vaxis supplies grapheme and negotiated-width behavior.

`draft.saved` means confirmed cache publication, not admission. `LOCKED UNSAVED` must not permit quiet prompt loss. Input and task drafts support exact retry in the TUI; instruction-import drafts still use plain mode. Polls pause during commands, leader prefixes, paste, model/task pickers, and the Rex panel; typing/paste completion also defers the next poll by 500 ms to leave a quiet submission interval. An already-issued read is not cancelled: conflicting actions still refuse rather than queue. Fast routine polls do not redraw transport state; slow polls become visible after 500 ms. Explicit actions and fencing show immediately.

### Vesper presentation

`src/tui_theme.zig` owns the near-black `#101010`, white, `#a0a0a0`/`#505050` gray, green `#99ffe4` and orange `#ffc799` palette, inspired by [Vesper Ghostty](https://github.com/beingfranklin/Vesper-Ghostty/blob/main/themes/Vesper.conf). Geometry centers an at-most-80-column message/input region in the main pane, outdenting inline first-row markers (green `•` for user, rune for assistant) without names or message IDs. The right sidebar auto-shows at 112 columns, normally consumes 28 columns, and shrinks when explicitly forced in a narrow pane. `:sidebar-toggle` is renderer-local, survives resize, and cannot create a bridge action or modify scope. The composer grows from two rows up to half the bounded surface (leaving chat/status space), then scrolls to its cursor. Two full main-pane rules frame it, without a prompt/mode banner. Directory/branch occupies the first footer row; model/thinking is right-aligned on the lowest row, with colon command entry on its left. Long command entry scrolls by grapheme without changing bytes. Sidebar names and agent/subagent subtitles are centered; canonical main is static `Δ hub` with no subtitle. Uncertain drafts, read-only mode, transport failures and request refusal notices stay visible.

The app starts in Insert mode. All TUI commands use `:` in Normal mode; slash input is literal. Normal-mode Space is a one-key leader: `t` tasks, `m` models, `n` new task. These call the existing guarded actions, never alternate authority paths. Enter is handled by the outer widget as explicit send/create; Shift-Enter inserts a newline, and Insert Ctrl-J remains the legacy-terminal fallback. Picker/command Enter retains its existing scoped meaning. Bracketed paste is handled first and cannot submit. Name scrambling affects only sidebar/footer cells, using an 18-tick reveal and periodic busy pulses (160-tick period, 50ms nominal tick). Busy animation stops after stale observations; it is not an execution or completion signal. Message runes, the fixed hub label and OSC titles never animate. Agent kind/selected identity come from validated hub metadata, never from animation text.

`src/tui_markdown.zig` produces safe styled cells from bounded message text: ATX headings, emphasis/strike, inline/fenced code, lists, blockquotes, literal links and pipe tables with alignment, Unicode width accounting and per-cell wrapping. Tables use at most 16 columns; very narrow panes stack cells. This is a bounded terminal subset, not full CommonMark. Tool/note payloads stay plain. No HTML interpretation, remote image fetch, OSC hyperlinks, clipboard or canonical-byte rewriting. Markdown controls and styles never become executable terminal data. Rune/ZWJ emoji widths still use Vaxis's negotiated width method.

Optional TUI `cwd`, `kind`, `agentRune` and `gitBranch` are display projections. Git sampling uses client code, not a tool invocation: no subprocess, git config, hooks or environment credential access. Only a matching client cwd plus a local hub binding (or allocation-registered task client) permits observation. Bounded no-follow/nonblocking regular-file reads find `.git`/worktree HEAD, walking at most 32 ancestors, on a two-second sampling interval. Missing, remote, malformed, symlinked or oversized metadata shows an unknown branch; no other host is queried and no binding is changed.

### External prompt editing

Normal-mode `v` sets a local editor-handoff flag. `App.run` first returns and joins its input loop, then the reporter restores its title/status and Vaxis restores the terminal. `src/tui_external_editor.zig` parses bounded `$EDITOR` argv with quotes/backslashes, without a shell or expansion. It writes only the current unlocked local prompt to a random private 0700 directory / 0600 `prompt.md`; this is not a saved request. An owned foreground process group receives the terminal, including Ctrl-C. Completion or failure reclaims the original foreground group and terminal modes before a fresh Vaxis app starts, keeping the same model/bridge, selected IDs and draft state. Hub execution continues independently. SIGTERM/HUP of the client cancels the owned editor group; no hub stop is sent. Editors must wait for their document to close. They have OS-user authority, not a sandbox; editor-created backups or detached services are not managed by Deck.

Only successful exit plus a bounded private owned regular-file read (no symlink/FIFO, valid UTF-8, no NUL, at most 16 KiB) replaces the prompt, as one undoable local edit. Bytes including trailing newlines are retained, never submitted automatically. Failure leaves the original prompt unchanged. Pending transport requests, locked/saved drafts and read-only inspection refuse before launch. Temporary files are removed on return; SIGKILL cannot guarantee cleanup. Fresh observations, not pre-editor status, restore activity indicators. There is no bridge restart, startup re-registration, input replay or durable-history change.

### Terminal status

`src/tui_status.zig` uses Vaxis's [OSC 7501 implementation](https://www.superlogical.com/rex/docs/build/program-status), protocol revision 0.4. Use one record, `id=deck`, `app=deck`. The title is `<saved rune> - <selected saved workspace basename>`, at most 192 UTF-8 bytes after control/direction sanitization. The canonical hub instead uses the fixed title `Δ - hub`; missing task symbols use a neutral dot. Before validated task metadata arrives, the launch directory is a provisional label. Title updates are change-only and reset the status-report cache so the OSC 7501 title stays coherent after selection. This changes no process name, shell name, Rex allocation/session label or execution binding.

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

Endpoints allow valid percent-encoded UTF-8, with 307 encoded characters and 100 decoded socket-path bytes. Compare decoded identities without changing retained spelling or hashes. Tested allocation API revisions are explicitly 8, 10 and 14; do not accept arbitrary newer revisions. Coordinator forwarding requires exactly 14 and does not turn HTTPS into a terminal-allocation target.

The TUI `:rex` panel uses existing public status/inspection contracts with exact hub/chat scope at both bridge endpoints. Reads refresh only on explicit actions. Open/reopen uses the client's current hub port and a new explicit attempt identity. Lost replies require inspection, not automatic resend. Existing input/task/import drafts are unchanged.

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

Internal reconciliation admits a separate Pi task, reads the original native receipt and exact request hash, then applies matching creation proof. It calls no Rex mutation and preserves the original uncertain/aborted result. Missing or acceptance-only evidence stays unresolved. This is not a public repair command. Advanced public open can start a new explicit attempt after uncertainty without replaying the old accepted operation. Normal agent resume uses `confirmedOnly` and refuses this ambiguous case.

## Providers and credentials

Inference and model credentials stay on the hub. Production modes register OpenAI chat models or the mock provider, not every installed Pi provider. Validate saved model/provider choices before resume. Mock and real stores are not silently converted.

Real-provider startup uses `--auto` internally: a nonempty `OPENAI_API_KEY` wins, otherwise stored ChatGPT OAuth is required. The CLI needs no `--api-key`; that spelling is retained as a deprecated alias, not a force/fallback policy. Empty means absent; unresolved `op://`, whitespace/control-containing and oversized keys refuse rather than selecting OAuth. `startupProviders` validates/resolves authentication (including necessary OAuth refresh, with a 30-second auth-resolution signal) under the native writer lock, before `Harness.open`. Missing credentials report `deck login openai`. Startup and status expose only `api_key`, `chatgpt_oauth` or `mock`, never credential values. The selected mode remains part of the implementation fingerprint.

API-key mode captures its key once in the auth resolver and uses an empty read-only inference credential store, so an existing OAuth record cannot override it and no key is persisted. OAuth mode exposes no ambient API key to Pi; missing/expired/failed refresh never falls through to one. Stored API-key records are not a supported startup source. A separate OAuth-login models instance shares the same serialized file store, permitting explicit login while API-key inference continues without changing its selected source.

Before state/lock acquisition, real `serve` replaces itself with the client-only `auth-bootstrap-main` helper. It reads fixed `~/.config/deck/.env` via no-follow/nonblocking bounded owned-private regular-file access. Only literal `OPENAI_API_KEY=op://...` references, optional quotes, blank lines and comments are accepted; no plaintext, interpolation, duplicates or arbitrary environment names. Maximum file/reference/key sizes are 16 KiB/4,096 characters/16,384 characters. An absent or empty mapping set does not invoke `op`. Configured mappings replace the corresponding ambient value in a validated environment snapshot; `op run --no-masking` resolves it and launches a handoff helper, which removes `OP_SESSION*`, `OP_SERVICE_ACCOUNT_TOKEN` and `OP_CONNECT_TOKEN` and execs native `serve`. Passing references in the environment instead of `--env-file` prevents a second mutable dotenv read. No resolved value appears in argv or a temporary file. `op` failure never launches the hub or falls back. The internal `--credentials-resolved` flag prevents recursion; it is not an authentication boundary against the local OS user.

The Node 24 exec handoffs occur before inherited native-effect descriptors exist; `op` must not wrap the Pi child (it would not preserve those descriptors). Output masking is disabled to preserve exact framed IPC, not as a claim that output is safe to log. Native shell defaults still remove `OPENAI_API_KEY`; MCP environments remain explicitly empty/pinned. `--mock`, clients, worker startup and OAuth login do not invoke this helper. No live vault access or biometric prompt is implied by fake-executable tests. Unattended service authorization and interactive `op signin` remain operator setup.

`deck login openai [--directory STATE] [--port PORT]` first attempts the native state writer lock. If acquired, native loads the existing machine identity and replaces itself with `login-main`, explicitly inheriting the lock descriptor. At this quiescent handoff CLOEXEC must be cleared for Darwin SETEXEC; Node keeps the lock until exit and closes non-stdio descriptors in its subprocess launches. The auth-only runner never opens a Harness or execution store. If the lock is held, it instead verifies the loopback hub's native startup `machineId`, pins the observed `hubId`, and uses the existing login RPCs; connection loss/mismatch never creates an offline credential writer. This requires a compatible hub advertising `machineId`. An explicit offline login can replace a legacy stored API-key record with OAuth. `SIGINT`/`SIGTERM` cancel the login interaction; the callback remains loopback-bound. Bare `deck login` is retained as an alias.

The private plaintext `auth.json` OAuth store serializes reads/writes/refreshes under the one writer. It validates permissions and bounds, then publishes a synced 0600 temporary file by rename. This is not keychain encryption or isolation from the same OS user. Never put tokens in prompts, captures, source, derivations, arguments, or logs.

Login interactions are transient, not transcript entries. The callback binds `127.0.0.1:1455`. Abandoned flows expire after ten minutes. Views whitelist up to 16 public events and bounded prompt/options data; entered answers and tokens are omitted. The plain client refuses secret-entry prompts.

`login_reply` acknowledges delivery, not saved credentials. Report success only after a valid matching `done` observation. Cancellation is not logout and cannot prove a racing callback saved nothing. Pin the hub and interaction; never replay an unconfirmed answer automatically. Live OAuth/refresh still needs separate validation.

## Recovery and backup

### State layout

The default hub root is `~/Library/Application Support/deck` on macOS. Linux uses `$XDG_STATE_HOME/deck`, or `~/.local/state/deck`. `--directory` overrides it. Machine config and Pi state share this root; optional 1Password reference mappings live separately at `~/.config/deck/.env`.

```text
config.json                    persistent machine identity
session.sqlite                 Pi conversations and Deck documents
writer.lock                    shared native/writer exclusion
auth.json                      optional private OAuth credentials
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

Backup format 1 contains `manifest.json` and a `files/` tree. It includes config, a standalone SQLite snapshot, published native receipts, optional private `rex-workers.json` automatic registration pins (at most 64 KiB), and optional stored credentials. SQLite's backup API incorporates committed WAL without rewriting the source. The synced manifest records path, size, and SHA-256 and is published last by exclusive hard link.

Exclude locks, WAL/SHM sidecars, unpublished temporaries (including native private-store `.32-hex.tmp` files), and known logs. The owned/private `client` directory is excluded without traversal: its drafts, startup records and detached-worker states are independent recovery domains. Refuse unknown state files instead of silently omitting possible authoritative data. Workspace files, runtime packages, client drafts, ambient/1Password credentials and reference mappings, and Rex objects are outside the backup.

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
