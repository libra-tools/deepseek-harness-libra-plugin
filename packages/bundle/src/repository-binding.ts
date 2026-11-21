/**
 * Per-session repository binding for the Libra bridge (plan-20261118 LVC-03).
 *
 * The Host owns the trusted working directory of a session; the model never
 * supplies it. Every session is bound once to the Libra worktree its own
 * directory resolves to, and one bridge process per canonical worktree is
 * shared by the sessions that address it. A session whose directory later
 * resolves to a different worktree fails closed instead of being sent to
 * another repository.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { BridgeClient, InitializeResult } from "@libra/dsh-bridge-client";

/** The repository identity the bridge reported for one worktree. */
export interface RepositoryIdentity {
  worktreeId: string;
  worktreeRootHash: string;
  headOid: string | null;
  branch: string | null;
  unborn: boolean;
}

/** What the Host records about a running bridge and the loaded bundle. */
export interface BridgeEvidence {
  /** Absolute path of the executable the bridge runs. */
  executable: string;
  /** SHA-256 of that executable file. */
  executableSha256: string;
  /** OS process id of the bridge child, when it is running. */
  childPid: number | undefined;
  /** The full `initialize` result the bridge returned. */
  initialize: InitializeResult;
  /** Absolute path of the loaded plugin entry file. */
  loadedModule: string;
  /** SHA-256 of the loaded plugin entry file. */
  loadedModuleSha256: string;
}

export interface RepositoryBinding {
  /** Stable identity of the bound worktree. */
  readonly key: string;
  /** Trusted working directory the Host reported when the session bound. */
  readonly cwd: string;
  readonly client: BridgeClient;
  readonly identity: RepositoryIdentity;
  readonly evidence: BridgeEvidence;
  refs: number;
}

/** Why a session could not be bound to a Libra repository. */
export type BindingFailure =
  | { kind: "no_working_directory"; sessionId: string }
  | { kind: "not_a_repository"; sessionId: string; cwd: string }
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
  executable: string;
  /** Create a connected-enough client for one worktree; the registry connects it. */
  createClient: (cwd: string) => BridgeClient;
  /** The entry file of the loaded plugin, for the bundle evidence. */
  loadedModule?: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
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
  if (typeof worktreeId !== "string" || typeof worktreeRootHash !== "string") return undefined;
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
 * One bridge per canonical worktree, shared by the sessions bound to it.
 *
 * A binding is created on a session's first access, reused while at least one
 * session references it, and closed once its last reference is released or the
 * plugin unloads.
 */
export class RepositoryRegistry {
  private readonly bindings = new Map<string, RepositoryBinding>();
  private readonly sessions = new Map<string, { key: string; cwd: string }>();
  private readonly loadedModule: string;
  private loadedModuleSha256: Promise<string> | undefined;
  private closed = false;

  constructor(private readonly options: RepositoryRegistryOptions) {
    this.loadedModule = options.loadedModule ?? fileURLToPath(import.meta.url);
  }

  /** Every live binding, in creation order, for Host diagnostics. */
  liveBindings(): RepositoryBinding[] {
    return [...this.bindings.values()];
  }

  /** The binding a session currently holds, if any. */
  sessionBinding(sessionId: string): RepositoryBinding | undefined {
    const bound = this.sessions.get(sessionId);
    return bound === undefined ? undefined : this.bindings.get(bound.key);
  }

