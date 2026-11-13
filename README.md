# Deck

Deck is a personal coding-agent tool. It has a Zig hub, command-line client, and terminal user interface (TUI). One TypeScript runtime uses Pi to store conversations and run agents. Zig runs local file and shell tools. Rex can keep task terminals open.

**Deck is a prototype.** Local hub/Rex clients, registered native workers, and opt-in assigned-host Rex task clients are implemented. [Two-machine acceptance](docs/HISTORY.md#phase-0-two-machine-acceptance) passed on one Darwin arm64 pair with mock providers and a private Rex API 10 server; the selected Rex API 9 endpoint remains unsupported. Tools run with your user permissions; the workspace is not a sandbox.

## Documentation

- [Developer guide](docs/DEVELOPER.md): architecture, contracts, storage, builds, and tests.
- [Roadmap](docs/ROADMAP.md): remaining work and acceptance checks.
- [History](docs/HISTORY.md): previous changes, design decisions, and test evidence.

These documents distinguish current behavior from the target design. A local build does not publish a release or update a running hub.

## Target workflow

**Goal, not a list of currently available commands.** Keep one hub-owned Pi runtime and SQLite store for the hub conversation, every task's primary conversation, and its children. Model calls originate at the hub; workspace operations and approved MCP tools execute on their designated hosts.

- Run the hub under an external service manager and open its control TUI with `deck hub`.
- Give each task a name, problem statement, description, one primary chat, an explicit execution-machine/cwd binding, and optional Pi-owned subagents. List saved tasks with their children; distinguish connectivity, activity and terminal presence.
- Let the hub model discover, create and message tasks. Let primary task agents message other tasks and explicitly report to the hub, with provenance and bounded message chains rather than automatic acknowledgement loops.
- From the hub, inspect tasks read-only and open/reopen their assigned-host Rex sessions. The opt-in remote `deck agent --launch-from ...` launcher selects an existing task or explicitly creates one through the hub before Rex starts its task-locked TUI. It does not create another hub or infer task identity from the current directory.
- Keep direct human input and agent-origin messages in the same primary task conversation. Model/thinking changes remain chat-scoped and idle-only in writable clients.
- Expose approved **native MCP tools**, hosted on the hub or the assigned worker. A task's saved tool profile determines access; attaching a different TUI does not change tools or credentials. Closing a terminal does not stop the agent or its tool host.

**Native MCP means Deck-owned MCP client transport and process supervision in Zig, with Pi owning durable tool invocations.** It does not mean loading Pi coding-agent extensions, reusing a running Pi session, or running another agent on each worker. MCP server programs are separate, explicitly installed software and may themselves need Node or Python. The native worker does not acquire those runtimes as mandatory dependencies. Service credentials stay with the configured tool host; model credentials stay at the hub. Reusing an MCP server configuration requires explicit Deck setup and approval, not automatic discovery of `.pi` files or arbitrary plugin execution.

Assigned-host task clients have isolated tests and a recorded two-machine Darwin arm64 acceptance run. That run used disposable registrations and mock providers, not a permanent service deployment. **Phase 1 is implemented:** `deck hub`, creation-time task briefs, grouped inspection, registered-host selection and explicit task-to-hub messaging. Native stdio MCP and explicit per-task profiles are implemented, with source/installed tests and [fresh two-machine MCP acceptance](docs/HISTORY.md#mcp-two-machine-acceptance) on the recorded Darwin arm64 pair. The explicitly approved remote bootstrap launcher is implemented, with [fresh Phase 4 acceptance](docs/HISTORY.md#phase-4-remote-launcher). `deck agent` remains compatible; bare `deck agent` on another machine still does not create a remote task or Rex allocation.

Interactive child terminals and captured, headless scheduled jobs remain later goals. Jobs will reuse their task/chat, with distinct per-run admission identities and captured file settings; jobs and their children will never allocate Rex terminals. See the [target architecture](docs/DEVELOPER.md#target-interactive-and-scheduled-architecture), [MCP boundary](docs/DEVELOPER.md#target-native-mcp-tools), and [phased plan](docs/ROADMAP.md#next-implementation-sequence). The instructions below describe what works now.

## Current workflow

1. Start one hub for your state directory and workspace.
2. Open the hub chat to plan work. Find an existing task before creating another task.
3. Inspect task chats read-only from the hub. Each task keeps its conversation, model settings, and workspace binding.
4. Participate in a task by opening/reopening its Rex session. Its allocation-verified TUI is locked to that task. There is no standalone/non-Rex task participation mode.
5. Review answers, tool results, and changed files. An accepted request is not completed work.
6. Detach when you do not need the client. The hub continues the work. Reopen the same chat later.
7. Use an explicit stop command to cancel work. Wait for outstanding effects to finish before changing settings or upgrading the hub.

Pi stores each chat separately. Task answers do not automatically become new input to the hub chat. Rex owns terminals, not agents. Closing a Rex window does not delete the chat or stop hub-owned inference.

## Build and try offline

Use Nix to build the package:

```sh
nix build path:.
./result/bin/deck --help
```

The package includes Node and the runtime. It works outside the checkout and needs no runtime downloads. The `path:.` form includes new files that are not yet tracked by Git. For a local profile installation, use `nix profile add path:.`.

Start a disposable mock hub from the checkout:

```sh
DEMO="$(mktemp -d /tmp/deck-demo.XXXXXX)"
mkdir "$DEMO/work"
./result/bin/deck init --directory "$DEMO/state"
./result/bin/deck serve --mock --port 52801 \
  --directory "$DEMO/state" --workspace "$DEMO/work"
```

In another terminal, from the checkout:

```sh
./result/bin/deck hub --port 52801
```

Use another unused port if 52801 is occupied. The mock provider makes no external model calls. It returns mock answers and does not exercise model-driven tools.

`serve` stays in the foreground. It does not install a service. For unattended use, configure your existing launchd/systemd service to run the same foreground command, with absolute executable/state/workspace paths and explicit environment. Do not start a second writer or upgrade an active hub without settling its work. `deck hub` attaches a client; it does not start or replace the service. The default endpoint is `127.0.0.1:52800`; clients must use the hub's port. `--directory` selects stored state. `--workspace` sets the initial main workspace. Saved chats keep their original binding when the hub restarts.

## Use the TUI

Interactive terminals use the TUI by default. The hub has teal status bars; Rex task clients use slate-blue bars and show `task / Rex locked`. Inspect a saved task read-only with:

```sh
deck hub --task CHAT_ID
```

Every task, child agent, and the hub agent has a stored `agentName`, separate from its title and numeric chat ID. The TUI uses this name instead of **assistant** above answers and shows it in the task picker. Names such as `wintermute`, `glasscut`, and `staticdrift` are unique within the hub's store and survive retries, restarts, and changes to the naming algorithm. The first algorithm combines two word banks; after its 100 pairs, it adds numeric suffixes such as `wintermute-2`. Existing tasks receive names on upgrade before work resumes. Names are labels, not routing or authorization identifiers.

In the hub, `/tasks` opens the task picker. It groups parents and children within each bounded scan page; parent IDs can reference another page. Saved binding, sampled connection/activity and historical Rex allocation are separate rows. Offline tasks remain visible. None of these observations is an open/completed task lifecycle. Move with `j/k` or arrows and press Enter to inspect. Use `n` for the next page, `g` for the first page, and Esc to close. `/hub` returns to the hub chat. Inspection cannot edit, send, retry/discard task drafts, stop, or change task settings. Saved task requests remain untouched. Use `/rex open` to participate in its Rex client.

From the hub chat, `/task TITLE` creates a task on the hub's saved workspace binding and then requests its Rex terminal. It does not submit input or switch the hub view. Creation and terminal allocation are separate: if Rex opening fails or is unconfirmed, the task remains saved and read-only here. Inspect it and explicitly open/reopen; never repeat creation to recover a terminal. Rex capability is required, with no local participation fallback.

For a structured brief, use `/new` in the hub chat, press `i`, then paste JSON into the **TASK BRIEF** editor:

```json
{"title":"Investigate latency","problem":"Requests slow down under load","description":"Measure first; preserve existing behavior."}
```

Use `Ctrl-S` or `:send` to create, not to submit model input. Title is limited to 200 UTF-8 bytes, problem to 2,048, description to 8,192; the complete JSON editor has an independent 16 KiB bound. Omit both `machineId` and `cwd` to inherit the hub binding, or supply both explicitly. `/hosts` lists approved hosts; Enter opens a form with that host selected and an empty cwd that you must fill. Offline registration is not availability, and unavailable work never falls back locally. `/new` cannot enroll a host or reassign an existing task. Legacy `/task-at` retains its explicit arbitrary/offline binding contract.

Briefs are immutable creation snapshots in this phase. They supply the new task's initial instructions but start no generation. `/brief` reads them without editing context. A later explicit instruction import can replace active instructions; it does not rewrite the saved brief or earlier history. `:cancel` clears only an unsubmitted form. After a lost creation ACK, use the existing exact-draft `:retry`/`:discard` flow; do not start another creation. Brief entry refuses to overwrite an unsent prompt or unresolved request. The separate command line remains 256 bytes with no command paste.

Rex task clients cannot list/create/select other tasks or return to the hub. Hub navigation/creation still refuses unsent prompt text and unresolved requests, rather than losing them. Send or clear the prompt first.

| Action | Keys or command |
| --- | --- |
| Start editing | `i` |
| Return to Normal mode | `Esc` |
| Add a line in Insert mode | Enter, Shift-Enter, or `Ctrl-J` |
| Submit or steer input | `Ctrl-S` or `:send` |
| Switch between chat and prompt | Tab or `Ctrl-W w` |
| Scroll chat | `j/k`, arrows, Page Up/Down, or mouse wheel |
| Read older or latest history | `:older`, `:latest` |
| Inspect tasks / return to hub (hub client only) | `/tasks`, `/select ID`, `/hub` |
| Create a task and request Rex (hub chat only) | `/task TITLE` |
| Compose a task brief / choose a registered host | `/new`, `/hosts` |
| Inspect the saved creation brief | `/brief` |
| Clear an unsubmitted creation form | `:cancel` |
| Create on an explicit saved host/cwd (hub only) | `/task-at {"machineId":"32 hex ID","cwd":"/absolute/path","title":"Task"}` |
| Inspect the selected task's Rex state | `/rex`; `s` refreshes status, `i` inspects presence |
| Open/reopen the selected task in Rex | `/rex open`, or `o` in the Rex view |
| Select a model | Esc, `/model`, Enter; then arrows or `j/k`, Enter to select, Esc to cancel |
| Cycle supported thinking levels | Shift-Tab |
| Retry or discard the active input/task draft | `:retry`, `:discard` |
| Request stop | `:stop` |
| Detach | `:q` or `Ctrl-C` |
| Detach and lose unsaved editor text | `:q!` |
| Show full key help | `:help` or F1 |

Editing, submission, settings changes, retry/discard, and stop are available only in the hub chat or the assigned Rex task client, not in read-only inspection.

The editor supports a Vim-style subset: motions, counts, delete/change/yank, visual selection, paste, undo, and redo. It is not full Vim. Enter adds a line; it does not submit. Pasted text never runs a command or submits input.

Unsubmitted editor text is memory-only and limited to 16 KiB. Exit warns when that text has no confirmed saved draft. The TUI renders bounded plain text and tool summaries, not Markdown. It shows a recent history window, not a complete local transcript.

The client accepts one request at a time. An overlapping action is refused, not queued. Try it again after the reply. Fast background polls keep a neutral `client` label. A poll that takes at least 500 ms shows `client waiting`. Neither label describes worker health.

The terminal title is `Δ - {dirName}`, using the client launch directory. Supported terminals receive OSC 7501 status with `app=deck`. Status distinguishes working, a new reply, a failed run, and required client action. Missing or stale observations clear the indicator. A selected-chat indicator is not proof that the whole hub is idle.

## Use the plain client

```sh
deck hub --no-tui
deck hub --no-tui --task CHAT_ID
```

| Command | Purpose |
| --- | --- |
| `/help` | List commands |
| `/tasks`, `/tasks more` | Hub only: list saved chats |
| `/select CHAT_ID`, `/hub` | Hub only: inspect a task / return to hub |
| `/task TITLE` | Hub chat only: create a task and request its Rex terminal |
| `/task-at JSON` | Hub chat only: explicit `machineId`, absolute `cwd`, and `title`; save first, then request Rex |
| `/new JSON` | Hub chat only: bounded `{title,problem?,description?,machineId?,cwd?}`; explicit hosts must be registered |
| `/hosts`, `/brief` | Read registered hosts (hub client only) / the selected chat's saved brief |
| `/status`, `/activity` | Inspect settings, bindings, or activity |
| `/older` | Read an older history page |
| `/instructions load` | Import the selected chat's `AGENTS.md` while idle |
| `/instructions`, `/instructions TASK_ID` | Inspect instruction source or import result |
| `/rex open`, `/rex status`, `/rex inspect` | Manage or inspect the selected task's Rex terminal |
| `/draft`, `/drafts` | Inspect the active draft or list saved requests |
| `/recover REQUEST_ID` | Select another saved request for this chat |
| `/retry` | Retry the active request with its original ID and arguments |
| `/discard`, `/discard REQUEST_ID` | Delete a local draft; do not cancel work |
| `/stop` | Request stop for the selected chat |
| `/exit`, `Ctrl-C` | Detach without stopping work |

The same role restrictions apply in plain mode. A direct `--task` launch is a read-only hub inspector, not an alternative participation path. A plain client within a verified allocation-bound Rex launch remains task-locked. `/main` is an unadvertised compatibility alias for `/hub`, not a way out of a task client. Enter submits only in a writable chat. Selection does not start or stop an agent. An unresolved active draft blocks selection changes.

For one-shot input to the hub chat, use `deck agent --message 'TEXT'`. This returns an admission receipt and detaches; it does not wait for an answer. `--message` always sends model input. It does not run slash commands. Redirected input also uses plain mode.

### Tasks and subagents

Models can inspect chats with `task_list`, `task_history`, and `task_activity`. Search currently filters titles; it is not full-text search.

`host_list` reads the approved host inventory, not credentials or enrollment controls. `task_create` creates an independent task without generation or Rex. It inherits the caller's saved machine/cwd and the hub's model/reasoning; only the hub model may explicitly select a registered `machineId` and `cwd`. Optional `problem`/`description` become the task's initial brief. A new tool call is a new creation, not a retry of an ambiguous one.

`task_message` sends to another independent task, not the hub or an owned child. `hub_message` explicitly reports from an independent task to the hub as follow-up input. Both return admission, **not an answer**, and retain authoritative sender, request and reply provenance. An eight-hop causal budget stops agent-message loops; only fresh human input resets it, not another tool call or a lower-hop agent message. Missing legacy provenance fails closed for new forwarding. This is a limit on messaging tools, not a sandbox or a fan-out quota. Deck never automatically relays ACKs, status or final answers. Stopping the sender does not stop admitted target work. Model coordination authority remains distinct from the task TUI's navigation lock.

`subagent` creates a Pi-owned foreground child and waits for its answer. It inherits the parent's settings and binding, but not its transcript. Stopping the parent cancels its ordinary owned work. You can inspect or stop child chats, but you cannot send them direct input or change their model independently.

### Native stdio MCP

Deck exposes explicitly approved MCP tools through the existing hub-owned Pi runtime. Zig supervises one isolated stdio server process per invocation/probe, on the assigned worker or hub. **No tools are granted by default.** Independent tasks start without grants; owned children inherit the parent's selection. Configuration/grant controls are currently an advanced **trusted-local hub API workflow**, not a TUI picker or model tool. Task-scoped clients cannot use them.

The supported protocol is **MCP 2025-06-18**, with a strict bounded JSON Schema subset and text/structured tool results. No Pi coding-agent plugins, automatic `.pi` discovery, package installation, HTTP transport or OAuth are provided. Server programs and any Node/Python dependencies are separately installed. The worker package remains native-only. Source/installed checks and [fresh Phase 3 real-machine acceptance](docs/HISTORY.md#mcp-two-machine-acceptance) passed with fake models and disposable servers on one Darwin arm64 pair. This does not imply live-service/provider, HTTP/OAuth or Linux runtime acceptance.

#### Configure and review a host

Use a private, owner-only regular file (for example, mode `0600`); do not use a symlink. This illustrative profile needs **real host IDs, paths, hashes and server schemas** before use:

```json
{
  "version": 1,
  "machineId": "<32-hex host machine ID>",
  "profiles": [{
    "id": "workspace",
    "executable": "/absolute/installed/server",
    "sha256": "<64-hex SHA-256 of executable bytes>",
    "argv": ["--stdio"],
    "cwd": "$TASK",
    "files": [],
    "env": [],
    "tools": [{
      "name": "read",
      "description": "Approved workspace read tool",
      "inputSchema": "{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}"
    }]
  }]
}
```

Copy the exact approved input/output schemas into JSON **strings**; include `outputSchema` when the server declares it. Discovery must match them structurally and cannot add tools. Pin script/dependency files with `files: [{"path":"/absolute/file","sha256":"<hash>"}]`. Use immutable installed paths: digest checks are not race-free protection against someone replacing paths during launch, and cwd is not a sandbox.

The environment starts empty. Add only explicitly required entries, either `{"name":"SERVICE_TOKEN","file":"/private/token","sha256":"<hash>"}` or a literal `{"name":"LANG","value":"C.UTF-8"}`. Secret files must be private, UTF-8, NUL-free and at most 4 KiB; their **exact bytes**, including a trailing newline, are passed through. No shell/secret-command expansion occurs. Loader/injection variables, `DECK_*`, `PI_*` and `OPENAI_API_KEY` are refused. Keep secrets out of public descriptions/schemas. A server has your OS-user authority and can return its supplied secret as tool data; MCP is **not a secret-removal boundary**.

```sh
# Export does not launch the server. Probe initializes/lists only: no tools/call.
# Startup itself may have effects, even during a probe.
umask 077
deck mcp export --config /private/host-profiles.json > /private/catalog.json
deck mcp probe --config /private/host-profiles.json --profile workspace --workspace /absolute/work

# Controlled startup only; do not replace a live hub implicitly.
deck serve --directory /private/hub-state \
  --mcp /private/host-profiles.json --mcp-catalog /private/catalog.json
```

`$TASK` means the saved task cwd on that exact host. An absolute profile cwd is fixed and never adopts the caller's cwd. A task can receive profiles on its assigned machine and separately approved **fixed-cwd hub services**, not arbitrary third-worker profiles.

For a worker, opt in with `deck-worker init ... --mcp /private/host-profiles.json`. Initialization creates its machine ID; use the new private `worker.json` identity when preparing the host profile file, before `identity`/`run`. For an existing stopped worker, preserve its identity/receipts and explicitly add the `mcp` configuration path. Review its new identity and approve the exact binary digest plus ordered `files,bash,mcp` or `files,bash,rex,mcp` capabilities on the hub. MCP does not require Rex. `deck-worker mcp export|probe` provides the same native diagnostics.

Combine reviewed exports into one hub catalog (`{"version":1,"profiles":[...]}`), preserving exported profile rows unchanged. The catalog is private and at most 256 KiB. Every remote profile must belong to an explicitly MCP-enabled registered route. Catalog-only `serve --mcp-catalog ...` is allowed for remote-only tools; local profiles also need `--mcp`. These flags do not enroll or reconnect workers themselves.

#### Grant a conversation explicit profiles

Use the existing loopback `POST /v1/command` API. First read `status` to verify the intended `hubId` and chat ID. All three MCP commands require that explicit hub identity:

```json
{"version":1,"id":"catalog-1","hubId":"<hub ID>","command":"mcp_catalog","args":{}}
```

```json
{"version":1,"id":"grants-1","hubId":"<hub ID>","command":"tool_profiles","args":{"chatId":"<chat ID>"}}
```

```json
{"version":1,"id":"grant-1","hubId":"<hub ID>","command":"set_tool_profiles","args":{"chatId":"<chat ID>","expectedRevision":0,"profiles":[{"machineId":"<host ID>","profileId":"workspace","revision":"<exported revision>"}]}}
```

Send each JSON object as a separate request, for example `curl --fail-with-body -sS -H 'Content-Type: application/json' --data-binary @request.json http://127.0.0.1:52800/v1/command`. Check the response's `ok` and exact result, not just HTTP status. Use the **observed** grant revision, not an assumed zero. At most eight profiles / 64 MCP tools may be granted to a conversation. Only independent idle/drained chats can change grants. An empty profile array revokes the selection. After an uncertain grant ACK, observe `tool_profiles` before deciding on a new change; never automatically resend the mutation.

Configuration/catalog changes require a controlled drained restart and explicit review/regrant of changed revisions. Schema drift or `tools/list_changed` creates a persistent revision fence; do not delete it to force a retry. Review the server/configuration, update its schemas/pins (or the optional `approval` label for an explicitly reviewed new revision), export again, and select that revision. Missing/withdrawn revisions expose no replacement tools. Reconnect and TUI detach/reopen do not refresh grants or change credentials.

Native acceptance is retained **before launch**. An identical invocation recovers its original result, or reports accepted-without-result as uncertain; it is never repeated to fill a missing result. Changed request bytes conflict. Tool errors and JSON-RPC errors are distinct, and neither proves rollback. Results are untrusted data retained in hub history. Keep worker configuration/receipts together; backups include local MCP receipts/stale fences but **not** external profile/catalog files, server dependencies or host-local secret files. See the [implementation contract](docs/DEVELOPER.md#stdio-implementation-contract-phases-23).

### Project instructions

`/instructions load` reads exactly `AGENTS.md` from the selected chat's saved workspace. It replaces stored explicit instructions; it does not append or merge. The text must be valid UTF-8, contain no NUL, and fit within 32 KiB. Empty text clears the explicit instructions.

Deck does not load this file automatically. The import starts no inference and requires no unfinished work. Admission is not application: inspect `/instructions` for the result. Later file edits need another explicit import. Independent tasks do not automatically copy imported instructions; foreground children inherit the parent's stored instructions.

## Connect a provider

Use separate state directories for mock, ChatGPT, and API-key testing. Deck rejects incompatible saved provider choices rather than silently converting them.

### ChatGPT mode

With `deck` installed and your workspace path selected:

```sh
deck init
deck serve --workspace /absolute/path/to/project
# In another terminal:
deck login
deck agent
```

The hub drives OpenAI's ChatGPT OAuth flow. Open the displayed URL and follow its prompts. Credentials stay on the hub. Default mode does not fall back to an ambient paid API key.

**Live ChatGPT login, account access, and refresh are not yet verified.** Automated tests use fake providers. A user previously reported a successful live API-key smoke test; see [History](docs/HISTORY.md#manual-evidence).

### Paid API-key mode

Supply `OPENAI_API_KEY` securely in the hub environment, not in command arguments or chat. Then use a separate state directory:

```sh
deck init --directory "$HOME/.local/state/deck-api"
deck serve --api-key --model gpt-4o-mini \
  --directory "$HOME/.local/state/deck-api" --workspace /absolute/path/to/project
```

This mode can incur charges. Do not run `deck login` for an API-key hub. Deck does not silently exchange OAuth and API-key credentials.

### Model and thinking settings

`serve --model ID` is a **bootstrap default**, not a model lock. It selects the model only when main is first created. Without the flag, the current OpenAI default is `gpt-6-sol`. A catalog entry does not guarantee account access.

- Saved chats keep their choices across restarts, even if the startup flag changes.
- New tasks inherit main's current saved model and thinking level.
- `/model` changes the selected chat's durable settings. All clients of that chat share them.
- The picker label `[hub default]` means the hub's startup default, not necessarily main's current choice.
- New main chats use medium thinking where supported. Non-reasoning models use off. Shift-Tab skips unsupported levels.
- Changes require no active, queued, parked, or draining work. They preserve the prompt and do not submit it.
- Resolve saved requests and unconfirmed settings outcomes before making another change. A lost settings reply causes read-back, not automatic resubmission.

The picker and status indicators need a compatible hub and client. Follow the upgrade procedure below; do not restart an active hub to try a new UI.

## Open a task in Rex

Start Rex yourself. Create or find an independent task with the plain client, then run:

```sh
deck rex open --task CHAT_ID
deck rex status --task CHAT_ID
deck rex inspect --task CHAT_ID
```

First open finds `rex` on the assigned execution host's PATH and discovers its running local Unix server. It does not use the client's PATH or autostart Rex. Optional overrides are `--rex`, `--server`, `--host-id`, and `--instance-id`. Later opens reuse the saved target; they do not migrate it. Use `--port N` for another Deck hub.

`open` and `reopen` have the same behavior. A running client is reused. An exited or missing client gets a new window. A missing session gets a new session. A failed inspection is not proof that an object is missing. These commands do not focus the Rex GUI.

**Rex creation is best-effort.** A lost reply or concurrent request can leave duplicate or orphaned terminals. Inspect the attempt and Rex before explicitly trying again. Cleanup is manual. No automatic retry submits model input or repeats a native operation.

Rex allocation supports independent task chats, not main or owned children. Managed launches use the TUI. Before enabling input, the client verifies its hub, chat, initial history, and allocation-bound native terminal ID. A failed or lost startup reply disables the client; it does not trigger a retry or submit input. A direct `deck agent --no-tui --task CHAT_ID` launch inspects read-only. Plain task participation requires the same pinned hub/task/allocation and native `REX_BLOCK` startup verification as the TUI; plain mode is not a bypass.

From the TUI, use `/rex` for allocation status and `i` for a fresh presence sample. These are separate from agent activity. Use `o` or `/rex open` for an explicit open/reopen. Reads do not create terminals. The panel does not poll continuously; `s` and `i` refresh it.

## Recover an unconfirmed request

Input, task creation, and instruction import save a private draft before sending. If saving fails, the client sends nothing. A lost reply can mean the request was already accepted.

1. Reconnect to the same hub and original chat.
2. Inspect the active draft. The TUI can retry input/task drafts. Use the plain client for instruction-import drafts or multiple saved requests.
3. Use `/retry` or `:retry` only when you intend to retry the original request.
4. Use discard only to forget the local draft. It cannot undo admission or cancel effects.

Retry preserves the original ID and arguments. It does not submit the clipped display preview. Deck never retries a mutation automatically. A new model tool call has a new identity and can repeat an effect; inspect uncertain effects first.

## Stop, upgrade, and back up

**Detach is not stop. A stop acknowledgement is not completed cancellation.** File operations already issued must finish. Shell cancellation cannot undo files or network effects, and deliberately escaped processes can survive.

Before an upgrade:

1. Keep the previous immutable build and a secure way to restore provider access.
2. Finish or explicitly stop work across **all** chats, including queued, parked, background, and owned-child work. Inspect global status, not only the selected-chat indicator.
3. Wait for outstanding work to settle. Stop the hub and wait for the actual writer lock to be released.
4. Back up the offline state. Start the new build and reopen clients.

Changed code cannot resume unfinished work. If startup refuses, use the original build and mode. Never delete `writer.lock` or edit stored identities to bypass this check. A surviving Pi child can still hold the lock after the supervisor exits.

```sh
deck backup --directory /path/to/state --output /path/to/new-backup
deck restore --from /path/to/new-backup --directory /path/to/new-state
```

Destination paths must not exist; their parents must exist. These commands do not stop or resume work. Backup includes Pi state, config, and native receipts. It excludes the workspace, runtime, client drafts, and Rex objects. Stored credentials are excluded unless you add `--include-credentials`; environment-only keys are never copied.

Restore keeps identities and workspace bindings. Do not run source and restored copies as separate hubs. An old backup can forget later effects without undoing them. Reconcile that difference before serving or retrying drafts. See [recovery and backup details](docs/DEVELOPER.md#recovery-and-backup).

## Register a files/bash worker

This default configuration enables **files/bash only**. [Rex task clients](#enable-assigned-host-rex-task-clients) require explicit additional approval. Pi, models, history, and credentials stay at the hub. The worker uses its saved machine ID/cwd; disconnection never redirects its work locally. [Phase 0 acceptance](docs/HISTORY.md#phase-0-two-machine-acceptance) exercised real OS Tailscale peers on two Darwin arm64 hosts. The separate isolated TCP suite still uses injected verifier identities; neither proves every platform or deployment.

Both OS hosts need a running Tailscale backend and an explicit absolute Tailscale executable. An embedded Rex service's node identity is **not** automatically the worker OS's identity. Do not expose the loopback chat API or reuse a Rex HTTPS URL as a worker endpoint.

1. Build `nix build path:.#worker --out-link result-worker` for the native-only package. It contains `deck-worker`, with no Node/Pi runtime dependency. The full package also includes it. Use the **same executable** for identity approval and running: `deck worker` is another entry point, but its binary digest differs.
2. Obtain the existing hub's `hubId` from its status, its direct OS Tailscale IP (`tailscale ip -4`), and its exact peer identity:
   ```sh
   deck-worker peer --tailscale /absolute/path/to/tailscale
   ```
   On macOS the executable may be `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Peer user IDs are emitted as strings; do not round-trip them through floating-point JSON numbers.
3. On the worker, initialize a **new, absolute, dedicated** directory. Its parent must exist:
   ```sh
   deck-worker init --directory /absolute/new-worker-state \
     --hub-id HUB_ID --hub-address HUB_TAILSCALE_IP:52901 \
     --hub-node HUB_STABLE_NODE_ID --hub-user HUB_DECIMAL_USER_ID
   deck-worker identity --directory /absolute/new-worker-state \
     --tailscale /absolute/path/to/tailscale
   ```
   Initialization creates a private machine identity and hub pins, not a Pi store or connection. Review the returned machine ID, OS peer, implementation SHA-256, and ordered `files,bash` capabilities independently before approving them.
4. On the hub, create a private regular registry file (mode `0600`), with this shape. Replace every placeholder with approved values. Each worker needs its own hub-side Tailscale listener port; at most eight workers are enabled:
   ```json
   {
     "version": 1,
     "hubId": "HUB_ID",
     "hosts": [{
       "machineId": "WORKER_32_HEX_MACHINE_ID",
       "peer": { "nodeId": "WORKER_STABLE_NODE_ID", "userId": "WORKER_DECIMAL_USER_ID" },
       "client": false,
       "implementation": "WORKER_BINARY_SHA256",
       "capabilities": ["files", "bash"],
       "listen": "HUB_TAILSCALE_IP:52901"
     }]
   }
   ```
5. After settling all hub work, start the hub with the approved registry (keep its normal provider/model options), then run the worker:
   ```sh
   # Hub: separate worker listeners; chat API remains loopback-only.
   deck serve --directory /absolute/hub-state \
     --workers /absolute/private/registry.json --tailscale /absolute/path/to/tailscale
   # Worker: outbound connections; no worker listener or provider login.
   deck-worker run --directory /absolute/new-worker-state \
     --tailscale /absolute/path/to/tailscale
   ```

Registrations are loaded at hub startup, not auto-discovered or hot-reloaded. The worker verifies the hub on both actual sockets; the hub verifies the worker, pins, capabilities, and fresh generation. The connected log is a connection event, not proof of task completion. Reconnect uses backoff and never replays effects. Lost outcomes remain uncertain; an explicit original-identity retry consults retained receipts. Keep the worker configuration and receipts together, and never run divergent copies of its state.

Existing saved bindings use the worker through the native adapter. Files/bash-only workers still refuse Rex. Do not start `deck serve` on the worker to join the hub—that creates another hub.

`deck remote-check` remains a read-only peer/registration diagnostic with `connection: "not_checked"`; it does not enroll or connect anything. See [transport details and limits](docs/DEVELOPER.md#registered-filesbash-workers).

## Enable assigned-host Rex task clients

Rex over Tailscale provides terminal access; Deck adds **no second user login**. A remote task TUI connects to a private Unix socket on its worker. Its task commands travel on a separate bounded channel of the same verified worker link, not through a remotely exposed hub HTTP API. Pi, inference, history, and scheduling remain on the hub.

1. Install the full Deck client and a supported Rex CLI/server on the execution host. Run Rex and the worker as the same OS user so its terminals can access the private client socket. The native-only worker package does not contain the TUI or Node; installing the client separately does not make the worker daemon a Pi runtime. Rex must be reachable through a **worker-local Unix endpoint**, with API **8 or 10**. HTTPS targets and API 9 are still refused.
2. For a **new** worker, add `--client /absolute/path/to/deck` to `deck-worker init`. The worker saves that client path and a derived `client.sock` path inside its private state directory (socket path at most 100 UTF-8 bytes). `identity` now emits ordered `files,bash,rex` capabilities plus:
   ```json
   {
     "rexClient": {
       "executable": "/absolute/path/to/deck",
       "socket": "/absolute/worker-state/client.sock"
     }
   }
   ```
   For an existing worker, first settle work and stop it. Preserve its machine ID, hub pins, and receipts; add this exact `rexClient` object to its private `worker.json` rather than reinitializing or copying the directory. The socket must be that directory's `client.sock`.
3. Review the new `identity` output. Approve the exact client/socket pair and ordered capabilities alongside the existing machine/peer/binary pins in the hub registry. Keep `client:false`: that separate diagnostic role does not grant general remote hub access. Changes require a controlled hub restart, not hot reload. Start the worker normally with `run`.
4. From the **hub chat**, create an explicitly bound task in either TUI or plain mode:
   ```text
   /task-at {"machineId":"WORKER_32_HEX_MACHINE_ID","cwd":"/remote/project with spaces","title":"Remote task"}
   ```
   Replace the placeholder with the actual 32-hex machine ID. The TUI command line is limited to 256 UTF-8 bytes and does not accept pasted commands; use `--no-tui` for longer JSON targets. Title, host, cwd, and request ID are saved before creation is sent. Creation ACK clears that draft before the separate best-effort Rex open. If the worker/Rex is unavailable or opening is unconfirmed, the task stays saved; inspect and explicitly `/rex open` it from the hub. **Do not repeat task creation to recover a terminal.** `/task TITLE` still uses the hub's saved workspace, not the most recently opened terminal.

Default Rex discovery runs on the assigned worker. Use `deck rex open --task ID --rex /worker/path/to/rex --server unix:///worker/socket` on the hub for explicit overrides. Saved targets bypass discovery. No local fallback, migration, terminal adoption, input replay, or automatic allocation retry occurs.

The client must register its exact hub/task/allocation and native `REX_BLOCK` before participation. The hub independently checks the saved host, cwd, ownership, current allocation, approved client/socket, and block on every relay command and again at mutation admission. Remote task clients cannot list/create/switch tasks, log in, access the hub chat, or allocate replacement terminals; use the hub for opening/reopening. Their status omits global Pi inspection. Detaching does not stop work. Reconnect resumes reads only; lost mutation acknowledgements retain drafts for explicit original-identity recovery.

All three sockets (effects, control, clients) independently verify their actual Tailscale peer and bind one fresh generation. Revocation, replacement, or config drift cannot silently attach an old client to another task. Changing an approved client path requires explicitly closing/reopening affected terminals; retain the old immutable build and settle work first. No live hub or remote machine is upgraded by building this feature.

Validation includes isolated sockets/FIFOs with injected peer verification and a separate [real two-machine run](docs/HISTORY.md#phase-0-two-machine-acceptance) with production Tailscale peer verification. The latter exercised managed startup, central task input/history, same-PID reconnect, lost-ACK draft recovery, native effect faults and explicit same-conversation reopen. It used a private Rex API 10/Unix server; the existing API 9 service was used only for operator access and remains unsupported for Deck allocation. No live provider or desktop GUI acceptance is implied.

## Enable the remote launcher

This is a separate, narrow permission—not an extension of a task client's authority. On a **new disposable or explicitly approved worker**, add `--launcher` alongside `--client /absolute/installed/deck` during `deck-worker init`. For an existing worker, stop/drain it, preserve its identity and receipts, and explicitly add `"launcher": true` to its private configuration. Review/reapprove its current binary digest, client/socket and ordered capabilities on the hub: `files,bash,rex,launcher`, or `files,bash,rex,mcp,launcher`. Restart through the controlled upgrade procedure; neither catalogs nor a client request can grant this permission.

Approval covers independent tasks assigned to this **OS machine**, not an individual human login or a sandbox. It grants no hub chat, child-task, other-host, provider-login, configuration or MCP-grant authority. Task-scoped RPC remains allocation-bound. A full Deck client must be installed at the approved path; the standalone worker still has no Node/Pi dependency or model loop.

From that worker:

```sh
# Explicit worker configuration selects the pinned hub. No cwd/task inference.
deck agent --launch-from /private/worker-state
deck agent --launch-from /private/worker-state --list --after 25

# Exact title/cwd and optional immutable brief. --confirm is required.
deck agent --launch-from /private/worker-state \
  --new '{"title":"Fix tests","cwd":"/absolute/project","problem":"Failing tests","description":""}' \
  --confirm

# Existing assigned independent tasks only.
deck agent --launch-from /private/worker-state --open 11 --confirm
deck agent --launch-from /private/worker-state --inspect 11
```

Listing scans at most 25 conversations; follow the returned `next` cursor even if the filtered page is empty. IDs above are examples, not task selection by labels or paths. The launcher cannot select a Rex executable/endpoint: configure a supported local Rex default on the worker. An existing allocation retains its target. Rex API 8/10 over a worker-local Unix socket remains the supported allocation surface.

Creation follows **save exact private draft → create → validate ACK → clear that draft → separate best-effort Rex open**. Creation starts no generation and grants no MCP profiles. Existing selections remain unchanged; only trusted-local hub controls can grant profiles. An open ACK means admission, not terminal readiness. The assigned worker launches the approved TUI, which must complete pinned hub/task/allocation/block startup before accepting input. Opening does not promise GUI focus or attach the invoking shell.

On an unconfirmed result:

```sh
deck agent --launch-from /private/worker-state --drafts
# Creation only: explicit retry recovers the same task, but does NOT open it.
deck agent --launch-from /private/worker-state --retry CREATION_DRAFT_UUID --confirm
# Inspect/reconcile an uncertain open first. Open drafts cannot be retried.
deck agent --launch-from /private/worker-state --inspect CHAT_ID
deck agent --launch-from /private/worker-state --discard DRAFT_UUID --confirm
```

Drafts live under the normal client-state root in a private `launcher-drafts` namespace keyed by hub and machine. Pending drafts block new launcher mutations until explicitly recovered/discarded. Discarding is local, not rollback; a new explicit open can create another terminal and supersede the old allocation. A failed open never recreates the acknowledged task. Reconnect/list/inspect never replay mutations, and a missing approval, offline worker or unsupported Rex never selects another host. Bare/local `deck agent`, the hub TUI and task inspection retain their existing behavior.

## Limits and trust

- The chat API listens only on loopback and trusts local OS users. Worker listeners authenticate registered Tailscale machines, not individual OS users. Task scopes expose allocation-scoped commands; separately approved launchers expose only list/create/open/inspect. Neither exposes the general HTTP/login/hub command surface.
- File and shell tools can access paths outside the workspace, use ordinary symlinks, and contact external services.
- File tools handle regular UTF-8 files up to 128 KiB. Exact edit requires one match. Bash has a 60-second default timeout, a 300-second maximum, and a 64 KiB output tail.
- Stored chats, receipts, instructions, credentials, drafts, and backups can contain sensitive plaintext. Display sanitization is not secret redaction.
- Activity and output previews are samples, not complete streams or proof of success. Read retained results and inspect the actual workspace.
- There is no general remote hub-client API, interactive child-terminal workflow, general settings editor, job scheduler, web UI, or automatic project-file loader. See the [Roadmap](docs/ROADMAP.md).

No license has been selected for Deck. Third-party notices remain in [`licenses/`](licenses/) and are installed with the package.
