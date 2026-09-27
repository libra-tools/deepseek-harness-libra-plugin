import type { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision, RequestErrorAction } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { BridgeClient } from "@libra/dsh-bridge-client";
import type { ResolvedConfig } from "./config.js";
import { acceptedUserQuery, completedResult, memoryMessage, parseDelivery, retireVisibleMemory } from "./memory-delivery.js";

interface SessionState {
  session: Session;
  opened: boolean;
  opening?: Promise<void>;
  capture?: Promise<void>;
  retiring: boolean;
  query: string | undefined;
  refreshed: { turn: number; generation: number } | undefined;
  requests: Set<Promise<unknown>>;
}

/** One mount's state. DSH owns Sessions; this module owns only their bridge work. */
export async function mountMemory(ctx: Context, config: ResolvedConfig, bridge: BridgeClient): Promise<void> {
  const sessions = new Map<Session, SessionState>();
  const retirements = new Map<string, Promise<void>>();
  const pending = new Set<Promise<unknown>>();
  let stopping = false;
  let shutdown: Promise<void> | undefined;

  function track<T>(operation: Promise<T>, state?: SessionState): Promise<T> {
    pending.add(operation);
    state?.requests.add(operation);
    const settled = (): void => {
      pending.delete(operation);
      state?.requests.delete(operation);
    };
    void operation.then(settled, settled);
    return operation;
  }

  function stop(): Promise<void> {
    if (shutdown) return shutdown;
    stopping = true;
    shutdown = (async () => {
      // Async Cordis disposers are concurrent: keep drain and close in ONE effect.
      await Promise.allSettled([...pending]);
      await bridge.close();
      sessions.clear();
    })();
    return shutdown;
  }
  ctx.effect(() => stop);

  function stateFor(session: Session): SessionState {
    let state = sessions.get(session);
    if (!state) {
      state = { session, opened: false, retiring: false, query: undefined, refreshed: undefined, requests: new Set() };
      sessions.set(session, state);
    }
    return state;
  }

  function open(state: SessionState): Promise<void> {
    if (state.opened) return Promise.resolve();
    if (state.opening) return state.opening;
    const opening = (async () => {
      // A new Session may reuse an id. Finish the old close before its new open.
      await retirements.get(String(state.session.id));
      if (stopping || state.retiring) return;
      completedResult(await bridge.requestMethod("session.open", { session_id: String(state.session.id) }));
      state.opened = true;
    })();
    state.opening = opening;
    const settled = (): void => { delete state.opening; };
    void opening.then(settled, settled);
    return opening;
  }

  function recall(state: SessionState, query: string, turn: number) {
    return track((async () => {
      await state.capture;
      if (stopping || state.retiring) return null;
      await open(state);
      if (stopping || state.retiring) return null;
      return parseDelivery(completedResult(await bridge.requestMethod("memory.recall", {
        session_id: String(state.session.id), query_text: query,
        ...(config.captureMemoryEpisodes ? { turn } : {}),
      })));
    })(), state);
  }

  function refreshed(state: SessionState, turn: number, generation: number): boolean {
    return state.refreshed?.turn === turn && state.refreshed.generation === generation;
  }
  function markRefreshed(state: SessionState, turn: number): void {
    state.refreshed = { turn, generation: state.session.surface.replaceGeneration };
  }

  function capture(session: Session, event: SessionEvent): void {
    if (stopping || !config.captureMemoryEpisodes || event.type !== "turn/end" || event.data.reason.kind !== "completed") return;
    const state = sessions.get(session);
    const turn = event.data.turn;
    if (!state || state.retiring || state.refreshed?.turn !== turn || !state.query) return;
    const response = [...session.events].reverse().find((candidate) =>
      candidate.type === "assistant/message" && candidate.data.turn === turn);
    if (response?.type !== "assistant/message" || response.data.interrupted) return;
    const responseText = response.data.message.content
      .flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    if (!responseText.trim()) return;
    const previous = state.capture;
    const goal = state.query;
    // Register synchronously: session/event is observe-only, not an awaited hook.
    state.capture = track((async () => {
      await previous;
      completedResult(await bridge.requestMethod("memory.episode.record", {
        session_id: String(session.id), turn, goal, response_text: responseText,
      }));
    })().catch((error: unknown) => {
      // Settling a best-effort capture is not a claim that an Episode exists.
      ctx.logger.warn(`libra-memory: Episode capture failed: ${String(error)}`);
    }), state);
  }

  function retire(session: Session): void {
    const state = sessions.get(session);
    if (stopping || !state || state.retiring) return;
    state.retiring = true;
    const id = String(session.id);
    const retirement = track((async () => {
      await Promise.allSettled([...state.requests]);
      if (state.opened) completedResult(await bridge.requestMethod("session.close", { session_id: id }));
    })().catch((error: unknown) => {
      ctx.logger.warn(`libra-memory: session retirement failed: ${String(error)}`);
    }).finally(() => {
      sessions.delete(session);
      if (retirements.get(id) === retirement) retirements.delete(id);
    }));
    retirements.set(id, retirement);
  }

  try {
    const negotiated = await track(bridge.connect());
    if (stopping) return;
    if (!negotiated.methods.includes("memory.recall")) throw new Error("Libra bridge does not advertise memory.recall");
    if (config.captureMemoryEpisodes && !negotiated.methods.includes("memory.episode.record")) {
      throw new Error("Libra bridge does not advertise memory.episode.record");
    }
    ctx.on("session/created", (session) => { if (!stopping) stateFor(session); });
    ctx.on("session/disposed", retire);
    ctx.on("session/event", capture);
    ctx.on("session/flush", async (session) => { await sessions.get(session)?.capture; });
    ctx.on("agent/pre-step", async ({ agent, step, turn, signal }, next): Promise<PreStepDecision> => {
      const before = agent.session.surface.replaceGeneration;
      const decision = await next();
      if (stopping || decision.kind === "reject" || signal.aborted) return decision;
      const state = stateFor(agent.session);
      if (state.retiring) return decision;
      const generation = agent.session.surface.replaceGeneration;
      if (step === 1) state.query = acceptedUserQuery(decision.messages);
      if ((step !== 1 && generation <= before) || refreshed(state, turn, generation)) return decision;
      const delivery = state.query === undefined ? null : await recall(state, state.query, turn);
      if (stopping || state.retiring || signal.aborted) return decision;
      retireVisibleMemory(agent.session);
      markRefreshed(state, turn);
      // Preserve upstream fields such as startsRequestSeries, not just messages.
      return delivery?.promptSection ? { ...decision, messages: [...decision.messages, memoryMessage(delivery)] } : decision;
    }, { prepend: true });
    ctx.on("agent/request-error", async ({ agent, turn, signal }, next): Promise<RequestErrorAction> => {
      const before = agent.session.surface.replaceGeneration;
      const action = await next();
      const generation = agent.session.surface.replaceGeneration;
      if (stopping || signal.aborted || action?.kind !== "retry" || generation <= before) return action;
      const state = stateFor(agent.session);
      if (state.retiring || state.query === undefined || refreshed(state, turn, generation)) return action;
      const delivery = await recall(state, state.query, turn);
      if (stopping || state.retiring || signal.aborted) return action;
      retireVisibleMemory(agent.session);
      if (delivery?.promptSection) agent.session.append("user/message", memoryMessage(delivery), { surfaceOp: "append" });
      markRefreshed(state, turn);
      return action;
    }, { prepend: true });
    for (const session of ctx.sessions.list()) stateFor(session);
  } catch (error) {
    await stop();
    throw error;
  }
}
