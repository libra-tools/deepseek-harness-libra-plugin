/**
 * Typed Libra VCS read methods and the Host read service (plan-20261118 LVC-04).
 *
 * A fake bridge client stands in for the child process so validation,
 * capability negotiation, error classes and cancellation can be checked
 * without spawning a bridge.
 */
import { describe, expect, it } from "vitest";

import {
  VCS_READ_METHODS,
  VcsReadError,
  VcsReadMethods,
  type BridgeClient,
  type CompletedRequest,
} from "@libra/dsh-bridge-client";
import { LibraVcsReadService, VcsHostError } from "@libra/dsh-bundle";

interface FakeBridge {
  methods: string[] | undefined;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  respond: (method: string) => CompletedRequest;
}

function fakeBridge(
  methods: string[] = [...VCS_READ_METHODS],
  respond: FakeBridge["respond"] = () => ({ id: 1, method: "", state: "success", result: { data: {} } }),
  handshaken = true,
): { client: BridgeClient; fake: FakeBridge } {
  const fake: FakeBridge = { methods, requests: [], respond };
  const client = {
    get negotiatedCapabilities() {
      return handshaken
        ? { protocol: { major: 1, minor: 2 }, limits: {}, methods: fake.methods, source: "fake" }
        : undefined;
    },
    async requestMethod(method: string, params: Record<string, unknown>) {
      fake.requests.push({ method, params });
      return fake.respond(method);
    },
  } as unknown as BridgeClient;
  return { client, fake };
}

const success = (method: string, data: Record<string, unknown>): CompletedRequest => ({
  id: 1,
  method,
  state: "success",
  result: { data },
});

