/**
 * Per-session repository binding for the Libra bridge (plan-20261118 LVC-03).
 *
 * The Host owns the session's effective working directory; the model never
 * supplies it. Libra's typed identity response determines the canonical
 * worktree identity. One persistent bridge serves each worktree, shared by
 * sessions that resolve to it. A session whose working directory later
 * resolves to a different worktree fails closed.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeClient, InitializeResult } from "@libra/dsh-bridge-client";

/** The repository identity reported by Libra for one worktree. */
export interface RepositoryIdentity {
  worktreeId: string;
  worktreeRootHash: string;
  headOid: string | null;
  branch: string | null;
  unborn: boolean;
}

/** What the Host records about a running bridge and the loaded bundle. */
export interface BridgeEvidence {
  /** Absolute path of the executable the bridge actually runs. */
  executable: string;
  /** SHA-256 of that executable file. */
  executableSha256: string;
  /** OS process id of the persistent bridge child. */
  childPid: number;
  /** Full, immutable `initialize` result returned by this bridge. */
  initialize: InitializeResult;
  /** Absolute package directory containing the loaded bundle entry. */
  bundlePackageDir: string;
  /** Absolute path to the loaded bundle entry, normally `dist/index.js`. */
  bundleEntryPath: string;
  /** SHA-256 of the loaded bundle entry. */
  bundleEntrySha256: string;
}

export interface RepositoryBinding {
  /** Opaque key derived from the worktree ID and canonical-root hash. */
  readonly key: string;
  /** Trusted Host working directory used to start the persistent bridge. */
  readonly cwd: string;
  readonly client: BridgeClient;
  readonly identity: RepositoryIdentity;
  readonly evidence: BridgeEvidence;
  refs: number;
}

/** Read-only evidence exposed to the Host and UI; it contains no bridge handle. */
export interface BridgeEvidenceSnapshot {
  key: string;
  identity: RepositoryIdentity;
  sessionCount: number;
  evidence: BridgeEvidence;
}

/** Read-only Host diagnostic service for loaded bundle and bridge identity. */
export interface LibraBridgeEvidenceService {
  bindings(): readonly BridgeEvidenceSnapshot[];
  failure(sessionId: string): BindingFailure | undefined;
}

/** Host-only explicit rebinding entry point; model tools never receive it. */
export interface LibraRepositoryBindingService {
  rebind(session: unknown): Promise<BindResult>;
}

/** Why a session could not be bound to a Libra repository. */
export type BindingFailure =
  | { kind: "no_working_directory"; sessionId: string }
  | { kind: "not_a_repository"; sessionId: string; cwd: string }
  | { kind: "bridge_unavailable"; sessionId: string; cwd: string }
  | { kind: "unsupported_capability"; sessionId: string; missing: string[] }
  | { kind: "cwd_changed"; sessionId: string; bound: string; now: string };

export type BindResult =
  | { ok: true; binding: RepositoryBinding }
  | { ok: false; failure: BindingFailure };

/** The Host service that owns a session's trusted working directory. */
export interface WorkingDirectoryService {
  get(session: unknown): string | undefined;
}

/** Factories the bundle wires in; tests replace them. */
export interface RepositoryRegistryOptions {
  /** Resolve the current configured executable to its canonical absolute path. */
  resolveExecutable: () => Promise<string>;
  /** Create a client for one trusted working directory and binary. */
  createClient: (cwd: string, executable: string) => BridgeClient | Promise<BridgeClient>;
  /** The loaded bundle entry (from the executing module's `import.meta.url`). */
  bundleEntryPath?: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function identityKey(identity: RepositoryIdentity): string {
  return sha256(`${identity.worktreeRootHash}\0${identity.worktreeId}`);
}

function immutableInitialize(result: InitializeResult): InitializeResult {
  return Object.freeze({
    protocol: Object.freeze({ ...result.protocol }),
    limits: Object.freeze({ ...result.limits }),
    methods: Object.freeze([...result.methods]),
    source: result.source,
  }) as unknown as InitializeResult;
}

function packageDirectoryFor(entryPath: string): string {
  const entryDirectory = dirname(entryPath);
  return ["dist", "lib", "src"].includes(basename(entryDirectory))
    ? dirname(entryDirectory)
    : entryDirectory;
}

/** Read a session's working directory from the Host service, never a model value. */
export function readSessionWorkingDirectory(
  service: WorkingDirectoryService | undefined,
  session: unknown,
): string | undefined {
  if (service === undefined) return undefined;
  const value = service.get(session);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** The capabilities this layer needs from the bridge. */
const REQUIRED_METHODS = ["vcs.identity"] as const;

function readIdentity(result: unknown): RepositoryIdentity | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const data = result as Record<string, unknown>;
  const payload = typeof data["data"] === "object" && data["data"] !== null
    ? data["data"] as Record<string, unknown>
    : data;
  const worktreeId = payload["worktree_id"];
  const worktreeRootHash = payload["worktree_root_hash"];
  if (typeof worktreeId !== "string" || worktreeId.length === 0
    || typeof worktreeRootHash !== "string" || worktreeRootHash.length === 0) return undefined;
  const headOid = payload["head_oid"];
  const branch = payload["branch"];
  return {
    worktreeId,
    worktreeRootHash,
    headOid: typeof headOid === "string" ? headOid : null,
    branch: typeof branch === "string" ? branch : null,
    unborn: payload["unborn"] === true,
  };
}

/**
 * One persistent bridge per canonical worktree, shared by its bound sessions.
 * Calls for a single session are serialized so retries and concurrent first
 * accesses cannot increment a reference twice or leave duplicate processes.
 */
export class RepositoryRegistry {
  private readonly bindings = new Map<string, RepositoryBinding>();
  private readonly sessions = new Map<string, { key: string; cwd: string }>();
  private readonly generations = new Map<string, number>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly identityTails = new Map<string, Promise<void>>();
  private readonly bundleEntryPath: string;
  private closed = false;

