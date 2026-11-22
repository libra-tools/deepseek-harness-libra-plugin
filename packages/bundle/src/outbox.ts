/**
 * DSH session-event projection into the Libra bridge outbox.
 *
 * Subscribes the durable, log-only DSH session feed (`session/event`) and
 * maps each committed `SessionEvent` to the bridge `event.append` vocabulary,
 * buffering through the crash-resilient local outbox. `session/flush` (the
 * DSH persistence checkpoint boundary) drains pending entries to the bridge
 * via `event.append` / `session.flush`; `session/disposed` closes the bridge
 * session. Every handler is contained: a capture/flush failure is logged and
 * never rejects the DSH event pipeline.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { OutboxStore, SessionProjectionService, type CaptureStatus } from "@libra/dsh-session";

import { acquireSessionLock, claimAbandoned, createGeneration, retireGeneration, type GenerationClaim } from "./recovery.js";

/** Default outbox location lives outside the repository, under the DSH home. */
export function defaultOutboxRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "libra", "outbox");
}

export interface OutboxMountOptions {
  /** Durable outbox directory. Defaults to `$DSH_HOME/libra/outbox`. */
  outboxRoot?: string;
  /** Canonical repository path binds durable events to their destination. */
  repositoryRoot: string;
  /**
   * Which sessions this mount serves. One mount exists per bound repository,
   * so a session bound elsewhere must not have its events captured here.
   */
  serves?: (session: Session) => boolean;
  /** Allow cleanup of a session whose current cwd no longer serves this pool. */
  servesDisposal?: (session: Session) => boolean;
  /** Route an event this outbox could not persist to a durable fallback. */
  onCaptureFailure?: (session: Session, event: { seq: number; type: string; data: unknown }) => void;
}

/** Durable snapshot fields needed to aggregate older outbox generations. */
export interface GenerationSnapshot {
  last_acked_seq: number;
  entries: Array<{ event_seq: number; state: string; last_error?: string }>;
}

/**
 * Merge capture state from older generations. A clean retired generation adds
 * nothing; pending/rejected entries, a newer acknowledgement or an accepted
 * sequence above the cursor keep `recovery_pending` set instead of hiding it.
 */
export function mergeCaptureStatus(
  current: CaptureStatus | undefined,
  others: readonly GenerationSnapshot[],
): CaptureStatus | undefined {
  const base: CaptureStatus = current ?? {
    session_id: "",
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
  let pending = base.pending_events;
  let rejected = base.rejected_events;
  let conflict = base.conflict_events;
  let rejectedTruncated = base.rejected_truncated;
  let firstPending = base.first_pending_seq;
  let lastAcked = base.last_acked_seq;
  const observed = new Set<number>();
  let recoveryPending = false;
  for (const snapshot of others) {
    lastAcked = Math.max(lastAcked, snapshot.last_acked_seq);
    for (const entry of snapshot.entries) {
      observed.add(entry.event_seq);
      if (entry.state === "pending") {
        pending += 1;
        firstPending = firstPending === null ? entry.event_seq : Math.min(firstPending, entry.event_seq);
        recoveryPending = true;
      } else if (entry.state === "rejected") {
        rejected += 1;
        if (entry.last_error?.includes("conflict") === true) conflict += 1;
        recoveryPending = true;
      } else if (entry.state === "acked" && entry.event_seq > snapshot.last_acked_seq) {
        recoveryPending = true;
      }
    }
    if (snapshot.last_acked_seq > base.last_acked_seq) recoveryPending = true;
    if (snapshot.entries.filter((entry) => entry.state === "rejected").length >= 64) rejectedTruncated = true;
  }
  if (current === undefined && !recoveryPending) return undefined;
  let gap = base.gap;
  if (!gap && observed.size > 0) {
    let expected = lastAcked + 1;
    for (const seq of [...observed].sort((a, b) => a - b)) {
      if (seq > expected) { gap = true; break; }
      if (seq === expected) expected += 1;
    }
  }
  return {
    session_id: base.session_id,
    pending_events: pending,
    rejected_events: rejected,
    conflict_events: conflict,
    last_acked_seq: lastAcked,
    first_pending_seq: firstPending,
    gap,
    paused: base.paused,
    recovery_pending: base.recovery_pending || recoveryPending,
    rejected_truncated: rejectedTruncated,
  };
}

/** Match OutboxStore's persisted-snapshot validation before summarizing. */
function validateGenerationSnapshot(value: unknown, sessionId: string): GenerationSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.session_id !== sessionId
    || typeof snapshot.last_acked_seq !== "number" || !Number.isSafeInteger(snapshot.last_acked_seq) || snapshot.last_acked_seq < 0
    || typeof snapshot.bytes !== "number" || !Number.isSafeInteger(snapshot.bytes)
    || !Array.isArray(snapshot.entries)) return undefined;
  const entries: GenerationSnapshot["entries"] = [];
  let bytes = 0;
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const row = entry as Record<string, unknown>;
    if (row.session_id !== sessionId
      || typeof row.event_seq !== "number" || !Number.isSafeInteger(row.event_seq) || row.event_seq < 0
      || typeof row.event_type !== "string" || typeof row.payload !== "string"
      || typeof row.payload_hash !== "string"
      || !["pending", "acked", "rejected"].includes(String(row.state))
      || (row.operation_id !== undefined && typeof row.operation_id !== "string")
      || (row.last_error !== undefined && typeof row.last_error !== "string")) return undefined;
    bytes += Buffer.byteLength(row.payload, "utf8");
    entries.push({
      event_seq: row.event_seq,
      state: String(row.state),
      ...(typeof row.last_error === "string" ? { last_error: row.last_error } : {}),
    });
  }
  if (bytes !== snapshot.bytes) return undefined;
  return { last_acked_seq: snapshot.last_acked_seq, entries };
}

