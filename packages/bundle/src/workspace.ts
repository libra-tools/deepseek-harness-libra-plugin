/**
 * Workspace lease binding to the DSH session lifecycle.
 *
 * Every session gets one Libra workspace lease, claimed on `session/created`
 * (linked to the parent's lease for forked sessions) and renewed on a timer
 * at half the lease TTL until `session/disposed` releases it. All bridge
 * interactions are contained: a claim/renew/release failure is logged and
 * never rejects the DSH event pipeline.
 */
import type { Context } from "@deepseek-ai/cordis";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { WorkspaceBindingService } from "@libra/dsh-workspace";

const DEFAULT_LEASE_TTL_MS = 30_000;

export interface WorkspaceMountOptions {
  /** Repository root claimed as the workspace path for every session. */
  repositoryRoot: string | (() => string);
  /** Lease TTL in milliseconds, or a live settings read. */
  leaseTtlMs?: number | (() => number);
  /** Renew interval; defaults to half the lease TTL. */
  renewIntervalMs?: number;
}

export interface WorkspaceMount {
  /** Domain service; exposed for introspection (e.g. tests, status tools). */
  binding: WorkspaceBindingService;
  dispose: () => void;
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
  const disposers: Array<() => unknown> = [];

  const leaseTtlMs = (): number => {
    const configured = typeof options.leaseTtlMs === "function" ? options.leaseTtlMs() : options.leaseTtlMs;
    return configured ?? DEFAULT_LEASE_TTL_MS;
  };
  const renewIntervalMs = options.renewIntervalMs ?? Math.max(1_000, Math.floor(leaseTtlMs() / 2));

  const armRenewal = (sessionId: string): void => {
    const timer = setInterval(() => {
      void binding.renew(sessionId).catch((error) => {
        ctx.logger.warn(`libra-workspace: renew failed for ${sessionId}: ${String(error)}`);
      });
    }, renewIntervalMs);
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const release = (sessionId: string): void => {
    const timer = timers.get(sessionId);
    if (timer !== undefined) {
      clearInterval(timer);
      timers.delete(sessionId);
    }
    void binding.releaseWithRetry(sessionId).catch((error) => {
      ctx.logger.warn(`libra-workspace: release failed for ${sessionId}: ${String(error)}`);
    });
  };

  disposers.push(ctx.on("session/created", (session) => {
    const sessionId = String(session.id);
    const parent = session.header?.parentSession;
    void binding.claim({
      session_id: sessionId,
      path: repositoryRoot(),
      ...(parent !== undefined
        ? { parent_session_id: String(parent), mode: "linked" as const }
        : {}),
      lease_ttl_ms: leaseTtlMs(),
    }).then(() => {
      armRenewal(sessionId);
    }).catch((error) => {
      ctx.logger.warn(`libra-workspace: claim failed for ${sessionId}: ${String(error)}`);
    });
  }));
  disposers.push(ctx.on("session/disposed", (session) => {
    release(String(session.id));
  }));

  return {
    binding,
    dispose: () => {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}
