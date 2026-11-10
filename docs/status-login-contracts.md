# Status and login contracts

The remaining public startup/selection and authentication commands now use the same generated-contract path as history, activity, instructions and Rex. This is groundwork for a second client/TUI, **not a TUI implementation or a remote-worker claim**. Pi still owns conversations/execution and its retained records; login remains a single transient provider interaction.

## Status and selection

`status {chatId?}` returns a closed `StatusSnapshot`. Missing/null envelope args still mean `{}`; an individual `chatId:null` is invalid. Legacy ignored argument extensions remain allowed. Safe positive string IDs and exact selected-chat echoes are checked before use: an omitted selection must return `chatId === mainChatId`; an explicit selection must echo it. A supplied expected hub ID must match the response. Malformed identity/capability metadata cannot select a chat, load history for another chat, create a draft or submit input.

- `hubId`, `mainChatId`, `chatId` and the `tools` display label are required. Tools currently says `offline` or `native-files + bash`; this is hub capability, **not availability of the saved worker**.
- Current producers emit the implementation SHA-256 and numeric `hubGuard`, `rexStartup`, `rexOpen` capabilities. These fields remain optional for older peers; omission never implies support. Operations which require a capability still refuse when it is missing/disabled. This is identity correlation, not authentication or proof that two restored stores have not reused an identity.
- The optional saved binding is a closed projection of machine/cwd, kind/title and paired parent/owner display links. Empty/offline metadata remains displayable, not execution authority. Original documents and their extensions are unchanged; no metadata is created by reading status.
- The optional model reference preserves Pi extensions/parameters as opaque JSON. Provider/model names are checked when supplied, and simultaneous provider labels must agree. The producer samples the model once, rather than reading its provider and reference separately. This is not a captured-settings migration.
- The optional global `activity` field is **not** selected-chat `ActivitySnapshot`. Its outer scheduling/tasks/submissions shape is checked, with at most 4,096 tasks and 4,096 submissions. Pi task/submission records, scheduler-state extensions and model parameters remain opaque compatible data. No new Pi archive schema, transcript mirror or lifecycle authority is introduced. An oversized/invalid read fails whole; it never truncates work into a false idle observation.

Validation runs before client send/private dispatch, on actual serialized IPC egress, at native HTTP forwarding and at client ingress. Native forwarding preserves validated original bytes rather than re-encoding typed views. Failed selection/status reads leave existing selection, history cursors and all saved input/task/import drafts unchanged.

## Login shapes and authority

Generated definitions cover `login_start`, `login_status`, `login_reply`, `login_cancel`, their arguments and closed replies. Transient login IDs are not durable input IDs. Existing input string limits remain 200,000 UTF-16 units in addition to schema code-point/well-formed-Unicode checks; bytes/frames are independently bounded. Argument extensions remain ignored, not forwarded to the provider.

`LoginSnapshot` has disjoint `idle`, `unsupported`, `pending`, `done`, `failed`, `cancelled` variants. Only `pending` may contain a prompt; active/terminal interactions require their original ID and a bounded event ring. A start response must echo the request ID, including when retrieving an already-settled transient interaction. A status poll must still match the client's current interaction before anything is rendered.

- Up to 16 provider events: `info`, `auth_url`, `device_code`, `progress`.
- Prompt variants: `text`, `manual_code`, `select`, `secret`. Descriptors contain no entered answer. The plain client still refuses secret-entry prompts before asking for an answer.
- Event links and select options are bounded to 64; option IDs must be unique. Public strings are bounded and well formed. Device timing metadata uses nonnegative safe integers; the client does not use it to schedule inference or infer authentication success.
- A provider adapter copies only the declared interaction fields, including public option descriptions. Provider extension fields/tokens are never spread into the wire view. Invalid/oversized known fields fail rather than being coerced, clipped or fabricated. Wire samples containing extra/private fields are rejected, not repaired.
- `login_reply` returns exactly `{accepted:true}`: only acknowledgement of delivery to that active prompt, **not credentials saved**. The client reports success only after a validated, matching `done` snapshot.
- `login_cancel` returns exactly `{cancelled:true}` after the transient interaction closes. This is not credential deletion/logout or proof that a concurrent provider callback did not already save credentials.

The client first validates `status` and pins its hub before starting login. Every subsequent login request, answer and best-effort cancellation carries that identity. Start/status/reply faults never automatically restart login or replay an answer. A known prompt-conflict may mean the browser callback won; polling authoritative state remains allowed. Other reply errors are unconfirmed outcomes, not permission to send again. Cleanup attempts cancellation of only the original interaction; failure does not establish its outcome. A lost start response can leave an active interaction until explicit cancellation or the existing ten-minute expiry.

Rendering JSON-escapes provider strings and DEL/C1 terminal controls; it does not open URLs, write the clipboard, echo entered answers or interpret terminal commands. Only the latest bounded notification-key set is retained for display deduplication, not a growing transcript. No auth-mode change, API-key fallback, credential format change or live OAuth validation is included.

## Generator and tests

The login variants exposed a generator bug: union decoding emitted inline payload structs inside a parser function, making optional-field serializer captures shadow that function's parameters. Decoding now references the union's declared payload type. A cross-language compiler probe exercises optional fields inside discriminated variants and omission-preserving round trips; the supported schema subset is unchanged.

The shared shape corpus now has **373 cases**, with **32 status/login semantic cases** shared by Zig and TS, plus UTF-16 boundary probes. Tests exercise actual serialized egress, malformed native forwarding/fencing, provider field whitelisting, failed provider events, initial identity refusal, failed chat selection, changed hubs, unsupported secret input, wrong login/prompt state, lost/malformed answer ACKs and byte-identical preservation of all three draft kinds. Existing client fixtures now supply valid status shapes so their original draft/progress/Rex fault tests still reach the boundary they intend to test; their deadlines and assertions were not weakened.

Validation at completion of this slice, before the [Zig 0.17.1 migration](zig-toolchain.md), on **aarch64-darwin** using pinned Zig 0.15.2/Node 24: formatting/build/native tests, TypeScript/generated checks, `nix flake check path:.` and `nix build path:.` passed. The package suite reports **356 tests, 354 passed, two opt-in skipped**; its installed-package smoke passed **1/1**, and a separate isolated installed Rex API 10 run passed **11/11**. Existing deadlines were not widened. Live provider OAuth and other platforms are not claimed validated.

Remaining prerequisites for the planned remote-worker/TUI work are native-effect request/result/progress contracts and command-specific error policy. Opaque Pi/provider data is intentionally not a second authored storage model. No live hub upgrade, provider authentication, automatic Rex creation or user-session change is performed by this migration.
