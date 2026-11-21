/**
 * Typed, bounded Libra VCS read methods (plan-20261118 LVC-04).
 *
 * These wrappers cover the additive `vcs.*` read methods frozen by LVC-02.
 * They validate cursors and page limits before a request leaves the plugin,
 * reject methods that were not negotiated, and keep the bridge's own error
 * classes distinct so a caller can tell an unsupported method from a stale
 * cursor or a scope mismatch. Responses are projected onto the documented
 * shapes instead of being passed through untyped.
 */
import { BridgeClientError, type BridgeClient } from "./client.js";
import type { CompletedRequest, JsonRpcErrorObject } from "./types.js";

export const VCS_READ_METHODS = ["vcs.status", "vcs.diff", "vcs.log", "vcs.show"] as const;
export type VcsReadMethod = (typeof VCS_READ_METHODS)[number];

/** Cursor offsets above this bound are refused by Libra before enumeration. */
export const MAX_CURSOR_OFFSET = 100_000;
/** Libra's page cap for one response. */
export const MAX_PAGE = 100;

export type VcsReadFailureKind =
  | "unsupported_capability"
  | "disconnected"
  | "invalid_params"
  | "cursor_invalid"
  | "scope_mismatch"
  | "cancelled"
  | "stale_state"
  | "conflict"
  | "protocol_mismatch"
  | "denied"
  | "timeout"
  | "internal";

export class VcsReadError extends Error {
  readonly kind: VcsReadFailureKind;
  readonly stableCode: string | undefined;
  readonly retryable: boolean;

  constructor(kind: VcsReadFailureKind, message: string, options: { stableCode?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = "VcsReadError";
    this.kind = kind;
    this.stableCode = options.stableCode;
    this.retryable = options.retryable === true;
  }
}

export interface VcsCursor {
  next: string | null;
}

export interface VcsStatusParams {
  cursor?: string | null;
  limit?: number;
}

export type VcsStatusState = "staged" | "unstaged" | "untracked" | "rename" | "conflict";
export type VcsCommitFileState = "staged" | "rename";

export interface VcsStatusEntry {
  path: string;
  state: VcsStatusState;
  oldPath: string | null;
}

export interface VcsStatusResult {
  entries: VcsStatusEntry[];
  cursor: VcsCursor;
  /** Binding identity the Host read this page under, when attached by the Host. */
  bindingKey?: string;
  bindingGeneration?: number;
}

export type VcsDiffSides = "worktree-vs-index" | "index-vs-head" | "worktree-vs-oid";

export interface VcsDiffParams {
  sides: VcsDiffSides;
  oid?: string;
  paths?: readonly string[];
  limit?: number;
}

export type VcsDiffTruncation = "none" | "binary" | "byte_cap" | "page_cap";

export interface VcsDiffFile {
  path: string;
  oldPath: string | null;
  /** Unified patch, or `null` when binary or over budget. */
  patch: string | null;
  truncated: boolean;
  truncation: VcsDiffTruncation;
}

export interface VcsDiffResult {
  sides: VcsDiffSides;
  byteCap: number;
  truncated: boolean;
  truncation: VcsDiffTruncation;
  files: VcsDiffFile[];
  bindingKey?: string;
  bindingGeneration?: number;
}

export interface VcsLogParams {
  cursor?: string | null;
  limit?: number;
}

export interface VcsCommitSummary {
  oid: string;
  summary: string;
  authorTime: number;
}

export interface VcsLogResult {
  commits: VcsCommitSummary[];
  cursor: VcsCursor;
  bindingKey?: string;
  bindingGeneration?: number;
}

export interface VcsShowParams {
  oid: string;
  cursor?: string | null;
  limit?: number;
}

export interface VcsShowFile {
  path: string;
  state: VcsCommitFileState;
  oldPath: string | null;
}

export interface VcsShowResult {
  oid: string;
  summary: string;
  parents: string[];
  files: VcsShowFile[];
  cursor: VcsCursor;
  bindingKey?: string;
  bindingGeneration?: number;
}

const DIFF_SIDES: readonly VcsDiffSides[] = ["worktree-vs-index", "index-vs-head", "worktree-vs-oid"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCursor(cursor: string | null | undefined): string | null {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string") {
    throw new VcsReadError("cursor_invalid", "cursor must be an opaque decimal string or null");
  }
  if (!/^\d+$/.test(cursor)) {
    throw new VcsReadError("cursor_invalid", "cursor must be an opaque decimal offset");
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset > MAX_CURSOR_OFFSET) {
    throw new VcsReadError("cursor_invalid", `cursor exceeds the ${MAX_CURSOR_OFFSET}-entry offset cap`);
  }
  return cursor;
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new VcsReadError("invalid_params", `limit must be an integer between 1 and ${MAX_PAGE}`);
  }
  return limit;
}

