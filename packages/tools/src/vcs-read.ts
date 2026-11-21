/**
 * Read-only Agent tool definitions for the typed Libra VCS reads
 * (plan-20261118 LVC-04).
 *
 * The model receives bounded cursors, one diff side selector, optional
 * repository-relative paths and one object id. It never receives a repository
 * root, a revision range, a pathspec or an absolute path; the Host binds the
 * repository from the caller's session.
 */
import type { ToolDefinition } from "./types.js";

export const VCS_READ_TOOLS: readonly ToolDefinition[] = [
  {
    name: "libra_vcs_status",
    bridge_method: "vcs.status",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["cursor", "limit"],
    required_parameters: [],
  },
  {
    name: "libra_vcs_diff",
    bridge_method: "vcs.diff",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["sides", "oid", "paths", "limit"],
    required_parameters: ["sides"],
  },
  {
    name: "libra_vcs_log",
    bridge_method: "vcs.log",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["cursor", "limit"],
    required_parameters: [],
  },
  {
    name: "libra_vcs_show",
    bridge_method: "vcs.show",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["oid", "cursor", "limit"],
    required_parameters: ["oid"],
  },
];

/** Model-facing descriptions for these tools. */
export const VCS_READ_TOOL_DESCRIPTIONS: Record<string, string> = {
  libra_vcs_status:
    "Paginated Libra working-tree status for the caller's session repository. Returns path/state entries and an opaque next cursor.",
  libra_vcs_diff:
    "Bounded Libra diff for the caller's session repository. Choose one side selector (worktree-vs-index, index-vs-head, or worktree-vs-oid) and optional repository-relative paths. Binary or oversized files carry truncation metadata instead of a patch.",
  libra_vcs_log:
    "Paginated commits reachable from HEAD in the caller's session repository. Returns oid, summary and author time with an opaque next cursor.",
  libra_vcs_show:
    "One commit from the caller's session repository: summary, parents and a paginated file list.",
};

/** Model-facing parameter descriptions for these tools. */
export const VCS_READ_PARAMETER_DESCRIPTIONS: Record<string, string> = {
  "cursor": "Opaque next cursor from the previous page. Omit for the first page.",
  "limit": "Page size, 1-100; Libra caps it at 100.",
  "sides": "One selector: worktree-vs-index, index-vs-head, or worktree-vs-oid.",
  "oid": "One commit object id (worktree-vs-oid diff side or the commit to show). Not a revision range.",
  "paths": "Repository-relative paths to include. Pathspec magic is refused.",
};
