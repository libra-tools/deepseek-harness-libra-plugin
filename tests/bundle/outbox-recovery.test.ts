import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Context } from "@deepseek-ai/cordis";
import type { BridgeClient } from "@libra/dsh-bridge-client";
import { OutboxStore } from "@libra/dsh-session";
import { mountLibraOutbox } from "../../packages/bundle/src/outbox.js";
import { acquireSessionLock, claimAbandoned, createGeneration } from "../../packages/bundle/src/recovery.js";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "libra-recovery-test-"));
  roots.push(path);
  return path;
}
function generation(base: string, owner: unknown): string {
  const path = join(base, `generation-${randomUUID()}`);
  mkdirSync(path);
  writeFileSync(join(path, "owner.json"), JSON.stringify(owner));
  return path;
}
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  expect(child.status).toBe(0);
  return Number(child.stdout);
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function mountHarness(outboxRoot: string, repositoryRoot: string, offline = false) {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const warnings: string[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ctx = {
    logger: { warn: (message: string) => warnings.push(message) },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    },
  } as unknown as Context;
  const bridge = {
    contract: { limits: { max_event_bytes: 100_000, max_batch_events: 100, max_batch_bytes: 100_000 } },
    requestMethod: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "event.append") {
        if (offline) throw new Error("bridge offline");
        const events = params.events as Array<{ seq: number }>;
        return { state: "success", result: { last_acked_seq: events.at(-1)!.seq, per_event: events.map(({ seq }) => ({ seq, status: "accepted" })) } };
      }
      return { state: "success", result: {} };
    },
  } as unknown as BridgeClient;
  const mounted = mountLibraOutbox(ctx, bridge, { outboxRoot, repositoryRoot });
  return {
    calls, warnings, mounted,
    emit: async (event: string, ...args: unknown[]) => {
      await (listeners.get(event) as ((...values: unknown[]) => unknown) | undefined)?.(...args);
    },
  };
}

function abandonedQueue(outboxRoot: string, repositoryRoot: string, sessionId: string, seq: number): string {
  const namespace = createHash("sha256").update(repositoryRoot).digest("hex");
  const parent = join(outboxRoot, namespace);
  mkdirSync(parent, { recursive: true });
  const dir = generation(parent, { version: 1, pid: deadPid() });
  new OutboxStore(dir).enqueue({ session_id: sessionId, event_seq: seq, event_type: "turn/start", payload: JSON.stringify({ from: repositoryRoot }) });
  return dir;
}

