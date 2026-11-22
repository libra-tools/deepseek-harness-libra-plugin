import { describe, expect, it, vi } from "vitest";

import { BridgeClientError, type BridgeClient, type CompletedRequest } from "@libra/dsh-bridge-client";
import {
  LibraVcsWriteService,
  USER_ACTION_APPROVAL,
  VcsHostError,
  normalizeFence,
  validateWritePaths,
  type VcsWriteFence,
  type VcsWriteScope,
} from "@libra/dsh-bundle";
import { VCS_WRITE_TOOLS } from "@libra/dsh-tools";

const FENCE: VcsWriteFence = {
  expectedHead: "a".repeat(40),
  expectedIndex: "b".repeat(64),
  expectedWorktree: "c".repeat(64),
};

const STATUS_WITH_FENCE = {
  ok: true,
  data: {
    writeFence: { head: FENCE.expectedHead, indexGeneration: FENCE.expectedIndex, worktreeGeneration: FENCE.expectedWorktree },
    bindingKey: "key-1",
    bindingGeneration: 3,
  },
};

function completed(method: string, result: unknown): CompletedRequest {
  return { id: 1, method, state: "success", result };
}

function failed(method: string, message: string, stableCode?: string, retryable = false): CompletedRequest {
  return {
    id: 1,
    method,
    state: "error",
    error: { code: -32000, message, data: { ...(stableCode === undefined ? {} : { stable_code: stableCode }), retryable } },
  };
}

interface FakeBridgeOptions {
  methods?: string[];
  responses?: Record<string, CompletedRequest | Error>;
}

function fakeBridge(options: FakeBridgeOptions = {}) {
  const methods = options.methods ?? ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"];
  const calls: Array<{ method: string; params: unknown }> = [];
  const requestMethod = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params });
    const response = options.responses?.[method];
    if (response instanceof Error) throw response;
    if (response !== undefined) return response;
    if (method === "vcs.status") return completed(method, STATUS_WITH_FENCE);
    if (method === "vcs.stage") {
      const input = params as { operation_id: string; paths: string[] };
      return completed(method, { ok: true, data: { operationId: input.operation_id, outcome: "applied", commitOid: null, paths: input.paths, failures: [] } });
    }
    if (method === "vcs.unstage") {
      const input = params as { operation_id: string; paths: string[] };
      return completed(method, { ok: true, data: { operationId: input.operation_id, outcome: "applied", commitOid: null, paths: input.paths, failures: [] } });
    }
    return completed(method, { ok: true, data: { operationId: "op-commit", outcome: "applied", commitOid: "d".repeat(40), paths: ["seed.txt"], failures: [] } });
  });
  const client = { requestMethod } as unknown as BridgeClient;
  return { client, methods, calls, requestMethod };
}

function serviceWith(bridge: ReturnType<typeof fakeBridge>, overrides: Partial<VcsWriteScope> = {}) {
  const validate = vi.fn(async () => undefined);
  const scope: VcsWriteScope = {
    client: bridge.client,
    methods: bridge.methods,
    bindingKey: "key-1",
    generation: 3,
    validate,
    ...overrides,
  };
  const service = new LibraVcsWriteService(async () => ({ ok: true, scope }));
  return { service, validate };
}

const SESSION = { id: "session-1" };

