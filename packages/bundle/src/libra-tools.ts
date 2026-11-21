/**
 * Libra bridge tools registered as first-party DSH tools.
 *
 * The model-visible surface is the allowlisted catalog owned by
 * `@libra/dsh-tools` (risk class, bridge method, parameter list). This module
 * compiles each catalog entry into a `ctx.tools.register(defineTool(...))`
 * definition so the agent loop can dispatch it, and owns the two seams the
 * facade deliberately does not: session identity (always the caller agent's
 * session, never model-supplied) and approval for write/restore/push_publish
 * (routed through the DSH approval service so the session approval policy —
 * ask/never — applies and every ask/outcome pair is audited on the session
 * log).
 */
import { randomUUID } from "node:crypto";

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type {
  ParameterPropertySpec,
  ParameterSchemaSpec,
  ToolCallKind,
  ToolCallView,
  ToolResult as DshToolResult,
  ToolResultView,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { TOOL_CATALOG, ToolsFacade } from "@libra/dsh-tools";
import type { ToolDefinition, ToolInput, ToolResult } from "@libra/dsh-tools";

/** Risks that must pass the DSH approval seam before reaching the bridge. */
const APPROVAL_RISKS = new Set(["write", "restore", "push_publish"]);

/** Model-forbidden bridge internals; never present in a parameter schema. */
const RESERVED_PARAMETERS = new Set([
  "actor",
  "repository_root",
  "executable",
  "database_path",
  "cwd",
  "owner",
  "fence",
  "workspace_id",
  "path",
  "worktree_id",
  "session_id",
  "operation_id",
  "approval",
  // Bridge test hook (status.get kind): never exposed to the model.
  "kind",
]);

/** Maximum rendered bytes returned to the model for one read tool. */
const MAX_RENDER_BYTES = 20000;

/** Curated model-facing descriptions for the catalog entries. */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  libra_context:
    "Query Libra context for the current session (bounded, redacted). Use this before deciding how to act in the repository.",
  libra_status: "Report the Libra agent bridge status and capability surface.",
  libra_diff: "Show a bounded, redacted diff of pending changes or a checkpoint in the Libra repository.",
  libra_history_search: "Search Libra session and checkpoint history within the bounded policy window.",
  libra_checkpoint: "List checkpoints recorded for the current session.",
  libra_checkpoint_show: "Show one checkpoint's metadata and evidence.",
  libra_checkpoint_create: "Record a checkpoint for the current session at the repository head.",
  libra_commit: "Create a Libra commit from the current session's recorded changes.",
  libra_review: "Run a review pass over the current session's work.",
  libra_restore_checkpoint: "Restore the working tree to a recorded checkpoint (destructive; requires approval).",
};

/** Per-tool parameter descriptions (defaults to a neutral bridge hint). */
const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  "libra_vcs_status.cursor": "Opaque next cursor from the previous status page.",
  "libra_vcs_status.limit": "Status page size, 1-100.",
  "libra_vcs_diff.sides": "One selector: worktree-vs-index, index-vs-head, or worktree-vs-oid.",
  "libra_vcs_diff.oid": "Commit object id for the worktree-vs-oid side.",
  "libra_vcs_diff.paths": "Repository-relative paths to diff.",
  "libra_vcs_diff.limit": "Maximum diff files in this page, 1-100.",
  "libra_vcs_log.cursor": "Opaque next cursor from the previous commit page.",
  "libra_vcs_log.limit": "Commit page size, 1-100.",
  "libra_vcs_show.oid": "The single commit object id to show.",
  "libra_vcs_show.cursor": "Opaque next cursor from the previous file page.",
  "libra_vcs_show.limit": "File page size, 1-100.",
  "libra_context.intent": "The intent or goal framing the context selection.",
  "libra_context.checkpoint_id": "Restrict context to this checkpoint.",
  "libra_checkpoint.limit": "Maximum number of checkpoints to return.",
  "libra_checkpoint.page": "Pagination page.",
  "libra_diff.mode": "Diff mode: staged, working, or checkpoint.",
  "libra_diff.paths": "Paths to include in the diff.",
  "libra_diff.checkpoint_id": "Diff against this checkpoint.",
  "libra_diff.limit": "Maximum diff size.",
  "libra_history_search.query": "Search query.",
  "libra_history_search.limit": "Maximum results.",
  "libra_history_search.offset": "Result offset.",
  "libra_history_search.page": "Pagination page.",
  "libra_commit.message": "Commit message.",
  "libra_commit.expected_head": "Expected repository head; the commit aborts on mismatch.",
  "libra_commit.signoff": "Sign-off marker for the commit.",
  "libra_commit.allow_empty": "Allow an empty commit.",
  "libra_checkpoint_create.checkpoint_id": "Stable checkpoint identity supplied by the agent.",
  "libra_checkpoint_create.target_oid": "Target object id to record.",
  "libra_review.agents": "Reviewer agents to include.",
  "libra_restore_checkpoint.checkpoint_id": "Checkpoint to restore.",
  "libra_restore_checkpoint.expected_head": "Expected repository head; the restore aborts on mismatch.",
};