function validateOid(oid: string | undefined): string {
  if (typeof oid !== "string" || oid.length === 0) {
    throw new VcsReadError("invalid_params", "oid is required");
  }
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(oid)) {
    throw new VcsReadError("invalid_params", "oid must be one SHA-1 or SHA-256 object id");
  }
  return oid;
}

function pathsOf(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new VcsReadError("invalid_params", "paths must be a list of at most 64 repository-relative strings");
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry, "utf8") > 4096
      || entry.includes("\0") || entry.startsWith(":") || entry.startsWith("/")
      || entry.startsWith("\\") || entry.includes(":") || entry.includes("\\")
      || ["*", "?", "[", "]"].some((syntax) => entry.includes(syntax))
      || entry.split("/").some((part) => part === ".." || part === "~")) {
      throw new VcsReadError("invalid_params", "paths must be literal repository-relative paths without pathspec syntax");
    }
    const normalized = entry.split("/").filter((part) => part.length > 0 && part !== ".").join("/");
    if (normalized.length === 0) throw new VcsReadError("invalid_params", "each path must name an entry inside the repository");
    paths.push(normalized);
  }
  return paths;
}

function malformed(method: VcsReadMethod, field: string): never {
  throw new VcsReadError("internal", `the bridge returned malformed ${method} data (${field})`);
}

function stringField(payload: Record<string, unknown>, key: string, method: VcsReadMethod): string {
  const value = payload[key];
  return typeof value === "string" ? value : malformed(method, key);
}

function nullableStringField(payload: Record<string, unknown>, key: string, method: VcsReadMethod): string | null {
  const value = payload[key];
  return value === null || typeof value === "string" ? value : malformed(method, key);
}

function repositoryPath(value: string, method: VcsReadMethod, field: string): string {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 4096
    || value.startsWith(":") || value.startsWith("/")
    || value.includes("\0") || value.includes(":") || value.includes("\\")
    || value.split("/").some((part) => part === ".." || part === "~")) {
    return malformed(method, field);
  }
  const normalized = value.split("/").filter((part) => part.length > 0 && part !== ".").join("/");
  return normalized.length > 0 ? normalized : malformed(method, field);
}

function pathField(payload: Record<string, unknown>, key: string, method: VcsReadMethod): string {
  return repositoryPath(stringField(payload, key, method), method, key);
}

function nullablePathField(payload: Record<string, unknown>, key: string, method: VcsReadMethod): string | null {
  const value = nullableStringField(payload, key, method);
  return value === null ? null : repositoryPath(value, method, key);
}

function statusStateField(payload: Record<string, unknown>, key: string): VcsStatusState {
  const state = payload[key];
  if (state === "staged" || state === "unstaged" || state === "untracked" || state === "rename" || state === "conflict") {
    return state;
  }
  return malformed("vcs.status", key);
}

function commitFileStateField(payload: Record<string, unknown>): VcsCommitFileState {
  const state = payload["state"];
  if (state === "staged" || state === "rename") return state;
  return malformed("vcs.show", "files[].state");
}

function arrayField(payload: Record<string, unknown>, key: string, method: VcsReadMethod): unknown[] {
  const value = payload[key];
  return Array.isArray(value) ? value : malformed(method, key);
}

function cursorOf(payload: Record<string, unknown>, method: VcsReadMethod): VcsCursor {
  const cursor = payload["cursor"];
  if (!isRecord(cursor) || !("next" in cursor)) malformed(method, "cursor");
  const next = cursor["next"];
  if (next === null) return { next: null };
  if (typeof next !== "string" || !/^\d+$/.test(next)) malformed(method, "cursor.next");
  const offset = Number(next);
  if (!Number.isSafeInteger(offset) || offset > MAX_CURSOR_OFFSET) malformed(method, "cursor.next");
  return { next };
}

function truncationOf(value: unknown, method: VcsReadMethod, field: string): VcsDiffTruncation {
  if (value === "none" || value === "binary" || value === "byte_cap" || value === "page_cap") return value;
  return malformed(method, field);
}

/**
 * Enforce the documented relationship between a file's patch and its truncation
 * metadata, so an omitted or capped patch is never presented as complete.
 */
function consistentFileTruncation(file: {
  patch: string | null;
  truncated: boolean;
  truncation: VcsDiffTruncation;
}): boolean {
  if (file.truncation === "none") return file.patch !== null && !file.truncated;
  if (file.patch !== null) return false;
  if (file.truncation === "binary") return file.truncated;
  return file.truncated && (file.truncation === "byte_cap" || file.truncation === "page_cap");
}

