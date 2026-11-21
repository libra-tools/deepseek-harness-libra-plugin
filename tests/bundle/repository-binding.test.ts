/**
 * Per-session repository binding (plan-20261118 LVC-03).
 *
 * Each test drives the registry with a fake bridge so the isolation rules —
 * one bridge per canonical worktree, fail-closed cwd changes, refcounted
 * lifetime and Host-only identity evidence — are checked without a real Libra
 * repository.
 */
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type BindResult,
  type BridgeEvidence,
  RepositoryRegistry,
  type RepositoryIdentity,
  readSessionWorkingDirectory,
} from "@libra/dsh-bundle";
import type { BridgeClient } from "@libra/dsh-bridge-client";
import type { ToolsFacade } from "@libra/dsh-tools";
import { registerLibraTools } from "../../packages/bundle/src/libra-tools.js";

interface FakeClientOptions {
  identity: RepositoryIdentity;
  methods?: string[];
  failure?: "connect" | "identity";
}

class FakeClient {
  readonly cwd: string;
  readonly identity: RepositoryIdentity;
  readonly methods: string[];
  readonly failure: FakeClientOptions["failure"];
  readonly pid: number;
  connected = false;
  closed = false;
  requests: string[] = [];

  static created: FakeClient[] = [];

  constructor(cwd: string, options: FakeClientOptions) {
    this.cwd = cwd;
    this.identity = options.identity;
    this.methods = options.methods ?? ["initialize", "vcs.identity", "vcs.status"];
    this.failure = options.failure;
    this.pid = 1000 + FakeClient.created.length;
    FakeClient.created.push(this);
  }

  get childPid(): number | undefined {
    return this.connected ? this.pid : undefined;
  }

  async connect(): Promise<{ protocol: { major: number; minor: number }; limits: Record<string, number>; methods: string[]; source: string }> {
    if (this.failure === "connect") throw new Error("cannot connect");
    this.connected = true;
    return { protocol: { major: 1, minor: 2 }, limits: {}, methods: this.methods, source: "libra" };
  }

  async requestMethod(method: string): Promise<{ state: "success"; result: unknown }> {
    this.requests.push(method);
    if (method !== "vcs.identity") return { state: "success", result: {} };
    if (this.failure === "identity") throw new Error("not a repository");
    return {
      state: "success",
      result: {
        worktree_id: this.identity.worktreeId,
        worktree_root_hash: this.identity.worktreeRootHash,
        head_oid: this.identity.headOid,
        branch: this.identity.branch,
        unborn: this.identity.unborn,
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
  }
}

function identity(root: string): RepositoryIdentity {
  return {
    worktreeId: `wt-${root.split("/").pop()}`,
    worktreeRootHash: `hash-${root.split("/").pop()}`,
    headOid: null,
    branch: "main",
    unborn: true,
  };
}

async function fixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `libra-binding-${name}-`));
  await mkdir(join(root, ".libra"), { recursive: true });
  return root;
}

function registry(
  identities: Map<string, RepositoryIdentity>,
  options: { methods?: string[]; failure?: FakeClientOptions["failure"] } = {},
): { registry: RepositoryRegistry; created: FakeClient[] } {
  FakeClient.created = [];
  const created = FakeClient.created;
  const instance = new RepositoryRegistry({
    resolveExecutable: async () => process.execPath,
    bundleEntryPath: fileURLToPath(new URL("../../packages/bundle/src/index.ts", import.meta.url)),
    createClient: (cwd) => {
      const known = identities.get(cwd);
      const selected = known ?? identity(cwd);
      return new FakeClient(cwd, { identity: selected, ...options }) as unknown as BridgeClient;
    },
  });
  return { registry: instance, created };
}

function bindingOf(result: BindResult) {
  if (!result.ok) throw new Error(`unexpected failure: ${result.failure.kind}`);
  return result.binding;
}

