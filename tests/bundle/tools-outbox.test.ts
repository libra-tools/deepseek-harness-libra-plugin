import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition as DshToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { SessionProjectionService } from "@libra/dsh-session";

import { apply } from "@libra/dsh-bundle";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

interface TestMessage {
  id: string;
  role: "user";
  content: Array<{ type: string; text?: string }>;
  source: Record<string, unknown> & { kind: string };
}

interface TestSession {
  id: string;
  header: { parentSession?: string };
  events: Array<{ seq: number; type: string; data: TestMessage }>;
  surface: { replaceGeneration: number; nodes: number[] };
  appended: TestMessage[];
  eventAt(sequence: number): { seq: number; type: string; data: TestMessage } | undefined;
  ownEvents(): readonly { seq: number; type: string; data: TestMessage }[];
  append: (
    type: string,
    message: TestMessage,
    options: {
      surfaceOp: "append" | { op: "replace"; startSeq: number; endSeq: number };
      sourceEventSeqs?: number[];
    },
  ) => void;
}

function makeSession(id: string, parentSession?: string): TestSession {
  const session: TestSession = {
    id,
    header: { ...(parentSession ? { parentSession } : {}) },
    events: [],
    surface: { replaceGeneration: 0, nodes: [] },
    appended: [],
    eventAt: (sequence) => session.events[sequence],
    ownEvents: () => session.events.slice(),
    append: (type, message, options) => {
      const sequence = session.events.length;
      session.events.push({ seq: sequence, type, data: message });
      session.appended.push(message);
      if (options.surfaceOp === "append") {
        session.surface.nodes.push(sequence);
        return;
      }
      const start = session.surface.nodes.indexOf(options.surfaceOp.startSeq);
      const end = session.surface.nodes.indexOf(options.surfaceOp.endSeq);
      if (start < 0 || end < start) throw new Error("invalid test surface replacement");
      session.surface.nodes.splice(start, end - start + 1, sequence);
      session.surface.replaceGeneration += 1;
    },
  };
  return session;
}

interface ApprovalRecord {
  toolName: string;
  reason: string;
}

interface TestHarness {
  ctx: Context;
  registry: Array<{
    name: string;
    description: string;
    parameters: { type: string; properties: Record<string, unknown> };
  }>;
  approvals: ApprovalRecord[];
  setApproval(outcome: "allowed-once" | "rejected"): void;
  emit(event: string, ...args: unknown[]): Promise<void>;
  warnings: string[];
  listenersOf(event: string): Array<(...args: never[]) => unknown>;
}

function makeContext(seed: TestSession[] = []): TestHarness {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
  const registry: TestHarness["registry"] = [];
  const approvals: ApprovalRecord[] = [];
  const warnings: string[] = [];
  let approvalOutcome: "allowed-once" | "rejected" = "allowed-once";
  const ctx = {
    sessions: { list: () => [...seed] },
    logger: { warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")) },
    get: (key: string) => {
      if (key === "tools") {
        return {
          register: (def: DshToolDefinition) => {
            registry.push(def);
            return () => {
              const index = registry.indexOf(def);
              if (index >= 0) registry.splice(index, 1);
              return index >= 0;
            };
          },
        };
      }
      if (key === "approval") {
        return {
          request: async (request: ApprovalRecord) => {
            approvals.push({ toolName: request.toolName, reason: request.reason });
            return approvalOutcome;
          },
        };
      }
      return undefined;
    },
    on: (event: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }) => {
      const entries = listeners.get(event) ?? [];
      if (options?.prepend) entries.unshift(listener);
      else entries.push(listener);
      listeners.set(event, entries);
      return () => {
        const index = entries.indexOf(listener);
        if (index >= 0) entries.splice(index, 1);
        return index >= 0;
      };
    },
  };
  return {
    ctx: ctx as unknown as Context,
    registry,
    approvals,
    setApproval(outcome) {
      approvalOutcome = outcome;
    },
    warnings,
    listenersOf: (event) => listeners.get(event) ?? [],
    emit: async (event, ...args) => {
      for (const entry of listeners.get(event) ?? []) {
        await (entry as unknown as (...value: unknown[]) => unknown)(...args);
      }
    },
  };
}

