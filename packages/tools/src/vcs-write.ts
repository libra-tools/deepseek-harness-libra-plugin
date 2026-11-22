/**
 * Agent-facing catalog entries for the typed Libra VCS writes (LVC-07).
 *
 * These tools are the only model-facing write entry points. Every entry is a
 * `write` risk, so `libra-tools.ts` requires the DSH approval gate before the
 * Host write service is called; the service then requires the approved
 * decision and forwards it to the bridge, whose own approval gate is the final
 * boundary. Paths are literal repository-relative names, never a repository
 * root, absolute path or pathspec.
 */
import type { ToolDefinition } from "./types.js";

export const VCS_WRITE_TOOLS: ToolDefinition[] = [
  {
    name: "libra_vcs_stage",
    bridge_method: "vcs.stage",
    risk: "write",
    schema_version: "1",
    retryable: false,
    parameters: ["paths"],
    required_parameters: ["paths"],
  },
  {
    name: "libra_vcs_unstage",
    bridge_method: "vcs.unstage",
    risk: "write",
    schema_version: "1",
    retryable: false,
    parameters: ["paths"],
    required_parameters: ["paths"],
  },
  {
    name: "libra_vcs_recover",
    bridge_method: "vcs.recover",
    risk: "write",
    schema_version: "1",
    retryable: false,
    parameters: ["action", "paths", "message"],
    required_parameters: ["action", "paths"],
  },
  {
    name: "libra_vcs_commit",
    bridge_method: "vcs.commit",
    risk: "write",
    schema_version: "1",
    retryable: false,
    parameters: ["paths", "message"],
    required_parameters: ["paths", "message"],
  },
];