describe("typed VCS read methods", () => {
  it("pages status with a validated cursor and explicit next cursor", async () => {
    const { client, fake } = fakeBridge([...VCS_READ_METHODS], (method) => method === "vcs.status"
      ? success(method, { entries: [{ path: "src/a.ts", state: "staged", oldPath: null }, { path: "b.md", state: "rename", oldPath: "old-b.md" }], cursor: { next: "40" } })
      : success(method, {}));
    const read = new VcsReadMethods(client);

    const page = await read.status({ cursor: "20", limit: 20 });

    expect(fake.requests).toEqual([{ method: "vcs.status", params: { cursor: "20", limit: 20 } }]);
    expect(page.entries).toEqual([
      { path: "src/a.ts", state: "staged", oldPath: null },
      { path: "b.md", state: "rename", oldPath: "old-b.md" },
    ]);
    expect(page.cursor.next).toBe("40");
    expect(page.entries.some((entry) => entry.path.startsWith("/"))).toBe(false);
  });

  it("rejects a malformed cursor and an out-of-range limit before any request", async () => {
    const { client, fake } = fakeBridge();
    const read = new VcsReadMethods(client);

    await expect(read.log({ cursor: "abc" })).rejects.toMatchObject({ kind: "cursor_invalid" });
    await expect(read.log({ cursor: String(100_001) })).rejects.toMatchObject({ kind: "cursor_invalid" });
    await expect(read.status({ limit: 0 })).rejects.toMatchObject({ kind: "invalid_params" });
    await expect(read.status({ limit: 101 })).rejects.toMatchObject({ kind: "invalid_params" });
    await expect(read.show({ oid: "HEAD..main" })).rejects.toMatchObject({ kind: "invalid_params" });
    expect(fake.requests).toHaveLength(0);
  });

  it("reports an unadvertised method as unsupported_capability", async () => {
    const { client } = fakeBridge(["vcs.status", "vcs.log"]);
    const read = new VcsReadMethods(client);

    await expect(read.diff({ sides: "worktree-vs-index" })).rejects.toMatchObject({
      kind: "unsupported_capability",
      retryable: false,
    });
    expect(read.availableMethods()).toEqual(["vcs.status", "vcs.log"]);
  });

  it("rejects unrelated diff OIDs, malformed object ids and unsafe path selectors before a request", async () => {
    const { client, fake } = fakeBridge();
    const read = new VcsReadMethods(client);

    await expect(read.diff({ sides: "worktree-vs-index", oid: "a".repeat(40) })).rejects.toMatchObject({ kind: "invalid_params" });
    await expect(read.diff({ sides: "worktree-vs-oid", oid: "not-an-object-id" })).rejects.toMatchObject({ kind: "invalid_params" });
    for (const path of ["/etc/passwd", "../secret", ":(exclude)*", "src/*.ts", "src\\\\x.ts", ""]) {
      await expect(read.diff({ sides: "worktree-vs-index", paths: [path] })).rejects.toMatchObject({ kind: "invalid_params" });
    }
    await expect(read.diff({ sides: "worktree-vs-index", paths: Array.from({ length: 65 }, (_, index) => `p${index}`) }))
      .rejects.toMatchObject({ kind: "invalid_params" });
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects a malformed successful bridge payload instead of presenting an empty repository", async () => {
    const { client } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, {}));
    await expect(new VcsReadMethods(client).status()).rejects.toMatchObject({ kind: "internal" });
  });

  it("refuses absolute or unknown status entries from a malformed bridge", async () => {
    for (const entry of [
      { path: "/etc/passwd", state: "staged", oldPath: null },
      { path: "src/a.ts", state: "future-state", oldPath: null },
    ]) {
      const { client } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, {
        entries: [entry], cursor: { next: null },
      }));
      await expect(new VcsReadMethods(client).status()).rejects.toMatchObject({ kind: "internal" });
    }
  });

  it("rejects contradictory diff metadata instead of presenting an omitted patch as complete", async () => {
    const cases: Array<Record<string, unknown>> = [
      // A file claims complete while its patch is absent.
      { sides: "worktree-vs-index", byteCap: 131072, truncated: false, truncation: "none",
        files: [{ path: "a.ts", oldPath: null, patch: null, truncated: false, truncation: "none" }] },
      // A file says it is complete while it carries truncation metadata.
      { sides: "worktree-vs-index", byteCap: 131072, truncated: true, truncation: "byte_cap",
        files: [{ path: "a.ts", oldPath: null, patch: null, truncated: false, truncation: "byte_cap" }] },
      // The aggregate says untruncated while a file is binary.
      { sides: "worktree-vs-index", byteCap: 131072, truncated: false, truncation: "none",
        files: [{ path: "a.ts", oldPath: null, patch: null, truncated: true, truncation: "binary" }] },
      // The aggregate claims a page cap but is not marked truncated.
      { sides: "worktree-vs-index", byteCap: 131072, truncated: false, truncation: "page_cap",
        files: [{ path: "a.ts", oldPath: null, patch: "diff", truncated: false, truncation: "none" }] },
      // A binary file must carry the truncated flag.
      { sides: "worktree-vs-index", byteCap: 131072, truncated: true, truncation: "binary",
        files: [{ path: "a.ts", oldPath: null, patch: null, truncated: false, truncation: "binary" }] },
    ];
    for (const data of cases) {
      const { client } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, data));
      await expect(new VcsReadMethods(client).diff({ sides: "worktree-vs-index" })).rejects.toMatchObject({ kind: "internal" });
    }
  });

  it("accepts a page-capped diff whose returned files are all complete", async () => {
    const { client } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, {
      sides: "worktree-vs-index", byteCap: 131072, truncated: true, truncation: "page_cap",
      files: [{ path: "a.ts", oldPath: null, patch: "diff --git a/a.ts b/a.ts", truncated: false, truncation: "none" }],
    }));
    const diff = await new VcsReadMethods(client).diff({ sides: "worktree-vs-index", limit: 1 });
    expect(diff).toMatchObject({ truncated: true, truncation: "page_cap" });
    expect(diff.files[0]).toMatchObject({ path: "a.ts", truncated: false, truncation: "none" });
  });

  it("rejects a diff whose response scope differs from the requested selector", async () => {
    const { client } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, {
      sides: "index-vs-head", byteCap: 131072, truncated: false, truncation: "none", files: [],
    }));
    await expect(new VcsReadMethods(client).diff({ sides: "worktree-vs-index" })).rejects.toMatchObject({ kind: "internal" });
  });

  it("reports a missing handshake as disconnected", async () => {
    const { client } = fakeBridge([], undefined, false);
    const read = new VcsReadMethods(client);
    await expect(read.status()).rejects.toMatchObject({ kind: "disconnected", retryable: true });
  });

  it("keeps diff scope, truncation and binary metadata", async () => {
    const { client, fake } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, {
      sides: "worktree-vs-index",
      byteCap: 262144,
      truncated: true,
      truncation: "binary",
      files: [
        { path: "img.png", oldPath: null, patch: null, truncated: true, truncation: "binary" },
        { path: "old.ts", oldPath: "new.ts", patch: "diff", truncated: false, truncation: "none" },
      ],
    }));
    const read = new VcsReadMethods(client);

    const diff = await read.diff({ sides: "worktree-vs-index", paths: ["src"], limit: 10 });

    expect(fake.requests[0]?.params).toEqual({ sides: "worktree-vs-index", paths: ["src"], limit: 10 });
    expect(diff).toMatchObject({ sides: "worktree-vs-index", byteCap: 262144, truncated: true, truncation: "binary" });
    expect(diff.files[0]).toMatchObject({ path: "img.png", patch: null, truncation: "binary" });
    expect(diff.files[1]).toMatchObject({ oldPath: "new.ts", truncation: "none" });
  });

  it("requires a single object id for the worktree-vs-oid side", async () => {
    const { client, fake } = fakeBridge();
    const read = new VcsReadMethods(client);

    await expect(read.diff({ sides: "worktree-vs-oid" })).rejects.toMatchObject({ kind: "invalid_params" });
    const { client: okClient, fake: okFake } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, {
      sides: "worktree-vs-oid", byteCap: 1024, truncated: false, truncation: "none", files: [],
    }));
    await new VcsReadMethods(okClient).diff({ sides: "worktree-vs-oid", oid: "0123456789abcdef0123456789abcdef01234567" });
    expect(okFake.requests[0]?.params).toMatchObject({ oid: "0123456789abcdef0123456789abcdef01234567" });
    expect(fake.requests).toHaveLength(0);
  });

  it("maps bridge failures onto distinct kinds from stable codes", async () => {
    const failures: Array<[string | undefined, string, string]> = [
      ["LBR-AGENT-027", "cursor must be an opaque decimal offset", "cursor_invalid"],
      ["LBR-AGENT-027", "limit must be a non-negative integer", "invalid_params"],
      ["LBR-AGENT-026", "unknown bridge method 'vcs.diff'", "unsupported_capability"],
      ["LBR-AGENT-030", "allowlisted but not implemented", "unsupported_capability"],
      ["LBR-AGENT-031", "bridge protocol major mismatch", "protocol_mismatch"],
      ["LBR-AGENT-032", "scope conflict", "scope_mismatch"],
      ["LBR-AGENT-033", "payload digest conflict", "conflict"],
      ["LBR-AGENT-035", "operation denied", "denied"],
      ["LBR-AGENT-036", "request deadline exceeded", "timeout"],
      ["LBR-AGENT-037", "boom", "internal"],
      ["LBR-AGENT-038", "the status fence is stale", "stale_state"],
      [undefined, "boom", "internal"],
    ];
    for (const [stableCode, message, expected] of failures) {
      const { client } = fakeBridge([...VCS_READ_METHODS], (method) => ({
        id: 1,
        method,
        state: "error",
        error: {
          code: 1000,
          message,
          data: { retryable: true, ...(stableCode !== undefined ? { stable_code: stableCode } : {}) },
        },
      }));
      await expect(new VcsReadMethods(client).status()).rejects.toMatchObject({ kind: expected, retryable: true });
    }
  });

  it("returns log and show pages in their documented shapes", async () => {
    const { client } = fakeBridge([...VCS_READ_METHODS], (method) => method === "vcs.log"
      ? success(method, { commits: [{ oid: "a".repeat(40), summary: "feat: x", authorTime: 1 }], cursor: { next: null } })
      : success(method, {
        oid: "b".repeat(40),
        summary: "fix: y",
        parents: ["c".repeat(40)],
        files: [{ path: "x.ts", state: "staged", oldPath: null }],
        cursor: { next: "20" },
      }));
    const read = new VcsReadMethods(client);

    expect(await read.log()).toMatchObject({ cursor: { next: null } });
    const shown = await read.show({ oid: "b".repeat(40), limit: 20 });
    expect(shown).toMatchObject({
      oid: "b".repeat(40),
      summary: "fix: y",
      parents: ["c".repeat(40)],
      files: [{ path: "x.ts", state: "staged", oldPath: null }],
      cursor: { next: "20" },
    });
  });
});

