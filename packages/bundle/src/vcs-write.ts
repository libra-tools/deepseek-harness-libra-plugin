/**
 * Host-owned typed Libra VCS write surface (plan-20261118 LVC-07).
 *
 * One operation serves both entry points: the panel's user action and the
 * Agent tool adapter call the same methods, so parameters, fencing, results and
 * failures cannot drift. The Host resolves the Session to its repository
 * binding, the caller supplies a fence observed from `vcs.status`, and the
 * bridge revalidates that fence before it writes anything. Approval is a Host
 * argument, never a Client/model parameter: the tool path receives a DSH
 * approval decision, while the UI path attaches the fixed user-action approver.
 */
import {
  BridgeClientError,
  type BridgeClient,
  type CompletedRequest,
  type JsonRpcErrorObject,
} from "@libra/dsh-bridge-client";

import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionId } from "@deepseek-ai/dsh-session";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import type { BindingFailure } from "./repository-binding.js";
import { VcsHostError, type VcsHostFailureKind } from "./vcs-read.js";

/** What the Host hands the write service for one bound Session. */
export interface VcsWriteScope {
  client: BridgeClient;
  /** Methods this bridge negotiated, already filtered to `vcs.*`. */
  methods: readonly string[];
  bindingKey: string;
  generation: number;
  /** Revalidate Host directory, ownership key and generation after the write. */
  validate(): Promise<void>;
}

export type VcsWriteScopeResolution =
  | { ok: true; scope: VcsWriteScope }
  | { ok: false; failure: BindingFailure };

export type VcsWriteScopeResolver = (session: unknown) => Promise<VcsWriteScopeResolution | undefined>;

/** The caller's observation of repository state, from `vcs.status`. */
export interface VcsWriteFence {
  /** HEAD commit id, or `null` when the repository has no commit yet. */
  expectedHead: string | null;
  expectedIndex: string;
  expectedWorktree: string;
}

/** A fence plus the binding it belongs to; a panel must refresh after a rebind. */
export interface VcsFenceResult extends VcsWriteFence {
  bindingKey: string;
  bindingGeneration: number;
}

export type VcsWriteOutcome = "applied" | "replayed" | "stale_state" | "failed" | "indeterminate" | "denied";

export interface VcsWriteFailure {
  path: string;
  message: string;
}

export interface VcsWriteResult {
  operationId: string;
  outcome: VcsWriteOutcome;
  commitOid: string | null;
  paths: string[];
  failures: VcsWriteFailure[];
  bindingKey: string;
  bindingGeneration: number;
}

export interface VcsStageRequest {
  paths: readonly string[];
  operationId: string;
  /**
   * Binding the caller observed (panel fence or the Agent tool's approved
   * resolution). A rebind between observation and dispatch must refuse the write.
   */
  binding?: { key: string; generation: number };
  /**
   * Fence observed by the caller. The panel supplies the Host-issued fence; an
   * Agent tool call omits it and the Host reads the current fence itself, so a
   * model can neither forge nor base a write on stale state.
   */
  fence?: VcsWriteFence;
}

export interface VcsCommitRequest extends VcsStageRequest {
  message: string;
}

export interface VcsRecoverIntent {
  action: "stage" | "unstage" | "commit";
  paths: readonly string[];
  message?: string;
}

export interface VcsWriteApproval {
  decision: "approved" | "denied";
  approver?: string;
}

export interface VcsWriteOptions {
  signal?: AbortSignal;
  requestId?: string;
}

/** Approval this Host attaches to a user-driven panel action. */
export const USER_ACTION_APPROVAL: VcsWriteApproval = Object.freeze({
  decision: "approved",
  approver: "dsh-user-action",
});

const MAX_PATHS = 64;
const MAX_PATH_BYTES = 4096;
const MAX_MESSAGE_BYTES = 4096;
const MAX_OPERATION_ID = 128;
const MAX_APPROVER = 128;
const MAX_UNRESOLVED_WRITES = 256;
const COMMIT_MESSAGE_LIMIT = 4000;

type WriteMethod = "vcs.stage" | "vcs.unstage" | "vcs.commit";

const STABLE_CODE_KINDS: Record<string, VcsHostFailureKind> = {
  "LBR-AGENT-026": "unsupported_capability",
  "LBR-AGENT-027": "invalid_params",
  "LBR-AGENT-030": "unsupported_capability",
  "LBR-AGENT-031": "protocol_mismatch",
  "LBR-AGENT-032": "scope_mismatch",
  "LBR-AGENT-023": "scope_mismatch",
  "LBR-AGENT-033": "conflict",
  "LBR-AGENT-035": "denied",
  "LBR-AGENT-036": "timeout",
  "LBR-AGENT-037": "internal",
  "LBR-AGENT-038": "stale_state",
};

