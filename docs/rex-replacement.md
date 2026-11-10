# Rex open/reopen: best-effort local scope

**Scope decision:** race-free replacement and lost-reply recovery are no longer prerequisites for the local Rex workflow, at the user's request. Implement explicit, best-effort allocation/open/reopen using the existing Rex API. Concurrent opens, state changes between inspection and creation, and an explicit new attempt after a lost reply may leave duplicate or orphaned terminals; manual cleanup is acceptable.

This supersedes the earlier decision to block replacement pending native conditional/idempotent mutation support. It does not establish such support: neither the examined API 8 metadata nor the installed API 10 probe proves atomic inspect-and-create. [Public local open/reopen is now implemented](rex-open.md) under this reduced scope. The commands do not claim atomicity, automatic lost-reply recovery or GUI attachment.

## Installed evidence

The fresh validation run found that this machine's externally managed Rex had advanced to **API 10**, version `0.0.1793645657-gd018d2`. The unchanged API-8-only Deck adapter refused native allocation before issuing creation; the old opt-in suite consequently failed. This was an actual compatibility mismatch, not a timeout to widen or a test to skip.

A separate empty-config, credential-free Unix scratch server was used to inspect API 10 metadata. The relevant advertised inputs remain:

| Method | Advertised properties | Missing safety property |
| --- | --- | --- |
| `session.create` | `label`, `initial_windows` | Caller-selected identity/idempotency key |
| `session.new_window` | `session_id`, `window_label`, `layout`, `focus` | Expected revision/process state/idempotency key |
| `block.close` | `session_id`, `block_id`, `window_id`, `keep_last` | Expected process state/revision |

**Advertised schema closure is not runtime enforcement.** API 10's `session.create` advertises `additionalProperties:false`, but the scratch probe successfully creates a session with invented `expected_revision:-1` and `idempotency_key` fields. Repeating the identical request creates a second, distinct session. Both scratch sessions are explicitly destroyed. Never send invented guard fields and assume Rex enforced them.

The opt-in `runtime/src/rex-contract.test.ts` now records this negative proof. The initial spike's installed-package run passed **10/10**, including production allocation/startup, dropped-reply receipt reconciliation and exact-object inspection running → exited → missing terminal → missing session. The fresh Nix package/check and installed smoke also passed; no live provider, live hub or operator Rex session was used. API support is the explicit set **8 and 10**, not a minimum-version range: 9 and unknown/future versions still refuse. Fake-native tests cover API 10 and unsupported-version refusal. Historical API 8 evidence is retained; a new API 8 run is not fabricated when that binary is unavailable.

## Implemented local workflow

- Open an ownerless task's ordinary Deck client on its saved worker and explicit Rex server, pinned to the same hub/chat. Pi still owns conversations and execution; Rex owns terminals.
- Inspect the saved full IDs when available. Reuse a running client; for an observed exited/missing terminal, explicitly create another client in the existing session when possible. An observed missing session may be explicitly recreated. Inspection is a best-effort observation, not a lock.
- Surface unavailable, wrong-server and malformed responses as errors rather than silently redirecting or claiming absence. A lost creation reply is an unknown outcome, not proof that nothing was created.
- Allow the user to explicitly make a new terminal attempt after an unknown outcome, with a clear duplicate/manual-cleanup warning. Do not require reconciliation to resolve the previous attempt first. Do not automatically retry creation after a timeout or reconnect.
- Keep prior known bindings/results as historical evidence and save full IDs from successful new replies. A new attempt does not turn an earlier unknown outcome into a known failure. Do not adopt objects by label or destroy unknown/possibly running terminals as cleanup.
- Preserve the conversation, saved worker/cwd, history, input drafts and admitted input IDs. Opening a terminal sends no model input, starts no inference and does not stop Pi work. Owned-child input/lifetime restrictions remain unchanged.

The legacy internal allocator still enforces one attempt per chat, including after uncertainty. The public `rex_open` path explicitly admits additional terminal attempts after settlement, without replaying the old accepted native operation or rewriting its receipt. Existing receipt-based repair can remain useful, but is optional—not a public reopen prerequisite. A new crash-recoverable Rex draft/reconciliation workflow is not required for this local slice; existing chat/input/import drafts remain unchanged.

## Removed gates and retained checks

**Out of scope for this local workflow:** native CAS/revision guards, exactly-once terminal creation, coordination with concurrent native actors, automatic lost-reply recovery, and exhaustive Rex replacement race/SIGKILL matrices. Duplicates and manual cleanup are accepted limitations, not passing safety guarantees. Existing tests and retained-receipt behavior need not be deleted.

**Still in scope:** generated/validated command contracts, explicit worker/server/hub/chat identity, bounded argv execution without credential forwarding, honest errors, ordinary open/reuse/exited/missing cases, preserved canonical history and no input replay. Use isolated Rex servers for tests. This descope is limited to Rex terminal management; it does not weaken file/bash effect uncertainty, model-input deduplication, worker identity or general transport contracts. Responsive-client health, GUI attachment, remote support and daemon restoration remain separate work.
