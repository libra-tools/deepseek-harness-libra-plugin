# Harness UI

## Current support

The plugin contributes two Client surfaces, both registered through installed DSH slot contracts:

- the bundle settings form (`plugins.bundle.config`), and
- the read-only `Libra` version-control panel (plan-20261118 LVC-05): a page-type tab in the right sidebar, `sidebar.right.pane.tab`, opened from the sidebar guide as kind `libra-version-control`.

Panel strings live in the `en` / `zh` dictionaries at the top of `packages/bundle/client.js`; the panel body calls `t(key)` and exposes no user-visible literals of its own. `packages/bundle/locale/en.json` and `zh.json` are catalog copy and are not the panel dictionary.

The panel is read-only. It shows repository status, a bounded file diff, commit history/detail and the live bridge diagnostics recorded by the Host. Stage/unstage/commit controls belong to LVC-07. Panel markup uses inherited fonts, colors and `currentColor` so it follows the DSH theme; it does not import Client primitives.

See the [plugin overview](../README.md) and [profile setup](profile.md) for configuration and bridge behavior.