/**
 * Validate and summarize durable older-generation snapshots. Invalid or
 * unreadable generations still mark recovery pending, even when the current
 * projection has no state, so the panel cannot show a clean count.
 */
export function summarizeCaptureGenerations(
  sessionId: string,
  current: CaptureStatus | undefined,
  raw: readonly unknown[],
): CaptureStatus | undefined {
  const others: GenerationSnapshot[] = [];
  let invalid = false;
  for (const value of raw) {
    const validated = validateGenerationSnapshot(value, sessionId);
    if (validated === undefined) { invalid = true; continue; }
    others.push(validated);
  }
  const merged = mergeCaptureStatus(current, others);
  if (invalid) {
    const base = merged ?? {
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
  return merged === undefined || merged.session_id !== "" ? merged : { ...merged, session_id: sessionId };
}

/**
 * Mount the session-event projection for the lifetime of `ctx`. Returns a
 * disposer. The outbox directory is created lazily on the first captured
 * event, so a composition that never emits session events leaves no trace.
 */
export function mountLibraOutbox(ctx: Context, bridge: BridgeClient, options: OutboxMountOptions): {
  retire: (session: Session) => Promise<void>;
  capture: (session: Session, event: { seq: number; type: string; data: unknown }) => boolean;
  accepting: () => boolean;
  open: (session: Session) => Promise<void>;
  wait: (session: Session) => Promise<void>;
  status: (session: Session) => CaptureStatus | undefined;
  setMemory: (memory: { wait: (session: Session) => Promise<void>; retire: (session: Session) => Promise<void> }) => void;
  dispose: () => Promise<void>;
} {
  let memory: { wait: (session: Session) => Promise<void>; retire: (session: Session) => Promise<void> } | undefined;
  interface SessionOutbox {
    projection: SessionProjectionService;
    store: OutboxStore;
    dir: string;
    operations: Promise<void>;
    disposing: boolean;
  }
  const projections = new Map<Session, SessionOutbox>();
  const retiring = new Map<string, Promise<void>>();
  const disposers: Array<() => unknown> = [];
  const namespace = createHash("sha256").update(options.repositoryRoot).digest("hex");
  const serves = options.serves ?? (() => true);
  const servesDisposal = options.servesDisposal ?? serves;
  let accepting = true;
  const root = options.outboxRoot ?? defaultOutboxRoot();
  const namespaceRoot = join(root, namespace);
  const locks = new Map<string, GenerationClaim>();
  const recovering = new Map<string, Promise<boolean>>();
  const warn = (message: string) => ctx.logger.warn(`libra-outbox: ${message}`);
  const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

  // Only inspect this repository's namespace. Legacy root-level entries are
  // preserved, and are never routed to an arbitrarily selected repository.
  const scan = (): Map<string, string[]> => {
    const found = new Map<string, string[]>();
    let directories;
    try { directories = readdirSync(namespaceRoot, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return found; throw error; }
    for (const entry of directories) {
      if (entry.name === ".session-locks") continue;
      const dir = join(namespaceRoot, entry.name);
      if (!entry.isDirectory()) { warn(`preserved unknown entry ${dir}`); continue; }
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        const match = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\.outbox\.json$/.exec(file.name);
        if (!file.isFile() || !match) continue;
        const id = match[1]!;
        const dirs = found.get(id) ?? [];
        dirs.push(dir);
        found.set(id, dirs);
      }
    }
    return found;
  };
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name !== namespace && !/^[a-f0-9]{64}$/.test(entry.name)) warn(`preserved legacy or interrupted queue ${join(root, entry.name)}`);
    }
  } catch (error) { if (!isMissing(error)) warn(`could not inspect legacy queues: ${String(error)}`); }

  const recover = (id: string): Promise<boolean> => {
    const existing = recovering.get(id);
    if (existing) return existing;
    const work = (async () => {
      let lock = locks.get(id);
      if (!lock) {
        lock = acquireSessionLock(namespaceRoot, id, warn);
        if (!lock) return false;
        locks.set(id, lock);
      }
      try {
        const own = [...projections].filter(([session]) => String(session.id) === id).map(([, state]) => state);
        const ownDirs = new Set(own.map((state) => state.dir));
        const dirs = (scan().get(id) ?? []).filter((dir) => !ownDirs.has(dir));
        const pending: Array<{ dir: string; min: number; max: number }> = [];
        const ambiguous = new Set<string>();
        let lastAcked = -1;
        for (const dir of dirs) {
          const data: unknown = JSON.parse(readFileSync(join(dir, `${id}.outbox.json`), "utf8"));
          if (!data || typeof data !== "object" || !("session_id" in data) || data.session_id !== id || !("entries" in data) || !Array.isArray(data.entries) || !("last_acked_seq" in data) || typeof data.last_acked_seq !== "number" || !Number.isSafeInteger(data.last_acked_seq) || data.last_acked_seq < 0) throw new Error(`invalid snapshot in ${dir}`);
          lastAcked = Math.max(lastAcked, data.last_acked_seq);
          const entries = data.entries as Array<Record<string, unknown>>;
          if (entries.some((entry) => !entry || typeof entry !== "object" || typeof entry.event_seq !== "number" || !Number.isSafeInteger(entry.event_seq) || !["pending", "rejected", "acked"].includes(String(entry.state)))) throw new Error(`invalid entries in ${dir}`);
          const queued = entries.filter((entry) => entry.state === "pending");
          if (queued.length) {
            pending.push({ dir, min: Math.min(...queued.map((entry) => entry.event_seq as number)), max: Math.max(...queued.map((entry) => entry.event_seq as number)) });
            if (own.length > 1) ambiguous.add(dir);
          }
        }
        if (pending.length > 1 || ambiguous.size) throw new Error(`multiple pending generations for ${id}; order is unverified`);
        const candidate = pending[0];
        const ownEntries = own.flatMap((state) => state.store.load(id).entries);
        if (lastAcked >= 0 && ownEntries.some((entry) => entry.state === "pending" && entry.event_seq <= lastAcked && !dirs.some((dir) => {
          const data = JSON.parse(readFileSync(join(dir, `${id}.outbox.json`), "utf8")) as { last_acked_seq: number; entries: Array<{ event_seq: number; payload_hash: string }> };
          return data.last_acked_seq >= entry.event_seq && data.entries.some((old) => old.event_seq === entry.event_seq && old.payload_hash === entry.payload_hash);
        }))) throw new Error(`new generation ${id} does not advance past durable acknowledgement ${lastAcked}`);
        if (candidate) {
          const entries = own.flatMap((state) => state.store.load(id).entries);
          const acknowledged = new Map<string, string>();
          for (const dir of dirs) {
            const data = JSON.parse(readFileSync(join(dir, `${id}.outbox.json`), "utf8")) as { last_acked_seq: number; entries: Array<{ event_seq: number; payload_hash: string; state: string }> };
            for (const entry of data.entries) {
              if (entry.state === "acked" || (entry.state === "pending" && entry.event_seq <= data.last_acked_seq && dir === candidate.dir)) {
                acknowledged.set(`${entry.event_seq}:${entry.payload_hash}`, dir);
              }
            }
          }
          const duplicateSeqs = new Set(entries.filter((entry) => entry.state === "pending" && acknowledged.has(`${entry.event_seq}:${entry.payload_hash}`)).map((entry) => entry.event_seq));
          if (entries.some((entry) => entry.state === "pending" && entry.event_seq < candidate.min && !duplicateSeqs.has(entry.event_seq))) throw new Error(`overlapping generations for ${id}; order is unverified`);
          if (entries.some((entry) => entry.state === "pending" && entry.event_seq <= candidate.max && !duplicateSeqs.has(entry.event_seq))) throw new Error(`overlapping generations for ${id}; order is unverified`);
          if (own.length && lastAcked >= 0 && entries.some((entry) => entry.state === "pending" && entry.event_seq <= lastAcked && !duplicateSeqs.has(entry.event_seq))) throw new Error(`new generation ${id} does not advance past durable acknowledgement ${lastAcked}`);
          const claim = claimAbandoned(candidate.dir, warn);
          if (!claim) throw new Error(`cannot safely claim pending generation ${candidate.dir}`);
          try {
            const store = new OutboxStore(candidate.dir);
            const parent = store.parentSessionId(id);
            const projection = new SessionProjectionService(store, bridge);
            await projection.flush({ id, header: parent ? { parentSession: parent } : {} });
            if (store.metrics(id).queued_events !== 0) throw new Error(`recovery drain incomplete for ${id}`);
          } finally { claim.release(); }
        }
        return true;
      } catch (error) {
        warn(`recovery blocked for ${id}: ${String(error)}`);
        return false;
      }
    })();
    recovering.set(id, work);
    void work.finally(() => { if (recovering.get(id) === work) recovering.delete(id); });
    return work;
  };
  const enqueue = (state: SessionOutbox, work: () => Promise<void>): Promise<void> => {
    const next = state.operations.catch(() => undefined).then(work);
    state.operations = next;
    return next;
  };
  const ensureProjection = (session: Session): SessionOutbox => {
    const existing = projections.get(session);
    if (existing !== undefined) return existing;
    const dir = createGeneration(namespaceRoot);
    const outbox = new OutboxStore(dir);
    const state = { projection: new SessionProjectionService(outbox, bridge), store: outbox, dir, operations: Promise.resolve(), disposing: false };
    projections.set(session, state);
    return state;
  };

  // Recovery is deliberately lazy: only a live session can prove that its
  // next event advances the prior generation. Never replay a queue merely
  // because an abandoned directory exists at plugin startup.

  const capture = (session: Session, event: { seq: number; type: string; data: unknown }): boolean => {
    try {
      const header = session.header;
      ensureProjection(session).projection.capture({
        session_id: String(session.id),
        ...(header.parentSession !== undefined
          ? { parent_session_id: String(header.parentSession) }
          : {}),
        event_seq: Number(event.seq),
        event_type: event.type,
        payload: JSON.stringify(event.data),
      });
      return true;
    } catch (error) {
      ctx.logger.warn(`libra-outbox: event capture failed: ${String(error)}`);
      try { options.onCaptureFailure?.(session, event); }
      catch (fallbackError) {
        ctx.logger.warn(`libra-outbox: durable fallback failed: ${String(fallbackError)}`);
      }
      return false;
    }
  };
  disposers.push(ctx.on("session/event", (session, event) => {
    if (!accepting || !serves(session)) return;
    capture(session, event);
  }));
  disposers.push(ctx.on("session/flush", async (session) => {
    if (!serves(session)) return;
    const state = projections.get(session);
    if (state === undefined) return;
    await retiring.get(String(session.id));
    await enqueue(state, async () => {
      await memory?.wait(session);
      try {
        if (!await recover(String(session.id))) return;
        await state.projection.flush({ id: session.id, header: session.header });
      } catch (error) {
        ctx.logger.warn(`libra-outbox: flush failed for ${String(session.id)}: ${String(error)}`);
      }
    });
  }));
  const retireSession = (session: Session): Promise<void> => {
    const id = String(session.id);
    const running = retiring.get(id);
    if (running !== undefined) return running;
    if (!projections.has(session)) return Promise.resolve();
    const state = ensureProjection(session);
    state.disposing = true;
    const previous = retiring.get(String(session.id));
    const work = (previous ?? Promise.resolve()).then(() => enqueue(state, async () => {
      try {
        await memory?.retire(session);
      } catch (error) {
        ctx.logger.warn(`libra-outbox: memory retirement failed for ${String(session.id)}: ${String(error)}`);
      }
      try {
        if (!await recover(String(session.id))) return;
        const result = await state.projection.dispose({ id: session.id, header: session.header });
        for (const warning of result.warnings) ctx.logger.warn(`libra-outbox: ${warning}`);
      } catch (error) {
        ctx.logger.warn(`libra-outbox: dispose failed for ${String(session.id)}: ${String(error)}`);
      } finally {
        try { retireGeneration(state.dir); }
        catch (error) { warn(`could not mark generation retired for ${String(session.id)}: ${String(error)}`); }
        projections.delete(session);
      }
    }));
    retiring.set(String(session.id), work);
    if (previous === undefined) {
      void work.then(() => {
        if (![...projections.keys()].some((current) => String(current.id) === String(session.id))) {
          locks.get(String(session.id))?.release();
          locks.delete(String(session.id));
        }
      }, () => undefined);
    }
    void work.then(() => {
      if (retiring.get(String(session.id)) === work) retiring.delete(String(session.id));
    }, () => {
      if (retiring.get(String(session.id)) === work) retiring.delete(String(session.id));
    });
    void work.catch((error: unknown) => ctx.logger.warn(`libra-outbox: dispose failed for ${String(session.id)}: ${String(error)}`));
    return work;
  };
  disposers.push(ctx.on("session/disposed", (session) => {
    if (!servesDisposal(session)) return;
    void retireSession(session);
  }));

  return {
    retire: retireSession,
    capture,
    accepting: () => accepting,
    open: async (session) => {
      await retiring.get(String(session.id));
      const state = ensureProjection(session);
      await enqueue(state, async () => {
        if (!await recover(String(session.id))) throw new Error(`outbox recovery blocked for ${String(session.id)}`);
        await state.projection.open({ id: session.id, header: session.header });
      });
    },
    wait: async (session) => { await retiring.get(String(session.id)); },
    status: (session) => {
      const id = String(session.id);
      const state = projections.get(session);
      const current = state?.projection.status(id);
      const dirs = [...new Set(scan().get(id) ?? [])].filter((dir) => dir !== state?.dir);
      const raw: unknown[] = [];
      for (const dir of dirs) {
        try {
          raw.push(JSON.parse(readFileSync(join(dir, `${id}.outbox.json`), "utf8")));
        } catch {
          raw.push(undefined);
        }
      }
      return summarizeCaptureGenerations(id, current, raw);
    },
    setMemory: (value) => { memory = value; },
    dispose: async () => {
      // Stop accepting before removing the listener so the Host buffer takes
      // over events committed during the drain.
      accepting = false;
      for (const dispose of disposers.reverse()) dispose();
      await Promise.allSettled([...retiring.values()]);
      await Promise.all([...projections].map(async ([session, state]) => {
        await retiring.get(String(session.id));
        await enqueue(state, async () => {
          try {
            await memory?.wait(session);
            if (!await recover(String(session.id))) return;
            await state.projection.flush({ id: session.id, header: session.header });
          } catch (error) {
            ctx.logger.warn(`libra-outbox: unload flush failed for ${String(session.id)}: ${String(error)}`);
          } finally {
            try { retireGeneration(state.dir); }
            catch (error) { warn(`could not mark generation retired for ${String(session.id)}: ${String(error)}`); }
          }
        });
      }));
      await Promise.allSettled([...recovering.values()]);
      for (const [id, lock] of locks) {
        try { lock.release(); locks.delete(id); }
        catch (error) { warn(`could not release session lock for ${id}: ${String(error)}`); }
      }
    },
  };
}
