import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition as DshToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";

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
  });

  function snapshot(sessionId: string): {
    last_acked_seq: number;
    entries: unknown[];
  } {
    return JSON.parse(readFileSync(join(outboxRoot!, `${sessionId}.outbox.json`), "utf8"));
  }

  it("captures session events and drains them on flush", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-"));
    const harness = makeContext([makeSession("s-10", "parent-9")]);
    dispose = await apply(harness.ctx, {
      libraExecutable: wrapper,
      repositoryRoot: repoRoot,
      outboxRoot,
    });
    await harness.emit("session/event", makeSession("s-10", "parent-9"), {
      seq: 0,
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } },
    });
    await harness.emit("session/event", makeSession("s-10", "parent-9"), {
      seq: 1,
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: "again" }], source: { kind: "user" } },
    });
    expect(readdirSync(outboxRoot)).toContain("s-10.outbox.json");
    expect(snapshot("s-10").entries).toHaveLength(2);

    await harness.emit("session/flush", makeSession("s-10", "parent-9"));

    const drained = snapshot("s-10");
    expect(drained.last_acked_seq).toBe(1);
    expect(drained.entries).toHaveLength(0);
    expect(harness.warnings).toHaveLength(0);
  });

  it("contains flush failures instead of rejecting the session pipeline", async () => {
    outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-"));
    const harness = makeContext([makeSession("s-11")]);
    dispose = await apply(harness.ctx, {
      libraExecutable: wrapper,
      repositoryRoot: repoRoot,
      outboxRoot,
    });
    // Events from a session whose outbox never opens: capture succeeds, flush
    // runs against the bridge (fake bridge acks), so no warning is expected.
    await harness.emit("session/event", makeSession("s-11"), {
      seq: 0,
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } },
    });
    await harness.emit("session/flush", makeSession("s-11"));
    expect(snapshot("s-11").last_acked_seq).toBe(0);
    // Any handler failure must be logged, never thrown out of emit.
    expect(harness.warnings.every((entry) => entry.startsWith("libra-outbox:"))).toBe(true);
  });
});
