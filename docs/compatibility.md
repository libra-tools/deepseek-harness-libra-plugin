# Compatibility

The bundle is validated as one unit against the current Harness revision. There
is no separate "Memory module era" anymore — Memory recall, tools + approval,
workspace leases, context grounding, and the session-event outbox are composed
together and verified together.

| Surface | Current value | Evidence/state |
| --- | --- | --- |
| Libra Agent Bridge | protocol `1.2`, Libra `0.21.25` authority `a92b29e8fc9ad514ebe2e6c53216845aa059d94f` | `protocol/agent-bridge.v1.receipt.json` |
| Protocol source | `protocol.rs` SHA256 `60ed0117473332e701f57019501855a3a47126cb11a3ecf69541c8c2ace8ecab` | receipt; refresh before any authority change |
| Initialize golden frame | fixture SHA256 `b34ac2e5d9b17af4450508360c671845156a6808ebe491ec9a7036633065f753` | receipt |
| DeepSeek Harness | `0.2.2-rc.3` (`dsh-v0.2.2-rc.3`) | `engines.dsh: ^0.2.2-rc.3`; external CLI/runtime receipt `remote-pending` |
| Bundle | `@libra-tools/dsh-bundle@0.2.0` | local build; `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Real Libra/DSH gates remain `remote-pending`. |

Only bundle, bridge-client and protocol remain in the workspace. The current entry provides Memory recall and optional Episode capture. Earlier rc.7, tools, workspace, UI and outbox reports describe historical work; they are not supported-feature claims for this revision.

## Wiring against DSH `0.2.2-rc.3`

| Plugin surface | DSH `0.2.2-rc.3` contract | Bundle wiring |
| --- | --- | --- |
| Session feed | `session/created` / `session/disposed` / `session/event` / `session/flush`, `Session.eventAt`, `SessionSurface.replaceGeneration` | `packages/bundle/src/{index,outbox,workspace,context}.ts` |
| Agent loop hooks | `agent/pre-step` (`PreStepDecision`), `agent/request-error` (`RequestErrorAction`) | Memory recall + context grounding |
| Tools | `ctx.tools.register(defineTool(...))` with `presentCall`/`presentResult` | `packages/bundle/src/libra-tools.ts` |
| Approval | `ctx.approval.request(...)` → `'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` | write/restore gates in `libra-tools.ts` |
| Durable projections | host-only `ProjectionDefinition` (`init(header, inheritedEventCount)`, `register` still returns a callable disposer) / `stateOf(session, key)` | `libraMemory` unit in `packages/bundle/src/memory-projection.ts` (surface-scan fallback when the host omits the service) |
| Messages | `createUserMessage` with `MessageSourceMap` augmented on `@deepseek-ai/dsh-llm/message` (`libra-memory`, `libra-memory-clear`, `libra-context`) | `packages/bundle/src/{index,context}.ts` |

## Local verification

- `pnpm typecheck` — all 9 packages against the pinned DSH `0.2.2-rc.3` type surface.
- `pnpm lint` — eslint clean.
- `pnpm test` — 79+ tests across protocol, bridge-client, session, tools,
  workspace, context, ui, and bundle (memory / tools+approval / outbox /
  workspace lease / context grounding / projection fold / degraded activation).
- `pnpm build` — `tsc -b` + esbuild `dist/` bundle + protocol fixture copy.

Real Libra/DSH integration gates remain `remote-pending` until `LIBRA_BINARY`,
`LIBRA_REPO`, and a pinned `DSH_CLI` are provided; the fake bridge does not
substitute for them.
