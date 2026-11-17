import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";

import { apply } from "@libra/dsh-bundle";

import {
  libraMemoryProjectionApply,
  type LibraMemoryProjectionState,
} from "../../packages/bundle/src/memory-projection.js";

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

function makeSession(id: string): TestSession {
  const session: TestSession = {
    id,
    header: {},
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

function user(text: string): TestMessage {
  return {
    id: `user-${text}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function makeContext(): {
  ctx: Context;
  warnings: string[];
  listenersOf(event: string): Array<(...args: never[]) => unknown>;
} {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
  const warnings: string[] = [];
  const ctx = {
    sessions: { list: () => [] },
    logger: { warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")) },
    get: () => undefined,
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
    warnings,
    listenersOf: (event) => listeners.get(event) ?? [],
  };
}

describe("libra-memory session projection fold", () => {
  it("tracks delivered sequences and drops shadowed ones", () => {
    const first = libraMemoryProjectionApply({ seqs: [] }, {
      type: "user/message",
      seq: 2,
      data: { source: { kind: "libra-memory" } },
    });
    expect(first.seqs).toEqual([2]);

    const second = libraMemoryProjectionApply(first, {
      type: "user/message",
      seq: 5,
      data: { source: { kind: "libra-memory" } },
    });
    expect(second.seqs).toEqual([2, 5]);

    const cleared = libraMemoryProjectionApply(second, {
      type: "user/message",
      seq: 6,
      data: { source: { kind: "libra-memory-clear", seqs: [2] } },
    });
    expect(cleared.seqs).toEqual([5]);
  });

  it("returns the same reference for unrelated events", () => {
    const state: LibraMemoryProjectionState = { seqs: [1] };
    const unchanged = libraMemoryProjectionApply(state, {
      type: "system/message",
      seq: 9,
      data: {},
    });
    expect(unchanged).toBe(state);
    const ignored = libraMemoryProjectionApply(state, {
      type: "user/message",
      seq: 10,
      data: { source: { kind: "user" } },
    });
    expect(ignored).toBe(state);
  });
});

describe("degraded activation", () => {
  it("activates inertly when no libra executable is configured", async () => {
    const harness = makeContext();
    const dispose = await apply(harness.ctx, {});
    expect(typeof dispose).toBe("function");
    expect(harness.warnings.some((entry) => entry.includes("plugin inactive"))).toBe(true);
    await dispose();
  });

  it("stays inactive when a configured executable cannot be found", async () => {
    const harness = makeContext();
    const dispose = await apply(harness.ctx, { libraExecutable: "libra-not-installed-xyz" });
    expect(harness.warnings.some((entry) => entry.includes("not found"))).toBe(true);
    expect(harness.listenersOf("agent/pre-step")).toHaveLength(0);
    await dispose();
  });

  it("resolves a bare executable name from PATH", async () => {
    const previous = process.env.PATH;
    process.env.PATH = `${dirname(wrapper)}${delimiter}${previous ?? ""}`;
    const harness = makeContext();
    const outboxRoot = mkdtempSync(join(tmpdir(), "libra-outbox-path-"));
    let dispose: (() => Promise<void>) | undefined;
    try {
      dispose = await apply(harness.ctx, {
        libraExecutable: "fake-bridge-wrapper.sh",
        repositoryRoot: repoRoot,
        outboxRoot,
      });
      expect(harness.warnings).toEqual([]);
      expect(harness.listenersOf("agent/pre-step").length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await dispose?.();
      rmSync(outboxRoot, { recursive: true, force: true });
    }
  });
});

describe("memory token budget cap", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it("asks Libra to apply the token budget instead of truncating a hashed section", async () => {
    const harness = makeContext();
    const session = makeSession("budget-s1");
    dispose = await apply(harness.ctx, {
      libraExecutable: wrapper,
      repositoryRoot: repoRoot,
      memoryTokenBudget: 1,
    });
    const preStep = harness.listenersOf("agent/pre-step")[0] as (
      payload: {
        agent: { session: TestSession };
        turn: number;
        step: number;
        signal: AbortSignal;
      },
      next: () => Promise<{ kind: "reject" } | { kind: "enter"; messages: TestMessage[] }>,
    ) => Promise<{ kind: "reject" } | { kind: "enter"; messages: TestMessage[] }>;

    const decision = await preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("probe")] }),
    );
    expect(decision.kind).toBe("enter");
    const last = (decision as { kind: "enter"; messages: TestMessage[] }).messages.at(-1);
    expect(last?.source.kind).toBe("libra-memory");
    const text = last?.content[0]?.text ?? "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4);
    expect(text).not.toContain("truncated to token budget");
    expect(last?.source.bundleHash).toBe(
      `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`,
    );
  });
});
