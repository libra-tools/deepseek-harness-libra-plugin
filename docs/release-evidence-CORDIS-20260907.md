# Cordis-native refactor evidence — 2026-09-07

Implementation and validation are complete for review. This is not a commit, push or npm publication receipt. Pre-existing uncommitted Memory capture work was retained. No Libra Rust or PR changes were made for this refactor.

## Scope

- Removed the unused context, UI, tools, workspace and session/outbox packages, their project references and dependent fake-host tests. Retained protocol and real transport checks.
- Kept the general Libra–DSH bundle identity. Memory recall and optional Episode capture are its current connected capabilities.
- Replaced handwritten Host declarations and double casts with official DSH types. The sole module augmentation adds plugin-owned Memory source variants.
- Kept `Config/inject/apply` as the public interface; configuration, delivery validation, source types and per-mount state are internal modules.
- Cordis owns subscriptions and one ordered drain/close effect. Session disposal is separate from plugin unload; reused IDs wait for the old bridge close.
- Fixed a regression exposed by real load order: a recovery plugin registered before Libra could return retry without entering Libra's listener. Memory now wraps that waterfall with `prepend: true`.

## Authorities

| Item | Value |
| --- | --- |
| DSH | `v0.1.2-alpha.1`, `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| Libra | `a92b29e8fc9ad514ebe2e6c53216845aa059d94f`, `0.21.25`, Bridge `1.2` |
| Protocol source SHA-256 | `5a47f2dfdcf0d7ec6a0c1d97f9955cfff321a45323546f2f7a230d007bbf46dc` |
| Receiver fixture SHA-256 | `f65daf162ad73ce994e246928d7caf7db042f48fb9dd9449e41f88ef502ce28a` |
| Bundle | `@libra-tools/dsh-bundle@0.1.0`, development artifact |

Type preparation verifies the upstream SHA and tracked source cleanliness, builds the official Agent declaration closure, and generates ignored development lookup paths. Public manifests and the lockfile contain no machine-specific type paths. An independent artifact consumer passes the upstream compiler with `strict: true` and **`skipLibCheck: false`**, using `Config`, `apply`, real `Context` and the merged Memory source. Public declarations have no unpublished `@libra/*` imports.

## Completed Docker gates

All compilation and tests ran inside the fixed `libra-dev-anduin` container.

| Gate | Result |
| --- | --- |
| `CI=1 pnpm install --frozen-lockfile --offline` | Passed; four workspace projects including root |
| `pnpm check` with real `LIBRA_BINARY` / `LIBRA_REPO` | lint, source typecheck, 42 tests and build passed; no skips |
| Artifact declaration consumer | Passed with full library declaration checking |
| `DSH_CHECKOUT=… pnpm test:lifecycle` | 16 real Cordis/Loader/Session/AgentLoop cases passed |
| `scripts/test-memory-episodes.mjs` | Real compiler generation → storage → unload/remount → recall passed |
| `scripts/test-integration.mjs --live` | Tarball → fresh profile → composition → installed runtime → persisted receipt → real headless answer passed |

The 42 unit tests include eight receiver tests, eleven controlled transport tests, one real Libra handshake and 22 retained review-series utility tests. The latter are not DSH behavior evidence and are not packaged.

The sixteen DSH cases cover zero/null delivery retirement, existing Sessions, capture→flush/next recall, delayed open/recall/capture during unload, reload without closing Host Sessions, two Sessions/two Contexts, rejected/cancelled admission, downstream-accepted query and request-series preservation, pre-step replacement, recovery-before-Libra overflow replacement, hash rejection, observable capture failure, Session disposal/ID reuse and in-flight cancellation. Only model and bridge peers are controlled; no FakeContext or replacement Session is used.

## Real model and persistence result

The generation gate used a deterministic DSH answer and one real `deepseek-chat` Episode compiler request in a new repository, with no prebuilt Memory seed.

- Note: `0fbd5cfe-18bb-5644-b626-d3d67a5f4d9c`; revision: `85fffdeec96bacd4ab8e81f4f9dc18c25e60d564`.
- Summary: “The deployment result for dshcedarepisode was recorded as the color violet.”
- Structured note, revision index, live head and search projection existed; compile job was `idle`.
- Remount recall receipt: `01a07b86-75e2-7981-8eaf-77f463642f24`.
- Fresh-profile receipt: `01a07b87-797d-7bf0-8a47-2ecfd096bd74`, persisted hash `sha256:551ff2e852ac204c2d74774bcb5d09041a8aadecaf7741388c6ab577e4307939`, one selection, 1600-token budget.
- A separate real `deepseek-v4-flash` headless request returned exactly `violet` from that generated Memory.

The key was read only inside the container: not printed, downloaded, packaged or supplied to profile installation. No new Rust regression run is claimed; earlier Rust evidence remains separately dated.

## Installable artifact

`libra-tools-dsh-bundle-0.1.0.tgz`

SHA-256: `31a7c19621d12bdefb6d3134ae74f1abc99ac071efa72170cfeddb5fb67a00bf`.

```text
LICENSE
README.md
package.json
cordis.patch.yml
dist/index.js
dist/index.js.map
dist/index.d.ts
dist/config.d.ts
dist/memory-source.d.ts
dist/protocol/agent-bridge.v1.schema.json
dist/protocol/agent-bridge.v1.receipt.json
```

The manifest has no bundled npm dependencies. Cordis, Schemastery, Agent, LLM and Session are Host-provided peers. The source map contains only bundle, bridge-client and protocol inputs. Inventory and content scans found no review-series files, checked credential-token patterns, or machine/private workspace paths.

## Boundaries and handoff

Capture remains opt-in and best-effort: no durable retry queue, historical replay, tool traces or later-steering capture. Flush waits for settlement, not guaranteed generation. Warning visibility follows DSH's exporter levels. The server's current 30-second deadline is unchanged despite the longer client capture timeout. Retired Memory stays in immutable DSH history.

The original local source baseline and removed files remain recoverable; unrelated private work was not reset or deleted. User review is required before staging or committing. npm publication still requires explicit authorization.

Proposed commit: `refactor(dsh): use native Cordis lifecycle for Memory`. Scope is the retained capture wiring, adapter removal, official types, lifecycle implementation, focused tests and current documentation; unrelated private review-series materials must stay out of the staged change.
