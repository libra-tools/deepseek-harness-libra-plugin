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
  /** Monotonic binding generation, so a shared read cannot cross a rebind. */
  generation: number;
  /** Revalidate Host directory, ownership key and generation after the read. */
  validate(): Promise<void>;
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
  | "conflict"
  | "protocol_mismatch"
  | "denied"
  | "timeout"
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
  /** Abort this caller's wait when a newer page supersedes it. */
  signal?: AbortSignal;
  /** Caller-generated refresh identity; different ids never share an in-flight read. */
  requestId?: string;
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function toHostError(error: unknown): VcsHostError {
  if (error instanceof VcsHostError) return error;
  if (error instanceof VcsReadError) {
    return new VcsHostError(error.kind, error.message, error.retryable);
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
    if (options.requestId !== undefined
      && (typeof options.requestId !== "string" || options.requestId.length === 0 || options.requestId.length > 128)) {
      throw new VcsHostError("invalid_params", "requestId must be a non-empty string of at most 128 characters");
    }
    if (typeof session !== "object" || session === null || !("id" in session)) {
      throw new VcsHostError("no_working_directory", "a Session is required");
    }
    const sessionId = String((session as { id: unknown }).id);

    // Resolve the binding before sharing: the key includes the bound repository
    // and its generation, so a read cannot hand a previous repository's rows to
    // a Session that moved, and each caller's own signal decides its outcome.
    const resolution = await this.resolve(session);
    if (isCancelled(options.signal)) throw new VcsHostError("cancelled", "the read was cancelled");
    if (resolution === undefined) {
      throw new VcsHostError("no_working_directory", "this Session is not bound to a repository yet");
    }
    if (!resolution.ok) throw failureToHostError(resolution.failure);

    await resolution.scope.validate();
    const key = `${sessionId}\u0000${resolution.scope.bindingKey}\u0000${resolution.scope.generation}\u0000${JSON.stringify(options.requestId ?? null)}\u0000${method}\u0000${JSON.stringify(params)}`;
    const shared = this.inflight.get(key);
    if (shared !== undefined) return this.await(shared as Promise<T>, options.signal, resolution.scope.validate);

    const work = (async (): Promise<T> => {
      try {
        return await run(resolution.scope.read);
      } catch (error) {
        throw toHostError(error);
      }
    })();
    this.inflight.set(key, work);
    void work.finally(() => {
      if (this.inflight.get(key) === work) this.inflight.delete(key);
    }).catch(() => undefined);
    return this.await(work, options.signal, resolution.scope.validate);
  }

  /** Await one caller's read, cancel only that waiter, then recheck its binding. */
  private async await<T>(
    work: Promise<T>,
    signal: AbortSignal | undefined,
    validate: () => Promise<void>,
  ): Promise<T> {
    if (isCancelled(signal)) throw new VcsHostError("cancelled", "the read was cancelled");
    let result: T;
    if (signal === undefined) {
      result = await work;
    } else {
      let onAbort: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new VcsHostError("cancelled", "the read was cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        result = await Promise.race([work, cancelled]);
      } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
    }
    if (isCancelled(signal)) throw new VcsHostError("cancelled", "the read was cancelled");
    await validate();
    if (isCancelled(signal)) throw new VcsHostError("cancelled", "the read was cancelled");
    return result;
  }
}

/** One Agent tool result for a typed VCS read, in the shared ToolResult shape. */
export interface VcsToolResult {
  schema_version: string;
  operation_id: string;
  status: "ok" | "error";
  data?: unknown;
  error?: { code: number; message: string; retryable: boolean; stable_code?: string };
}

const READ_TOOL_PARAMETERS: Record<string, { method: "status" | "diff" | "log" | "show"; params: string[]; required: string[] }> = {
  libra_vcs_status: { method: "status", params: ["cursor", "limit"], required: [] },
  libra_vcs_diff: { method: "diff", params: ["sides", "oid", "paths", "limit"], required: ["sides"] },
  libra_vcs_log: { method: "log", params: ["cursor", "limit"], required: [] },
  libra_vcs_show: { method: "show", params: ["oid", "cursor", "limit"], required: ["oid"] },
};

const FORBIDDEN_TOOL_PARAMETERS = new Set([
  "actor", "repository_root", "executable", "cwd", "owner", "fence",
  "workspace_id", "path", "worktree_id", "database_path",
]);

/**
 * Validate and run one `libra_vcs_*` Agent call through the Host service, so the
 * model path and the panel path share validation and typed failures.
 */
export async function invokeVcsReadTool(
  service: LibraVcsReadService,
  session: unknown,
  toolName: string,
  input: Record<string, unknown>,
): Promise<VcsToolResult> {
  const definition = READ_TOOL_PARAMETERS[toolName];
  const operationId = typeof input["operation_id"] === "string" ? input["operation_id"] : `read-${Date.now()}`;
  const error = (kind: VcsHostFailureKind, message: string, retryable = false): VcsToolResult => ({
    schema_version: "1",
    operation_id: operationId,
    status: "error",
    error: { code: -32000, message, retryable, stable_code: kind },
  });
  if (definition === undefined) return error("invalid_params", `unknown VCS read tool ${toolName}`);
  for (const key of Object.keys(input)) {
    if (key === "operation_id") continue;
    if (FORBIDDEN_TOOL_PARAMETERS.has(key) || !definition.params.includes(key)) {
      return error("invalid_params", `unexpected tool parameter ${key}`);
    }
  }
  for (const required of definition.required) {
    if (!(required in input)) return error("invalid_params", `${toolName} requires parameter ${required}`);
  }
  const params: Record<string, unknown> = {};
  for (const key of definition.params) {
    if (input[key] !== undefined) params[key] = input[key];
  }
  try {
    const data = definition.method === "diff"
      ? await service.diff(session, params as never)
      : definition.method === "show"
        ? await service.show(session, params as never)
        : definition.method === "status"
          ? await service.status(session, params as never)
          : await service.log(session, params as never);
    return { schema_version: "1", operation_id: operationId, status: "ok", data };
  } catch (caught) {
    if (caught instanceof VcsHostError) return error(caught.kind, caught.message, caught.retryable);
    return error("internal", String(caught));
  }
}
