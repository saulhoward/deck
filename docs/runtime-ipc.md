# Private runtime IPC v1

Private transport between Zig and its single TS writer. `deck serve --stdio --mock` inherits stdin/stdout as a testable bridge; no TCP listener is opened in stdio mode. `deck serve --mock` instead connects private child pipes to a Zig loopback HTTP bridge (see below). Checkout builds need `npm run build` and Node 24 on PATH, defaulting to `runtime/dist/main.js` relative to the launch directory. The [Nix package](packaging.md) supplies private Node and absolute runtime paths and runs from any cwd. `--runtime /absolute/path` remains a development override for the child entry point.

## State and writer ownership

`deck init [--directory PATH]` creates a version-1 config containing a persistent random machine ID. Repeating init validates but never replaces it. Default state root is macOS Application Support/deck or Linux XDG_STATE_HOME/deck (otherwise ~/.local/state/deck). For now config and state share this private root; separate XDG config and joined roles are deferred. `--directory` selects a dedicated state directory, **not a workspace**. The directory is made private (0700), config and lock files are 0600. Serve requires prior initialization. Config is replaced atomically on first creation; unsupported versions are rejected rather than rewritten.

Zig acquires a nonblocking exclusive `writer.lock` before spawning Node and retains it until the child exits. The lock descriptor is inherited across exec, and Node keeps it open until process exit. Killing the supervisor therefore does not release the writer lock while its child remains alive. Stale lock files are harmless: the OS releases locks, not filenames. Never delete a lock file to force a second writer. This implementation targets macOS/Linux only.

With `--mock`, the runtime registers no real providers and every model result clearly says it is mock output. Default `serve` now registers OpenAI with ChatGPT OAuth; explicit `--api-key` enables paid-key mode. See [providers and login](providers.md) for setup and unverified live-provider behavior. All modes now include a Zig native-file worker on dedicated inherited pipes; see [local tools](local-tools.md) for capability and uncertainty limits. [Bash](shell-tools.md) uses a third, dedicated inherited cancellation pipe and bounded execution threads. No startup downloads occur.

## Framing and envelopes

Each frame is a four-byte unsigned big-endian byte length followed by UTF-8 JSON. Frame bodies must be objects and are limited to 1 MiB in either direction. Zero-length, invalid UTF-8/JSON, truncated frames and incompatible envelopes terminate the connection. Stdout is protocol-only; diagnostics go to stderr.

Request:

```json
{"version":1,"id":"transport-request-1","command":"status","args":{}}
```

Success:

```json
{"version":1,"id":"transport-request-1","ok":true,"result":{"mainChatId":"1","activity":{},"tools":"native-files + bash"}}
```

Failure:

```json
{"version":1,"id":"transport-request-1","ok":false,"error":{"code":"invalid","message":"Unknown command"}}
```

`id` is a nonempty transport correlation string (at most 200 characters), not a durable request identity. At most 16 commands are active; additional commands receive `busy`. Output writes respect stream backpressure and remain within that active-command bound. Responses may be out of request order. Oversized results return `too_large`; history supports smaller pages, though a single oversized entry still cannot fit this transport. EOF closes the runtime/store; it does not invoke conversation abort. Stopping the runtime leaves interrupted Pi work recoverable on reopening.

| Command | Arguments | Result |
| --- | --- | --- |
| `status` | optional `chatId` | Persistent Pi-owned `hubId`, main/selected chat ID, saved binding/model, global Pi inspection and file-tool capability |
| `activity` | optional `chatId` (default main) | Bounded selected-chat presentation from Pi live/inbox documents |
| `list_chats` | optional integer `limit` (1–100, default 50), `after` conversation ID | `{items:[{chatId,kind,title,machineId,cwd}],next?}` in ascending conversation-ID order |
| `create_task` | `requestId`, `title`, `machineId`, absolute `cwd` | `chatId` |
| `admit` | `chatId`, `requestId`, `text`, `mode` (`steer` or `followUp`) | Durable `submissionId` |
| `history` | `chatId`, optional integer `limit` (1–100, default 100), `before` or `after` entry ID, boolean `includeActivity` | `{items,next?}`; newest first by default/`before`, oldest first with `after`; `next` continues the chosen direction |
| `stop` | `chatId` | `{requested:true}`; Pi abort/draining continues independently |

