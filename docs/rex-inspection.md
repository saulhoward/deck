# Fresh read-only Rex inspection (internal)

`DeckRuntime.inspectTerminal(chatId, signal?)` now samples the **saved native worker and exact bound Rex objects**. It is also exposed by the validated read-only `rex_inspect` command and `deck rex inspect` / `/rex inspect`; see [the public workflow](rex-open.md). It is not a model tool or automatic reconnect action. No new allocation, adoption, replacement, input or inference follows from a sample.

Keep three independent facts separate:

1. [Creation provenance](rex-allocation.md): retained native result applied to a Pi-owned allocation task and full binding.
2. [Historical startup](rex-startup.md): the allocation-bound client once registered its native `REX_BLOCK`.
3. **This inspection:** a fresh, bounded, non-atomic observation, not a health lease, responsive-client handshake, selected-chat proof or proof of input delivery.

A running process is not application readiness. An exited client does not mean its conversation or project is complete. Failed inspection never makes a saved binding disappear or clears uncertain creation. The one-allocation-attempt-per-chat restriction remains unchanged.

## Scope and authority

Inspection reads existing Pi conversation/agent/Rex metadata and the original allocation task/result. It requires the original managed ownerless task, coherent saved machine/cwd, matching hub/chat/allocation task, trustworthy retained creation binding and original explicit executable/endpoint/host/instance. Creation provenance may come from the original completed allocation or the separately linked successful [receipt-based reconciliation](rex-reconciliation.md); the old uncertain/aborted outcome is never rewritten. A broken reconciliation proof link refuses inspection. Without a binding it returns `unbound`, including when creation remains uncertain; it does **not** discover objects by label or startup claims.

The request is built from that saved binding, not supplied session IDs or current focus. It routes through the assigned `HostFiles` adapter. The native worker verifies its machine identity, executes in the saved absolute cwd and accepts only an explicit local `unix:///ABSOLUTE_SOCKET` with expected full host/instance/session/window/block IDs. No hub/other-worker fallback, daemon autostart or credential forwarding is added. The original Rex executable is trusted external code, not byte-attested or sandboxed.

Pi records are rechecked after I/O. An in-flight subscription fences conversation, saved binding/metadata and agent-cwd changes, including change-and-restore (ABA); stale results have no observation. Per-chat single-flight and a four-read runtime limit prevent competing retained samples. Each call has a new request UUID. There is no persisted latest-health value: callers must scope presentation to that request/chat/hub and discard old samples. Public connection-generation/selection fencing remains part of the future client integration, not an implemented transport protocol.

## Bounded native adapter

Every CLI call uses literal argv and:

```text
/absolute/rex --autostart=false --timeout 2s --server unix:///SOCKET ...
```

The native `rex_inspect` operation uses the existing four cancellable process slots, shared with bash and allocation, but **bypasses the native acceptance/result journal entirely**. Ephemeral read IDs occupy the upper half of the 64-bit control-ID space, disjoint from Pi safe-integer task IDs; mutation operations reject that namespace. IDs are unique for the lifetime of the hub's worker pipe, not durable retry identities. No read receipt can be replayed as fresh observation or mistaken for a mutation receipt after restart.

Queries and final projections are generated-schema validated and bounded to 16 KiB. Raw stdout/stderr share the existing 64 KiB lossless-output limit and are additionally captured as separate bounded channels, necessary to distinguish native errors from diagnostic-looking stdout. Each subprocess has a four-second deadline plus bounded process cleanup; at most six CLI calls are issued per sample. Cancellation uses the existing TERM/KILL/drain machinery. This is a bounded sequence, not an atomic multi-read transaction or a hard real-time deadline.

The raw environment uses the existing credential-restricted allowlist; no progress/output previews or raw diagnostics are forwarded. Native results omit terminal contents, labels, cwd/home, PID, argv, environment and private errors. The timed runtime projection includes hub/chat/task/request identity, start/finish wall-clock milliseconds, sample disposition and the expected exact object scope. Revision is the sampled session view revision, **not** a lock or process-health generation. Wall-clock labels are not trusted elapsed-time measurements.

## Read sequence and native evidence

The supported installed evidence is Rex API **8**, version `0.0.1793377904-ge6592f`, and API **10**, version `0.0.1793645657-gd018d2`, on aarch64-darwin. The [API 10 revalidation](rex-replacement.md) exercises the existing production allocation/reconciliation/inspection sequence; the adapter accepts only these two revisions and still refuses unknown/intermediate revisions. The adapter:

1. Runs `server status --json`, checking endpoint, host, instance and API revision.
2. Calls `api call session.view '{"session_id":"FULL_ID"}'`, verifying the exact session, revision, complete window/layer/block structure, full IDs and duplicate absence.
3. Calls `api call session.list_blocks` with the exact session. This includes detached blocks, unlike the placed-only session view. Cross-checks placed block IDs/window/host/flavor against the view, with at most 128 windows/layers and 512 blocks. A detached block or one under the wrong window is conflict, **not** a missing terminal.
4. For the correctly placed local shell block only, calls `api call com.superlogical.terminal.process` with exact session/block and an empty **object** `args`.
5. Re-reads the session view/revision, then rechecks server identity. Structural/revision changes make the result inconclusive; final identity change overrides apparent presence/absence.

All reads are scoped; there is **no session live-list lookup**. Recognized pagination/partial/truncation markers, incomplete required structures, invalid JSON, unsupported API shapes, oversized/lossy output or failed calls never establish absence. Raw byte truncation is rejected even if its retained tail looks like valid JSON.

For an absent session, only this version-specific native API failure is affirmative evidence: normal exit **3**, empty stdout and exact stderr

```text
Error: stream response "control-1" failed: session FULL_ID not found (status=404 code=session_not_found)
```

including the final newline, followed by successful matching server identity verification. CLI `session inspect` target-resolution prose, a generic nonzero exit, another session's 404, authentication failure, timeout, mixed stdout/stderr or a diagnostic-looking string in stdout is inconclusive. Unsupported future error shapes stay inconclusive rather than broadening this recognizer.

API 8 omits absent optional process fields as well as returning nulls. A positive child/foreground PID means `running`. A completed `last_exit.exit_code` without a running process means `exited`; only the signed exit code is projected. Missing/null process fields without a completed exit record mean `pending`, **not** exited. Malformed process records or unsupported signal-only exit shapes stay inconclusive. Even a correctly returned process sample can become outdated immediately.

## Results

Generated contracts live in [`contracts/wire.schema.json`](../contracts/wire.schema.json): inspection scope/query, presence/status string enums, observation and timed snapshot. Zig validates input and serialized output; TS validates native ingress, compares expected scope and checks exit-code/state consistency before whitelisted projection. Schema shape validity does not prove authority or observation freshness.

Outer `status`:

- `sampled`: bounded native observation returned, including inconclusive/failure categories;
- `unbound`: no saved full binding; not proof of no external effect;
- `unavailable`: no native adapter;
- `conflict`: original Pi authority/provenance/binding checks fail, with no CLI call;
- `stale` or `cancelled`: no observation is returned or applied.

Native `state` distinguishes `unavailable`, `identity_changed`, `missing_session`, `missing_terminal`, `pending`, `running`, `exited`, `conflict`, `inconclusive` and `cancelled`. Offline/busy native responses are unavailable; a generic rejected/lost read remains inconclusive. Read-only inspection never mutates. An explicit public open may reuse a running client or create for observed exited/missing objects, under the separate best-effort policy.

## Evidence and limits

Automated Pi/faux and fake-native tests cover read-only record/receipt behavior, original worker routing, capacity, cancellation/draining, independent admission/file effects during reads, binding ABA, late samples, scope drift, malformed/private output, detached/wrong-window/duplicate objects, pending/null/omitted fields, exit codes, identity changes, unsupported APIs, partial/inconsistent/flooded data, false 404s and timeouts. Reads create no input, model generation or Pi task; existing creation/startup/bindings/receipts remain intact.

The explicit opt-in [installed Rex test](rex-contract.md) additionally runs the **production worker inspector** against a scratch allocated Deck client: running → exited → exact terminal removed while the session remains → native session-not-found. Historical startup and full saved binding remain unchanged, no read receipts appear, and canonical history stays empty. The fixture's private filesystem control is test-only, not a public API or another writer.

No user sessions, live provider, live-hub refresh, GUI/server restoration, remote worker or cross-platform support is claimed. The narrow [retained-creation reconciliation](rex-reconciliation.md) now repairs provenance without Rex calls. The public [best-effort local allocation/open/reopen workflow](rex-open.md) now uses this inspection path; broader reconciliation, native conditional guards and race/lost-reply recovery guarantees are not prerequisites. A read-only sample is not a lock; concurrent opens or explicit new attempts after unknown outcomes may leave duplicate terminals for manual cleanup. The inspector itself remains read-only.
