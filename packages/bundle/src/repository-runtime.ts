/** Host-owned per-Session Libra bridge lifecycle (plan-20261118 LVC-03). */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import { VCS_READ_TOOLS } from "@libra/dsh-tools";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { VcsReadMethods } from "@libra/dsh-bridge-client";
import { redactPayload } from "@libra/dsh-session";
import { ToolsFacade } from "@libra/dsh-tools";

import { registerLibraTools, type ResolvedTools } from "./libra-tools.js";
import { mountLibraContext } from "./context.js";
import { defaultOutboxRoot, mountLibraOutbox } from "./outbox.js";
import { mountLibraWorkspace } from "./workspace.js";
import {
  readLive,
  resolveDeployment,
  resolveExecutable,
  type DeploymentConfig,
  type ResolvedDeployment,
} from "./deployment.js";
import { invokeVcsReadTool, LibraVcsReadService, VcsHostError } from "./vcs-read.js";
import { LibraVcsRemote } from "./vcs-remote.js";
import { libraMemoryProjection } from "./memory-projection.js";
import {
  RepositoryRegistry,
  readSessionWorkingDirectory,
  type BindingFailure,
  type BindResult,
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
  tools: ToolsFacade;
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
  const runtimeTails = new Map<string, Promise<void>>();
  const withRuntimeLock = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = runtimeTails.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    runtimeTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      unlock();
      if (runtimeTails.get(key) === tail) runtimeTails.delete(key);
    }
  };
  const deployments = new WeakMap<BridgeClient, ResolvedDeployment>();
  const facades = new Map<string, ToolsFacade>();
  const pendingBinds = new Set<Promise<PerRepositoryRuntime | undefined>>();
  const pendingOperations = new Set<Promise<unknown>>();
  const sessionTails = new Map<string, Promise<void>>();
  const disposedSessions = new Set<string>();
  // Events committed while a Session's bridge handshake is in flight are
  // persisted to disk and drained into the binding once it mounts, so capture
  // survives a slow bind or an early disposal instead of being dropped.
  const spoolRoot = join(
    (readLive(config.outboxRoot)?.trim() || "").length > 0
      ? readLive(config.outboxRoot)!.trim()
      : defaultOutboxRoot(),
    "pending-events",
  );
  const spoolWarned = new Set<string>();
  const deliveryFenced = new Set<string>();
  const SPOOL_WARN_BYTES = 64 * 1024 * 1024;
  const spoolName = (sessionId: string, identityKey: string): string =>
    `${sessionId.replace(/[^A-Za-z0-9._:-]/g, "_")}.${identityKey.replace(/[^A-Za-z0-9._:-]/g, "_")}.jsonl`;
  const spoolPath = (sessionId: string, identityKey: string): string =>
    join(spoolRoot, spoolName(sessionId, identityKey));
  const ensureSpoolRoot = (): void => {
    mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
    // An existing directory may carry broader modes from an older version.
    chmodSync(spoolRoot, 0o700);
  };
  const spoolEvent = (session: Session, event: BufferedSessionEvent, scope: string): boolean => {
    const sessionId = String(session.id);
    const path = spoolPath(sessionId, scope);
    // The durable spool follows the same fail-closed redaction as the outbox:
    // a payload that cannot be redacted is not written at all.
    const origin = canonicalHostDirectory(session);
    if (origin === undefined) {
      if (!spoolWarned.has(sessionId)) {
        spoolWarned.add(sessionId);
        ctx.logger.warn(`libra: session ${sessionId} has no trusted directory; refusing to spool its events`);
      }
      return false;
    }
    const redacted = redactPayload(JSON.stringify(event.data));
    if (!redacted.ok) {
      if (!spoolWarned.has(sessionId)) {
        spoolWarned.add(sessionId);
        ctx.logger.warn(`libra: session ${sessionId} has an event the spool cannot redact (${redacted.reason}); not persisted`);
      }
      return false;
    }
    try {
      ensureSpoolRoot();
      if (existsSync(path)) chmodSync(path, 0o600);
      const line = `${JSON.stringify({ seq: event.seq, type: event.type, payload: redacted.payload, origin })}\n`;
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
      const size = statSync(path).size;
      if (size > SPOOL_WARN_BYTES && !spoolWarned.has(sessionId)) {
        spoolWarned.add(sessionId);
        ctx.logger.warn(`libra: session ${sessionId} has ${size} bytes of unbound events; keeping the durable spool (disk bounded by bridge handshake timeout)`);
      }
      return true;
    } catch (error) {
      ctx.logger.warn(`libra: could not spool an event for session ${sessionId}: ${String(error)}`);
      return false;
    }
  };
  /**
   * Associate an event with the repository it belongs to. A Host move makes
   * the association uncertain, so such events are quarantined instead of being
   * delivered to whichever repository binds next.
   */
  const canonicalHostDirectory = (session: Session): string | undefined => {
    const directory = hostDirectoryOf(session);
    if (directory === undefined || !isAbsolute(directory)) return undefined;
    try { return realpathSync(directory); } catch { return undefined; }
  };
  const quarantineUnbound = (sessionId: string): void => {
    const path = spoolPath(sessionId, "unbound");
    if (!existsSync(path)) return;
    try {
      renameSync(path, spoolPath(sessionId, `quarantine-${Date.now()}`));
    } catch (error) {
      // Without a durable rename fence, that tail must never be delivered.
      deliveryFenced.add(sessionId);
      ctx.logger.warn(`libra: could not quarantine pre-binding events for session ${sessionId}; delivery is fenced: ${String(error)}`);
    }
  };
  const spoolScopeFor = (session: Session): string => {
    const sessionId = String(session.id);
    const record = registry.sessionBindingRecord(sessionId);
    if (record === undefined) return "unbound";
    const hostDirectory = hostDirectoryOf(session);
    const recordedDirectory = registry.sessionDirectory(sessionId);
    if (hostDirectory === undefined || recordedDirectory === undefined
      || !sameDirectory(hostDirectory, recordedDirectory)) return "quarantine";
    return record.key;
  };
  const sessionSerial = async <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = sessionTails.get(sessionId) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    sessionTails.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      unlock();
      if (sessionTails.get(sessionId) === tail) sessionTails.delete(sessionId);
    }
  };
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
    registry.sessionBindingRecord(String(session.id))?.key === key;
  const sameDirectory = (observed: string, bound: string): boolean => {
    // The Host reports absolute paths; resolving a relative value here would
    // compare it against the plugin process cwd.
    if (!isAbsolute(observed) || !isAbsolute(bound)) return false;
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
    if (bindingFailures.has(sessionId) || deliveryFenced.has(sessionId)) return false;
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
    await withRuntimeLock(key, () => disposeRuntimeNow(key));
  }

  async function disposeRuntimeNow(key: string): Promise<void> {
    const runtime = runtimes.get(key);
    if (runtime === undefined) return;
    runtimes.delete(key);
    await runtime.dispose();
  }

  async function ensureRuntime(binding: RepositoryBinding): Promise<PerRepositoryRuntime> {
    return withRuntimeLock(binding.key, async () => {
    const existing = runtimes.get(binding.key);
    if (existing !== undefined && existing.binding.client === binding.client) return existing;
    if (existing !== undefined) {
      // The registry replaced a crashed bridge with a new client; the mounted
      // layers still hold the dead one, so retire them before remounting.
      await disposeRuntimeNow(binding.key);
    }

    const work = (async (): Promise<PerRepositoryRuntime> => {
      const deployment = deployments.get(binding.client);
      if (deployment === undefined) throw new Error("bridge deployment snapshot is unavailable");
      const disposers: Array<() => unknown> = [];
      const serves = sessionServedBy(binding.key);
      const servesDisposal = sessionOwnedBy(binding.key);
      let outbox: ReturnType<typeof mountLibraOutbox> | undefined;
      let workspace: ReturnType<typeof mountLibraWorkspace> | undefined;
      let memory: RepositoryMemoryRuntime | undefined;
      let tools: ToolsFacade | undefined;
      try {
        outbox = mountLibraOutbox(ctx, binding.client, {
          // The opaque Libra identity is stable for sessions whose cwd is a
          // subdirectory of the same worktree; it namespaces this outbox.
          repositoryRoot: binding.key,
          ...(deployment.outboxRoot !== undefined ? { outboxRoot: deployment.outboxRoot } : {}),
          serves,
          servesDisposal,
          onCaptureFailure: (failedSession, failedEvent) => {
            spoolEvent(failedSession, failedEvent, binding.key);
          },
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

        tools = new ToolsFacade(binding.client, {
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
          tools: tools!,
          ...(memory !== undefined ? { memory } : {}),
          dispose: async () => {
            for (const dispose of disposers.reverse()) {
              try {
                await dispose();
              } catch (error) {
                ctx.logger.warn(`libra: repository runtime shutdown failed (${binding.identity.worktreeId}): ${String(error)}`);
              }
            }
            if (facades.get(binding.key) === tools) facades.delete(binding.key);
          },
        };

        return runtime;
      } catch (error) {
        for (const dispose of disposers.reverse()) {
          try { await dispose(); } catch { /* best-effort partial mount cleanup */ }
        }
        if (tools !== undefined && facades.get(binding.key) === tools) facades.delete(binding.key);
        throw error;
      }
    })();
    const runtime = await work;
    runtimes.set(binding.key, runtime);
    return runtime;
    });
  }

  /**
   * Retire the state a Session accumulated in its previous repository as soon
   * as its Host directory no longer matches the directory recorded for it.
   * Covers moves to a missing directory, a non-repository and a dead bridge,
   * not only the explicit cwd_changed refusal.
   */
  async function retireIfMoved(session: Session, cwd: string | undefined): Promise<void> {
    const sessionId = String(session.id);
    const record = registry.sessionBindingRecord(sessionId);
    if (record === undefined) return;
    const boundDirectory = registry.sessionDirectory(sessionId);
    if (cwd !== undefined && boundDirectory !== undefined && sameDirectory(cwd, boundDirectory)) return;
    const runtime = runtimes.get(record.key);
    if (runtime !== undefined) await retireSession(runtime, session);
  }

  async function bindSession(session: Session): Promise<PerRepositoryRuntime | undefined> {
    if (disposed) return undefined;
    return sessionSerial(String(session.id), () => bindSessionCore(session));
  }

  async function bindSessionCore(session: Session): Promise<PerRepositoryRuntime | undefined> {
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
      // The Host may have moved the Session during the handshake; deliver the
      // buffered events only when the binding still matches the Host directory.
      const activatedHost = hostDirectoryOf(session);
      const activatedDirectory = registry.sessionDirectory(sessionId);
      if (activatedHost === undefined || activatedDirectory === undefined
        || !sameDirectory(activatedHost, activatedDirectory)) {
        await retireSession(runtime, session);
        await registry.release(sessionId, async (lastBinding) => disposeRuntime(lastBinding.key));
        quarantineUnbound(sessionId);
        const failure: BindingFailure = { kind: "cwd_changed", sessionId, bound: result.binding.identity.worktreeId, now: "" };
        reportFailure(failure);
        return undefined;
      }
      flushSpooledEvents(sessionId, session, runtime);
      if (disposedSessions.has(sessionId)) {
        // The Session was disposed while its first bind was in flight; release
        // it now instead of keeping a bridge reference until unload.
        await retireSession(runtime, session);
        await registry.release(sessionId, async (lastBinding) => disposeRuntime(lastBinding.key));
        return undefined;
      }
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

  const vcsReadService = new LibraVcsReadService(async (value) => {
    if (typeof value !== "object" || value === null || !("id" in value)) return undefined;
    const session = value as Session;
    const sessionId = String(session.id);
    const runtime = await trackBind(session);
    if (runtime === undefined) {
      const failure = bindingFailures.get(sessionId);
      return {
        ok: false,
        failure: failure ?? { kind: "bridge_unavailable", sessionId, cwd: "" } as BindingFailure,
      };
    }
    const binding = runtime.binding;
    if (!binding.client.connected) {
      return { ok: false, failure: { kind: "bridge_unavailable", sessionId, cwd: binding.cwd } };
    }
    const generation = registry.sessionGeneration(sessionId) ?? 0;
    const validate = async (): Promise<void> => {
      const hostDirectory = hostDirectoryOf(session);
      const boundDirectory = registry.sessionDirectory(sessionId);
      const record = registry.sessionBindingRecord(sessionId);
      if (hostDirectory === undefined || boundDirectory === undefined
        || record?.key !== binding.key
        || registry.sessionGeneration(sessionId) !== generation
        || !sameDirectory(hostDirectory, boundDirectory)) {
        await retireIfMoved(session, hostDirectory);
        throw new VcsHostError("cwd_changed", "the Session repository binding changed during the read");
      }
      if (!binding.client.connected) {
        throw new VcsHostError("disconnected", "the repository bridge disconnected during the read", true);
      }
    };
    return {
      ok: true as const,
      scope: {
        read: new VcsReadMethods(binding.client),
        methods: binding.evidence.initialize.methods.filter((method) => method.startsWith("vcs.")),
        bindingKey: binding.key,
        generation,
        validate,
      },
    };
  });

  const vcsToolNames = new Set(VCS_READ_TOOLS.map((tool) => tool.name));
  const resolveTools = async (session: Session | undefined): Promise<ResolvedTools | undefined> => {
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
    const facade = facades.get(runtime.binding.key);
    if (facade === undefined) return undefined;
    return {
      listTools: () => facade.listTools(),
      getPolicy: () => facade.getPolicy(),
      supports: (method) => facade.supports(method),
      invoke: async (name, params) => {
        // The typed read tools share the Host service with the panel, so both
        // paths validate cursors/parameters and report the same failure kinds.
        if (vcsToolNames.has(name)) {
          return invokeVcsReadTool(vcsReadService, session, name, params);
        }
        return facade.invoke(name, params);
      },
    };
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
      evidence: Object.freeze({ ...binding.evidence }),
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

  hostDisposers.push(ctx.reflect.provide("libraVcsRead", vcsReadService));
  // Typert registers the Client-facing namespace with Cordis and owns its
  // disposal in this plugin context. Its Remote methods carry a Session
  // resource, so DSH checks the caller's session-level access policy.
  new LibraVcsRemote(ctx, vcsReadService, (sessionId) =>
    ctx.sessions.list().find((candidate) => String(candidate.id) === sessionId));

  const bindingService: LibraRepositoryBindingService = {
    rebind: async (value) => {
      const earlyId = typeof value === "object" && value !== null && "id" in value ? String(value.id) : "";
      if (disposed || disposedSessions.has(earlyId)) {
        return { ok: false, failure: { kind: "bridge_unavailable", sessionId: earlyId, cwd: "" } };
      }
      const target = value as Session;
      const work = (async () => sessionSerial(String(target.id), () => rebindNow(value)))();
      pendingOperations.add(work);
      try {
        return await work;
      } finally {
        pendingOperations.delete(work);
      }
    },
  };

  async function rebindNow(value: unknown): Promise<BindResult> {
    {
      if (typeof value !== "object" || value === null || !("id" in value)) {
        return { ok: false, failure: { kind: "no_working_directory", sessionId: "" } };
      }
      const session = value as Session;
      const sessionId = String(session.id);
      const cwd = readSessionWorkingDirectory(workingDirectory, session);
      if (cwd === undefined) {
        const failure: BindingFailure = { kind: "no_working_directory", sessionId };
        reportFailure(failure);
        await retireIfMoved(session, undefined);
        return { ok: false, failure };
      }
      // An explicit rebind makes the origin of any pre-binding tail uncertain.
      quarantineUnbound(sessionId);
      const oldBinding = registry.sessionBinding(sessionId);
      const oldRuntime = oldBinding === undefined ? undefined : runtimes.get(oldBinding.key);
      // Fence the old runtime before draining it so concurrent events and tool
      // calls cannot enter it while the session moves.
      bindingFailures.set(sessionId, { kind: "cwd_changed", sessionId, bound: oldBinding?.identity.worktreeId ?? "", now: "" });
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
        flushSpooledEvents(sessionId, session, runtime);
        if (disposedSessions.has(sessionId)) {
          await retireSession(runtime, session);
          await registry.release(sessionId, async (lastBinding) => disposeRuntime(lastBinding.key));
          const failure: BindingFailure = { kind: "bridge_unavailable", sessionId, cwd };
          reportFailure(failure);
          return { ok: false, failure };
        }
        return result;
      } catch {
        await registry.release(sessionId, async (lastBinding) => disposeRuntime(lastBinding.key));
        const failure: BindingFailure = { kind: "bridge_unavailable", sessionId, cwd };
        reportFailure(failure);
        return { ok: false, failure };
      }
    }
  }
  hostDisposers.push(ctx.reflect.provide("libraRepositoryBinding", bindingService));

  interface BufferedSessionEvent { seq: number; type: string; data: unknown }

  /**
   * Binding and runtime activation cross an asynchronous bridge handshake, so
   * events committed in that window would otherwise reach no outbox. Buffer
   * them per session and drain them into the binding once it is mounted.
   */
  const disposeEventBuffer = ctx.on("session/event", (session: Session, event: BufferedSessionEvent) => {
    const sessionId = String(session.id);
    const bound = registry.sessionBinding(sessionId);
    const runtime = bound === undefined ? undefined : runtimes.get(bound.key);
    if (runtime !== undefined && runtime.sessions.has(sessionId)
      && runtime.outbox.accepting() && sessionServedBy(bound!.key)(session)) return;
    spoolEvent(session, event, spoolScopeFor(session));
  });

  const flushSpooledEvents = (sessionId: string, session: Session, runtime: PerRepositoryRuntime): void => {
    // Deliver only events that verifiably belong here: the Host must still
    // resolve to the recorded directory of this repository.
    if (deliveryFenced.has(sessionId)) return;
    if (registry.sessionBindingRecord(sessionId) === undefined && deliveryFenced.has(sessionId)) return;
    const hostDirectory = hostDirectoryOf(session);
    const recordedDirectory = registry.sessionDirectory(sessionId);
    const record = registry.sessionBindingRecord(sessionId);
    if (hostDirectory === undefined || recordedDirectory === undefined
      || record?.key !== runtime.binding.key || !sameDirectory(hostDirectory, recordedDirectory)) return;
    const scopes = [runtime.binding.key, "unbound"];
    for (const scope of scopes) {
      const path = spoolPath(sessionId, scope);
      if (!existsSync(path)) continue;
      try {
        const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
        let accepted = 0;
        let quarantined = false;
        for (const line of lines) {
          const parsed = JSON.parse(line) as { seq: number; type: string; payload: string; origin?: string };
          // Deliver only events whose recorded origin is this repository; a
          // tail from elsewhere is quarantined instead of being delivered.
          if (parsed.origin === undefined
            || !(sameDirectory(parsed.origin, recordedDirectory)
              || (hostDirectory !== undefined && sameDirectory(parsed.origin, hostDirectory)))) {
            try {
              renameSync(path, spoolPath(sessionId, `quarantine-${Date.now()}`));
              quarantined = true;
            } catch {
              deliveryFenced.add(sessionId);
              return;
            }
            break;
          }
          if (!runtime.outbox.capture(session, {
            seq: parsed.seq,
            type: parsed.type,
            data: JSON.parse(parsed.payload) as unknown,
          })) break;
          accepted += 1;
        }
        if (quarantined) continue;
        if (accepted === lines.length) {
          unlinkSync(path);
        } else if (accepted > 0) {
          const remaining = `${lines.slice(accepted).join("\n")}\n`;
          const temporary = `${path}.tmp`;
          writeFileSync(temporary, remaining, { encoding: "utf8", mode: 0o600 });
          chmodSync(temporary, 0o600);
          renameSync(temporary, path);
        }
      } catch (error) {
        ctx.logger.warn(`libra: could not drain spooled events for session ${sessionId}: ${String(error)}`);
      }
    }
  };

  const disposeCreated = ctx.on("session/created", (session: Session) => trackBind(session));
  const disposeLifecycle = ctx.on("session/disposed", async (session: Session) => {
    const sessionId = String(session.id);
    disposedSessions.add(sessionId);
    await sessionSerial(sessionId, async () => {
      const record = registry.sessionBindingRecord(sessionId);
      if (record !== undefined) {
        const runtime = runtimes.get(record.key);
        if (runtime !== undefined) {
          flushSpooledEvents(sessionId, session, runtime);
          await retireSession(runtime, session);
        }
        await registry.release(sessionId, async (lastBinding) => disposeRuntime(lastBinding.key));
      }
      bindingFailures.delete(sessionId);
    });
  });
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
    disposeLifecycle();
    disposeTools();
    // Keep spooling events until in-flight binds settle: a handshake that is
    // still running has no outbox mounted, so those committed events must
    // remain durable rather than disappear during unload.
    await Promise.allSettled([...pendingBinds, ...pendingOperations, ...runtimeTails.values()]);
    await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.dispose()));
    runtimes.clear();
    facades.clear();
    disposeEventBuffer();
    await registry.dispose();
    for (const dispose of hostDisposers.reverse()) {
      try { await dispose(); } catch { /* best-effort service/projection cleanup */ }
    }
  };
}