describe("LibraVcsWriteService", () => {
  it("reads a fence from vcs.status and refuses one that cannot be fenced", async () => {
    const bridge = fakeBridge();
    const { service } = serviceWith(bridge);
    const fence = await service.fence(SESSION);
    expect(fence).toEqual({ ...FENCE, bindingKey: "key-1", bindingGeneration: 3 });
    expect(bridge.calls.map((call) => call.method)).toEqual(["vcs.status"]);

    const unfenceable = fakeBridge({ responses: { "vcs.status": completed("vcs.status", { ok: true, data: { entries: [], cursor: { next: null } } }) } });
    const second = serviceWith(unfenceable).service;
    await expect(second.fence(SESSION)).rejects.toMatchObject({ kind: "stale_state", retryable: true });
  });

  it("stages literal paths with the supplied fence and attaches binding identity", async () => {
    const bridge = fakeBridge({ responses: { "vcs.status": completed("vcs.status", STATUS_WITH_FENCE) } });
    const { service, validate } = serviceWith(bridge);
    const result = await service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-stage", fence: FENCE },
      USER_ACTION_APPROVAL,
    );
    expect(result).toEqual({
      operationId: "op-stage",
      outcome: "applied",
      commitOid: null,
      paths: ["seed.txt"],
      failures: [],
      bindingKey: "key-1",
      bindingGeneration: 3,
    });
    expect(bridge.calls.at(-1)?.params).toMatchObject({
      operation_id: "op-stage",
      paths: ["seed.txt"],
      expectedHead: FENCE.expectedHead,
      expectedIndex: FENCE.expectedIndex,
      expectedWorktree: FENCE.expectedWorktree,
      approval: { decision: "approved", approver: "dsh-user-action" },
    });
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("unstage and commit share the same validation and result contract", async () => {
    const bridge = fakeBridge();
    const { service } = serviceWith(bridge);
    const unstage = await service.unstage(SESSION, { paths: ["seed.txt"], operationId: "op-unstage", fence: FENCE }, USER_ACTION_APPROVAL);
    expect(unstage.outcome).toBe("applied");
    const commitBridge = fakeBridge({
      responses: {
        "vcs.commit": completed("vcs.commit", {
          ok: true,
          data: { operationId: "op-commit", outcome: "applied", commitOid: "d".repeat(40), paths: ["seed.txt"], failures: [] },
        }),
      },
    });
    const commit = await serviceWith(commitBridge).service.commit(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-commit", fence: FENCE, message: "  seed  " },
      USER_ACTION_APPROVAL,
    );
    expect(commit.commitOid).toBe("d".repeat(40));
    expect(commitBridge.calls.at(-1)?.params).toMatchObject({
      operation_id: "op-commit",
      paths: ["seed.txt"],
      message: "seed",
      approval: { decision: "approved", approver: "dsh-user-action" },
    });
  });

  it("rejects a denial, bad paths, bad fences and bad messages before any bridge write", async () => {
    const bridge = fakeBridge();
    const { service } = serviceWith(bridge);
    await expect(service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-denied", fence: FENCE }, { decision: "denied" }))
      .rejects.toMatchObject({ kind: "denied" });
    expect(bridge.calls).toEqual([]);

    for (const path of ["/etc/passwd", "../outside", "dir\\file", ":path", "*.ts", "a//b", "file/"]) {
      await expect(service.stage(SESSION, { paths: [path], operationId: "op-path", fence: FENCE }, USER_ACTION_APPROVAL))
        .rejects.toMatchObject({ kind: "invalid_params" });
    }
    await expect(service.stage(SESSION, { paths: [], operationId: "op-empty", fence: FENCE }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "invalid_params" });
    await expect(service.stage(SESSION, { paths: Array.from({ length: 65 }, (_, index) => `p${index}.txt`), operationId: "op-long", fence: FENCE }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "invalid_params" });
    await expect(service.commit(SESSION, { paths: ["seed.txt"], operationId: "op-msg", fence: FENCE, message: "  " }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "invalid_params" });
    await expect(service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-fence", fence: { expectedHead: "zz", expectedIndex: "1", expectedWorktree: "2" } as never }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "invalid_params" });
    expect(bridge.calls).toEqual([]);
  });

  it("refuses a method the bridge did not negotiate", async () => {
    const bridge = fakeBridge({ methods: ["vcs.status"] });
    const { service } = serviceWith(bridge);
    await expect(service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-unsupported", fence: FENCE }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "unsupported_capability" });
    expect(bridge.calls).toEqual([]);
  });

  it("maps bridge failures to stable host kinds", async () => {
    for (const [stable, kind] of [
      ["LBR-AGENT-038", "stale_state"],
      ["LBR-AGENT-035", "denied"],
      ["LBR-AGENT-027", "invalid_params"],
      ["LBR-AGENT-033", "conflict"],
    ] as const) {
      const bridge = fakeBridge({ responses: { "vcs.stage": failed("vcs.stage", "refused", stable) } });
      await expect(serviceWith(bridge).service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-fail", fence: FENCE }, USER_ACTION_APPROVAL))
        .rejects.toMatchObject({ kind });
    }
    const timeoutBridge = fakeBridge({ responses: { "vcs.stage": new BridgeClientError("request_timeout", "timed out") } });
    await expect(serviceWith(timeoutBridge).service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-timeout", fence: FENCE }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate", retryable: false });
  });

  it("rejects a bridge result that mismatches the authorized operation or paths", async () => {
    const wrongOperation = fakeBridge({
      responses: {
        "vcs.stage": completed("vcs.stage", { ok: true, data: { operationId: "other", outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } }),
      },
    });
    await expect(serviceWith(wrongOperation).service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-mismatch", fence: FENCE }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate", retryable: false });

    const wrongPath = fakeBridge({
      responses: {
        "vcs.stage": completed("vcs.stage", { ok: true, data: { operationId: "op-path", outcome: "applied", commitOid: null, paths: ["other.txt"], failures: [] } }),
      },
    });
    await expect(serviceWith(wrongPath).service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-path", fence: FENCE }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate", retryable: false });

    const badCommit = fakeBridge({
      responses: {
        "vcs.commit": completed("vcs.commit", { ok: true, data: { operationId: "op-commit", outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } }),
      },
    });
    await expect(serviceWith(badCommit).service.commit(SESSION, { paths: ["seed.txt"], operationId: "op-commit", fence: FENCE, message: "seed" }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate", retryable: false });
  });

  it("refuses a write when the binding observed by the caller changed", async () => {
    const bridge = fakeBridge();
    const { service } = serviceWith(bridge);
    await expect(service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-rebind", fence: FENCE, binding: { key: "old-key", generation: 2 } },
      USER_ACTION_APPROVAL,
    )).rejects.toMatchObject({ kind: "cwd_changed", retryable: true });
    expect(bridge.calls).toEqual([]);
  });

  it("reads the host-issued fence when the caller (Agent path) omits it", async () => {
    const bridge = fakeBridge();
    const { service } = serviceWith(bridge);
    const result = await service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-host-fence" },
      USER_ACTION_APPROVAL,
    );
    expect(result.operationId).toBe("op-host-fence");
    expect(bridge.calls.map((call) => call.method)).toEqual(["vcs.status", "vcs.stage"]);
    const stageParams = bridge.calls.at(-1)?.params as Record<string, unknown>;
    expect(stageParams).toMatchObject({
      expectedHead: FENCE.expectedHead,
      expectedIndex: FENCE.expectedIndex,
      expectedWorktree: FENCE.expectedWorktree,
    });
  });

  it("recovers an internal commit failure by replaying the same operation id", async () => {
    let calls = 0;
    const responses: CompletedRequest[] = [
      failed("vcs.commit", "commit.create: details withheld", "LBR-AGENT-037"),
      completed("vcs.commit", {
        ok: true,
        data: { operationId: "op-recover", outcome: "replayed", commitOid: "e".repeat(40), paths: ["seed.txt"], failures: [] },
      }),
    ];
    const requestMethod = vi.fn(async (method: string, params?: unknown) => {
      calls += 1;
      void params;
      return responses[Math.min(calls - 1, responses.length - 1)] ?? failed(method, "unexpected");
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    const result = await service.commit(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-recover", fence: FENCE, message: "recovered" },
      USER_ACTION_APPROVAL,
    );
    expect(result.outcome).toBe("replayed");
    expect(result.commitOid).toBe("e".repeat(40));
    expect(requestMethod).toHaveBeenCalledTimes(2);
    expect(requestMethod.mock.calls[0]?.[1]).toEqual(requestMethod.mock.calls[1]?.[1]);
  });

  it("replays once after a timeout or disconnect so the caller need not re-issue", async () => {
    for (const mode of ["throw", "response"] as const) {
      let stageCalls = 0;
      const requestMethod = vi.fn(async (method: string) => {
        if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
        stageCalls += 1;
        if (stageCalls === 1) {
          if (mode === "throw") throw new BridgeClientError("request_timeout", "no answer");
          return failed("vcs.stage", "timeout", "LBR-AGENT-036", true);
        }
        return completed("vcs.stage", {
          ok: true,
          data: { operationId: "op-transport", outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] },
        });
      });
      const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
      const result = await serviceWith(bridge).service.stage(
        SESSION,
        { paths: ["seed.txt"], operationId: "op-transport" },
        USER_ACTION_APPROVAL,
      );
      expect(result.outcome).toBe("replayed");
      expect(stageCalls).toBe(2);
    }
  });

  it("reports cancellation before dispatch without touching the bridge", async () => {
    const bridge = fakeBridge();
    const { service } = serviceWith(bridge);
    const controller = new AbortController();
    controller.abort();
    await expect(service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-cancelled" },
      USER_ACTION_APPROVAL,
      { signal: controller.signal },
    )).rejects.toMatchObject({ kind: "cancelled" });
    expect(bridge.calls).toEqual([]);
  });

  it("reports post-dispatch cancellation as indeterminate", async () => {
    const controller = new AbortController();
    const requestMethod = vi.fn(async (method: string, _params?: unknown, signal?: AbortSignal) => {
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      // The caller aborts after the bridge received (and possibly applied) the write.
      controller.abort();
      void signal;
      throw new BridgeClientError("request_cancelled", "caller left");
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const service = serviceWith(bridge).service;
    await expect(service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-late-cancel" },
      USER_ACTION_APPROVAL,
      { signal: controller.signal },
    )).rejects.toMatchObject({ kind: "indeterminate", retryable: false });
  });

  it("keeps a successful post-dispatch response even if the caller aborted meanwhile", async () => {
    const controller = new AbortController();
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      controller.abort();
      return completed("vcs.stage", { ok: true, data: { operationId: "op-late-success", outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const result = await serviceWith(bridge).service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-late-success" },
      USER_ACTION_APPROVAL,
      { signal: controller.signal },
    );
    expect(result.outcome).toBe("applied");
  });

  it("replays an identical UI operation through stage after an indeterminate outcome", async () => {
    let calls = 0;
    const bridgeCalls: Array<{ method: string; params: unknown }> = [];
    const requestMethod = vi.fn(async (method: string, params?: unknown) => {
      bridgeCalls.push({ method, params });
      if (method === "vcs.status") return completed(method, { ok: true, data: STATUS_WITH_FENCE.data });
      calls += 1;
      const input = params as { operation_id: string; paths: string[] };
      return completed(method, {
        ok: true,
        data: {
          operationId: input.operation_id,
          outcome: calls === 1 ? "indeterminate" : "replayed",
          commitOid: null,
          paths: input.paths,
          failures: [],
        },
      });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    const original = { paths: ["seed.txt"], operationId: "op-panel-retry", fence: FENCE, binding: { key: "key-1", generation: 3 } };
    const first = await service.stage(SESSION, original, USER_ACTION_APPROVAL);
    expect(first.outcome).toBe("indeterminate");
    const replayed = await service.stage(SESSION, original, USER_ACTION_APPROVAL);
    expect(replayed.outcome).toBe("replayed");
    const stagePayloads = bridgeCalls.filter(({ method }) => method === "vcs.stage").map(({ params }) => params);
    expect(stagePayloads[1]).toEqual(stagePayloads[0]);
  });

  it("recovers the stored indeterminate operation after state is reconciled", async () => {
    let stageCalls = 0;
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      stageCalls += 1;
      if (stageCalls === 1) throw new BridgeClientError("request_timeout", "no answer");
      if (stageCalls === 2) throw new BridgeClientError("request_timeout", "still no answer");
      return completed("vcs.stage", { ok: true, data: { operationId: "op-recover", outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    await expect(service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-recover" }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate" });
    const recovered = await service.recover(SESSION, { action: "stage", paths: ["seed.txt"] }, USER_ACTION_APPROVAL);
    expect(recovered.outcome).toBe("replayed");
    await expect(service.recover(SESSION, { action: "stage", paths: ["seed.txt"] }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "invalid_params" });
  });

  it("keeps the unresolved record when recovery is attempted against another binding", async () => {
    let stageCalls = 0;
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed(method, { ok: true, data: STATUS_WITH_FENCE.data });
      stageCalls += 1;
      if (stageCalls <= 2) throw new BridgeClientError("request_timeout", "no answer");
      return completed(method, { ok: true, data: { operationId: "op-retained", outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    await expect(service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-retained" }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate" });
    await expect(service.recover(
      SESSION, { action: "stage", paths: ["seed.txt"] }, USER_ACTION_APPROVAL, {}, { key: "other-key", generation: 3 },
    )).rejects.toMatchObject({ kind: "cwd_changed" });
    const recovered = await service.recover(SESSION, { action: "stage", paths: ["seed.txt"] }, USER_ACTION_APPROVAL);
    expect(recovered.outcome).toBe("replayed");
    expect(stageCalls).toBe(3);
  });

  it("keeps the unresolved record when recovery stays malformed", async () => {
    let stageCalls = 0;
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed(method, { ok: true, data: STATUS_WITH_FENCE.data });
      stageCalls += 1;
      if (stageCalls === 1) {
        return completed(method, { ok: true, data: { operationId: "op-malformed-recover", outcome: "indeterminate", commitOid: null, paths: ["seed.txt"], failures: [] } });
      }
      if (stageCalls <= 3) {
        return completed(method, { ok: true, data: { operationId: "wrong", outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } });
      }
      return completed(method, { ok: true, data: { operationId: "op-malformed-recover", outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    const first = await service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-malformed-recover" }, USER_ACTION_APPROVAL);
    expect(first.outcome).toBe("indeterminate");
    await expect(service.recover(SESSION, { action: "stage", paths: ["seed.txt"] }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate" });
    const recovered = await service.recover(SESSION, { action: "stage", paths: ["seed.txt"] }, USER_ACTION_APPROVAL);
    expect(recovered.outcome).toBe("replayed");
  });

  it("bounds retained unresolved writes and refuses dispatch at capacity", async () => {
    const requestMethod = vi.fn(async (method: string, params?: unknown) => {
      if (method === "vcs.status") return completed(method, { ok: true, data: STATUS_WITH_FENCE.data });
      const input = params as { operation_id: string; paths: string[] };
      return completed(method, {
        ok: true,
        data: { operationId: input.operation_id, outcome: "indeterminate", commitOid: null, paths: input.paths, failures: [] },
      });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    for (let index = 0; index < 256; index += 1) {
      const session = { id: `unresolved-${index}` };
      const result = await service.stage(session, { paths: [`p${index}.txt`], operationId: `op-${index}` }, USER_ACTION_APPROVAL);
      expect(result.outcome).toBe("indeterminate");
    }
    await expect(service.stage(
      { id: "unresolved-over-cap" },
      { paths: ["over-cap.txt"], operationId: "op-over-cap" },
      USER_ACTION_APPROVAL,
    )).rejects.toMatchObject({ kind: "conflict" });
    expect(requestMethod.mock.calls.filter(([method]) => method === "vcs.stage")).toHaveLength(256);
  });

  it("rejects a concurrent write while another mutation is still in flight", async () => {
    let releaseStage!: (response: CompletedRequest) => void;
    let started!: () => void;
    const stageStarted = new Promise<void>((resolve) => { started = resolve; });
    const bridgeCalls: string[] = [];
    const requestMethod = vi.fn(async (method: string, params?: unknown) => {
      bridgeCalls.push(method);
      if (method === "vcs.status") return completed(method, { ok: true, data: STATUS_WITH_FENCE.data });
      if (method === "vcs.stage") {
        const input = params as { operation_id: string; paths: string[] };
        started();
        return new Promise<CompletedRequest>((resolve) => { releaseStage = resolve; }).then(() =>
          completed(method, { ok: true, data: { operationId: input.operation_id, outcome: "applied", commitOid: null, paths: input.paths, failures: [] } }));
      }
      return completed(method, { ok: true, data: { operationId: "op-unstage", outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    const first = service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-in-flight" }, USER_ACTION_APPROVAL);
    await stageStarted;
    await expect(service.unstage(SESSION, { paths: ["seed.txt"], operationId: "op-parallel" }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "conflict" });
    expect(bridgeCalls.filter((method) => method === "vcs.unstage")).toHaveLength(0);
    releaseStage(completed("vcs.stage", {}));
    await expect(first).resolves.toMatchObject({ outcome: "applied" });
  });

  it("blocks every new write while one operation is unresolved and then replays the exact payload", async () => {
    let stageCalls = 0;
    const bridgeCalls: Array<{ method: string; params: unknown }> = [];
    const requestMethod = vi.fn(async (method: string, params?: unknown) => {
      bridgeCalls.push({ method, params });
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      if (method === "vcs.stage") {
        stageCalls += 1;
        if (stageCalls < 3) throw new BridgeClientError("request_timeout", "no answer");
        const body = params as { operation_id: string; paths: string[] };
        return completed(method, { ok: true, data: { operationId: body.operation_id, outcome: "replayed", commitOid: null, paths: body.paths, failures: [] } });
      }
      return completed(method, { ok: true, data: { operationId: "unexpected", outcome: "applied", commitOid: "d".repeat(40), paths: ["seed.txt"], failures: [] } });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    await expect(service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-single-flight" }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate" });
    await expect(service.commit(SESSION, { paths: ["seed.txt"], operationId: "op-overwrite", message: "new commit" }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "conflict" });
    expect(bridgeCalls.filter(({ method }) => method === "vcs.commit")).toHaveLength(0);

    const recovered = await service.recover(SESSION, { action: "stage", paths: ["seed.txt"] }, USER_ACTION_APPROVAL);
    expect(recovered.outcome).toBe("replayed");
    const stageParams = bridgeCalls.filter(({ method }) => method === "vcs.stage").map(({ params }) => params);
    expect(stageParams[2]).toEqual(stageParams[0]);
  });

  it("refuses recovery for a different path set or binding", async () => {
    let stageCalls = 0;
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      stageCalls += 1;
      throw new BridgeClientError("request_timeout", "no answer");
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    await expect(service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-recover-mismatch" }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate" });
    await expect(service.recover(SESSION, { action: "stage", paths: ["other.txt"] }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "invalid_params" });
    await expect(service.recover(
      SESSION, { action: "stage", paths: ["seed.txt"] }, USER_ACTION_APPROVAL, {}, { key: "old-key", generation: 1 },
    )).rejects.toMatchObject({ kind: "cwd_changed" });
    expect(stageCalls).toBe(2);
  });

  it("refuses a projection-error replay after the Session binding changed", async () => {
    let validations = 0;
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      return completed("vcs.stage", { ok: true, data: { operationId: "wrong", outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const scope: VcsWriteScope = {
      client: bridge.client,
      methods: bridge.methods,
      bindingKey: "key-1",
      generation: 3,
      validate: async () => {
        validations += 1;
        if (validations > 1) throw new VcsHostError("cwd_changed", "moved", true);
      },
    };
    const service = new LibraVcsWriteService(async () => ({ ok: true, scope }));
    await expect(service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-malformed-moved", fence: FENCE, binding: { key: "key-1", generation: 3 } },
      USER_ACTION_APPROVAL,
    )).rejects.toMatchObject({ kind: "indeterminate", retryable: false });
    expect(requestMethod.mock.calls.filter(([method]) => method === "vcs.stage")).toHaveLength(1);
  });

  it("refuses to replay after the Session binding changed", async () => {
    let validations = 0;
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      throw new BridgeClientError("request_timeout", "no answer");
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const scope: VcsWriteScope = {
      client: bridge.client,
      methods: bridge.methods,
      bindingKey: "key-1",
      generation: 3,
      validate: async () => {
        validations += 1;
        if (validations > 1) throw new VcsHostError("cwd_changed", "moved", true);
      },
    };
    const service = new LibraVcsWriteService(async () => ({ ok: true, scope }));
    await expect(service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-moved-replay", fence: FENCE, binding: { key: "key-1", generation: 3 } },
      USER_ACTION_APPROVAL,
    )).rejects.toMatchObject({ kind: "indeterminate", retryable: false });
    expect(requestMethod.mock.calls.filter(([method]) => method === "vcs.stage")).toHaveLength(1);
  });

  it("recovers a malformed success response by replaying the recorded result", async () => {
    const responses: CompletedRequest[] = [
      completed("vcs.stage", { ok: true, data: { operationId: "wrong", outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } }),
      completed("vcs.stage", { ok: true, data: { operationId: "op-malformed", outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } }),
    ];
    let stageCalls = 0;
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      stageCalls += 1;
      return responses[Math.min(stageCalls - 1, responses.length - 1)]!;
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const result = await serviceWith(bridge).service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-malformed" },
      USER_ACTION_APPROVAL,
    );
    expect(result.outcome).toBe("replayed");
    expect(stageCalls).toBe(2);
  });

  it("returns indeterminate when post-dispatch projection stays malformed", async () => {
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      return completed("vcs.stage", { ok: true, data: { operationId: "wrong", outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    await expect(serviceWith(bridge).service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-bad" },
      USER_ACTION_APPROVAL,
    )).rejects.toMatchObject({ kind: "indeterminate", retryable: false });
  });

  it("returns indeterminate, without replaying into a new binding, when validation fails after dispatch", async () => {
    const bridge = fakeBridge();
    let validations = 0;
    const validate = vi.fn(async () => {
      validations += 1;
      if (validations > 1) throw new VcsHostError("cwd_changed", "moved", true);
    });
    const scope: VcsWriteScope = {
      client: bridge.client,
      methods: bridge.methods,
      bindingKey: "key-1",
      generation: 3,
      validate,
    };
    const service = new LibraVcsWriteService(async () => ({ ok: true, scope }));
    await expect(service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-validated", fence: FENCE, binding: { key: "key-1", generation: 3 } },
      USER_ACTION_APPROVAL,
    )).rejects.toMatchObject({ kind: "indeterminate", retryable: false });
    expect(bridge.calls.filter((call) => call.method === "vcs.stage")).toHaveLength(1);
  });

  it("keeps a post-dispatch protocol violation recoverable", async () => {
    let stageCalls = 0;
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed(method, { ok: true, data: STATUS_WITH_FENCE.data });
      stageCalls += 1;
      if (stageCalls === 1) throw new BridgeClientError("protocol_violation", "unexpected response id");
      return completed(method, { ok: true, data: { operationId: "op-protocol", outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    await expect(service.stage(SESSION, { paths: ["seed.txt"], operationId: "op-protocol" }, USER_ACTION_APPROVAL))
      .rejects.toMatchObject({ kind: "indeterminate", retryable: false });
    const recovered = await service.recover(SESSION, { action: "stage", paths: ["seed.txt"] }, USER_ACTION_APPROVAL);
    expect(recovered.outcome).toBe("replayed");
    expect(stageCalls).toBe(2);
  });

  it("reports a non-retryable indeterminate error when both attempts are uncertain", async () => {
    const requestMethod = vi.fn(async (method: string) => {
      if (method === "vcs.status") return completed("vcs.status", { ok: true, data: STATUS_WITH_FENCE.data });
      throw new BridgeClientError("request_timeout", "no answer");
    });
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    await expect(serviceWith(bridge).service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-uncertain" },
      USER_ACTION_APPROVAL,
    )).rejects.toMatchObject({ kind: "indeterminate", retryable: false });
    expect(requestMethod.mock.calls.filter(([method]) => method === "vcs.stage")).toHaveLength(2);
  });

  it("surfaces the second failure when a replay cannot recover the commit", async () => {
    const requestMethod = vi.fn(async () => failed("vcs.commit", "still failing", "LBR-AGENT-037"));
    const bridge = { client: { requestMethod } as unknown as BridgeClient, methods: ["vcs.status", "vcs.stage", "vcs.unstage", "vcs.commit"] };
    const { service } = serviceWith(bridge);
    await expect(service.commit(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-double-fail", fence: FENCE, message: "still" },
      USER_ACTION_APPROVAL,
    )).rejects.toMatchObject({ kind: "indeterminate", retryable: false });
    expect(requestMethod).toHaveBeenCalledTimes(2);
  });

  it("passes outcomes through and keeps failures structured", async () => {
    const replayed = fakeBridge({
      responses: {
        "vcs.stage": completed("vcs.stage", {
          ok: true,
          data: { operationId: "op-replay", outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [{ path: "seed.txt", message: "ignored" }] },
        }),
      },
    });
    const result = await serviceWith(replayed).service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-replay", fence: FENCE },
      USER_ACTION_APPROVAL,
    );
    expect(result.outcome).toBe("replayed");
    expect(result.failures).toEqual([{ path: "seed.txt", message: "ignored" }]);
  });

  it("serves the same operation to UI and Agent tool entry points", async () => {
    const uiBridge = fakeBridge();
    const ui = await serviceWith(uiBridge).service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-shared", fence: FENCE },
      USER_ACTION_APPROVAL,
    );
    const toolBridge = fakeBridge();
    const tool = await serviceWith(toolBridge).service.stage(
      SESSION,
      { paths: ["seed.txt"], operationId: "op-shared", fence: FENCE },
      { decision: "approved", approver: "dsh-approval" },
    );
    expect(tool).toEqual(ui);
    expect(toolBridge.calls.at(-1)?.params).toMatchObject({ approval: { decision: "approved", approver: "dsh-approval" } });
  });
});

describe("VCS write validation helpers and tool catalog", () => {
  it("exposes literal-path and fence validation", () => {
    expect(validateWritePaths(["dir/file.txt", "seed.txt"])).toEqual(["dir/file.txt", "seed.txt"]);
    expect(() => validateWritePaths(["same", "same"])).toThrowError(/duplicates/);
    expect(normalizeFence({ head: null, indexGeneration: "ab", worktreeGeneration: "cd" }))
      .toEqual({ expectedHead: null, expectedIndex: "ab", expectedWorktree: "cd" });
  });

  it("registers the three mutations and recovery tool without model-controlled authority fields", () => {
    expect(VCS_WRITE_TOOLS.map((tool) => tool.name)).toEqual([
      "libra_vcs_stage", "libra_vcs_unstage", "libra_vcs_recover", "libra_vcs_commit",
    ]);
    for (const tool of VCS_WRITE_TOOLS) {
      expect(tool.risk).toBe("write");
      expect(tool.bridge_method.startsWith("vcs.")).toBe(true);
      expect(tool.parameters).not.toContain("approval");
      expect(tool.parameters).not.toContain("operation_id");
      expect(tool.parameters).not.toContain("session_id");
      expect(tool.parameters).not.toContain("fence");
    }
  });
});
