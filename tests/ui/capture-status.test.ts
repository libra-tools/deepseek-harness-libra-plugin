import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BridgeClientError, type BridgeClient, type CompletedRequest } from "@libra/dsh-bridge-client";
import type { CaptureStatus } from "@libra/dsh-session";
import {
  LibraCaptureStatusService,
  parseCheckpointRows,
  applyRejectedSpool,
  hasQuarantinedSpool,
  hasSpoolFailure,
  readCaptureStatus,
  readRejectedSpoolEvents,
  recordRejectedSpoolEvent,
  recordSpoolFailure,
  withSpooledCapture,
  type CaptureScope,
} from "../../packages/bundle/src/capture-status.js";
import { mergeCaptureStatus, summarizeCaptureGenerations } from "../../packages/bundle/src/outbox.js";

const SESSION = { id: "session-1" };
const CAPTURE: CaptureStatus = {
  session_id: "session-1",
  pending_events: 2,
  rejected_events: 1,
  conflict_events: 1,
  last_acked_seq: 7,
  first_pending_seq: 9,
  gap: false,
  paused: false,
  recovery_pending: false,
  rejected_truncated: false,
};

function bridge(overrides: Partial<BridgeClient> = {}, methods: string[] = ["checkpoint.list"]): BridgeClient {
  return {
    contract: { methods },
    negotiatedCapabilities: { methods },
    requestMethod: vi.fn(async () => ({
      id: 1,
      method: "checkpoint.list",
      state: "success",
      result: {
        schema_version: 1,
        data: {
          limit: 20,
          checkpoints: [{
            checkpoint_id: "cp-1",
            bridge_session_id: "session-1",
            agent_checkpoint_id: "agent-cp-1",
            target_oid: "e".repeat(40),
          }],
        },
      },
    })),
    ...overrides,
  } as unknown as BridgeClient;
}

function scope(client: BridgeClient): CaptureScope {
  return { capture: CAPTURE, bridge: client, bindingKey: "key-1", generation: 3 };
}

describe("spool failure evidence", () => {
  it("persists a failure marker that survives a fresh reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-spool-failure-"));
    recordSpoolFailure(dir, "session-1");
    recordSpoolFailure(dir, "session-1");
    expect(hasSpoolFailure(dir, "session-1")).toBe(true);
    expect(hasSpoolFailure(dir, "session-2")).toBe(false);
  });

  it("keeps durable evidence in the temporary fallback when both configured paths fail", () => {
    const fallback = mkdtempSync(join(tmpdir(), "capture-spool-fallback-tmp-"));
    recordSpoolFailure("/dev/null/spool", "session-1", fallback);
    expect(readFileSync(join(fallback, "spool-failures.jsonl"), "utf8")).toContain("session-1");
    expect(hasSpoolFailure("/dev/null/spool", "session-1", fallback)).toBe(true);
    // A stat failure with no matching evidence fails closed rather than "clean".
    expect(() => hasSpoolFailure("/dev/null/spool", "session-2", fallback)).toThrow();
  });

  it("falls back to the outbox root when the spool path cannot be written", () => {
    const parent = mkdtempSync(join(tmpdir(), "capture-spool-fallback-"));
    const dir = join(parent, "pending-events");
    // A file where the spool directory should be makes the primary write fail;
    // the sibling ledger remains durable and a new reader can still detect it.
    writeFileSync(dir, "not a directory");
    recordSpoolFailure(dir, "session-1");
    expect(readFileSync(join(parent, "spool-failures.jsonl"), "utf8")).toContain("session-1");
    expect(hasSpoolFailure(dir, "session-1")).toBe(true);
  });
});

describe("spool rejection evidence", () => {
  it("refuses to overwrite a malformed marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-rejections-bad-"));
    writeFileSync(join(dir, "session-1.rejections.json"), JSON.stringify({ count: "bad" }));
    expect(() => recordRejectedSpoolEvent(dir, "session-1")).toThrow(/malformed/);
    expect(() => readRejectedSpoolEvents(dir, "session-1")).toThrow(/invalid rejection count/);
  });

  it("persists only a payload-free count across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-rejections-"));
    recordRejectedSpoolEvent(dir, "session-1");
    recordRejectedSpoolEvent(dir, "session-1");
    expect(readRejectedSpoolEvents(dir, "session-1")).toBe(2);
    expect(applyRejectedSpool(null, "session-1", 2)).toMatchObject({
      session_id: "session-1",
      rejected_events: 2,
      pending_events: 0,
    });
    expect(readRejectedSpoolEvents(dir, "session-2")).toBe(0);
  });
});

