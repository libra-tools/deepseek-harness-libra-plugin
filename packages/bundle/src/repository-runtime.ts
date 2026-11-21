/** Host-owned per-Session Libra bridge lifecycle (plan-20261118 LVC-03). */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { ToolsFacade } from "@libra/dsh-tools";

import { registerLibraTools } from "./libra-tools.js";
import { mountLibraContext } from "./context.js";
import { mountLibraOutbox } from "./outbox.js";
import { mountLibraWorkspace } from "./workspace.js";
import { readLive, resolveDeployment, resolveExecutable, type DeploymentConfig, type ResolvedDeployment } from "./deployment.js";
import { libraMemoryProjection } from "./memory-projection.js";
import {
  RepositoryRegistry,
  readSessionWorkingDirectory,
  type BindingFailure,
  type BridgeEvidenceSnapshot,
  type LibraBridgeEvidenceService,
  type LibraRepositoryBindingService,
  type RepositoryBinding,
  type WorkingDirectoryService,
} from "./repository-binding.js";

/** The per-repository subset of the Memory adapter used by the Host pool. */
export interface RepositoryMemoryRuntime {
  track(session: Session): void;
  wait(session: Session): Promise<void>;
  retire(session: Session): Promise<void>;
  dispose(): Promise<void>;
}

export interface RepositoryMemoryOptions {
  memoryTokenBudget?: () => number | undefined;
  captureEpisodes?: () => boolean;
  openSession: (session: Session) => Promise<void>;
  waitSession: (session: Session) => Promise<void>;
  serves?: (session: Session) => boolean;
  registerProjection?: boolean;
}

export interface RepositoryRuntimeDependencies {
  pluginName: string;
  bridgeEnv: (deployment: ResolvedDeployment) => Record<string, string>;
  mountMemory: (
    ctx: Context,
    bridge: BridgeClient,
    options: RepositoryMemoryOptions,
  ) => Promise<RepositoryMemoryRuntime>;
}

interface PerRepositoryRuntime {
  binding: RepositoryBinding;
  sessions: Set<string>;
  outbox: ReturnType<typeof mountLibraOutbox>;
  workspace: ReturnType<typeof mountLibraWorkspace>;
  memory?: RepositoryMemoryRuntime;
  dispose: () => Promise<void>;
}

interface SessionProjectionRegistrar {
  register(definition: unknown): () => unknown;
}

function failureKey(failure: BindingFailure): string {
  return failure.kind === "cwd_changed"
    ? `${failure.kind}:${failure.now}`
    : failure.kind === "unsupported_capability"
      ? `${failure.kind}:${failure.missing.join(",")}`
      : failure.kind;
}

/**
 * Bind each DSH Session to the Libra worktree discovered from the Host-owned
 * working directory. Every mounted layer is filtered by that binding, tool
 * calls resolve through their calling Session, and cwd changes fail closed.
 */
