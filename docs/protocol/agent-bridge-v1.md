# Agent Bridge v1 — transport and handshake

## Transport

- One JSON-RPC 2.0 object per NDJSON line on stdout.
- Diagnostics only on stderr; stdout pollution is a protocol violation.
- Default request deadline: 30 seconds.
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
`a92b29e8fc9ad514ebe2e6c53216845aa059d94f`. The current bundle calls session
open/close, Memory recall, and opt-in Episode record. Other methods remain in
the protocol fixture because they are bridge capabilities, not because this
bundle exposes them as model tools. The previous transcript outbox was removed;
the bundle does not call wire `event.append` or `session.flush`.

DSH's `session/flush` hook is a different interface: the plugin waits for its
pending Episode capture through that native hook.

## Memory Episode generation extension (`1.2`)

The additive `memory.episode.record` method accepts only
`{session_id, turn, goal, response_text}`. It requires the same process-active,
repository-scoped session as recall. The opt-in bundle forwards the accepted
query and final assistant text from a successful DSH `turn/end` event.
Libra owns the compiler model, canonical history evidence, policy, admission,
and SQLite projections; callers cannot supply a Memory note or code revision.

Success returns `{schema_version: 1, data: {task_id, note_id, revision_oid}}`
after the generated Episode has been persisted. When capture is enabled, the
bundle adds the optional positive `turn` field to `memory.recall`; Libra freezes
the starting HEAD once for that turn (including compaction refreshes). Recording
requires this matching turn anchor and reads the terminal HEAD server-side.
Enable generation at bridge startup
with `LIBRA_DSH_MEMORY_MODEL`; model credentials resolve through Libra's normal
DeepSeek provider configuration. The bundle sets this variable when
`captureMemoryEpisodes` is enabled and allows 180 seconds for bridge requests.
Recording is not idempotent across manual retries; do not replay a completed
record request as an automatic transport retry.

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