describe("spooled fallback capture", () => {
  it("detects timestamped quarantine files for this Session only", () => {
    expect(hasQuarantinedSpool("session-1", [
      "session-1.quarantine-1700000000000.jsonl",
      "other.abc.jsonl",
    ])).toBe(true);
    expect(hasQuarantinedSpool("session-1", ["session-1.abc.jsonl"])).toBe(false);
    expect(hasQuarantinedSpool("session-1", ["session-10.quarantine-1.jsonl"])).toBe(false);
  });

  it("keeps capture recovery-pending while a fallback spool still holds events", () => {
    expect(withSpooledCapture(null, "s1", true)).toMatchObject({
      session_id: "s1",
      recovery_pending: true,
      pending_events: 0,
    });
    expect(withSpooledCapture(CAPTURE, "s1", true)).toMatchObject({ recovery_pending: true });
    expect(withSpooledCapture(null, "s1", false)).toBeNull();
  });
});

describe("capture generation aggregation", () => {
  it("keeps pending and newer acknowledgement from an older generation visible", () => {
    expect(mergeCaptureStatus(undefined, [{
      last_acked_seq: 4,
      entries: [{ event_seq: 5, state: "pending" }],
    }])).toMatchObject({ pending_events: 1, last_acked_seq: 4, recovery_pending: true });

    expect(mergeCaptureStatus(CAPTURE, [{
      last_acked_seq: 9,
      entries: [{ event_seq: 9, state: "acked" }],
    }])).toMatchObject({ last_acked_seq: 9, recovery_pending: true });
  });

  it("does not report recovery for a clean retired generation", () => {
    expect(mergeCaptureStatus(CAPTURE, [{ last_acked_seq: 7, entries: [] }])).toMatchObject({
      recovery_pending: false,
    });
  });
});

describe("capture generation validation", () => {
  it("rejects a snapshot that belongs to another Session or has inconsistent bytes", () => {
    const foreign = summarizeCaptureGenerations("s1", undefined, [{
      session_id: "other",
      last_acked_seq: 5,
      bytes: 3,
      entries: [],
    }]);
    expect(foreign).toMatchObject({ session_id: "s1", recovery_pending: true });

    const badBytes = summarizeCaptureGenerations("s1", undefined, [{
      session_id: "s1",
      last_acked_seq: 1,
      bytes: 99,
      entries: [{
        session_id: "s1", event_seq: 1, event_type: "message",
        payload: "x", payload_hash: "h", state: "pending",
      }],
    }]);
    expect(badBytes).toMatchObject({ session_id: "s1", recovery_pending: true });
  });

  it("marks invalid older generations as recovery pending even without current state", () => {
    const malformed = summarizeCaptureGenerations("s1", undefined, [{ last_acked_seq: "bad", entries: [] }]);
    expect(malformed).toMatchObject({ session_id: "s1", recovery_pending: true, pending_events: 0 });
    const invalidEntry = summarizeCaptureGenerations("s1", undefined, [{
      last_acked_seq: 1,
      entries: [{ event_seq: 1, state: "unknown" }],
    }]);
    expect(invalidEntry).toMatchObject({ session_id: "s1", recovery_pending: true });
    const unreadable = summarizeCaptureGenerations("s1", undefined, [undefined]);
    expect(unreadable).toMatchObject({ session_id: "s1", recovery_pending: true });
  });
});