const OUTCOMES = new Set<VcsWriteOutcome>(["applied", "replayed", "stale_state", "failed", "indeterminate", "denied"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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

function failureKind(error: JsonRpcErrorObject): VcsHostFailureKind {
  const stable = error.data?.stable_code;
  if (stable !== undefined) {
    const known = STABLE_CODE_KINDS[stable];
    if (known !== undefined) return known;
  }
  const message = error.message.toLowerCase();
  if (message.includes("stale_state")) return "stale_state";
  if (message.includes("approval")) return "denied";
  if (message.includes("cursor")) return "invalid_params";
  return "internal";
}

function toHostError(error: unknown): VcsHostError {
  if (error instanceof VcsHostError) return error;
  if (error instanceof BridgeClientError) {
    switch (error.code) {
      case "request_cancelled":
        return new VcsHostError("cancelled", "the write was cancelled before dispatch");
      case "request_timeout":
        return new VcsHostError("timeout", "the bridge did not answer the write in time", true);
      case "protocol_violation":
        return new VcsHostError("protocol_mismatch", "the bridge rejected the write method as not negotiated");
      case "queue_full":
        return new VcsHostError("bridge_unavailable", "the bridge request queue is full", true);
      default:
        return new VcsHostError("disconnected", `the bridge request failed: ${error.message}`, true);
    }
  }
  return new VcsHostError("internal", String(error));
}

/** Reject anything that is not a plain repository-relative literal path. */
export function assertLiteralPath(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new VcsHostError("invalid_params", `${field} must be a non-empty repository-relative path`);
  }
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > MAX_PATH_BYTES) {
    throw new VcsHostError("invalid_params", `${field} exceeds ${MAX_PATH_BYTES} bytes`);
  }
  if (raw.includes("\u0000") || raw.includes("\\")) {
    throw new VcsHostError("invalid_params", `${field} contains an unsupported character`);
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new VcsHostError("invalid_params", `${field} must be repository-relative, not absolute`);
  }
  if (raw.startsWith(":") || raw.includes(":(")) {
    throw new VcsHostError("invalid_params", `${field} uses pathspec magic; the bridge accepts literal paths only`);
  }
  if (/[*?[\]]/.test(raw)) {
    throw new VcsHostError("invalid_params", `${field} uses glob syntax; the bridge accepts literal paths only`);
  }
  if (raw.endsWith("/") || raw.includes("//")) {
    throw new VcsHostError("invalid_params", `${field} must name a file, not a directory`);
  }
  if (raw.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    throw new VcsHostError("invalid_params", `${field} contains a traversal or empty segment`);
  }
  if (hasControlCharacter(raw)) {
    throw new VcsHostError("invalid_params", `${field} contains a control character`);
  }
  return raw;
}

/** Validate and deduplicate the authorized path set. */
export function validateWritePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new VcsHostError("invalid_params", "at least one repository-relative path is required");
  }
  if (paths.length > MAX_PATHS) {
    throw new VcsHostError("invalid_params", `at most ${MAX_PATHS} paths are allowed in one write`);
  }
  const unique: string[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = assertLiteralPath(paths[index], `paths[${index}]`);
    if (unique.includes(path)) {
      throw new VcsHostError("invalid_params", `paths[${index}] duplicates an earlier path`);
    }
    unique.push(path);
  }
  return unique;
}

export function assertOperationId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_OPERATION_ID) {
    throw new VcsHostError("invalid_params", `operationId must be a non-empty string of at most ${MAX_OPERATION_ID} characters`);
  }
  if (hasControlCharacter(raw)) {
    throw new VcsHostError("invalid_params", "operationId contains a control character");
  }
  return raw;
}

export function assertCommitMessage(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new VcsHostError("invalid_params", "message must be a string");
  }
  const message = raw.trim();
  if (message.length === 0) {
    throw new VcsHostError("invalid_params", "the commit message must not be empty");
  }
  if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
    throw new VcsHostError("invalid_params", `the commit message exceeds ${MAX_MESSAGE_BYTES} UTF-8 bytes`);
  }
  if (message.includes("\u0000")) {
    throw new VcsHostError("invalid_params", "the commit message contains an unsupported character");
  }
  return message.length > COMMIT_MESSAGE_LIMIT ? message.slice(0, COMMIT_MESSAGE_LIMIT) : message;
}

function assertHead(raw: unknown): string | null {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(raw)) {
    throw new VcsHostError("invalid_params", "expectedHead must be null or a SHA-1/SHA-256 commit id");
  }
  return raw;
}

function assertGeneration(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128 || !/^[0-9a-f]+$/i.test(raw)) {
    throw new VcsHostError("invalid_params", `${field} must be a non-empty hexadecimal digest`);
  }
  return raw;
}

/** Normalize a fence from either a caller request or a `vcs.status` result. */
export function normalizeFence(input: unknown): VcsWriteFence {
  if (!isRecord(input)) throw new VcsHostError("invalid_params", "a write fence is required");
  return {
    expectedHead: assertHead(input.expectedHead ?? input.head ?? null),
    expectedIndex: assertGeneration(input.expectedIndex ?? input.indexGeneration, "expectedIndex"),
    expectedWorktree: assertGeneration(input.expectedWorktree ?? input.worktreeGeneration, "expectedWorktree"),
  };
}

