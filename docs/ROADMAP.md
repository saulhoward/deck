# Roadmap

This is planned work except for explicitly completed gates below, not a list of implemented commands or blanket support claims. Use the [README](../README.md) for current operation, the [Developer guide](DEVELOPER.md) for contracts, and [History](HISTORY.md) for recorded evidence. No delivery dates are implied.

## Current position

**Implemented:** default environment-key/ChatGPT-OAuth selection, pre-lock 1Password reference bootstrap and online/offline `deck login openai` (fake-auth tests, not live-account acceptance); one hub-owned Pi Harness/SQLite store; separate hub/task conversations; native files/bash; saved drafts and retained native receipts; explicit instruction import; foreground owned subagents; task inspection/creation/messaging tools; idle-only model/thinking controls; managed task-locked Rex TUIs; verified worker transport; assigned-host Rex and task relay; explicit task-target creation; stable hub-local `agentName` identities (fixed `hub` for canonical main), persisted cyclic runes (Δ for the hub), and a Vesper-inspired responsive TUI with inline rune markers, centered Markdown chat, expandable input, centered identity sidebar, colon commands, Normal-mode Space leaders and private `$EDITOR` handoff; `deck hub`, immutable creation briefs, grouped task/child inspection, registered-host selection and explicit bounded `hub_message` reporting; native MCP 2025-06-18 stdio supervision, explicit private profiles/public catalogs, idle-only task grants, and assigned-worker MCP routing.