  constructor(private readonly options: RepositoryRegistryOptions) {
    this.bundleEntryPath = options.bundleEntryPath ?? fileURLToPath(import.meta.url);
  }

  /** Every live binding, in creation order, for Host diagnostics. */
  liveBindings(): RepositoryBinding[] {
    return [...this.bindings.values()];
  }

  /** The binding a session currently holds, if its bridge is still alive. */
  sessionBinding(sessionId: string): RepositoryBinding | undefined {
    const bound = this.sessions.get(sessionId);
    if (bound === undefined) return undefined;
    const binding = this.bindings.get(bound.key);
    return binding !== undefined && binding.client.connected ? binding : undefined;
  }

  /** The session's own canonical directory inside its bound worktree. */
  sessionDirectory(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  /**
   * Monotonic binding generation for one session. A rebind, a move inside the
   * worktree, or a release increments it, so a caller that captured an earlier
   * value can detect that the session moved while it waited.
   */
  sessionGeneration(sessionId: string): number | undefined {
    return this.generations.get(sessionId);
  }

  private advanceGeneration(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
  }

  /**
   * Bind a session to the worktree its Host-trusted working directory resolves
   * to. Repeated calls validate the identity without acquiring another ref.
   */
  async bind(sessionId: string, workingDirectory: string): Promise<BindResult> {
    return this.withLock(this.sessionTails, sessionId, () => this.bindLocked(sessionId, workingDirectory));
  }

  private async bindLocked(sessionId: string, workingDirectory: string): Promise<BindResult> {
    if (this.closed) {
      return { ok: false, failure: { kind: "bridge_unavailable", sessionId, cwd: workingDirectory } };
    }
    if (!isAbsolute(workingDirectory)) {
      // The Host reports absolute directories; a relative value would resolve
      // against the plugin process cwd and bind an unintended repository.
      return { ok: false, failure: { kind: "not_a_repository", sessionId, cwd: workingDirectory } };
    }
    let cwd: string;
    try {
      cwd = await realpath(workingDirectory);
    } catch {
      return { ok: false, failure: { kind: "not_a_repository", sessionId, cwd: workingDirectory } };
    }

    const existing = this.sessions.get(sessionId);
    if (existing !== undefined && existing.cwd === cwd) {
      const binding = this.bindings.get(existing.key);
      if (binding !== undefined) {
        // A crashed child is not a usable binding; drop it and re-identify so
        // the caller gets a live bridge and fresh evidence.
        if (binding.client.connected) return { ok: true, binding };
        this.bindings.delete(binding.key);
        await binding.client.close().catch(() => undefined);
      }
      this.sessions.delete(sessionId);
    }
    const probe = await this.identify(sessionId, cwd);
    if (!probe.ok) return probe;

    if (existing !== undefined) {
      const bound = this.bindings.get(existing.key);
      if (bound !== undefined) {
        await probe.client.close().catch(() => undefined);
        if (probe.identityKey !== bound.key) {
          return {
            ok: false,
            failure: {
              kind: "cwd_changed",
              sessionId,
              bound: bound.identity.worktreeId,
              now: probe.identity.worktreeId,
            },
          };
        }
        this.sessions.set(sessionId, { key: bound.key, cwd });
        this.advanceGeneration(sessionId);
        return { ok: true, binding: bound };
      }
      this.sessions.delete(sessionId);
    }

    return this.withLock(this.identityTails, probe.identityKey, async () => {
      if (this.closed) {
        await probe.client.close().catch(() => undefined);
        return { ok: false, failure: { kind: "bridge_unavailable", sessionId, cwd } };
      }
      const pooled = this.bindings.get(probe.identityKey);
      if (pooled !== undefined) {
        await probe.client.close().catch(() => undefined);
        pooled.refs += 1;
        this.sessions.set(sessionId, { key: pooled.key, cwd });
        this.advanceGeneration(sessionId);
        return { ok: true, binding: pooled };
      }

      const binding: RepositoryBinding = {
        key: probe.identityKey,
        cwd,
        client: probe.client,
        identity: probe.identity,
        evidence: probe.evidence,
        refs: 1,
      };
      this.bindings.set(binding.key, binding);
      this.sessions.set(sessionId, { key: binding.key, cwd });
      this.advanceGeneration(sessionId);
      return { ok: true, binding };
    });
  }

  /** Drop one session's reference; drain its runtime before closing the last bridge. */
  async release(
    sessionId: string,
    beforeLastRelease?: (binding: RepositoryBinding) => Promise<void>,
  ): Promise<void> {
    await this.withLock(this.sessionTails, sessionId, () => this.releaseLocked(sessionId, beforeLastRelease));
  }

  /** Explicitly move a session after a cwd_changed refusal. */
  async rebind(
    sessionId: string,
    workingDirectory: string,
    beforeLastRelease?: (binding: RepositoryBinding) => Promise<void>,
  ): Promise<BindResult> {
    return this.withLock(this.sessionTails, sessionId, async () => {
      await this.releaseLocked(sessionId, beforeLastRelease);
      return this.bindLocked(sessionId, workingDirectory);
    });
  }

  private async releaseLocked(
    sessionId: string,
    beforeLastRelease?: (binding: RepositoryBinding) => Promise<void>,
  ): Promise<void> {
    const bound = this.sessions.get(sessionId);
    if (bound === undefined) return;
    await this.withLock(this.identityTails, bound.key, async () => {
      const binding = this.bindings.get(bound.key);
      if (binding === undefined) {
        this.sessions.delete(sessionId);
        return;
      }
      if (binding.refs <= 1) await beforeLastRelease?.(binding);
      this.sessions.delete(sessionId);
      this.advanceGeneration(sessionId);
      binding.refs -= 1;
      if (binding.refs > 0) return;
      this.bindings.delete(binding.key);
      await binding.client.close().catch(() => undefined);
    });
  }

  /** Close every bridge after pending binds and releases have settled. */
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.sessionTails.values(), ...this.identityTails.values()]);
    this.sessions.clear();
    const bindings = [...this.bindings.values()];
    this.bindings.clear();
    await Promise.allSettled(bindings.map((binding) => binding.client.close()));
  }

  private async withLock<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    locks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      unlock();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  /** Connect a probe and read its identity plus the running-artifact evidence. */
  private async identify(sessionId: string, cwd: string): Promise<
    | { ok: true; identity: RepositoryIdentity; identityKey: string; client: BridgeClient; evidence: BridgeEvidence }
    | { ok: false; failure: BindingFailure }
  > {
    let executable: string;
    let client: BridgeClient;
    try {
      executable = await this.options.resolveExecutable();
      if (!isAbsolute(executable)) throw new Error("resolved Libra executable is not absolute");
      client = await this.options.createClient(cwd, executable);
    } catch {
      return { ok: false, failure: { kind: "bridge_unavailable", sessionId, cwd } };
    }

    let initialize: InitializeResult;
    try {
      initialize = immutableInitialize(await client.connect());
    } catch {
      await client.close().catch(() => undefined);
      return { ok: false, failure: { kind: "bridge_unavailable", sessionId, cwd } };
    }
    const missing = REQUIRED_METHODS.filter((method) => !initialize.methods.includes(method));
    if (missing.length > 0) {
      await client.close().catch(() => undefined);
      return { ok: false, failure: { kind: "unsupported_capability", sessionId, missing: [...missing] } };
    }

    let identity: RepositoryIdentity | undefined;
    try {
      const response = await client.requestMethod("vcs.identity");
      identity = response.state === "success" ? readIdentity(response.result) : undefined;
    } catch {
      await client.close().catch(() => undefined);
      return { ok: false, failure: { kind: "bridge_unavailable", sessionId, cwd } };
    }
    if (identity === undefined) {
      await client.close().catch(() => undefined);
      return { ok: false, failure: { kind: "not_a_repository", sessionId, cwd } };
    }

    try {
      const bundleEntryPath = await realpath(this.bundleEntryPath);
      const [executableSha256, bundleEntrySha256] = await Promise.all([
        fileSha256(executable),
        fileSha256(bundleEntryPath),
      ]);
      const childPid = client.childPid;
      if (childPid === undefined) throw new Error("bridge child process is not running");
      // Evidence is host-owned proof; freeze it so no later caller can rewrite
      // the values a diagnostic reports as the running artifact.
      const evidence: BridgeEvidence = Object.freeze({
        executable,
        executableSha256,
        childPid,
        initialize,
        bundlePackageDir: packageDirectoryFor(bundleEntryPath),
        bundleEntryPath,
        bundleEntrySha256,
      });
      return { ok: true, identity, identityKey: identityKey(identity), client, evidence };
    } catch {
      await client.close().catch(() => undefined);
      return { ok: false, failure: { kind: "bridge_unavailable", sessionId, cwd } };
    }
  }
}
