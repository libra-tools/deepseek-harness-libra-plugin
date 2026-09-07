# DeepSeek Harness Libra Plugin

`@libra-tools/dsh-bundle` connects [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to Libra through `libra agent bridge --stdio` (JSON-RPC over NDJSON).

DSH owns the agent loop, Sessions, persistence, and approvals. Libra owns repository evidence, Memory generation, selection policy, and storage. The plugin contains the Cordis entry and bridge client; it does not open Libra's database or implement a second Harness runtime.

The current entry integrates Memory recall and optional Episode capture. The old tools, UI, workspace, context-adapter and event-outbox packages were not connected to this entry and have been removed. This is an unreleased refactor of the existing Libra integration bundle, not a new npm release.

## Supported development combination

| Component | Pin |
| --- | --- |
| DSH | `v0.1.2-alpha.1`, `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| Libra | `0.21.25`, `a92b29e8fc9ad514ebe2e6c53216845aa059d94f` |
| Bridge | `1.2`; recall requires `memory.recall`, capture also requires `memory.episode.record` |
| Node.js | `^22.19.0 || >=24.0.0` |

DSH supplies the Cordis, Schemastery, Agent, Session and LLM peers. They are not embedded in the bundle. Older rc.7 reports are historical, not compatibility claims for this source tree. See [compatibility](compatibility/harness-alpha1.md).

## Runtime behavior

- Before an admitted turn, use the downstream-accepted user query to request Libra Memory. Rejected or cancelled steps do not recall.
- Validate the delivery envelope and exact text hash, then attach the same identified message to DSH history and the model request, with receipt provenance.
- Refresh after a surface replacement or an overflow-recovery replacement. Empty or null delivery retires the previous visible snapshot without deleting durable history.
- With `captureMemoryEpisodes: true`, send the accepted query and final assistant text after a completed turn. Libra records canonical evidence and runs its Episode compiler and writer. The next recall and DSH's `session/flush` wait for capture settlement.
- Cordis owns subscriptions and one ordered cleanup: stop accepting work, drain pending bridge requests, then close the process. Plugin unload does not close live DSH Sessions. Actual Session disposal retires its bridge session, including before an ID is reused.

Capture is best-effort: a warning and settled flush do not prove an Episode was stored. It adds a compiler model request per successful turn, requires an existing repository code commit, and has no durable retry queue. Failed, aborted, blocked and truncated turns are skipped. Tool traces, later steering and historical replay are not captured. See [Memory capture and algorithm testing](docs/memory-episodes.md).

## Build and install a development tarball

The repository root and `packages/bundle` workspace manifest are not standalone install targets. Prepare an installed checkout of the exact DSH pin, then build the self-contained artifact:

```sh
pnpm install --frozen-lockfile
DSH_CHECKOUT=/absolute/path/to/pinned/deepseek-harness pnpm prepare:dsh
pnpm check
pnpm pack:bundle -- --destination /absolute/path/to/artifacts
dsh plugin --profile headless add /absolute/path/to/artifacts/libra-tools-dsh-bundle-0.1.0.tgz
```

Configure the inserted `libra` entry with deployment-owned paths:

```json
{
  "libraExecutable": "/absolute/path/to/libra",
  "repositoryRoot": "/absolute/path/to/libra-repository",
  "captureMemoryEpisodes": false,
  "memoryModel": "deepseek-chat"
}
```

`LIBRA_BINARY` and `LIBRA_REPO` are path fallbacks. The executable must be an executable file at an absolute path; no PATH lookup or model-supplied command is accepted. Initialize the target repository with Libra first. Opt-in capture uses `DEEPSEEK_API_KEY` or Libra's normal repository credential configuration. See [profile setup](docs/profile.md).

## Source layout

| Package | Responsibility |
| --- | --- |
| `packages/bundle` | `Config/inject/apply`, Memory hooks, per-mount state and cleanup |
| `packages/bridge-client` | Framed transport, handshake, deadlines and child process ownership |
| `packages/protocol` | Versioned receiver schema and allowed bridge method definitions |

The bundle entry injects the real `agents` and `sessions` services. Type checking uses declarations built from the pinned DSH checkout; `.dsh-types.json` and `.dsh-dev` are ignored development artifacts. The only DSH module augmentation adds plugin-owned Memory source variants. There is no hand-maintained Host interface shim.

## Verification

```sh
pnpm check
DSH_CHECKOUT=/absolute/path/to/pinned/deepseek-harness pnpm test:lifecycle
pnpm test:contract -- --protocol-version 1
LIBRA_BINARY=/absolute/path/to/libra LIBRA_REPO=/absolute/path/to/repository pnpm test:contract -- --libra-release a92b29e8fc9ad514ebe2e6c53216845aa059d94f
```

The lifecycle gate runs the built bundle through real Cordis, Loader, Session and AgentLoop, with controlled model and bridge peers for timing. Unit tests retain protocol and transport coverage without fake DSH interfaces.

`scripts/test-integration.mjs` separately packs the bundle, installs it into a fresh profile, checks composition, runs the installed artifact through Loader/AgentLoop, and verifies its persisted receipt. `scripts/test-memory-episodes.mjs` uses the real compiler model for generation → storage → remount → recall. Exact inputs and the distinction between deterministic and paid model checks are documented in [Memory testing](docs/memory-episodes.md).

## Security and protocol

All runtime access to Libra goes through the bridge. There is no current model-visible tools facade, workspace lease adapter, UI projection or transcript outbox. Recall sends the accepted query; opt-in capture also sends the final answer. Do not assume the removed outbox's redaction behavior applies to these inputs. Libra enforces its Memory policy and persists selection receipts.

The authority receipt pins Libra's actual protocol source and initialize fixture. The transport uses one JSON object per line, bounded UTF-8 frames, negotiated methods and deadlines. See [protocol](docs/protocol/agent-bridge-v1.md), [security](docs/security.md), and [privacy](docs/privacy.md).

MIT — see [LICENSE](LICENSE).
