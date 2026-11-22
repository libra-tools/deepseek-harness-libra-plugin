import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Context } from "@deepseek-ai/cordis";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { mountLibraOutbox } from "../../packages/bundle/src/outbox.js";
import {
  OutboxCorruptionError,
  OutboxStore,
  SessionProjectionService,
  redactPayload,
} from "@libra/dsh-session";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

function makeProjection(): { service: SessionProjectionService; bridge: BridgeClient; outboxRoot: string } {
  const outboxRoot = mkdtempSync(join(tmpdir(), "dsh-outbox-"));
  const bridge = new BridgeClient({
    executable: wrapper,
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "" },
  });
  const service = new SessionProjectionService(new OutboxStore(outboxRoot), bridge);
  return { service, bridge, outboxRoot };
}

describe("session-projection", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
    vi.restoreAllMocks();
  });

  it("projects a batch through the bridge", async () => {
    const { service, bridge: client } = makeProjection();
    bridge = client;
    await bridge.connect();
    const session = { id: "s1" };
    service.capture({ session_id: session.id, event_seq: 1, event_type: "tool/result", payload: '{"tool":"libra_status","ok":true}' });
    await service.flush(session);
    expect(service.metrics("s1").queued_events).toBe(0);
    expect(service.metrics("s1").active_sessions).toBe(1);
  });

  it("opens a captured session before appending its events", async () => {
    const { service, bridge: client } = makeProjection();
    bridge = client;
    await bridge.connect();
    const request = vi.spyOn(bridge, "requestMethod");
    const session = { id: "capture-before-open" };
    service.capture({ session_id: session.id, event_seq: 1, event_type: "tool/result", payload: '{"ok":true}' });
    await service.flush(session);
    const methods = request.mock.calls.map(([method]) => method);
    expect(methods.indexOf("session.open")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("session.open")).toBeLessThan(methods.indexOf("event.append"));
  });

  it("opens a captured child with its parent when disposed before open", async () => {
    const { bridge: client } = makeProjection();
    bridge = client;
    await bridge.connect();
    const request = vi.spyOn(bridge, "requestMethod");
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const ctx = {
      logger: { warn: vi.fn() },
      on: (event: string, listener: (...args: never[]) => unknown) => {
        listeners.set(event, listener);
        return () => { listeners.delete(event); };
      },
    } as unknown as Context;
    const mounted = mountLibraOutbox(ctx, bridge, {
      repositoryRoot: repoRoot,
      outboxRoot: mkdtempSync(join(tmpdir(), "dsh-outbox-dispose-")),
    });
    const session = { id: "child-dispose", header: { parentSession: "parent" } };
    const emit = (event: string, ...args: unknown[]) =>
      (listeners.get(event) as (...args: unknown[]) => unknown)(...args);
    emit("session/event", session, { seq: 1, type: "tool/result", data: { ok: true } });
    emit("session/disposed", session);
    await mounted.wait(session as never);
    expect(request).toHaveBeenCalledWith("session.open", {
      session_id: "child-dispose",
      parent_session_id: "parent",
    });
    await mounted.dispose();
  });

  it("stores parent_session_id for subagent lineage", async () => {
    const { service, bridge: client, outboxRoot } = makeProjection();
    bridge = client;
    await bridge.connect();
    service.capture({
      session_id: "child",
      parent_session_id: "parent",
      event_seq: 1,
      event_type: "tool/result",
      payload: '{"ok":true}',
    });
    const outbox = new OutboxStore(outboxRoot);
    expect(outbox.load("child").parent_session_id).toBe("parent");
    await service.flush({ id: "child" });
  });

  it("reports durable pending, rejected, gap and acknowledgement state", () => {
    const outbox = new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-status-")));
    outbox.enqueue({ session_id: "status", event_seq: 1, event_type: "message", payload: "one" });
    outbox.enqueue({ session_id: "status", event_seq: 3, event_type: "message", payload: "three" });
    outbox.applyAppendResult("status", 1, [{ seq: 1, status: "accepted" }]);
    const status = outbox.captureStatus("status");
    expect(status).toMatchObject({
      pending_events: 1,
      last_acked_seq: 1,
      first_pending_seq: 3,
      gap: true,
      rejected_events: 0,
      conflict_events: 0,
    });
  });

  it("keeps a gap after accepted events are flushed and after reload", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-outbox-gap-"));
    const outbox = new OutboxStore(root);
    for (const seq of [1, 3]) {
      outbox.enqueue({ session_id: "gap", event_seq: seq, event_type: "message", payload: `e${seq}` });
    }
    outbox.applyAppendResult("gap", 1, [
      { seq: 1, status: "accepted" },
      { seq: 3, status: "accepted" },
    ]);
    expect(outbox.captureStatus("gap")).toMatchObject({ pending_events: 0, last_acked_seq: 1, gap: true });
    const reloaded = new OutboxStore(root);
    expect(reloaded.captureStatus("gap").gap).toBe(true);
  });

  it("marks pruned rejected diagnostics as a lower bound", () => {
    const outbox = new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-prune-")));
    for (let seq = 1; seq <= 65; seq += 1) {
      outbox.enqueue({
        session_id: "pruned",
        event_seq: seq,
        event_type: "message",
        payload: "token sk-abcdefghijklmnopqrstuvwxyz",
      });
    }
    const status = outbox.captureStatus("pruned");
    expect(status.rejected_events).toBe(64);
    expect(status.rejected_truncated).toBe(true);
  });

  it("distinguishes bridge conflicts from other rejections", () => {
    const outbox = new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-conflict-")));
    for (const seq of [1, 2]) {
      outbox.enqueue({ session_id: "conflict", event_seq: seq, event_type: "message", payload: `e${seq}` });
    }
    outbox.applyAppendResult("conflict", 2, [
      { seq: 1, status: "conflict" },
      { seq: 2, status: "rejected" },
    ]);
    expect(outbox.captureStatus("conflict")).toMatchObject({
      pending_events: 0,
      rejected_events: 2,
      conflict_events: 1,
      gap: false,
    });
  });

  it("reports an enqueue failure as paused even with no pending events", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-outbox-paused-"));
    // A one-byte store capacity rejects the first payload and pauses the session.
    const service = new SessionProjectionService(new OutboxStore(root, 1), { connect: async () => ({}) } as unknown as BridgeClient);
    expect(() => service.capture({ session_id: "paused", event_seq: 1, event_type: "message", payload: "one" }))
      .toThrow(/quota/);
    expect(service.status("paused")).toMatchObject({ pending_events: 0, paused: true });
  });

  it("emits drain warning when dispose times out with pending events", async () => {
    const { service, bridge: client } = makeProjection();
    bridge = client;
    await bridge.connect();
    service.capture({
      session_id: "slow",
      event_seq: 1,
      event_type: "message",
      payload: '{"kind":"assistant"}',
    });
    const result = await service.dispose({ id: "slow" }, 0);
    expect(result.drained).toBe(false);
    expect(result.warnings.some((w) => w.includes("drain incomplete"))).toBe(true);
  });

  it("reports a rejected session.close instead of treating it as success", async () => {
    const { service, bridge: client } = makeProjection();
    bridge = client;
    await bridge.connect();
    await service.open({ id: "close-error" });
    const request = vi.spyOn(bridge, "requestMethod");
    request.mockResolvedValueOnce({ id: 123, method: "session.close", state: "error_fatal", error: { code: -1, message: "close refused" } });
    await expect(service.dispose({ id: "close-error" })).rejects.toThrow("close refused");
    request.mockRestore();
  });

  it("concurrent session limit does not pause other sessions", () => {
    const service = new SessionProjectionService(
      new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-conc-"))),
      { connect: async () => ({}) } as unknown as BridgeClient,
      { maxConcurrentSessions: 1 },
    );
    service.capture({
      session_id: "s1",
      event_seq: 1,
      event_type: "message",
      payload: '{"a":1}',
    });
    expect(() =>
      service.capture({
        session_id: "s2",
        event_seq: 1,
        event_type: "message",
        payload: '{"b":1}',
      }),
    ).toThrow(/concurrent session limit/);
    expect(() =>
      service.capture({
        session_id: "s1",
        event_seq: 2,
        event_type: "message",
        payload: '{"a":2}',
      }),
    ).not.toThrow();
  });
});

