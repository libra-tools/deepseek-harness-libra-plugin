# DeepSeek Harness Libra Plugin

`@libra-tools/dsh-bundle` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profile plugin that connects Harness sessions to [Libra](https://github.com/libra-tools/libra) through a typed JSON-RPC NDJSON bridge (`libra agent bridge --stdio`).

Harness owns the agent loop, session persistence, and approval policy. Libra owns repository state, durable evidence, and storage policy. This plugin is the TypeScript client and Cordis bundle between them—it does not read Libra's database or implement a second Harness runtime.

**npm:** [@libra-tools/dsh-bundle](https://www.npmjs.com/package/@libra-tools/dsh-bundle) · **This tree:** `0.2.0` (not the published `0.1.0`) · **Harness:** `^0.2.2-rc.3` · **Libra bridge fixture:** protocol 1.2

## What it does

When loaded into a Harness profile, the bundle:

1. Registers the Cordis entry `libra` using Harness's native agent and session services.
2. Starts the configured `libra agent bridge --stdio` process with fixed arguments.
3. Negotiates the bridge protocol and routes requests through typed, allowlisted methods.
4. Connects supported Libra capabilities to the Harness lifecycle, preserving session identity and receipt provenance.
5. Drains pending requests and closes the bridge when the plugin is unloaded, without closing live Harness sessions.

### Composed layers

The bundle composes five bridge-backed layers into one Cordis context (one
shared bridge child process, closed once by the bundle disposer):

1. **Memory recall** — when the bridge advertises `memory.recall`, requests a
   bounded section for an accepted DSH turn and attaches it to the model request
   with receipt/content hashes. The new local implementation uses lexical
   selection and does not persist a selection receipt. Visible deliveries are tracked
   through a durable session projection (`libraMemory`) so retirement survives
   compaction; hosts without `sessionProjections` fall back to a surface scan.
2. **Tools** — the allowlisted catalog below is registered as first-party DSH
   tools (`ctx.tools.register`). Session identity always comes from the caller
   agent's session; write/restore calls pass the DSH approval service
   (`ctx.approval`) before reaching the bridge, and each call carries a
   generated `operation_id` so provenance cannot be forged.
3. **Workspace leases** — one lease per session, claimed on `session/created`
   (linked for forked sessions), renewed at half the lease TTL, released on
   `session/disposed`.
4. **Context grounding** — one bounded, redacted `libra_context` snapshot is
   injected on the first turn; afterwards the model queries `libra_context`
   on demand.
5. **Outbox** — every committed DSH `session/event` is redacted and buffered
   locally, then drained to the bridge on `session/flush` / `session/disposed`.

```
┌─────────────────────┐     NDJSON JSON-RPC      ┌──────────────────────────┐
│  DeepSeek Harness   │ ◄──────────────────────► │  libra agent bridge      │
│  (agent loop, UI,   │   stdin / stdout         │  --stdio                  │
│   approval policy)  │                          └────────────┬─────────────┘
└──────────┬──────────┘                                       │
           │ @libra-tools/dsh-bundle                           │ Rust bridge
           │ (this repo)                                       ▼
           │                                    Libra storage, workspace,
           │                                    checkpoints, provenance
           ▼
     Memory recall, tools + approval,
     workspace leases, context grounding,
     local outbox (redaction, batching)
```

Memory requires a Libra bridge that advertises the relevant methods. Libra
Bridge `1.0` does not provide Memory; the new local implementation requires
repository-local opt-in and a compatible development build. See
[compatibility.md](docs/compatibility.md) for the compatibility record.

## Requirements

| Component | Pin |
| --- | --- |
| Node.js | `>= 24.9` |
| DeepSeek Harness | `0.2.2-rc.3` (`@deepseek-ai/dsh`, Node `>=24.9`) |
| Libra | A build with `agent bridge --stdio`; Memory requires the negotiated extension methods and repository-local opt-in |
| Repository | Libra-initialized worktree (`libra init`) |

Peer dependencies at runtime (all optional; provided by Harness):
`@deepseek-ai/cordis` `^4.1.0`, `@deepseek-ai/dsh-agent` / `dsh-llm` /
`dsh-session` / `dsh-session-projection` / `dsh-tools` / `dsh-user-approval`
`^0.2.2-rc.3`. The bundle declares `engines.dsh: ^0.2.2-rc.3`, which is the
check DSH uses before loading a profile plugin.

## Configuration

The bundle loads with a minimal config; every key is optional:

| Key | Default | Effect |
| --- | --- | --- |
| `libraExecutable` | `LIBRA_BINARY` env | Absolute path, relative path, or a name on `PATH`. When neither is set, or the file cannot be executed, the plugin stays inactive (nothing is spawned; a warning is logged). |
| `repositoryRoot` | `LIBRA_REPO` env, else cwd | Libra-initialized worktree the bridge operates in. |
| `outboxRoot` | `$DSH_HOME/libra/outbox` | Repository-scoped, generation-isolated event queues and per-session SQLite coordination locks (outside the repository). Applied when the plugin loads. |
| `injectContext` | `true` | Inject one bounded `libra_context` snapshot on the first turn. |
| `workspaceLeaseTtlMs` | `30000` | Workspace lease TTL; the bundle renews at half the TTL. |
| `memoryTokenBudget` | `0` (Libra decides) | Positive values are sent to `memory.recall` as `token_budget`. The plugin does not truncate a section after its hash is checked. |
| `captureMemoryEpisodes` | `false` | Send the accepted query and final answer to a compatible bridge after a successful turn. The new local store also requires repository-local `bridge.conversationMemory=true`. |
| `memoryModel` | `deepseek-chat` | Forwarded for older compiler-backed bridges; the new local store does not call a model. |

On the Plugins page, this bundle's configuration edits the same fields. The binary path is deployment configuration and is never a model-visible parameter. Changing the binary or repository requires reloading the plugin; existing sessions are not silently moved to another repository. Capture and other mount-time fields apply when the plugin loads.

This plugin does not replace the built-in changed-files card (`dsh-workspace-changes`) or a general memory plugin such as `dsh-mnemon` / `dsh-plugin-memory`. Those may stay enabled. Libra owns repository checkpoints, commits, leases and its own Memory storage; the others own turn diffs or their own memory stores. If more than one plugin injects a user message on the first turn, Harness keeps both; Libra's section is the one whose source kind is `libra-memory` or `libra-context`.

## Install

### From this monorepo (development)

This revision is an unreleased update to the existing bundle. Build a development tarball to use the source documented here; no new npm release is claimed.

The repository root and `packages/bundle` workspace manifest are not standalone install targets. Build the self-contained artifact in the workspace:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack:bundle -- --destination /absolute/path/to/artifacts
dsh plugin --profile headless add /absolute/path/to/artifacts/libra-tools-dsh-bundle-0.2.0.tgz
```

The separate `test:lifecycle` and `test:integration` scripts target a historical
DSH alpha.1 checkout and are not evidence for DSH `0.2.2-rc.3`.

Configure the inserted `libra` entry with deployment-owned paths:

```json
{
  "libraExecutable": "/absolute/path/to/libra",
  "repositoryRoot": "/absolute/path/to/libra-repository"
}
```

All tools map to contract methods only—no wildcard bridge access.

| Tool | Bridge method | Risk | Default |
| --- | --- | --- | --- |
| `libra_context` | `context.get` | read | allowed |
| `libra_status` | `status.get` | read | allowed |
| `libra_diff` | `diff.get` | read | allowed |
| `libra_history_search` | `history.search` | read | allowed |
| `libra_checkpoint` | `checkpoint.list` | read | allowed |
| `libra_checkpoint_show` | `checkpoint.show` | read | allowed |
| `libra_checkpoint_create` | `checkpoint.create` | write | denied until approval |
| `libra_commit` | `commit.create` | write | denied until approval |
| `libra_review` | `review.run` | write | denied until approval |
| `libra_restore_checkpoint` | `checkpoint.restore` | restore | denied until approval |

The model-visible parameter surface is filtered: bridge internals
(`actor`, `repository_root`, `workspace_id`, `session_id`, `operation_id`,
`approval`, …) never appear in a tool schema — session identity is bound from
the calling agent, `operation_id` is generated per call, and approval is
routed through the DSH approval policy (ask/never), which is audited on the
session log.

Tool results are always a single object: `{ schema_version, operation_id, status, data?, error?, warnings? }`. Bridge and transport failures surface as `status: "error"`—never silent empty success.

See [docs/tools.md](docs/tools.md) for approval policy and error mapping.

## Monorepo packages

The installable artifact is `@libra-tools/dsh-bundle`. Internal packages are compiled into its `dist/` bundle; Harness peers remain host-provided.

| Package | Responsibility |
| --- | --- |
| `packages/bundle` | Cordis entry, capability hooks, per-mount state and cleanup |
| `packages/bridge-client` | Framed transport, handshake, deadlines and child process ownership |
| `packages/protocol` | Versioned receiver schema and allowed bridge method definitions |

## Security and privacy defaults

- **Bridge-only:** no direct `.libra/` database or object store access from TypeScript.
- **Fail-closed:** protocol major mismatch, actor/lease conflict, redaction uncertainty, and forbidden model parameters (e.g. `actor`, `repository_root`, `database_path`) are rejected.
- **Redaction:** known secret patterns and oversized payloads are blocked or stripped before outbox persistence; pattern-based checks cannot guarantee removal of all secrets or personal information.
- **Actor binding:** the plugin derives `deepseek-harness:<session_id>` from the caller's session and rejects model-supplied identity fields. The local bridge trusts its stdio host and repository context; a session ID is not an authentication credential.

Details: [docs/security.md](docs/security.md), [docs/privacy.md](docs/privacy.md).

## Protocol authority

The Libra Rust bridge (`libra/src/internal/ai/agent_bridge/`) owns its actual methods, limits, error codes and handshake semantics. The receiver fixture in `protocol/agent-bridge.v1.schema.json` records an older protocol `1.2` development revision; it must not be treated as proof that an installed binary supports Memory. Check the peer's negotiated method list and the compatibility record.

Transport summary: one JSON-RPC 2.0 object per NDJSON line on stdout; stderr for diagnostics. The client bounds the handshake and plugin shutdown; ordinary bridge requests are not assigned an artificial total deadline.

See [docs/protocol/agent-bridge-v1.md](docs/protocol/agent-bridge-v1.md).

## Development

Run the local checks against the workspace dependencies. Real Libra/DSH integration gates require separately configured test environments.

### Verification matrix

```sh
pnpm check
DSH_CHECKOUT=/absolute/path/to/pinned/deepseek-harness pnpm test:lifecycle
pnpm test:contract -- --protocol-version 1
pnpm test:contract -- --libra-release <libra-authority-revision>
pnpm test:contract -- --events
pnpm test:contract -- --tools
pnpm test:contract -- --workspace
DSH_CLI="/absolute/path/to/pinned/dsh" \
LIBRA_BINARY="/absolute/path/to/libra" \
LIBRA_REPO="/absolute/path/to/initialized/libra-repo" \
pnpm test:integration -- --profile libra --revision dsh-v0.2.2-rc.3 --context --ui
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
| Tools & approval | [docs/tools.md](docs/tools.md) |
| Workspace & subagent | [docs/workspace.md](docs/workspace.md) |
| Context injection | [docs/context.md](docs/context.md) |
| Memory recall module | [docs/release-evidence-MEM-DSH-01.md](docs/release-evidence-MEM-DSH-01.md) |
| UI cards | [docs/ui.md](docs/ui.md) |
| Harness compatibility | [docs/compatibility.md](docs/compatibility.md) |
| Release evidence | [docs/release-evidence-REL-TS-02.md](docs/release-evidence-REL-TS-02.md) |
| Implementation plan | [docs/plan/plan-20260824.md](docs/plan/plan-20260824.md) |

## License

MIT — see [LICENSE](LICENSE).
