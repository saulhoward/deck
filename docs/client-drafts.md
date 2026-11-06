# Durable client drafts

The plain client caches **unacknowledged requests**, not conversations, transcripts or an execution queue. Pi remains the only admission/scheduling authority. Both interactive input and `--message`, plus `/task TITLE` and `/instructions load`, save a complete private record **before** making their admission/task-creation HTTP request. Failure to save prevents sending, including on `/retry`.

## Recovery

Reconnect to the same store and select the original chat (`--task CHAT_ID` for a task). The oldest saved request for that chat becomes the active draft; no request is automatically sent. The client prints its kind, request ID and original chat.

- `/draft`: inspect a sanitized, bounded preview of the active request. Display clipping never changes saved content.
- `/retry`: resend the exact original request ID and arguments. Input retains its chat/text/steering mode; task creation retains its title and original host/cwd, not the hub's current defaults. Instruction import retains its original target chat and full saved host/cwd, not newly advertised defaults; the filename is fixed to `AGENTS.md`.
- `/discard`: forget the active draft locally. **It does not undo admission or cancel any work.**
- `/drafts`: list metadata for saved requests across chats in this hub, without printing their contents.
- `/recover REQUEST_ID`: activate another saved request for the selected chat. The previous active draft is saved first and remains recoverable; it is not deleted or submitted.
- `/discard REQUEST_ID`: explicitly forget another saved record in this hub, including an archived draft.

Switching chats or starting a new request is blocked while an active draft remains unresolved. Other archived drafts are not automatically activated after ACK/discard; use `/drafts` and `/recover`, or reconnect/select their original chat. This is local recovery selection, not a background replay scheduler. Multiple clients may share the cache and explicitly retry the same identity; Pi's durable deduplication handles this. They never overwrite conflicting payloads. Discard affects the shared local cache, so coordinate clients before discarding.

A valid positive submission/chat/task-ID acknowledgement removes the record. Import ACKs must additionally match the chat/request IDs and explicitly say `admitted:true,completion:"not_waited"`; they do not prove application. After ACK, import results remain in Pi, discoverable with `/instructions [TASK_ID]`, not in a second client completion cache. If acknowledgement parsing or local deletion fails, the original draft remains active for safe retry. It may already be admitted. Authentication/model/tool failures do not authorize a new request ID or automatic replay. `--message` refuses to replace an existing saved draft for the selected chat; recover/discard interactively first. Unlike the old one-shot failure message, errors do not automatically print the input text.

## Scope and storage

`status.hubId` is a random, session-scoped identity persisted in a Pi document. Existing stores acquire it on their next open; new clients require it, so restart an older serve process **when idle**. It survives port/default-workspace changes and is independent of chat binding. Distinct stores have distinct identities even if their main chat IDs match. This is a cache namespace, not authentication; copied stores retain the same identity and it does not distinguish divergent clones.

The default client root is:

- macOS: `~/Library/Application Support/deck/client`
- Linux: `$XDG_STATE_HOME/deck/client`, or `~/.local/state/deck/client`

`DECK_CLIENT_STATE_DIRECTORY` selects an alternate **absolute** client root, independently of the hub's `--directory`. Under it, `drafts/<SHA-256 of hubId>/<request UUID>.json` contains versioned plaintext request data. Treat it as sensitive. Directories are created with mode 0700; records are 0600, user-owned regular files. Insecure directories/files and final symlinks are rejected, not silently chmodded or ignored. Existing roots/draft subdirectories are checked before writing; this is not a defense against a malicious process with the same OS user capabilities.

A record is written to a private exclusive temporary file, fsynced, then atomically published using an exclusive hard link. Existing IDs are accepted only for an identical validated request; no replacement is permitted. This requires a filesystem supporting hard links. Temporary files are removed normally; a killed client may leave private `.tmp` files, which recovery ignores. They were never sent before publication/cleanup completed. If a final JSON also exists, it is the recovery record. Do not delete files while a live client is saving them.

Recovery bounds each record to 1 MiB and lists at most 1,000 records (metadata only is retained in memory). Corrupt/incompatible records fail closed with a diagnostic; preserve them for inspection rather than guessing or editing their request IDs. Client shutdown warns if an active draft is unresolved. An input that could not be saved is still memory-only and cannot be recovered after client death.

These are process-crash recovery guarantees, **not** a power-loss/exactly-once guarantee. A client death before publication cannot send the request but may lose that draft. ACK means durable Pi admission, not generation completion or successful effects. Instruction drafts contain no file text: administrative admission does not capture bytes before the first worker read, and the retained worker result fixes bytes once read. Draft persistence does not pin later model/settings/instruction-file choices; see [settings semantics](settings.md). Repair of an unadmitted reservation after observed settings drift can return `settings_changed`: keep the original draft until restoring the original choices, or explicitly discard it and start a new request. No transcript cursor is persisted: reconnect still starts with bounded recent history.

## Validation

Unit tests cover private publication, concurrent identical saves, conflict rejection, hub isolation, task binding round-trips and corrupt/insecure/symlink rejection. Subprocess tests kill clients after request receipt but before ACK, recover across port/binding changes without automatic resend, and verify identical input/task retry arguments. Additional cases cover malformed ACK retention, one-shot replacement refusal, discard without sending, and save failure preventing both initial send and retry. Adapter tests verify the Pi-owned hub identity survives store reopening; the installed-package smoke exercises successful draft publication and cleanup through the real bridge. Import-specific tests kill a client after real Pi application but before ACK, recover the same task across port/default changes without rereading, reject malformed receipt identities, retain cleanup failures, block sends on save failure and detach without stop. Read-only status/discard do not trigger another import.