describe("session-projection:duplicate-and-replay", () => {
  it("deduplicates identical (session_id,event_seq)", () => {
    const outbox = new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-dup-")));
    const event = {
      session_id: "s1",
      event_seq: 1,
      event_type: "message",
      payload: '{"kind":"assistant"}',
    };
    outbox.enqueue(event);
    outbox.enqueue(event);
    const snapshot = outbox.load("s1");
    expect(snapshot.entries.filter((e) => e.event_seq === 1).length).toBe(1);
  });

  it("rejects corrupt snapshots and traversal session ids", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-outbox-corrupt-"));
    writeFileSync(join(root, "broken.outbox.json"), "{not-json", "utf8");
    const outbox = new OutboxStore(root);
    expect(() => outbox.load("broken")).toThrow(OutboxCorruptionError);
    expect(() => outbox.load("../escape")).toThrow(OutboxCorruptionError);
  });

  it("preserves unreported pending events below the server cursor", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-outbox-cursor-"));
    const outbox = new OutboxStore(root);
    for (const event_seq of [1, 2, 3, 4, 5]) {
      outbox.enqueue({ session_id: "cursor", event_seq, event_type: "message", payload: `event-${event_seq}` });
    }
    outbox.applyAppendResult("cursor", 100, [
      { seq: 1, status: "accepted" },
      { seq: 2, status: "duplicate" },
      { seq: 3, status: "conflict" },
      { seq: 4, status: "rejected" },
    ]);
    const snapshot = new OutboxStore(root).load("cursor");
    expect(snapshot.last_acked_seq).toBe(100);
    expect(snapshot.entries.map(({ event_seq, state, last_error }) => ({ event_seq, state, last_error }))).toEqual([
      { event_seq: 3, state: "rejected", last_error: "bridge event status: conflict" },
      { event_seq: 4, state: "rejected", last_error: "bridge event status: rejected" },
      { event_seq: 5, state: "pending", last_error: undefined },
    ]);
  });

  it("applies partial acknowledgements by per-event status", () => {
    const outbox = new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-partial-")));
    for (const event_seq of [1, 2]) {
      outbox.enqueue({ session_id: "partial", event_seq, event_type: "message", payload: `event-${event_seq}` });
    }
    outbox.applyAppendResult("partial", 2, [
      { seq: 1, status: "accepted" },
      { seq: 2, status: "conflict" },
    ]);
    const snapshot = outbox.load("partial");
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.state).toBe("rejected");
    expect(snapshot.last_acked_seq).toBe(2);
  });
});

