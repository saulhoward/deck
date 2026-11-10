# Local client foundations before the Zig TUI

The existing **local** public commands and private native-effect boundary are now on the schema-first path. This is enough to start a maintained-library Zig terminal spike; remote workers are not a local-TUI prerequisite. No TUI dependency, renderer, remote transport, execution queue or transcript store is added here.

## Native boundary

`contracts/wire.schema.json` generates `NativeRequest`, operation/argument views, `NativeResult`, `NativeProgress`, `NativeResponse` and a compatible `NativeReceipt` validation view. Semantic adapters live in `runtime/src/native-contracts.ts` and `src/native_contracts.zig`.

The existing v1 bytes and fields remain unchanged:

```json
{"version":1,"id":"42","machineId":"saved-worker","cwd":"/saved","operation":"write","args":{"path":"file.txt","content":"text"}}
{"version":1,"id":"42","result":{"ok":true,"output":"File updated on assigned worker","code":"ok","exitCode":null,"truncated":false}}
```

- Requests/envelopes and per-operation arguments are closed. The generated `NativeArguments` superset is a decoding view, **not** permission to mix fields from different operations. Validate the operation-specific schema too.
- File/bash/allocation/receipt-lookup IDs are canonical positive decimal Pi safe-integer strings. Fresh Rex inspect/resolve IDs use the disjoint unsigned 64-bit high half. Gaps, zero, leading zeros and overflow refuse. Progress is exactly `progress:TARGET` with a safe Pi target ID. Cancellation retains its existing eight-byte big-endian record, restricted to these numeric namespaces; it is not a new JSON command or durable receipt. A malformed/closed control channel cancels accepted process groups. Once that failure is observed, later requests refuse; in-flight file operations still drain.
- Worker/cwd still come from the saved binding. Cwd must be absolute; paths/cwd are bounded to 4,096 UTF-8 bytes and reject NUL. Relative file paths, absolute paths, `..` and ordinary symlinks retain normal OS semantics: **not a sandbox**.
- Content/edit strings remain bounded to 128 KiB of UTF-8; an edit match cannot be empty. Bash requires a nonempty NUL-free command and an optional integer timeout of 1–300 seconds (default 60). Encoded frames remain at most 1 MiB. Rex plans/queries retain 16 KiB limits; receipt lookup permits a 256 KiB query and 128 KiB opaque original request.
- A response must match the pending request ID and contain exactly the payload for its operation. Progress is at most 2,048 UTF-8 bytes, with required boolean clipping/loss flags. Results have bounded well-formed text, optional compatible metadata and bounded exit codes. File results cannot claim shell exits/clipping; bash success requires exit zero; success codes must match the operation. Unknown well-shaped **failure** codes do not establish rollback or permission to replay. Rex consumers additionally validate their embedded projections and original saved scope, as before.
- `PipeFiles` validates the actual serialized request before writing, and the complete request-specific reply before resolving anything. Invalid, unsolicited, duplicate, mixed, lost or malformed replies fence the adapter, reject outstanding issued work as uncertain, and refuse new calls as offline. Explicit adapter close does this synchronously too. Late queued replies cannot turn a fenced operation into success. No automatic reconnect or resend is added.
- Zig validates requests before capacity allocation, receipt publication or effects, and validates actual serialized results before final-result persistence/egress. Malformed new requests close the private channel without acceptance. Stored malformed results do not become success/absence, and are not repaired or rewritten. Rex receipt lookup remains read-only and treats contradictory saved results as inconclusive.

The original request **bytes**, including property order and whitespace, remain the hash input. Generated typed serialization is not a receipt migration/canonicalization step. Existing receipt decoding retains its historical defaults, and matching valid old receipts are returned without rewriting or executing anything. Acceptance without a result still means `effect_uncertain`. Hash conflicts remain conflicts. The Pi/native operation relationship, process groups, four process slots, sixteen pending results, four progress reads, drain-only file cancellation and credential-restricted native environment are unchanged.

### Environment scope

There is **no production environment RPC** to migrate or expose. Production Pi tool execution uses the narrow native adapter; `DeckRuntime` returns no Pi environment when native tools are enabled, rather than falling back to the hub's Node filesystem. Native shell/Rex environment filtering remains an internal policy. Test-injected Pi environments are not a wire protocol. An `environment` native operation is refused; remote registration/environment contracts must be designed and verified with the remote-worker milestone.

## Client transport and error policy

