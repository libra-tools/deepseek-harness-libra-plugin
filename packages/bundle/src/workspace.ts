/**
 * Workspace lease binding to the DSH session lifecycle.
 *
 * One mount belongs to one Libra repository and serves only its bound
 * sessions. It drains claims, renewals and releases before its bridge closes.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { WorkspaceBindingService } from "@libra/dsh-workspace";

const DEFAULT_LEASE_TTL_MS = 30_000;

export interface WorkspaceMountOptions {
  /** Repository path claimed as the workspace path for this repository pool. */
  repositoryRoot: string | (() => string);
  /** Which sessions this mount serves for normal operations. */
  serves?: (session: Session) => boolean;
  /** Allow lease cleanup after a session's current cwd no longer serves this pool. */
  servesDisposal?: (session: Session) => boolean;
  /** Only link a fork to a parent served by the same repository pool. */
  parentServes?: (parentSessionId: string) => boolean;
  /** Lease TTL in milliseconds, or a live settings read. */
  leaseTtlMs?: number | (() => number);
  /** Renew interval; defaults to half the lease TTL. */
  renewIntervalMs?: number;
}

export interface WorkspaceMount {
  /** Domain service; exposed for introspection (e.g. tests, status tools). */
  binding: WorkspaceBindingService;
  /** Claim one session explicitly; useful when binding starts during creation. */
  claim: (session: Session) => Promise<void>;
  /** Release one session and wait for the bridge operation to settle. */
  release: (sessionId: string) => Promise<void>;
  dispose: () => Promise<void>;
}

export function mountLibraWorkspace(
  ctx: Context,
  bridge: BridgeClient,
  options: WorkspaceMountOptions,
): WorkspaceMount {
  const repositoryRoot = (): string =>
    typeof options.repositoryRoot === "function" ? options.repositoryRoot() : options.repositoryRoot;
  const binding = new WorkspaceBindingService(bridge, repositoryRoot());
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const claims = new Map<string, Promise<void>>();
  const leaseIds = new Set<string>();
  const releasing = new Set<string>();
  const activeOperations = new Set<Promise<unknown>>();
  const disposers: Array<() => unknown> = [];
  let stopping = false;

  const leaseTtlMs = (): number => {
    const configured = typeof options.leaseTtlMs === "function" ? options.leaseTtlMs() : options.leaseTtlMs;
    return configured ?? DEFAULT_LEASE_TTL_MS;
  };
  const renewIntervalMs = options.renewIntervalMs ?? Math.max(1_000, Math.floor(leaseTtlMs() / 2));
  const serves = options.serves ?? (() => true);
  const servesDisposal = options.servesDisposal ?? serves;
  const track = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation);
    void operation.finally(() => activeOperations.delete(operation)).catch(() => undefined);
    return operation;
  };

  const armRenewal = (sessionId: string): void => {
    if (stopping || timers.has(sessionId) || !leaseIds.has(sessionId)) return;
    const timer = setInterval(() => {
      void track(binding.renew(sessionId)).catch((error) => {
        ctx.logger.warn(`libra-workspace: renew failed for ${sessionId}: ${String(error)}`);
      });
    }, renewIntervalMs);
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const claim = (session: Session): Promise<void> => {
    const sessionId = String(session.id);
    if (stopping || !serves(session) || leaseIds.has(sessionId)) return Promise.resolve();
    const pending = claims.get(sessionId);
    if (pending !== undefined) return pending;
    const parent = session.header?.parentSession === undefined
      ? undefined
      : String(session.header.parentSession);
    const work = track(binding.claim({
      session_id: sessionId,
      path: repositoryRoot(),
      ...(parent !== undefined && (options.parentServes?.(parent) ?? true)
        ? { parent_session_id: parent, mode: "linked" as const }
        : {}),
      lease_ttl_ms: leaseTtlMs(),
    })).then(() => {
      leaseIds.add(sessionId);
      // A release that started while this claim was in flight must not leave a
      // renewal timer behind on a shared runtime.
      if (!releasing.has(sessionId)) armRenewal(sessionId);
    }).catch((error: unknown) => {
      ctx.logger.warn(`libra-workspace: claim failed for ${sessionId}: ${String(error)}`);
    }).finally(() => {
      if (claims.get(sessionId) === work) claims.delete(sessionId);
    });
    claims.set(sessionId, work);
    return work;
  };

  const release = async (sessionId: string): Promise<void> => {
    releasing.add(sessionId);
    const timer = timers.get(sessionId);
    if (timer !== undefined) {
      clearInterval(timer);
      timers.delete(sessionId);
    }
    await claims.get(sessionId);
    // A claim may have armed its timer while this release awaited it.
    const armed = timers.get(sessionId);
    if (armed !== undefined) {
      clearInterval(armed);
      timers.delete(sessionId);
    }
    if (leaseIds.has(sessionId)) {
      await track(binding.releaseWithRetry(sessionId)).catch((error: unknown) => {
        ctx.logger.warn(`libra-workspace: release failed for ${sessionId}: ${String(error)}`);
      });
      leaseIds.delete(sessionId);
    }
    releasing.delete(sessionId);
  };

  disposers.push(ctx.on("session/created", (session: Session) => {
    void claim(session);
  }));
  disposers.push(ctx.on("session/disposed", (session: Session) => {
    if (!servesDisposal(session)) return;
    void release(String(session.id));
  }));

  return {
    binding,
    claim,
    release,
    dispose: async () => {
      if (stopping) return;
      stopping = true;
      for (const dispose of disposers.reverse()) dispose();
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      await Promise.allSettled([...claims.values(), ...activeOperations]);
      await Promise.allSettled([...leaseIds].map((sessionId) => release(sessionId)));
      await Promise.allSettled([...activeOperations]);
    },
  };
}
