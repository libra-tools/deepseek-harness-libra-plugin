import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision, RequestErrorAction } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import type { SessionSeq } from "@deepseek-ai/dsh-session/types";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import z from "@deepseek-ai/schemastery";
import { BridgeClient } from "@libra/dsh-bridge-client";
import type { CompletedRequest } from "@libra/dsh-bridge-client";
import { ToolsFacade } from "@libra/dsh-tools";

import { registerLibraTools } from "./libra-tools.js";
import { mountLibraContext } from "./context.js";
import { mountLibraWorkspace } from "./workspace.js";
import { mountLibraOutbox } from "./outbox.js";
import {
  libraMemoryProjection,
  libraMemoryProjectionKey,
} from "./memory-projection.js";
import {
  readLive,
  resolveDeployment,
  resolveExecutable as findExecutable,
  type DeploymentConfig,
  type ResolvedDeployment,
} from "./deployment.js";
import { applyPerSession } from "./repository-runtime.js";
import type { WorkingDirectoryService } from "./repository-binding.js";

export { evaluateSessionEvidence, LibraEvidenceRemote } from "./evidence-remote.js";
export type { BridgeEvidenceInfo, EvidenceResolver, EvidenceResult, SessionEvidence } from "./evidence-remote.js";
export { LibraVcsRemote, type SessionById } from "./vcs-remote.js";
export { boundModelValue } from "./libra-tools.js";
export {
  invokeVcsReadTool,
  LibraVcsReadService,
  VcsHostError,
  type VcsHostFailureKind,
  type VcsReadOptions,
  type VcsReadScope,
  type VcsScopeResolution,
} from "./vcs-read.js";

/** Cordis identity used by the DSH loader. */
export const name = "@libra-tools/dsh-bundle";

/** Only the two lifecycle services used by this adapter are required. */
export const inject = ["agents", "sessions"];

/**
 * Deployment-owned locations. Every field is optional and volatile so the
 * Plugins page can edit it without a schema rejection on an empty profile.
 * `0` memory budget means Libra's own budget. Memory selection stays in Libra.
 */
export type Config = DeploymentConfig;
export {
  type BindingFailure,
  type BindResult,
  type BridgeEvidence,
  type BridgeEvidenceSnapshot,
  type LibraBridgeEvidenceService,
  type LibraRepositoryBindingService,
  type RepositoryBinding,
  type RepositoryIdentity,
  RepositoryRegistry,
  type RepositoryRegistryOptions,
  type WorkingDirectoryService,
  readSessionWorkingDirectory,
} from "./repository-binding.js";

export const Config = z.object({
  libraExecutable: z.string().default("").volatile(),
  repositoryRoot: z.string().default("").volatile(),
  outboxRoot: z.string().default("").volatile(),
  injectContext: z.boolean().default(true).volatile(),
  workspaceLeaseTtlMs: z.number().default(30_000).volatile(),
  memoryTokenBudget: z.number().default(0).volatile(),
  captureMemoryEpisodes: z.boolean().default(false).volatile(),
  memoryModel: z.string().default("deepseek-chat").volatile(),
});

interface LibraMemorySource {
  kind: "libra-memory";
  receiptId: string;
  viewHash: string;
  bundleHash: string;
  selectedCount: number;
  tokenBudget: number;
  form: "snapshot";
  sections: readonly [{ readonly name: "libra-memory"; readonly text: string }];
}

interface LibraMemoryClearSource {
  kind: "libra-memory-clear";
  /** Surface sequences this clear message retires (shadowed deliveries). */
  seqs: number[];
  form: "snapshot";
  sections: readonly [{ readonly name: "libra-memory"; readonly text: string }];
}

declare module "@deepseek-ai/dsh-llm/message" {
  interface MessageSourceMap {
    "libra-memory": LibraMemorySource;
    "libra-memory-clear": LibraMemoryClearSource;
  }
}

interface MemoryDelivery {
  promptSection: string;
  receiptId: string;
  viewHash: string;
  bundleHash: string;
  selectedCount: number;
  tokenBudget: number;
}

