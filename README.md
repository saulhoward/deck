# Deck

A personal agent harness: a Zig hub, CLI and TUI with coordinator-owned TypeScript/Pi conversations and inference, tools executing on trusted workers, and named Rex task chats. Every chat uses the hub; workers do not run independent model runtimes.

**Prototype, local slice in progress.** See the [phased implementation plan](docs/implementation-plan.md) for progress and limits, and the [architecture proposal](docs/architecture.md) for the target. Zig initializes private state, supervises a single Pi writer, and exposes a loopback HTTP command bridge over [private framed IPC](docs/runtime-ipc.md). A plain client supports persistent main/task chats, durable deduplicated admission and [crash-recoverable request drafts](docs/client-drafts.md). Drafts save privately before sending; reconnect and `/retry` explicitly—there is no automatic replay. Writer death or failed Pi store closure stops the hub with a nonzero exit; there is no automatic restart or effect replay. Default `serve` now wires OpenAI with hub-owned ChatGPT OAuth; `--mock` remains an offline demo and `--api-key` is an explicit paid-key opt-in. API-key inference has passed a user-reported smoke test; live ChatGPT OAuth is still unverified. Native UTF-8 `read`/`write`/exact-`edit` and bounded, cancellable `bash` now execute in Zig; Rex, remote workers and TUI remain unimplemented.

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

Use the pinned shell: an unrelated system Zig may have incompatible APIs.

```sh
nix build path:.            # Zig + compiled runtime + production dependencies + private Node
./result/bin/deck --help
nix flake check path:.
```

The installed package works outside the checkout without global Node/npm or startup downloads; see [packaging and its smoke test](docs/packaging.md). The explicit `path:.` form includes newly added prototype files before they are committed; once tracked, ordinary `nix build` works too.

The flake targets arm64/x86_64 macOS and Linux. CI checks macOS and Linux on its available runner architectures. Nix does not install or manage Rex, Tailscale or 1Password.

## Layout

- `src/`, `build.zig`: Zig CLI, private-state initialization, writer locking/supervision and tests.
- `runtime/`: strict ESM TypeScript, version-pinned Pi adapter, IPC frame codec and offline contract tests.
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

The hub binds only `127.0.0.1:52800`. Use `/help`, `/tasks` (then `/tasks more` for another page), `/select CHAT_ID`, `/main`, `/older`, `/task TITLE`, `/status`, `/activity`, `/stop` or `/exit`. Listing and selecting existing chats never creates or stops work. `/older` walks retained history backward in labeled pages while new entries are fetched incrementally. Within a selection, forward catch-up preserves entry order through bursts and transient disconnections; a new selection/client still starts from a bounded recent tail. The client shows changing Pi activity and settled tool results; native shell output is not yet streamed while running. Reopen a task directly with `deck agent --no-tui --task CHAT_ID`. All inference output is from the mock provider. Native file tools are enabled, though the mock does not call them. See [protocol and limitations](docs/runtime-ipc.md).

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
