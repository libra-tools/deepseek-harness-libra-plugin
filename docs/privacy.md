# Privacy and data flow

The plugin exchanges data with Libra through the local bridge and does not access Libra storage directly. Its session-event outbox can contain conversation content. Memory recall and optional Episode capture are separate from this outbox and require a bridge that advertises the relevant methods.

## Recall

When a compatible bridge supports Memory, the plugin sends the accepted user query and DSH session ID to the local Libra bridge. For the new conversation-memory implementation, the repository-local `bridge.conversationMemory` setting must be explicitly enabled; matching redacted records can be returned across sessions in that repository. Session IDs are not authentication. Returned text is untrusted historical material, and framing cannot guarantee that a model will ignore instructions in it.

## Optional capture

When both `captureMemoryEpisodes` in the plugin and the repository-local `bridge.conversationMemory` setting are enabled, the plugin sends the accepted query, final assistant text, session ID and turn number after a successful turn. The new implementation stores a bounded, redacted record locally; it does not invoke a model provider or generate a note. An older compatible bridge may have different generation and retention semantics; consult that bridge's documentation. Tool traces, reasoning blocks and later steering are not included in the Episode request.

## Retention and redaction

The plugin maintains repository-scoped generation queues and local per-session SQLite coordination locks under `$DSH_HOME/libra/outbox`, and forwards event payloads to Libra after applying pattern-based checks. These checks do not reliably detect every secret or sensitive value, and event payloads can contain conversation text. Undelivered events can survive restart and be replayed when a live session supplies an unambiguous sequence and an abandoned generation can be claimed; an abandoned directory alone is not enough to trigger replay. A legacy queue, a live or unknown owner, a residual claim, or an ambiguous generation order is preserved and warned about instead of guessed. A residual claim requires offline inspection after all contenders are stopped. Disabling the plugin does not erase its queues.

The new conversation-memory store is a separate private database under the repository's `.libra/conversation-memory` directory. Its secret-pattern redaction is best-effort and does not guarantee removal of all secrets, personal information or sensitive text. Logical deletion cannot guarantee physical erasure from SQLite pages, journals, filesystem snapshots or backups; the bridge does not currently expose a deletion operation. Disabling capture does not delete already stored data.

Memory snapshots and receipt metadata become part of DSH's immutable history. Retiring a snapshot changes the model-visible surface, not the stored history. Capture has no durable retry queue or automatic replay on remount; a settled DSH flush means capture finished or failed observably, not necessarily that a record exists.
