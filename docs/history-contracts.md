# Schema-backed history boundary

The existing `history` command now uses checked-in JSON Schema for its arguments, bounded page/entry envelope and the payload fields consumed by the plain renderer. This is a compatible read adapter over Pi's retained entries, **not** a replacement archive format, transcript mirror or complete schema migration of all Pi/provider data.

## Shape and compatibility

`contracts/wire.schema.json` owns the wire views; the existing generator produces Zig types/validators/codecs and TypeScript types/guards. No generator extension or runtime dependency was needed.

- `HistoryArgs` requires a safe positive string `chatId`, a limit from 1–100 (default 100), and at most one exclusive `before`/`after` cursor. Only `after` accepts the literal `"0"`. Optional attachment flags must be booleans. Legacy argument extensions remain ignored, not forwarded to Pi.
- `HistoryPage` is closed and bounds `items` to 100. Entry IDs keep their existing **numeric**, positive safe-integer v1 representation. Cursors remain canonical decimal **strings**. String, boolean, unsafe or fractional entry IDs are never coerced.
- `HistoryEntry` is deliberately extensible: Pi-owned metadata, original capture contents and unknown entry kinds are retained unchanged. The adapter additionally validates `deck.input` data, agent-origin IDs and the rendered fields of assistant/tool-result message arrays. Text/tool-call content requires its corresponding text/name field. Unknown entry kinds remain unrendered but still advance the observation cursor; unknown content types remain unrendered or get the existing non-text tool placeholder.
- Message/content arrays are bounded to 4,096; rendered strings to 1,048,576 Unicode code points. The existing **1 MiB encoded response** limit is separate and normally tighter. Ill-formed Unicode in checked strings refuses; retained content is not clipped or repaired to pass validation. No new bound is imposed on opaque extension fields beyond existing transport limits.
- Optional activity/progress/instruction attachments now use the [generated live-view contracts](live-view-contracts.md), including closed nested fields, bounds and semantic chat/UTF-16/result consistency checks. Supplied attachments must have been requested and match the selected history chat. Missing optional samples leave existing display state unchanged. They remain separate samples, not canonical history or effect receipts; no equality between their run IDs or observation times is required.

Generated typed parsers are views, not lossless archive codecs. Native forwarding uses the original validated bytes. Neither Pi records nor receipts/drafts are round-tripped through generated codecs for storage, hashing or replay.

## Semantic and transport guards

`runtime/src/history-contracts.ts` and the native forwarding guard validate the complete page relative to the original request:

- ascending, exclusive-after order for forward reads;
- descending, exclusive-before order for backward reads and the initial newest page;
- no duplicates, unsafe IDs or more rows than the requested limit;
- a supplied `next` must exactly equal the final row's ID in scan order;
- an empty page cannot supply `next` (unlike discovery, history has no filtered-out rows).

Generated request checks run before client send and private dispatch. Serialized private egress, Zig HTTP forwarding and client ingress all run shape and semantic checks. A malformed private reply fences the native transport without replay, consistent with other migrated commands. Invalid serialized output yields a generic correlated `invalid_response`; private payloads/serializer diagnostics are not exposed.

Both initial/forward history and `/older` validate **before any page content or older-page header is printed**, and before changing cursors. Invalid/lost pages leave both observation positions and saved mutation drafts intact. Forward polling may retry its previous read position; backward retry is explicitly `/older`, never `/retry` or automatic input replay. Valid system/unknown entries count toward the forward watermark even though the plain renderer omits them.

Existing fork-aware Pi scanning, nonconsecutive IDs, empty-chat bootstrap, adaptive page-size reduction on `too_large`, independent backward browsing, hub pinning, selection fencing, bounded output/backpressure and detach-without-stop are unchanged. A single oversized or invalid retained entry can block that read; no silent skip or record repair is introduced. History cursors remain memory-only across client restarts.

## Validation

- Shared generated-contract fixtures cover argument/page/entry/payload shapes, Unicode, bounds, required fields and archive-extension compatibility.
- `src/history.test.json` is a shared **35-case semantic corpus** consumed by TypeScript and the production Zig forwarding guard, including ordering, exclusive bounds, exact cursors, rendered payloads and safe IDs.
- IPC tests reject bad arguments before scanning, validate the serialized representation and preserve subsequent read availability without replay or private error output.
- Native HTTP faults cover malformed payloads, coercible/unsafe IDs, ordering, cursors, request limits and valid forward/backward pages (including integral float/exponent JSON numbers).
- Plain-client faults prove no partial invalid-page rendering, cursor preservation in both directions, explicit older retry, forward catch-up through gaps/unrendered entries and unchanged unacknowledged drafts. Existing real Pi/faux, fork/reopen, large-history, stale-selection, backpressure, HTTP and installed-package tests remain required.

History-slice aarch64-darwin validation (before the later live-view migration): pinned Zig formatting/tests/build, generated no-stale gate, TypeScript checks, `nix flake check path:.` and `nix build path:.` passed. The package suite reports **292 tests: 290 passed, two opt-in skipped**; separately, installed smoke passed **1/1** and isolated installed Rex API 10 passed **10/10**. No deadline widening, live-provider calls, live-hub upgrade or user Rex sessions were involved; other platforms remain subject to CI.

This is read-path hardening only: no new model input, task, terminal, allocation, stop or general settings command.