`list_chats` scans Pi's canonical conversation records and reads existing Deck metadata, including main and tasks assigned to offline hosts. It creates no documents, conversations or inference. `next` is the last **scanned** ID; pass it as `after` for the next page. Pages can be empty while still returning `next` if scanned Pi conversations have no Deck metadata. The limit bounds scanned records, not matching items or encoded bytes; the existing frame-size error still applies. Pages are not a frozen snapshot: newly created higher IDs may appear on subsequent pages. This is client discovery, not model-facing task search/orchestration, an activity/lifecycle catalog, or Rex integration.

`history` delegates to Pi's fork-aware canonical entry scan, including retained history before resets/compaction. Both `before` and `after` bounds are exclusive; specifying both is invalid. Keep `chatId` unchanged and pass the returned `next` as `before` to walk backward, or as `after` to walk forward. Omit both to read the newest page. `after:"0"` means from the beginning, which also lets an empty-chat client begin incremental observation without racing the first append. Positive bounds are safe integer entry-ID strings. Entry IDs need not be consecutive, and parent entries inherited by forks obey Pi's fork boundary. New appends do not move an existing backward cursor. No transcript mirror or server-side browsing session is created. `next` is now a Deck entry-ID string rather than the previously exposed incidental Pi cursor object; prototype clients consuming that field need updating. Items retain Pi's numeric entry IDs and existing entry representation. A smaller `limit` can repair a `too_large` response without advancing the requested cursor, unless a single entry itself exceeds 1 MiB.

Conversation/submission IDs are strings at this boundary even though Pi 1.4.0 uses internal numeric IDs. Admission ACKs acknowledge durable Pi submission only, not generation completion. Retry `admit` using the same durable `requestId`; mismatched text/mode returns `conflict`. `create_task` also requires a durable request ID: its task/conversation and receipt commit together in Pi, and conflicting retries reject. `stop` uses Pi abort semantics, including withdrawing queued input; it does not stop other ownerless task chats. There is no additional request-cancellation protocol yet. Settings are intentionally not exposed while captured-settings semantics remain incomplete.

## Loopback HTTP and plain client

```sh
# From the repository, after building Zig and TypeScript (mock demo state):
./zig-out/bin/deck init --directory /tmp/deck-demo
./zig-out/bin/deck serve --mock --directory /tmp/deck-demo
# In another terminal:
./zig-out/bin/deck agent --no-tui
./zig-out/bin/deck agent --no-tui --message 'Hello'  # ACK and detach, not wait for an answer
./zig-out/bin/deck agent --no-tui --task 2           # select an existing conversation
```

HTTP mode binds **only** `127.0.0.1:52800`; `--port N` overrides the port on both serve and agent. `POST /v1/command` accepts the same v1 JSON command envelope and returns a JSON response envelope. Application errors use `ok:false`; HTTP syntax/security errors use 4xx. All requests must have the exact `Host: 127.0.0.1:PORT`. All Origin-bearing requests are rejected. No CORS, browser support, remote bind or authentication claim is made. As in the architecture, loopback trusts local OS users. Request heads are bounded to 8 KiB, bodies to 1 MiB, with three-second socket read/write timeouts.

This intentionally small bridge handles HTTP/IPC roundtrips serially, but inference continues independently in TS and admission never waits for generation. Native file work uses separate pipes and a Zig thread, not this roundtrip loop. Stop returns promptly as a non-durable stop-request receipt; Pi continues scoped abort/draining while other commands can proceed. It does not claim effects have stopped or been undone. Live SSE is not yet implemented. Writer failures are now monitored without requiring a client request (below).

