# Changelog

## Unreleased — Cordis-native refactor (2026-09-07)

- Removed the unused session/outbox, tools, workspace, context and UI packages and their fake-host tests. They were not connected to the current bundle entry; no replacement tools or UI surface is claimed.
- Replaced handwritten DSH Host declarations with types built from the pinned `v0.1.2-alpha.1` checkout. Retained only plugin-owned Memory source augmentation.
- Split configuration, delivery validation and Memory lifecycle state behind the existing Cordis entry. A single disposer drains bridge work before close and leaves live DSH Sessions intact across reload.
- Added real Loader/Session/AgentLoop coverage for admission, cancellation, replacement/retry, capture flush, delayed unload, session reuse and mount isolation.
- Pinned the Bridge 1.2 authority receipt to Libra `a92b29e8fc9ad514ebe2e6c53216845aa059d94f`; corrected current setup, privacy and compatibility documentation.

Package version remains `0.1.0`; this entry does not announce npm publication. Earlier entries below are historical implementation records, not the current feature list.

## Historical — REL-TS-02 implementation slice (2026-08-24)

- added an optional Libra Memory recall module for accepted DSH turns, including
  compaction/retry refresh and receipt provenance;
- added a real DSH `v0.1.2-alpha.1` Loader/AgentLoop integration gate for the
  Memory module without changing the scope of the existing plugin modules;
- refreshed the Libra Agent Bridge v1 fixture and authority receipt for Libra `0.21.22`;
- hardened bridge environment, UTF-8 frame/result validation, handshake checks, and child crash handling;
- added durable outbox corruption/path/quota protection and server ack/per-event replay handling;
- aligned typed tools, mutation operation IDs, approval decisions, workspace owner/fence leases,
  context injection, compaction resume, UI card quotas, and bundle lifecycle disposal;
- replaced floating DSH integration resolution with explicit pinned `DSH_CLI`/revision gates and
  temporary staging;
- recorded local verification and the remaining real Libra/DSH gates as `remote-pending` in
  `docs/release-evidence-REL-TS-02.md`.

This is not a publish declaration. The package version remains `0.1.0` until the fixed external
contract and clean-profile release gates are complete.

## 0.1.0 — 2026-08-24

- Initial `@libra-tools/dsh-bundle` release for DeepSeek Harness `dsh-v0.1.0-rc.7`.
- Protocol receiver for Libra agent bridge v1.
- Bridge client, session projection/outbox, tools facade, workspace binding, context injection, and UI cards.