function assertApproval(approval: VcsWriteApproval | undefined): string {
  if (approval === undefined || approval.decision !== "approved") {
    throw new VcsHostError("denied", "the write was not approved by the user");
  }
  if (approval.approver !== undefined
    && (typeof approval.approver !== "string" || approval.approver.length === 0 || approval.approver.length > MAX_APPROVER)) {
    throw new VcsHostError("invalid_params", `approver must be a non-empty string of at most ${MAX_APPROVER} characters`);
  }
  return approval.approver ?? "dsh-user-action";
}

function indeterminateWrite(method: WriteMethod, paths: readonly string[], nextStep?: string): VcsHostError {
  const action = method.slice("vcs.".length);
  return new VcsHostError(
    "indeterminate",
    `the ${action} write for ${JSON.stringify(paths)} may already have been applied; reconcile repository state, then call libra_vcs_recover with the same action and paths${nextStep === undefined ? "" : `; ${nextStep}`}`,
    false,
  );
}

function projectFence(data: Record<string, unknown>): VcsFenceResult {
  if (!isRecord(data.writeFence)) {
    throw new VcsHostError("stale_state", "the repository state changed while it was read; refresh and retry", true);
  }
  return {
    ...normalizeFence(data.writeFence),
    bindingKey: typeof data.bindingKey === "string" ? data.bindingKey : "",
    bindingGeneration: typeof data.bindingGeneration === "number" ? data.bindingGeneration : 0,
  };
}

function projectWriteResult(
  data: Record<string, unknown>,
  request: VcsStageRequest,
  method: WriteMethod,
): Omit<VcsWriteResult, "bindingKey" | "bindingGeneration"> {
  const operationId = data.operationId;
  if (typeof operationId !== "string" || operationId !== request.operationId) {
    throw new VcsHostError("internal", "the bridge reported a different operation id");
  }
  const outcome = data.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome as VcsWriteOutcome)) {
    throw new VcsHostError("internal", "the bridge reported an unknown write outcome");
  }
  const paths = Array.isArray(data.paths) ? data.paths : [];
  const projectedPaths: string[] = [];
  for (const [index, path] of paths.entries()) {
    const value = assertLiteralPath(path, `paths[${index}]`);
    if (!request.paths.includes(value)) {
      throw new VcsHostError("internal", "the bridge applied a path that was not authorized");
    }
    projectedPaths.push(value);
  }
  let commitOid: string | null = null;
  if (data.commitOid !== null && data.commitOid !== undefined) {
    if (typeof data.commitOid !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(data.commitOid)) {
      throw new VcsHostError("internal", "the bridge reported an invalid commit id");
    }
    commitOid = data.commitOid;
  }
  if (method === "vcs.commit" && outcome === "applied" && commitOid === null) {
    throw new VcsHostError("internal", "an applied commit reported no commit id");
  }
  const failures: VcsWriteFailure[] = [];
  if (Array.isArray(data.failures)) {
    for (const entry of data.failures) {
      if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.message !== "string") {
        throw new VcsHostError("internal", "the bridge reported a malformed write failure");
      }
      failures.push({ path: assertLiteralPath(entry.path, "failures.path"), message: entry.message });
    }
  }
  return {
    operationId,
    outcome: outcome as VcsWriteOutcome,
    commitOid,
    paths: projectedPaths,
    failures,
  };
}

/**
 * Host write service shared by the panel Remote and the Agent tool adapter.
 * The model never supplies a repository, an approval decision or a raw fence
 * shape; it supplies a Session-scoped action and literal paths.
 */
export class LibraVcsWriteService {
  private readonly unresolvedWrites = new Map<string, {
    method: WriteMethod;
    request: VcsStageRequest | VcsCommitRequest;
    params: Record<string, unknown>;
  }>();
  private readonly activeWrites = new Set<string>();

  constructor(private readonly resolve: VcsWriteScopeResolver) {}

