# Compatibility

The current integration uses DSH `v0.1.2-alpha.1` at `cd5ef8148158c3a752a658978873241fdf8e2bbc` and Libra Bridge `1.2` at `a92b29e8fc9ad514ebe2e6c53216845aa059d94f` (Libra `0.21.25`). See the [current compatibility record](../compatibility/harness-alpha1.md) and [protocol authority receipt](../protocol/agent-bridge.v1.receipt.json).

Only bundle, bridge-client and protocol remain in the workspace. The current entry provides Memory recall and optional Episode capture. Earlier rc.7, tools, workspace, UI and outbox reports describe historical work; they are not supported-feature claims for this revision.

A DSH or protocol change requires inspecting the new official contract and rerunning the relevant type, runtime and artifact gates. Fake peers test transport or timing and do not substitute for real profile installation, Libra storage or compiler-model evidence.
