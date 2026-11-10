# Zig toolchain

Deck pins **Zig 0.17.1**, the latest stable version in the [official release index](https://ziglang.org/download/index.json) when this migration was performed (released November 2, 2026). The index's `master` entry is a 0.18 development build, not a stable release.

`flake.nix` selects `pkgs.zig_0_17` for both the package and development shell. `flake.lock` fixes Nixpkgs at `4fe25e12eb9f4c744966dd3de5a05246cf098601`, supplying exactly 0.17.1. CI uses the same flake. Node remains on the explicit Node 24 package, and Pi/npm versions are unchanged.

```sh
nix develop -c zig version             # 0.17.1
nix develop -c zig build
nix develop -c zig build test
nix develop -c zig build run -- --help
nix develop -c npm run check
DECK_TEST_BINARY="$PWD/zig-out/bin/deck" nix develop -c npm test
nix flake check path:.
nix build path:.
```

Use `path:.` for Nix package builds while new source files are untracked. Do not rely on the system compiler or switch to a development compiler implicitly.

## Migration from 0.15.2

- Build arguments use `Run.addPassthruArgs()` instead of `Build.args`. The executable and tests link libc on the supported Unix targets.
- `std.process.Init` supplies explicit I/O, arguments and the immutable process environment. `src/native.zig` carries I/O/environment into the existing native worker threads; it does not introduce a task scheduler or another execution owner.
- Files, directories, networking, clocks and thread synchronization use `std.Io`. Small POSIX helpers retain descriptor flags, polling-compatible pipes and nonblocking child reaping. Native process capacity, timeout/cancellation budgets and bounded output behavior are unchanged.
- `std.process.spawn` explicitly inherits the Pi writer-lock descriptor and its three private IPC ends. Parent descriptors remain close-on-exec. Shell/Rex descendants never receive the writer lock through this mechanism. Manually reaped children have their IDs cleared and streams cleaned without a second wait/kill.
- Path APIs now return sentinel-terminated allocations. Runtime path helpers retain that type through allocation and free, covered with the testing allocator.
- The generator uses `@FieldType` for tagged-union payload reflection; generated Zig codecs were regenerated. JSON object-map mutations now pass their allocator explicitly. No schema, wire format, request hash or retained receipt changes are part of this compiler migration.

The orphan-writer tests now own Pi's stdin independently of the Node `ChildProcess` object. Node destroys its own `.stdin` when the Zig supervisor exits; using it for both actions raced the lock assertion against legitimate EOF shutdown. The tests now separate SIGKILL from EOF and verify that the surviving Pi writer can still answer status and prevents a second writer. Deadlines are unchanged.

## Validation and deployment

Completed validation on arm64 macOS with scratch state and mock providers:

- Zig formatting/build/tests: **18/18** native tests passed, including sentinel allocation, descriptor flags and thread drainage; build-run argument forwarding also passed.
- Generated-contract/TypeScript checks and full suite: **356 tests, 354 passed, two opt-in skipped**.
- `nix flake check path:.` and `nix build path:.`: passed; installed-package smoke **1/1**.
- Separate isolated installed Rex API 10 suite: **11/11**.
- Cross-builds for x86_64 macOS and arm64/x86_64 Linux: passed. These check compilation only, not runtime support on those hosts.

No live hub, credentials or user Rex sessions were changed. No deadlines were widened.

Changing compiler/native code changes the implementation fingerprint. Upgrade a hub only when idle, retaining its original immutable build while unfinished work remains; see [recovery compatibility](recovery-compatibility.md). Building this migration does not restart a live hub or migrate retained state.

No TUI library or TUI implementation is added by the toolchain migration. Evaluate maintained Zig libraries against this compiler before selecting the frontend dependency.