export async function applyPerSession(
  ctx: Context,
  config: DeploymentConfig,
  workingDirectory: WorkingDirectoryService,
  dependencies: RepositoryRuntimeDependencies,
): Promise<() => Promise<void>> {
  const bindingFailures = new Map<string, BindingFailure>();
  const runtimes = new Map<string, PerRepositoryRuntime>();
  const starting = new Map<string, Promise<PerRepositoryRuntime>>();
  const deployments = new WeakMap<BridgeClient, ResolvedDeployment>();
  const facades = new Map<string, ToolsFacade>();
  const pendingBinds = new Set<Promise<PerRepositoryRuntime | undefined>>();
  const hostDisposers: Array<() => unknown> = [];
  let disposed = false;
  let warnedLegacyRoot = false;

  const registry = new RepositoryRegistry({
    resolveExecutable: async () => {
      const configured = readLive(config.libraExecutable)?.trim() || process.env.LIBRA_BINARY?.trim();
      if (configured === undefined || configured.length === 0) throw new Error("no Libra executable is configured");
      const executable = await resolveExecutable(configured);
      if (executable === undefined) throw new Error("the configured Libra executable is unavailable");
      return executable;
    },
    createClient: async (cwd, executable) => {
      const resolved = await resolveDeployment(config, cwd);
      if (resolved.deployment === undefined) throw new Error(resolved.reason ?? "Libra deployment settings are unavailable");
      const deployment = { ...resolved.deployment, libraExecutable: executable };
      const client = new BridgeClient({ executable, cwd: deployment.repositoryRoot, env: dependencies.bridgeEnv(deployment) });
      deployments.set(client, deployment);
      return client;
    },
    bundleEntryPath: fileURLToPath(import.meta.url),
  });

  const sessionOwnedBy = (key: string) => (session: Session): boolean =>
    registry.sessionBinding(String(session.id))?.key === key;
  const sameDirectory = (observed: string, bound: string): boolean => {
    if (observed === bound) return true;
    try { return realpathSync(observed) === bound; } catch { return false; }
  };
  const hostDirectoryOf = (session: Session): string | undefined =>
    readSessionWorkingDirectory(workingDirectory, session);
  /**
   * A session is served only while its Host directory still resolves to the
   * directory recorded for that same session, so events and requests stop as
   * soon as the Host moves it. Comparing against the session's own directory
   * keeps sibling sessions of one worktree served even though the pooled
   * bridge started in another one.
   */
  const sessionServedBy = (key: string) => (session: Session): boolean => {
    const sessionId = String(session.id);
    if (bindingFailures.has(sessionId)) return false;
    if (registry.sessionBinding(sessionId)?.key !== key) return false;
    const sessionDirectory = registry.sessionDirectory(sessionId);
    const hostDirectory = hostDirectoryOf(session);
    return sessionDirectory !== undefined && hostDirectory !== undefined
      && sameDirectory(hostDirectory, sessionDirectory);
  };

  const reportFailure = (failure: BindingFailure): void => {
    const previous = bindingFailures.get(failure.sessionId);
    bindingFailures.set(failure.sessionId, failure);
    if (previous !== undefined && failureKey(previous) === failureKey(failure)) return;
    const advice = failure.kind === "no_working_directory"
      ? "the Host supplied no session working directory"
      : failure.kind === "not_a_repository"
        ? "the session directory is not a Libra repository"
        : failure.kind === "bridge_unavailable"
          ? "the configured Libra bridge could not start or complete its handshake"
          : failure.kind === "unsupported_capability"
            ? `the bridge is missing ${failure.missing.join(", ")}`
            : "the session directory now resolves to another Libra worktree; an explicit Host rebind is required";
    ctx.logger.warn(`libra: session ${failure.sessionId} is unavailable (${failure.kind}): ${advice}`);
  };

  async function retireSession(runtime: PerRepositoryRuntime, session: Session): Promise<void> {
    const sessionId = String(session.id);
    runtime.sessions.delete(sessionId);
    try {
      await runtime.workspace.release(sessionId);
    } catch (error) {
      ctx.logger.warn(`libra: workspace lease release failed for ${sessionId}: ${String(error)}`);
    }
    try {
      await runtime.outbox.retire(session);
    } catch (error) {
      ctx.logger.warn(`libra: outbox retirement failed for ${sessionId}: ${String(error)}`);
    }
    try {
      await runtime.memory?.retire(session);
    } catch (error) {
      ctx.logger.warn(`libra: memory retirement failed for ${sessionId}: ${String(error)}`);
    }
  }

  async function disposeRuntime(key: string): Promise<void> {
    const runtime = runtimes.get(key);
    if (runtime === undefined) return;
    runtimes.delete(key);
    await runtime.dispose();
  }

  async function ensureRuntime(binding: RepositoryBinding): Promise<PerRepositoryRuntime> {
    const existing = runtimes.get(binding.key);
    if (existing !== undefined) return existing;
    const pending = starting.get(binding.key);
    if (pending !== undefined) return pending;

    const work = (async (): Promise<PerRepositoryRuntime> => {
      const deployment = deployments.get(binding.client);
      if (deployment === undefined) throw new Error("bridge deployment snapshot is unavailable");
      const disposers: Array<() => unknown> = [];
      const serves = sessionServedBy(binding.key);
      const servesDisposal = sessionOwnedBy(binding.key);
      let outbox: ReturnType<typeof mountLibraOutbox> | undefined;
      let workspace: ReturnType<typeof mountLibraWorkspace> | undefined;
      let memory: RepositoryMemoryRuntime | undefined;
      try {
        outbox = mountLibraOutbox(ctx, binding.client, {
          // The opaque Libra identity is stable for sessions whose cwd is a
          // subdirectory of the same worktree; it namespaces this outbox.
          repositoryRoot: binding.key,
          ...(deployment.outboxRoot !== undefined ? { outboxRoot: deployment.outboxRoot } : {}),
          serves,
          servesDisposal,
        });
        disposers.push(outbox.dispose);

        if (binding.evidence.initialize.methods.includes("memory.recall")) {
          memory = await dependencies.mountMemory(ctx, binding.client, {
            memoryTokenBudget: () => readLive(config.memoryTokenBudget),
            captureEpisodes: () => readLive(config.captureMemoryEpisodes) === true,
            openSession: outbox.open,
            waitSession: outbox.wait,
            serves,
            registerProjection: false,
          });
          outbox.setMemory(memory);
          disposers.push(memory.dispose);
        } else {
          ctx.logger.warn(`libra: bridge for ${binding.identity.worktreeId} does not advertise memory.recall; Memory module not mounted`);
        }

        const tools = new ToolsFacade(binding.client, {
          allowRead: true,
          allowWrite: true,
          allowRestore: true,
          allowPushPublish: false,
        });
        facades.set(binding.key, tools);
        if (readLive(config.injectContext) !== false) {
          disposers.push(mountLibraContext(ctx, tools, {
            pluginName: dependencies.pluginName,
            serves,
            servesDisposal,
          }));
        }
        workspace = mountLibraWorkspace(ctx, binding.client, {
          repositoryRoot: binding.cwd,
          leaseTtlMs: () => readLive(config.workspaceLeaseTtlMs) ?? deployment.workspaceLeaseTtlMs,
          serves,
          servesDisposal,
          parentServes: (parentId) => registry.sessionBinding(parentId)?.key === binding.key
            && !bindingFailures.has(parentId),
        });
        disposers.push(workspace.dispose);

        const runtime: PerRepositoryRuntime = {
          binding,
          sessions: new Set(),
          outbox,
          workspace,
          ...(memory !== undefined ? { memory } : {}),
          dispose: async () => {
            for (const dispose of disposers.reverse()) {
              try {
                await dispose();
              } catch (error) {
                ctx.logger.warn(`libra: repository runtime shutdown failed (${binding.identity.worktreeId}): ${String(error)}`);
              }
            }
            facades.delete(binding.key);
          },
        };

        const disposeSession = ctx.on("session/disposed", async (session: Session) => {
          if (!sessionOwnedBy(binding.key)(session)) return;
          await retireSession(runtime, session);
          await registry.release(String(session.id), async (lastBinding) => {
            if (lastBinding.key === binding.key) await disposeRuntime(binding.key);
          });
        });
        disposers.push(disposeSession);
        return runtime;
      } catch (error) {
        for (const dispose of disposers.reverse()) {
          try { await dispose(); } catch { /* best-effort partial mount cleanup */ }
        }
        facades.delete(binding.key);
        throw error;
      }
    })();
    starting.set(binding.key, work);
    try {
      const runtime = await work;
      runtimes.set(binding.key, runtime);
      return runtime;
    } finally {
      starting.delete(binding.key);
    }
  }

  /**
   * Retire the state a Session accumulated in its previous repository as soon
   * as its Host directory no longer matches the directory recorded for it.
   * Covers moves to a missing directory, a non-repository and a dead bridge,
   * not only the explicit cwd_changed refusal.
   */
  async function retireIfMoved(session: Session, cwd: string | undefined): Promise<void> {
    const sessionId = String(session.id);
    const bound = registry.sessionBinding(sessionId);
    if (bound === undefined) return;
    const boundDirectory = registry.sessionDirectory(sessionId);
    if (cwd !== undefined && boundDirectory !== undefined && sameDirectory(cwd, boundDirectory)) return;
    const runtime = runtimes.get(bound.key);
    if (runtime !== undefined) await retireSession(runtime, session);
  }

  async function bindSession(session: Session): Promise<PerRepositoryRuntime | undefined> {
    if (disposed) return undefined;
    const sessionId = String(session.id);
    const cwd = readSessionWorkingDirectory(workingDirectory, session);
    if (cwd === undefined) {
      reportFailure({ kind: "no_working_directory", sessionId });
      await retireIfMoved(session, undefined);
      return undefined;
    }

    const legacyRoot = readLive(config.repositoryRoot)?.trim() || process.env.LIBRA_REPO?.trim();
    if (legacyRoot !== undefined && legacyRoot.length > 0 && !warnedLegacyRoot) {
      warnedLegacyRoot = true;
      ctx.logger.warn("libra: repositoryRoot/LIBRA_REPO is deprecated in session-bound mode; the Host session working directory is authoritative. Remove the setting after confirming each session opens in its intended repository.");
    }

    const result = await registry.bind(sessionId, cwd);
    if (!result.ok) {
      reportFailure(result.failure);
      await retireIfMoved(session, cwd);
      return undefined;
    }
    bindingFailures.delete(sessionId);
    try {
      const runtime = await ensureRuntime(result.binding);
      runtime.sessions.add(sessionId);
      runtime.memory?.track(session);
      await runtime.workspace.claim(session);
      return runtime;
    } catch (error) {
      await registry.release(sessionId, async (lastBinding) => disposeRuntime(lastBinding.key));
      reportFailure({ kind: "bridge_unavailable", sessionId, cwd });
      ctx.logger.warn(`libra: repository runtime activation failed: ${String(error)}`);
      return undefined;
    }
  }

  const trackBind = (session: Session): Promise<PerRepositoryRuntime | undefined> => {
    const work = bindSession(session);
    pendingBinds.add(work);
    void work.then(() => pendingBinds.delete(work), () => pendingBinds.delete(work));
    return work;
  };

  const resolveTools = async (session: Session | undefined): Promise<ToolsFacade | undefined> => {
    if (session === undefined) return undefined;
    const sessionId = String(session.id);
    const alreadyBound = registry.sessionBinding(sessionId) !== undefined;
    const generationBefore = alreadyBound ? registry.sessionGeneration(sessionId) : undefined;
    const runtime = await trackBind(session);
    if (runtime === undefined || bindingFailures.has(sessionId)) return undefined;
    // Binding and runtime activation are asynchronous; a move during either
    // must not send this call to the repository the Session left.
    const hostDirectory = hostDirectoryOf(session);
    const boundDirectory = registry.sessionDirectory(sessionId);
    const generationNow = registry.sessionGeneration(sessionId);
    if (hostDirectory === undefined || boundDirectory === undefined
      || !sameDirectory(hostDirectory, boundDirectory)
      || (alreadyBound && generationNow !== generationBefore)) {
      await retireIfMoved(session, hostDirectory);
      return undefined;
    }
    return facades.get(runtime.binding.key);
  };

  const toolsRuntime = ctx.get("tools");
  const disposeTools = toolsRuntime === undefined
    ? () => undefined
    : registerLibraTools(
        toolsRuntime as Parameters<typeof registerLibraTools>[0],
        resolveTools,
        ctx.get("approval") as ApprovalService | undefined,
        { generation: (sessionId) => registry.sessionGeneration(sessionId) },
      );

  const projections = ctx.get("sessionProjections") as SessionProjectionRegistrar | undefined;
  if (projections !== undefined) hostDisposers.push(projections.register(libraMemoryProjection));

  const diagnostics: LibraBridgeEvidenceService = {
    bindings: () => Object.freeze(registry.liveBindings().map((binding): BridgeEvidenceSnapshot => Object.freeze({
      key: binding.key,
      identity: Object.freeze({ ...binding.identity }),
      sessionCount: binding.refs,
      evidence: binding.evidence,
    }))),
    failure: (sessionId) => {
      const failure = bindingFailures.get(sessionId);
      if (failure === undefined) return undefined;
      return failure.kind === "unsupported_capability"
        ? { ...failure, missing: [...failure.missing] }
        : { ...failure };
    },
  };
  hostDisposers.push(ctx.reflect.provide("libraBridgeEvidence", diagnostics));

  const bindingService: LibraRepositoryBindingService = {
    rebind: async (value) => {
      if (typeof value !== "object" || value === null || !("id" in value)) {
        return { ok: false, failure: { kind: "no_working_directory", sessionId: "" } };
      }
      const session = value as Session;
      const sessionId = String(session.id);
      const cwd = readSessionWorkingDirectory(workingDirectory, session);
      if (cwd === undefined) {
        const failure: BindingFailure = { kind: "no_working_directory", sessionId };
        reportFailure(failure);
        return { ok: false, failure };
      }
      const oldBinding = registry.sessionBinding(sessionId);
      const oldRuntime = oldBinding === undefined ? undefined : runtimes.get(oldBinding.key);
      if (oldRuntime !== undefined) await retireSession(oldRuntime, session);
      const result = await registry.rebind(sessionId, cwd, async (lastBinding) => {
        await disposeRuntime(lastBinding.key);
      });
      if (!result.ok) {
        reportFailure(result.failure);
        return result;
      }
      bindingFailures.delete(sessionId);
      try {
        const runtime = await ensureRuntime(result.binding);
        runtime.sessions.add(sessionId);
        runtime.memory?.track(session);
        await runtime.workspace.claim(session);
        return result;
      } catch {
        await registry.release(sessionId, async (lastBinding) => disposeRuntime(lastBinding.key));
        const failure: BindingFailure = { kind: "bridge_unavailable", sessionId, cwd };
        reportFailure(failure);
        return { ok: false, failure };
      }
    },
  };
  hostDisposers.push(ctx.reflect.provide("libraRepositoryBinding", bindingService));

  const disposeCreated = ctx.on("session/created", (session: Session) => trackBind(session));
  const disposePreStep = ctx.on("agent/pre-step", async ({ agent }, next) => {
    await trackBind(agent.session);
    return next();
  }, { prepend: true });

  await Promise.allSettled(ctx.sessions.list().map((session) => trackBind(session)));

  return async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    disposeCreated();
    disposePreStep();
    disposeTools();
    await Promise.allSettled([...pendingBinds, ...starting.values()]);
    await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.dispose()));
    runtimes.clear();
    facades.clear();
    await registry.dispose();
    for (const dispose of hostDisposers.reverse()) {
      try { await dispose(); } catch { /* best-effort service/projection cleanup */ }
    }
  };
}

