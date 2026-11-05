# Sampled answer previews

The plain client now displays a bounded **provisional snapshot** of the selected chat's current assistant text, alongside its existing activity lines and canonical history. It reads Pi's `LiveDoc`; there is no second stream log, transcript store, execution tracker or inference engine.

Example (each preview is a complete snapshot, **not an append-only delta**):

```text
assistant preview (provisional snapshot): {"runTaskId":"42","attempt":1,"phase":"generating","text":"An initial explanation"}
assistant preview (provisional snapshot): {"runTaskId":"42","attempt":1,"phase":"generating","text":"An initial explanation, revised"}
assistant: The complete retained answer ...
assistant preview cleared; retained history remains authoritative.
```

## Boundaries

- Recent history polls request `includeProgress:true`, normally every 500 ms. Pi already throttles persistence of provider partials. Fast answers, transitions and intermediate tokens can be missed. This is **not SSE or lossless token streaming**.
- The server scans only the last 128 current message blocks and keeps a **2,048 UTF-16-code-unit text tail**. `textClipped`, `blocksOmitted` and `nonTextOmitted` signal omissions when applicable. The projection fits within 16 KiB of JSON, including worst-case character escaping.
- Only assistant text is projected. Hidden reasoning, signatures, tool-call arguments, tool output/details, retry error strings, deferred handles and provider error/abort metadata are not forwarded. Error/aborted message bodies are suppressed in this view. This is a narrow projection, not general secret detection: ordinary model text can still contain sensitive or untrusted content.
- Previews have `version:1`, `chatId`, `provisional:true`, optional `runTaskId` and optional `generation:{attempt,phase,text,...omissionFlags}`. Phases are `generating`, `retrying` or `deferred`. A missing generation does **not** prove the chat is idle: it may be running tools or draining effects. Use activity/authoritative Pi work state for those questions.
- The standalone `progress` command accepts optional `chatId` (default main). `history` can attach the same projection with boolean `includeProgress`. These reads create no work or metadata. History, activity and progress are sampled separately, not atomically. If attaching a preview would overflow the frame, history omits that optional field rather than letting it block a fitting canonical page.
- Plain mode whitelists/bounds the display again, strips terminal controls, JSON-quotes newlines and prints one line per changed snapshot. Only the last bounded fingerprint is retained. A retry, replacement or clipped tail is not interpreted as an append. Identical observable snapshots may be coalesced, including across rounds whose boundaries fall between polls.
- Selection resets preview deduplication; stale responses are ignored. A transport outage is reported, not interpreted as completion. Reconnect reads current live state and catches up committed history independently. There is no replay cursor or durable terminal-delivery promise for previews.
- Final retained answers use the existing history path independently of previews; within its frame limits, assistant text renders in full. A single oversized canonical entry still fails explicitly rather than being skipped. Preview text may repeat there, be revised, or survive only as an interrupted/aborted canonical entry after recovery. **A preview is neither a final answer nor an admission/effect receipt.** No synthetic transcript entry is written for display.
- Recent polling waits for stdout to drain rather than queueing unlimited snapshots behind a blocked pipe. Detach cancels transport reads without sending Pi stop. If stdout is blocked, the client exits explicitly and may drop queued display bytes; it owns no execution, and save-before-send still protects requests interrupted during draft publication. History remains available after reconnect, subject to the existing bounded initial-tail/`/older` rules.

`task_activity` remains a bounded activity-only model tool; it does not acquire these partials. Owned children have their own live state: select the child (or query its `progress` API) to observe it; the parent's foreground subagent tool still returns only its bounded settled result. Native bash/file output remains **settlement-only**. Live shell output, tool partials, SSE, TUI rendering and arbitrary provider-specific block types remain future work.

## Validation

Automated tests use actual Pi/faux token streaming for partial/final separation, read-only/isolation behavior, tool-wait clearing and stop. SIGKILL during a visible partial verifies original-input recovery, retained interrupted text and a distinct new final answer. Projection/display tests cover bounds, hidden fields, retry attempts and malformed snapshots; IPC tests verify optional previews cannot block a fitting history frame. Subprocess clients cover terminal sanitization, deduplication through outage/reconnect, replacement/tail clipping, full final history, stale selection and both `/exit`/SIGINT under blocked stdout. The native HTTP and installed-package checks verify the optional history and standalone progress APIs; their mock replies may finish too quickly to show a partial.

These are automated faux/mock checks, not live provider validation. To check manually on a scratch store, attach `deck agent --no-tui` to an authenticated hub and request a longer answer if comfortable with the provider's charges. Look for labeled preview snapshots followed by the complete canonical answer. Detach/reconnect during generation, and separately try `/stop`; detach must not cancel the run, while stop may leave an interrupted partial rather than a successful answer. Never paste credentials into chat. Live OAuth remains separately unverified.
