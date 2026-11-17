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

The receiver fixture records Bridge `1.2` from Libra
`a92b29e8fc9ad514ebe2e6c53216845aa059d94f`. The current bundle registers
Libra tools and uses the bridge for session lifecycle, context and workspace
leases. It also projects DSH session events through a local outbox, using wire
`event.append` and `session.flush`. Memory recall and opt-in Episode capture
are mounted only when the negotiated peer advertises the required methods.

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