**Evidence limit:** isolated tests are now supplemented by [Phase 0 two-machine acceptance](HISTORY.md#phase-0-two-machine-acceptance), passed on 2026-11-12 for one Darwin arm64 pair using actual Tailscale peers, mock providers and a private Rex API 10 server. This is not cross-platform, live-provider or desktop GUI acceptance. Rex allocation remains limited to API 8/10 and worker-local Unix endpoints; the existing API 9/HTTPS operator endpoint remains unsupported.

**MCP evidence limit:** Phases 2/3 passed source/installed validation and a separate [fresh two-machine MCP run](HISTORY.md#mcp-two-machine-acceptance) on 2026-11-12. The run used actual Tailscale verification, installed native binaries/adapters, a faux-provider entry and disposable servers on one Darwin arm64 pair. It does not imply live-service/provider, HTTP/OAuth or Linux runtime acceptance; the older Phase 0 run is not being reused as MCP proof.

**Not implemented:** remote task bootstrap from bare `deck agent`, MCP HTTP/OAuth, interactive child terminals, or captured scheduled jobs. `task_create` still defaults to the caller's host/cwd; only the hub model may explicitly select a registered host. `task_message` still refuses main/hub; `hub_message` is the separate explicit report path. Existing foreground delegation remains available.

## Product boundary

- One hub owns agents, model calls, admission, scheduling and canonical history. A primary task is a persistent conversation/work grouping, not a permanently running process. Its children retain Pi ownership.
- The hub is a control/chat surface. Task TUIs participate only in their allocation-bound conversation; model coordination tools are a separate authority from UI navigation.
- Workspace binding and explicit tool-profile grants determine execution. A terminal attachment never changes a task's machine, tools or credentials.
- **Native MCP is the integration surface.** Deck's Zig layer implements MCP client transport and process supervision; Pi owns durable tool invocations. Hub-hosted services and assigned-worker services are explicit choices, not automatic fallback.
- **Pi coding-agent extension compatibility is out of scope.** No plugin loader, hooks/UI emulation, worker Pi session, provider-plugin import or automatic `.pi` discovery. Internal Pi Durable adapters are not removed or confused with user plugins.
- Tool hosts outlive TUI attachment and have no agent loop or transcript replica. Server software is separately installed; optional Node/Python-based MCP servers do not become mandatory dependencies of the native worker.
- No automatic replay of input, MCP effects or Rex creation. Detach is not stop; stop ACK is not drainage; loss is not rollback. A journal cannot make an external service exactly-once.

## Next implementation sequence

Build one accepted vertical slice at a time. Phases 0–4 deliver the focused interactive workflow with stdio MCP. Phase 5 adds hosted HTTP integrations. Existing foreground subagents remain usable throughout; new child-terminal and scheduling machinery must not delay this milestone.

The order is deliberate: establish task identity/coordination first, prove MCP effects locally before distributing them, then let the remote launcher select the established task/profile contracts. Keep HTTP authentication and optional protocol features out of the first tool-host implementation.

| Phase | Deliverable | Exit evidence |
| --- | --- | --- |
| **0 — passed** | Existing two-machine baseline, one Darwin arm64 pair | Real peer/binary/client pins; effect and draft faults; reconnect/reopen without replay or fallback |
| **1 — implemented** | Clear hub workflow and task coordination | Named task brief, grouped inspection, explicit host selection, bounded task-to-hub reply |
| **2 — passed** | Native MCP on one host | Source/installed read/counter, strict boundaries, cancellation and exact/uncertain receipt recovery |
| **3 — passed for the recorded pair** | Assigned-worker MCP and tool profiles | Actual peers; host/account/workspace isolation; detach/reopen; cancellation, loss and no-replay recovery |
| 4 | Authorized remote create/open launcher | Remote shell → one hub task → assigned Rex TUI, without general hub authority |
| 5 | Streamable HTTP and selected service integration | Tested TLS/auth/session/retry contracts; approved real-service evidence |

Phase 0 is accepted for the recorded pair. Phase 1 is implemented with deterministic workflow, recovery and TUI acceptance. Phases 2/3 passed their scoped source/installed and fresh real-machine gates. Phase 4 passed its source/installed and fresh two-machine bootstrap gates on 2026-11-13; see the [recorded scope and evidence](HISTORY.md#phase-4-remote-launcher). Phase 5 is next, not implicitly authorized by that acceptance. New hosts/builds still require explicit approval and appropriate acceptance. Do not widen Rex compatibility or production deadlines to make a milestone appear complete.

### First milestone scenario

On two explicitly registered machines, use the hub TUI to create a task with a brief and saved worker/cwd. Open its Rex TUI. Give it an approved worker-local stdio MCP tool and an explicitly granted hub-hosted service tool. Send input both directly and through the hub model. Have the task report back to the hub once, with provenance. Detach, interrupt the worker link, reconnect and reopen the same conversation. Then create/open a task from the authorized remote launcher. Verify canonical history, unchanged binding/profile, no hidden generation on creation, no duplicate effect/input, and no second Pi runtime.

Use fake models and disposable MCP servers for deterministic acceptance. Real provider/service access is a separately authorized check, not implied by this scenario or by approving a worker.

## Phase 0 — Accept the existing remote baseline

**Passed for the recorded Darwin arm64 pair on 2026-11-12.** See the [acceptance record](HISTORY.md#phase-0-two-machine-acceptance) for topology, fixtures, fault cases and limits. All test processes were stopped; scratch state/receipts and staged immutable builds were retained. This was a disposable registration, not a permanent production service setup.

**Scope:** validate what is already built before layering remote MCP or bootstrap authority on it.

- Independently approve the actual worker OS peer, worker executable digest, ordered capabilities and client/socket pair. An embedded Rex node is not the worker OS identity.
- Use a supported private/test Rex endpoint and scratch hub/worker state. Repeat native file/bash effects, cancellation, lost acceptance/results, original-identity receipt recovery, stale replies and identity drift on actual machines.
- Exercise managed startup, direct task input, worker/hub reconnect, terminal exit and explicit same-conversation reopen. Keep startup evidence, terminal presence and agent activity distinct.
- Record platform/tool versions, topology and refusal cases. Preserve builds, configuration and receipts; do not install/enroll/upgrade a live host without separate authorization.

**Gate:** a repeatable two-machine run demonstrates no replay, silent generation replacement, task migration, cross-host fallback or worker Pi store. API 9 support is a separate contract exercise if needed, not a shortcut in this phase.

**Not in this phase:** new transports, MCP, new task roles, generic monitoring dashboards or automatic repair.

## Phase 1 — Make the hub/task workflow explicit

**Implemented in source.** The three slices are present: (1) `deck hub` and bounded creation briefs, (2) grouped inspection and registered-host selection, (3) explicit `hub_message` with durable correlation and an eight-hop causal limit. See [workflow contracts](DEVELOPER.md#hub-workflow-contracts) and the [validation record](HISTORY.md#phase-1-hub-workflow-and-coordination). No new execution engine or worker Pi store was introduced.

- Add `deck hub` as the clear hub-client entry point. Preserve existing client flags and inspector semantics. `deck serve` remains foreground; document external service management rather than adding an installer now.
- Extend task creation metadata with title/name, problem statement and description. Preserve stable IDs, exact creation bytes and legacy receipt compatibility. Provide bounded brief entry instead of requiring long descriptions in the existing 256-byte TUI command line; preserve unsent prompts and unresolved drafts. Saving/editing metadata must not silently submit input or rewrite old context.
- Add grouped primary-task/child inspection. Show saved binding, sampled connection/activity and Rex state separately; list offline tasks too. Do not invent an open/completed lifecycle from connectivity or a finished assistant turn.
- Expose a bounded read-only registered-host inventory and explicit host/cwd selection for hub creation, including the hub model's creation tool. Preserve inherited defaults and no-reassignment behavior. Registration/enrollment is never a model tool.
- Add an explicit task-to-hub messaging tool (`hub_message`) alongside existing task messaging. Carry stable request IDs, authoritative sender provenance and reply correlation. The first version sends explicit follow-up input; a passive-notification UI is not a prerequisite.
- Enforce a bounded causal-hop budget in agent messaging tools, propagated across agent-origin messages rather than reset by another tool call. Human initiation is distinct. Never automatically relay ACKs, status observations or final answers as new input.

**Gate exercised:** a deterministic hub → task → hub exchange creates one task, starts it only on explicit input, records both sides, and stops a scripted acknowledgement loop. Tests cover cutoff pinning against later human input, lower-hop reset refusal, SIGKILL after report admission, retained legacy envelopes, lost creation ACKs and the real PTY composer. Creation/opening remain separate mutations. Task clients remain locked; owned children still cannot receive independent direct input or model changes. Old drafts/receipts and existing task-to-task behavior remain valid.

**Deliberate initial bounds:** briefs are immutable creation snapshots, not an existing-task edit API; grouping is within bounded scan pages with parent links across pages; host samples are not health leases or task lifecycle. The eight-hop budget bounds forwarding depth, not arbitrary native code or fan-out. No new real-machine or live-provider/service acceptance is implied.

**Not in this phase:** MCP, remote launcher authority, full-text search, independent child agents, automatic outcome reporting or a new task scheduler.

## Phase 2 — Native MCP on one host

**Status: passed for the recorded scope.** Source and installed native/Pi tests cover approved read/counter tools, real TUI detach/reopen, capacity/cancellation, strict schemas, pin/credential refusal, stale fences, backup/restore and both accepted-null/completed-receipt crash recovery. See [recorded evidence and artifact identities](HISTORY.md#native-stdio-mcp-phases-23); no live provider/service or deployment is implied.

**Scope:** one complete, safe stdio MCP path on the hub's native tool host, designed for reuse on a worker. Do not prototype an unrelated Node/Pi-plugin execution path that must later be replaced.

1. **Freeze the boundary.** Define the supported MCP protocol revision, JSON Schema subset, request/response types, operation/receipt versioning and numeric bounds for catalogs, frames, concurrency, output and deadlines. Generate Deck contracts; keep external MCP framing distinct. Refuse unsupported schemas/features rather than weakening validation.
2. **Load an explicit private profile.** Use approved executable/argv/cwd, a restricted environment with local credential references, and an allowlisted catalog. No automatic project/Pi configuration, package downloads, plugin execution or secret-command expansion. Resolve task-dependent launch configuration explicitly; never mutate a shared process cwd.
3. **Implement the Zig client.** Supervise the stdio process; negotiate initialization; perform bounded paginated `tools/list`; expose approved `tools/call`; correlate responses and clean up owned resources. Separate bounded stderr diagnostics from protocol stdout. Tool-list changes require explicit refresh/review, not automatic grants.
4. **Bridge durable Pi calls.** Project only authorized descriptors into each conversation. Bind each invocation to the conversation, saved host/profile/schema revision and Pi tool-task ID. Persist acceptance before sending to the server and retain the validated result. Explicit identical retries consult receipts; changed requests conflict; accepted-without-result stays uncertain.
5. **Prove effects before enabling writes.** Start bring-up with a disposable read tool, then a fake counter mutation. Do not ship arbitrary mutating tools until loss before/after acceptance, lost server replies, restart, duplicate/wrong IDs, changed schemas and cancellation pass. MCP annotations/JSON-RPC IDs are not permission to replay.

**Gate:** a hub agent discovers only granted tools, calls both fixtures, and retains results in its existing Pi conversation. A lost mutation reply never increments the counter twice through automatic retry. Native acceptance without a result is surfaced as uncertain. Detaching the TUI does not kill the tool host. A broken server does not starve native control traffic or silently cancel unrelated conversations. Configuration secrets are not copied into catalogs, task inputs/history or diagnostics; returned service data is still treated as sensitive, not magically redacted.

**First supported surface:** bounded text/structured tool results. No sampling, elicitation, prompts, resources/subscriptions, custom UI, binary artifacts, Streamable HTTP or OAuth in this phase. Unsupported capabilities are not advertised and receive explicit refusal. This is per-invocation configuration provenance, not a claim of full per-input or per-job file capture.

## Phase 3 — Route MCP to assigned workers

**Status: passed on the recorded Darwin arm64 pair.** The [fresh acceptance run](HISTORY.md#mcp-two-machine-acceptance) used new disposable state/server/model, actual Tailscale verification and newly reviewed binary/capability pins. Worker and fixed-hub tools, account/workspace isolation, remote TUI detach/reopen/input, cancellation, accepted-null and completed-result recovery, and offline no-fallback behavior passed without replay or silent grant changes. Isolated tests additionally cover MCP without Rex, third-worker forwarding refusal and malformed/stale protocol cases. No historical scopes, live credentials or production services were reused/replaced.

**Scope:** reuse Phase 2's native component and receipt contract over the existing verified worker architecture.

- Add explicit MCP worker capability/profile approval; files/bash-only workers remain unchanged. MCP must work without Rex or a TUI installed. Do not enroll capabilities merely because an executable/configuration exists.
- Carry calls through the native effect path with bounded per-server/host capacity and independent cancellation/heartbeat progress. If an additional channel is necessary, independently verify its actual peer and generation too. Do not expose a general remote HTTP command API or misuse task-client RPC as tool-execution authority.
- Store explicit task profile grants. Resolve credentials and server startup on the designated host. Key shared server instances by compatible host/profile revision/workspace/credential context; never let one task's cwd or environment affect another.
- Namespace and validate hub-hosted versus assigned-worker tools. Exposing a shared hub service is an explicit grant, not fallback when a worker is unavailable. Recheck grants at admission, not just during catalog display.
- Test same-named tools with different hosts/accounts/workspaces, withdrawn tools, stale profile revisions, worker loss, restart, outstanding cancellation and receipt lookup. Profile changes are explicit and initially require affected work to be idle/drained.

**Gate:** on the accepted two-machine baseline, a task uses a worker-local tool and an explicitly granted hub service, while every model call and canonical conversation remains at the hub. A third/ungranted host cannot receive calls. Reconnect does not replay effects or refresh grants silently. Closing/reopening Rex does not change the selected tool environment. The worker package remains native-only; optional server runtimes are separately provisioned.

**Not in this phase:** Pi configuration auto-import, arbitrary cross-host tool selection, tool-host failover, offline inference or a worker transcript store.

## Phase 4 — Add the remote create/open launcher

**Status: passed for the recorded scope on 2026-11-13.** Final source/installed tests and fresh two-machine acceptance cover the explicit launcher authority, normal create/open, exact recovery, lost open/startup ACKs, refusals, central mock generation with selected MCP profiles, and cleanup. This is not deployment or live-provider/service acceptance; see [History](HISTORY.md#phase-4-remote-launcher).

The first launcher is an explicit, plain command surface: `deck agent --launch-from ABS_WORKER_DIRECTORY` lists at most 25 scanned conversations per page; `--new JSON --confirm` creates and separately requests opening, `--open ID --confirm` opens an assigned independent task, and `--inspect ID` observes it. `--drafts`, explicit creation `--retry UUID --confirm`, and `--discard UUID --confirm` handle local uncertainty. No implicit cwd/task selection, login or mutation-on-reconnect is permitted.

**Boundary frozen for this slice:** ordered `launcher` capability requires an approved Rex client and an explicit worker `--launcher` opt-in. Launcher and allocation-bound task scopes are mutually exclusive on the existing independently verified client channel; only list/create/open/inspect are available to launcher scope. Approval covers independent tasks assigned to that machine, not children, the main chat or another host; it is an OS-machine permission, not a per-human ACL. Creation IDs are machine-namespaced, briefs/cwd retain existing byte bounds, new tasks start with empty MCP grants, and existing selections remain unchanged. Launcher request bodies are at most 128 KiB inside the existing 1 MiB frame, eight relay slots and unchanged 10-second client/15-second relay fences. Exact drafts are stored privately before mutation; failed open replies are retained for inspection, never automatically retried. There is no new queue, store of execution history or exposed HTTP endpoint.

**Scope:** make starting work from a remote shell convenient without granting an unattached client the task or hub role.

- Provide a narrow, explicitly approved launcher permission over the verified worker link. It is separate from allocation-bound task RPC. It may request creation on that worker or opening an authorized task already bound there; it cannot enroll workers, change bindings, access hub chat/login, or become a general command client.
- Use the explicit `deck agent --launch-from ...` workflow: select the configured hub and an existing task, or explicitly confirm a new task's brief/cwd. This slice uses a plain CLI with explicit JSON/IDs and `--confirm`, not implicit selection or a new interactive picker. Preserve current local/inspector behavior; never silently infer a task from cwd, labels or `REX_BLOCK`.
- Reuse durable creation drafts and exact-identity recovery. Obtain creation ACK before the separate best-effort Rex request; a lost open reply never recreates the task. The hub authorizes the allocation and the assigned worker launches the approved task TUI.
- Require normal pinned hub/task/allocation/block startup before input. Keep bootstrap UI authority and the launched task client's authority separate. A worker link authenticates the approved machine, not a new individual OS-user identity; do not claim a per-human ACL system.

**Gate:** a remote shell can explicitly create/open one task, then participate in its managed Rex TUI with hub-owned inference and selected MCP profiles. Missing approval, wrong hub/task/host, offline workers and unsupported Rex refuse without fallback. Simulated lost creation/open/startup replies preserve exact drafts/uncertainty and cause no automatic task, input or terminal replay. No second Deck user login or exposed hub HTTP API is introduced.

**Not in this phase:** automatic enrollment, implicit task adoption, broad remote hub access or race-free Rex creation. Best-effort duplicate/orphan risks remain explicit.

## Phase 5 — Add hosted MCP integrations deliberately

**Scope:** extend the proven tool boundary, not the agent topology. This phase is needed for services requiring Streamable HTTP; it does not block the stdio milestone.

- First implement a bounded native Streamable HTTP client with tested protocol negotiation, TLS/endpoint identity, sessions, correlation, streaming/disconnect behavior and token-safe redirect rules. Connection recovery never becomes hidden mutation retry. Do not add legacy SSE transport merely for nominal coverage.
- Start with explicitly provisioned service credentials on the selected tool host. Test host-local secret resolution, revocation, wrong endpoint/account configuration, malformed replies and redaction with a disposable service.
- Add OAuth only as a separate increment required by a selected service. Specify consent, scopes, callback ownership, storage and refresh before use. Existing Pi login state is not an implicit credential-sharing API. Service authentication is distinct from worker trust and model-provider login.
- Choose one real integration, such as an MCP service exposing Slack. Record its actual server version, transport, tools and authentication requirements; do not assume a Pi Slack plugin is an MCP server. Validate a read first, then a separately approved disposable write and uncertain-outcome handling.

**Gate:** the same profile/grant/receipt rules hold over HTTP. A lost write response is not automatically resent, credentials remain local to their tool host, and account/endpoint drift cannot silently redirect a call. Record real-service evidence separately from fake-server tests. No plugin compatibility layer is introduced to bypass an unsupported protocol feature.

## Deferred work after the interactive MCP milestone

These remain goals, not competing prerequisites for Phases 1–4:

- **Interactive children:** named TUI terminals inside the primary task's Rex session. Define owned-child input, model-setting and lifetime rules first. A terminal must not revive a finished owner or create a second executor. Existing foreground children remain the baseline.
- **Scheduled jobs:** Pi-owned durable scheduling, stable job chat, unique occurrence identity and per-run captured configuration/file contents. Capture through the assigned host, retain exact contents/profile references for same-run recovery, and define atomic admission, timezone/DST, overlap and misfire behavior. Jobs and children never allocate Rex. Current version-3 admission observations are not these captures.
- **Provider acceptance:** separately authorized live OAuth/refresh, entitlement, revoked-grant and model-delegation tests. Never fall back to paid keys. Keep automated model tests offline.
- **Settings/recovery:** full per-input capture across queued input, steering, continuation, compaction and children; explicit instruction precedence; compatible migration/downgrade policy and original-build retention. No hook-only capture enforcement or rewritten historical records.
- **Operational tools:** read-only receipt/reconciliation UI, sensitive-data retention policy, backup/repair improvements, explicit service installation and timestamped capacity views. Do not reissue effects to inspect or repair them.
- **Presentation/platforms:** bounded Markdown/large-history navigation, tool-output artifacts, derived search, actual GUI/font/tmux/SSH validation and additional platform runtime tests. Cross-compilation is not runtime evidence. Incremental delivery needs bounded buffers and a canonical watermark.
- **Optional protocol growth:** reviewed MCP configuration import, additional result/resource types and interaction features only when a concrete integration requires them. Keep provider quota/fast-mode, web monitoring and unrelated automation out of the core path.

## Acceptance discipline

For each phase:

1. Write behavior, refusal cases, ownership and numeric limits before coding. Decide the exact schema/protocol subset, not a claim of generic compatibility.
2. Extend generated contracts and semantic boundary tests without changing historical request hashes/receipt encodings silently.
3. Test with scratch state, fake models and disposable services. Include crash/lost-ACK points, stale identities, bounded capacity, cancellation, redaction and exact-identity recovery.
4. Run relevant native/runtime, installed package and cross-build checks. Record source, isolated integration, real-machine and real-service evidence separately; do not invent test counts for planned features.
5. Review the phase gate before starting the next dependent slice. Deployment/enrollment/account access always requires separate authorization, settled work and retained immutable builds.

No phase authorizes automatic terminal cleanup, transcript replication, cross-host failover, hidden mutation retry, a new execution scheduler or a Pi-extension compatibility project. Rex remains best-effort; that exception does not weaken input/native/MCP effect safety. Source triage, managed worktrees, browser/mobile automation, embeddings and learning remain outside this plan.