const INTEGER_PARAMETERS = new Set(["limit", "offset", "page"]);
const BOOLEAN_PARAMETERS = new Set(["allow_empty", "signoff"]);
const STRING_ARRAY_PARAMETERS = new Set(["agents", "paths", "evidence_ids"]);

function parameterSchema(def: ToolDefinition): ParameterSchemaSpec {
  const properties: Record<string, ParameterPropertySpec> = {};
  for (const name of def.parameters) {
    if (RESERVED_PARAMETERS.has(name)) continue;
    const description = PARAMETER_DESCRIPTIONS[`${def.name}.${name}`]
      ?? `Parameter for ${def.bridge_method}.`;
    const required = def.required_parameters.includes(name) ? { required: true as const } : {};
    if (INTEGER_PARAMETERS.has(name)) {
      properties[name] = { type: "integer", description, ...required };
    } else if (BOOLEAN_PARAMETERS.has(name)) {
      properties[name] = { type: "boolean", description, ...required };
    } else if (STRING_ARRAY_PARAMETERS.has(name)) {
      properties[name] = { type: "array", items: { type: "string" }, description, ...required };
    } else {
      properties[name] = { type: "string", description, ...required };
    }
  }
  return properties as ParameterSchemaSpec;
}

function renderValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === null || value === undefined) {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RENDER_BYTES) {
    return `${text.slice(0, MAX_RENDER_BYTES)}\n… [truncated]`;
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bridgeError(result: ToolResult): Error {
  const message = result.error?.message ?? "bridge error";
  const error = new Error(`${message}${result.error?.stable_code ? ` (${result.error.stable_code})` : ""}`);
  if (result.error?.stable_code !== undefined) {
    Object.assign(error, { code: result.error.stable_code, retryable: result.error.retryable });
  }
  return error;
}

export type ToolsResolver = (session: Session | undefined) => Promise<ToolsFacade | undefined>;

/** Read-only view of the session's repository binding, for approval fencing. */
export interface BindingScope {
  generation(sessionId: string): number | undefined;
}

async function invokeLibra(
  approval: ApprovalService | undefined,
  resolveTools: ToolsResolver,
  scope: BindingScope | undefined,
  def: ToolDefinition,
  args: Record<string, unknown>,
  exec: ToolRunContext,
): Promise<JsonValue> {
  const input: ToolInput = { ...args };
  const session = exec.agent?.session;
  const tools = await resolveTools(session);
  if (tools === undefined) {
    throw new Error(`${def.name}: this session is not bound to an available Libra repository`);
  }
  // Typed reads must fail closed when the repository binding's bridge did not
  // negotiate the method, instead of surfacing a generic method-not-found.
  if (def.risk === "read" && !tools.supports(def.bridge_method)) {
    throw new Error(`${def.name}: the bridge does not advertise ${def.bridge_method}`, {
      cause: { code: "unsupported_capability" },
    });
  }
  if (session !== undefined && def.parameters.includes("session_id")) {
    input.session_id = String(session.id);
  }
  const sessionId = session === undefined ? undefined : String(session.id);
  if (APPROVAL_RISKS.has(def.risk)) {
    if (approval === undefined || exec.agent === undefined) {
      throw new Error(`${def.name}: no approval service is composed; refusing ${def.risk} operation`);
    }
    // Capture the binding this approval is about; a move during the wait must
    // invalidate it even if the Session later returns to the same repository.
    const approvalGeneration = scope === undefined || sessionId === undefined
      ? undefined
      : scope.generation(sessionId);
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: def.name,
      callId: exec.callId,
      reason: `${def.name} is a ${def.risk} operation on the Libra repository`,
      signal: exec.signal,
    });
    if (outcome !== "allowed-once") {
      throw new Error(`${def.name}: approval ${outcome}`, { cause: { code: "approval-denied" } });
    }
    input.operation_id ??= randomUUID();
    input.approval = { decision: "approved", approver: "dsh-approval" };
    const current = await resolveTools(session);
    const generationNow = scope === undefined || sessionId === undefined
      ? undefined
      : scope.generation(sessionId);
    if (current === undefined || current !== tools || generationNow !== approvalGeneration) {
      throw new Error(`${def.name}: the Session's repository binding changed during approval; refusing ${def.risk} operation`);
    }
  } else if (def.risk === "read") {
    input.operation_id ??= randomUUID();
  }
  const result = await tools.invoke(def.name, input);
  if (result.status === "error") throw bridgeError(result);
  if (result.data === undefined) return {};
  // Bridge payloads are lossless JSON by contract, so a structural cast is safe.
  return isRecord(result.data) ? result.data as JsonValue : { value: result.data as JsonValue };
}

