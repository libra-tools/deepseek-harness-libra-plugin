/**
 * Host-owned typed Libra VCS read surface (plan-20261118 LVC-04).
 *
 * Every method resolves the caller's Session to the repository binding the
 * Host established in LVC-03, invokes exactly one negotiated `vcs.*` read
 * method, and returns a typed, bounded result. The model and the Client never
 * choose a repository root, revision range or absolute path; an AbortSignal
 * lets a UI refresh cancel a stale page between requests, and identical
 * in-flight reads are shared so one render cannot duplicate bridge calls.
 */
import {
  VcsReadError,
  type VcsDiffParams,
  type VcsDiffResult,
  type VcsLogParams,
  type VcsLogResult,
  type VcsReadMethods,
  type VcsShowParams,
  type VcsShowResult,
  type VcsStatusParams,
  type VcsStatusResult,
} from "@libra/dsh-bridge-client";

import type { BindingFailure } from "./repository-binding.js";

/** What the Host hands the read service for one bound Session. */
export interface VcsReadScope {
  read: VcsReadMethods;
  /** Methods this bridge negotiated, already filtered to the read set. */
  methods: readonly string[];
  bindingKey: string;
}

export type VcsScopeResolution =
  | { ok: true; scope: VcsReadScope }
  | { ok: false; failure: BindingFailure };

/** Resolve the caller's Session binding; `undefined` means "not bound yet". */
export type VcsScopeResolver = (session: unknown) => Promise<VcsScopeResolution | undefined>;

export type VcsHostFailureKind =
  | "cancelled"
  | "no_working_directory"
  | "not_a_repository"
  | "cwd_changed"
  | "bridge_unavailable"
  | "disconnected"
  | "unsupported_capability"
  | "invalid_params"
  | "cursor_invalid"
  | "scope_mismatch"
  | "stale_state"
  | "internal";

/** Failure carrying a machine-distinguishable kind for the Client UI. */
export class VcsHostError extends Error {
  readonly kind: VcsHostFailureKind;
  readonly retryable: boolean;

  constructor(kind: VcsHostFailureKind, message: string, retryable = false) {
    super(message);
    this.name = "VcsHostError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export interface VcsReadOptions {
  /** Abort a stale page or a refresh that superseded this request. */
  signal?: AbortSignal;
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

const HOST_KINDS = new Set<VcsHostFailureKind>([
  "invalid_params",
  "cursor_invalid",
  "scope_mismatch",
  "stale_state",
  "internal",
]);

function toHostError(error: unknown): VcsHostError {
  if (error instanceof VcsHostError) return error;
  if (error instanceof VcsReadError) {
    const kind = HOST_KINDS.has(error.kind as VcsHostFailureKind)
      ? error.kind as VcsHostFailureKind
      : error.kind as VcsHostFailureKind;
    return new VcsHostError(kind, error.message, error.retryable);
  }
  return new VcsHostError("internal", String(error));
}

function failureToHostError(failure: BindingFailure): VcsHostError {
  switch (failure.kind) {
    case "no_working_directory":
      return new VcsHostError("no_working_directory", "the Host reported no working directory for this Session");
    case "not_a_repository":
      return new VcsHostError("not_a_repository", "this Session's directory is not a Libra repository");
    case "cwd_changed":
      return new VcsHostError("cwd_changed", "this Session moved to another worktree; the Host must rebind it");
    case "bridge_unavailable":
      return new VcsHostError("bridge_unavailable", "the Libra bridge for this repository is unavailable", true);
    case "unsupported_capability":
      return new VcsHostError("unsupported_capability", `the bridge does not advertise ${failure.missing.join(", ")}`);
    default: {
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
}

/** Host read service provided as `libraVcsRead`; the model cannot call it. */
export class LibraVcsReadService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly resolve: VcsScopeResolver) {}

  status(session: unknown, params: VcsStatusParams = {}, options: VcsReadOptions = {}): Promise<VcsStatusResult> {
    return this.call(session, "status", params, options, (read) => read.status(params));
  }

  diff(session: unknown, params: VcsDiffParams, options: VcsReadOptions = {}): Promise<VcsDiffResult> {
    return this.call(session, "diff", params, options, (read) => read.diff(params));
  }

  log(session: unknown, params: VcsLogParams = {}, options: VcsReadOptions = {}): Promise<VcsLogResult> {
    return this.call(session, "log", params, options, (read) => read.log(params));
  }

  show(session: unknown, params: VcsShowParams, options: VcsReadOptions = {}): Promise<VcsShowResult> {
    return this.call(session, "show", params, options, (read) => read.show(params));
  }

  private async call<T>(
    session: unknown,
    method: "status" | "diff" | "log" | "show",
    params: unknown,
    options: VcsReadOptions,
    run: (read: VcsReadMethods) => Promise<T>,
  ): Promise<T> {
    if (isCancelled(options.signal)) throw new VcsHostError("cancelled", "the read was cancelled");
    if (typeof session !== "object" || session === null || !("id" in session)) {
      throw new VcsHostError("no_working_directory", "a Session is required");
    }
    const sessionId = String((session as { id: unknown }).id);
    const key = `${sessionId}\u0000${method}\u0000${JSON.stringify(params)}`;
    const shared = this.inflight.get(key);
    if (shared !== undefined) return shared as Promise<T>;

    const work = (async (): Promise<T> => {
      const resolution = await this.resolve(session);
      if (isCancelled(options.signal)) throw new VcsHostError("cancelled", "the read was cancelled");
      if (resolution === undefined) {
        throw new VcsHostError("no_working_directory", "this Session is not bound to a repository yet");
      }
      if (!resolution.ok) throw failureToHostError(resolution.failure);
      try {
        const result = await run(resolution.scope.read);
        if (isCancelled(options.signal)) throw new VcsHostError("cancelled", "the read was cancelled");
        return result;
      } catch (error) {
        throw toHostError(error);
      }
    })();
    this.inflight.set(key, work);
    void work.finally(() => {
      if (this.inflight.get(key) === work) this.inflight.delete(key);
    }).catch(() => undefined);
    return work;
  }
}
