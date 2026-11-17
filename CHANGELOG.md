# Changelog

## 0.2.0 — DSH 0.2.2-rc.3 settings and bridge fixes

- Restores the tool, workspace, context, and outbox surfaces on the DSH `0.2.2-rc.3` line, and keeps optional Episode capture (`captureMemoryEpisodes`, `memoryModel`) from the Bridge 1.2 memory work.

- Package version moves off the published `0.1.0` artifact. `engines.dsh` stays `^0.2.2-rc.3`, which accepts that rc and later `0.2.x` builds.
- `connect()` reuses a negotiated handshake. A new binary or repository closes the child before the next `initialize`.
- Configuration fields are optional, defaulted, and volatile. A missing or unusable binary leaves the plugin inactive. Relative paths and `PATH` names resolve to an absolute executable.
- Tool parameters use integers, booleans, and string arrays where the bridge facade requires them. `libra_diff` renders a diff card and `libra_history_search` renders a search card.
- Memory token budget is sent to `memory.recall`. The plugin no longer truncates a hashed prompt section locally.
- Plugins-page configuration, English and Chinese display text, and an icon.

## Unreleased — DSH 0.2.2-rc.3 compatibility

- Declared `engines.dsh: ^0.2.2-rc.3` and Node `>=24.9.0` so the DSH 0.2.2
  version gate accepts the bundle. Raised optional peers and devDependencies
  to `0.2.2-rc.3` (`cordis` `4.1.0`, `schemastery` `3.19.0`). Dropped
  `dsh-code-runtime` and `dsh-invariants`, which are not published on this line.
- Moved `MessageSourceMap` augmentation onto `@deepseek-ai/dsh-llm/message`.
- Replaced the removed `SessionProjectionStateMap` with a host-only
  `ProjectionDefinition` whose `init` takes `(header, inheritedEventCount)`.
- Tool `presentResult` now reads the model-facing `{ content, isError }`
  result instead of the bridge payload.

## Unreleased — DSH 0.1.5-rc.2 compatibility pass (P0–P3)

- **P0 — Memory module API fix.** Migrated the bundle from hand-written DSH
  shims to the real `0.1.5-rc.2` type surface: `Session.eventAt` /
  `SessionSurface.replaceGeneration`, `surfaceOp: {op: 'replace', startSeq,
  endSeq}`, `PreStepDecision` / `RequestErrorAction`, `createUserMessage` with
  the merge-extensible `MessageSourceMap`. Pinned cordis `^4.0.2` and the DSH
  runtime subpackages to `0.1.5-rc.2` (dev + optional peers); removed the old
  `dsh-contract.d.ts` shims; rebuilt `dist/`.
- **P1 — tools, approval, outbox.** Registered the allowlisted catalog as
  first-party DSH tools (`ctx.tools.register(defineTool(...))`) with a filtered
  model surface (bridge internals and test hooks never exposed), agent-session
  identity binding, generated per-call `operation_id`, and write/restore
  approval routed through `ctx.approval` (denied calls fail before the bridge).
  Wired the session-event outbox: `session/event` → capture,
  `session/flush` → drain, `session/disposed` → dispose, all contained with
  logged warnings so the DSH event pipeline never rejects.
- **P2 — workspace, context, UI.** Bound workspace leases to the session
  lifecycle (claim on `session/created` with parent linking, renewal at half
  the TTL, release on `session/disposed`); injected one bounded, redacted
  `libra_context` grounding snapshot on the first turn; added
  `presentCall`/`presentResult` card presenters (risk → card kind) to every
  registered tool.
- **P3 — durability, configurability, degraded activation, docs.** Tracked
  visible Memory deliveries through a `ctx.sessionProjections` unit
  (`libraMemory`, zod-validated, survives compaction) with a surface-scan
  fallback; made `libraExecutable`/`repositoryRoot` optional with inert
  degraded activation (no hard throw in `apply`); added `outboxRoot`,
  `injectContext`, `workspaceLeaseTtlMs`, and `memoryTokenBudget` config;
  aligned README/`docs/compatibility.md`/CHANGELOG to `0.1.5-rc.2` and the
  protocol `1.1` / Libra `0.21.25` fixture (receipt hash verified).

Full local gate: `pnpm typecheck`, `pnpm lint`, `pnpm test` (79 tests), and
`pnpm build` (esbuild `dist/` bundle) all green. Real Libra/DSH integration
gates remain `remote-pending` (require `LIBRA_BINARY`, `LIBRA_REPO`, pinned
`DSH_CLI`).

## Unreleased — REL-TS-02 implementation slice (2026-08-24)

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