function renderOutput(_args: Record<string, JsonValue>, value: JsonValue): ContentBlock[] {
  return [{ type: "text", text: renderValue(value) }];
}

/** Map a catalog risk class to the UI card category for a tool call. */
function callKindFor(def: ToolDefinition): ToolCallKind {
  switch (def.risk) {
    case "read":
      return def.name === "libra_history_search" ? "search" : "read";
    case "write":
      return "edit";
    case "restore":
      return "delete";
    default:
      return "other";
  }
}

/** Human-readable card title for one tool call. */
function cardTitle(def: ToolDefinition): string {
  return def.name.replace(/^libra_/, "libra ");
}

function resultText(result: DshToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
    .map((block) => block.text)
    .join("\n");
}

function stringPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function presentCallFor(def: ToolDefinition): (args: Record<string, unknown>) => ToolCallView {
  // Pure presenter: render intent for a UI card while the call is pending.
  return (args) => {
    if (def.name === "libra_diff") {
      const paths = stringPaths(args.paths);
      return {
        card: "diff",
        title: cardTitle(def),
        diffs: (paths.length > 0 ? paths : ["repository"]).map((path) => ({
          path,
          oldText: null,
          newText: "",
        })),
      };
    }
    return {
      card: "generic",
      title: cardTitle(def),
      kind: callKindFor(def),
      rawInput: args,
    };
  };
}

function presentResultFor(def: ToolDefinition): (
  args: Record<string, unknown>,
  result: DshToolResult,
) => ToolResultView | undefined {
  // `presentResult` receives the model-facing tool result (rendered content +
  // isError), not the bridge payload returned from `execute`.
  return (args, result) => {
    const failed = result.isError ? `${cardTitle(def)} failed` : undefined;
    if (def.name === "libra_diff") {
      const paths = stringPaths(args.paths);
      const text = resultText(result);
      return {
        card: "diff",
        ...(failed !== undefined ? { title: failed } : {}),
        diffs: [{
          path: paths[0] ?? "libra.diff",
          oldText: "",
          newText: text,
        }],
      };
    }
    if (def.name === "libra_history_search") {
      const lines = resultText(result).split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      const paths = lines.slice(0, 50);
      return {
        card: "search",
        shape: "paths",
        ...(failed !== undefined ? { title: failed } : {}),
        paths,
        truncated: lines.length > paths.length,
        total: lines.length,
      };
    }
    return {
      card: "generic",
      ...(failed !== undefined ? { title: failed } : {}),
      content: result.content,
    };
  };
}

/**
 * Minimal structural surface of the DSH tools registry this module needs.
 */
export interface ToolsService {
  register(definition: unknown): unknown;
}

/**
 * Register every catalog tool on the DSH tools registry. Returns a disposer
 * that unregisters them in reverse order.
 */
export function registerLibraTools(
  toolsService: ToolsService,
  resolveTools: ToolsResolver,
  approval: ApprovalService | undefined,
  scope?: BindingScope,
): () => void {
  const disposers: Array<() => void> = [];
  for (const def of TOOL_CATALOG) {
    disposers.push(toolsService.register(defineTool({
      name: def.name,
      description: TOOL_DESCRIPTIONS[def.name] ?? `${def.name} (${def.bridge_method})`,
      parameters: parameterSchema(def),
      output: {
        schema: { type: "json" },
        render: renderOutput,
      },
      isConcurrencySafe: () => def.risk === "read",
      presentCall: presentCallFor(def),
      presentResult: presentResultFor(def),
      async execute(args, exec) {
        return invokeLibra(approval, resolveTools, scope, def, args, exec);
      },
    })) as () => void);
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