  /**
   * Replay the exact request of an indeterminate write after the caller has
   * reconciled state. The caller repeats the same action, path set and message;
   * the Host supplies the stored operation id, binding and fence, so a new
   * operation cannot be started under the guise of recovery.
   */
  async recover(
    session: unknown,
    intent: VcsRecoverIntent,
    approval: VcsWriteApproval | undefined,
    options: VcsWriteOptions = {},
    expectedBinding?: { key: string; generation: number },
  ): Promise<VcsWriteResult> {
    assertApproval(approval);
    const method = (`vcs.${intent.action}`) as WriteMethod;
    const scope = await this.scope(session, options);
    if (expectedBinding !== undefined
      && (expectedBinding.key !== scope.bindingKey || expectedBinding.generation !== scope.generation)) {
      throw new VcsHostError("cwd_changed", "the repository binding changed; recovery belongs to the previous binding", true);
    }
    const sessionId = String((session as { id: unknown }).id);
    const key = this.recoverKey(sessionId, scope.bindingKey);
    const release = this.enterWrite(key);
    try {
    const entry = this.unresolvedWrites.get(key);
    if (entry === undefined || entry.method !== method) {
      throw new VcsHostError("invalid_params", `no unresolved ${intent.action} write for this repository binding`);
    }
    const paths = validateWritePaths(intent.paths);
    if (paths.length !== entry.request.paths.length
      || [...paths].sort().join("\u0000") !== [...entry.request.paths].sort().join("\u0000")) {
      throw new VcsHostError("invalid_params", "the recovery path set does not match the unresolved operation");
    }
    if (intent.action === "commit" && assertCommitMessage(intent.message) !== entry.params.message) {
      throw new VcsHostError("invalid_params", "the recovery message does not match the unresolved operation");
    }
    this.requireMethod(scope, method);
    try {
      await scope.validate();
      // Reuse the original bridge payload byte-for-byte, including operation
      // id, fence, and bridge approval. This is an idempotent result lookup.
      let data = await this.requestWrite(scope, method, entry.params, options);
      let result: Omit<VcsWriteResult, "bindingKey" | "bindingGeneration">;
      try {
        result = projectWriteResult(data, entry.request, method);
        await scope.validate();
      } catch {
        try {
          await scope.validate();
          data = await this.request(scope, method, entry.params, options, true);
          result = projectWriteResult(data, entry.request, method);
          await scope.validate();
        } catch {
          throw indeterminateWrite(method, entry.request.paths);
        }
      }
      if (result.outcome === "indeterminate") {
        throw indeterminateWrite(method, entry.request.paths);
      }
      this.unresolvedWrites.delete(key);
      return { ...result, bindingKey: scope.bindingKey, bindingGeneration: scope.generation };
    } catch (error) {
      // Only a definitive refusal proves the original operation did not apply;
      // every transport, projection or binding failure keeps the record for a
      // later exact-payload recovery in its original repository.
      if (error instanceof VcsHostError) {
        if (error.kind === "denied" || error.kind === "stale_state" || error.kind === "invalid_params"
          || error.kind === "unsupported_capability" || error.kind === "conflict") {
          this.unresolvedWrites.delete(key);
          throw error;
        }
        if (error.kind === "internal" || error.kind === "timeout" || error.kind === "disconnected") {
          throw indeterminateWrite(method, entry.request.paths);
        }
      }
      throw error;
    }
    } finally {
      release();
    }
  }

  private isSameUnresolvedOperation(
    unresolved: { method: WriteMethod; request: VcsStageRequest | VcsCommitRequest; params: Record<string, unknown> },
    method: WriteMethod,
    request: VcsStageRequest | VcsCommitRequest,
    paths: string[],
    operationId: string,
    message: string | undefined,
    scope: VcsWriteScope,
  ): boolean {
    if (unresolved.method !== method || unresolved.request.operationId !== operationId
      || request.binding?.key !== scope.bindingKey || request.binding.generation !== scope.generation) return false;
    if (paths.length !== unresolved.request.paths.length
      || [...paths].sort().join("\u0000") !== [...unresolved.request.paths].sort().join("\u0000")) return false;
    if (message !== unresolved.params.message) return false;
    if (request.fence !== undefined) {
      const fence = normalizeFence(request.fence);
      if (fence.expectedHead !== unresolved.params.expectedHead
        || fence.expectedIndex !== unresolved.params.expectedIndex
        || fence.expectedWorktree !== unresolved.params.expectedWorktree) return false;
    } else if (unresolved.request.fence !== undefined) {
      return false;
    }
    return true;
  }

  private enterWrite(key: string): () => void {
    if (this.activeWrites.has(key)) {
      throw new VcsHostError("conflict", "another VCS write is already in progress for this Session and repository; retry after it completes");
    }
    this.activeWrites.add(key);
    return () => { this.activeWrites.delete(key); };
  }

  private recoverKey(sessionId: string, bindingKey: string): string {
    return `${sessionId}\u0000${bindingKey}`;
  }

  /** Read the current fence through `vcs.status`, refusing an unfenceable state. */
  async fence(session: unknown, options: VcsWriteOptions = {}): Promise<VcsFenceResult> {
    const scope = await this.scope(session, options);
    return this.readFence(scope, options);
  }

  stage(
    session: unknown,
    request: VcsStageRequest,
    approval: VcsWriteApproval | undefined,
    options: VcsWriteOptions = {},
  ): Promise<VcsWriteResult> {
    return this.write(session, "vcs.stage", request, approval, options);
  }

  unstage(
    session: unknown,
    request: VcsStageRequest,
    approval: VcsWriteApproval | undefined,
    options: VcsWriteOptions = {},
  ): Promise<VcsWriteResult> {
    return this.write(session, "vcs.unstage", request, approval, options);
  }