interface LiveSessionState {
  session: Session;
  opened: boolean;
  opening: Promise<void> | undefined;
  lastQuery: string | undefined;
  lastRefreshTurn: number | undefined;
  lastRefreshGeneration: number | undefined;
  retiring: Promise<void> | undefined;
  capture: Promise<void> | undefined;
}

const EPISODE_TRUNCATION_MARKER = "\n[TRUNCATED: original content omitted]";
const utf8Encoder = new TextEncoder();

function truncateUtf8(value: string, limit: number): { text: string; originalBytes: number } {
  const originalBytes = utf8Encoder.encode(value).length;
  if (originalBytes <= limit) return { text: value, originalBytes };
  const markerBytes = utf8Encoder.encode(EPISODE_TRUNCATION_MARKER).length;
  const budget = limit - markerBytes;
  let end = 0;
  let used = 0;
  for (const character of value) {
    const size = utf8Encoder.encode(character).length;
    if (used + size > budget) break;
    used += size;
    end += character.length;
  }
  return { text: `${value.slice(0, end)}${EPISODE_TRUNCATION_MARKER}`, originalBytes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
  return text;
}

function requireNatural(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
  return value;
}

function parseDelivery(result: unknown): MemoryDelivery | null {
  if (!isRecord(result)) throw new Error("memory.recall returned an invalid envelope");
  assertExactKeys(result, ["schema_version", "data"], "envelope");
  if (result.schema_version !== 1 || !isRecord(result.data)) {
    throw new Error("memory.recall returned an unsupported schema version");
  }
  assertExactKeys(result.data, ["delivery"], "data envelope");
  if (result.data.delivery === null) return null;
  if (!isRecord(result.data.delivery)) throw new Error("memory.recall returned an invalid delivery");
  const delivery = result.data.delivery;
  assertExactKeys(delivery, [
    "prompt_section",
    "receipt_id",
    "view_hash",
    "bundle_hash",
    "selected_count",
    "token_budget",
  ], "delivery");
  if (typeof delivery.prompt_section !== "string") {
    throw new Error("memory.recall returned an invalid prompt_section");
  }
  const parsed: MemoryDelivery = {
    promptSection: delivery.prompt_section,
    receiptId: requireString(delivery.receipt_id, "receipt_id"),
    viewHash: requireSha256(delivery.view_hash, "view_hash"),
    bundleHash: requireSha256(delivery.bundle_hash, "bundle_hash"),
    selectedCount: requireNatural(delivery.selected_count, "selected_count"),
    tokenBudget: requireNatural(delivery.token_budget, "token_budget"),
  };
  if ((parsed.selectedCount === 0) !== (parsed.promptSection.length === 0)) {
    throw new Error("memory.recall returned inconsistent selection content");
  }
  const calculated = `sha256:${createHash("sha256").update(Buffer.from(parsed.promptSection, "utf8")).digest("hex")}`;
  if (calculated !== parsed.bundleHash) {
    throw new Error("memory.recall bundle hash mismatch");
  }
  return parsed;
}

function completedResult(request: CompletedRequest): unknown {
  if (request.state === "success" && request.error === undefined) return request.result;
  const stableCode = request.error?.data?.stable_code ?? "LBR-AGENT-UNKNOWN";
  const retryable = request.error?.data?.retryable === true;
  throw new Error(`${request.method} failed (${stableCode}, retryable=${String(retryable)})`);
}

function memoryMessage(delivery: MemoryDelivery): UserMessage {
  const text = delivery.promptSection;
  return createUserMessage({
    content: [{ type: "text", text }],
    source: {
      kind: "libra-memory",
      receiptId: delivery.receiptId,
      viewHash: delivery.viewHash,
      bundleHash: delivery.bundleHash,
      selectedCount: delivery.selectedCount,
      tokenBudget: delivery.tokenBudget,
      form: "snapshot",
      sections: [{ name: "libra-memory", text }],
    },
  });
}

const MEMORY_CLEAR_TEXT = "Libra Memory snapshot cleared. Earlier Libra Memory snapshots no longer apply.";

function memoryClearMessage(seqs: readonly SessionSeq[]): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text: MEMORY_CLEAR_TEXT }],
    source: {
      kind: "libra-memory-clear",
      seqs: [...seqs].map(Number),
      form: "snapshot",
      sections: [{ name: "libra-memory", text: MEMORY_CLEAR_TEXT }],
    },
  });
}

