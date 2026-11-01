# Deck

A personal agent harness: a Zig hub, CLI and TUI with coordinator-owned TypeScript/Pi conversations and inference, tools executing on trusted workers, and named Rex task chats. Every chat uses the hub; workers do not run independent model runtimes.

**Design/bootstrap stage.** Read [the architecture proposal](docs/architecture.md) for behavior, boundaries, critiques and review decisions. The current CLI only supports help/version; `init`, `serve`, `agent`, networking and the TUI are not implemented.

## Development

```sh
nix develop                 # Zig 0.15.2, Node 24, npm, Git
npm ci
zig build
zig build test
zig build run -- --help
npm run check
npm test                    # offline Pi SQLite close/reopen integration
zig fmt --check build.zig src
```

Use the pinned shell: an unrelated system Zig may have incompatible APIs.

```sh
nix build                   # bootstrap Zig CLI, no TS runtime yet
./result/bin/deck --help
nix flake check
```

The flake targets arm64/x86_64 macOS and Linux. CI checks macOS and Linux on its available runner architectures. Nix does not install or manage Rex, Tailscale or 1Password.

## Layout

- `src/`, `build.zig`: Zig executable and tests.
- `runtime/`: strict ESM TypeScript, exact Pi dependencies, offline integration test.
- `docs/architecture.md`: proposed system design (not an implementation claim).
- `flake.nix`, `flake.lock`: reproducible package and development environment.
- `package.json`, `package-lock.json`: locked runtime/development dependencies.

Future deployment target (not working yet):

```sh
nix profile add github:saulhoward/deck
deck init
deck serve
# In another terminal:
deck agent
```

No license has been selected yet.