describe("outbox recovery integration", () => {
  it("replays an abandoned generation only after its live session provides an order", async () => {
    const base = root();
    const old = abandonedQueue(base, "/repo-one", "recovery-session", 1);
    const other = abandonedQueue(base, "/repo-two", "other-session", 1);
    const harness = mountHarness(base, "/repo-one");
    const session = { id: "recovery-session", header: {} };
    try {
      expect(harness.calls.some((call) => call.method === "event.append")).toBe(false);
      await harness.emit("session/event", session, { seq: 2, type: "turn/start", data: { live: true } });
      await harness.emit("session/flush", session);
      expect(new OutboxStore(old).load("recovery-session").entries).toHaveLength(0);
      expect(harness.calls.filter((call) => call.method === "event.append").flatMap((call) => call.params.events as Array<{ seq: number }>).map((event) => event.seq)).toEqual([1, 2]);
      expect(new OutboxStore(other).load("other-session").entries).toHaveLength(1);
    } finally {
      await harness.mounted.dispose();
    }
  });

  it("preserves a new generation whose sequence does not advance the acknowledged generation", async () => {
    const base = root();
    const old = abandonedQueue(base, "/repo-one", "reused-session", 5);
    const harness = mountHarness(base, "/repo-one", true);
    const session = { id: "reused-session", header: {} };
    try {
      await harness.emit("session/event", session, { seq: 0, type: "turn/start", data: { fresh: true } });
      await harness.emit("session/flush", session);
      expect(new OutboxStore(old).load("reused-session").entries).toHaveLength(1);
      expect(harness.calls.some((call) => call.method === "event.append")).toBe(false);
      expect(harness.warnings.some((warning) => /does not advance/.test(warning))).toBe(true);
    } finally {
      await harness.mounted.dispose();
    }
  });

  it("does not treat rejected diagnostics as pending recovery generations", async () => {
    const base = root();
    const first = abandonedQueue(base, "/repo-one", "diagnostic-session", 1);
    const second = abandonedQueue(base, "/repo-one", "diagnostic-session", 2);
    new OutboxStore(first).applyAppendResult("diagnostic-session", 1, [{ seq: 1, status: "rejected" }]);
    new OutboxStore(second).applyAppendResult("diagnostic-session", 2, [{ seq: 2, status: "rejected" }]);
    const harness = mountHarness(base, "/repo-one");
    const session = { id: "diagnostic-session", header: {} };
    try {
      await harness.emit("session/event", session, { seq: 3, type: "turn/start", data: { fresh: true } });
      await harness.emit("session/flush", session);
      expect(harness.calls.filter((call) => call.method === "event.append").flatMap((call) => call.params.events as Array<{ seq: number }>).map((event) => event.seq)).toEqual([3]);
    } finally {
      await harness.mounted.dispose();
    }
  });

  it("recovers a drained generation before accepting a later live event", async () => {
    const base = root();
    const dir = abandonedQueue(base, "/repo-one", "drained-session", 1);
    new OutboxStore(dir).applyAppendResult("drained-session", 1, [{ seq: 1, status: "accepted" }]);
    const harness = mountHarness(base, "/repo-one");
    const session = { id: "drained-session", header: {} };
    try {
      await harness.emit("session/event", session, { seq: 2, type: "turn/start", data: { fresh: true } });
      await harness.emit("session/flush", session);
      expect(harness.calls.filter((call) => call.method === "event.append").flatMap((call) => call.params.events as Array<{ seq: number }>).map((event) => event.seq)).toEqual([2]);
    } finally {
      await harness.mounted.dispose();
    }
  });

  it("preserves two unrecovered generations instead of guessing their order", async () => {
    const base = root();
    const first = mountHarness(base, "/repo-one", true);
    const session = { id: "reload-session", header: {} };
    await first.emit("session/event", session, { seq: 0, type: "turn/start", data: { first: true } });
    await first.emit("session/flush", session);
    let second: ReturnType<typeof mountHarness> | undefined;
    try {
      second = mountHarness(base, "/repo-one");
      await second.emit("session/event", session, { seq: 1, type: "turn/start", data: { second: true } });
      await expect(second.mounted.open(session)).rejects.toThrow("outbox recovery blocked");
      expect(second.calls.some((call) => call.method === "event.append")).toBe(false);
    } finally {
      await second?.mounted.dispose();
    }
    await first.mounted.dispose();
    const third = mountHarness(base, "/repo-one");
    try {
      await third.emit("session/event", session, { seq: 2, type: "turn/start", data: { third: true } });
      await third.emit("session/flush", session);
      expect(third.warnings.some((warning) => /multiple pending generations/.test(warning))).toBe(true);
      expect(third.calls.some((call) => call.method === "event.append")).toBe(false);
    } finally {
      await third.mounted.dispose();
    }
  });

  it("recovers an offline mount after HMR disposal in the same process", async () => {
    const base = root();
    const first = mountHarness(base, "/repo-one", true);
    const session = { id: "hmr-session", header: {} };
    await first.emit("session/event", session, { seq: 0, type: "turn/start", data: { first: true } });
    await first.emit("session/flush", session);
    await first.mounted.dispose();
    const second = mountHarness(base, "/repo-one");
    try {
      await second.emit("session/event", session, { seq: 1, type: "turn/start", data: { second: true } });
      await second.emit("session/flush", session);
      await vi.waitFor(() => expect(second.calls.some((call) => call.method === "event.append")).toBe(true));
      const events = second.calls.filter((call) => call.method === "event.append").flatMap((call) => call.params.events as Array<{ seq: number }>);
      expect(events.map((event) => event.seq)).toEqual([0, 1]);
      expect(second.warnings.some((warning) => /recovery blocked/.test(warning))).toBe(false);
    } finally {
      await second.mounted.dispose();
    }
  });

  it("preserves ambiguous same-owner generations without sending either", async () => {
    const base = root();
    abandonedQueue(base, "/repo-one", "ambiguous-session", 1);
    const namespace = createHash("sha256").update("/repo-one").digest("hex");
    const second = generation(join(base, namespace), { version: 1, pid: process.pid });
    new OutboxStore(second).enqueue({ session_id: "ambiguous-session", event_seq: 2, event_type: "turn/start", payload: "{}" });
    const harness = mountHarness(base, "/repo-one");
    try {
      await harness.emit("session/event", { id: "ambiguous-session", header: {} }, { seq: 3, type: "turn/start", data: { live: true } });
      await expect(harness.mounted.open({ id: "ambiguous-session", header: {} } as never)).rejects.toThrow();
      await vi.waitFor(() => expect(harness.warnings.some((warning) => /multiple pending generations/.test(warning))).toBe(true));
      expect(harness.calls.some((call) => call.method === "event.append")).toBe(false);
    } finally {
      await harness.mounted.dispose();
    }
  });

  it("does not send a new generation past an offline abandoned generation", async () => {
    const base = root();
    const old = abandonedQueue(base, "/repo-one", "same-session", 1);
    const harness = mountHarness(base, "/repo-one", true);
    const session = { id: "same-session", header: {} };
    try {
      await harness.emit("session/event", session, { seq: 2, type: "turn/start", data: { fresh: true } });
      await harness.emit("session/flush", session);
      expect(new OutboxStore(old).load("same-session").entries).toHaveLength(1);
      const events = harness.calls.filter((call) => call.method === "event.append").flatMap((call) => call.params.events as Array<{ seq: number }>);
      expect(events.some((event) => event.seq === 2)).toBe(false);
    } finally {
      await harness.mounted.dispose();
    }
  });
});

