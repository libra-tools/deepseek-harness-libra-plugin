# Harness UI

## Current support

The plugin contributes two Client surfaces, both registered through installed DSH slot contracts:

- the bundle settings form (`plugins.bundle.config`), and
- the `Libra` version-control panel (plan-20261118 LVC-05, writes added by LVC-07): a page-type tab in the right sidebar, `sidebar.right.pane.tab`, opened from the sidebar guide as kind `libra-version-control`.

Panel strings live in the `en` / `zh` dictionaries at the top of `packages/bundle/client.js`; the panel body calls `t(key)` and exposes no user-visible literals of its own. `packages/bundle/locale/en.json` and `zh.json` are catalog copy and are not the panel dictionary.

The panel shows repository status, a bounded file diff, commit history/detail and the live bridge diagnostics recorded by the Host. Each status row has a Stage or Unstage control, and a commit form submits the staged set with the typed message. Writes go through the Host `libraVcsWrite` Remote: the Client sends literal paths, an operation id and the Host-issued HEAD/index/worktree fence, and the Host attaches the fixed user-action approval. The bridge revalidates the fence before writing; a stale result refreshes the panel and asks the user to retry, and success triggers one canonical refresh instead of an optimistic row. A timeout, disconnect or internal failure after dispatch (including a rejected Remote promise) is treated as uncertain: the panel re-reads canonical state, retains the original request (operation id, paths and fence) and offers a retry that replays exactly that request, so a write that was applied is recovered rather than reported as a failure. The request is persisted before dispatch, so closing the panel while a write is in flight does not lose its operation id, and a cancelled retry keeps the record too; a temporarily unverifiable binding keeps the record instead of discarding it. The retry is refused after a confirmed Session rebind because the original operation belongs to the previous repository binding; the record is retained for that repository identity (returning to it, even with a new binding generation, replays the same operation id and payload against the current binding), and a new write stays blocked until the unresolved operation is replayed or reconciled. If an Agent left an unresolved operation, the panel shows how to call the approval-gated `libra_vcs_recover` tool before writing again. A commit page load is cancelled on refresh or panel close, so it cannot submit after the user leaves the panel. Panel markup uses inherited fonts, colors and `currentColor` so it follows the DSH theme; it does not import Client primitives.

See the [plugin overview](../README.md) and [profile setup](profile.md) for configuration and bridge behavior.
