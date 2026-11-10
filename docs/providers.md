# Prototype providers and login

Inference and credentials stay in the hub's TS runtime. A local Zig worker now supplies bounded UTF-8 `read`, `write` and exact `edit`; [bash](shell-tools.md) now runs in owned process groups with bounded output and cancellation. Remote workers are still unavailable. See [local tool capabilities, trust and smoke testing](local-tools.md).

## ChatGPT (default)

From the repository after building Zig and TypeScript:

```sh
./zig-out/bin/deck init
./zig-out/bin/deck serve
# Another terminal:
./zig-out/bin/deck login
./zig-out/bin/deck agent --no-tui
```

`deck login` connects to the running loopback hub (use matching `--port N` overrides), validates startup status and pins that hub before sending login commands or answers. The hub drives Pi's OpenAI **Sign in with ChatGPT** OAuth flow; the CLI displays the authorization URL and bridges any select/manual-code prompts. Open the URL yourself. The callback server runs on the hub at 127.0.0.1:1455; Deck forces the callback bind to loopback, regardless of an inherited `PI_OAUTH_CALLBACK_HOST`. Follow Pi's prompt if the browser callback needs manual forwarding. Ctrl+C cancels the selected login, not conversations. An abandoned flow expires after ten minutes; its status can also be observed/cancelled through private commands.

The stable initialized machine ID is formatted as a UUID for Pi's OpenAI agent-host identity. Login state, URLs and prompts are transient memory, not Pi transcript entries. Only the hub writes provider credentials. Login is not available on a mock or explicit API-key hub. Live ChatGPT authorization/account eligibility and refresh against OpenAI have **not** been exercised here. The user reports the live API-key smoke suite passed: conversation, native write/read/edit, bash, foreground sleep cancellation, detach/reconnect while work continues, and recovery/retry of an unsent draft across client exit and hub restart. This is user-reported manual validation, not CI or live OAuth/refresh coverage. Automated tests use fake providers and never call external services.

## Explicit paid API-key access

```sh
# Supply OPENAI_API_KEY securely in the hub environment, not as a CLI argument.
./zig-out/bin/deck serve --api-key --model gpt-4o-mini
```

`--api-key` is an explicit billing opt-in. Default ChatGPT mode ignores ambient API keys and requires an OAuth credential. Explicit API-key mode refuses stored OAuth. Wrong-type stored credentials fail closed on every provider read/refresh, including Pi's restart path, not just new admissions. A refresh failure preserves the stored credential and never falls back to a paid key. Credential types are not silently replaced: use the appropriate mode/state directory; manual credential import/migration is unsupported.

## Models and persisted choices

`--model ID` selects a concrete model from the pinned OpenAI chat catalog when main is **first created**. The initial default is `openai/gpt-6-sol` from Pi 1.4.0's catalog; catalog membership does not guarantee account access. Resumed conversations retain their saved model, even when a different startup default is supplied; `/status` shows the saved selection. New tasks inherit main's model/reasoning. Model/settings mutation is not yet exposed over HTTP.

Before scheduling resumes, Deck verifies saved conversations' model/provider IDs exist in the selected runtime. It rejects, rather than silently converting, a mock store opened in real mode or vice versa. Use separate `--directory` state roots for mock demos and real conversations. No legacy `openai-codex` provider is registered.

Unconfigured new input returns `auth_required` before admission, so clients retain drafts instead of claiming success. A retry of an already-admitted request still retrieves its original receipt even if auth subsequently becomes unavailable. The admission is not a promise that inference will succeed: revoked/expired grants or unavailable models surface as Pi generation errors, which the plain client displays. Provider partial streaming is not yet exposed by the polling client.

## Credentials and exclusion

The hub stores `auth.json` in its private state directory. Its credential store:

- checks private file permissions and rejects malformed/oversized records;
- serializes reads, writes and refresh callbacks within the single writer;
- writes a fresh 0600 temporary file, syncs, then atomically renames;
- relies on Zig's inherited writer lock for exclusion across processes;
- lists only non-secret provider/type metadata and preserves the previous file if a refresh callback fails.

It must **not** be used from a second process without that writer lock. Do not put tokens in config, prompts, logs, Nix expressions or source control. The credentials are private plaintext, not OS-keychain encryption. Existing state/transcripts also require private backups and appropriate access control.

## Private login commands

All use the existing v1 command envelope. These are local-only experimental interfaces, not a remote/public auth service.

- `login_start {requestId}` starts a ChatGPT interaction; retries reuse the same transient ID. Another pending login returns conflict.
- `login_status {}` returns interaction ID/status, up to 16 provider notifications and the current non-secret prompt descriptor.
- `login_reply {loginId,promptId,answer}` answers only that still-active prompt. Wrong/stale identity rejects.
- `login_cancel {loginId}` cancels only that interaction.

These commands now have generated, bounded, closed replies and identity/state checks at every transport boundary; see [status/login contracts](status-login-contracts.md). Provider interaction fields are whitelisted, malformed replies cannot claim sign-in success, and lost/malformed answer ACKs never automatically resend the answer. Public notifications escape terminal controls and keep only bounded display deduplication state. A cancel ACK is not logout or proof credentials were not saved by a concurrent callback.

Interaction status is volatile across hub restarts; committed credentials survive. No tokens or entered answers are included in status responses. Secret-entry prompts are unsupported by the plain CLI rather than echoed as passwords. Authentication remains subject to the loopback trust boundary; remote transport is not enabled.
