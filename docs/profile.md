# Libra profile setup

Use DSH `v0.1.2-alpha.1` at `cd5ef8148158c3a752a658978873241fdf8e2bbc`. Build and pack the workspace as described in the [README](../README.md), then install the tarball:

```sh
dsh plugin --profile headless add /absolute/path/to/libra-tools-dsh-bundle-0.1.0.tgz
dsh --profile headless --dump-config
```

The bundle patch inserts an entry with ID `libra` and name `@libra-tools/dsh-bundle`. It directly injects DSH's `agents` and `sessions`; there is no host adapter or `degraded-no-host` mode. Missing required services prevent Cordis from activating it.

| Config | Meaning |
| --- | --- |
| `libraExecutable` | Absolute executable path; fallback `LIBRA_BINARY` |
| `repositoryRoot` | Existing directory; fallback `LIBRA_REPO`, then current directory |
| `captureMemoryEpisodes` | Defaults to `false`; opt in to compiler calls and generation input storage |
| `memoryModel` | Libra compiler model; defaults to `deepseek-chat` |

Use a Libra-initialized repository and the [pinned Bridge 1.2 build](../compatibility/harness-alpha1.md). Capture also needs an existing code commit and provider credentials. These are deployment settings, not model-controlled parameters.

`--dump-config` proves composition only. The integration gate runs the installed artifact and checks its database receipt. See [Memory testing](memory-episodes.md). The current development tarball has not been published to npm.
