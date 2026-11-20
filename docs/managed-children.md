# Managed children

## Execution and identity

Managed children are Pi **ownerless** conversations with `ChatDoc.kind: "task"` and a separate immutable `managedParentChatId`. They do not use captured `parentChatId`/`ownerTaskId`. Creation validates canonical Pi ownership on the parent, rejects child parents, and inherits the saved machine/cwd. Captured delegation, naming, invocation-bound submission and foreground cancellation are unchanged.

`create_managed_child` requires a pinned `hubId` and closed arguments `{requestId,parentChatId,title,problem?,description?}`. It returns `{chatId,parentChatId,brief}`. It is not exposed through task-scoped or launcher/remote mutation allowlists. The user hub advertises `managedChildren: 1`; updated clients refuse unsupported creation without falling back to ordinary tasks. Managed-aware native/runtime contracts must be deployed together.

The `deck.managed-child-request` receipt hashes parent/title/brief in its own namespace. Creation, agent snapshot, metadata, independent name, grants and receipt commit atomically. Replay returns the original child; changed arguments conflict. No initial input or generation is admitted. Rex opening is a separate best-effort client action after a validated ACK; an uncertain open is never retried automatically.

Parent settings are checked again inside the creation transaction. Snapshotting preserves enabled tools, including nested-call/deferred tools, the offered model-tool subset, registered extensions, model/reasoning and MCP grants. Later parent configuration changes do not track into the child. The child starts with its own brief instructions, not the parent's transcript, loaded-skills history or personal instructions. Availability of inherited tools still depends on the saved host, approved catalog and registration; there is no fallback host or new capability policy.

## Messaging

`parent_message` lives in `deck.task-control`, with its existing causality hook. It infers the parent's ID and admits follow-up input with a stable Pi tool-task request ID, authoritative origin and the shared eight-hop budget. `task_message` remains the parent's explicit route to a child. All agent-origin admissions centrally check independent canonical source/target ownership and both managed relationships; neither generic `hub_message` nor `task_message` can bypass the parent-only rule. Human input through verified task participation is unaffected. No new execution queue, automatic transcript mirroring or automatic final-answer delivery exists.

Managed children are leaf nodes: allowing one to parent another would conflict with the literal parent-only communication rule. Ordinary parents may own multiple managed children; siblings cannot message each other. Existing foreground captured delegations remain available via inherited tools and their separate invocation/result mechanism.

## Human participation and drafts

The TUI `:new-child [ID]` opens the existing brief editor with `managedParentChatId`. The plain `/new JSON` command accepts the same form. A managed form may not contain `machineId` or `cwd`. The saved local draft remains `kind: "task"`, retaining the managed parent and full brief but no decorative binding. Shared delivery converts that field to wire `parentChatId`; recovery never substitutes the currently selected chat or current hub binding. Drafts are published privately before sending and removed only after exact parent/brief ACK validation. SIGKILL/lost ACK recovery is explicit, preserving the same identity.

The hub task list and attached-client sidebar label managed parentage without claiming Pi ownership. Task listing remains bounded canonical pagination, not a full-directory traversal on every poll. `:subagent` / `:parent` and the captured sidebar remain captured-only navigation. Managed agents use ordinary task inspection, Rex, and assigned-worker attachments. A pinned task client cannot navigate into its parent or another managed child, create agents, or infer write authority from relationship metadata. Existing allocation/revocation checks remain in force.

## Limits and tests

Native tools still run with the OS user's capabilities; coordination checks are not a security sandbox or history-privacy boundary. There is no reparenting, nested managed hierarchy, automatic result relay, or model-facing managed creation tool.

Regression coverage includes atomic rollback and replay/restart/SIGKILL, full/restricted tool and MCP inheritance, independent model settings, stop-parent independence, causal messaging and generic-route bypass denial, framed IPC ACK correlation, attached/remote scope checks, native/TS contract parity, saved client recovery, real PTY creation and unsent-form preservation, and unchanged captured ownership/read-only behavior.
