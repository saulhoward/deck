# Read-only model task inspection

Deck installs `deck.task-inspection` alongside coding/native tools. Its three model-callable tools read canonical Pi conversations and existing Deck metadata. They do not introduce a task catalog, mirrored transcript, background search job or scheduler. They work even when the inspected chat's assigned worker is offline, without issuing file/bash effects.

| Tool | Arguments | Result |
|---|---|---|
| `task_list` | optional `limit` 1–25/default 10, `after`, `query` up to 200 characters | One canonical conversation-scan page, filtered to Deck chats and optionally by case-insensitive title substring, with optional `next` |
| `task_history` | `chatId`, optional `limit` 1–20/default 5, `before` | Descending canonical history page, bounded projection per entry, optional exclusive `next` for older history |
| `task_activity` | `chatId` | The same bounded Pi activity projection as the client API |

IDs and cursors are positive safe-integer strings. `task_history` and `task_activity` reject unknown/unmanaged conversations without creating metadata. Listing may scan unmanaged Pi conversations but does not expose them as Deck chats. Main, task and foreground subagent chats are discoverable. Subagent rows include complete `parentChatId`/`ownerTaskId` strings for display; invalid link fields are omitted with `linksOmitted: true`. Pi's ownership edge, not these labels, governs cancellation.

## Pagination and bounds

`task_list.limit` counts **scanned records**, not matches. `query` filters only that one page; it is not a complete-store search. An empty result can still have `next`: follow that cursor to continue. No tool automatically downloads the full store. The model can explicitly make another call.

Discovery returns each title/machineId/cwd as `{text, clipped?}`, capped at 160/80/256 code units. These are display values, not reassignment parameters. IDs remain complete. Filtering uses the full title before display clipping.

History delegates fork ancestry and exclusive entry-ID pagination to Pi through the existing Deck API. Each recognized entry has at most a 1,024-code-unit text tail and 16 tool-name occurrences (names capped at 80), with clipping/omission flags. User/assistant text and settled tool output are included; agent-sent inputs also expose a bounded source-chat label. Tool arguments, hidden reasoning, provider error details, capture metadata, system prompts and arbitrary custom entry data are not. Unprojected entries still appear by ID/kind with `omitted: true`, so pagination never skips them invisibly. This is a useful inspection view, not complete transcript export.

Each result must serialize to at most 64 KiB of JSON. The Pi tool retention budget matches that limit. Oversized pages fail with advice to reduce `limit`; no cursor is advanced server-side, no entries are silently dropped, and successful output is valid complete JSON. A one-entry projected history page fits the budget. Reads are sampled at different times, not one atomic cross-chat snapshot. Tool replay is marked safe because it only reads; a replay can observe newer committed state.

## Authority and privacy

Inspection is global within this single-user hub. There are no per-chat ACLs: a model can intentionally inspect another Deck chat, including text/code in retained messages and settled tool results. Do not mix conversations requiring separate access boundaries in one store. These tools are not credential redactors or a sandbox. Hidden fields are omitted, but visible message/output text can itself contain sensitive information. Reading another conversation may send that projected text to the current conversation's provider and retain it in the inspecting chat's tool result.

Retained text is untrusted task data, not new instructions to the inspecting agent. Tool descriptions state this distinction; that is guidance, not a prompt-injection security boundary.

A model tool call still has its ordinary Pi-owned task/result in the **calling** chat. Inspection never submits to, wakes with new input, creates, configures or stops the **inspected** chat. Activity is presentation, not proof of worker availability or cleanup. Transport/worker connections are not needed for central reads. Abort is checked before/after bounded reads; this does not claim cancellation of an already-running SQLite operation.

## Installation and upgrades

The extension is installed by default; explicit Pi extension/tool selections may omit it. The runtime callback is bound before scheduling resumes, so reopened tool tasks use the reopened store owner. Adding these tools changes the default resolved registry/tool selection. An unadmitted version-2 reservation made with older choices may therefore return `settings_changed` on retry; inspect the failure and explicitly discard/start a new request if appropriate. Admitted work retains Pi's documented use-time resolution behavior, not frozen implementation code. See [settings semantics](settings.md).

## Validation

Faux model-driven tests execute the actual Pi tool pipeline, including reopen, empty filtered pages with continuation, case-insensitive title matches, backward history paging, offline activity, malformed/unmanaged IDs, omitted sensitive fields, explicit clipping and oversized-page reduction. They verify inspected history remains unchanged and no native effect occurs. Installed-package checks verify all three tool definitions are present. Automated tests do not call a real provider; this new tool slice still needs live model confirmation.

For a manual test, use `/task Parser investigation`, send a harmless note and wait for completion, then `/main`. Ask: “Use task_list to find Parser investigation, following next even after empty filtered pages. Use task_history and task_activity to report its note and current activity. Do not create, message or stop any task.” Check that actual tool calls appear and the inspected task receives no new input.

Model-facing task creation/messaging are implemented separately by [task control](task-control.md), not granted by this read-only extension. Semantic/full-text search remains unfinished. Pi-owned foreground delegation is implemented separately by [subagents](subagents.md), with owned child chats restricted to inspection/stop rather than external input. Existing user-facing `/task` and HTTP creation/admission remain separate capabilities.