function execStub(session: TestSession): ToolRunContext {
  return {
    agent: { session },
    callId: "call-1",
    name: "libra_status",
    arguments: {},
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

function execute(def: DshToolDefinition, args: Record<string, unknown>, session: TestSession): Promise<unknown> {
  return (def as unknown as {
    execute: (value: Record<string, unknown>, exec: ToolRunContext) => Promise<unknown>;
  }).execute(args, execStub(session));
}

describe("libra tools registered as DSH tools", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it("registers the allowlisted catalog with a filtered model surface", async () => {
    const harness = makeContext();
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    const names = harness.registry.map((def) => def.name).sort();
    expect(names).toEqual([
      "libra_checkpoint",
      "libra_checkpoint_create",
      "libra_checkpoint_show",
      "libra_commit",
      "libra_context",
      "libra_diff",
      "libra_history_search",
      "libra_restore_checkpoint",
      "libra_review",
      "libra_status",
    ]);
    const status = harness.registry.find((def) => def.name === "libra_status");
    expect(status).toBeDefined();
    expect(Object.keys(status!.parameters.properties).sort()).toEqual([]);
    const commit = harness.registry.find((def) => def.name === "libra_commit");
    const commitParams = Object.keys(commit!.parameters.properties).sort();
    expect(commitParams).toEqual(["allow_empty", "evidence_ids", "expected_head", "message", "signoff"]);
    expect(commit!.parameters.properties.allow_empty).toMatchObject({ type: "boolean" });
    expect(commit!.parameters.properties.evidence_ids).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(commit!.parameters.properties.message).toMatchObject({ type: "string" });
    const review = harness.registry.find((def) => def.name === "libra_review");
    expect(review!.parameters.properties.agents).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    const diff = harness.registry.find((def) => def.name === "libra_diff");
    expect(diff!.parameters.properties.limit).toMatchObject({ type: "integer" });
    for (const name of ["session_id", "operation_id", "approval", "actor", "repository_root", "workspace_id"]) {
      expect(commitParams).not.toContain(name);
      expect(commit!.parameters.properties[name]).toBeUndefined();
    }
  });

  it("routes a read call to the bridge and binds the agent session", async () => {
    const harness = makeContext();
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    const status = harness.registry.find((def) => def.name === "libra_status");
    const value = await execute(status!, {}, makeSession("s-1"));
    expect(value).toEqual({ ok: true, method: "status.get" });
  });

  it("refuses a write call when DSH approval is denied", async () => {
    const harness = makeContext();
    harness.setApproval("rejected");
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    const commit = harness.registry.find((def) => def.name === "libra_commit");
    await expect(execute(commit!, { message: "fix" }, makeSession("s-2"))).rejects.toThrow(/approval rejected/);
    expect(harness.approvals).toHaveLength(1);
    expect(harness.approvals[0]!.toolName).toBe("libra_commit");
  });

  it("forwards an approved write with generated operation identity", async () => {
    const harness = makeContext();
    harness.setApproval("allowed-once");
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    const commit = harness.registry.find((def) => def.name === "libra_commit");
    const value = await execute(commit!, { message: "fix" }, makeSession("s-3"));
    expect(value).toEqual({ ok: true, method: "commit.create" });
    expect(harness.approvals).toHaveLength(1);
    expect(harness.approvals[0]!.toolName).toBe("libra_commit");
  });

  it("skips tool registration when the host has no tools service", async () => {
    const harness = makeContext();
    const bare = {
      sessions: { list: () => [] },
      logger: { warn: () => undefined },
      get: () => undefined,
      on: () => () => true,
    } as unknown as Context;
    dispose = await apply(bare, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    expect(harness.registry).toHaveLength(0);
  });
});

describe("libra outbox projection", () => {
  let dispose: (() => Promise<void>) | undefined;
  let outboxRoot: string | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    if (outboxRoot) rmSync(outboxRoot, { recursive: true, force: true });
    outboxRoot = undefined;
    vi.restoreAllMocks();
  });

  it("waits for capture, drains the outbox, then closes the disposed session once", async () => {
    let exactSession = false;
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-order-"));
    const session = makeSession("ordered-session");
    const other = makeSession("other-session");
    const harness = makeContext([session, other]);
    const original = BridgeClient.prototype.requestMethod;
    const originalFlush = SessionProjectionService.prototype.flush;
    let flushes = 0;
    const projectionFlush = vi.spyOn(SessionProjectionService.prototype, "flush").mockImplementation(async function (id) {
      if (exactSession && flushes++ === 0) throw new Error("flush is still waiting for capture");
      return originalFlush.call(this, id);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<{ method: string; sessionId: unknown; phase: "start" | "end" }> = [];
    vi.spyOn(BridgeClient.prototype, "requestMethod").mockImplementation(async function (method, params) {
      const sessionId = (params as { session_id?: string } | undefined)?.session_id;
      calls.push({ method, sessionId, phase: "start" });
      if (method === "memory.episode.record") await gate;
      const result = await original.call(this, method, params);
      calls.push({ method, sessionId, phase: "end" });
      return result;
    });
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot, outboxRoot, captureMemoryEpisodes: true });
    const preStep = harness.listenersOf("agent/pre-step")[0] as unknown as (
      payload: unknown, next: () => Promise<unknown>,
    ) => Promise<unknown>;
    try {
      await preStep({ agent: { session }, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: "enter", messages: [{ id: "q", role: "user", content: [{ type: "text", text: "goal" }], source: { kind: "user" } }] }));
      session.events.push({ seq: 0, type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "answer" }] } } as unknown as TestMessage });
      await harness.emit("session/event", session, { seq: 0, type: "assistant/message", data: session.events[0]!.data });
      await harness.emit("session/event", session, { seq: 1, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
      await vi.waitFor(() => expect(calls.some((call) => call.method === "memory.episode.record")).toBe(true));
      // DSH dispatches session/flush listeners in parallel, not in registration order.
      const flush = Promise.all(harness.listenersOf("session/flush").map((listener) =>
        (listener as unknown as (session: TestSession) => unknown)(session)));
      await harness.emit("session/disposed", session);
      exactSession = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(projectionFlush).not.toHaveBeenCalled();
      expect(calls.some((call) => call.method === "event.append")).toBe(false);
      expect(calls.some((call) => call.method === "session.close")).toBe(false);
      release();
      await flush;
      expect(projectionFlush).toHaveBeenCalledWith({ id: session.id, header: session.header });
      await vi.waitFor(() => expect(calls.filter((call) => call.method === "session.close" && call.phase === "end")).toHaveLength(1));
      const methods = calls.filter((call) => call.sessionId === session.id).map((call) => `${call.method}:${call.phase}`);
      expect(methods.filter((method) => method === "session.open:start")).toHaveLength(1);
      expect(methods.indexOf("memory.episode.record:end")).toBeLessThan(methods.indexOf("event.append:start"));
      expect(methods.indexOf("session.flush:end")).toBeLessThan(methods.indexOf("session.close:start"));
      expect(calls.some((call) => call.method === "session.close" && call.sessionId === other.id)).toBe(false);
    } finally {
      release();
    }
  });

  it("waits for an in-flight recall and flushes the live tail on unload", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-unload-"));
    const session = makeSession("unload-tail");
    const harness = makeContext([session]);
    const original = BridgeClient.prototype.requestMethod;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    vi.spyOn(BridgeClient.prototype, "requestMethod").mockImplementation(async function (method, params) {
      calls.push(`${method}:start`);
      if (method === "memory.recall") await gate;
      const result = await original.call(this, method, params);
      calls.push(`${method}:end`);
      return result;
    });
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot, outboxRoot });
    const preStep = harness.listenersOf("agent/pre-step")[0] as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
    try {
      const step = preStep({ agent: { session }, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: "enter", messages: [{ id: "q", role: "user", content: [{ type: "text", text: "goal" }], source: { kind: "user" } }] }));
      await vi.waitFor(() => expect(calls).toContain("memory.recall:start"));
      await harness.emit("session/event", session, { seq: 0, type: "turn/start", data: { turn: 1 } });
      let unloaded = false;
      const unloading = dispose().then(() => { unloaded = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unloaded).toBe(false);
      release();
      await step;
      await unloading;
      dispose = undefined;
      expect(calls).toContain("session.flush:end");
      expect(calls).not.toContain("session.close:start");
      expect(snapshot(session.id).entries).toHaveLength(0);
    } finally {
      release();
    }
  });

  it("persists a resumed session event while the previous generation is retiring", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-generation-"));
    const oldSession = makeSession("reused-generation");
    const nextSession = makeSession("reused-generation");
    const harness = makeContext([oldSession]);
    const original = BridgeClient.prototype.requestMethod;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const batches: string[] = [];
    vi.spyOn(BridgeClient.prototype, "requestMethod").mockImplementation(async function (method, params) {
      if (method === "event.append") {
        batches.push(JSON.stringify(params));
        if (batches.length === 1) await gate;
      }
      return original.call(this, method, params);
    });
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot, outboxRoot });
    try {
      await harness.emit("session/event", oldSession, { seq: 0, type: "turn/start", data: { generation: "old" } });
      await harness.emit("session/disposed", oldSession);
      await vi.waitFor(() => expect(batches).toHaveLength(1));
      await harness.emit("session/created", nextSession);
      await harness.emit("session/event", nextSession, { seq: 1, type: "turn/start", data: { generation: "new" } });
      const namespace = createHash("sha256").update(realpathSync(repoRoot)).digest("hex");
      const snapshots = readdirSync(join(outboxRoot, namespace), { recursive: true }).filter((name) => name.endsWith(".outbox.json"))
        .map((name) => readFileSync(join(outboxRoot!, namespace, name), "utf8"));
      expect(snapshots.some((content) => content.includes('\\"generation\\":\\"new\\"'))).toBe(true);
      expect(batches).toHaveLength(1);
      release();
      await harness.emit("session/flush", oldSession);
    } finally {
      release();
    }
  });

  it("warns about unscoped legacy outboxes without modifying them", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-legacy-"));
    const legacyPath = join(outboxRoot, "legacy.outbox.json");
    const legacy = '{"session_id":"legacy","entries":[{"payload":"unowned"}]}';
    writeFileSync(legacyPath, legacy);
    const harness = makeContext();
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot, outboxRoot });
    await harness.emit("session/event", makeSession("fresh"), { seq: 1, type: "turn/start", data: { turn: 1 } });
    expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
    expect(harness.warnings.some((warning) => /legacy/i.test(warning) && warning.includes(legacyPath))).toBe(true);
  });

  it("isolates outboxes for different repositories sharing a session id", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-repos-"));
    const session = makeSession("same-repo-id");
    const first = makeContext([session]);
    // Simulate an interrupted flush, leaving the first repository's durable tail.
    const original = BridgeClient.prototype.requestMethod;
    vi.spyOn(BridgeClient.prototype, "requestMethod").mockImplementation(async function (method, params) {
      if (method === "event.append") throw new Error("offline");
      return original.call(this, method, params);
    });
    dispose = await apply(first.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot, outboxRoot });
    await first.emit("session/event", session, { seq: 0, type: "turn/start", data: { repository: "one" } });
    await dispose();
    dispose = undefined;
    vi.restoreAllMocks();
    const second = makeContext([session]);
    dispose = await apply(second.ctx, { libraExecutable: wrapper, repositoryRoot: tmpdir(), outboxRoot });
    await second.emit("session/event", session, { seq: 0, type: "turn/start", data: { repository: "two" } });
    const firstHash = createHash("sha256").update(realpathSync(repoRoot)).digest("hex");
    const secondHash = createHash("sha256").update(realpathSync(tmpdir())).digest("hex");
    const readEntries = (hash: string) => {
      const directory = readdirSync(join(outboxRoot!, hash), { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name !== ".session-locks")?.name;
      if (!directory) throw new Error("outbox generation is missing");
      return JSON.parse(readFileSync(join(outboxRoot!, hash, directory, `${session.id}.outbox.json`), "utf8")).entries;
    };
    expect(readEntries(firstHash)[0]).toMatchObject({ state: "pending", payload: expect.stringContaining("one") });
    expect(readEntries(secondHash)[0]).toMatchObject({ state: "pending", payload: expect.stringContaining("two") });
  });

  it("preserves live sessions when the plugin is unloaded", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-hmr-"));
    const session = makeSession("live-hmr");
    const harness = makeContext([session]);
    const request = vi.spyOn(BridgeClient.prototype, "requestMethod");
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot, outboxRoot });
    const preStep = harness.listenersOf("agent/pre-step")[0] as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
    await preStep({ agent: { session }, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [{ id: "q", role: "user", content: [{ type: "text", text: "goal" }], source: { kind: "user" } }] }));
    await dispose();
    dispose = undefined;
    expect(request.mock.calls.some(([method]) => method === "session.close")).toBe(false);
  });

  it("keeps undelivered events and does not close on a failed flush", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-failure-"));
    const session = makeSession("failed-flush");
    const harness = makeContext([session]);
    const original = BridgeClient.prototype.requestMethod;
    const calls: string[] = [];
    vi.spyOn(BridgeClient.prototype, "requestMethod").mockImplementation(async function (method, params) {
      calls.push(method);
      if (method === "event.append") throw new Error("offline");
      return original.call(this, method, params);
    });
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot, outboxRoot });
    await harness.emit("session/event", session, { seq: 0, type: "turn/start", data: { turn: 1 } });
    await harness.emit("session/disposed", session);
    await vi.waitFor(() => expect(harness.warnings.some((warning) => warning.includes("flush failed"))).toBe(true));
    expect(calls.filter((method) => method === "session.close")).toHaveLength(0);
    expect(snapshot(session.id).entries).toHaveLength(1);
  });

  function snapshot(sessionId: string): {
    last_acked_seq: number;
    entries: unknown[];
  } {
    const namespace = createHash("sha256").update(realpathSync(repoRoot)).digest("hex");
    const files = readdirSync(join(outboxRoot!, namespace), { recursive: true }).filter((file) => file.endsWith(".outbox.json"));
    const path = files.find((file) => file.endsWith(`/${sessionId}.outbox.json`));
    if (!path) throw new Error(`outbox not captured for ${sessionId}`);
    return JSON.parse(readFileSync(join(outboxRoot!, namespace, path), "utf8"));
  }

  it("captures session events and drains them on flush", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-"));
    const session = makeSession("s-10", "parent-9");
    const harness = makeContext([session]);
    dispose = await apply(harness.ctx, {
      libraExecutable: wrapper,
      repositoryRoot: repoRoot,
      outboxRoot,
    });
    await harness.emit("session/event", session, {
      seq: 0,
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } },
    });
    await harness.emit("session/event", session, {
      seq: 1,
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: "again" }], source: { kind: "user" } },
    });
    expect(readdirSync(join(outboxRoot, createHash("sha256").update(realpathSync(repoRoot)).digest("hex")), { recursive: true }).some((entry) => entry.endsWith("/s-10.outbox.json"))).toBe(true);
    expect(snapshot("s-10").entries).toHaveLength(2);

    await harness.emit("session/flush", session);

    const drained = snapshot("s-10");
    expect(drained.last_acked_seq).toBe(1);
    expect(drained.entries).toHaveLength(0);
    expect(harness.warnings).toHaveLength(0);
  });

  it("contains flush failures instead of rejecting the session pipeline", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-"));
    const session = makeSession("s-11");
    const harness = makeContext([session]);
    dispose = await apply(harness.ctx, {
      libraExecutable: wrapper,
      repositoryRoot: repoRoot,
      outboxRoot,
    });
    // Events from a session whose outbox never opens: capture succeeds, flush
    // runs against the bridge (fake bridge acks), so no warning is expected.
    await harness.emit("session/event", session, {
      seq: 0,
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } },
    });
    await harness.emit("session/flush", session);
    expect(snapshot("s-11").last_acked_seq).toBe(0);
    // Any handler failure must be logged, never thrown out of emit.
    expect(harness.warnings.every((entry) => entry.startsWith("libra-outbox:"))).toBe(true);
  });
});
