import { describe, expect, it, vi } from "vitest";

import { BridgeClientError, type BridgeClient, type CompletedRequest } from "@libra/dsh-bridge-client";
import { LibraVcsWriteService, USER_ACTION_APPROVAL, invokeVcsWriteTool, type VcsWriteScope } from "@libra/dsh-bundle";
import { TOOL_CATALOG, VCS_WRITE_TOOLS, ToolsFacade } from "@libra/dsh-tools";

const FENCE = { expectedHead: "a".repeat(40), expectedIndex: "b".repeat(64), expectedWorktree: "c".repeat(64) };
const SESSION = { id: "session-1" };

function completed(method: string, data: unknown): CompletedRequest {
  return { id: 1, method, state: "success", result: { ok: true, data } };
}

function fakeClient(responses: Record<string, CompletedRequest | Error> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const requestMethod = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params });
    const response = responses[method];
    if (response instanceof Error) throw response;
    if (response !== undefined) return response;
    if (method === "vcs.status") {
      return completed(method, { writeFence: { head: FENCE.expectedHead, indexGeneration: FENCE.expectedIndex, worktreeGeneration: FENCE.expectedWorktree } });
    }
    const input = params as { operation_id: string; paths: string[]; message?: string };
    if (method === "vcs.commit") {
      return completed(method, { operationId: input.operation_id, outcome: "applied", commitOid: "d".repeat(40), paths: input.paths, failures: [] });
    }
    return completed(method, { operationId: input.operation_id, outcome: "applied", commitOid: null, paths: input.paths, failures: [] });
  });
  const client = { requestMethod } as unknown as BridgeClient;
  return { client, calls };
}

function service(client: BridgeClient) {
  const scope: VcsWriteScope = {
    client,
    methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"],
    bindingKey: "key-1",
    generation: 1,
    validate: async () => undefined,
  };
  return new LibraVcsWriteService(async () => ({ ok: true, scope }));
}

describe("VCS write tool catalog", () => {
  it("registers three write tools and one recovery tool with model-safe parameters", () => {
    expect(VCS_WRITE_TOOLS.map((tool) => tool.name)).toEqual([
      "libra_vcs_stage", "libra_vcs_unstage", "libra_vcs_recover", "libra_vcs_commit",
    ]);
    for (const tool of VCS_WRITE_TOOLS) {
      expect(tool.risk).toBe("write");
      expect(tool.parameters).not.toContain("operation_id");
      expect(tool.parameters).not.toContain("approval");
      expect(tool.parameters).not.toContain("expected_head");
      expect(tool.parameters).not.toContain("session_id");
      expect(tool.required_parameters).toContain("paths");
      expect(tool.required_parameters).not.toContain("approval");
    }
    const names = TOOL_CATALOG.map((tool) => tool.name);
    for (const tool of VCS_WRITE_TOOLS) expect(names).toContain(tool.name);
  });

  it("keeps the legacy facade catalog and policy for non-typed tools", () => {
    const facade = new ToolsFacade({} as BridgeClient, {
      allowRead: true, allowWrite: true, allowRestore: true, allowPushPublish: false,
    });
    expect(facade.supports("vcs.stage")).toBe(false);
  });
});

