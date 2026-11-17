/**
 * Session-projection unit tracking visible libra-memory nodes.
 *
 * Mirrors the `dsh-tmux-context` pattern: a pure fold over committed session
 * events keeps the set of surface sequences whose events carry a
 * `libra-memory` source (added on delivery) and drops the sequences a
 * `libra-memory-clear` message shadows (stamped into the clear message's
 * source). The durable state survives compaction, so retirement can target
 * exact sequences even after their events are compacted away — the gap the
 * surface scan fallback leaves open.
 */
import { z } from "zod";

import type { SessionEvent, SessionHeader, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session/types";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";

/** Durable fold state: surface sequences of live libra-memory nodes. */
export interface LibraMemoryProjectionState {
  seqs: SessionSeq[];
}

export const libraMemoryProjectionKey = "libraMemory" as const;

/** Validates persisted state before it seeds a fold. */
export const libraMemoryStateSchema = z.object({
  seqs: z.array(z.number()),
});

/** DSH 0.2.2 passes the session header and fork-inherited prefix here. */
export function libraMemoryProjectionInit(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): LibraMemoryProjectionState {
  // This fold starts from the empty surface; both inputs belong to DSH's seed
  // contract and are intentionally unused.
  void header;
  void inheritedEventCount;
  return { seqs: [] };
}

export const libraMemoryProjection = {
  key: libraMemoryProjectionKey,
  stateVersion: 1,
  // Persisted seqs are plain numbers. SessionSeq is a type brand and is not
  // present in the JSON checkpoint, so the schema cannot produce it directly.
  stateSchema: libraMemoryStateSchema as unknown as z.ZodType<LibraMemoryProjectionState>,
  init: libraMemoryProjectionInit,
  apply: libraMemoryProjectionApply,
} satisfies ProjectionDefinition<typeof libraMemoryProjectionKey, LibraMemoryProjectionState>;

/**
 * Pure transition: previous state + one committed event → next state.
 * Returns the same reference for unrelated events (zero downstream work).
 */
export function libraMemoryProjectionApply(
  state: LibraMemoryProjectionState,
  event: SessionEvent,
): LibraMemoryProjectionState {
  if (event.type !== "user/message") return state;
  const source = (event.data as { source?: { kind?: string; seqs?: unknown } }).source;
  if (source === undefined) return state;
  if (source.kind === "libra-memory") {
    const seqs = new Set(state.seqs.map(Number));
    seqs.add(Number(event.seq));
    return { seqs: [...seqs].sort((a, b) => a - b) as SessionSeq[] };
  }
  if (source.kind === "libra-memory-clear") {
    const shadowed = new Set(Array.isArray(source.seqs) ? source.seqs.map(Number) : []);
    const seqs = state.seqs.filter((seq) => !shadowed.has(Number(seq)));
    return { seqs };
  }
  return state;
}
