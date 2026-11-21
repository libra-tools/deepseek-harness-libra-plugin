/**
 * Read-only Agent tools for the typed VCS reads (plan-20261118 LVC-04).
 *
 * The model surface must stay bounded: read risk only, no repository identity
 * parameters, and exactly one bridge method per tool. The facade dispatches the
 * declared method with the validated parameters.
 */
import { describe, expect, it } from "vitest";

import { VCS_READ_TOOLS, TOOL_CATALOG, ToolsFacade } from "@libra/dsh-tools";
import { boundModelValue, invokeVcsReadTool, VcsHostError, type LibraVcsReadService } from "@libra/dsh-bundle";
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

describe("Agent VCS reads share the Host service", () => {
  function service(error?: unknown) {
    const calls: Array<{ method: string; params: unknown }> = [];
    const make = (method: string) => async (_session: unknown, params: unknown) => {
      calls.push({ method, params });
      if (error !== undefined) throw error;
      return { method, params } as never;
    };
    return {
      calls,
      service: {
        status: make("status"),
        diff: make("diff"),
        log: make("log"),
        show: make("show"),
      } as unknown as LibraVcsReadService,
    };
  }

  it("dispatches a tool call to the typed service with only declared parameters", async () => {
    const { service: host, calls } = service();
    const result = await invokeVcsReadTool(host, { id: "s-1" }, "libra_vcs_diff", {
      sides: "worktree-vs-index",
      paths: ["src"],
      limit: 5,
      operation_id: "op-1",
    });
    expect(result).toMatchObject({ status: "ok", operation_id: "op-1" });
    expect(calls[0]).toEqual({ method: "diff", params: { sides: "worktree-vs-index", paths: ["src"], limit: 5 } });
  });

  it("rejects unexpected, forbidden and missing parameters without calling the service", async () => {
    const { service: host, calls } = service();
    for (const [tool, input, message] of [
      ["libra_vcs_status", { repository_root: "/tmp/x" }, "unexpected tool parameter"],
      ["libra_vcs_status", { cursor: null, path: "a" }, "unexpected tool parameter"],
      ["libra_vcs_diff", { paths: ["a"] }, "requires parameter sides"],
      ["libra_vcs_show", {}, "requires parameter oid"],
    ] as const) {
      const result = await invokeVcsReadTool(host, { id: "s-1" }, tool, input as Record<string, unknown>);
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain(message);
      expect(result.error?.stable_code).toBe("invalid_params");
    }
    expect(calls).toHaveLength(0);
  });

  it("propagates the typed Host failure kinds as stable codes", async () => {
    const { service: host } = service(new VcsHostError("cwd_changed", "moved"));
    const result = await invokeVcsReadTool(host, { id: "s-1" }, "libra_vcs_status", {});
    expect(result.status).toBe("error");
    expect(result.error?.stable_code).toBe("cwd_changed");
  });
});

describe("model-facing result bounds", () => {
  it("keeps a small result intact", () => {
    const text = boundModelValue({ entries: [{ path: "a.ts", state: "staged" }] });
    expect(JSON.parse(text)).toEqual({ entries: [{ path: "a.ts", state: "staged" }] });
  });

  it("bounds a large diff by dropping patches and saying so", () => {
    const patch = "x".repeat(30_000);
    const value = {
      sides: "worktree-vs-index",
      byteCap: 262144,
      truncated: false,
      truncation: "none",
      files: [
        { path: "a.ts", oldPath: null, patch, truncated: false, truncation: "none" },
        { path: "b.ts", oldPath: null, patch: "small", truncated: false, truncation: "none" },
      ],
    };
    const text = boundModelValue(value);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(20_000);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["truncated"]).toBe(true);
    expect(parsed["modelTruncation"]).toBe("patch_omitted");
    const files = parsed["files"] as Array<Record<string, unknown>>;
    expect(files[0]?.["patch"]).toBeNull();
    expect(files[0]?.["truncated"]).toBe(true);
    expect(files[0]?.["truncation"]).toBe("byte_cap");
  });

  it("bounds UTF-8 text without exceeding the byte cap", () => {
    const text = boundModelValue("雪".repeat(10_000));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(20_000);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ truncated: true, truncation: "model_output_cap" });
    expect(typeof parsed["preview"]).toBe("string");
  });

  it("falls back to an explicit preview envelope for a huge non-diff result", () => {
    const text = boundModelValue({ rows: "y".repeat(50_000) });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(20_000);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ truncated: true, truncation: "model_output_cap" });
    expect(typeof parsed["originalBytes"]).toBe("number");
    expect(String(parsed["preview"]).length).toBeGreaterThan(0);
  });
});
