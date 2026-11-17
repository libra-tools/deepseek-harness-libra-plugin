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
name, and set `repositoryRoot` to an initialized Libra repository. The plugin
can also read `LIBRA_BINARY` and `LIBRA_REPO`. Without an explicit repository,
it uses the host process's current directory, which can differ from a DSH
session's workspace. Reload the plugin after changing the executable or
repository.

Optional settings include `outboxRoot`, `injectContext`,
`workspaceLeaseTtlMs`, and `memoryTokenBudget`. For the new local conversation
Memory, use a bridge advertising the Memory methods and explicitly set the
repository-local `bridge.conversationMemory` configuration to `true`. Capture
also requires `captureMemoryEpisodes: true` in the plugin. Both settings are
off by default. `memoryModel` applies only to older compiler-backed bridges;
the new local implementation does not invoke a provider.