function isLibraMemorySequence(session: Session, sequence: SessionSeq): boolean {
  const event = session.eventAt(sequence);
  if (event?.type !== "user/message") return false;
  // Read `kind` through a plain object shape; the surface source union is
  // merge-extensible, so a direct `===` on the literal union trips TS control
  // flow narrowing once `model`/`tool` members are predicate-narrowed away.
  const source = (event.data as { source?: { kind?: string } }).source;
  return source?.kind === "libra-memory";
}

interface LibraMemoryProjectionState {
  seqs: SessionSeq[];
}

/** Minimal structural surface of the sessionProjections registry. */
interface SessionProjectionsLike {
  register(definition: unknown): () => void;
  stateOf(session: Session, key: string): unknown;
}

/**
 * Visible libra-memory sequences for one session: prefer the durable
 * projection state (survives compaction) and fall back to a surface scan
 * when the host does not compose `sessionProjections`.
 */
function visibleMemorySequences(
  session: Session,
  projected: LibraMemoryProjectionState | undefined,
): SessionSeq[] {
  if (projected !== undefined) {
    return projected.seqs.filter((sequence) => session.surface.nodes.includes(sequence));
  }
  return session.surface.nodes.filter((sequence) => isLibraMemorySequence(session, sequence));
}

function retireVisibleMemory(session: Session, projected: LibraMemoryProjectionState | undefined): void {
  for (const sequence of visibleMemorySequences(session, projected)) {
    session.append("user/message", memoryClearMessage([sequence]), {
      surfaceOp: { op: "replace", startSeq: sequence, endSeq: sequence },
      sourceEventSeqs: [sequence],
    });
  }
}

function acceptedUserQuery(messages: readonly UserMessage[]): string | undefined {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.source.kind !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text") blocks.push(block.text);
    }
  }
  return blocks.length === 0 ? undefined : blocks.join("\n");
}

/**
 * Mount one bridge-backed Memory recall adapter into a real Cordis composition.
 * The returned disposer preserves still-live DSH sessions across HMR.
 */
interface MemoryMountOptions {
  /** Live cap forwarded to `memory.recall` (tokens). Absent or 0 is unbounded here. */
  memoryTokenBudget?: () => number | undefined;
  /** When true, recall carries the turn and a completed turn records an Episode. */
  captureEpisodes?: () => boolean;
  openSession: (session: Session) => Promise<void>;
  waitSession: (session: Session) => Promise<void>;
  /**
   * Which sessions this mount serves. One mount exists per bound repository,
   * so a session bound elsewhere must not recall or record here.
   */
  serves?: (session: Session) => boolean;
  /** Register the shared projection unit; a per-repository pool owns it once. */
  registerProjection?: boolean;
}

