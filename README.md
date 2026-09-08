# DeepSeek Harness Libra Plugin

`@libra-tools/dsh-bundle` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profile plugin that connects Harness sessions to [Libra](https://github.com/libra-tools/libra) through a typed JSON-RPC NDJSON bridge (`libra agent bridge --stdio`).

Harness owns the agent loop, session persistence, and approval policy. Libra owns repository state, durable evidence, and storage policy. This plugin is the TypeScript client and Cordis bundle between them—it does not read Libra's database or implement a second Harness runtime.

**Package:** `@libra-tools/dsh-bundle` · **Harness pin:** `v0.1.2-alpha.1` · **Libra bridge:** `1.2`

## What it does

When loaded into a Harness profile, the bundle:

1. Registers the Cordis entry `libra` using Harness's native agent and session services.
2. Starts the configured `libra agent bridge --stdio` process with fixed arguments.
3. Negotiates the bridge protocol and routes requests through typed, allowlisted methods.
4. Connects supported Libra capabilities to the Harness lifecycle, preserving session identity and receipt provenance.
5. Drains pending requests and closes the bridge when the plugin is unloaded, without closing live Harness sessions.

### Current capabilities

Memory recall and optional Episode capture are the capabilities connected in this revision. Recall supplies a validated, receipt-backed prompt section for an accepted turn; opt-in capture sends the accepted query and final answer to Libra for generation and storage.

Capture is best-effort and can incur a compiler model request per successful turn. It requires an existing repository code commit and has no durable retry queue. See [Memory integration](docs/memory-episodes.md) for behavior, data flow, and testing.

The bundle does not currently expose model-visible tools, workspace leases, UI cards, or a transcript outbox. The earlier unmounted adapters have been removed; historical reports are not current feature claims.

## Requirements

| Component | Pin |
| --- | --- |
| DSH | `v0.1.2-alpha.1`, `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| Libra | `0.21.25`, `a92b29e8fc9ad514ebe2e6c53216845aa059d94f` |
| Bridge | `1.2`; recall requires `memory.recall`, capture also requires `memory.episode.record` |
| Node.js | `^22.19.0 || >=24.0.0` |

DSH supplies the Cordis, Schemastery, Agent, Session and LLM peers. They are not embedded in the bundle. Older rc.7 reports are historical, not compatibility claims for this source tree. See [compatibility](compatibility/harness-alpha1.md).

## Install

### From this monorepo (development)

This revision is an unreleased update to the existing bundle. Build a development tarball to use the source documented here; no new npm release is claimed.

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
  "repositoryRoot": "/absolute/path/to/libra-repository"
}
```

`LIBRA_BINARY` and `LIBRA_REPO` are path fallbacks. The executable must be an executable file at an absolute path; no PATH lookup or model-supplied command is accepted. Initialize the target repository with Libra first. Opt-in capture uses `DEEPSEEK_API_KEY` or Libra's normal repository credential configuration. See [profile setup](docs/profile.md).

## Monorepo packages

The installable artifact is `@libra-tools/dsh-bundle`. Internal packages are compiled into its `dist/` bundle; Harness peers remain host-provided.

| Package | Responsibility |
| --- | --- |
| `packages/bundle` | Cordis entry, capability hooks, per-mount state and cleanup |
| `packages/bridge-client` | Framed transport, handshake, deadlines and child process ownership |
| `packages/protocol` | Versioned receiver schema and allowed bridge method definitions |

The bundle entry injects the real `agents` and `sessions` services. Type checking uses declarations built from the pinned DSH checkout; `.dsh-types.json` and `.dsh-dev` are ignored development artifacts. The only DSH module augmentation adds plugin-owned Memory source variants. There is no hand-maintained Host interface shim.

## Development

Prepare the pinned Harness declarations as shown above before running checks.

### Verification matrix

```sh
pnpm check
DSH_CHECKOUT=/absolute/path/to/pinned/deepseek-harness pnpm test:lifecycle
pnpm test:contract -- --protocol-version 1
LIBRA_BINARY=/absolute/path/to/libra LIBRA_REPO=/absolute/path/to/repository pnpm test:contract -- --libra-release a92b29e8fc9ad514ebe2e6c53216845aa059d94f
```

The lifecycle gate runs the built bundle through real Cordis, Loader, Session and AgentLoop, with controlled model and bridge peers for timing. Unit tests retain protocol and transport coverage without fake DSH interfaces.

`scripts/test-integration.mjs` separately packs the bundle, installs it into a fresh profile, checks composition, runs the installed artifact through Loader/AgentLoop, and verifies its persisted receipt. `scripts/test-memory-episodes.mjs` uses the real compiler model for generation → storage → remount → recall. Exact inputs and the distinction between deterministic and paid model checks are documented in [Memory testing](docs/memory-episodes.md).

## Security and privacy defaults

- **Bridge-only:** TypeScript does not access Libra's database or object store directly.
- **Deployment-owned configuration:** executable and repository paths cannot be supplied by the model.
- **Validated delivery:** protocol checks, bounded frames, and content hashes protect the transport and prompt delivery boundary.
- **Explicit capture:** additional generation and storage are disabled by default. The plugin does not promise secret redaction of query or answer text.

Harness retains approval ownership; Libra enforces repository access and selection policy. See [security](docs/security.md) and [privacy](docs/privacy.md).

## Protocol authority

The authority receipt pins Libra's actual protocol source and initialize fixture. The transport uses one JSON object per line, bounded UTF-8 frames, negotiated methods and deadlines. See [protocol](docs/protocol/agent-bridge-v1.md), [security](docs/security.md), and [privacy](docs/privacy.md).

## Documentation

| Topic | Path |
| --- | --- |
| Profile setup | [docs/profile.md](docs/profile.md) |
| Compatibility | [docs/compatibility.md](docs/compatibility.md) |
| Bridge protocol | [docs/protocol/agent-bridge-v1.md](docs/protocol/agent-bridge-v1.md) |
| Security and privacy | [docs/security.md](docs/security.md), [docs/privacy.md](docs/privacy.md) |
| Memory integration | [docs/memory-episodes.md](docs/memory-episodes.md) |
| Current validation evidence | [docs/release-evidence-CORDIS-20260907.md](docs/release-evidence-CORDIS-20260907.md) |

## License

MIT — see [LICENSE](LICENSE).