describe("capture status checkpoint parsing", () => {
  it("accepts only concrete checkpoint ids and OIDs for the same Session", () => {
    expect(parseCheckpointRows({
      data: {
        checkpoints: [{
          checkpoint_id: "cp-1",
          bridge_session_id: "session-1",
          agent_checkpoint_id: "agent-cp-1",
          target_oid: "e".repeat(40),
        }],
      },
    }, "session-1")).toEqual([expect.objectContaining({
      checkpointId: expect.stringMatching(/^cp:[0-9a-f]{16}$/),
      agentCheckpointId: expect.stringMatching(/^cp:[0-9a-f]{16}$/),
      targetOid: "e".repeat(40),
      targetVerified: false,
    })]);

    expect(() => parseCheckpointRows({
      data: { checkpoints: [{ checkpoint_id: "cp-1", bridge_session_id: "other" }] },
    }, "session-1")).toThrow(/another Session/);
    expect(() => parseCheckpointRows({ data: { checkpoints: [{ checkpoint_id: "", bridge_session_id: "session-1" }] } }, "session-1"))
      .toThrow(/opaque id/);
    const secret = parseCheckpointRows({ data: { checkpoints: [{
      checkpoint_id: "ghp_abcdefghijklmnopqrstuvwxyz",
      bridge_session_id: "session-1",
    }] } }, "session-1");
    expect(secret[0]?.checkpointId).toMatch(/^cp:[0-9a-f]{16}$/);
    expect(JSON.stringify(secret)).not.toContain("ghp_");
  });

  it("links a commit only from a checkpoint target OID, never from an agent checkpoint id", async () => {
    const client = bridge({
      requestMethod: vi.fn(async () => ({
        id: 1,
        method: "checkpoint.list",
        state: "success",
        result: {
          data: {
            checkpoints: [{
              checkpoint_id: "cp-2",
              bridge_session_id: "session-1",
              agent_checkpoint_id: "agent-only",
              target_oid: null,
            }],
          },
        },
      } as CompletedRequest)),
    });
    const view = await readCaptureStatus(scope(client), "session-1");
    expect(view.commitLink).toBeNull();
    expect(view.checkpoints).toEqual([expect.objectContaining({
      checkpointId: expect.stringMatching(/^cp:[0-9a-f]{16}$/),
      agentCheckpointId: expect.stringMatching(/^cp:[0-9a-f]{16}$/),
      targetOid: null,
      targetVerified: false,
    })]);
    expect(view.capture).toEqual(CAPTURE);
  });

  it("separates unsupported and unavailable checkpoint reads from capture state", async () => {
    const unsupported = await readCaptureStatus(scope(bridge({}, ["vcs.status"])), "session-1");
    expect(unsupported.checkpointState).toBe("unsupported_capability");
    expect(unsupported.capture).toEqual(CAPTURE);

    const failing = bridge({ requestMethod: vi.fn(async () => { throw new BridgeClientError("not_connected", "lost"); }) });
    const unavailable = await readCaptureStatus(scope(failing), "session-1");
    expect(unavailable.checkpointState).toBe("unavailable");
    expect(unavailable.checkpoints).toEqual([]);
    expect(unavailable.capture).toEqual(CAPTURE);
  });

  it("claims a commit link only after the target OID resolves to a commit", async () => {
    const verified = bridge({
      requestMethod: vi.fn(async (method: string) => method === "vcs.show"
        ? {
          id: 1,
          method,
          state: "success",
          result: {
            data: {
              oid: "e".repeat(40),
              summary: "seed",
              parents: [],
              files: [],
              cursor: { next: null },
            },
          },
        } as CompletedRequest
        : {
          id: 1,
          method,
          state: "success",
          result: {
            data: {
              checkpoints: [{
                checkpoint_id: "cp-verified",
                bridge_session_id: "session-1",
                agent_checkpoint_id: null,
                target_oid: "e".repeat(40),
              }],
            },
          },
        } as CompletedRequest),
    }, ["checkpoint.list", "vcs.show"]);
    const view = await readCaptureStatus(scope(verified), "session-1");
    expect(view.checkpoints[0]?.targetVerified).toBe(true);
    expect(view.commitLink).toEqual({
      checkpointId: expect.stringMatching(/^cp:[0-9a-f]{16}$/),
      targetOid: "e".repeat(40),
    });

    const missing = bridge({
      requestMethod: vi.fn(async (method: string) => method === "vcs.show"
        ? {
          id: 1,
          method,
          state: "error",
          error: { code: -32000, message: "unknown commit", data: {} },
        } as CompletedRequest
        : {
          id: 1,
          method,
          state: "success",
          result: {
            data: {
              checkpoints: [{
                checkpoint_id: "cp-missing",
                bridge_session_id: "session-1",
                agent_checkpoint_id: null,
                target_oid: "f".repeat(40),
              }],
            },
          },
        } as CompletedRequest),
    }, ["checkpoint.list", "vcs.show"]);
    const unverified = await readCaptureStatus(scope(missing), "session-1");
    expect(unverified.checkpoints[0]?.targetVerified).toBe(false);
    expect(unverified.commitLink).toBeNull();

    const malformed = bridge({
      requestMethod: vi.fn(async (method: string) => method === "vcs.show"
        ? {
          id: 1,
          method,
          state: "success",
          result: { data: { oid: "e".repeat(40) } },
        } as CompletedRequest
        : {
          id: 1,
          method,
          state: "success",
          result: {
            data: {
              checkpoints: [{
                checkpoint_id: "cp-malformed",
                bridge_session_id: "session-1",
                agent_checkpoint_id: null,
                target_oid: "e".repeat(40),
              }],
            },
          },
        } as CompletedRequest),
    }, ["checkpoint.list", "vcs.show"]);
    const malformedView = await readCaptureStatus(scope(malformed), "session-1");
    expect(malformedView.checkpoints[0]?.targetVerified).toBe(false);
    expect(malformedView.commitLink).toBeNull();
  });

  it("refuses status for an unknown Session or an unbound capture scope", async () => {
    const service = new LibraCaptureStatusService(
      (sessionId) => (sessionId === "session-1" ? SESSION as never : undefined),
      async () => undefined,
    );
    await expect(service.status("missing" as never)).rejects.toMatchObject({ kind: "no_working_directory" });
    await expect(service.status("session-1" as never)).rejects.toMatchObject({ kind: "no_working_directory" });
  });
});
