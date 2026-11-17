import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { apply } from "@libra/dsh-bundle";

const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
chmodSync(wrapper, 0o755);

const listenerMap = new Map<string, Array<(...args: never[]) => unknown>>();
const warnings: string[] = [];
const session = {
  id: "utf8-episode",
  header: {},
  ownEvents: () => events,
  surface: { replaceGeneration: 0, nodes: [] },
};
const events: Array<{ type: string; data: unknown }> = [];
const ctx = {
  sessions: { list: () => [session] },
  logger: { warn: (message: string) => warnings.push(message) },
  get: () => undefined,
  on: (event: string, listener: (...args: never[]) => unknown) => {
    const listeners = listenerMap.get(event) ?? [];
    listeners.push(listener);
    listenerMap.set(event, listeners);
    return () => listeners.splice(listeners.indexOf(listener), 1);
  },
} as unknown as Context;
const preStep = () => listenerMap.get("agent/pre-step")?.[0] as unknown as (
  payload: unknown, next: () => Promise<unknown>,
) => Promise<unknown>;
const textEncoder = new TextEncoder();
const bytes = (value: string) => textEncoder.encode(value).length;

afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "exact boundary", goal: "a".repeat(4096), answer: "中".repeat(5460) + "a".repeat(4), truncated: false },
  { name: "one byte beyond boundary", goal: "a".repeat(4097), answer: "a".repeat(16385), truncated: true },
  { name: "multibyte code point boundary", goal: "a".repeat(4093) + "🙂" + "tail", answer: "中".repeat(4000) + "b".repeat(4384) + "🙂" + "tail", truncated: true },
])("keeps $name valid without changing exact-length content", async ({ goal, answer, truncated }) => {
  const original = BridgeClient.prototype.requestMethod;
  let record: Record<string, unknown> | undefined;
  vi.spyOn(BridgeClient.prototype, "requestMethod").mockImplementation(async function (method, params) {
    if (method === "memory.episode.record") record = params as Record<string, unknown>;
    return original.call(this, method, params);
  });
  events.splice(0, events.length, { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: answer }] } } });
  const dispose = await apply(ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot, captureMemoryEpisodes: true });
  try {
    await preStep()(
      { agent: { session }, turn: 2, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: goal }], source: { kind: "user" } }] }),
    );
    listenerMap.get("session/event")?.[1]?.call(ctx, session as never, { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } } as never);
    await vi.waitFor(() => expect(record).toBeDefined());
    expect(bytes(record!.goal as string)).toBeLessThanOrEqual(4096);
    expect(bytes(record!.response_text as string)).toBeLessThanOrEqual(16384);
    expect(record!.goal).not.toContain("�");
    expect(record!.response_text).not.toContain("�");
    if (!truncated) {
      expect(record!.goal).toBe(goal);
      expect(record!.response_text).toBe(answer);
    } else {
      expect(record!.goal).toContain("[TRUNCATED");
      expect(record!.response_text).toContain("[TRUNCATED");
    }
  } finally {
    await dispose();
  }
});

it("records marked, valid UTF-8 within limits and never logs original content", async () => {
  const original = BridgeClient.prototype.requestMethod;
  let record: Record<string, unknown> | undefined;
  vi.spyOn(BridgeClient.prototype, "requestMethod").mockImplementation(async function (method, params) {
    if (method === "memory.episode.record") record = params as Record<string, unknown>;
    return original.call(this, method, params);
  });
  const goal = `秘密目标-${"目标🙂".repeat(1500)}`;
  const answer = `秘密回答-${"回答🙂".repeat(6000)}`;
  events.push({ type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: answer }] } } });
  const dispose = await apply(ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot, captureMemoryEpisodes: true });
  try {
    await preStep()(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: goal }], source: { kind: "user" } }] }),
    );
    listenerMap.get("session/event")?.[1]?.call(ctx, session as never, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } as never);
    await vi.waitFor(() => expect(record).toBeDefined());
    expect(bytes(record!.goal as string)).toBeLessThanOrEqual(4096);
    expect(bytes(record!.response_text as string)).toBeLessThanOrEqual(16384);
    expect(record!.goal).toContain("[TRUNCATED");
    expect(record!.response_text).toContain("[TRUNCATED");
    expect(record!.goal).not.toContain("�");
    expect(record!.response_text).not.toContain("�");
    expect(warnings.some((warning) => warning.includes("field=goal bytes=") && warning.includes("turn=1") && warning.includes("utf8-episode"))).toBe(true);
    expect(warnings.join("\n")).not.toContain("秘密目标");
    expect(warnings.join("\n")).not.toContain("秘密回答");
  } finally {
    await dispose();
  }
});
