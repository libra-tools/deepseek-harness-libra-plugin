# Tools and approval

## Current support

The old `packages/tools` adapter was not wired into the current bundle entry and has been removed in the Cordis-native refactor. Its former interfaces are not a supported runtime surface. Historical implementation reports remain dated; they are not current feature documentation.

See the [plugin overview](../README.md) and [profile setup](profile.md) for currently connected capabilities. DSH retains ownership of its native agent, approval, workspace and UI behavior.

## Typed VCS read tools (LVC-04)

`libra_vcs_status`, `libra_vcs_diff`, `libra_vcs_log` and `libra_vcs_show` are read-risk tools over the additive `vcs.*` methods. They run through the Host `libraVcsRead` service, so the model and the panel cannot diverge. The Client reaches the same service through the `libraVcs` Remote namespace.

| Tool | Method | Parameters (model-visible) | Result |
| --- | --- | --- | --- |
| `libra_vcs_status` | `vcs.status` | `cursor` (opaque), `limit` (1–100) | `entries: [{ path, state }]`, `cursor.next` |
| `libra_vcs_diff` | `vcs.diff` | `sides` (required selector), `oid` (only for `worktree-vs-oid`), `paths`, `limit` | `sides`, `byteCap`, `truncated`, `truncation`, `files: [{ path, oldPath, patch, truncated, truncation }]` |
| `libra_vcs_log` | `vcs.log` | `cursor`, `limit` | `commits: [{ oid, summary, authorTime }]`, `cursor.next` |
| `libra_vcs_show` | `vcs.show` | `oid` (required), `cursor`, `limit` | `oid`, `summary`, `parents`, `files: [{ path, state, oldPath }]`, `cursor.next` |

Rules that hold for both callers:

- The repository is the caller Session's Host-resolved binding; a tool call is refused when no live binding serves that Session. Model-supplied roots, pathspec magic and revision ranges are rejected.
- `limit` must be an integer in 1–100 and a cursor must be an opaque decimal offset within Libra's cap; both are validated before the request.
- An unadvertised method is `unsupported_capability`. Disconnected transport, invalid parameters, invalid cursors, scope mismatch and stale state remain distinct, so a caller can retry the right class and never treat an outage as an empty repository.
- A binary or oversized diff is never presented as an empty change: `truncated` and `truncation` say why the patch is absent.
