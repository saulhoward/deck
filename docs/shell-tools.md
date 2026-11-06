# Native bash (prototype)

`bash {command, timeout?}` now runs on the conversation's saved Zig worker alongside native file tools. Timeout is in seconds, defaults to 60, and must be an integer from 1 to 300. Bash must be on the worker's PATH. Commands are noninteractive (`stdin` is /dev/null); there is no Rex process persistence yet.

## Try it

Rebuild Zig and TypeScript and restart the hub. Use the scratch workspace/state from [local tools](local-tools.md), or create a new one with `--workspace`. Existing chats retain their saved cwd. Ask the agent:

- “Run `pwd` and list the workspace files.”
- “Create a small script in this workspace and run it.”
- “Run `sleep 30`.” Then send `/stop` while it runs.

Automated tests use only fake inference and real local Zig shell execution. The user reports live API-key bash execution, foreground `sleep 30` cancellation with `/stop`, and detach/reconnect while a delayed shell finishes all passed. This is manual validation, not coverage of every process-tree escape or failure mode. As before, paid API-key mode must be explicitly selected.

## Execution and bounds

- Zig launches `bash --noprofile --norc -c <command>` with the saved cwd and a new POSIX process group. A binding to another/offline machine never falls back to the hub.
- At most four bash operations run concurrently; excess requests return `busy` without acceptance. File work and chat admission do not wait for these processes.
- Stdout/stderr are continuously drained, retaining only a **64 KiB combined tail**. The model receives that tail, an exit status, timeout/cancellation status, and a truncation flag. Full output is not retained in an artifact yet. While running, the plain client shows [sampled provisional tails](live-progress.md) separately from settled results, clipping long final results to a labeled 8K-character display tail; `/activity` prints status without output.
- Nonzero exit is a tool error. Invalid UTF-8 (including a clipped multibyte prefix in the tail) is replaced by `?` for high bytes, with `lossyUtf8=true` reported. Stream ordering is the worker's poll/read order, not a strict reconstruction of concurrent writes.
- The shell inherits the worker environment except `OPENAI_API_KEY` and `BASH_ENV`. It does not inherit the hub's SQLite writer lock or private worker pipe endpoints. Ordinary host tool credentials remain ambient on that machine.

**This is not a sandbox or credential-isolation boundary.** Commands have your OS user's capabilities, can access absolute paths and local credential files, and can contact external services. Removing the default key environment variable does not prevent a trusted user's process from reading other user-accessible state. Shell commands/output are centrally retained and may contain secrets. Do not use this prototype with untrusted prompts, repositories or machines.

## Sampled running output

Each active native bash slot caches only its latest 2 KiB output tail, replaced at most every 250 ms. The TS adapter requests that ephemeral sample at most once per 500 ms while its tool invocation is active, with at most four outstanding sample requests separate from the sixteen effect-request slots. Sampling does not create native operation receipts or replay accepted commands. It uses the saved machine/cwd and stable operation ID; missing samples do not establish completion, health or availability.

No progress pipe or disk write occurs in the shell's drain loop. The worker copies a bounded sample under a short in-memory mutex, then responds outside that mutex. Even a full result pipe cannot block drain/timeout/cancellation checks. The adapter retains at most one Pi `details()` publication in flight plus one replacement sample, and deduplicates unchanged samples. Progress errors do not replace the native result. Pi's LiveDoc owns the visible sample; there is no second output log.

The public preview retains up to four running native bash tails, each at most 512 UTF-16 code units, with clipping/lossy flags. It includes bounded nested bash slots but no generic tool details, arguments or diagnostics. Fast commands and intermediate output may be missed. Output is untrusted and may contain secrets; terminal sanitization is not redaction. A preview is **not** proof of command success, absence of effects, or complete output. Successful settlement replaces it with the final tool result. Stop/restart may retain an interrupted sample in Pi's error details, not a new successful result; an uncertain command is never rerun to rebuild its preview.

## Cancellation and ownership

The TS adapter forwards Pi's tool cancellation signal over a **separate inherited control pipe**, using fixed-size operation-ID records. Cancellation cannot sit behind a large command body or a full output pipe. Zig checks it while polling/draining child output, sends TERM to the command group, then escalates to KILL after 250 ms if needed. Early cancellation is remembered even if it arrives before the work frame is processed.

`/stop` remains scoped to the selected conversation. It returns a stop-request receipt promptly; Pi then aborts/drains its owned work and withdraws queued input. Use `/status` to observe actual activity. Detaching a chat does not cancel anything. Native-channel closure requests cancellation of active groups, but a hard supervisor kill cannot promise cleanup of already-spawned processes.

When the shell leader finishes, Zig also kills ordinary background descendants in that group. Programs that deliberately escape via a new process group/session or a service manager are outside this ownership guarantee; this is not daemon supervision. The worker bounds final output draining rather than waiting forever on pipe descriptors retained by escaped descendants. OS/kernel stalls can still delay process termination; cancellation cannot undo completed filesystem/network effects.

## Recovery

Bash uses the same private accepted/result receipt journal as files, with the stable Pi tool-task ID and full request hash. Acceptance is synced before spawn. A matching completed duplicate returns the retained result rather than rerunning a command. An accepted receipt without a final result is **effect_uncertain** after restart. Conflicting IDs reject. These tools remain non-replay-safe in Pi: the runtime never automatically reruns an interrupted shell.

Do not retry an uncertain mutation automatically. Inspect actual state before deciding whether a new command is appropriate. A shell's timeout or cancellation does not prove it had no external effects, and neither receipts nor Pi recovery provide exactly-once effects or power-loss guarantees. Rex-backed long-running sessions and cross-host reconnection remain future work.

## Tests

Zig tests cover success/nonzero exit, bounded output, invalid UTF-8, timeout, TERM-resistant cancellation and ordinary background-child cleanup. An actual inherited-pipe test covers shell execution, model-key environment omission, retained-result replay, cancellation during output flooding, concurrent file access and four-slot capacity. Pi/native tests verify visible pre-settlement output, read-only/isolation/bounds, separate full final output, no preview receipts, retained-result replay without rerunning, stop clearing and lossy UTF-8. A deliberately unread/full native result pipe verifies shell draining and TERM-resistant cancellation still settle the retained receipt. SIGKILL after a visible sample verifies original-build recovery marks the tool interrupted, clears live output and never calls the native effect adapter again. Client tests cover sanitization, deduplication, stale selection, outage and detach/backpressure. The installed smoke also samples real packaged bash without inference. Live-provider validation of these new previews remains pending.
