# Nix package

The Nix package now includes the working **local prototype**, not just the Zig bootstrap CLI:

- Zig executable, built with the pinned stable Zig 0.17.1 and linked with the target platform's libc;
- compiled ESM TypeScript under `libexec/deck/runtime/dist`;
- the exact production npm closure from `package-lock.json`;
- a wrapper selecting private Node 24 and the packaged runtime;
- Bash on the command PATH for native shell execution.

There is no bundling/minification layer. Complete npm packages are retained so lazy SDK imports and provider JSON/WASM assets remain where upstream expects them. Development dependencies and compiled Deck test files are removed from the installed payload. Git, build caches, local node_modules, credentials and arbitrary repository-root files are not part of the source allowlist; do not put secrets in source directories or package manifests either.

## Build and run

```sh
# From this checkout; path:. includes newly added/untracked prototype source files.
nix build path:.
./result/bin/deck --help
```

Once all source files are tracked, ordinary `nix build` works too. Nix Git flake sources exclude untracked files, so use the explicit path form while developing this uncommitted prototype.

No `nix develop`, global Node/npm, npm install, checkout cwd or runtime download is needed to launch the installed package. For example:

```sh
# Keep separate state for a disposable mock demo:
./result/bin/deck init --directory "$HOME/.local/state/deck-packaged-demo"
./result/bin/deck serve --mock --directory "$HOME/.local/state/deck-packaged-demo"
# Another terminal:
./result/bin/deck agent --no-tui
```

You can run the package by its absolute path from a different working directory. The default **workspace** is still the launch cwd, not the package's store path. Use `--workspace /your/project` when creating main for the first time; resumed conversations keep their saved binding. The foreground hub remains loopback-only and starts no OS service.

For real inference, omit `--mock` and use `deck login` for ChatGPT, or explicitly choose `--api-key` with a securely supplied OPENAI_API_KEY as described in [providers](providers.md). Use a separate state directory from mock demos. No sign-in or real inference occurs during builds.

Optional local profile installation:

```sh
nix profile add path:.
deck --help
```

Installing from the GitHub flake requires these sources to have been committed/published there; a local successful build does not publish a release. Rex, Tailscale and 1Password remain externally managed. Native commands have your user capabilities and depend on other host tools as needed; shipping Bash is not a sandbox or a complete toolchain image.

## Validation

`nix build path:.` first verifies checked-in [schema-derived contracts](protocol-contracts.md) against local deterministic generation, then runs Zig tests, TypeScript checks and the runtime/supervisor/native-effect test suite, including writer-death/Harness-failure fault tests and native pipe shutdown checks. The source allowlist includes `contracts/` and `scripts/` for build/test-time generation checks; installed validators are inlined and require neither directory at runtime. An additional **post-install check** runs with a temporary HOME/cwd, no Node on PATH and deliberately wrong incoming runtime-path environment variables. It verifies the wrapper selects the installed runtime/Node, loads a lazy real-provider SDK module without network requests, exercises native file/bash effects, and saves/acknowledges a private client draft while admitting/rendering mock chat through the installed hub/client, switches task chats, and browses more than 100 seeded canonical entries with `/older`. Before serving, the installed offline backup/restore commands copy the seeded store and the smoke then uses the restored state, exercising the administrative runtime with the same private Node. The seeded transcript includes a paired tool exchange for result-rendering checks, and `/activity` checks the installed API/client projection; forward catch-up is also checked from a saved entry-ID checkpoint. The installed adapter also checks that all three read-only task-inspection tools, both task-control tools and foreground `subagent` are offered. The installed status check also verifies the startup implementation digest; history's optional provisional-progress field and the standalone progress API are checked without claiming a visible partial from the fast mock response. [Recovery compatibility](recovery-compatibility.md) requires retaining the old immutable build while unfinished work remains. These fixtures do not perform real inference.

```sh
nix flake check path:.
# Re-run only the installed-package smoke test after a normal development TS build:
DECK_PACKAGE_BINARY="$PWD/result/bin/deck" node --test runtime/dist/package.test.js
```

The installed check is skipped by ordinary `npm test` unless DECK_PACKAGE_BINARY is set. All automated inference is faux; the package smoke test never uses credentials or calls a provider. macOS builds allow local networking solely for loopback test listeners. This package was built/tested locally on arm64 macOS; the existing CI matrix also builds/checks its available macOS/Linux runner architectures. Other listed target architectures remain unverified until tested.

The [Zig 0.17.1 migration](zig-toolchain.md) updates both package and development-shell compiler selections. Cross-compilation is a build check only, not evidence that another platform's process supervision or terminal behavior has been exercised.

## Runtime paths and updates

The wrapper sets internal DECK_RUNTIME_ROOT and DECK_NODE paths to immutable store locations. Checkout binaries fall back to `runtime/dist` in the current directory and `node` on PATH. `serve --runtime /path/to/main.js` remains an explicit development/test override; client/login scripts continue to come from the selected runtime root. These are deployment paths, not persisted conversation settings or credential locations.

The npm fetch closure has a fixed npmDepsHash in `flake.nix`. When intentionally changing the lockfile, update that hash (a temporary `lib.fakeHash` build reports the expected hash), then rerun all recovery/compatibility tests. Do not bypass the hash or allow runtime dependency downloads. Node/TS/npm package changes remain versioned independently of stored conversation identities.