Plain mode uses line input, loads an initial tail of up to 100 canonical entries, then fetches forward from its last observed entry ID. Only cursor/summary state is retained, not a growing set of displayed IDs. It emits no ANSI and strips terminal control sequences from displayed content. It is not a raw-mode editor or complete scrolling history implementation. `/status`, `/activity`, `/stop`, `/older`, `/tasks`, `/tasks more`, `/select CHAT_ID`, `/main`, `/task TITLE`, `/retry`, `/discard`, `/help`, `/exit` are supported. `/tasks` lists the first 25 scanned records (including main); `/tasks more` advances without changing the selected chat. `/select` validates an existing chat before switching; `/main` returns to main. Selection clears the displayed page and fetches the selected history; stale in-flight history from prior selections is ignored. Switching only changes this client's selection, never creates work or aborts the previous chat. `/task` creates/selects an independent task conversation on the selected chat's host/cwd. Interactive and one-shot unacknowledged admissions/task-creation requests save their IDs and original chat/binding arguments privately before sending. See [durable client drafts](client-drafts.md) for recovery, storage and multi-client limits. `/draft`, `/drafts`, `/recover REQUEST_ID` and `/discard [REQUEST_ID]` inspect/manage this cache; recovery never automatically resends. Switching or creating another task is blocked until `/retry` succeeds or `/discard` explicitly forgets the draft. Discard is local: it does not undo or cancel work that may already have been admitted despite a lost ACK. On reconnect/selection, a saved request for that original chat becomes active for explicit `/retry`; other saved requests remain available through `/drafts`. Ctrl+C and exit detach without aborting Pi work; pending client HTTP reads are cancelled and late responses are ignored. Detaching with an unresolved draft prints a warning: it may already be admitted, and recovery requires the local save to have succeeded. A save failure prevents sending, but leaves new input memory-only. One-shot `--message` prints the durable submission receipt; it does not wait for inference.

### Older history in plain mode

`/older` walks backward from the oldest entry in the first recent page loaded for this selection. Each page is printed as a labeled older-history block, oldest first within the block; the terminal is not redrawn or prepended. A failed fetch leaves the cursor unchanged: retry `/older`, not `/retry`. Once exhausted, it reports no older history. Selection resets the browsing cursor. User/assistant text is rendered with the same control stripping as recent output; tool-call names and settled tool results are also rendered. System entries remain paginated but not rendered.

Recent polling and backward browsing keep independent cursors and page-size limits. Polling never resets the browsing cursor, and older IDs never advance the forward watermark. Both automatically halve their page limit on `too_large`, down to one entry, and retain the successful smaller limit for this selection; other errors leave cursors unchanged. Later automatic forward polls retry the same position; `/older` requires an explicit retry. A single oversized entry remains an explicit error. No unbounded display cache or automatic full-history download is added.

### Forward catch-up and detach

Within the current selection, each poll reads at most one ascending page after the last successfully displayed/observed ID. The watermark advances only after a validated page is rendered; all entries, including unrendered system entries, count. Empty pages leave it unchanged. Bursts larger than a page and transient hub/transport failures therefore do not jump over committed entries: subsequent polls resume the same position and drain the backlog in order. One page per poll bounds each catch-up step and leaves commands responsive; a sustained arrival rate above the drain rate can still grow the backlog. Activity is sampled at current time, independently of how far the displayed transcript has caught up.

This requires the updated hub and client together; restart `serve` after updating the runtime. It assumes the same store remains available and retains its history. A single oversized entry blocks progress with an error rather than silently skipping it. Selection/client restart deliberately starts a fresh bounded tail; the observation cursor is not persisted across client crashes, and older retained entries remain accessible via `/older`. These are committed-entry catch-up guarantees, not durable terminal delivery or preservation of provider partials/unretained shell bytes. SSE and partial streaming remain separate work.

Detaching aborts only this client's HTTP transport, not a Pi submission, tool or conversation. It does not send `stop`. Ctrl+C can therefore detach promptly while a catch-up read is stalled; ordinary connection closure still never means aborting hub-owned work.

### Activity and tool results

