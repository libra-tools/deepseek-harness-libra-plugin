# Libra profile setup

```bash
DSH_CLI="/absolute/path/to/pinned/dsh-v0.2.2-rc.3"
"$DSH_CLI" plugin --profile libra add file:/tmp/libra-dsh-bundle-<run>
"$DSH_CLI" --profile libra --dump-config
```

The `libra` profile installs `@libra-tools/dsh-bundle`, which registers the Cordis layer `libra`. The bundle starts `libra agent bridge --stdio` after a pinned DSH host supplies the lifecycle adapter; without that host capability it reports `degraded-no-host`. When no `libraExecutable`/`LIBRA_BINARY` is configured the bundle activates inertly (nothing is spawned) instead of failing the composition.

Required: Libra repository initialized (`libra init`) and Libra binary on PATH or configured explicitly.

## Development profile

Build and pack the workspace bundle, then install the tarball into a DSH profile:

```bash
pnpm build
pnpm pack:bundle
dsh plugin --profile headless add /absolute/path/to/libra-tools-dsh-bundle-0.2.0.tgz
```

Configure `libraExecutable` with an absolute path, a relative path, or a `PATH`
name. The plugin can also read `LIBRA_BINARY`.

Repositories are not configured per profile in Host mode: each Session binds to
the `.libra` worktree that DSH's `workingDirectory` reports for it, and sessions
in other workspaces use their own bridge, lease, outbox queue and tool facade.
A profile still carrying `repositoryRoot` or `LIBRA_REPO` keeps that value only
as the legacy fallback for compositions without the Host
`workingDirectory` service; the plugin logs the deprecation once. A Session
whose directory later resolves to a different worktree fails closed until the
Host rebinds it; the model cannot choose a repository.

The executable is resolved when a Session binds, so changing it affects Sessions
that bind afterwards.

Optional settings include `outboxRoot`, `injectContext`,
`workspaceLeaseTtlMs`, and `memoryTokenBudget`. For the new local conversation
Memory, use a bridge advertising the Memory methods and explicitly set the
repository-local `bridge.conversationMemory` configuration to `true`. Capture
also requires `captureMemoryEpisodes: true` in the plugin. Both settings are
off by default. `memoryModel` applies only to older compiler-backed bridges;
the new local implementation does not invoke a provider.
