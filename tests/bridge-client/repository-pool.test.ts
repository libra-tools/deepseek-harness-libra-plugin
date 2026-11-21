/**
 * Host session-to-repository pool (plan-20261118 LVC-03).
 *
 * Drives the real bundle composition against fake bridge children: each
 * session's Host working directory determines the repository it binds to,
 * one child serves each worktree, a cwd change fails closed, the explicit
 * Host rebind moves a session, and unload closes every child.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apply } from "@libra/dsh-bundle";
import type {
  LibraBridgeEvidenceService,
  LibraRepositoryBindingService,
} from "@libra/dsh-bundle";

const wrapper = new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url).pathname;
chmodSync(wrapper, 0o755);
const previousPath = process.env.PATH;
const namespacePattern = /^[a-f0-9]{64}$/;

interface TestSession {
  id: string;
  header: { parentSession?: string };
  surface: { nodes: number[]; replaceGeneration: number };
  events: Array<{ seq: number; type: string; data: unknown }>;
}

interface Harness {
  ctx: Context;
  emit: (event: "session/created" | "session/disposed", session: TestSession) => Promise<void>;
  capture: (session: TestSession, seq: number) => Promise<void>;
  warnings: string[];
  evidence: () => LibraBridgeEvidenceService;
  binding: () => LibraRepositoryBindingService;
}

function makeHarness(directories: Map<string, string>): Harness {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
  const warnings: string[] = [];
  const services = new Map<string, unknown>();
  const ctx = {
    sessions: { list: () => [] },
    logger: { warn: (message: string) => warnings.push(message) },
    get: (name: string) => (name === "workingDirectory"
      ? { get: (session: TestSession) => directories.get(String(session.id)) }
      : services.get(name)),
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const entries = listeners.get(event) ?? [];
      entries.push(listener);
      listeners.set(event, entries);
      return () => {
        const index = entries.indexOf(listener);
        if (index >= 0) entries.splice(index, 1);
        return index >= 0;
      };
    },
    reflect: {
      provide: (name: string, value: unknown) => {
        services.set(name, value);
        return () => { services.delete(name); };
      },
    },
  };
  return {
    ctx: ctx as unknown as Context,
    warnings,
    emit: async (event, session) => {
      for (const listener of listeners.get(event) ?? []) {
        await (listener as unknown as (value: TestSession) => Promise<unknown>)(session);
      }
    },
    capture: async (session, seq) => {
      for (const listener of listeners.get("session/event") ?? []) {
        await (listener as unknown as (
          value: TestSession,
          event: { seq: number; type: string; data: unknown },
        ) => Promise<unknown>)(session, {
          seq,
          type: "user/message",
          data: { role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } },
        });
      }
    },
    evidence: () => services.get("libraBridgeEvidence") as LibraBridgeEvidenceService,
    binding: () => services.get("libraRepositoryBinding") as LibraRepositoryBindingService,
  };
}

function session(id: string): TestSession {
  return { id, header: {}, surface: { nodes: [], replaceGeneration: 0 }, events: [] };
}

function fixtureRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `libra-pool-${name}-`));
  chmodSync(root, 0o755);
  return root;
}

describe("Host session-to-repository pool", () => {
  let dispose: (() => Promise<void>) | undefined;
  let outboxRoot: string | undefined;
  let roots: string[] = [];

  afterEach(async () => {
    process.env.PATH = previousPath;
    await dispose?.();
    dispose = undefined;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
    if (outboxRoot !== undefined) rmSync(outboxRoot, { recursive: true, force: true });
    outboxRoot = undefined;
    vi.restoreAllMocks();
  });

  async function start(directories: Map<string, string>): Promise<Harness> {
    process.env.PATH = `${join(wrapper, "..")}:${previousPath ?? ""}`;
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-pool-outbox-"));
    const harness = makeHarness(directories);
    dispose = await apply(harness.ctx, {
      libraExecutable: "fake-bridge-wrapper.sh",
      outboxRoot,
    });
    return harness;
  }

  function namespaces(): string[] {
    return readdirSync(outboxRoot!).filter((name) => namespacePattern.test(name));
  }

  function totalQueuedFiles(): number {
    return namespaces().reduce((count, namespace) => count + queuedFiles(namespace).length, 0);
  }

  function queuedFiles(namespace: string): string[] {
    return readdirSync(join(outboxRoot!, namespace), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".outbox.json"));
  }

  it("gives each repository its own bridge, identity and outbox namespace", async () => {
    const first = fixtureRoot("a");
    const second = fixtureRoot("b");
    roots = [first, second];
    const harness = await start(new Map([["s-1", first], ["s-2", second]]));
    const one = session("s-1");
    const two = session("s-2");

    await harness.emit("session/created", one);
    await harness.emit("session/created", two);
    await harness.capture(one, 0);
    await harness.capture(two, 0);

    const bindings = harness.evidence().bindings();
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map((entry) => entry.key)).size).toBe(2);
    expect(new Set(bindings.map((entry) => entry.identity.worktreeId)).size).toBe(2);
    expect(new Set(bindings.map((entry) => entry.evidence.childPid)).size).toBe(2);
    for (const entry of bindings) {
      expect(entry.sessionCount).toBe(1);
      expect(entry.evidence.executable).toBe(wrapper);
      expect(entry.evidence.executableSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.evidence.bundleEntrySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.evidence.bundleEntryPath).toContain("repository-runtime");
      expect(entry.evidence.bundlePackageDir).toContain("packages/bundle");
      expect(entry.evidence.initialize.methods).toContain("vcs.identity");
    }

    const names = namespaces();
    expect(names).toHaveLength(2);
    const queues = names.map((name) => queuedFiles(name));
    for (const queue of queues) expect(queue).toHaveLength(1);
    const owners = queues.map((queue) => queue[0]!.split("/").pop()!.replace(".outbox.json", ""));
    expect(new Set(owners).size).toBe(2);
    expect(new Set(owners)).toEqual(new Set(["s-1", "s-2"]));
  }, 60_000);

  it("shares one bridge and one outbox namespace between sessions in the same worktree", async () => {
    const shared = fixtureRoot("shared");
    roots = [shared];
    const harness = await start(new Map([["s-1", shared], ["s-2", shared]]));
    const one = session("s-1");
    const two = session("s-2");

    await harness.emit("session/created", one);
    await harness.emit("session/created", two);
    await harness.capture(one, 0);
    await harness.capture(two, 1);

    const bindings = harness.evidence().bindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.sessionCount).toBe(2);

    const names = namespaces();
    expect(names).toHaveLength(1);
    expect(queuedFiles(names[0]!)).toHaveLength(2);
  }, 60_000);

  it("fails closed on a cwd change and only the Host rebind moves the session", async () => {
    const first = fixtureRoot("before");
    const second = fixtureRoot("after");
    roots = [first, second];
    const directories = new Map([["s-1", first]]);
    const harness = await start(directories);
    const one = session("s-1");

    await harness.emit("session/created", one);
    const before = harness.evidence().bindings();
    expect(before).toHaveLength(1);

    directories.set("s-1", second);
    await harness.emit("session/created", one);

    const queuedBefore = totalQueuedFiles();
    expect(harness.evidence().failure("s-1")?.kind).toBe("cwd_changed");
    expect(harness.evidence().bindings()).toHaveLength(1);
    expect(harness.warnings.some((entry) => entry.includes("cwd_changed"))).toBe(true);

    await harness.capture(one, 1);
    expect(totalQueuedFiles()).toBe(queuedBefore);

    const result = await harness.binding().rebind(one);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(harness.evidence().failure("s-1")).toBeUndefined();
    expect(result.binding.identity.worktreeId).not.toBe(before[0]!.identity.worktreeId);
    expect(harness.evidence().bindings()).toHaveLength(1);
  }, 60_000);

  it("releases the last session's runtime and unload closes every child", async () => {
    const first = fixtureRoot("release");
    roots = [first];
    const harness = await start(new Map([["s-1", first], ["s-2", first]]));
    const one = session("s-1");
    const two = session("s-2");

    await harness.emit("session/created", one);
    await harness.emit("session/created", two);
    expect(harness.evidence().bindings()[0]!.sessionCount).toBe(2);

    await harness.emit("session/disposed", one);
    expect(harness.evidence().bindings()[0]!.sessionCount).toBe(1);

    await harness.emit("session/disposed", two);
    expect(harness.evidence().bindings()).toHaveLength(0);

    await dispose?.();
    dispose = undefined;
    // Unload releases the Host service with the plugin; nothing is left mounted.
    expect(harness.evidence()).toBeUndefined();
    expect(harness.warnings.filter((entry) => entry.includes("shutdown")).length).toBe(0);
  }, 60_000);

  it("reports a clear failure when the Host has no working directory", async () => {
    const harness = await start(new Map());

    await harness.emit("session/created", session("s-1"));

    expect(harness.evidence().bindings()).toHaveLength(0);
    expect(harness.evidence().failure("s-1")?.kind).toBe("no_working_directory");
    expect(harness.warnings.some((entry) => entry.includes("no_working_directory"))).toBe(true);
  }, 60_000);

  it("retires one session's state when it leaves a shared worktree", async () => {
    const shared = fixtureRoot("shared-rebind");
    const moved = fixtureRoot("moved");
    roots = [shared, moved];
    const directories = new Map([["s-1", shared], ["s-3", shared]]);
    const harness = await start(directories);
    const one = session("s-1");
    const three = session("s-3");

    await harness.emit("session/created", one);
    await harness.emit("session/created", three);
    await harness.capture(one, 0);
    await harness.capture(three, 1);
    const before = harness.evidence().bindings();
    expect(before).toHaveLength(1);
    expect(before[0]!.sessionCount).toBe(2);
    const oldPid = before[0]!.evidence.childPid;
    const queuedBefore = totalQueuedFiles();

    directories.set("s-3", moved);
    const rebind = await harness.binding().rebind(three);
    expect(rebind.ok).toBe(true);

    const after = harness.evidence().bindings();
    expect(after).toHaveLength(2);
    const stayed = after.find((entry) => entry.identity.worktreeId === before[0]!.identity.worktreeId);
    expect(stayed?.sessionCount).toBe(1);
    expect(stayed?.evidence.childPid).toBe(oldPid);
    const movedBinding = after.find((entry) => entry.key !== before[0]!.key);
    expect(movedBinding?.sessionCount).toBe(1);
    // The departing session's queue was drained and retired, not left to flush
    // to the worktree it left.
    expect(totalQueuedFiles()).toBe(queuedBefore);
    await harness.emit("session/disposed", three);
    await harness.emit("session/disposed", one);
    expect(harness.evidence().bindings()).toHaveLength(0);
  }, 60_000);

  it("keeps a bound session available after its first event", async () => {
    const root = fixtureRoot("steady");
    roots = [root];
    const harness = await start(new Map([["s-1", root]]));
    const one = session("s-1");

    await harness.emit("session/created", one);
    await harness.capture(one, 0);

    expect(harness.evidence().bindings()).toHaveLength(1);
    expect(harness.evidence().failure("s-1")).toBeUndefined();
    expect(queuedFiles(namespaces()[0]!)).toHaveLength(1);
  }, 60_000);
});
