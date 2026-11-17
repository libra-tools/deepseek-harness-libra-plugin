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

Configure `libraExecutable` with an absolute path, a relative path, or a `PATH` name for a Libra binary that advertises
Agent Bridge protocol `1.1`, and set `repositoryRoot` to an initialized Libra
repository. The plugin can also read these values from `LIBRA_BINARY` and
`LIBRA_REPO`. Optional knobs: `outboxRoot`, `injectContext` (default `true`),
`workspaceLeaseTtlMs`, and `memoryTokenBudget` (see the README configuration
table). Optional Episode capture stays off unless `captureMemoryEpisodes` is
true; `memoryModel` defaults to `deepseek-chat`.