  commit(
    session: unknown,
    request: VcsCommitRequest,
    approval: VcsWriteApproval | undefined,
    options: VcsWriteOptions = {},
  ): Promise<VcsWriteResult> {
    return this.write(session, "vcs.commit", request, approval, options);
  }

  private async scope(session: unknown, options: VcsWriteOptions): Promise<VcsWriteScope> {
    if (isCancelled(options.signal)) throw new VcsHostError("cancelled", "the write was cancelled");
    if (options.requestId !== undefined
      && (typeof options.requestId !== "string" || options.requestId.length === 0 || options.requestId.length > 128)) {
      throw new VcsHostError("invalid_params", "requestId must be a non-empty string of at most 128 characters");
    }
    if (typeof session !== "object" || session === null || !("id" in session)) {
      throw new VcsHostError("no_working_directory", "a Session is required");
    }
    const resolution = await this.resolve(session);
    if (isCancelled(options.signal)) throw new VcsHostError("cancelled", "the write was cancelled");
    if (resolution === undefined) {
      throw new VcsHostError("no_working_directory", "this Session is not bound to a repository yet");
    }
    if (!resolution.ok) throw failureToHostError(resolution.failure);
    await resolution.scope.validate();
    return resolution.scope;
  }

  private async readFence(scope: VcsWriteScope, options: VcsWriteOptions): Promise<VcsFenceResult> {
    this.requireMethod(scope, "vcs.status");
    const data = await this.request(scope, "vcs.status", {}, options);
    const fence = projectFence(data);
    await scope.validate();
    return { ...fence, bindingKey: scope.bindingKey, bindingGeneration: scope.generation };
  }

  private async write(
    session: unknown,
    method: WriteMethod,
    request: VcsStageRequest | VcsCommitRequest,
    approval: VcsWriteApproval | undefined,
    options: VcsWriteOptions,
  ): Promise<VcsWriteResult> {
    const approver = assertApproval(approval);
    const paths = validateWritePaths(request.paths);
    const operationId = assertOperationId(request.operationId);
    let message: string | undefined;
    if (method === "vcs.commit") {
      message = assertCommitMessage((request as VcsCommitRequest).message);
    }
    if (typeof session !== "object" || session === null || !("id" in session)) {
      throw new VcsHostError("no_working_directory", "a Session is required");
    }
    // The bridge binds the mutation to the trusted session scope, so the Host
    // supplies the Session id; a model or Client payload never names it.
    const sessionId = String((session as { id: unknown }).id);
    const scope = await this.scope(session, options);
    this.requireMethod(scope, method);
    const unresolvedKey = this.recoverKey(sessionId, scope.bindingKey);
    const unresolved = this.unresolvedWrites.get(unresolvedKey);
    if (unresolved !== undefined) {
      if (this.isSameUnresolvedOperation(unresolved, method, request, paths, operationId, message, scope)) {
        return this.recover(session, {
          action: method.slice("vcs.".length) as VcsRecoverIntent["action"],
          paths,
          ...(message === undefined ? {} : { message }),
        }, approval, options, { key: scope.bindingKey, generation: scope.generation });
      }
      const action = unresolved.method.slice("vcs.".length);
      throw new VcsHostError(
        "conflict",
        `an unresolved ${action} write for ${JSON.stringify(unresolved.request.paths)} may already have been applied; reconcile state and call libra_vcs_recover with the same action and paths before starting another write`,
        false,
      );
    }
    const release = this.enterWrite(unresolvedKey);
    try {
    // Another write may have completed with an uncertain outcome just before
    // this one acquired the per-repository lock.
    const racedUnresolved = this.unresolvedWrites.get(unresolvedKey);
    if (racedUnresolved !== undefined) {
      throw new VcsHostError("conflict", "an unresolved VCS write must be recovered before starting another write", false);
    }
    if (this.unresolvedWrites.size >= MAX_UNRESOLVED_WRITES) {
      throw new VcsHostError(
        "conflict",
        `the Host has reached its ${MAX_UNRESOLVED_WRITES}-operation unresolved-write limit; recover an earlier operation before starting another write`,
        false,
      );
    }
    if (isCancelled(options.signal)) throw new VcsHostError("cancelled", "the write was cancelled before dispatch");
    if (request.binding !== undefined
      && (request.binding.key !== scope.bindingKey || request.binding.generation !== scope.generation)) {
      throw new VcsHostError("cwd_changed", "the repository binding changed; refresh and retry", true);
    }
    // The panel passes its Host-issued fence; the Agent path has none and the
    // Host reads the current fence now instead of trusting model input.
    const fence = request.fence === undefined
      ? await this.readFence(scope, options)
      : normalizeFence(request.fence);

    const params: Record<string, unknown> = {
      session_id: sessionId,
      operation_id: operationId,
      paths,
      expectedHead: fence.expectedHead,
      expectedIndex: fence.expectedIndex,
      expectedWorktree: fence.expectedWorktree,
      approval: { decision: "approved", approver },
      ...(message === undefined ? {} : { message }),
    };
    let data: Record<string, unknown>;
    try {
      data = await this.requestWrite(scope, method, params, options);
    } catch (error) {
      if (error instanceof VcsHostError && error.kind === "indeterminate") {
        this.unresolvedWrites.set(unresolvedKey, {
          method,
          request: { ...request, paths },
          params,
        });
      }
      throw error;
    }
    let result: Omit<VcsWriteResult, "bindingKey" | "bindingGeneration">;
    try {
      result = projectWriteResult(data, { ...request, paths }, method);
      await scope.validate();
    } catch (error) {
      // The mutation has already been dispatched and may have applied; a
      // projection or post-write validation failure must not be reported as if
      // nothing happened. Never replay into a different binding.
      if (error instanceof VcsHostError && error.kind === "cwd_changed") {
        this.unresolvedWrites.set(unresolvedKey, {
          method,
          request: { ...request, paths },
          params,
        });
        throw indeterminateWrite(method, paths);
      }
      try {
        await scope.validate();
        const replay = await this.request(scope, method, params, options, true);
        result = projectWriteResult(replay, { ...request, paths }, method);
        await scope.validate();
      } catch {
        this.unresolvedWrites.set(unresolvedKey, {
          method,
          request: { ...request, paths },
          params,
        });
        throw indeterminateWrite(method, paths);
      }
    }
    if (result.outcome === "indeterminate") {
      this.unresolvedWrites.set(unresolvedKey, {
        method,
        request: { ...request, paths },
        params,
      });
    } else {
      this.unresolvedWrites.delete(unresolvedKey);
    }
    return { ...result, bindingKey: scope.bindingKey, bindingGeneration: scope.generation };
    } finally {
      release();
    }
  }