describe("approval boundary", () => {
  function harness(): {
    commit: () => { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> };
    generation: { value: number };
    invocations: string[];
  } {
    const definitions: Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }> = [];
    const service = { register: (definition: unknown) => { definitions.push(definition as never); return () => undefined; } };
    const invocations: string[] = [];
    const facade = { invoke: async () => { invocations.push("invoke"); return { status: "ok", data: {} }; } };
    const generation = { value: 1 };
    const resolveTools = async () => facade as unknown as ToolsFacade;
    const approval = {
      request: async () => {
        generation.value += 1;
        return "allowed-once";
      },
    };
    registerLibraTools(service, resolveTools, approval as never, { generation: () => generation.value });
    const commit = definitions.find((definition) => definition.name === "libra_commit")!;
    return { commit: () => commit, generation, invocations };
  }

  const session = { id: "s-approval", header: {}, surface: { nodes: [], replaceGeneration: 0 }, events: [] };
  const exec = {
    agent: { session },
    callId: "call-1",
    name: "libra_commit",
    signal: new AbortController().signal,
  };

  it("refuses an approved write when the binding changed while approval waited", async () => {
    const { commit, invocations } = harness();
    await expect(commit().execute({ message: "x" }, exec)).rejects.toThrow(/binding changed during approval/);
    expect(invocations).toHaveLength(0);
  });

  it("sends the approved write when the binding stayed the same", async () => {
    const definitions: Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }> = [];
    const service = { register: (definition: unknown) => { definitions.push(definition as never); return () => undefined; } };
    const invocations: string[] = [];
    const facade = { invoke: async () => { invocations.push("invoke"); return { status: "ok", data: {} }; } };
    const stable = { value: 7 };
    const approval = { request: async () => "allowed-once" };
    registerLibraTools(service, (async () => facade) as never, approval as never, { generation: () => stable.value });
    const commit = definitions.find((definition) => definition.name === "libra_commit")!;
    await commit.execute({ message: "x" }, exec);
    expect(invocations).toHaveLength(1);
  });
});

