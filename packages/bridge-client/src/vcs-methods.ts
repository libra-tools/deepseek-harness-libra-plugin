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
import type { BridgeClient } from "./client.js";
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
  | "stale_state"
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

export interface VcsStatusEntry {
  path: string;
  state: string;
}

export interface VcsStatusResult {
  entries: VcsStatusEntry[];
  cursor: VcsCursor;
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
}

export interface VcsShowParams {
  oid: string;
  cursor?: string | null;
  limit?: number;
}

export interface VcsShowFile {
  path: string;
  state: string;
  oldPath: string | null;
}

export interface VcsShowResult {
  oid: string;
  summary: string;
  parents: string[];
  files: VcsShowFile[];
  cursor: VcsCursor;
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
  if (oid.includes("..") || oid.includes(":") || oid.includes(" ") || oid.startsWith("-")) {
    throw new VcsReadError("invalid_params", "oid must be one object id, not a revision range");
  }
  return oid;
}

function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new VcsReadError("invalid_params", "paths must be a list of repository-relative strings");
  }
  return value as string[];
}

function cursorOf(payload: Record<string, unknown>): VcsCursor {
  const cursor = payload["cursor"];
  if (!isRecord(cursor)) return { next: null };
  const next = cursor["next"];
  return { next: typeof next === "string" ? next : null };
}

function failureKind(error: JsonRpcErrorObject): VcsReadFailureKind {
  const message = error.message.toLowerCase();
  if (error.data?.stable_code === "LBR-AGENT-031") return "disconnected";
  if (message.includes("cursor")) return "cursor_invalid";
  if (message.includes("scope") || message.includes("repository")) return "scope_mismatch";
  if (message.includes("stale")) return "stale_state";
  if (message.includes("invalid") || message.includes("must be") || message.includes("refuses")) {
    return "invalid_params";
  }
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

  async status(params: VcsStatusParams = {}): Promise<VcsStatusResult> {
    const payload = await this.call("vcs.status", {
      cursor: validateCursor(params.cursor),
      ...(validateLimit(params.limit) !== undefined ? { limit: params.limit } : {}),
    });
    const entries = Array.isArray(payload["entries"]) ? payload["entries"] : [];
    return {
      entries: entries.filter(isRecord).map((entry: Record<string, unknown>) => ({
        path: String(entry["path"] ?? ""),
        state: String(entry["state"] ?? ""),
      })),
      cursor: cursorOf(payload),
    };
  }

  async diff(params: VcsDiffParams): Promise<VcsDiffResult> {
    if (!DIFF_SIDES.includes(params.sides)) {
      throw new VcsReadError("invalid_params", `sides must be one of ${DIFF_SIDES.join(", ")}`);
    }
    const oid = params.sides === "worktree-vs-oid" ? validateOid(params.oid) : undefined;
    const payload = await this.call("vcs.diff", {
      sides: params.sides,
      ...(oid !== undefined ? { oid } : {}),
      paths: stringList(params.paths),
      ...(validateLimit(params.limit) !== undefined ? { limit: params.limit } : {}),
    });
    const files = Array.isArray(payload["files"]) ? payload["files"] : [];
    return {
      sides: params.sides,
      byteCap: typeof payload["byteCap"] === "number" ? payload["byteCap"] as number : 0,
      truncated: payload["truncated"] === true,
      truncation: String(payload["truncation"] ?? "none") as VcsDiffTruncation,
      files: files.filter(isRecord).map((file: Record<string, unknown>) => ({
        path: String(file["path"] ?? ""),
        oldPath: typeof file["oldPath"] === "string" ? file["oldPath"] : null,
        patch: typeof file["patch"] === "string" ? file["patch"] : null,
        truncated: file["truncated"] === true,
        truncation: String(file["truncation"] ?? "none") as VcsDiffTruncation,
      })),
    };
  }

  async log(params: VcsLogParams = {}): Promise<VcsLogResult> {
    const payload = await this.call("vcs.log", {
      cursor: validateCursor(params.cursor),
      ...(validateLimit(params.limit) !== undefined ? { limit: params.limit } : {}),
    });
    const commits = Array.isArray(payload["commits"]) ? payload["commits"] : [];
    return {
      commits: commits.filter(isRecord).map((commit: Record<string, unknown>) => ({
        oid: String(commit["oid"] ?? ""),
        summary: String(commit["summary"] ?? ""),
        authorTime: typeof commit["authorTime"] === "number" ? commit["authorTime"] as number : 0,
      })),
      cursor: cursorOf(payload),
    };
  }

  async show(params: VcsShowParams): Promise<VcsShowResult> {
    const oid = validateOid(params.oid);
    const payload = await this.call("vcs.show", {
      oid,
      cursor: validateCursor(params.cursor),
      ...(validateLimit(params.limit) !== undefined ? { limit: params.limit } : {}),
    });
    const files = Array.isArray(payload["files"]) ? payload["files"] : [];
    return {
      oid: typeof payload["oid"] === "string" ? payload["oid"] as string : oid,
      summary: String(payload["summary"] ?? ""),
      parents: Array.isArray(payload["parents"])
        ? payload["parents"].filter((parent): parent is string => typeof parent === "string")
        : [],
      files: files.filter(isRecord).map((file: Record<string, unknown>) => ({
        path: String(file["path"] ?? ""),
        state: String(file["state"] ?? ""),
        oldPath: typeof file["oldPath"] === "string" ? file["oldPath"] : null,
      })),
      cursor: cursorOf(payload),
    };
  }

  private async call(method: VcsReadMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require([method]);
    let response: CompletedRequest;
    try {
      response = await this.bridge.requestMethod(method, params);
    } catch (error) {
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
