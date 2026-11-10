# Local file tools (prototype)

The initialized hub now includes a local Zig file worker. Pi still owns inference, transcripts and tool-task intent; TS never uses its own filesystem as a tool fallback. Three deliberately narrow custom tools replace the built-in file tools:

| Tool | Contract |
| --- | --- |
| `read {path}` | Read a regular UTF-8 text file, at most 128 KiB. No image/binary or offset/limit support yet. |
| `write {path,content}` | Replace/create a regular UTF-8 file, at most 128 KiB. Parent directories must exist. |
| `edit {path,oldText,newText}` | Replace exactly one literal match, rejecting zero/multiple matches. No fuzzy matching. Result at most 128 KiB. |

The adapter is intentionally small rather than pretending to implement Pi's entire execution-environment interface. [Native bash](shell-tools.md) now runs alongside file tools, with bounded output and independent cancellation. Remote effects, image reads, streaming file bodies and large-file paging are deferred.

## Try it safely

Rebuild, stop the old hub, then use a scratch workspace and a separate state directory:

```sh
nix develop
zig build
npm run build
mkdir -p /tmp/deck-work
./zig-out/bin/deck init --directory "$HOME/.local/state/deck-files-test"
# Export OPENAI_API_KEY securely, as before, then:
./zig-out/bin/deck serve --api-key --model gpt-4o-mini \
  --directory "$HOME/.local/state/deck-files-test" --workspace /tmp/deck-work
# Another terminal, from the Deck repository:
./zig-out/bin/deck agent --no-tui
```

Ask: “Write hello.txt containing hello, read it back, then change hello to goodbye using edit.” Inspect `/tmp/deck-work/hello.txt` yourself. The user reports this live API-key write/read/edit workflow passed, including independent verification through tool results. No live model calls are made by automated tests; repeat the manual smoke test when validating another provider or environment.

`--workspace` sets main's workspace only on first conversation creation. Existing conversations keep their saved host/cwd; restarting in another directory or passing a new default never moves their effects. `/task TITLE` inherits the selected chat's binding. `/status` shows the saved binding and file-tool capability. To change the initial workspace during testing, use a new state root rather than editing history/config by hand.

**Trust boundary:** tools run as your OS user. Relative paths resolve from the saved cwd, but absolute paths, `..` and ordinary symlinks are allowed. This is not a workspace sandbox. Do not ask the model to operate on sensitive files. Non-regular file targets are rejected; opens are nonblocking to avoid accidentally hanging on FIFOs/devices. Reads must be valid UTF-8. Parent directory/symlink traversal remains ordinary OS behavior.

## Transport and ownership

The [native schema/semantic boundary](client-foundations.md) now validates closed operation-specific requests before acceptance and bounded correlated results/progress before application. Invalid replies fence pending issued work as uncertain; explicit close refuses subsequent calls. Malformed new requests create no receipt or effect. Existing raw request hashes and retained receipt bytes are not normalized or migrated. There is no production environment RPC: Pi's hub-local environment fallback stays disabled.

The supervisor creates a dedicated inherited request pipe and result pipe alongside the existing command pipes. The child dispatches bounded file requests independently of HTTP/command admission; a native operation never uses stdout or requires a client to keep polling. A Zig worker thread serializes local file operations, which also avoids interleaving Deck's own file-tool edits. Bash runs concurrently and can race with these edits, just like external processes. At most 16 native requests may be pending in TS; frames are bounded to 1 MiB. There is no new listener or task-local socket.

Every tool resolves its saved ChatDoc binding. The worker independently verifies the machine ID against the initialized local machine before any file access. A task assigned elsewhere returns offline; it never runs against the local filesystem as a fallback. Connection loss fails outstanding issued operations as uncertain and rejects new requests as offline. Deck does not reconnect/resend effects automatically.

Pi commits the tool intent before invoking the adapter. The stable Pi tool-task ID is the native operation ID. The tools use Pi's default non-replay-safe policy: interrupted tools are not automatically reexecuted after runtime restart. They do not acquire Rex terminal persistence.

## Receipts and uncertainty

Worker bookkeeping lives under `state/worker/operations/<operation-id>.json`, inside the private state root. It is intentionally a small file journal rather than a second conversation/task database. Do not delete/reset the Pi database while reusing this journal: operation IDs belong to that canonical store.

Before workspace access, Zig syncs an acceptance receipt containing the request hash, then atomically renames it into place. After execution it retains the result in the same manner. A duplicate matching ID returns the retained result without repeating the operation; conflicting arguments reject. An acceptance without a final result returns **effect_uncertain**, not “not executed.” Receipt corruption/storage failure closes the worker channel, causing issued requests to fail uncertain rather than execute without bookkeeping. Receipts include retained tool output and must be protected like transcripts; retention/cleanup is not implemented yet.

File content changes and receipts cannot form a single atomic transaction. Writes/edits can be partial if storage fails, and a process can die after mutation but before result persistence. Inspect the actual file before deciding to retry with a new tool call. These receipts address process-crash ambiguity, not an exactly-once or power-loss durability guarantee; directory syncing, backup/reconciliation UI and remote receipt recovery remain future work. External processes editing the same files can still race with Deck; there is no worktree snapshot manager.

## Stop behavior

Cancellation is checked before issuing a file operation. Once issued, these short synchronous filesystem operations are drained, not interrupted or undone. `/stop` now returns a **stop-request receipt**, not a claim that the conversation is already idle. Pi continues scoped abort/queue withdrawal independently; `/status` exposes actual activity while effects drain. Detach still never calls abort. A failed stop is logged generically; stop requests are not durable client admissions and can be lost on hub failure.

Bash now has separate execution threads, process-group ownership, bounded output and a dedicated cancellation pipe; see [shell tools](shell-tools.md). File operations remain drain-only.

## Tests

Zig tests cover read/write/exact edit, non-regular/binary/oversize rejection, host affinity, retained receipts, conflicting IDs and accepted-but-uncertain operations. Runtime tests exercise the Pi native-tool adapter with saved bindings and stable IDs. An inherited-pipe integration test launches the actual Zig supervisor and a small TS effect client, proving native file mutations/readback and offline-host rejection without credentials or model calls.