describe("cross-process session lock", () => {
  it("releases the session lock after its retirement completes", async () => {
    const base = root();
    const harness = mountHarness(base, "/repo-one");
    const session = { id: "retire-lock", header: {} };
    await harness.emit("session/event", session, { seq: 1, type: "turn/start", data: { live: true } });
    await harness.emit("session/flush", session);
    const namespace = createHash("sha256").update("/repo-one").digest("hex");
    expect(acquireSessionLock(join(base, namespace), "retire-lock", () => {})).toBeUndefined();
    await harness.emit("session/disposed", session);
    await vi.waitFor(() => {
      const lock = acquireSessionLock(join(base, namespace), "retire-lock", () => {});
      if (!lock) throw new Error("lock still held");
      lock.release();
    });
    await harness.mounted.dispose();
  });

  it("excludes another mount in the same process and releases on close", () => {
    const base = root();
    const first = acquireSessionLock(base, "../unsafe", () => {});
    expect(first).toBeDefined();
    expect(acquireSessionLock(base, "../unsafe", () => {})).toBeUndefined();
    const other = acquireSessionLock(base, "different", () => {});
    expect(other).toBeDefined();
    other!.release();
    first!.release();
    const next = acquireSessionLock(base, "../unsafe", () => {});
    expect(next).toBeDefined();
    next!.release();
  });

  it("excludes a separate process and releases after it is killed", async () => {
    const base = root();
    const module = new URL("../../packages/bundle/src/recovery.ts", import.meta.url).href;
    const script = `import { acquireSessionLock } from ${JSON.stringify(module)}; const lock = acquireSessionLock(process.argv[1], 'shared', console.error); console.log(lock ? 'locked' : 'failed'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, base], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("locked")) resolve(); });
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`child exited before locking: ${code}`)));
      });
      expect(acquireSessionLock(base, "shared", () => {})).toBeUndefined();
      const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
      child.kill("SIGKILL");
      await exited;
      const recovered = acquireSessionLock(base, "shared", () => {});
      expect(recovered).toBeDefined();
      recovered!.release();
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("outbox generation ownership", () => {
  it("persists the creating process before a generation is returned", () => {
    const dir = createGeneration(root());
    expect(JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"))).toEqual({ version: 1, pid: process.pid });
  });

  it("never claims a live owner, including a reused PID", () => {
    const dir = generation(root(), { version: 1, pid: process.pid });
    expect(claimAbandoned(dir, () => {})).toBeUndefined();
    expect(existsSync(join(dir, "claim"))).toBe(false);
  });

  it("claims a genuinely exited process and releases only its own claim", () => {
    const dir = generation(root(), { version: 1, pid: deadPid() });
    const claim = claimAbandoned(dir, () => {});
    expect(claim).toBeDefined();
    expect(JSON.parse(readFileSync(join(dir, "claim", "owner.json"), "utf8"))).toMatchObject({ version: 1, pid: process.pid });
    expect(claimAbandoned(dir, () => {})).toBeUndefined();
    claim!.release();
    expect(existsSync(join(dir, "claim"))).toBe(false);
    expect(claimAbandoned(dir, () => {})).toBeDefined();
  });

  it("preserves unknown or malformed owners and warns", () => {
    for (const owner of [{}, { version: 2, pid: 123 }, { version: 1, pid: 0 }, { version: 1, pid: -1 }]) {
      const dir = generation(root(), owner);
      const warnings: string[] = [];
      expect(claimAbandoned(dir, (message) => warnings.push(message))).toBeUndefined();
      expect(warnings.length).toBeGreaterThan(0);
      expect(existsSync(join(dir, "claim"))).toBe(false);
    }
  });

  it("preserves a generation when process liveness cannot be checked", () => {
    const dir = generation(root(), { version: 1, pid: 12345 });
    const warnings: string[] = [];
    const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    try {
      expect(claimAbandoned(dir, (message) => warnings.push(message))).toBeUndefined();
      expect(existsSync(join(dir, "claim"))).toBe(false);
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      probe.mockRestore();
    }
  });

  it("preserves a claim left before its owner could be written", () => {
    const dir = generation(root(), { version: 1, pid: deadPid() });
    mkdirSync(join(dir, "claim"));
    const warnings: string[] = [];
    expect(claimAbandoned(dir, (message) => warnings.push(message))).toBeUndefined();
    expect(existsSync(join(dir, "claim"))).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("allows exactly one of two real processes to claim the same generation", async () => {
    const dir = generation(root(), { version: 1, pid: deadPid() });
    const module = new URL("../../packages/bundle/src/recovery.ts", import.meta.url).href;
    const script = `import { claimAbandoned } from ${JSON.stringify(module)}; const claim = claimAbandoned(process.argv[1], () => {}); console.log(claim ? 'won' : 'lost');`;
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
    });
    expect((await Promise.all([run(), run()])).sort()).toEqual(["lost", "won"]);
    expect(existsSync(join(dir, "claim", "owner.json"))).toBe(true);
  });
});
