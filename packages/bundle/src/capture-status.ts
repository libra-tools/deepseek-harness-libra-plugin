/**
 * Host-owned capture status for the Libra panel (plan-20261118 LVC-08).
 *
 * The view combines the durable outbox projection (pending, acknowledged,
 * rejected/conflict, gap) with bridge checkpoint records for the same Session.
 * A commit is linked only when a bridge checkpoint row carries a concrete
 * `target_oid`; an ordinary commit is never labelled captured. Flush/close
 * success alone never produces a "complete" claim.
 */
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionId } from "@deepseek-ai/dsh-session";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { VcsReadMethods, type BridgeClient } from "@libra/dsh-bridge-client";
import { redactPayload } from "@libra/dsh-session";
import type { CaptureStatus } from "@libra/dsh-session";

import { VcsHostError, type VcsHostFailureKind } from "./vcs-read.js";

export interface CaptureCheckpoint {
  checkpointId: string;
  agentCheckpointId: string | null;
  targetOid: string | null;
  /** True only after a repository-scoped commit read confirms the OID. */
  targetVerified: boolean;
}

export type CheckpointState = "ok" | "unsupported_capability" | "unavailable";

/** What the Host resolves for one bound Session. */
export interface CaptureScope {
  capture: CaptureStatus | null;
  bridge: BridgeClient;
  bindingKey: string;
  generation: number;
}

export type CaptureScopeResolver = (session: unknown) => Promise<CaptureScope | undefined>;

export interface CaptureStatusView {
  bindingKey: string;
  bindingGeneration: number;
  /** `null` means no capture has been observed for this Session yet. */
  capture: CaptureStatus | null;
  checkpointState: CheckpointState;
  checkpoints: CaptureCheckpoint[];
  /** The only commit link the panel may show: checkpoint → concrete OID. */
  commitLink: { checkpointId: string; targetOid: string } | null;
}

export type SessionById = (sessionId: SessionId) => Session | undefined;

export type CaptureRemoteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { kind: VcsHostFailureKind; message: string; retryable: boolean } };

