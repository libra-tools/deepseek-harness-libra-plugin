# Libra profile setup

Use DSH `v0.1.2-alpha.1` at `cd5ef8148158c3a752a658978873241fdf8e2bbc`. Build and pack the workspace as described in the [README](../README.md), then install the tarball:

```sh
dsh plugin --profile headless add /absolute/path/to/libra-tools-dsh-bundle-0.1.0.tgz
dsh --profile headless --dump-config
```

The bundle patch inserts an entry with ID `libra` and name `@libra-tools/dsh-bundle`. Harness supplies its native `agents` and `sessions` services; missing required services prevent Cordis from activating the entry.

## Bridge configuration

Set the executable and repository paths in the inserted `libra` entry. These are deployment settings, not model-controlled parameters.

| Config | Meaning |
| --- | --- |
| `libraExecutable` | Absolute executable path; fallback `LIBRA_BINARY` |
| `repositoryRoot` | Existing directory; fallback `LIBRA_REPO`, then current directory |

Use a Libra-initialized repository and the [pinned Bridge 1.2 build](../compatibility/harness-alpha1.md).

## Optional capability settings

Recall is active when the bundle is loaded. Episode capture is disabled by default:

| Config | Meaning |
| --- | --- |
| `captureMemoryEpisodes` | Defaults to `false`; opt in to compiler calls and generation input storage |
| `memoryModel` | Libra compiler model; defaults to `deepseek-chat` |

Capture also needs an existing code commit and provider credentials. See [Memory integration](memory-episodes.md) for setup, behavior, and costs.

## Verify installation

`--dump-config` proves composition only. The integration gate runs the installed artifact and checks its database receipt. See [Memory testing](memory-episodes.md). The current development tarball has not been published to npm.
