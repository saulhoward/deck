# Deck

A personal agent harness: a Zig hub, CLI and TUI with coordinator-owned TypeScript/Pi conversations and inference, tools executing on trusted workers, and named Rex task chats. Every chat uses the hub; workers do not run independent model runtimes.

**Prototype, local slice in progress.** See the [phased implementation plan](docs/implementation-plan.md) for progress and limits, and the [architecture proposal](docs/architecture.md) for the target. Zig initializes private state, supervises a single Pi writer, and exposes a loopback HTTP command bridge over [private framed IPC](docs/runtime-ipc.md). A plain client supports persistent main/task chats, durable deduplicated admission and [crash-recoverable request drafts](docs/client-drafts.md). Drafts save privately before sending; reconnect and `/retry` explicitly—there is no automatic replay. [Settings observations](docs/settings.md) have explicit limits; general settings configuration remains deferred, apart from the explicit idle-only instruction import below. [Startup compatibility](docs/recovery-compatibility.md) now refuses changed-code recovery while unfinished work remains; upgrade when idle and retain the original build. Writer death or failed Pi store closure stops the hub with a nonzero exit; there is no automatic restart or effect replay. Default `serve` now wires OpenAI with hub-owned ChatGPT OAuth; `--mock` remains an offline demo and `--api-key` is an explicit paid-key opt-in. The user reports the live API-key smoke suite passed: inference, file write/read/edit, bash, stop, detach/reconnect and durable draft recovery. Live ChatGPT OAuth is still unverified. Native UTF-8 `read`/`write`/exact-`edit` and bounded, cancellable `bash` now execute in Zig; [public local Rex open/reopen](docs/rex-open.md) is now available on a best-effort basis; remote workers and TUI remain unimplemented.

## Development

```sh
nix develop                 # Zig 0.15.2, Node 24, npm, Git
npm ci --ignore-scripts
zig build
zig build test
zig build run -- --help
npm run check
npm test                    # runtime-only offline tests
DECK_TEST_BINARY="$PWD/zig-out/bin/deck" npm test  # also exercise the Zig supervisor
zig fmt --check build.zig src
```

Use the pinned shell: an unrelated system Zig may have incompatible APIs. `npm test` bounds concurrency to four test files so native runtime startup/fingerprint checks do not compete with a large batch of crash fixtures.

```sh
nix build path:.            # Zig + compiled runtime + production dependencies + private Node
./result/bin/deck --help
nix flake check path:.
```

The installed package works outside the checkout without global Node/npm or startup downloads; see [packaging and its smoke test](docs/packaging.md). The explicit `path:.` form includes newly added prototype files before they are committed; once tracked, ordinary `nix build` works too.

The flake targets arm64/x86_64 macOS and Linux. CI checks macOS and Linux on its available runner architectures. Nix does not install or manage Rex, Tailscale or 1Password.

## Layout

- `src/`, `build.zig`: Zig CLI, private-state initialization, writer locking/supervision and tests.
- `runtime/`: strict ESM TypeScript, version-pinned Pi adapter, IPC frame codec, schema-generated request/response envelope validation with exact reply correlation, and offline contract tests.
- `docs/implementation-plan.md`: phased rollout, completed checks and implementation limitations.
- `docs/architecture.md`: proposed system design (not an implementation claim).
- `flake.nix`, `flake.lock`: reproducible package and development environment.
- `package.json`, `package-lock.json`: locked runtime/development dependencies.

## Try the mock prototype

From the repository root, after `zig build` and `npm run build`:

```sh
./zig-out/bin/deck init --directory /tmp/deck-demo
./zig-out/bin/deck serve --mock --directory /tmp/deck-demo
# In another terminal:
./zig-out/bin/deck agent --no-tui
```

The hub binds only `127.0.0.1:52800`. Use `/help`, `/tasks` (then `/tasks more` for another page), `/select CHAT_ID`, `/main`, `/older`, `/task TITLE`, `/status`, `/activity`, `/stop` or `/exit`. Listing and selecting existing chats never creates or stops work. `/older` walks retained history backward in labeled pages while new entries are fetched incrementally. Within a selection, forward catch-up preserves entry order through bursts and transient disconnections; a new selection/client still starts from a bounded recent tail. The client shows changing Pi activity, bounded [provisional answer and native-bash output snapshots](docs/live-progress.md), and settled tool results. Retained history/results remain authoritative; snapshots are sampled tails, not lossless streams. Reopen a task directly with `deck agent --no-tui --task CHAT_ID`. All inference output is from the mock provider. Native file tools are enabled, though the mock does not call them. History pages and rendered payloads have [schema-backed validation](docs/history-contracts.md) before any output/cursor advance, preserving existing numeric entry IDs and string cursors. [Activity, progress and instruction views](docs/live-view-contracts.md), including history attachments, now use generated closed contracts too; invalid samples preserve cursors, display state and saved drafts. See [protocol and limitations](docs/runtime-ipc.md).

