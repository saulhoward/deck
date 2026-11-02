# Native bash (prototype)

`bash {command, timeout?}` now runs on the conversation's saved Zig worker alongside native file tools. Timeout is in seconds, defaults to 60, and must be an integer from 1 to 300. Bash must be on the worker's PATH. Commands are noninteractive (`stdin` is /dev/null); there is no Rex process persistence yet.

## Try it

Rebuild Zig and TypeScript and restart the hub. Use the scratch workspace/state from [local tools](local-tools.md), or create a new one with `--workspace`. Existing chats retain their saved cwd. Ask the agent:

- “Run `pwd` and list the workspace files.”
- “Create a small script in this workspace and run it.”
- “Run `sleep 30`.” Then send `/stop` while it runs.

Automated tests use only fake inference and real local Zig shell execution. Model-driven shell use with a live provider still needs your manual smoke test. As before, paid API-key mode must be explicitly selected.

## Execution and bounds

- Zig launches `bash --noprofile --norc -c <command>` with the saved cwd and a new POSIX process group. A binding to another/offline machine never falls back to the hub.
- At most four bash operations run concurrently; excess requests return `busy` without acceptance. File work and chat admission do not wait for these processes.
- Stdout/stderr are continuously drained, retaining only a **64 KiB combined tail**. The model receives that tail, an exit status, timeout/cancellation status, and a truncation flag. Full output is not retained in an artifact yet, and output is delivered at settlement, not streamed live. The plain client now shows pending/running Pi tool status and settled results, clipping long results to a labeled 8K-character display tail; `/activity` prints the selected conversation's current summary.
- Nonzero exit is a tool error. Invalid UTF-8 (including a clipped multibyte prefix in the tail) is replaced by `?` for high bytes, with `lossyUtf8=true` reported. Stream ordering is the worker's poll/read order, not a strict reconstruction of concurrent writes.
- The shell inherits the worker environment except `OPENAI_API_KEY` and `BASH_ENV`. It does not inherit the hub's SQLite writer lock or private worker pipe endpoints. Ordinary host tool credentials remain ambient on that machine.

**This is not a sandbox or credential-isolation boundary.** Commands have your OS user's capabilities, can access absolute paths and local credential files, and can contact external services. Removing the default key environment variable does not prevent a trusted user's process from reading other user-accessible state. Shell commands/output are centrally retained and may contain secrets. Do not use this prototype with untrusted prompts, repositories or machines.

## Cancellation and ownership

The TS adapter forwards Pi's tool cancellation signal over a **separate inherited control pipe**, using fixed-size operation-ID records. Cancellation cannot sit behind a large command body or a full output pipe. Zig checks it while polling/draining child output, sends TERM to the command group, then escalates to KILL after 250 ms if needed. Early cancellation is remembered even if it arrives before the work frame is processed.

`/stop` remains scoped to the selected conversation. It returns a stop-request receipt promptly; Pi then aborts/drains its owned work and withdraws queued input. Use `/status` to observe actual activity. Detaching a chat does not cancel anything. Native-channel closure requests cancellation of active groups, but a hard supervisor kill cannot promise cleanup of already-spawned processes.

When the shell leader finishes, Zig also kills ordinary background descendants in that group. Programs that deliberately escape via a new process group/session or a service manager are outside this ownership guarantee; this is not daemon supervision. The worker bounds final output draining rather than waiting forever on pipe descriptors retained by escaped descendants. OS/kernel stalls can still delay process termination; cancellation cannot undo completed filesystem/network effects.

## Recovery

Bash uses the same private accepted/result receipt journal as files, with the stable Pi tool-task ID and full request hash. Acceptance is synced before spawn. A matching completed duplicate returns the retained result rather than rerunning a command. An accepted receipt without a final result is **effect_uncertain** after restart. Conflicting IDs reject. These tools remain non-replay-safe in Pi: the runtime never automatically reruns an interrupted shell.

Do not retry an uncertain mutation automatically. Inspect actual state before deciding whether a new command is appropriate. A shell's timeout or cancellation does not prove it had no external effects, and neither receipts nor Pi recovery provide exactly-once effects or power-loss guarantees. Rex-backed long-running sessions and cross-host reconnection remain future work.

## Tests

Zig tests cover success/nonzero exit, bounded output, invalid UTF-8, timeout, TERM-resistant cancellation and ordinary background-child cleanup. An actual inherited-pipe test covers shell execution, model-key environment omission, retained-result replay, cancellation during output flooding, concurrent file access and four-slot capacity. A Pi contract test verifies selected-conversation abort propagates its signal to the native shell adapter.
