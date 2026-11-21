/**
 * Bounded Libra context injection into the agent flow.
 *
 * On the first turn (step 1) of each session, the plugin queries
 * `libra_context` through the injector (budget-bounded, redacted) and grounds
 * the agent with a plugin-source user message carrying the resulting snapshot.
 * After that the model queries `libra_context` on demand via the registered
 * tool; no further automatic injection happens, so the surface stays bounded
 * and the per-query Memory recall adapter keeps its own slot.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolsFacade } from "@libra/dsh-tools";
import { ContextInjector } from "@libra/dsh-context";

interface LibraContextSource {
  kind: "libra-context";
  plugin: string;
  form: "snapshot";
  sections: readonly [{ readonly name: "libra-context"; readonly text: string }];
}

declare module "@deepseek-ai/dsh-llm/message" {
  interface MessageSourceMap {
    "libra-context": LibraContextSource;
  }
}

export interface ContextMountOptions {
  /** Plugin name stamped on the injected message source. */
  pluginName: string;
  /** Per-session query intent used for the initial context query. */
  intent?: string;
  /** One mount per repository serves only its own bound sessions. */
  serves?: (session: Session) => boolean;
  /** Always clear per-session context state when a bound session is disposed. */
  servesDisposal?: (session: Session) => boolean;
}

export function mountLibraContext(
  ctx: Context,
  tools: ToolsFacade,
  options: ContextMountOptions,
): () => void {
  const injector = new ContextInjector(tools);
  const injected = new Set<string>();
  const disposers: Array<() => unknown> = [];

  disposers.push(ctx.on("session/disposed", (session) => {
    if (options.servesDisposal !== undefined && !options.servesDisposal(session)) return;
    if (options.servesDisposal === undefined && options.serves !== undefined && !options.serves(session)) return;
    const sessionId = String(session.id);
    injected.delete(sessionId);
    injector.disposeSession(sessionId);
  }));

  disposers.push(ctx.on("agent/pre-step", async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    if (options.serves !== undefined && !options.serves(agent.session)) return next();
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted) return decision;
    // The Host can move the Session while the rest of the step runs; do not
    // ground it with context from the repository it left.
    if (options.serves !== undefined && !options.serves(agent.session)) return decision;
    if (step !== 1 || turn !== 1) return decision;
    const sessionId = String(agent.session.id);
    if (injected.has(sessionId)) return decision;
    const slice = await injector.inject(sessionId, options.intent);
    if (signal.aborted || (options.serves !== undefined && !options.serves(agent.session))) return decision;
    injected.add(sessionId);
    if (slice.text.length === 0) return decision;
    return {
      ...decision,
      messages: [...decision.messages, contextMessage(slice.text, options.pluginName)],
    };
  }));

  return () => {
    for (const dispose of disposers.reverse()) dispose();
    injector.dispose();
  };
}

function contextMessage(text: string, pluginName: string): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: {
      kind: "libra-context",
      plugin: pluginName,
      form: "snapshot",
      sections: [{ name: "libra-context", text }],
    },
  });
}