describe("Host read service", () => {
  it("resolves the session binding and returns typed pages", async () => {
    const { client, fake } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, {
      entries: [{ path: "a.ts", state: "staged", oldPath: null }], cursor: { next: "20" },
    }));
    const service = new LibraVcsReadService(async () => ({
      ok: true,
      scope: { read: new VcsReadMethods(client), methods: [...VCS_READ_METHODS], bindingKey: "k1", generation: 1, validate: async () => undefined },
    }));

    const page = await service.status({ id: "s-1" }, { limit: 20 });

    expect(page.entries).toEqual([{ path: "a.ts", state: "staged", oldPath: null }]);
    expect(fake.requests[0]?.method).toBe("vcs.status");
  });

  it("shares an identical in-flight read instead of duplicating the call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client, fake } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, { commits: [], cursor: { next: null } }));
    const clientWithGate = {
      get negotiatedCapabilities() { return (client as unknown as { negotiatedCapabilities: unknown }).negotiatedCapabilities; },
      async requestMethod(method: string, params: Record<string, unknown>) {
        await gate;
        return (client as unknown as { requestMethod: (m: string, p: Record<string, unknown>) => Promise<CompletedRequest> }).requestMethod(method, params);
      },
    } as unknown as BridgeClient;
    const service = new LibraVcsReadService(async () => ({
      ok: true,
      scope: { read: new VcsReadMethods(clientWithGate), methods: [...VCS_READ_METHODS], bindingKey: "k1", generation: 1, validate: async () => undefined },
    }));
    const first = service.log({ id: "s-1" });
    const second = service.log({ id: "s-1" });
    release();
    await first;
    await second;
    expect(fake.requests).toHaveLength(1);
  });

  it("cancels only one waiter when two callers share a read", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client, fake } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, { commits: [], cursor: { next: null } }));
    const gated = {
      get negotiatedCapabilities() { return client.negotiatedCapabilities; },
      async requestMethod(method: string, params: Record<string, unknown>) {
        markStarted();
        await gate;
        return client.requestMethod(method, params);
      },
    } as unknown as BridgeClient;
    const service = new LibraVcsReadService(async () => ({
      ok: true,
      scope: { read: new VcsReadMethods(gated), methods: [...VCS_READ_METHODS], bindingKey: "k1", generation: 1, validate: async () => undefined },
    }));
    const controller = new AbortController();
    const cancelled = service.log({ id: "s-1" }, {}, { signal: controller.signal });
    await started;
    const surviving = service.log({ id: "s-1" });
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    release();
    await expect(surviving).resolves.toMatchObject({ commits: [], cursor: { next: null } });
    expect(fake.requests).toHaveLength(1);
  });

  it("does not return an old repository result after a mid-read rebind", async () => {
    let current = "repo-a";
    let releaseA!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const { client: clientA, fake: fakeA } = fakeBridge([...VCS_READ_METHODS], (method) =>
      success(method, { commits: [{ oid: "a".repeat(40), summary: "repo-a", authorTime: 1 }], cursor: { next: null } }));
    const delayedA = {
      get negotiatedCapabilities() { return clientA.negotiatedCapabilities; },
      async requestMethod(method: string, params: Record<string, unknown>) {
        markStarted();
        await gateA;
        return clientA.requestMethod(method, params);
      },
    } as unknown as BridgeClient;
    const { client: clientB, fake: fakeB } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, {
      commits: [{ oid: "b".repeat(40), summary: "repo-b", authorTime: 2 }], cursor: { next: null },
    }));
    const service = new LibraVcsReadService(async () => {
      const repo = current;
      const bridge = repo === "repo-a" ? delayedA : clientB;
      const generation = repo === "repo-a" ? 1 : 2;
      return {
        ok: true as const,
        scope: {
          read: new VcsReadMethods(bridge),
          methods: [...VCS_READ_METHODS],
          bindingKey: repo,
          generation,
          validate: async () => {
            if (current !== repo) throw new VcsHostError("cwd_changed", "the Session moved during the read");
          },
        },
      };
    });
    const oldRead = service.log({ id: "s-1" });
    await started;
    current = "repo-b";
    const newRead = service.log({ id: "s-1" });

    await expect(newRead).resolves.toMatchObject({ commits: [{ summary: "repo-b" }] });
    releaseA();
    await expect(oldRead).rejects.toMatchObject({ kind: "cwd_changed" });
    expect(fakeA.requests).toHaveLength(1);
    expect(fakeB.requests).toHaveLength(1);
  });

  it("does not share a read between different refresh request ids", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client, fake } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, { commits: [], cursor: { next: null } }));
    const gated = {
      get negotiatedCapabilities() { return client.negotiatedCapabilities; },
      async requestMethod(method: string, params: Record<string, unknown>) {
        markStarted();
        await gate;
        return client.requestMethod(method, params);
      },
    } as unknown as BridgeClient;
    const service = new LibraVcsReadService(async () => ({
      ok: true,
      scope: { read: new VcsReadMethods(gated), methods: [...VCS_READ_METHODS], bindingKey: "k1", generation: 1, validate: async () => undefined },
    }));
    const first = service.log({ id: "s-1" }, {}, { requestId: "refresh-1" });
    await started;
    const second = service.log({ id: "s-1" }, {}, { requestId: "refresh-2" });
    release();
    await first;
    await second;
    expect(fake.requests).toHaveLength(2);
  });

  it("aborts the underlying bridge request when its last waiter cancels", async () => {
    const calls: Array<{ params: unknown; signal: AbortSignal | undefined }> = [];
    const abortable = {
      get negotiatedCapabilities() {
        return { protocol: { major: 1, minor: 2 }, limits: {}, methods: [...VCS_READ_METHODS], source: "fake" };
      },
      requestMethod(_method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<CompletedRequest> {
        calls.push({ params, signal });
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => reject(new VcsReadError("cancelled", "cancelled"));
          if (signal?.aborted === true) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    } as unknown as BridgeClient;
    const service = new LibraVcsReadService(async () => ({
      ok: true,
      scope: { read: new VcsReadMethods(abortable), methods: [...VCS_READ_METHODS], bindingKey: "k1", generation: 1, validate: async () => undefined },
    }));
    const controller = new AbortController();
    const cancelled = service.log({ id: "s-1" }, {}, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it("maps binding failures onto machine-distinguishable Host errors", async () => {
    const service = new LibraVcsReadService(async () => ({
      ok: false,
      failure: { kind: "cwd_changed", sessionId: "s-1", bound: "wt-a", now: "wt-b" },
    }));
    await expect(service.status({ id: "s-1" })).rejects.toMatchObject({ kind: "cwd_changed" });
    const unsupported = new LibraVcsReadService(async () => ({
      ok: false,
      failure: { kind: "unsupported_capability", sessionId: "s-1", missing: ["vcs.show"] },
    }));
    await expect(unsupported.show({ id: "s-1" }, { oid: "a".repeat(40) })).rejects.toMatchObject({
      kind: "unsupported_capability",
    });
  });

  it("cancels a read whose signal is already aborted and after it resolves", async () => {
    const { client } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, { entries: [], cursor: { next: null } }));
    const service = new LibraVcsReadService(async () => ({
      ok: true,
      scope: { read: new VcsReadMethods(client), methods: [...VCS_READ_METHODS], bindingKey: "k1", generation: 1, validate: async () => undefined },
    }));
    const aborted = new AbortController();
    aborted.abort();
    await expect(service.status({ id: "s-1" }, {}, { signal: aborted.signal })).rejects.toMatchObject({ kind: "cancelled" });

    const controller = new AbortController();
    const pending = service.status({ id: "s-1" }, {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(VcsHostError);
  });
});

describe("Remote namespace", () => {
  it("declares four Session-scoped methods and returns typed results over the namespace", async () => {
    const remoteModule = await import("../../packages/bundle/src/vcs-remote.js");
    const { Context } = await import("@deepseek-ai/cordis");
    const { remoteMethods } = await import("@deepseek-ai/dsh-typert-protocol");
    const { client } = fakeBridge([...VCS_READ_METHODS], (method) => success(method, {
      entries: [{ path: "a.ts", state: "staged", oldPath: null }], cursor: { next: null },
    }));
    const service = new LibraVcsReadService(async () => ({
      ok: true,
      scope: { read: new VcsReadMethods(client), methods: [...VCS_READ_METHODS], bindingKey: "k1", generation: 1, validate: async () => undefined },
    }));
    const remote = new remoteModule.LibraVcsRemote(new Context(), service, (id) =>
      String(id) === "s-1" ? { id: "s-1" } as never : undefined);
    const markers = remoteMethods(remote);
    for (const method of ["status", "diff", "log", "show"]) {
      expect(markers.find((marker) => marker.method === method)?.resources?.session).toBeDefined();
    }
    await expect(remote.status("s-1" as never)).resolves.toMatchObject({
      ok: true,
      data: { entries: [{ path: "a.ts", oldPath: null }] },
    });
    await expect(remote.status("missing" as never)).resolves.toMatchObject({
      ok: false,
      error: { kind: "no_working_directory" },
    });
  });
});