async function mountMemory(
  ctx: Context,
  bridge: BridgeClient,
  options: MemoryMountOptions,
): Promise<{ dispose: () => Promise<void>; wait: (session: Session) => Promise<void>; retire: (session: Session) => Promise<void>; track: (session: Session) => void }> {
  let stopping = false;
  const serves = options.serves ?? (() => true);
  const sessions = new Map<Session, LiveSessionState>();
  const retirements = new Set<Promise<void>>();
  const recalls = new Set<Promise<MemoryDelivery | null>>();
  const listenerDisposers: Array<() => unknown> = [];
  const projections = ctx.get("sessionProjections") as SessionProjectionsLike | undefined;
  const projectedState = (session: Session): LibraMemoryProjectionState | undefined => {
    if (projections === undefined) return undefined;
    const state = projections.stateOf(session, libraMemoryProjectionKey);
    if (!isRecord(state)) return undefined;
    const seqs = state.seqs;
    return Array.isArray(seqs) ? { seqs: seqs as SessionSeq[] } : undefined;
  };
  const trackSession = (session: Session): LiveSessionState => {
    const existing = sessions.get(session);
    if (existing !== undefined) {
      existing.session = session;
      return existing;
    }
    const created: LiveSessionState = {
      session,
      opened: false,
      opening: undefined,
      lastQuery: undefined,
      lastRefreshTurn: undefined,
      lastRefreshGeneration: undefined,
      retiring: undefined,
      capture: undefined,
    };
    sessions.set(session, created);
    return created;
  };

  const openSession = async (state: LiveSessionState): Promise<void> => {
    if (stopping) throw new Error("Libra Memory adapter is stopping");
    if (state.retiring !== undefined) throw new Error("DSH session is retiring");
    if (state.opened) return;
    if (state.opening !== undefined) return state.opening;
    const opening = options.openSession(state.session)
      .then(() => {
        state.opened = true;
      })
      .finally(() => {
        if (state.opening === opening) state.opening = undefined;
      });
    state.opening = opening;
    return opening;
  };

  const recall = (state: LiveSessionState, queryText: string, turn: number): Promise<MemoryDelivery | null> => {
    const operation = (async () => {
      await state.capture;
      await openSession(state);
      const budget = options.memoryTokenBudget?.();
      const result = completedResult(await bridge.requestMethod("memory.recall", {
        session_id: String(state.session.id),
        query_text: queryText,
        ...(typeof budget === "number" && budget > 0 ? { token_budget: budget } : {}),
        ...(options.captureEpisodes?.() === true ? { turn } : {}),
      }));
      return parseDelivery(result);
    })();
    recalls.add(operation);
    void operation.then(() => recalls.delete(operation), () => recalls.delete(operation));
    return operation;
  };

  const markRefreshed = (state: LiveSessionState, turn: number, generation: number): void => {
    state.lastRefreshTurn = turn;
    state.lastRefreshGeneration = generation;
  };

  const alreadyRefreshed = (state: LiveSessionState, turn: number, generation: number): boolean =>
    state.lastRefreshTurn === turn && state.lastRefreshGeneration === generation;

  const retire = (session: Session): Promise<void> => {
    const state = sessions.get(session);
    if (state === undefined) return Promise.resolve();
    if (state.retiring !== undefined) return state.retiring;
    const retirement = (async () => {
      try {
        await state.opening;
        await state.capture;
      } finally {
        sessions.delete(session);
      }
    })();
    state.retiring = retirement;
    retirements.add(retirement);
    const forget = (): void => {
      retirements.delete(retirement);
    };
    void retirement.then(forget, forget);
    void retirement.catch((error: unknown) => {
      ctx.logger.warn(`libra-memory: session retirement failed: ${String(error)}`);
    });
    return retirement;
  };

  const captureEpisode = (session: Session, event: { type: string; data?: unknown }): void => {
    if (options.captureEpisodes?.() !== true || stopping || event.type !== "turn/end" || !isRecord(event.data)) return;
    const reason = event.data.reason;
    if (!isRecord(reason) || reason.kind !== "completed") return;
    const turn = event.data.turn;
    if (typeof turn !== "number") return;
    const state = sessions.get(session);
    if (state === undefined || state.retiring !== undefined || state.lastRefreshTurn !== turn || state.lastQuery === undefined) return;
    const response = [...session.ownEvents()].reverse().find((candidate) =>
      candidate.type === "assistant/message" && isRecord(candidate.data) && candidate.data.turn === turn);
    if (response?.type !== "assistant/message" || response.data.interrupted === true) return;
    const message = response.data.message;
    const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
    const responseText = content.flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
    if (responseText.trim().length === 0) return;
    const previous = state.capture;
    const truncatedGoal = truncateUtf8(state.lastQuery, 4096);
    const truncatedResponse = truncateUtf8(responseText, 16384);
    for (const [field, truncated] of [["goal", truncatedGoal], ["response", truncatedResponse]] as const) {
      if (truncated.originalBytes !== utf8Encoder.encode(truncated.text).length) {
        ctx.logger.warn(`libra-memory: Episode truncated session=${String(session.id)} turn=${turn} field=${field} bytes=${truncated.originalBytes}`);
      }
    }
    const goal = truncatedGoal.text;
    state.capture = (async () => {
      await previous;
      completedResult(await bridge.requestMethod("memory.episode.record", {
        session_id: String(session.id),
        turn,
        goal,
        response_text: truncatedResponse.text,
      }));
    })().catch((error: unknown) => {
      ctx.logger.warn(`libra-memory: Episode capture failed: ${String(error)}`);
    });
  };

  try {
    const negotiated = await bridge.connect();
    if (!negotiated.methods.includes("memory.recall")) {
      throw new Error("Libra bridge does not advertise memory.recall");
    }
    if (options.captureEpisodes?.() === true && !negotiated.methods.includes("memory.episode.record")) {
      throw new Error("Libra bridge does not advertise memory.episode.record");
    }
    if (projections !== undefined && options.registerProjection !== false) {
      listenerDisposers.push(projections.register(libraMemoryProjection));
    }
    listenerDisposers.push(ctx.on("session/created", (session) => {
      if (!stopping && serves(session)) trackSession(session);
    }));
    listenerDisposers.push(ctx.on("session/event", (session, event) => {
      if (!stopping && serves(session)) captureEpisode(session, event);
    }));
    listenerDisposers.push(ctx.on("session/flush", async (session) => {
      if (!serves(session)) return;
      await sessions.get(session)?.capture;
    }));
    listenerDisposers.push(ctx.on("agent/pre-step", async (
      { agent, turn, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!serves(agent.session)) return next();
      const beforeGeneration = agent.session.surface.replaceGeneration;
      const decision = await next();
      if (decision.kind === "reject" || signal.aborted) return decision;
      await options.waitSession(agent.session);
      // The Host can move a Session while this listener awaited; never recall
      // from the repository it left.
      if (signal.aborted || !serves(agent.session)) return decision;
      const state = trackSession(agent.session);
      const generation = agent.session.surface.replaceGeneration;
      let queryText: string | undefined;
      let refreshDue = false;
      if (step === 1) {
        refreshDue = true;
        queryText = acceptedUserQuery(decision.messages);
        state.lastQuery = queryText;
      } else if (generation > beforeGeneration) {
        refreshDue = true;
        queryText = state.lastQuery;
      }
      if (!refreshDue || alreadyRefreshed(state, turn, generation)) return decision;
      const delivery = queryText === undefined ? null : await recall(state, queryText, turn);
      if (signal.aborted || !serves(agent.session)) return decision;
      retireVisibleMemory(state.session, projectedState(state.session));
      markRefreshed(state, turn, state.session.surface.replaceGeneration);
      if (delivery === null || delivery.promptSection.length === 0) return decision;
      return { ...decision, messages: [...decision.messages, memoryMessage(delivery)] };
    }, { prepend: true }));
    listenerDisposers.push(ctx.on("agent/request-error", async (
      { agent, turn, signal },
      next,
    ): Promise<RequestErrorAction> => {
      if (!serves(agent.session)) return next();
      const beforeGeneration = agent.session.surface.replaceGeneration;
      const action = await next();
      const generation = agent.session.surface.replaceGeneration;
      if (signal.aborted || action?.kind !== "retry" || generation <= beforeGeneration) return action;
      await options.waitSession(agent.session);
      if (signal.aborted || !serves(agent.session)) return action;
      const state = trackSession(agent.session);
      if (state.lastQuery === undefined || alreadyRefreshed(state, turn, generation)) return action;
      const delivery = await recall(state, state.lastQuery, turn);
      if (signal.aborted || !serves(agent.session)) return action;
      retireVisibleMemory(state.session, projectedState(state.session));
      if (delivery !== null && delivery.promptSection.length > 0) {
        agent.session.append("user/message", memoryMessage(delivery), { surfaceOp: "append" });
      }
      markRefreshed(state, turn, state.session.surface.replaceGeneration);
      return action;
    }));

    for (const session of ctx.sessions.list()) {
      if (serves(session)) trackSession(session);
    }
  } catch (error) {
    for (const dispose of listenerDisposers.reverse()) dispose();
    throw error;
  }

  return {
    track: (session) => { if (serves(session)) trackSession(session); },
    wait: async (session) => { await sessions.get(session)?.capture; },
    retire,
    dispose: async () => {
      if (stopping) return;
      stopping = true;
      for (const dispose of listenerDisposers.reverse()) dispose();
      await Promise.allSettled([...retirements, ...recalls, ...[...sessions.values()].flatMap((state) => [state.capture, state.opening])]);
    },
  };
}

