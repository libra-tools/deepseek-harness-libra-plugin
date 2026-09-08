# Security defaults

Harness owns approval policy and session lifecycle. Libra owns repository access and storage policy. The plugin enforces the client-side boundaries between them.

## Bridge and configuration

- The plugin spawns only the configured executable with fixed `agent bridge --stdio` arguments and a constrained child environment. It does not read Libra storage directly.
- Configuration is deployment-owned; the model cannot override executable or repository paths.

## Connected capability: Memory

- Requests contain session identity and accepted query text, plus the turn number for opt-in capture. They cannot supply a principal, ACL, selector, budget or code revision.
- Libra derives repository scope and principal, applies Memory policy, and persists a selection receipt before returning a delivery. The plugin validates the returned envelope and exact text hash.
- Capture forwards the accepted query and final assistant answer to Libra. Provider credentials are forwarded only when capture is enabled, and are not included in bridge request bodies. Generation can incur provider costs.
- Failed recalls fail the step. Capture failures produce a stable-code warning without undoing the completed DSH turn. Error logs are not evidence of successful generation.
- DSH keeps ownership of approvals and Sessions. This bundle currently exposes no write tools, workspace lease API or UI actions.

The deleted transcript outbox's secret scanning and redaction guarantees do not apply to Memory inputs. See [privacy](privacy.md).
