# Generated activity, progress and instruction read contracts

The `activity`, `progress` and `instruction_status` commands and their optional `history` attachments now use generated JSON Schema contracts at every transport boundary. This completes the selected-chat live-view slice, **not** the remaining status/login/native-effect protocol migration. In particular, `status.activity` is a different, global Pi inspection shape and is not covered here.

## Wire shapes and scope

`contracts/wire.schema.json` owns all view types, enum/union variants, required/nullable/optional fields, bounds and unknown-field policies. Types/runtime guards are generated for TypeScript and Zig; no generator extension or new dependency was needed.

- `LiveViewArgs`: optional positive safe string `chatId`; activity/progress retain legacy ignored argument extensions. Omitted or null envelope args default to `{}`; explicit null fields refuse.
- `InstructionStatusArgs`: optional safe `chatId`/`taskId`, with the existing closed argument policy. No path, instruction text or mutation parameters are accepted.
- An omitted chat still selects main at runtime. Explicit chat selections must match the returned `chatId`. An explicit instruction task must match the non-null returned import task. These are scope/correlation checks, not authentication or ownership authority.
- All output objects, nested views and result variants are closed. Unknown fields, variants, null nonnullable optionals, unsafe IDs/counts and excessive arrays/strings refuse rather than being normalized into a plausible observation.

### Activity

The existing unversioned v1 shape is retained: chat, busy flag, queued count, optional run/generation, up to 32 tool summaries, omitted-tool/compaction counts and compaction-failure flag. Generation phase is `generating|retrying|deferred`; tool status is `pending|running|done`. Tool call/name labels keep their 128/80 UTF-16-unit caps; task IDs are safe decimal strings. Arguments, output, private details and errors remain absent.

No extra busy/run/tool-state relationship is inferred from this presentation. Sampling is not a worker-health lease, task outcome or proof native effects drained.

### Progress

The existing version-1 `provisional:true` shape is retained. Generation, a tools array or a tool-slot omission marker requires a safe run ID. Generation text stays within 2,048 UTF-16 units; up to four bash-only tails stay within 512 each. Attempts are positive safe integers; omission markers are literal true when present, and omitted-block counts are positive. No general tool partials, hidden reasoning, arguments or provider diagnostics are added.

A valid idle snapshot may clear displayed previews. A malformed or missing snapshot cannot. Samples remain replacement tails, not append deltas, effect receipts, completion evidence or a durable delivery stream.

### Instruction status

Source and import task are required, explicitly nullable fields. Source labels keep the existing 80/256 UTF-16 caps, absolute displayed cwd, fixed `AGENTS.md` path, SHA-256, 0–32,768 byte count and safe source task ID.

The import view keeps Pi's existing task-state/outcome enums. Nonterminal views cannot contain an outcome/result; terminal views require an outcome. Only completed outcomes contain exactly one of a result or `resultOmitted:true`. Results are closed `applied` (source), `rejected` (bounded reason) and `aborted` variants. Applied source identity must match the import task. `sourceOmitted:true` requires a null current source.

**Current source and historical import remain independent.** The current source may be absent or belong to a different import than the explicitly requested historical task. No equality with that historical result is imposed. Domain projection still whitelists stored data and explicitly marks omitted invalid provenance/results; malformed wire data is rejected, not repaired by the client. An invalid task projection fails the read instead of fabricating an absent task.

## Validation and failure behavior

Generated/semantic guards run before client send and private dispatch, on actual serialized IPC egress, before Zig HTTP forwarding, and at client ingress. Shared TypeScript/Zig semantic checks preserve safe IDs, scope echoes, existing UTF-16 limits and instruction result consistency. Unknown commands continue on their existing contracts; this migration does not accidentally apply selected-chat activity validation to global status.

History validates every supplied attachment before any entry or live sample is rendered and before either cursor advances. Attachments must have been requested and match that history request's chat. Their run IDs and observations are **not** required to match each other: Pi history/live/source/task reads are separate samples, not one atomic snapshot. Requested samples can remain absent, including the existing progress/instruction frame-budget fallback; omission is not a clearing claim.

Invalid serialized output yields a generic `invalid_response`, without private payload diagnostics. A malformed private response fences native forwarding with no replay. Client read failures preserve history positions, preview/instruction deduplication state and all existing mutation drafts. Instruction display retains canonical key ordering for deduplication and JSON-escapes DEL/C1 controls as well as ordinary JSON-escaped C0 controls in labels. Forward polling can retry the same read position; explicit read commands introduce no new retry draft, automatic mutation, instruction reload, stop or inference. A malformed attachment blocks that page rather than silently advancing past its entries.

## Unicode and retained data

Schema lengths count code points; existing UTF-16 display caps remain separate semantic guards in both languages. Producers now clip a well-formed string without cutting a surrogate pair: a boundary pair is omitted as a whole, and existing clipping flags remain accurate. No UTF-16 cap is increased. Boundary validation rejects malformed strings instead of coercing/normalizing them.

Only ephemeral display projections change. Canonical Pi records, instruction source documents, captures, request hashes, receipts and saved drafts are not migrated or rewritten. Wire shapes/IDs, admission semantics and effect uncertainty rules remain unchanged. The existing unfinished-work implementation compatibility gate still applies to this new build.

## Tests

- Shared generated shape fixtures exercise arrays, enums, result unions, required/null/optional fields, bounds and native typed-codec round trips, including a nested applied result.
- `src/views.test.json` is a shared 51-case semantic corpus for scope, safe IDs, state/result relationships, UTF-16 versus code-point bounds and history attachments.
- IPC faults cover pre-dispatch rejection, default selection, ignored/closed arguments, serialized-output changes, wrong chat/task echoes and malformed attachments without private output or redispatch.
- Native HTTP faults exercise the production forwarding checks and transport fencing, independently of TS validation.
- Client faults preserve drafts/cursors/deduplication across malformed/lost reads, never partially print a bad page, never clear previews from an invalid sample and recover at the same canonical position.
- Existing actual Pi/faux streaming, instruction-import, frame-budget, stale-selection, backpressure/detach, crash-recovery and installed-package tests remain required. No live provider or user Rex sessions are used.

## Validation result

Fresh aarch64-darwin validation passed: pinned Zig formatting/build/tests, TypeScript/generated-contract checks, `nix flake check path:.` and `nix build path:.`. The final package suite reports **308 tests: 306 passed, two opt-in skipped**. Separately, installed-package smoke passed **1/1** and isolated installed Rex API 10 passed **10/10**. The generated shared shape corpus now has 289 cases; the 51 view semantic cases supplement the existing history corpus. No deadlines were widened, live hub upgraded, credentials used for inference or user Rex sessions touched. Other platforms remain subject to CI.