describe("repository binding", () => {
  it("binds two sessions to two repositories with two bridges", async () => {
    const first = await fixture("first");
    const second = await fixture("second");
    const identities = new Map([
      [first, identity(first)],
      [second, identity(second)],
    ]);
    const { registry: instance, created } = registry(identities);

    const a = bindingOf(await instance.bind("s-1", first));
    const b = bindingOf(await instance.bind("s-2", second));

    expect(a.key).not.toBe(b.key);
    expect(a.client).not.toBe(b.client);
    expect(created).toHaveLength(2);
    expect(instance.liveBindings()).toHaveLength(2);
  });

  it("shares one bridge between sessions bound to the same worktree", async () => {
    const root = await fixture("shared");
    const identities = new Map([[root, identity(root)]]);
    const { registry: instance, created } = registry(identities);

    const first = bindingOf(await instance.bind("s-1", root));
    const second = bindingOf(await instance.bind("s-2", root));

    expect(first.client).toBe(second.client);
    expect(first.refs).toBe(2);
    // The second bind opened an identifying client and closed it again.
    expect(created.some((client) => client.closed)).toBe(true);
    expect(instance.liveBindings()).toHaveLength(1);
  });

  it("fails closed when a bound session's directory resolves to another worktree", async () => {
    const first = await fixture("bound");
    const moved = await fixture("moved");
    const identities = new Map([
      [first, identity(first)],
      [moved, identity(moved)],
    ]);
    const { registry: instance } = registry(identities);

    bindingOf(await instance.bind("s-1", first));
    const again = await instance.bind("s-1", moved);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.failure.kind).toBe("cwd_changed");
    // The original binding is untouched.
    expect(instance.sessionBinding("s-1")?.identity.worktreeId).toBe(identity(first).worktreeId);
  });

  it("reports a missing repository and a bridge without the identity method", async () => {
    const missing = join(tmpdir(), `libra-binding-absent-${process.pid}`);
    const { registry: notRepository } = registry(new Map());
    const absent = await notRepository.bind("s-1", missing);
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.failure.kind).toBe("not_a_repository");

    const root = await fixture("no-identity");
    const { registry: without } = registry(new Map(), { methods: ["initialize"] });
    const unsupported = await without.bind("s-1", root);
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.failure.kind).toBe("unsupported_capability");
      if (unsupported.failure.kind === "unsupported_capability") {
        expect(unsupported.failure.missing).toContain("vcs.identity");
      }
    }
  });

  it("does not add a second reference when the same session binds again", async () => {
    const root = await fixture("repeat-bind");
    const identities = new Map([[root, identity(root)]]);
    const { registry: instance } = registry(identities);

    const first = bindingOf(await instance.bind("s-1", root));
    const again = bindingOf(await instance.bind("s-1", root));

    expect(again).toBe(first);
    expect(first.refs).toBe(1);
    expect(instance.liveBindings()).toHaveLength(1);
    await instance.release("s-1");
    expect(instance.liveBindings()).toHaveLength(0);
  });

  it("serializes concurrent binds for one session and shares the repository bridge", async () => {
    const root = await fixture("concurrent-bind");
    const identities = new Map([[root, identity(root)]]);
    const { registry: instance, created } = registry(identities);

    const results = await Promise.all([
      instance.bind("s-1", root),
      instance.bind("s-1", root),
    ]);
    const first = bindingOf(results[0]!);
    const second = bindingOf(results[1]!);

    expect(second).toBe(first);
    expect(first.refs).toBe(1);
    expect(instance.liveBindings()).toHaveLength(1);
    expect(created.filter((client) => !client.closed)).toHaveLength(1);
  });

  it("distinguishes an unavailable bridge from a directory without a repository", async () => {
    const root = await fixture("unavailable");
    const { registry: unavailable } = registry(new Map(), { failure: "connect" });

    const result = await unavailable.bind("s-1", root);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("bridge_unavailable");
  });

  it("replaces a crashed bridge instead of serving stale evidence", async () => {
    const root = await fixture("crashed");
    const identities = new Map([[root, identity(root)]]);
    const { registry: instance } = registry(identities);
    const first = bindingOf(await instance.bind("s-1", root));
    expect(first.evidence.childPid).toBe(1000);

    // The child exits without the registry being told.
    (first.client as unknown as { connected: boolean }).connected = false;
    expect(instance.sessionBinding("s-1")).toBeUndefined();

    const second = bindingOf(await instance.bind("s-1", root));
    expect(second.client).not.toBe(first.client);
    expect(second.evidence.childPid).not.toBe(1000);
    expect(second.identity.worktreeId).toBe(first.identity.worktreeId);
  });

  it("reconciles reference counts when a shared bridge crashes", async () => {
    const root = await fixture("shared-crash");
    const identities = new Map([[root, identity(root)]]);
    const { registry: instance } = registry(identities);
    const first = bindingOf(await instance.bind("s-1", root));
    bindingOf(await instance.bind("s-2", root));
    expect(first.refs).toBe(2);

    (first.client as unknown as { connected: boolean }).connected = false;
    const replacement = bindingOf(await instance.bind("s-1", root));
    expect(replacement.client).not.toBe(first.client);
    expect(replacement.refs).toBe(1);
    expect(instance.sessionBinding("s-2")).toBeUndefined();

    const reattached = bindingOf(await instance.bind("s-2", root));
    expect(reattached.client).toBe(replacement.client);
    expect(replacement.refs).toBe(2);

    await instance.release("s-1");
    expect(replacement.refs).toBe(1);
    expect(instance.liveBindings()).toHaveLength(1);
    await instance.release("s-2");
    expect(instance.liveBindings()).toHaveLength(0);
  });

  it("keeps reported evidence immutable", async () => {
    const root = await fixture("frozen-evidence");
    const identities = new Map([[root, identity(root)]]);
    const { registry: instance } = registry(identities);
    const binding = bindingOf(await instance.bind("s-1", root));
    expect(Object.isFrozen(binding.evidence)).toBe(true);
    const snapshot = Object.freeze({ ...binding.evidence });

    expect(() => {
      (snapshot as { executableSha256: string }).executableSha256 = "tampered";
    }).toThrow(TypeError);
    expect(binding.evidence.executableSha256).not.toBe("tampered");
    expect(binding.evidence.childPid).toBe(1000);
  });

  it("closes a bridge only after its last session releases it", async () => {
    const root = await fixture("release");
    const identities = new Map([[root, identity(root)]]);
    const { registry: instance } = registry(identities);

    const binding = bindingOf(await instance.bind("s-1", root));
    bindingOf(await instance.bind("s-2", root));
    await instance.release("s-1");
    expect(binding.refs).toBe(1);
    expect(instance.liveBindings()).toHaveLength(1);

    await instance.release("s-2");
    expect(instance.liveBindings()).toHaveLength(0);
    await instance.dispose();
    expect(binding.refs).toBeLessThanOrEqual(0);
  });

  it("records Host-only identity evidence for each running bridge", async () => {
    const root = await fixture("evidence");
    const identities = new Map([[root, identity(root)]]);
    const { registry: instance } = registry(identities);
    const binding = bindingOf(await instance.bind("s-1", root));

    const evidence: BridgeEvidence = binding.evidence;
    expect(evidence.executable).toBe(process.execPath);
    expect(evidence.executableSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.bundleEntrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.bundlePackageDir).toContain("packages/bundle");
    expect(evidence.bundleEntryPath).toContain("/packages/bundle/src/index.ts");
    expect(evidence.childPid).toBe(1000);
    expect(evidence.initialize.methods).toContain("vcs.identity");
    expect(binding.client["requests"]).toContain("vcs.identity");
  });

  it("reads the working directory only from the Host service", () => {
    const session = { id: "s-1" };
    const service = { get: (value: unknown) => (value === session ? "/trusted/dir" : undefined) };
    expect(readSessionWorkingDirectory(service, session)).toBe("/trusted/dir");
    expect(readSessionWorkingDirectory(undefined, session)).toBeUndefined();
    expect(readSessionWorkingDirectory(service, { id: "other" })).toBeUndefined();
  });
});