describe("session-projection:crash-and-resume", () => {
  it("resumes from last ack after reloading outbox", async () => {
    const outboxRoot = mkdtempSync(join(tmpdir(), "dsh-outbox-crash-"));
    const outbox = new OutboxStore(outboxRoot);
    outbox.enqueue({
      session_id: "s1",
      event_seq: 1,
      event_type: "message",
      payload: '{"kind":"assistant"}',
    });
    outbox.markAcked("s1", 1);
    const reloaded = new OutboxStore(outboxRoot);
    expect(reloaded.load("s1").last_acked_seq).toBe(1);
  });
});

describe("session-projection:redaction", () => {
  it("fail-closes on secret payloads", () => {
    const result = redactPayload('token sk-abcdefghijklmnopqrstuvwxyz');
    expect(result.ok).toBe(false);
  });

  it("prunes excess rejected diagnostic entries", () => {
    const outbox = new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-rej-")), 1024 * 1024, 2);
    for (let i = 1; i <= 5; i++) {
      outbox.enqueue({
        session_id: "s1",
        event_seq: i,
        event_type: "message",
        payload: `sk-${"a".repeat(24)}`,
      });
    }
    outbox.markAcked("s1", 0);
    const snapshot = outbox.load("s1");
    expect(snapshot.entries.filter((e) => e.state === "rejected").length).toBeLessThanOrEqual(2);
  });
});
