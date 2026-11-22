# Tools and approval

## Current support

The old `packages/tools` adapter was not wired into the current bundle entry and has been removed in the Cordis-native refactor. Its former interfaces are not a supported runtime surface. Historical implementation reports remain dated; they are not current feature documentation.

See the [plugin overview](../README.md) and [profile setup](profile.md) for currently connected capabilities. DSH retains ownership of its native agent, approval, workspace and UI behavior.

## Typed VCS write tools (LVC-07)

`libra_vcs_stage`, `libra_vcs_unstage` and `libra_vcs_commit` are `write`-risk tools over the additive `vcs.stage` / `vcs.unstage` / `vcs.commit` methods (protocol minor 2). `libra_vcs_recover` is the approval-gated Host recovery entry for an unresolved write; it requires the original action, paths and commit message when applicable. They run through the Host `LibraVcsWriteService`, the same service the panel's user action calls, so parameters, fence handling, results and failures cannot diverge.

| Tool | Bridge method | Parameters | Result |
| --- | --- | --- | --- |
| `libra_vcs_stage` | `vcs.stage` | `paths` (literal repo-relative, required) | `{ operationId, outcome, commitOid, paths, failures }` plus binding identity |
| `libra_vcs_unstage` | `vcs.unstage` | same as stage | same as stage |
| `libra_vcs_commit` | `vcs.commit` | stage parameters plus `message` (required, ≤4096 UTF-8 bytes) | same, with the created `commitOid` |
| `libra_vcs_recover` | Host replays original `vcs.stage` / `vcs.unstage` / `vcs.commit` | `action`, exact original `paths`, and original `message` for commit | resolved outcome with the original operation id |

A mutation that publishes its effect but fails internally while recording the result, or whose transport answer is lost after dispatch, is replayed once with the same operation id; the bridge reports the recorded outcome (`replayed`) instead of writing twice. Refusals such as `stale_state`, `denied`, `conflict` or `unsupported_capability` are terminal and never replayed. A returned outcome other than `applied`/`replayed` is reported as a typed tool error (`denied`, `stale_state`, `internal` for failed, or non-retryable `indeterminate` when the Host cannot establish whether the write applied), never as a successful call. An `indeterminate` error means the caller must reconcile repository state and use `libra_vcs_recover` with the same action and paths; it must not reissue the operation with a new id. The Host retains the exact bridge payload (including original operation id and fence), allows one unresolved operation per Session/repository, blocks later writes, and removes the record only after a definitive recovery result. The Host caps retained unresolved writes at 256 and refuses new writes at capacity. Repeating the same panel action with the same Host operation id is also routed to this exact replay path. A post-dispatch projection, protocol violation, disconnect, rebind or caller cancellation is treated the same way (never reported as an error that implies no mutation); only a cancellation observed before dispatch is an ordinary `cancelled` result. Every automatic replay revalidates the original Session binding first (including a projection-failure replay), so it can never start or repeat the mutation in a repository the Session has left.

Every call is approval-gated: the DSH approval gate runs before the Host service with the action and complete JSON-encoded authorized path set in its reason; a denial performs no bridge write. Approval and operation ids are Host-generated and are absent from model-visible parameters. A summary that cannot show every path within the approval display budget is refused instead of approved partially. The panel path attaches the fixed `dsh-user-action` approver instead; the Client never sends an approval, repository root or fence shape. Agent calls do not supply a fence: the Host reads the current HEAD/index/worktree fence from `vcs.status` immediately before the write, so a model cannot forge or act on stale repository state. The panel obtains the same Host-issued fence through `libraVcsWrite.fence`, and the bridge revalidates it before writing; a stale fence returns `stale_state` with no mutation and the panel refreshes and asks for a retry. Absolute paths, traversal, pathspec/glob syntax, backslashes and more than 64 paths are rejected before dispatch.

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
