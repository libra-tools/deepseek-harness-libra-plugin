# Security defaults

Harness owns approval policy and session lifecycle. Libra owns repository access and storage policy. The plugin enforces the client-side boundaries between them.

## Bridge and configuration

- The plugin spawns only the configured executable with fixed `agent bridge --stdio` arguments and a constrained child environment. It does not read Libra storage directly.
- Configuration is deployment-owned; the model cannot override executable or repository paths.

## Connected capability: Memory

- Recall requests contain the accepted query and session ID and may include a token budget and turn. Capture requests contain the accepted query, final assistant answer, session ID and turn. Requests cannot select a repository path or supply a principal.
- The new bridge obtains repository identity from the local repository and requires repository-local `bridge.conversationMemory=true` for reads and writes. A session ID is an idempotency key, not an authenticated identity; the local stdio process and its OS user are part of the trust boundary.
- The plugin validates the returned envelope and exact text hash. The new local conversation store does not call a model provider or persist a selection receipt. For compatibility with older bridges, the plugin forwards `DEEPSEEK_API_KEY` in the bridge process environment when capture is enabled; older bridges can have different generation and retention semantics.
- Memory inputs are free text. Known secret-pattern scrubbing is best-effort and cannot guarantee removal of all secrets or PII. Avoid sensitive text in captured turns.
- A delivered memory snapshot is untrusted historical material, not an instruction source. Text escaping and selection reduce prompt-injection risk but do not guarantee that a model will ignore embedded instructions.
- Libra tools are registered for read and write operations. Workspace leases and tool cards are part of the bundle. Write and restore tools are gated by DSH approval.
- The bundle also keeps a session-event outbox. It is separate from conversation Memory and applies pattern-based redaction before queuing events.
- Repository-hash queue namespaces prevent routing an event to a different repository. Generation directories have exclusive owner metadata; recovery uses a local per-session SQLite lock before claiming an exited owner's queue. Live or unknown ownership, residual claims and ambiguous ordering are never overwritten or guessed.
- Outbox recovery requires a local filesystem with correct SQLite advisory locking and no other host accessing the same queue directory. Network filesystems, NFS/SMB shares, different PID namespaces and incompatible SQLite VFS configurations are unsupported for automatic recovery; preserve and inspect the queues offline instead. Never delete `.session-locks` while a process may be running.
- Process-level crash durability is not power-loss durability: snapshot replacement does not promise `fsync` of every file and directory entry. Episode capture is a separate best-effort operation and does not share the event outbox's retry mechanism.
