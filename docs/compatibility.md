# Compatibility

The bundle composes Memory recall, tools and approval, workspace leases,
context grounding and the session-event outbox. Memory support depends on the
methods advertised by the actual Libra binary and must be verified separately
from the DSH compatibility gate.

| Surface | Current value | Evidence/state |
| --- | --- | --- |
| Libra Agent Bridge | protocol `1.2`, Libra `0.21.25` authority `a92b29e8fc9ad514ebe2e6c53216845aa059d94f` | `protocol/agent-bridge.v1.receipt.json` |
| Protocol source | `protocol.rs` SHA256 `5a47f2dfdcf0d7ec6a0c1d97f9955cfff321a45323546f2f7a230d007bbf46dc` | historical receipt; not a receipt for the new local implementation |
| Initialize golden frame | fixture SHA256 `b34ac2e5d9b17af4450508360c671845156a6808ebe491ec9a7036633065f753` | receipt |
| DeepSeek Harness | `0.2.2-rc.3` (`dsh-v0.2.2-rc.3`) | `engines.dsh: ^0.2.2-rc.3`; isolated installed-runtime offline Memory test passed |
| Bundle | `@libra-tools/dsh-bundle@0.2.0` | local build; 120 tests passed, 5 skipped; typecheck, lint and build passed |

The workspace also contains context, session, tools, UI and workspace packages. The new local Memory implementation is a separate development change and has not yet received a signed compatibility receipt. A negotiated Memory capability does not establish that Episode capture is enabled.

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
- `pnpm test` — protocol, bridge-client, session, tools, workspace, context,
  UI, and bundle tests, including Memory, outbox generation recovery and
  shutdown containment. Consult the current test output for the exact count.
- `pnpm build` — `tsc -b` + esbuild `dist/` bundle + protocol fixture copy.

Real integration uses an explicitly supplied `LIBRA_BINARY` and isolated
repositories. `tests/dsh-alpha1/installed-memory-offline.mjs` loads the installed
DSH `0.2.2-rc.3` runtime with an offline adapter; it is not a claim that the
historical alpha lifecycle suite supports this revision. The fake bridge does
not substitute for the real-binary gates.