  /**
   * Bind a session to the worktree its trusted working directory resolves to.
   *
   * A session already bound to one worktree fails closed when its directory
   * now resolves to another one: the caller must rebind explicitly instead of
   * having requests silently redirected.
   */
  async bind(
    sessionId: string,
    workingDirectory: string,
  ): Promise<BindResult> {
    if (this.closed) {
      return { ok: false, failure: { kind: "not_a_repository", sessionId, cwd: workingDirectory } };
    }
    let cwd: string;
    try {
      cwd = await realpath(workingDirectory);
    } catch {
      return { ok: false, failure: { kind: "not_a_repository", sessionId, cwd: workingDirectory } };
    }

    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      const binding = this.bindings.get(existing.key);
      if (binding !== undefined) {
        const current = await this.identify(sessionId, cwd);
        if (!current.ok) return current;
        if (current.identity.worktreeId !== binding.key) {
          return {
            ok: false,
            failure: {
              kind: "cwd_changed",
              sessionId,
              bound: binding.key,
              now: current.identity.worktreeId,
            },
          };
        }
        binding.refs += 1;
        this.sessions.set(sessionId, { key: binding.key, cwd });
        return { ok: true, binding };
      }
      this.sessions.delete(sessionId);
    }

    const identified = await this.identify(sessionId, cwd);
    if (!identified.ok) return identified;
    const { identity, client, evidence } = identified;

    const shared = this.bindings.get(identity.worktreeId);
    if (shared !== undefined) {
      shared.refs += 1;
      this.sessions.set(sessionId, { key: shared.key, cwd });
      // The session asked through a different client; close the spare child.
      await client.close().catch(() => undefined);
      return { ok: true, binding: shared };
    }

    const binding: RepositoryBinding = {
      key: identity.worktreeId,
      cwd,
      client,
      identity,
      evidence,
      refs: 1,
    };
    this.bindings.set(binding.key, binding);
    this.sessions.set(sessionId, { key: binding.key, cwd });
    return { ok: true, binding };
  }

  /** Drop one session's reference; the last reference closes the bridge. */
  async release(sessionId: string): Promise<void> {
    const bound = this.sessions.get(sessionId);
    if (bound === undefined) return;
    this.sessions.delete(sessionId);
    const binding = this.bindings.get(bound.key);
    if (binding === undefined) return;
    binding.refs -= 1;
    if (binding.refs > 0) return;
    this.bindings.delete(binding.key);
    await binding.client.close().catch(() => undefined);
  }

  /** Close every bridge; used on plugin unload. */
  async dispose(): Promise<void> {
    this.closed = true;
    this.sessions.clear();
    const bindings = [...this.bindings.values()];
    this.bindings.clear();
    await Promise.allSettled(bindings.map((binding) => binding.client.close()));
  }

  /** Connect one client and read its identity and evidence. */
  private async identify(
    sessionId: string,
    cwd: string,
  ): Promise<
    | { ok: true; identity: RepositoryIdentity; client: BridgeClient; evidence: BridgeEvidence }
    | { ok: false; failure: BindingFailure }
  > {
    const client = this.options.createClient(cwd);
    let initialize: InitializeResult;
    try {
      initialize = await client.connect();
    } catch {
      await client.close().catch(() => undefined);
      return { ok: false, failure: { kind: "not_a_repository", sessionId, cwd } };
    }
    const missing = REQUIRED_METHODS.filter((method) => !initialize.methods.includes(method));
    if (missing.length > 0) {
      await client.close().catch(() => undefined);
      return { ok: false, failure: { kind: "unsupported_capability", sessionId, missing } };
    }
    let identity: RepositoryIdentity | undefined;
    try {
      const response = await client.requestMethod("vcs.identity");
      identity = readIdentity(response.result);
    } catch {
      identity = undefined;
    }
    if (identity === undefined) {
      await client.close().catch(() => undefined);
      return { ok: false, failure: { kind: "not_a_repository", sessionId, cwd } };
    }
    this.loadedModuleSha256 ??= fileSha256(this.loadedModule).catch(() => "");
    const evidence: BridgeEvidence = {
      executable: this.options.executable,
      executableSha256: await fileSha256(this.options.executable).catch(() => ""),
      childPid: client.childPid,
      initialize,
      loadedModule: this.loadedModule,
      loadedModuleSha256: await this.loadedModuleSha256,
    };
    return { ok: true, identity, client, evidence };
  }
}