  /**
   * A mutation may publish its effect and then fail to record the result, or a
   * transport may lose the answer after dispatch. The bridge's idempotency
   * contract makes one replay of the same operation id safe and reports the
   * recorded outcome instead of writing again, so internal, timeout and
   * disconnected failures are replayed once. Refusals (stale, denied,
   * unsupported, conflict, invalid parameters) are terminal and never replayed.
   */
  private async requestWrite(
    scope: VcsWriteScope,
    method: WriteMethod,
    params: Record<string, unknown>,
    options: VcsWriteOptions,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.request(scope, method, params, options, true);
    } catch (error) {
      if (error instanceof VcsHostError
        && (error.kind === "internal" || error.kind === "timeout" || error.kind === "disconnected")) {
        try {
          // A replay must not start in a repository the Session already left.
          await scope.validate();
          return await this.request(scope, method, params, options, true);
        } catch {
          throw indeterminateWrite(method, Array.isArray(params.paths) ? params.paths as string[] : []);
        }
      }
      throw error;
    }
  }

  private requireMethod(scope: VcsWriteScope, method: string): void {
    if (!scope.methods.includes(method)) {
      throw new VcsHostError("unsupported_capability", `the bridge does not advertise ${method}`);
    }
  }

  private async request(
    scope: VcsWriteScope,
    method: string,
    params: Record<string, unknown>,
    options: VcsWriteOptions,
    mutation = false,
  ): Promise<Record<string, unknown>> {
    if (isCancelled(options.signal)) throw new VcsHostError("cancelled", "the operation was cancelled before dispatch");
    let response: CompletedRequest;
    try {
      response = await scope.client.requestMethod(method, params, options.signal);
    } catch (error) {
      if (isCancelled(options.signal)) {
        // A cancelled caller may already have dispatched the mutation.
        throw mutation
          ? indeterminateWrite(method as WriteMethod, Array.isArray(params.paths) ? params.paths as string[] : [])
          : new VcsHostError("cancelled", "the read was cancelled");
      }
      if (mutation && error instanceof BridgeClientError && error.code === "protocol_violation") {
        // The mutation frame was sent; an unexpected response id/frame means
        // the connection failed before the answer could be attributed.
        throw indeterminateWrite(method as WriteMethod, Array.isArray(params.paths) ? params.paths as string[] : []);
      }
      throw toHostError(error);
    }
    if (isCancelled(options.signal)) {
      if (!mutation) throw new VcsHostError("cancelled", "the read was cancelled");
      if (response.state !== "success") throw indeterminateWrite(method as WriteMethod, Array.isArray(params.paths) ? params.paths as string[] : []);
    }
    if (response.state !== "success") {
      const failure = response.error;
      throw new VcsHostError(
        failure === undefined ? "internal" : failureKind(failure),
        failure?.message ?? "the bridge returned no result",
        failure?.data?.retryable === true,
      );
    }
    const data = isRecord(response.result) && isRecord(response.result["data"])
      ? response.result["data"] as Record<string, unknown>
      : response.result;
    if (!isRecord(data)) throw new VcsHostError("internal", "the bridge returned a non-object result");
    return data;
  }
}

/** One Agent tool result in the shared ToolResult shape. */
export interface VcsWriteToolResult {
  schema_version: string;
  operation_id: string;
  status: "ok" | "error";
  data?: VcsWriteResult;
  error?: {
    code: number;
    message: string;
    retryable: boolean;
    stable_code?: string;
  };
}

