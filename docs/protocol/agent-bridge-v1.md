# Agent Bridge v1 — transport and handshake

## Transport

- One JSON-RPC 2.0 object per NDJSON line on stdout.
- Diagnostics only on stderr; stdout pollution is a protocol violation.
- Default server inactivity window: 60 seconds; useful progress renews it.
- Frame cap: 256 KiB per line; result and event limits are also checked as UTF-8 bytes.

## Handshake (`initialize`)

The client sends:

```json
{"jsonrpc":"2.0","method":"initialize","params":{"protocol":{"major":1,"minor":0}},"id":1}
```

The bridge returns capability negotiation: `protocol`, `limits`, `methods`, `source`.
Protocol major mismatch is fail-closed before any other method is accepted.

## Request terminal states

Each in-flight request ends in exactly one terminal state:

| State | Meaning |
| --- | --- |
| `success` | JSON-RPC result returned |
| `error_retryable` | JSON-RPC error with `data.retryable: true` |
| `error_fatal` | JSON-RPC error without retryability |

The `initialize` handshake request is recorded with the same terminal-state model as
subsequent bridge methods.

## Client constraints

The TypeScript client only spawns a configured `libra` executable with argv
`agent bridge --stdio`. Model-provided executables or argv are rejected at
configuration normalization.

## Current entry and protocol authority

The receiver fixture and receipt claim Bridge `1.2` provenance from Libra
`ff895071882e05c4bdfe4a227976bc3ad77ac0d4` (`libra 0.30.217`), the revision
that enabled the typed repository reads. The receipt pins the SHA-256 of that
revision's `src/internal/ai/agent_bridge/protocol.rs` and of this fixture, so
a changed contract is detected rather than trusted. The current bundle
registers Libra tools and uses the bridge for session lifecycle, context and
workspace leases. It also projects DSH session events through a local outbox,
using wire `event.append` and `session.flush`. Memory recall and opt-in
Episode capture are mounted only when the negotiated peer advertises the
required methods; the current authority revision does not advertise them, so
the fixture no longer lists them either.

DSH's `session/flush` hook is a separate, parallel durability checkpoint: the
plugin waits for pending capture and outbox work through that native hook.

## Conversation Episode record extension (`1.2`)

The new local conversation-memory implementation accepts
`memory.episode.record` parameters `{session_id, turn, goal, response_text}`.
The opt-in bundle forwards the accepted query and final assistant text from a
successful DSH `turn/end` event. The repository-local setting
`bridge.conversationMemory=true` must also be enabled. The new implementation
stores bounded, redacted text locally; it does not call a model provider or
generate a Memory note or revision.

Success returns `{schema_version: 1, data: {recorded, content_hash, turn}}`.
Repeated records with the same session and turn are idempotent when their
redacted contents match; a conflicting replay is rejected. The older Bridge
1.2 development fixture describes a different compiler-backed implementation;
its generated notes and receipts are not claims about this implementation.

The client bounds its initial handshake but imposes no total-duration cap on
subsequent requests. The server's request deadline, child exit and explicit
close still apply. A completed DSH flush indicates capture settled; it does not
by itself guarantee that the record was stored.

## Memory recall extension (`1.1`)

Protocol minor `1.1` adds `memory.recall` without changing the existing v1
methods. The plugin discovers the method through the `initialize.methods` list.

```json
{
  "jsonrpc": "2.0",
  "method": "memory.recall",
  "params": {
    "session_id": "dsh-session-id",
    "query_text": "accepted user query"
  },
  "id": 2
}
```

The result contains an optional delivery with `prompt_section`, `receipt_id`,
`view_hash`, `bundle_hash`, `selected_count`, and `token_budget`. This method is
used only by the Memory module; `context.get` retains its existing meaning.

## VCS read extension (LVC-02)

`vcs.identity`, `vcs.status`, `vcs.diff`, `vcs.log`, and `vcs.show` are
additive protocol minor 1 methods. They are negotiated per connection: a peer
that negotiated minor 1 or higher sees them in `initialize.methods` and may
call them, and a peer that negotiated an older minor neither sees nor may
call them — the bridge refuses such a call before dispatch, and the existing
behaviour of the original v1 methods is unchanged.

The reads are bounded and repository-scoped. `vcs.identity` returns stable
repository identity and HEAD fields without an absolute path; `vcs.status`
returns paginated staged, unstaged, untracked, conflict and rename states;
`vcs.diff` uses validated repository-relative paths and reports truncation;
`vcs.log` and `vcs.show` return paginated history and commit detail. Values
come from Libra core services, never direct SQL, shell text parsing or an
external `git` process, and errors that could carry host paths withhold the
underlying detail. `status.get` remains bridge session/event/checkpoint
telemetry, not worktree status.

## VCS write extension (LVC-06)

**Do not use the experimental `vcs.stage`, `vcs.unstage`, and `vcs.commit` methods.** They are not in the bridge allowlist and are not advertised by any released binary; the LVC-06 card that would enable them has not landed. The implementation behind them was corrected during LVC-02 — literal paths, a content-aware fence, an operation-specific publication record and a durable recovery answer — but an advertised method does not establish that it is safe or released, and the fixture deliberately omits them. `commit.create` retains its existing contract. See the LVC-02 / LVC-06 implementation review in the version-control plan.