/** Stable bridge codes the read surface can classify without reading messages. */
const STABLE_CODE_KINDS: Record<string, VcsReadFailureKind> = {
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

function failureKind(error: JsonRpcErrorObject): VcsReadFailureKind {
  const stable = error.data?.stable_code;
  const known = stable === undefined ? undefined : STABLE_CODE_KINDS[stable];
  // invalid_params is the one shared code whose message decides the class:
  // Libra reports both a bad cursor and other bad parameters under it.
  if (known === "invalid_params" && error.message.toLowerCase().includes("cursor")) {
    return "cursor_invalid";
  }
  if (known !== undefined) return known;
  const message = error.message.toLowerCase();
  if (message.includes("cursor")) return "cursor_invalid";
  return "internal";
}

/** Typed read wrappers over one connected bridge client. */
export class VcsReadMethods {
  constructor(private readonly bridge: BridgeClient) {}

  /** Methods this bridge actually negotiated. */
  availableMethods(): readonly string[] {
    return this.bridge.negotiatedCapabilities?.methods ?? [];
  }

  /** Throw `unsupported_capability` unless every requested read method is negotiated. */
  require(methods: readonly VcsReadMethod[] = VCS_READ_METHODS): void {
    const capabilities = this.bridge.negotiatedCapabilities;
    if (capabilities === undefined) {
      throw new VcsReadError("disconnected", "the bridge is not connected or handshaken", { retryable: true });
    }
    const missing = methods.filter((method) => !capabilities.methods.includes(method));
    if (missing.length > 0) {
      throw new VcsReadError(
        "unsupported_capability",
        `the bridge does not advertise ${missing.join(", ")}`,
        { retryable: false },
      );
    }
  }

  async status(params: VcsStatusParams = {}, signal?: AbortSignal): Promise<VcsStatusResult> {
    const payload = await this.call("vcs.status", {
      cursor: validateCursor(params.cursor),
      ...(validateLimit(params.limit) !== undefined ? { limit: params.limit } : {}),
    }, signal);
    const entries = arrayField(payload, "entries", "vcs.status").map((entry) => {
      if (!isRecord(entry)) malformed("vcs.status", "entries[]");
      return {
        path: pathField(entry, "path", "vcs.status"),
        state: statusStateField(entry, "state"),
        oldPath: nullablePathField(entry, "oldPath", "vcs.status"),
      };
    });
    return { entries, cursor: cursorOf(payload, "vcs.status") };
  }

  async diff(params: VcsDiffParams, signal?: AbortSignal): Promise<VcsDiffResult> {
    if (!DIFF_SIDES.includes(params.sides)) {
      throw new VcsReadError("invalid_params", `sides must be one of ${DIFF_SIDES.join(", ")}`);
    }
    if (params.sides === "worktree-vs-oid" && params.oid === undefined) {
      throw new VcsReadError("invalid_params", "oid is required for worktree-vs-oid");
    }
    if (params.sides !== "worktree-vs-oid" && params.oid !== undefined) {
      throw new VcsReadError("invalid_params", "oid is only valid for worktree-vs-oid");
    }
    const oid = params.sides === "worktree-vs-oid" ? validateOid(params.oid) : undefined;
    const paths = pathsOf(params.paths);
    const limit = validateLimit(params.limit);
    const payload = await this.call("vcs.diff", {
      sides: params.sides,
      ...(oid !== undefined ? { oid } : {}),
      paths,
      ...(limit !== undefined ? { limit } : {}),
    }, signal);
    if (stringField(payload, "sides", "vcs.diff") !== params.sides) malformed("vcs.diff", "sides");
    const byteCap = payload["byteCap"];
    const truncated = payload["truncated"];
    if (typeof byteCap !== "number" || !Number.isSafeInteger(byteCap) || byteCap < 0) malformed("vcs.diff", "byteCap");
    if (typeof truncated !== "boolean") malformed("vcs.diff", "truncated");
    const truncation = truncationOf(payload["truncation"], "vcs.diff", "truncation");
    const files = arrayField(payload, "files", "vcs.diff").map((file) => {
      if (!isRecord(file)) malformed("vcs.diff", "files[]");
      const fileTruncated = file["truncated"];
      if (typeof fileTruncated !== "boolean") malformed("vcs.diff", "files[].truncated");
      const patch = file["patch"];
      if (patch !== null && typeof patch !== "string") malformed("vcs.diff", "files[].patch");
      const fileTruncation = truncationOf(file["truncation"], "vcs.diff", "files[].truncation");
      const entry = {
        path: pathField(file, "path", "vcs.diff"),
        oldPath: nullablePathField(file, "oldPath", "vcs.diff"),
        patch,
        truncated: fileTruncated,
        truncation: fileTruncation,
      };
      if (!consistentFileTruncation(entry)) malformed("vcs.diff", "files[] metadata");
      return entry;
    });
    // The aggregate flag describes the files plus what the page omitted: a
    // page-capped diff legitimately reports truncation while every returned
    // file is complete.
    if (truncated !== (files.some((file) => file.truncated) || truncation === "page_cap")) {
      malformed("vcs.diff", "truncated");
    }
    if (truncation === "none") {
      if (truncated || files.some((file) => file.truncation !== "none")) malformed("vcs.diff", "truncation");
    } else if (truncation === "binary") {
      // A binary aggregate needs a binary file that is marked truncated.
      if (!files.some((file) => file.truncation === "binary" && file.truncated)) malformed("vcs.diff", "truncation");
    } else if (truncation === "byte_cap") {
      if (!files.some((file) => file.truncation === "byte_cap" && file.truncated)) malformed("vcs.diff", "truncation");
    } else if (!truncated) {
      malformed("vcs.diff", "truncation");
    }
    return { sides: params.sides, byteCap, truncated, truncation, files };
  }

  async log(params: VcsLogParams = {}, signal?: AbortSignal): Promise<VcsLogResult> {
    const payload = await this.call("vcs.log", {
      cursor: validateCursor(params.cursor),
      ...(validateLimit(params.limit) !== undefined ? { limit: params.limit } : {}),
    }, signal);
    const commits = arrayField(payload, "commits", "vcs.log").map((commit) => {
      if (!isRecord(commit)) malformed("vcs.log", "commits[]");
      const authorTime = commit["authorTime"];
      if (typeof authorTime !== "number" || !Number.isFinite(authorTime)) malformed("vcs.log", "commits[].authorTime");
      return {
        oid: stringField(commit, "oid", "vcs.log"),
        summary: stringField(commit, "summary", "vcs.log"),
        authorTime,
      };
    });
    return { commits, cursor: cursorOf(payload, "vcs.log") };
  }

  async show(params: VcsShowParams, signal?: AbortSignal): Promise<VcsShowResult> {
    const oid = validateOid(params.oid);
    const payload = await this.call("vcs.show", {
      oid,
      cursor: validateCursor(params.cursor),
      ...(validateLimit(params.limit) !== undefined ? { limit: params.limit } : {}),
    }, signal);
    const returnedOid = stringField(payload, "oid", "vcs.show");
    const parents = arrayField(payload, "parents", "vcs.show").map((parent) =>
      typeof parent === "string" ? parent : malformed("vcs.show", "parents[]"));
    const files = arrayField(payload, "files", "vcs.show").map((file) => {
      if (!isRecord(file)) malformed("vcs.show", "files[]");
      return {
        path: pathField(file, "path", "vcs.show"),
        state: commitFileStateField(file),
        oldPath: nullablePathField(file, "oldPath", "vcs.show"),
      };
    });
    return {
      oid: returnedOid === oid ? returnedOid : malformed("vcs.show", "oid"),
      summary: stringField(payload, "summary", "vcs.show"),
      parents,
      files,
      cursor: cursorOf(payload, "vcs.show"),
    };
  }

  private async call(
    method: VcsReadMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.require([method]);
    let response: CompletedRequest;
    try {
      response = await this.bridge.requestMethod(method, params, signal);
    } catch (error) {
      if (error instanceof BridgeClientError && error.code === "request_cancelled") {
        throw new VcsReadError("cancelled", `the ${method} read was cancelled`);
      }
      throw new VcsReadError("disconnected", `the bridge request failed: ${String(error)}`, { retryable: true });
    }
    if (response.state !== "success") {
      const failure = response.error;
      const options: { stableCode?: string; retryable?: boolean } = {};
      if (typeof failure?.data?.stable_code === "string") options.stableCode = failure.data.stable_code;
      if (failure?.data?.retryable === true) options.retryable = true;
      throw new VcsReadError(
        failure === undefined ? "internal" : failureKind(failure),
        failure?.message ?? "the bridge returned no result",
        options,
      );
    }
    const result = response.result;
    const data = isRecord(result) && isRecord(result["data"]) ? result["data"] as Record<string, unknown> : result;
    if (!isRecord(data)) {
      throw new VcsReadError("internal", "the bridge returned a non-object result");
    }
    return data;
  }
}