Models have read-only `task_list`, `task_history` and `task_activity` tools, plus separate `task_create`/`task_message` tools for ownerless tasks and durable admission. Search is a paginated title-substring filter, not a full-store index. Messaging returns an admission receipt, not an answer; stopping the caller does not stop independent target work. These ownerless operations are distinct from the new foreground `subagent` tool, which waits for a Pi-owned child's answer and propagates ordinary scoped cancellation. Children inherit the saved host/agent selections without recursive delegation or task-control tools. See [inspection](docs/task-tools.md), [task control](docs/task-control.md), and [foreground subagents and limits](docs/subagents.md).

Use `/instructions load` to explicitly import saved-worker `AGENTS.md` into Pi's stored instructions while the selected chat is idle. It **replaces**, rather than appends, explicit instruction text and starts no inference. `/instructions` or `/instructions TASK_ID` reads source/import status without loading. The client saves its request/binding before send; an admission ACK is not successful application. See [instruction import and recovery](docs/instruction-import.md). `AGENTS.md` is not automatically loaded on startup or input admission.

## Rex allocation foundation (internal only)

An opt-in [isolated Rex CLI test](docs/rex-contract.md) exercises real Deck clients, stable IDs, hub reconnect and continued central Pi execution after Rex destruction. The new [internal Pi/native allocator](docs/rex-allocation.md) persists launch intent, retains a native effect receipt and atomically binds full Rex IDs without inference. It refuses duplicate/uncertain retries and launches clients pinned to the intended hub. [Allocation-bound startup registration](docs/rex-startup.md) now joins the saved intent, native `REX_BLOCK` and retained binding, including early/lost-ACK recovery. It is a **historical observation, not current health**. New [internal read-only inspection](docs/rex-inspection.md) separately samples the saved worker/full Rex IDs without creating objects, Pi work or read receipts; running process presence is not responsive-client readiness. [Explicit receipt-based reconciliation](docs/rex-reconciliation.md) can now repair an unbound creation binding only from hash-matched native success, preserving the original uncertain/aborted result and never calling Rex. Missing evidence stays unresolved. [Public local allocation/open/reopen](docs/rex-open.md) now exposes this adapter through `deck rex open|reopen|status|inspect --task CHAT_ID` and plain `/rex` commands. It follows the explicitly [best-effort local scope](docs/rex-replacement.md): native race prevention and lost-reply recovery are not guarantees. Concurrent opens or explicit new attempts after unknown outcomes may leave duplicate terminals for manual cleanup; model-input deduplication and file/bash replay rules are unchanged. The internal native adapter explicitly supports tested Rex APIs 8 and 10; unknown revisions still refuse. API 10 supplies no proven conditional replacement guard, so no atomicity/idempotency guarantee is claimed. The legacy internal allocator remains single-attempt; explicit public open can start another attempt without replaying the old accepted operation. First open requires an explicit local Rex target; later opens reuse it. Running clients are reused, exited/missing clients get a new window, and missing sessions can be recreated. No GUI focus/attachment or automatic cleanup is added. Normal tests never connect to your Rex server.

## Offline backup and restore

After stopping `serve` and awaiting the actual writer-lock release:

```sh
deck backup --directory /path/to/state --output /path/to/new-backup
deck restore --from /path/to/new-backup --directory /path/to/new-state
```

These commands never resume work or overwrite existing destinations. Backups combine a standalone SQLite snapshot with config/native-effect receipts; stored credentials are excluded unless `--include-credentials` is explicit. Preserve the original build for unfinished work. Restore preserves identities/bindings, is not workspace relocation, and cannot undo later external effects: reconcile rollback before explicitly serving a restored image. Arrange an authenticated restart path before stopping a hub whose key exists only in process memory. See [backup format, limits and recovery procedure](docs/backup-restore.md).

## OpenAI conversations (live ChatGPT flow not yet verified)

Use a separate state directory from the mock demo:

```sh
./zig-out/bin/deck init
./zig-out/bin/deck serve
# Another terminal:
./zig-out/bin/deck login
./zig-out/bin/deck agent --no-tui
```

Credentials stay on the hub. Default mode never falls back to an ambient paid API key. See [provider setup, model persistence and security limits](docs/providers.md) before using real account access. See [local file tools and a scratch-workspace smoke test](docs/local-tools.md) before enabling model-driven edits. Tools run with your OS user's capabilities; `--workspace` is a cwd, not a sandbox. See [shell ownership, cancellation and output limits](docs/shell-tools.md) before running commands.

Optional local profile install (no service installation or sign-in during the build):

```sh
nix profile add path:.
deck init
deck serve
# In another terminal:
deck agent
```

No license has been selected yet.
