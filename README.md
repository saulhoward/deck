# Deck

Deck is a personal coding-agent tool. It has a Zig hub, command-line client, and terminal user interface (TUI). One TypeScript runtime uses Pi to store conversations and run agents. Zig runs local file and shell tools. Rex can keep task terminals open.

**Deck is a prototype.** Local hub/Rex clients and opt-in registered files/bash workers are implemented. Remote Rex/TUI access is not yet available. Tools run with your user permissions; the workspace is not a sandbox.

## Documentation

- [Developer guide](docs/DEVELOPER.md): architecture, contracts, storage, builds, and tests.
- [Roadmap](docs/ROADMAP.md): remaining work and acceptance checks.
- [History](docs/HISTORY.md): previous changes, design decisions, and test evidence.

These documents distinguish current behavior from the target design. A local build does not publish a release or update a running hub.

## Target workflow

Every chat uses the hub. Interactive tasks will have named Rex sessions on their execution machines. Their subagents will have named TUI terminals inside the same session. Closing and reopening a session will retain the task's hub conversation.

Scheduled jobs and their children will run in the hub runtime through registered host connections, without Rex terminals. Each job will reuse its task and Pi conversation. Each run will have its own admission identity and captured file settings.

Remote interactive clients, jobs, and subagent terminals still need implementation. Local task navigation, Rex-managed TUI launches, and worker-only native effects are available. See the [target architecture](docs/DEVELOPER.md#target-interactive-and-scheduled-architecture) and [next implementation steps](docs/ROADMAP.md#next-implementation-sequence). The instructions below describe what works now.

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
./result/bin/deck agent --port 52801
```

Use another unused port if 52801 is occupied. The mock provider makes no external model calls. It returns mock answers and does not exercise model-driven tools.

`serve` stays in the foreground. It does not install a service. The default endpoint is `127.0.0.1:52800`; clients must use the hub's port. `--directory` selects stored state. `--workspace` sets the initial main workspace. Saved chats keep their original binding when the hub restarts.

## Use the TUI

Interactive terminals use the TUI by default. The hub has teal status bars; Rex task clients use slate-blue bars and show `task / Rex locked`. Inspect a saved task read-only with:

```sh
deck agent --task CHAT_ID
```

In the hub, `/tasks` opens the task picker. Move with `j/k` or arrows and press Enter to inspect. Use `n` for the next page, `g` for the first page, and Esc to close. `/hub` returns to the hub chat. Inspection cannot edit, send, retry/discard task drafts, stop, or change task settings. Saved task requests remain untouched. Use `/rex open` to participate in its Rex client.

From the hub chat, `/task TITLE` creates a task on the hub's saved workspace binding and then requests its Rex terminal. It does not submit input or switch the hub view. Creation and terminal allocation are separate: if Rex opening fails or is unconfirmed, the task remains saved and read-only here. Inspect it and explicitly open/reopen; never repeat creation to recover a terminal. Rex capability is required, with no local participation fallback.

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
deck agent --no-tui
deck agent --no-tui --task CHAT_ID
```

| Command | Purpose |
| --- | --- |
| `/help` | List commands |
| `/tasks`, `/tasks more` | Hub only: list saved chats |
| `/select CHAT_ID`, `/hub` | Hub only: inspect a task / return to hub |
| `/task TITLE` | Hub chat only: create a task and request its Rex terminal |
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

`task_create` creates an independent task. `task_message` sends input and returns an admission receipt, not an answer. Stopping the sender does not stop the target task.

`subagent` creates a Pi-owned foreground child and waits for its answer. It inherits the parent's settings and binding, but not its transcript. Stopping the parent cancels its ordinary owned work. You can inspect or stop child chats, but you cannot send them direct input or change their model independently.

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

First open finds `rex` on the hub/native worker's PATH and discovers its running local Unix server. It does not use the client's PATH or autostart Rex. Optional overrides are `--rex`, `--server`, `--host-id`, and `--instance-id`. Later opens reuse the saved target; they do not migrate it. Use `--port N` for another Deck hub.

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

This enables **native effects only**, not remote task participation or remote Rex. Pi, models, history, and credentials stay at the hub. The worker uses its saved machine ID/cwd; disconnection never redirects its work locally. An actual two-machine Deck acceptance test is still pending; isolated TCP tests use injected verifier identities, not a live tailnet.

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

Existing saved bindings can use the worker through the native adapter. There is not yet a user-facing remote task creation/participation workflow: `/task` still requires a working Rex path, and remote Rex is deliberately refused. Do not start `deck serve` on the worker to join the hub—that creates another hub.

`deck remote-check` remains a read-only peer/registration diagnostic with `connection: "not_checked"`; it does not enroll or connect anything. See [transport details and limits](docs/DEVELOPER.md#registered-filesbash-workers).

## Limits and trust

- The chat API listens only on loopback and trusts local OS users. Optional worker-only listeners authenticate registered Tailscale machines, not individual OS users; they do not expose chat commands.
- File and shell tools can access paths outside the workspace, use ordinary symlinks, and contact external services.
- File tools handle regular UTF-8 files up to 128 KiB. Exact edit requires one match. Bash has a 60-second default timeout, a 300-second maximum, and a 64 KiB output tail.
- Stored chats, receipts, instructions, credentials, drafts, and backups can contain sensitive plaintext. Display sanitization is not secret redaction.
- Activity and output previews are samples, not complete streams or proof of success. Read retained results and inspect the actual workspace.
- There is no remote Rex/TUI access, general settings editor, job scheduler, web UI, or automatic project-file loader. See the [Roadmap](docs/ROADMAP.md).

No license has been selected for Deck. Third-party notices remain in [`licenses/`](licenses/) and are installed with the package.