const WRITE_TOOL_PARAMETERS: Record<string, { action: "stage" | "unstage" | "commit" | "recover"; params: string[]; required: string[] }> = {
  libra_vcs_recover: {
    action: "recover",
    params: ["action", "paths", "message", "approval"],
    required: ["action", "paths"],
  },
  libra_vcs_stage: {
    action: "stage",
    params: ["paths", "operation_id", "approval"],
    required: ["paths", "operation_id"],
  },
  libra_vcs_unstage: {
    action: "unstage",
    params: ["paths", "operation_id", "approval"],
    required: ["paths", "operation_id"],
  },
  libra_vcs_commit: {
    action: "commit",
    params: ["paths", "message", "operation_id", "approval"],
    required: ["paths", "message", "operation_id"],
  },
};

const FORBIDDEN_WRITE_TOOL_PARAMETERS = new Set([
  "actor", "repository_root", "executable", "cwd", "owner", "fence", "session_id",
  "workspace_id", "path", "worktree_id", "database_path", "expectedHead",
  "expectedIndex", "expectedWorktree", "operationId", "expected_head",
  "expected_index", "expected_worktree", "fence",
]);

function toolApproval(raw: unknown): VcsWriteApproval | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return undefined;
  const decision = raw.decision;
  if (decision !== "approved" && decision !== "denied") return undefined;
  const approver = raw.approver;
  return {
    decision,
    ...(typeof approver === "string" ? { approver } : {}),
  };
}

/**
 * Validate and run one `libra_vcs_*` write Agent call through the Host service.
 * The DSH approval gate has already produced `approval`; this adapter only
 * translates snake_case tool parameters to the shared service contract.
 */
export async function invokeVcsWriteTool(
  service: LibraVcsWriteService,
  session: unknown,
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  expectedBinding?: { key: string; generation: number },
): Promise<VcsWriteToolResult> {
  const definition = WRITE_TOOL_PARAMETERS[toolName];
  const operationId = typeof input["operation_id"] === "string" ? input["operation_id"] : "";
  const error = (kind: VcsHostFailureKind, message: string, retryable = false): VcsWriteToolResult => ({
    schema_version: "1",
    operation_id: operationId,
    status: "error",
    error: { code: -32000, message, retryable, stable_code: kind },
  });
  if (definition === undefined) return error("invalid_params", `unknown VCS write tool ${toolName}`);
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_WRITE_TOOL_PARAMETERS.has(key)) {
      return error("invalid_params", `unexpected tool parameter ${key}`);
    }
    if (!definition.params.includes(key)) {
      return error("invalid_params", `unexpected tool parameter ${key}`);
    }
    if (key === "approval" && value !== undefined && !isRecord(value)) {
      return error("invalid_params", "approval must be an object { decision, approver? }");
    }
  }
  for (const required of definition.required) {
    if (input[required] === undefined) return error("invalid_params", `${toolName} requires parameter ${required}`);
  }
  if (definition.action === "recover") {
    const action = input["action"];
    if (action !== "stage" && action !== "unstage" && action !== "commit") {
      return error("invalid_params", "recover action must be stage, unstage or commit");
    }
    if (action === "commit" && input["message"] === undefined) {
      return error("invalid_params", "recover commit requires the original message");
    }
  }
  const approval = toolApproval(input["approval"]);
  if (approval === undefined) return error("denied", "the write has no DSH approval decision");
  // No fence: the Host reads the current one, so a model cannot supply or
  // forge repository state.
  const options = signal === undefined ? {} : { signal };
  try {
    const data = definition.action === "recover"
      ? await service.recover(session, {
        action: input["action"] as never,
        paths: input["paths"] as never,
        ...(input["message"] === undefined ? {} : { message: input["message"] as string }),
      }, approval, options, expectedBinding)
      : await (() => {
        const request: VcsStageRequest = {
          paths: input["paths"] as never,
          operationId,
          ...(expectedBinding === undefined ? {} : { binding: expectedBinding }),
        };
        return definition.action === "commit"
          ? service.commit(session, { ...request, message: input["message"] as never }, approval, options)
          : definition.action === "stage"
            ? service.stage(session, request, approval, options)
            : service.unstage(session, request, approval, options);
      })();
    const resultOperationId = typeof data.operationId === "string" ? data.operationId : operationId;
    if (data.outcome === "applied" || data.outcome === "replayed") {
      return { schema_version: "1", operation_id: resultOperationId, status: "ok", data };
    }
    // The panel distinguishes these outcomes; an Agent call must not present a
    // refusal as success. Keep the recovery details on the error for the caller.
    const refusal = data.outcome === "denied"
      ? { kind: "denied" as const, retryable: false, message: "the write was refused by the approval decision" }
      : data.outcome === "stale_state"
        ? { kind: "stale_state" as const, retryable: true, message: "the repository state changed before the write; refresh and retry" }
        : data.outcome === "indeterminate"
          ? {
            kind: "indeterminate" as const,
            retryable: false,
            message: `the write may already have been applied; reconcile state, then call libra_vcs_recover with action=${definition.action === "recover" ? String(input["action"]) : definition.action} and the same paths ${JSON.stringify(data.paths)}${input["message"] === undefined ? "" : ` and message ${JSON.stringify(input["message"])}`}`,
          }
          : { kind: "internal" as const, retryable: false, message: `the write outcome was ${data.outcome}` };
    return {
      schema_version: "1",
      operation_id: resultOperationId,
      status: "error",
      data,
      error: { code: -32000, message: reflectionMessage(data, refusal.message), retryable: refusal.retryable, stable_code: refusal.kind },
    };
  } catch (caught) {
    if (caught instanceof VcsHostError) return error(caught.kind, caught.message, caught.retryable);
    return error("internal", String(caught));
  }
}

