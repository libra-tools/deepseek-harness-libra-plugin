import { chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";
import { ToolsFacade } from "@libra/dsh-tools";

import { mountLibraContext } from "../../packages/bundle/src/context.js";
import { mountLibraWorkspace } from "../../packages/bundle/src/workspace.js";

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

function user(text: string): TestMessage {
  return {
    id: `user-${text}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

interface TestHarness {
  ctx: Context;
  emit(event: string, ...args: unknown[]): Promise<void>;
  listenersOf(event: string): Array<(...args: never[]) => unknown>;
}

function makeContext(seed: TestSession[] = []): TestHarness {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
  const ctx = {
    sessions: { list: () => [...seed] },
    logger: { warn: () => undefined },
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
    listenersOf: (event) => listeners.get(event) ?? [],
    emit: async (event, ...args) => {
      for (const entry of listeners.get(event) ?? []) {
        await (entry as unknown as (...value: unknown[]) => unknown)(...args);
      }
    },
  };
}

interface PreStepPayload {
  agent: { session: TestSession };
  turn: number;
  step: number;
  signal: AbortSignal;
}

type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<{ kind: "reject" } | { kind: "enter"; messages: TestMessage[] }>,
) => Promise<{ kind: "reject" } | { kind: "enter"; messages: TestMessage[] }>;

function makeBridge(): BridgeClient {
  return new BridgeClient({
    executable: wrapper,
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", LIBRA_SKIP_WEB_BUILD: "1" },
  });
}

describe("workspace lease binding", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close().catch(() => undefined);
    bridge = undefined;
  });

  it("claims on session/created and releases on session/disposed", async () => {
    bridge = makeBridge();
    await bridge.connect();
    const harness = makeContext();
    const mount = mountLibraWorkspace(harness.ctx, bridge, { repositoryRoot: repoRoot });

    await harness.emit("session/created", makeSession("w-1"));
    await vi.waitFor(() => {
      expect(mount.binding.getHandle("w-1")).toBeDefined();
    });
    expect(mount.binding.getHandle("w-1")?.workspace_id).toBe(repoRoot);

    await harness.emit("session/disposed", makeSession("w-1"));
    await vi.waitFor(() => {
      expect(mount.binding.getHandle("w-1")).toBeUndefined();
    });
    mount.dispose();
  });

  it("links forked sessions to the parent workspace lease", async () => {
    bridge = makeBridge();
    await bridge.connect();
    const harness = makeContext();
    const mount = mountLibraWorkspace(harness.ctx, bridge, { repositoryRoot: repoRoot });

    await harness.emit("session/created", makeSession("w-parent"));
    await vi.waitFor(() => {
      expect(mount.binding.getHandle("w-parent")).toBeDefined();
    });
    await harness.emit("session/created", makeSession("w-child", "w-parent"));
    await vi.waitFor(() => {
      expect(mount.binding.getHandle("w-child")).toBeDefined();
    });
    expect(mount.binding.getHandle("w-child")?.parent_session_id).toBe("w-parent");
    mount.dispose();
  });
});

describe("context injection", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close().catch(() => undefined);
    bridge = undefined;
  });

  it("injects one bounded context snapshot on the first turn only", async () => {
    bridge = makeBridge();
    await bridge.connect();
    const tools = new ToolsFacade(bridge, {
      allowRead: true,
      allowWrite: true,
      allowRestore: true,
      allowPushPublish: false,
    });
    const harness = makeContext([makeSession("c-1")]);
    const dispose = mountLibraContext(harness.ctx, tools, { pluginName: "@libra-tools/dsh-bundle" });
    const preStep = harness.listenersOf("agent/pre-step")[0] as PreStepListener;

    const first = await preStep(
      { agent: { session: makeSession("c-1") }, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("probe")], startsRequestSeries: true }),
    );
    expect(first).toMatchObject({ kind: "enter", startsRequestSeries: true });
    const injected = (first as { kind: "enter"; messages: TestMessage[] }).messages.at(-1);
    expect(injected?.source.kind).toBe("libra-context");
    expect(injected?.content[0]?.text).toContain("decision summary");

    const later = await preStep(
      { agent: { session: makeSession("c-1") }, turn: 2, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("probe-2")] }),
    );
    expect((later as { kind: "enter"; messages: TestMessage[] }).messages).toHaveLength(1);

    dispose();
  });

  it("skips injection when the bridge returns an empty slice", async () => {
    bridge = makeBridge();
    await bridge.connect();
    const tools = new ToolsFacade(bridge, {
      allowRead: true,
      allowWrite: true,
      allowRestore: true,
      allowPushPublish: false,
    });
    const harness = makeContext();
    const dispose = mountLibraContext(harness.ctx, tools, { pluginName: "@libra-tools/dsh-bundle" });
    const preStep = harness.listenersOf("agent/pre-step")[0] as PreStepListener;
    const rejected = await preStep(
      { agent: { session: makeSession("c-2") }, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "reject" }),
    );
    expect(rejected.kind).toBe("reject");
    dispose();
  });
});
