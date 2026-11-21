/**
 * Read-only Agent tools for the typed VCS reads (plan-20261118 LVC-04).
 *
 * The model surface must stay bounded: read risk only, no repository identity
 * parameters, and exactly one bridge method per tool. The facade dispatches the
 * declared method with the validated parameters.
 */
import { describe, expect, it } from "vitest";

import { VCS_READ_TOOLS, TOOL_CATALOG, ToolsFacade } from "@libra/dsh-tools";
import { VCS_READ_METHODS, type BridgeClient, type CompletedRequest } from "@libra/dsh-bridge-client";

const FORBIDDEN = [
  "actor", "repository_root", "executable", "cwd", "owner", "fence",
  "workspace_id", "path", "worktree_id", "database_path",
];

function fakeClient(methods: string[] = [...VCS_READ_METHODS]): {
  client: BridgeClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    get negotiatedCapabilities() {
      return { protocol: { major: 1, minor: 2 }, limits: {}, methods, source: "fake" };
    },
    async requestMethod(method: string, params: unknown): Promise<CompletedRequest> {
      calls.push({ method, params });
      return { id: 1, method, state: "success", result: { data: { entries: [], cursor: { next: null } } } };
    },
  } as unknown as BridgeClient;
  return { client, calls };
}

describe("typed VCS read tools", () => {
  it("exposes four bounded read tools", () => {
    expect(VCS_READ_TOOLS.map((tool) => tool.name)).toEqual([
      "libra_vcs_status",
      "libra_vcs_diff",
      "libra_vcs_log",
      "libra_vcs_show",
    ]);
    for (const tool of VCS_READ_TOOLS) {
      expect(tool.risk).toBe("read");
      expect(tool.parameters.every((parameter) => !FORBIDDEN.includes(parameter))).toBe(true);
    }
    expect(VCS_READ_TOOLS.find((tool) => tool.name === "libra_vcs_diff")?.required_parameters).toEqual(["sides"]);
    expect(VCS_READ_TOOLS.find((tool) => tool.name === "libra_vcs_show")?.required_parameters).toEqual(["oid"]);
  });

  it("includes the read tools in the shared catalog exactly once", () => {
    const names = TOOL_CATALOG.map((tool) => tool.name);
    for (const tool of VCS_READ_TOOLS) expect(names.filter((name) => name === tool.name)).toHaveLength(1);
  });

  it("dispatches each tool to its one bridge method with the given parameters", async () => {
    const { client, calls } = fakeClient();
    const facade = new ToolsFacade(client, {
      allowRead: true,
      allowWrite: false,
      allowRestore: false,
      allowPushPublish: false,
    });

    await facade.invoke("libra_vcs_status", { cursor: "20", limit: 10 });
    await facade.invoke("libra_vcs_diff", { sides: "worktree-vs-index", paths: ["src"] });
    await facade.invoke("libra_vcs_log", { limit: 5 });
    await facade.invoke("libra_vcs_show", { oid: "a".repeat(40), cursor: "0" });

    expect(calls.map((call) => call.method)).toEqual(["vcs.status", "vcs.diff", "vcs.log", "vcs.show"]);
    expect(calls[0]?.params).toMatchObject({ cursor: "20", limit: 10 });
    expect(calls[1]?.params).toMatchObject({ sides: "worktree-vs-index", paths: ["src"] });
    expect(calls[2]?.params).toMatchObject({ limit: 5 });
    expect(calls[3]?.params).toMatchObject({ oid: "a".repeat(40), cursor: "0" });
  });

  it("refuses parameters outside the declared tool surface", async () => {
    const { client } = fakeClient();
    const facade = new ToolsFacade(client, {
      allowRead: true, allowWrite: false, allowRestore: false, allowPushPublish: false,
    });
    const result = await facade.invoke("libra_vcs_status", { repository_root: "/tmp/other" });
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("repository identity");
  });

  it("reports a negotiated-method check for each read tool", () => {
    const { client } = fakeClient(["vcs.status"]);
    const facade = new ToolsFacade(client, {
      allowRead: true, allowWrite: false, allowRestore: false, allowPushPublish: false,
    });
    expect(facade.supports("vcs.status")).toBe(true);
    expect(facade.supports("vcs.diff")).toBe(false);
  });
});