The plain client requests `history` with `includeActivity:true` on recent polls, and prints an `activity:` JSON status line only when the bounded summary changes. The first idle snapshot is quiet. `/activity` explicitly prints the selected chat's current summary; `/status` retains the broader global Pi inspection for diagnostics. Selection resets observation cursors and activity deduplication and ignores stale responses. Older-history fetches do not change the live display state.

`activity` contains `chatId`, Pi's `busy` run flag, queued submission count, optional `runTaskId` and generation `{attempt,phase}` (`generating`, `retrying`, `deferred`), up to 32 primary/nested tool summaries (`callId`, `name`, `status`, optional `taskId`, `nested`), `omittedTools`, compaction count and a compaction-failure flag. Call/name strings are bounded to 128/80 code units. Arguments, inbox content, provider errors, partial model text, tool output and arbitrary details are deliberately omitted. The underlying live/inbox/history reads sample committed state separately, not one atomic revision. This is a current presentation, not an event log, execution authority, admission ACK, proof of worker availability, or guarantee of OS process cleanup. Short transitions between polls can be missed. Nothing is stored outside Pi except the client's display fingerprint.

Retained assistant tool calls print names, not arguments. Canonical `pi.tool-result` entries print an ok/error flag, selected native metadata (code/exit status/truncation), and at most an 8K-character text tail after control stripping. Display clipping is labeled and does not alter the canonical result; non-text content gets a placeholder. An error/uncertain result does not mean the effect did not happen. Refreshing/rendering never reissues a tool.

Native bash still delivers output **at settlement**, not while running; live status only identifies the pending/running tool. Provider partial text, streamed shell output and SSE remain unfinished. Activity snapshots are not an event log or a replacement for the canonical transcript and forward entry catch-up.

## Writer failure and shutdown

In HTTP mode, Zig checks the writer's process status every 100 ms while idle in the listener loop and while waiting for IPC response bytes. It reaps only that exact child and caches its termination status for the normal `Child.wait` cleanup; native shell children retain their own waiters. Unexpected writer death, including exit code zero, stops the listener and exits serve nonzero with a generic `runtime unavailable` diagnostic. There is no automatic respawn, effect retry or second store owner.

The runtime also observes Pi's public `harness.closed` result. A failed Harness/store triggers a generic diagnostic and writer shutdown without logging the failure payload. Ordinary model/tool failures are not fatal store failures. Native request/control/result pipes are closed and their asynchronous close events awaited before forcing Node exit: an outstanding fs.read on the inherited result pipe can otherwise leave Node's libuv thread-pool shutdown blocked. Pi remains the canonical owner of pending work; the Zig worker drains file work and cancels owned shell groups when its channels close, retaining receipts where possible.

These are death/failure checks, not a heartbeat or live-hang watchdog. A living writer stuck in computation or effect draining is not automatically killed. HTTP header/body handling still uses three-second per-I/O socket timeouts and can delay process checks; those are not a total request deadline. A hard supervisor kill and deliberately escaped shell sessions retain the cleanup limits described in [shell tools](shell-tools.md).

After a failure, inspect pending work and uncertain effects before restarting the same serve command/state/mode. Never delete the writer lock. Existing clients retain their in-memory observation position through transient reconnects, and saved unacknowledged drafts can be explicitly retried after client exits. Transcript observation cursors are not durable.

## Validation

```sh
nix develop -c zig build
nix develop -c zig build test
DECK_TEST_BINARY="$PWD/zig-out/bin/deck" nix develop -c npm test
```

The supervisor test initializes a fresh directory, checks permissions/idempotency, sends framed requests, checks durable dedup/conflict, kills Zig while Node retains the writer lock, then drains/closes the child and reopens the same main chat. It uses no credentials. Additional fault tests kill an idle writer, request an unexpected clean exit, kill during IPC, and kill while a TERM-resistant native shell runs. They verify nonzero hub exit, port release, shell cancellation/retained receipt and store reopening. A separate synthetic Harness-failure notification exercises the real runtime shutdown path and checks that private error text is not logged; it is not a claim of complete SQLite fault-injection coverage. Without DECK_TEST_BINARY the runtime-only tests run and supervisor/fault integration tests are explicitly skipped.