function bridgeEnv(deployment: ResolvedDeployment): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    LIBRA_SKIP_WEB_BUILD: "1",
    ...(deployment.captureMemoryEpisodes ? {
      LIBRA_DSH_MEMORY_MODEL: deployment.memoryModel,
      ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
    } : {}),
  };
}

/**
 * Re-read volatile settings before each bridge call. A changed target requires
 * a reload so an existing session can never be sent to another repository.
 */
function followDeployment(
  bridge: BridgeClient,
  current: () => Promise<ResolvedDeployment | undefined>,
  initial: ResolvedDeployment,
): void {
  const original = bridge.requestMethod.bind(bridge);
  const key = `${initial.libraExecutable}\0${initial.repositoryRoot}`;
  let gate: Promise<void> = Promise.resolve();
  bridge.requestMethod = (method, params) => {
    const run = gate.then(async () => {
      const deployment = await current();
      if (deployment === undefined) throw new Error("libra executable is not configured");
      const next = `${deployment.libraExecutable}\0${deployment.repositoryRoot}`;
      if (next !== key) throw new Error("Libra executable or repository changed; reload the plugin before continuing");
    }).then(() => original(method, params));
    gate = run.then(() => undefined, () => undefined);
    return run;
  };
}

/**
 * Compose the Libra bridge-backed layers into a real Cordis composition:
 * Memory recall (when the bridge advertises `memory.recall`), the libra_*
 * tool registry (when the host composes `ctx.tools`), and the session-event
 * outbox projection. One shared bridge is owned by this layer's disposer.
 * Missing or unusable locations leave the plugin inert instead of failing
 * the profile. A later settings change is picked up on the next session.
 */