`runtime/src/hub-client.ts` is a client-only transport used by the plain UI. It validates/byte-bounds the serialized request, limits streamed HTTP response bodies to 1 MiB **before JSON parsing**, requires valid UTF-8, refuses redirects, and keeps the existing ten-second deadline and detach signal. Content-Length is only an early limit check; chunked/decoded bytes are independently bounded. HTTP errors do not expose response bodies. One invocation sends at most one request, with a fresh transport ID and unchanged durable arguments/hub pin.

`command-policy.ts` and `src/command_policy.zig` share fixtures and generated policy types. This policy is local guidance, **not a new server receipt**. Every failure preserves drafts and forbids automatic mutation retry:

| Command class | Failure guidance |
| --- | --- |
| Read-only status/history/discovery/views/Rex inspection/login status | Preserve the current view/cursor; repeat the read according to the UI's existing polling/manual policy. Only validated remote `history:too_large` permits reducing the same-position page limit. |
| `admit`, `create_task`, `import_instructions` | Keep the saved request. Explicit retry uses the same durable ID, arguments and original binding. Remote `conflict`, `invalid`, `settings_changed` call for review, not a silently repaired request. Other/unknown errors still do not prove non-execution. |
| `rex_open` | Inspect before another explicit action. Best-effort duplicate/orphan risk remains; do not replay the old native operation. |
| Login start/reply/cancel | Observe the original transient interaction; do not automatically restart or replay an answer. A validated remote reply `conflict` may continue authoritative polling. Cancellation is not logout. |
| `stop`, `rex_startup` | Any repeat is an explicit action. Stop ACK is not drainage; startup ACK is not health. |
| Unknown command/error | Do not invent success, rollback or retry permission. |
| Local pre-send refusal | `not_sent` applies only because validation/serialization/abort refused before fetch; keep the draft for review. |

Remote errors, HTTP errors and lost/malformed replies never establish `not_sent` for a mutation. Well-shaped future error codes remain displayable and conservative. `KnownCommandErrorCode` describes the current producer vocabulary; it does not close the compatible wire error string.

Pure Zig helpers `src/hub.zig.validClientRequest()`, `validCommandArgs()` and `validReply()` expose the same public request/argument/reply semantics as `runtime/src/command-contracts.ts` for a future client. The reply helper includes envelope and exact transport-ID correlation. Importing these functions starts no listener or Pi session. Generated shape guards alone are insufficient; retain command-specific semantic and client selection-generation checks.

## Evidence and next step

- Shared shape corpus: **426 cases**; new semantic corpora: **61 native**, **33 public argument**, **30 failure-policy** cases.
- Native unit tests prove pre-acceptance refusal, exact raw-byte hashes, retained/uncertain/conflicting results, optional legacy metadata and byte-identical corrupt-receipt refusal without effects.
- Real inherited-pipe tests inject invalid/late/duplicate/progress replies, closure, loss and bad UTF-8. Raw ingress tests bypass the TS guard and verify the actual worker refuses before receipts, file changes or process launch.
- HTTP faults cover oversized declared/chunked bodies, malformed/truncated UTF-8/JSON, redirects, HTTP failures, loss, abort and wrong IDs. All three draft kinds stay byte-identical through unknown remote errors and malformed/oversized responses until explicit exact-argument retry.
- The backpressure test still floods 256 progress requests and enforces its original cancellation deadline, now using the production progress correlation spelling. No deadlines are widened.
- Zig now explicitly registers earlier history/live-view/status/login/Rex semantic tests; this exposed and fixed one dormant Zig 0.17 allocator-argument omission in a view test.

Validation on **aarch64-darwin / Zig 0.17.1**: **28/28 Zig tests**, generated/TypeScript checks, full development and Nix package suites (**382 tests: 380 passed, two opt-in skipped**), `nix flake check path:.`, and `nix build path:.` passed. Installed smoke passed **1/1**; separate isolated installed Rex API 10 passed **11/11**. Cross-builds passed for x86_64 macOS and x86_64/aarch64 Linux; those are compilation checks, not runtime-support evidence.

Next: evaluate maintained Zig 0.17.1 TUI libraries in an isolated editing/Unicode/paste/resize/keyboard/restoration spike. Test untrusted terminal-control handling at rendering without rewriting retained text. Then build a single-chat client using canonical bounded history, replaceable views and the existing draft format. Add no Pi runtime/store, hidden Rex creation, model-input replay or stop-on-detach behavior. Keep `--no-tui`. Live OAuth, remote identities/reconnects, new platforms and terminal-library compatibility remain separate validation claims.

Builds do not deploy. Keep the original immutable build while unfinished work exists, and upgrade a live hub only when idle. These checks use scratch state/fake providers and isolated Rex, not live hub/provider/user sessions.
