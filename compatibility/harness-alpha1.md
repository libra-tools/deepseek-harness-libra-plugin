# Harness v0.1.2-alpha.1 compatibility

| Component | Pin |
| --- | --- |
| DeepSeek Harness | `v0.1.2-alpha.1` / `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| Libra bridge | `1.2`, Libra `0.21.25`, `a92b29e8fc9ad514ebe2e6c53216845aa059d94f` |
| Bundle | `@libra-tools/dsh-bundle@0.1.0` development tarball, not published by this refactor |
| Node.js | `^22.19.0 || >=24.0.0` |

The bundle uses official Cordis `Config/inject/apply`, `ctx.on` and `ctx.effect` contracts. The Host owns Sessions; the bundle owns per-mount Memory state and one bridge process. The former Host adapters and ambient Host declarations are removed.

Type preparation builds upstream declarations from the exact installed checkout. Runtime tests load the built bundle through the pinned Loader and real AgentLoop. The separate integration gate packs the bundle, installs it into a fresh `headless` profile with `dsh plugin add`, checks composition, runs the installed artifact and verifies the persisted Libra receipt. The optional live mode runs DSH's actual `deepseek-v4-flash` model.

The [Memory generation gate](../docs/memory-episodes.md) distinguishes a deterministic DSH answer from a real Episode compiler request. Prior evidence remains dated; current refactor results are recorded separately. Direct GitHub-root installation and npm publication are not claimed.