const MAX_CHECKPOINTS = 100;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Never return caller-supplied checkpoint text; show a stable opaque digest. */
function displayIdentifier(value: string): string {
  return `cp:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}
/** Opaque identifiers only; caller-supplied text must not reach the panel. */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isSafeIdentifier(value: string): boolean {
  return OPAQUE_ID.test(value) && redactPayload(value).ok;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

/** Parse one checkpoint page, refusing malformed rows instead of inventing links. */
export function parseCheckpointRows(result: unknown, sessionId: string): CaptureCheckpoint[] {
  if (!isRecord(result)) throw new VcsHostError("internal", "the bridge returned a malformed checkpoint page");
  const envelope = isRecord(result["data"]) ? result["data"] : result;
  const rows = envelope["checkpoints"];
  if (!Array.isArray(rows) || rows.length > MAX_CHECKPOINTS) {
    throw new VcsHostError("internal", "the bridge returned a malformed checkpoint list");
  }
  const parsed: CaptureCheckpoint[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new VcsHostError("internal", "the bridge returned a malformed checkpoint row");
    const checkpointId = row["checkpoint_id"];
    const bridgeSessionId = row["bridge_session_id"];
    if (typeof checkpointId !== "string" || !isSafeIdentifier(checkpointId)) {
      throw new VcsHostError("internal", "the bridge returned a checkpoint without a safe opaque id");
    }
    // Only records the bridge itself attributes to this Session may appear.
    if (bridgeSessionId !== sessionId) {
      throw new VcsHostError("internal", "the bridge attributed a checkpoint to another Session");
    }
    const agentCheckpointId = optionalString(row["agent_checkpoint_id"]);
    const targetOid = optionalString(row["target_oid"]);
    if (agentCheckpointId === undefined || targetOid === undefined
      || (agentCheckpointId !== null && !isSafeIdentifier(agentCheckpointId))) {
      throw new VcsHostError("internal", "the bridge returned a malformed checkpoint association");
    }
    parsed.push({
      checkpointId: displayIdentifier(checkpointId),
      agentCheckpointId: agentCheckpointId === null ? null : displayIdentifier(agentCheckpointId),
      targetOid: targetOid !== null && OID.test(targetOid) ? targetOid : null,
      targetVerified: false,
    });
  }
  return parsed;
}

/** Timestamped quarantine files are named `<session>.<scope>.jsonl`. */
export function hasQuarantinedSpool(sessionId: string, entries: readonly string[]): boolean {
  const prefix = `${sessionId.replace(/[^A-Za-z0-9._:-]/g, "_")}.`;
  return entries.some((name) => name.startsWith(prefix) && name.includes(".quarantine-"));
}

const SPOOL_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function rejectionPath(dir: string, sessionId: string): string {
  if (!SPOOL_SESSION.test(sessionId)) throw new Error("invalid session id for rejection marker");
  return join(dir, `${sessionId}.rejections.json`);
}

/** Persist a payload-free count of events the durable spool could not redact. */
export function recordRejectedSpoolEvent(dir: string, sessionId: string): void {
  const path = rejectionPath(dir, sessionId);
  let count = 0;
  let existing: string | undefined;
  try {
    existing = readFileSync(path, "utf8");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    const parsed: unknown = JSON.parse(existing);
    const record = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    // A malformed marker is recovery evidence; never overwrite it as count 1.
    if (record === undefined || typeof record.count !== "number"
      || !Number.isSafeInteger(record.count) || record.count < 0) {
      throw new Error("existing rejection marker is malformed; refusing to overwrite");
    }
    count = record.count;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, count: count + 1 }), { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

const failureLedger = (root: string): string => join(root, "spool-failures.jsonl");
const defaultFailureFallback = (): string => join(tmpdir(), "dsh-libra-capture-failures");

/** Persist a payload-free marker for an event the spool failed to retain. */
export function recordSpoolFailure(dir: string, sessionId: string, fallbackRoot = defaultFailureFallback()): void {
  const path = rejectionPath(dir, sessionId).replace(/\.rejections\.json$/, ".marker-failure.jsonl");
  const line = `${JSON.stringify({ version: 1, session_id: sessionId, at: Date.now() })}\n`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    return;
  } catch {
    // Continue to durable fallbacks below.
  }
  for (const root of [join(dir, ".."), fallbackRoot]) {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      chmodSync(root, 0o700);
      const ledger = failureLedger(root);
      appendFileSync(ledger, line, { encoding: "utf8", mode: 0o600 });
      chmodSync(ledger, 0o600);
      return;
    } catch {
      // Try the next durable location.
    }
  }
  throw new Error("no durable location accepted the spool failure marker");
}

export function hasSpoolFailure(
  dir: string,
  sessionId: string,
  fallbackRoot = defaultFailureFallback(),
): boolean {
  const path = rejectionPath(dir, sessionId).replace(/\.rejections\.json$/, ".marker-failure.jsonl");
  let primaryError: unknown;
  try {
    if (statSync(path).size > 0) return true;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") primaryError = error;
  }
  let ledgerError: unknown;
  for (const root of [join(dir, ".."), fallbackRoot]) {
    let lines: string;
    try {
      lines = readFileSync(failureLedger(root), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      ledgerError = error;
      continue;
    }
    for (const line of lines.split("\n")) {
      if (line.length === 0) continue;
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid spool failure ledger");
      }
      if ((parsed as Record<string, unknown>).session_id === sessionId) return true;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (ledgerError !== undefined) throw ledgerError;
  return false;
}

/** Read the durable rejection count; a malformed marker is not treated as zero. */
export function readRejectedSpoolEvents(dir: string, sessionId: string): number {
  const path = rejectionPath(dir, sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid rejection marker");
  const count = (parsed as Record<string, unknown>).count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("invalid rejection count");
  return count;
}

/** Add durable spool rejections to the outbox projection without inventing state. */
export function applyRejectedSpool(
  capture: CaptureStatus | null,
  sessionId: string,
  rejected: number,
): CaptureStatus | null {
  if (rejected === 0) return capture;
  const base = capture ?? {
    session_id: sessionId,
    pending_events: 0,
    rejected_events: 0,
    conflict_events: 0,
    last_acked_seq: 0,
    first_pending_seq: null,
    gap: false,
    paused: false,
    recovery_pending: false,
    rejected_truncated: false,
  };
  return { ...base, rejected_events: base.rejected_events + rejected };
}

/** Surface a still-spooled fallback as recovery pending, even if outbox state is absent. */
export function withSpooledCapture(
  capture: CaptureStatus | null,
  sessionId: string,
  spooled: boolean,
): CaptureStatus | null {
  if (!spooled) return capture;
  const base = capture ?? {
    session_id: sessionId,
    pending_events: 0,
    rejected_events: 0,
    conflict_events: 0,
    last_acked_seq: 0,
    first_pending_seq: null,
    gap: false,
    paused: false,
    recovery_pending: true,
    rejected_truncated: false,
  };
  return { ...base, session_id: sessionId, recovery_pending: true };
}

export async function readCaptureStatus(scope: CaptureScope, sessionId: string): Promise<CaptureStatusView> {
  let checkpointState: CheckpointState = "ok";
  let checkpoints: CaptureCheckpoint[] = [];
  try {
    if (!scope.bridge.contract.methods.includes("checkpoint.list")) {
      checkpointState = "unsupported_capability";
    } else {
      const response = await scope.bridge.requestMethod("checkpoint.list", {
        session_id: sessionId,
        limit: 20,
      });
      if (response.state !== "success") {
        checkpointState = "unavailable";
      } else {
        checkpoints = parseCheckpointRows(response.result, sessionId);
      }
    }
  } catch {
    checkpointState = "unavailable";
    checkpoints = [];
  }
  const linkedIndex = checkpoints.findIndex((checkpoint) => checkpoint.targetOid !== null);
  if (linkedIndex >= 0 && scope.bridge.contract.methods.includes("vcs.show")) {
    const linked = checkpoints[linkedIndex]!;
    try {
      // Use the same typed reader as the VCS read tools, so a malformed or
      // incomplete commit response cannot produce a "Linked commit" claim.
      const shown = await new VcsReadMethods(scope.bridge).show({ oid: linked.targetOid as string, limit: 1 });
      if (shown.oid === linked.targetOid) {
        checkpoints[linkedIndex] = { ...linked, targetVerified: true };
      }
    } catch {
      // A failed verification keeps the checkpoint visible but no commit claim.
    }
  }
  const linked = checkpoints.find((checkpoint) => checkpoint.targetVerified && checkpoint.targetOid !== null);
  return {
    bindingKey: scope.bindingKey,
    bindingGeneration: scope.generation,
    capture: scope.capture,
    checkpointState,
    checkpoints,
    commitLink: linked === undefined || linked.targetOid === null
      ? null
      : { checkpointId: linked.checkpointId, targetOid: linked.targetOid },
  };
}

export class LibraCaptureStatusService {
  constructor(
    private readonly lookup: SessionById,
    private readonly resolve: CaptureScopeResolver,
  ) {}

  async status(sessionId: SessionId): Promise<CaptureStatusView> {
    const session = this.lookup(sessionId);
    if (session === undefined) {
      throw new VcsHostError("no_working_directory", "the requested Session is not live on this Host");
    }
    const scope = await this.resolve(session);
    if (scope === undefined) {
      throw new VcsHostError("no_working_directory", "this Session has no capture state for a bound repository");
    }
    return readCaptureStatus(scope, String(session.id));
  }
}

/** Client-facing namespace `libraCapture` for the panel's capture section. */
export class LibraCaptureRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly service: LibraCaptureStatusService,
  ) {
    super(ctx, "libraCapture");
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async status(sessionId: SessionId): Promise<CaptureRemoteResult<CaptureStatusView>> {
    try {
      return { ok: true, data: await this.service.status(sessionId) };
    } catch (error) {
      if (error instanceof VcsHostError) {
        return { ok: false, error: { kind: error.kind, message: error.message, retryable: error.retryable } };
      }
      return { ok: false, error: { kind: "internal", message: String(error), retryable: false } };
    }
  }
}