describe("invokeVcsWriteTool", () => {
  it("maps tool parameters to the shared service and returns the same result as the UI path", async () => {
    const client = fakeClient();
    const writeService = service(client.client);
    const ui = await writeService.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-shared", fence: FENCE },
      USER_ACTION_APPROVAL,
    );
    const tool = await invokeVcsWriteTool(writeService, SESSION, "libra_vcs_stage", {
      paths: ["seed.txt"],
      operation_id: "op-shared",
      approval: { decision: "approved", approver: "dsh-approval" },
    });
    expect(tool.status).toBe("ok");
    expect(tool.operation_id).toBe("op-shared");
    expect(tool.data).toEqual(ui);
    expect(client.calls.at(-1)?.params).toMatchObject({
      operation_id: "op-shared",
      approval: { decision: "approved", approver: "dsh-approval" },
    });
  });

  it("requires Host-injected approval and refuses model-supplied authority fields", async () => {
    const writeService = service(fakeClient().client);
    const base = {
      paths: ["seed.txt"],
      operation_id: "op-tool",
    };
    const missing = await invokeVcsWriteTool(writeService, SESSION, "libra_vcs_stage", base);
    expect(missing.status).toBe("error");
    expect(missing.error?.stable_code).toBe("denied");

    const denied = await invokeVcsWriteTool(writeService, SESSION, "libra_vcs_stage", {
      ...base, approval: { decision: "denied" },
    });
    expect(denied.status).toBe("error");
    expect(denied.error?.stable_code).toBe("denied");

    for (const name of ["libra_vcs_stage", "libra_vcs_unstage", "libra_vcs_commit", "libra_vcs_recover"]) {
      const forged = await invokeVcsWriteTool(writeService, SESSION, name, {
        ...base, message: "seed", approval: { decision: "approved" }, fence: "forged",
        expected_head: "forged", expected_index: "forged", expected_worktree: "forged",
        expectedHead: "forged", operationId: "forged",
      });
      expect(forged.status).toBe("error");
      expect(forged.error?.stable_code).toBe("invalid_params");
    }
  });

  it("reports a bridge refusal as a typed tool error, not a success", async () => {
    const writeService = service(fakeClient({
      "vcs.stage": completed("vcs.stage", { operationId: "op-refused", outcome: "failed", commitOid: null, paths: ["seed.txt"], failures: [] }),
    }).client);
    const refused = await invokeVcsWriteTool(writeService, SESSION, "libra_vcs_stage", {
      paths: ["seed.txt"], operation_id: "op-refused", approval: { decision: "approved", approver: "dsh-approval" },
    });
    expect(refused.status).toBe("error");
    expect(refused.error?.stable_code).toBe("internal");
    expect(JSON.stringify(refused.data)).toContain("failed");
  });

  it("reports a stale or denied outcome as a retryable typed tool error", async () => {
    for (const [outcome, kind, retryable] of [
      ["stale_state", "stale_state", true],
      ["denied", "denied", false],
      ["indeterminate", "indeterminate", false],
    ] as const) {
      const writeService = service(fakeClient({
        "vcs.stage": completed("vcs.stage", { operationId: "op-outcome", outcome, commitOid: null, paths: ["seed.txt"], failures: [] }),
      }).client);
      const result = await invokeVcsWriteTool(writeService, SESSION, "libra_vcs_stage", {
        paths: ["seed.txt"], operation_id: "op-outcome", approval: { decision: "approved", approver: "dsh-approval" },
      });
      expect(result.status).toBe("error");
      expect(result.error?.stable_code).toBe(kind);
      expect(result.error?.retryable).toBe(retryable);
    }
  });

  it("recovers the Host-stored operation with the original operation id and payload", async () => {
    let stageCalls = 0;
    const client = fakeClient();
    const originalRequest = client.client.requestMethod.bind(client.client);
    const requestMethod = vi.fn(async (method: string, params?: unknown) => {
      if (method === "vcs.stage") {
        stageCalls += 1;
        if (stageCalls <= 2) throw new BridgeClientError("request_timeout", "lost response");
        return completed(method, {
          operationId: "host-generated-op",
          outcome: "replayed",
          commitOid: null,
          paths: ["seed.txt"],
          failures: [],
        });
      }
      return originalRequest(method, params);
    });
    const writeService = service({ requestMethod } as unknown as BridgeClient);
    const initial = await invokeVcsWriteTool(writeService, SESSION, "libra_vcs_stage", {
      paths: ["seed.txt"], operation_id: "host-generated-op", approval: { decision: "approved" },
    });
    expect(initial.status).toBe("error");
    expect(initial.error?.stable_code).toBe("indeterminate");
    expect(initial.error?.message).toContain("libra_vcs_recover");
    const recovered = await invokeVcsWriteTool(writeService, SESSION, "libra_vcs_recover", {
      action: "stage", paths: ["seed.txt"], approval: { decision: "approved" },
    });
    expect(recovered.status).toBe("ok");
    expect(recovered.data?.operationId).toBe("host-generated-op");
    expect(stageCalls).toBe(3);
  });

  it("refuses a write whose approved binding no longer matches", async () => {
    const writeService = service(fakeClient().client);
    const denied = await invokeVcsWriteTool(writeService, SESSION, "libra_vcs_stage", {
      paths: ["seed.txt"], operation_id: "op-moved", approval: { decision: "approved", approver: "dsh-approval" },
    }, undefined, { key: "old-key", generation: 1 });
    expect(denied.status).toBe("error");
    expect(denied.error?.stable_code).toBe("cwd_changed");
  });

  it("refuses commit without a message and reports typed failures", async () => {
    const writeService = service(fakeClient().client);
    const base = {
      paths: ["seed.txt"],
      operation_id: "op-commit",
      approval: { decision: "approved", approver: "dsh-approval" },
    };
    const noMessage = await invokeVcsWriteTool(writeService, SESSION, "libra_vcs_commit", base);
    expect(noMessage.status).toBe("error");
    expect(noMessage.error?.stable_code).toBe("invalid_params");

    const stale = await invokeVcsWriteTool(
      service(fakeClient({ "vcs.commit": new BridgeClientError("request_timeout", "timed out") }).client),
      SESSION,
      "libra_vcs_commit",
      { ...base, message: "seed" },
    );
    expect(stale.status).toBe("error");
    expect(stale.error?.stable_code).toBe("indeterminate");
    expect(stale.error?.retryable).toBe(false);
  });
});
