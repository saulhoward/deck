# Deck architecture proposal

**Status:** target architecture with a partial local prototype. See [implementation progress and limitations](implementation-plan.md) for the implemented subset: Zig supervision/loopback transport, central Pi conversations, provider integration, a plain client with bounded provisional answer snapshots, native local file/bash tools, ownerless task control and Pi-owned foreground delegation. Current subagent chats are inspection/stop-only externally; the richer direct child-input/Rex contracts below are not yet implemented. Commands and protocol shapes below remain proposed contracts unless that implementation plan says otherwise.

**Chosen topology:** coordinator-owned Pi conversations and inference, with tools executing on registered workers. Every chat—including a task or subagent chat opened in Rex—uses the hub. Hub availability is required; independent worker-local inference and transcript replication are not goals.

Deck is a deliberately smaller version of [`jessfraz/agent`](https://github.com/jessfraz/agent). See [the source-based comparison](comparison-agent.md) for the rationale and omitted features.

## 1. Product and invariants

Deck is a personal agent harness: a Zig hub, CLI and TUI coordinate TypeScript agents using Pi Durable and pi-ai, with tool execution on trusted macOS/Linux machines. A persistent main conversation finds existing work before proposing another task. Each task has a named Rex session; its subagents have named terminals within that session.

Tasks begin through the hub. The user may open a task or subagent's Rex terminal and address that agent directly, without going through the main conversational agent. **This is direct conversation selection, not a bypass of the hub transport.** All requests and responses are already recorded centrally by Pi Durable. There is no separate task-lifecycle reporting protocol.

Invariants:

1. **One hub-owned Pi writer.** One TS runtime/Harness owns the canonical store for main, task, job and subagent conversations. Workers do not own Pi stores or run inference.
2. **Every chat uses that runtime.** Clients select and observe existing conversations; opening a terminal never creates a competing execution.
3. **Tools stay on their assigned machines.** A task's execution host means its workspace/tool host, not the location of its model runtime. An offline worker retains its assignments; disconnection never redirects effects to the hub or another machine.
4. **Conversation identity outlives attachment.** Detach, stop current work, terminate a process and delete history are distinct operations.
5. **Tasks group work, not lifecycle states.** Pi submissions, messages, tools and busy/idle activity supply observable status. Agents need no special completion/failure report.
6. **Admission is durable and deduplicated.** Client retries reuse request IDs. Neither admission deduplication nor Pi recovery promises exactly-once external effects.
7. **Settings are typed and scoped.** New tasks inherit main's effective model/reasoning/fast selection; resumed tasks retain their saved choices.
8. Trust is intentional: tools have the capabilities of their execution user. This is not a sandbox or multi-tenant service.

## 2. Components and ownership

```text
main TUI / plain CLI / future browser
Rex task chat / Rex subagent chat
                  |
           hub API + live views
                  |
              Zig hub
      routing, host registry, transport
                  |
          private Zig↔TS IPC
                  |
         one TS Pi application
         Pi Durable + pi-ai
         all live conversations
         one canonical SQLite store
                  |
         host-effect requests
                  |
       Zig hub routes to worker
                  |
       outbound worker connection
                  |
         Zig machine daemon
         local tools/workspace
         Rex session/terminal adapter
```

`deck serve` is a foreground Zig daemon with configured roles. Without `--hub`, an installation is hub + local worker by default; a joined installation is worker-only. The local worker follows the same tool contract as remote workers, without requiring a network loopback.

The hub supervises one TS child, which owns the Harness and its SQLite connection. Main, task and subagent agents are separate conversations in that Harness, not separate TS processes. Pi owns generation, streaming, inboxes, compaction, tool tasks and usage. Zig owns transport, process supervision and native host effects. Slow tool requests must not block other conversations or command admission.

A TS tool adapter dispatches a typed host operation through Zig and receives progress/results. Its conversation's saved binding determines the default machine and cwd. Implement standard coding tools through a worker-backed execution environment where Pi's interfaces fit; keep any custom adapter narrow. Never let a missing worker silently fall back to the hub filesystem. Model credentials and provider traffic remain on the hub.

**Rex owns its persistent sessions and terminals; Pi owns agent execution.** Rex task terminals run chat clients, not local copies of the Pi engine. Detaching Rex or exiting a chat does not stop hub-owned work. No dedicated per-task Pi runner block or task-host socket is needed. Long-running shell processes can use Rex-backed execution when they need terminal persistence; an ordinary worker-daemon child does not acquire that guarantee merely because the task has a Rex session. Keep tool process ownership/cancellation explicit.

Proposed Zig modules:

- `cli/`: arguments, defaults, init, login bridge and client commands;
- `hub/`: routing, worker registry, client sessions and native-effect dispatch;
- `machine/`: registration, inventory/load sampling, local tool execution and receipts;
- `transport/`: HTTP/SSE, worker streams, local sockets and runtime IPC;
- `rex/`: session/terminal creation, stable-ID discovery and reconciliation;
- `tui/`: editor, event reducer, Markdown and terminal layout.

Proposed TS modules under `runtime/src/`: `protocol/`, `harness/`, `providers/`, `tools/`, `tasks/`, `jobs/`, and `main.ts`. Deck's catalog, admission metadata and job definitions should use Pi transactional documents where possible, not a second hub database requiring cross-store commits. Pi types stay behind a small versioned adapter.

## 3. Initialization and defaults

Target installation:

```sh
nix profile add github:saulhoward/deck
deck init
deck serve
```

`init` writes a versioned config and persistent machine ID, creates private directories and probes dependencies. Rerunning it must not reset identities, history or credentials. Default endpoint: `http://127.0.0.1:52800`. Synthesize defaults; persist only identity, roles and deviations. Suggested overrides: `--config`, `--hub`, `--name`, `--listen`, `--directory`.

Joining alternatives:

```sh
deck init --hub http://127.0.0.1:52800
deck init --hub tailscale://100.x.x.x:52800
```

On an initialized hub machine, local joining should reuse its registration; `serve` should report the running instance rather than start a second writer. Separate instances require explicit state paths/identities. Changing an existing hub's role requires confirmation.

`tailscale://` is a Deck locator for verified tailnet transport, not a Rex URI or TLS scheme. A remote hub must listen on its Tailscale address, not just loopback; detect/confirm it during setup and allow `--listen`. Do not default to all interfaces. Client-only terminals connect to the configured hub without needing their own daemon.

Do not install services or perform sign-in during Nix builds. Later offer explicit launchd/systemd user-service installation. Rex, Tailscale and 1Password are externally managed. 1Password is optional when ambient credentials suffice.

## 4. Domain model and persistence

Use opaque stable IDs, not labels, as keys.

| Entity | Data and purpose |
| --- | --- |
| Machine | ID, verified tailnet identity, Rex locator, capabilities/capacity, last seen, connection generation |
| Task | ID, title, workspace/repository, assigned tool host, Rex binding, originating main chat; a work grouping |
| Chat | Pi conversation ID, kind (`main`, `task`, `job`, `subagent`), task/parent links, settings and tool-host binding |
| Admission | Client request ID, origin (`main`, `task-terminal`, `schedule`), conversation, mode, payload hash, immutable settings/file capture and Pi submission mapping |
| Host operation | Stable operation/tool-call ID, assigned machine, arguments, acceptance/result or uncertain status, cancellation scope |
| Job | Schedule/timezone, stable task/chat, overlap/misfire policy, enabled state |
| Occurrence | Unique `(job ID, scheduled instant)`, admission ID, captured settings/files and submission mapping |

A submission is not necessarily one generation task: steers can join existing work, and one run can answer several inputs. Preserve the mapping rather than equating these identities.

**Hub Pi SQLite** is the source of truth for every transcript, inbox, agent choice, task binding, admission, checkpoint and usage record. Application metadata lives alongside conversations as Deck-defined documents/entries. No passive archive conversations, source-to-hub ID mapping, chat ingestion pipeline, worker Pi database or live-store replication is required.

**Worker state** is limited to registration/config and native-operation bookkeeping needed to identify accepted effects, return retained results and reconcile uncertain operations. It is not a chat store or another agent scheduler. Start with the smallest journal required by the effect contract; do not add a second task catalog or conversation inbox. Clients hold display caches and unacknowledged request IDs/drafts, not execution authority. A rebuildable FTS index can be a separate derived file.

Example layout (XDG config/state/cache on Linux; Application Support/Caches on macOS, with overrides):

```text
config/deck/config.json
state/deck/session.sqlite          # hub only: all Pi conversations and Deck documents
state/deck/search.sqlite           # optional, derived and rebuildable
state/deck/assets/                 # retained hub artifacts, as supported
state/deck/worker/operations.sqlite # worker native-operation receipts, if needed
```

Use a hub process lock held through the lifetime of its TS writer, including supervisor failure: do not admit a second writer while an old child still runs. Pi does not supply cross-process locking. Zig never writes Pi tables. Migrations are versioned, backed up and downgrade-rejecting. Use SQLite's online backup/checkpoint facilities, not naked file copies while WAL writes continue. Retain runtime/extension versions needed for recovery. The prototype now has [offline backup/restore](backup-restore.md) using the SQLite backup API plus native receipts under the shared writer lock; it does not yet implement the broader migration/downgrade/online-backup policy.

**Captured file settings needs clarification.** The prototype now records explicitly labeled admission observations and guards internal configuration/reservation-gap repair; this is **not** the full snapshot contract below (see [implemented settings semantics](settings.md)). Proposed meaning: snapshot effective config/instruction files (paths, non-secret contents/hash, precedence, cwd and extension versions), not the entire worktree. Clients/worker reads supply project-local files; hub defaults/instructions are resolved centrally. A pending request may wait for required worker reads before it becomes a fully captured admission; expose that distinction rather than claiming unavailable files were captured. Once admitted, retries reuse the capture. Reproducible workspace snapshots are a separate feature.

## 5. Routing and direct task chat

Main gets orchestration tools such as `find_tasks`, `inspect_task`, `list_machines`, `message_task`, `propose_task`, `create_task`, and `schedule_job`. It does not type prompts into terminal editors.

1. Search existing task metadata and retained conversation text. Include assignments to offline workers to avoid duplicate creation.
2. Prefer explicit references and clear matches; show candidates when ambiguous.
3. If nothing fits, ask to create a task on a machine. Placement considers workspace, capabilities, memory and load—not CPU alone.
4. Persist the task/conversation, Rex allocation intent and stable request identity before native creation. Reconcile a lost creation reply before trying again.
5. Open the named Rex terminal as a client of that hub conversation. The same conversation accepts main-agent messages and terminal replies.
6. Pi records requests/responses directly in the canonical store. The main view can show linked answers for work it dispatched; task views show their own transcripts.

Opening a task/subagent terminal selects its existing conversation, not a fork or another attached executor. Enter can steer busy work or start input when idle; Tab queues a follow-up. Parent/child ownership follows Pi semantics; viewing or replying to a subagent must not create a competing owner or implicitly revive an invalid finished child ownership relationship.

**All chats being stored at the hub does not merge them into main's model context.** Preserve separate conversations, parent links and origin metadata. Main can search/read relevant exchanges. A background agent's quoted reply is evidence, not a new top-level user command. Notification grouping/muting changes presentation, not retention.

There is no task-completed/failed state machine or `report_task` tool. Pi answers, errors, tool results and activity are sufficient. A finished turn does not prove a broader project is complete. Optional future organization (titles, pinning, hiding) must not become a reporting prerequisite.

## 6. Admission, host effects and recovery

### Conversation admission

- Clients assign a request UUID before sending and retain it until acknowledged. All clients use the same hub admission path, including Rex terminals.
- The hub checks request/payload consistency and uses Pi's request identity for deduplication. Commit application admission metadata with `submit(tx, draft)` where needed so input and receipt share a transaction.
- ACK means durable Pi admission, not completion or receipt in Zig memory. A retry after a lost ACK returns the same submission.
- Pi's inbox and transcript supply the canonical order. Preserve queued input identity when it becomes a model-visible entry; do not manufacture a second user message for display.
- Use Pi's steering/follow-up behavior first. Test `steeringMode: "all"` and `followUpMode: "one-at-a-time"` against Enter/Tab semantics before adding a custom FIFO queue. A separate durable gate is not part of the initial design.

### Host effects

The Pi tool task records intent before issuing its native operation. Zig routes it to the assigned worker over that worker's existing connection. Use stable operation IDs, validated args, progress/result messages and explicit cancellation.

A worker may return a previously retained result for the same ID; conflicting payloads are rejected. If the outcome of an issued effect is unknown, report **uncertain**, not “not executed.” An unanswered operation is not automatically resent as a new command. Only proven replay-safe operations or provider-supported idempotency permit automatic retry. Native inspection/readback may reconcile actual state; neither a dead connection nor a successful Pi restart proves that an external mutation did not happen.

Bound outstanding commands/progress and keep independent control/cancellation capacity so a full pipe cannot block shutdown. A connection generation prevents stale cleanup from removing its replacement. On reconnect, refresh machine metadata and reconcile outstanding operations without moving ownership.

### Availability and failure

Hub downtime means chat, inference and new admissions are unavailable. Show that plainly; do not accept input as if it had been committed. Clients can retain drafts/unacknowledged IDs and reconnect. Existing Rex terminals/sessions and already-issued worker processes can survive, according to their actual owners. No further model progress is promised until the hub returns.

An offline worker keeps its task assignments. Other conversations/hosts can proceed, but effects for that worker wait or return an explicit unavailable result under a defined tool policy; never execute them locally on the hub. Do not blindly repeat in-flight effects when the worker returns.

Pi recovers hub execution from checkpoints after restart, with the same host bindings and operation reconciliation. No coordinator replication or automatic cross-host failover is planned. Backups/restoration are separate operational work and must not activate two writers.

Stopping is an explicit command, not socket closure. Esc aborts the selected conversation's current Pi work and foreground children, and cancels/drains its owned native operations where supported. Show Pi's actual queued-input abort behavior rather than maintaining a second paused FIFO by default. Main-chat Esc does not implicitly stop independently delegated tasks. Detach never invokes abort. Completed external effects cannot be undone by cancellation.

## 7. Scheduling

The hub owns schedules and uses **Pi durable tasks/sleeps** for timers/recovery. Zig can validate calendar definitions and calculate next instants; do not build another durable execution scheduler.

A job reuses a stable task/chat/Pi conversation, including its Rex binding. Each occurrence gets a unique `(job ID, scheduled UTC instant)` admission identity and immutable settings/file capture. Commit occurrence metadata and admission atomically through Pi.

Default overlap policy: serialize within the job. Default misfire policy: coalesce missed occurrences into one with missed-count metadata; cap configured catch-up. Calendar schedules specify timezone and DST behavior. Native manual requests retain separate identities and do not move recurring deadlines. Scheduled and terminal input use the same Pi admission path and defined queue policy.

Offline workers retain ownership; unavailable capture files/effects stay explicit. Disabling a job prevents future admissions, not already accepted work. Requests/responses are ordinary centrally stored chat; there is no extra job/task reporting lifecycle.

## 8. Rex integration

Rex's taxonomy is session → windows (tabs) → blocks (terminals). Create one named session per task, its primary chat terminal, and named subagent terminals. Persist full Rex IDs; labels can change/collide. Discover using `--json` and explicit server/session/block targets. Spawn with argv, not interpolated shell strings or `rex send` into editors.

Rely on Rex persistence. Normal reopen finds the saved session/terminal and reconnects its chat client to the hub conversation. A dead chat client may be replaced without changing conversation identity or restarting inference. Persist creation intent; after a lost reply, inspect/adopt an unambiguous existing allocation rather than create duplicates. Exact commands and restart behavior need installed-CLI validation.

Closing/disconnecting Rex UI does not stop hub inference. Destroying a Rex session affects its terminals and any processes it owns, not the existence of the centrally saved conversation. Reopening restores access to that same conversation. Tool processes actually owned by a destroyed terminal can be interrupted; represent that honestly and reconcile uncertain effects. Lack of connectivity is not proof of native absence.

Rex is the task-session interface and a useful persistent process facility, not a second agent engine. A Rex outage must be visible when creating/reopening terminals; chat history and hub-owned inference are not stored in Rex and do not disappear with it.

## 9. Interfaces and protocols

Hub HTTP `/v1` commands and SSE streams support:

- search/list tasks, chats, machines and jobs;
- create/select/message conversations, steer/follow-up input and scoped stop;
- inspect/configure settings and activity;
- page all agents' canonical history and retained artifacts;
- stream chat/activity and dispatch-linked answer notifications.

Local clients can use a private Unix socket; remote clients, including those running in Rex, use the configured authenticated hub endpoint. No worker-local chat API is necessary. Workers initiate reconnecting outbound connections to announce inventory and accept host-effect/Rex requests. Specify versions, heartbeat, jittered backoff, size limits and flow control. No chat replication protocol is required.

Zig↔TS IPC uses versioned, length-prefixed JSON over inherited pipes, with request IDs, typed errors and cancellation. TS stdout is protocol-only; logs go to stderr. Suggested errors: `offline`, `conflict`, `busy`, `unsupported`, `auth_required`, `storage_failed`, `effect_uncertain`. Define one small schema and validate both directions; avoid independently maintained unchecked Zig/TS shapes.

Expose Deck snapshots/events rather than raw Chord internals. Pi's windowed watches/history support a bounded recent view and asynchronous pagination. Attach/snapshot share a watermark or equivalent gap-safe contract. Slow clients get bounded buffers, coalesced progress and resumable views, not unbounded queues. Reading history never submits it to the model. Pi progress can be provisional (deferred persistence); durable admission/final entries are distinct from live partial display.

## 10. Terminal UX

`deck agent` reopens main chat through the hub. Rex terminals launch `deck agent --task <id>` plus a subagent selector where needed, addressing that conversation through the same hub API. Load recent history first, then older pages in the background. `/resume` selects another saved chat in place without starting a new execution. Each attached client has independent editor/scroll state. Do not steal the viewport when history or output arrives.

| Input | Meaning |
| --- | --- |
| Enter | Start input if idle; steer if busy |
| Tab | Queue a separate FIFO follow-up using Pi admission |
| Shift+Enter | Newline |
| Esc | Stop selected work, with explicit scope and queue behavior |
| `/exit`, Ctrl+C | Detach client; hub work continues |
| `?` in empty editor, `/help` | Commands and shortcuts |
| Ctrl+T | Activity view |
| Enter on activity item | Expand available reasoning or stored tool input/output |
| `/model`, `/reasoning`, `/fast` | Configure this conversation |
| `/status` | Settings, hub/assigned-worker connection, available plan usage |
| `/machines` | Host capacity, recent timestamped load and connection status |

Reasoning means provider-exposed reasoning/summary, not hidden chain of thought. Load large tool bodies on expansion.

Follow modern terminal guidance: raw-mode restoration, Kitty keyboard negotiation, bracketed paste, focus events, synchronized output where supported, grapheme-aware editing/width, resize handling, hyperlinks and bounded redraws. Probe capabilities rather than brands. Provide a newline fallback (e.g. Ctrl+J) where Shift+Enter is indistinguishable. Tab queueing needs a different completion binding. Sanitize model/tool control sequences; no arbitrary OSC execution or automatic clipboard writes.

Render Markdown tables/code/links, virtualize history and tolerate incomplete streamed syntax. Adapt wide tables to narrow terminals. Evaluate maintained Zig TUI libraries before implementing low-level rendering. Test Unicode, paste, Rex/SSH/tmux nesting, resizing and restoration after errors. `--no-tui` avoids terminal negotiation/ANSI; `--json` supports automation. A future `--wait` can return a submission outcome without making execution depend on client lifetime.

## 11. Providers, settings and credentials

Inference runs only at the hub. Default to pi-ai's OpenAI provider and **Sign in with ChatGPT**; upstream marks the separate OpenAI Codex provider legacy. Resolve an available concrete model at initial conversation creation and persist its provider/model ID. Never silently change resumed choices or fall back from failed OAuth to paid API-key access.

Persist typed `{ provider, modelId, reasoning, fast }` alongside Pi choices. Validate supported reasoning levels. Fast mode needs a tested provider mapping, requested/effective display and explicit rejection when unsupported. Apply changes at safe request boundaries with recorded settings/admission snapshots. Conversation choices do not depend on which terminal/worker displays them.

`deck login` uses the hub's TS provider flow and private persistent credential store. Credentials and OAuth refresh remain on the hub; workers do not need model-provider login. Serialize writes/refresh and use atomic private storage. Other providers use the hub's Pi environment/ambient resolution. Optional 1Password references resolve at runtime. Worker tool credentials (e.g. Git access) stay on the machines executing those tools and are separate from model credentials.

Keep secrets out of config captures, transcripts, Nix derivations and logs. All chats live centrally, including direct task interaction; define retention and backup access accordingly.

Plan quota differs from Pi token/cost accounting. Verify actual provider/reset APIs; show unavailable/stale states rather than invented percentages. Reset instants travel as UTC and display in each client's timezone with offset/countdown. Shared account quota is not additive across conversations. Agent's use of Codex quota is a possible integration to investigate, not proof of a separate Deck allowance.

## 12. Trusted network and HTTP security

Trust the pool, but verify transport identity. A claimed Rex/Tailscale address in JSON is not authentication; Rex's connection does not automatically secure Deck's separate HTTP listener.

Bind remote Deck traffic to Tailscale, verify actual peers with tailscaled LocalAPI WhoIs or a supported equivalent, and map verified identity to registration. Restrict the port with tailnet ACLs; do not accept caller-supplied identity headers. A protected proxy needs an explicit local trust boundary. Validate platform support early. Private Unix sockets can narrow local access; loopback TCP otherwise trusts local OS users.

No public listener, Deck passwords or enrollment-token layer is needed for the trusted personal deployment. Run unprivileged and support registration removal. Trusted worker compromise can expose powerful host effects and centrally retained conversations; this is not a multi-user permissions system.

For a future web UI, enforce Host/Origin checks, same-origin/CSRF protection and no wildcard CORS. Keep tokens server-side, bound payloads/artifacts, redact logs and disable unsafe Markdown HTML/links.

## 13. Packaging, tests and rollout

Current foundation: locked nixpkgs, Zig 0.15.2, Node 24 dev shell, exact Pi 1.4.0 dependencies and npm lockfile. Pi Durable is experimental; upgrades need recovery/compatibility tests. Intended targets: arm64/x86_64 macOS/Linux; claim support only after platform testing.

The Nix package now installs the Zig local prototype, compiled TS, its locked production npm closure and Node privately, preserving lazy provider assets/imports. An installed-package smoke check verifies hub/client/native-tool behavior outside the checkout without Node on PATH; see [packaging](packaging.md). No global npm or startup dependency downloads are needed. Worker-only mode is still unimplemented and should not need TS. Rex/Tailscale/1Password remain external.

Milestones:

1. **Contract spikes:** central Pi conversations, worker-backed tool/environment adapter, native Pi FIFO/abort behavior, ChatGPT login/refresh, Rex reconnect, Tailscale identity and terminal capabilities.
2. **Local slice:** one hub runtime/store, main + task + subagent conversations, Rex clients, ordinary coding tools, all-chat history, settings and detach/reopen.
3. **Remote effects:** worker registry, host affinity, reverse links, effect receipts/uncertainty, disconnect/reconnect and fault injection.
4. **TUI/history:** Markdown/activity, lazy scrolling, simple metadata/FTS related-work retrieval, machine load and plain-output parity.
5. **Jobs/monitoring:** Pi durable schedules with occurrence captures, HTTP monitoring and later web UI.

Test faux-provider inference, SQLite reopen, surviving TS-child writer locks, duplicate/conflicting admissions, lost ACKs, simultaneous main/Rex inputs, queue/steer/abort semantics, subagent ownership, tool host affinity, no offline fallback, uncertain effects and cancellation, hub restart/reconnect, stale worker generations, large history/backpressure, storage failure, terminal restoration, credential refresh, migrations and schedule DST/overlap/misfires. Verify task chat remains its own conversation rather than unsolicited model input to main. No real credentials/model calls in CI; current CI covers available macOS/Linux runner architectures.

## 14. Decisions and implications

- **Central Pi is the simplification.** One canonical store, inference/credential location and admission path replace worker Pi stores, passive archives, replication and offline local chat.
- **Hub availability is accepted.** Rex preserves terminals and appropriate native processes, not an independent inference service. Chat reconnects when the hub returns.
- **No task lifecycle protocol.** Tasks organize work; actual Pi chat/activity supplies reporting.
- **Do not merge all chats into main.** Search/links and dispatch-aware notifications avoid context explosion and instruction replay while retaining every conversation.
- **Rex persistence is not agent persistence.** Sessions/terminals are Rex-owned; generation/checkpoints/history are hub Pi-owned. Neither needs a duplicate owner.
- **Pi primitives first.** Reuse native inboxes, follow-ups, child ownership, abort and durable sleeps before inventing parallel schedulers or queues.
- **Native effects still need uncertainty handling.** Removing transcript replication does not make disconnected shell/network effects safe to repeat.
- **Captured files are not worktree snapshots.** Defer managed worktree allocation/cleanup unless actual concurrency demands it.
- **Feature scope stays narrow.** Defer source polling/triage, lifecycle outcomes, browser automation, mobile/push, historic imports, embeddings, learning and cross-host failover.
- **Remaining risks:** provider fast/quota support, worker execution-environment fit, Rex recovery and Zig TUI capability need early validation.

## References

- [Comparison with Agent](comparison-agent.md), including pinned upstream implementation references.
- [Pi repository](https://github.com/earendil-works/pi), [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md), [Durable specification](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md).
- [pi-ai providers/auth/OAuth/usage](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md).
- [Durable background subagents example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-background.ts).
- [Rex CLI](https://www.superlogical.com/rex/docs/automate/cli): stable IDs, targets and JSON output.
- [Mitchell Hashimoto: Ghostty and Modern Terminals](https://mitchellh.com/writing/ghostty-and-modern-terminals), [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/).

Exact Rex commands, worker-backed Pi interfaces, terminal library, provider quotas and Tailscale integration remain validation work, not implemented bootstrap features.
