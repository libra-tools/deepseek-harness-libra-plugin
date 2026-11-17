/**
 * DSH session-event projection into the Libra bridge outbox.
 *
 * Subscribes the durable, log-only DSH session feed (`session/event`) and
 * maps each committed `SessionEvent` to the bridge `event.append` vocabulary,
 * buffering through the crash-resilient local outbox. `session/flush` (the
 * DSH persistence checkpoint boundary) drains pending entries to the bridge
 * via `event.append` / `session.flush`; `session/disposed` closes the bridge
 * session. Every handler is contained: a capture/flush failure is logged and
 * never rejects the DSH event pipeline.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { OutboxStore, SessionProjectionService } from "@libra/dsh-session";

/** Default outbox location lives outside the repository, under the DSH home. */
function defaultOutboxRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "libra", "outbox");
}

export interface OutboxMountOptions {
  /** Durable outbox directory. Defaults to `$DSH_HOME/libra/outbox`. */
  outboxRoot?: string;
}

/**
 * Mount the session-event projection for the lifetime of `ctx`. Returns a
 * disposer. The outbox directory is created lazily on the first captured
 * event, so a composition that never emits session events leaves no trace.
 */
export function mountLibraOutbox(ctx: Context, bridge: BridgeClient, options: OutboxMountOptions): () => void {
  let projection: SessionProjectionService | undefined;
  const disposers: Array<() => unknown> = [];

  const ensureProjection = (): SessionProjectionService => {
    if (projection === undefined) {
      const outbox = new OutboxStore(options.outboxRoot ?? defaultOutboxRoot());
      projection = new SessionProjectionService(outbox, bridge);
    }
    return projection;
  };

  disposers.push(ctx.on("session/event", (session, event) => {
    try {
      const header = session.header;
      ensureProjection().capture({
        session_id: String(session.id),
        ...(header.parentSession !== undefined
          ? { parent_session_id: String(header.parentSession) }
          : {}),
        event_seq: Number(event.seq),
        event_type: event.type,
        payload: JSON.stringify(event.data),
      });
    } catch (error) {
      ctx.logger.warn(`libra-outbox: event capture failed: ${String(error)}`);
    }
  }));
  disposers.push(ctx.on("session/flush", async (session) => {
    if (projection === undefined) return;
    try {
      await projection.flush(String(session.id));
    } catch (error) {
      ctx.logger.warn(`libra-outbox: flush failed for ${String(session.id)}: ${String(error)}`);
    }
  }));
  disposers.push(ctx.on("session/disposed", (session) => {
    if (projection === undefined) return;
    try {
      projection.dispose(String(session.id));
    } catch (error) {
      ctx.logger.warn(`libra-outbox: dispose failed for ${String(session.id)}: ${String(error)}`);
    }
  }));

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