async function applyForConfiguredRoot(ctx: Context, config: Config): Promise<() => Promise<void>> {
  let runtime: { dispose: () => Promise<void> } | undefined;
  let starting: Promise<void> | undefined;
  let warned = false;

  const live = { root: "", ttl: 30_000 };
  const currentDeployment = async (): Promise<ResolvedDeployment | undefined> => {
    const resolved = await resolveDeployment(config);
    if (resolved.deployment !== undefined) {
      live.ttl = resolved.deployment.workspaceLeaseTtlMs;
    }
    return resolved.deployment;
  };

  const start = async (): Promise<void> => {
    if (runtime !== undefined) return;
    if (starting !== undefined) return starting;
    starting = (async () => {
      const resolved = await resolveDeployment(config);
      if (resolved.deployment === undefined) {
        if (!warned) {
          warned = true;
          ctx.logger.warn(`libra: ${resolved.reason ?? "plugin inactive"}; plugin inactive`);
        }
        return;
      }
      const deployment = resolved.deployment;
      const bridge = new BridgeClient({
        executable: deployment.libraExecutable,
        cwd: deployment.repositoryRoot,
        env: bridgeEnv(deployment),
      });
      followDeployment(bridge, currentDeployment, deployment);
      const disposers: Array<() => unknown> = [];
      let connected = false;
      const shutdown = async (): Promise<void> => {
        const drain = (async () => {
          for (const dispose of disposers.reverse()) {
            try {
              await dispose();
            } catch {
              // contained: each layer is best-effort on shutdown
            }
          }
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          drain.then(() => false),
          new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), 1_000); }),
        ]);
        clearTimeout(timer);
        if (timedOut) ctx.logger.warn("libra: shutdown drain timed out; closing bridge with pending work");
        if (connected) await bridge.close().catch(() => undefined);
      };
      try {
        const negotiated = await bridge.connect();
        connected = true;
        const outbox = mountLibraOutbox(ctx, bridge, {
          repositoryRoot: deployment.repositoryRoot,
          ...(deployment.outboxRoot !== undefined ? { outboxRoot: deployment.outboxRoot } : {}),
        });
        disposers.push(outbox.dispose);
        if (negotiated.methods.includes("memory.recall")) {
          const memory = await mountMemory(ctx, bridge, {
            memoryTokenBudget: () => readLive(config.memoryTokenBudget),
            captureEpisodes: () => deployment.captureMemoryEpisodes,
            openSession: outbox.open,
            waitSession: outbox.wait,
          });
          outbox.setMemory(memory);
          disposers.push(memory.dispose);
        } else {
          ctx.logger.warn("libra: bridge does not advertise memory.recall; Memory module not mounted");
        }
        const tools = new ToolsFacade(bridge, {
          allowRead: true,
          allowWrite: true,
          allowRestore: true,
          allowPushPublish: false,
        });
        if (readLive(config.injectContext) !== false) {
          disposers.push(mountLibraContext(ctx, tools, { pluginName: name }));
        }
        const toolsRuntime = ctx.get("tools");
        if (toolsRuntime !== undefined) {
          disposers.push(registerLibraTools(
            toolsRuntime,
            async () => tools,
            ctx.get("approval") as ApprovalService | undefined,
          ));
        }
        live.root = deployment.repositoryRoot;
        live.ttl = deployment.workspaceLeaseTtlMs;
        const workspace = mountLibraWorkspace(ctx, bridge, {
          repositoryRoot: () => live.root,
          leaseTtlMs: () => live.ttl,
        });
        disposers.push(workspace.dispose);
        runtime = { dispose: shutdown };
      } catch (error) {
        await shutdown();
        throw error;
      }
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  };

  const disposeWatch = ctx.on("session/created", () => {
    void start().catch((error: unknown) => {
      ctx.logger.warn(`libra: activation failed: ${String(error)}`);
    });
  });
  try {
    await start();
  } catch (error) {
    disposeWatch();
    throw error;
  }

  return async (): Promise<void> => {
    disposeWatch();
    await starting;
    await runtime?.dispose();
    runtime = undefined;
  };
}

/**
 * DSH 0.2.2 provides the Host-owned `workingDirectory` service. It is required
 * for session-bound mode; an explicitly configured legacy root remains only
 * as a compatibility path for direct compositions without that service.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const workingDirectory = ctx.get("workingDirectory") as WorkingDirectoryService | undefined;
  if (workingDirectory !== undefined) {
    return applyPerSession(ctx, config, workingDirectory, {
      pluginName: name,
      bridgeEnv,
      mountMemory,
    });
  }

  const explicitRoot = readLive(config.repositoryRoot)?.trim() || process.env.LIBRA_REPO?.trim();
  if (explicitRoot !== undefined && explicitRoot.length > 0) {
    return applyForConfiguredRoot(ctx, config);
  }
  const executable = readLive(config.libraExecutable)?.trim() || process.env.LIBRA_BINARY?.trim();
  if (executable !== undefined && executable.length > 0 && await findExecutable(executable) === undefined) {
    ctx.logger.warn(`libra: Libra executable not found or not executable: ${executable}; plugin inactive`);
  } else {
    ctx.logger.warn("libra: Host workingDirectory is unavailable; plugin inactive");
  }
  return async () => undefined;
}
