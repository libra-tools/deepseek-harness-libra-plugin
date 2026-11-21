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
      ? success(method, { entries: [{ path: "src/a.ts", state: "staged" }, { path: "b.md", state: "unstaged" }], cursor: { next: "40" } })
      : success(method, {}));
    const read = new VcsReadMethods(client);

    const page = await read.status({ cursor: "20", limit: 20 });

    expect(fake.requests).toEqual([{ method: "vcs.status", params: { cursor: "20", limit: 20 } }]);
    expect(page.entries).toEqual([{ path: "src/a.ts", state: "staged" }, { path: "b.md", state: "unstaged" }]);
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

  it("maps bridge failures onto distinct kinds", async () => {
    const failures: Array<[string, string]> = [
      ["cursor must be an opaque decimal offset", "cursor_invalid", "cursor_invalid"],
      ["scope mismatch: repository changed", "scope_mismatch", "scope_mismatch"],
      ["the write fence is stale", "stale_state", "stale_state"],
      ["limit must be a non-negative integer", "invalid_params", "invalid_params"],
      ["boom", "internal", "internal"],
    ];
    for (const [message, expected] of failures) {
      const { client } = fakeBridge([...VCS_READ_METHODS], (method) => ({
        id: 1,
        method,
        state: "error",
        error: { code: 1000, message, data: { retryable: true } },
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
      entries: [{ path: "a.ts", state: "staged" }], cursor: { next: "20" },
    }));
    const service = new LibraVcsReadService(async () => ({
      ok: true,
      scope: { read: new VcsReadMethods(client), methods: [...VCS_READ_METHODS], bindingKey: "k1" },
    }));

    const page = await service.status({ id: "s-1" }, { limit: 20 });

    expect(page.entries).toEqual([{ path: "a.ts", state: "staged" }]);
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
      scope: { read: new VcsReadMethods(clientWithGate), methods: [...VCS_READ_METHODS], bindingKey: "k1" },
    }));
    const first = service.log({ id: "s-1" });
    const second = service.log({ id: "s-1" });
    release();
    await first;
    await second;
    expect(fake.requests).toHaveLength(1);
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
      scope: { read: new VcsReadMethods(client), methods: [...VCS_READ_METHODS], bindingKey: "k1" },
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
