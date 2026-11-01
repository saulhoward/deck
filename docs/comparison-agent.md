# Comparison with `jessfraz/agent`

Compared against upstream commit [`7147c1c21a736eafc7d9e6b3769f5c548630e6bd`](https://github.com/jessfraz/agent/tree/7147c1c21a736eafc7d9e6b3769f5c548630e6bd). This is a source/document review, not a claim that upstream has been run or its deployment guarantees independently verified. Upstream explicitly labels some recovery features unfinished.

## Decision after this comparison

**Chosen: A — central Pi, distributed host effects.** The user accepted coordinator-owned conversations/inference and hub-dependent Rex task chats. [The architecture proposal](architecture.md) now reflects that choice: one hub TS runtime/Harness/store, model credentials at the hub, and worker-side tools. Worker-local Pi stores, passive archives, transcript replication and offline direct chat have been removed.

The comparison below records the **pre-decision** Deck proposal so the trade-off remains understandable. References to “current Deck” in that historical analysis mean the proposal reviewed at the time, not the subsequently selected architecture.

## Summary

Deck closely matches Agent's original front-door experience: one persistent main conversation, find existing work before creating another task, named Rex sessions and subagent terminals, Pi inference/persistence, plan sign-in, scheduled conversation reuse, and an interactive terminal UI.

**Deck is a substantial feature simplification, but its current execution/storage topology is not simpler.** Agent centralizes live Pi state and inference; workers provide remote effects and terminal interaction. Deck currently puts live Pi runtimes on execution machines and adds hub-side Pi archives. That introduces transcript replication, disconnected admission ordering, per-machine credentials and two representations of each remote conversation.

There is also an important distinction between **recording every conversation at the hub** and **feeding every conversation into the main agent**. Agent already retains its conversations centrally while selectively publishing results/notices to main. Deck should retain separate chats too; removing task-outcome machinery does not require merging transcripts into main.

## Side-by-side

| Area | Agent | Current Deck proposal | Assessment |
| --- | --- | --- | --- |
| Native layer | Rust CLI/service, Ratatui TUI, generated TS/schema contracts | Zig CLI/service/TUI, TS adapters | A language choice, not itself a simplification; Zig TUI selection remains work. |
| Pi ownership | One coordinator TS application/Harness and canonical SQLite store | Main Pi at hub; per-task Pi on workers; passive Pi archive at hub | Deck is more distributed here. |
| Inference/auth | Coordinator-owned model collection and login; host effects routed outward | Inference and credentials on each execution machine | Deck adds credential placement/refresh operations across hosts. |
| Direct task terminal | Interactive Rex terminal connected to coordinator-owned conversation/attached actor | Local task-host socket, independent of hub round trips | Same user-facing idea, different availability and state ownership. |
| Central history | Native conversations are already in coordinator Pi; no live-store replication needed | Source records imported from workers into passive Pi conversations | Deck needs ordering, identity mapping, atomic receipts, gap detection and backfill. |
| Task meaning | Intended outcome, summaries, pending input, source links, resource and worker bindings | Work grouping: identity, workspace, owner, conversations and Rex binding | A genuine simplification. |
| Reporting | Durable task/agent outcomes, triage, selective notices to main | All requests/responses archived; normal Pi activity and optional dispatch-linked notifications | Remove outcome/notice-triage machinery, not conversation separation. |
| Rex | Persistent sessions/terminals with native binding inspection and allocation reconciliation | Persistent task host plus separate detachable chat terminals | Strong overlap; avoid a parallel session supervisor. Deck's runner/client separation is an explicit design choice. |
| Host links | Reverse worker connections, native inventory, connection generations, uncertain effect handling | Similar registry/relay and no automatic reassignment | Keep the core; avoid treating an offline host as permission to replay effects elsewhere. |
| Related-work retrieval | Exact-source matching, FTS + local vectors, retained imports, coverage and provenance | Task/catalog and conversation search, implementation not yet selected | Begin with IDs, metadata and FTS; defer semantic retrieval and historical import. |
| Scheduling | Pi durable background lanes/sleeps; native planner; atomic occurrence admissions | Hub job/occurrence records and dispatch, timer implementation not yet fixed | Reuse Pi scheduling rather than invent a second durable execution scheduler. |
| Settings | Typed model/reasoning/fast choices; scheduled admission snapshots; live guidance refresh | Typed choices and proposed immutable config-file capture | Similar model selection; clarify snapshot vs live refresh before copying behavior. |
| Automation | Mail/calendar/GitHub/Slack/Messages sources, event cursors, judgment and follow-through | No source intake | Large simplification; omit the whole source/outcome journal. |
| Resources/browser | Guarded multi-worktree inventory/collection and owned browser connections/effects | Normal workspace/tools; no special browser/resource manager | Large simplification. Keep workspaces explicit; defer automatic cleanup. |
| Clients | Terminal, SwiftUI iOS, attachments, push path, feedback repairs | Terminal/plain CLI; HTTP for later web UI | Large simplification; do not build mobile/push/attachment infrastructure now. |
| Later features | Historical import, semantic indexing, reviewed learning, speech, recovery roadmap | Not required | Explicit non-goals for initial Deck. |

## What the implementation confirms

### 1. “Worker” does not mean an independent Pi runtime

[Upstream architecture](https://github.com/jessfraz/agent/blob/7147c1c21a736eafc7d9e6b3769f5c548630e6bd/docs/architecture.md) says the selected coordinator is the only writer and that clients/workers use the same store. The implementation agrees:

- [`runtime/src/bridge.ts`](https://github.com/jessfraz/agent/blob/7147c1c21a736eafc7d9e6b3769f5c548630e6bd/runtime/src/bridge.ts), `openApplication`, opens the coordinator's `session.sqlite`, one Harness, model collection and task store. It configures SQLite `synchronous = FULL`.
- [`runtime/src/tasks.ts`](https://github.com/jessfraz/agent/blob/7147c1c21a736eafc7d9e6b3769f5c548630e6bd/runtime/src/tasks.ts), `TaskStore.run`, obtains the task's conversation from that Session, checks its binding and rejects a second attached worker for the actor. Execution context binds that conversation to its selected host.
- [`src/service.rs`](https://github.com/jessfraz/agent/blob/7147c1c21a736eafc7d9e6b3769f5c548630e6bd/src/service.rs) forwards runtime events/commands and routes native host calls, with special handling for attached `RunTask` connections.

Thus central chat retention is intrinsic to Agent's normal execution path, not achieved by archiving separately executing worker Pi stores.

### 2. Direct-looking Rex chat still uses the coordinator

Agent's README explicitly says “Every chat uses the coordinator.” Its task terminals remain interactive and serialize typed replies with main-agent inputs. That meets the UX of opening an agent's terminal and talking to it, but not independent local admission during a coordinator outage.

**Our earlier proposal added offline direct-chat availability as an interpretation, not an explicit user requirement.** Opening Rex and talking directly to the task agent does not by itself decide whether the agent's Pi runtime is local or coordinator-owned. The initial Deck notes did specify TS agent runtimes and persistent workers on execution machines, so this deserves an explicit decision rather than silently moving inference to the hub.

### 3. Task lifecycle is a substantial layer Deck can remove

Agent's task and agent states, `record_task`/reporting tools, outcome journal, source triage and next-actor/check semantics serve its autonomous follow-through goal. These are not prerequisites for Pi conversation persistence or named Rex sessions.

Deck's updated requirement deliberately removes this layer. A task can simply bind a project/work grouping to an owner, conversation and Rex session. Pi already records whether submissions answered, failed or were aborted, and whether work is active. Avoid deriving a new domain-level “task completed” state from those facts.

Agent's selective user-notice pipeline is also distinct from storage. Deck can show all chat in a hub view, link answers to dispatched requests and use simple subscriptions without adding outcome triage or hidden main-context projections.

### 4. Upstream has concrete primitives worth reusing conceptually

- Pi is the engine for submissions, steering, abort, watches, compaction, usage and durable sleeps.
- Native effects retain host ownership; disconnects do not move them to another machine.
- Admission is durable before a client is told it succeeded; retries preserve IDs.
- Rex allocation intent and inspection prevent duplicate sessions after uncertain creation.
- History browsing and transcript ingestion never create execution.
- Pi is authoritative; search indexes are derived and rebuildable.
- Contracts are typed and validated in both directions; UI state is separate from durable agent state.

These are good boundaries, not reasons to port Agent's many application-specific resource/state machines.

### 5. Some apparent Deck requirements need less custom machinery

Agent configures Pi with `steeringMode: "all"` and `followUpMode: "one-at-a-time"` in `bridge.ts`. Before adding Deck's separate durable FIFO gate, test whether native Pi admission already meets the requested “Tab queues a separate FIFO turn” behavior. Preserve the application-specific scheduled-settings capture, but do not duplicate Pi's inbox by default.

Agent also implements persisted background work on Pi's task/sleep machinery. Deck needs only job definitions, occurrence identity and a schedule planner around that capability, not another general-purpose timer/recovery engine in Zig.

[Upstream history documentation](https://github.com/jessfraz/agent/blob/7147c1c21a736eafc7d9e6b3769f5c548630e6bd/docs/history.md) describes inert imports using ownerless Pi conversations and application `data` entries, with checkpoints in the same transaction. This is a useful precedent if Deck keeps worker-local execution plus central archives. It is **not** an existing general live-Harness replication API; Codex import and live mirroring have different completeness/order requirements.

## Two coherent Deck architectures

### A. Central Pi, distributed host effects — closest simplified Agent

```text
main chat / Rex task chats → hub Pi runtime + canonical conversations
                                      |
                              machine connections
                                      |
                            local tools and Rex sessions
```

Keep one hub-owned Pi Harness/store initially. Task/subagent terminals select their own conversations but connect to that runtime; worker links run tools on the selected machines. Keep all chats, remove outcome triage, integrations, resource managers, embeddings, mobile clients and learning.

**Simpler:** no live transcript replication, no passive archive model, one credential location, one durable admission authority. Central history/search and a future web UI read the real conversation.

**Trade-off:** existing local effects can survive disconnection as supported by their owners, but new chat/model progress needs the hub. Rex preserves terminal processes, not the unavailable coordinator's inference service. This also changes the current worker-local TS runtime proposal.

**Selected design:** A. Hub availability is acceptable. “Direct chat” means addressing a task agent directly, not bypassing the coordinator transport.

### B. Worker-local Pi, central chat archive — current Deck proposal

```text
Rex task chats → local Pi runtime → local tools
                       |
                 durable chat sync
                       |
                 hub Pi archive
```

Keep inference/state with the task and forward every admitted request and response to a passive hub archive. Keep the hub as the creator/router of top-level tasks and the main conversation.

**Benefit:** a task remains interactive through Rex when the hub is unavailable, and local tools do not require remote-effect RPC to the inference engine. This follows the current Deck architecture.

**Cost:** record replication, local/central identity mappings, durable backfill, explicit freshness, credentials on runtime machines, and a hub representation that is not an executable copy of the source Harness. Authoritative admission ordering is local to each task. This is narrower in features than Agent but not merely Agent with modules removed.

If B is intentional, implement one local agent plus crash-safe hub ingestion before adding scheduling or polishing the TUI. Keep one source store per task as a starting point, not a proven optimal process count.

**These are alternatives, not a recommendation to support both topologies.** Supporting both doubles the hard boundaries rather than simplifying the project. A has now been selected; B is retained here only as the rejected alternative.

## Recommended scope, independent of topology

**Keep now:** Zig CLI/service, thin TS/Pi adapter, main chat, task identity/placement, named Rex chats/subagents, ordinary coding tools, typed settings, all-chat retention, simple history search, detach/reopen, and explicit host ownership.

**Add after the chat slice:** schedules reusing their conversations, richer TUI/activity, machine load display and web monitoring.

**Defer:** source polling/triage, lifecycle outcomes, proactive follow-through, browser automation, managed worktree collection, historical Codex import, embedding runner/vector index, mobile/push, attachments, feedback repair agents, speech, learning and automatic cross-host recovery.

**Follow-through from the decision (incorporated into `architecture.md`):**

1. Make inference/store ownership a short explicit decision at the top of `architecture.md`.
2. Remove the speculative FIFO gate if Pi's native mode passes behavior tests.
3. Use Pi durable scheduling for the small job feature; keep Zig's role to planning/host effects and interfaces.
4. Start retrieval with task metadata + FTS over retained user/assistant text; keep the index rebuildable.
5. Define one small versioned wire contract and generate or validate both Zig and TS bindings from it; avoid independently maintained unchecked types.
6. Keep Rex's persistence guarantees separate from server-restart recovery. Agent's [roadmap](https://github.com/jessfraz/agent/blob/7147c1c21a736eafc7d9e6b3769f5c548630e6bd/docs/roadmap.md) still calls out Rex restart reconciliation and transfer of direct worker execution as unfinished. Deck's dedicated runner is a proposal to make detach ownership explicit, not an already validated guarantee.

## Bottom line

Agent is a central conversational execution engine with a broad personal-automation layer. Deck can be a smaller main-chat/task-chat harness without that automation layer. Deck now retains Agent's centralized Pi engine and deliberately omits independent worker inference and central transcript replication.