/** Client-facing result envelope for one panel write. */
export type VcsWriteRemoteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { kind: VcsHostFailureKind; message: string; retryable: boolean } };

/** Panel request: literal paths plus the fence observed from `fence()`. */
export interface VcsRemoteStageParams extends VcsWriteFence {
  paths: readonly string[];
  operationId: string;
  /** Binding identity carried with the Host-issued fence. */
  bindingKey: string;
  bindingGeneration: number;
}

export interface VcsRemoteCommitParams extends VcsRemoteStageParams {
  message: string;
}

export type SessionById = (sessionId: SessionId) => Session | undefined;

/**
 * The panel's Client-facing Remote namespace `libraVcsWrite`.
 *
 * The Client sends only a Session id, paths and a caller-generated operation
 * id; the Host attaches the user-action approval. A model cannot call a Remote
 * method, and the Agent path reaches the same service only after DSH approval.
 */
export class LibraVcsWriteRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly service: LibraVcsWriteService,
    private readonly lookup: SessionById,
  ) {
    super(ctx, "libraVcsWrite");
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async fence(sessionId: SessionId): Promise<VcsWriteRemoteResult<VcsFenceResult>> {
    try {
      const data = await this.service.fence(this.session(sessionId));
      return { ok: true, data };
    } catch (caught) {
      return this.failure(caught);
    }
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async stage(
    sessionId: SessionId,
    params: VcsRemoteStageParams,
    signal?: AbortSignal,
  ): Promise<VcsWriteRemoteResult<VcsWriteResult>> {
    return this.run(sessionId, params, signal, (session, request, options) =>
      this.service.stage(session, request, USER_ACTION_APPROVAL, options));
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async unstage(
    sessionId: SessionId,
    params: VcsRemoteStageParams,
    signal?: AbortSignal,
  ): Promise<VcsWriteRemoteResult<VcsWriteResult>> {
    return this.run(sessionId, params, signal, (session, request, options) =>
      this.service.unstage(session, request, USER_ACTION_APPROVAL, options));
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async commit(
    sessionId: SessionId,
    params: VcsRemoteCommitParams,
    signal?: AbortSignal,
  ): Promise<VcsWriteRemoteResult<VcsWriteResult>> {
    return this.run(sessionId, params, signal, (session, request, options) =>
      this.service.commit(session, { ...request, message: params.message }, USER_ACTION_APPROVAL, options));
  }

  private async run(
    sessionId: SessionId,
    params: VcsRemoteStageParams,
    signal: AbortSignal | undefined,
    call: (session: Session, request: VcsStageRequest, options: VcsWriteOptions) => Promise<VcsWriteResult>,
  ): Promise<VcsWriteRemoteResult<VcsWriteResult>> {
    try {
      const session = this.session(sessionId);
      const request: VcsStageRequest = {
        paths: params.paths,
        operationId: params.operationId,
        binding: { key: params.bindingKey, generation: params.bindingGeneration },
        fence: {
          expectedHead: params.expectedHead,
          expectedIndex: params.expectedIndex,
          expectedWorktree: params.expectedWorktree,
        },
      };
      const options = signal === undefined ? {} : { signal };
      return { ok: true, data: await call(session, request, options) };
    } catch (caught) {
      return this.failure(caught);
    }
  }

  private session(sessionId: SessionId): Session {
    const session = this.lookup(sessionId);
    if (session === undefined) {
      throw new VcsHostError("no_working_directory", "the requested Session is not live on this Host");
    }
    return session;
  }

  private failure(error: unknown): { ok: false; error: { kind: VcsHostFailureKind; message: string; retryable: boolean } } {
    if (error instanceof VcsHostError) {
      return { ok: false, error: { kind: error.kind, message: error.message, retryable: error.retryable } };
    }
    return { ok: false, error: { kind: "internal", message: String(error), retryable: false } };
  }
}

function reflectionMessage(data: VcsWriteResult, base: string): string {
  const details = data.commitOid === null ? "" : ` commit=${data.commitOid}`;
  return `${base}${details}`;
}
