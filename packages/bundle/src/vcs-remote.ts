/**
 * Client-to-Host Remote namespace for the typed Libra VCS reads
 * (plan-20261118 LVC-04).
 *
 * The `session` resource reader connects each Remote request to DSH's
 * session-level access policy. The Client sends a Session id, not a repository
 * identity; the Host resolves that id against its own live session list and
 * returns a discriminated result so typed failures survive the Remote boundary.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionId } from "@deepseek-ai/dsh-session";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import type {
  VcsDiffParams,
  VcsDiffResult,
  VcsLogParams,
  VcsLogResult,
  VcsShowParams,
  VcsShowResult,
  VcsStatusParams,
  VcsStatusResult,
} from "@libra/dsh-bridge-client";
import { LibraVcsReadService, VcsHostError, type VcsHostFailureKind } from "./vcs-read.js";

/** Resolve one live Host Session by id; the wire never names a repository. */
export type SessionById = (sessionId: SessionId) => Session | undefined;

/** Typed success or explicit failure returned over the Client Remote. */
export type VcsRemoteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { kind: VcsHostFailureKind; message: string; retryable: boolean } };

/** The Client-facing Remote namespace `libraVcs`. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class LibraVcsRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly service: LibraVcsReadService,
    private readonly lookup: SessionById,
  ) {
    super(ctx, "libraVcs");
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  status(
    sessionId: SessionId,
    params: VcsStatusParams = {},
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<VcsRemoteResult<VcsStatusResult>> {
    return this.read(signal, () => this.service.status(this.session(sessionId), params, this.options(signal, requestId)));
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  diff(
    sessionId: SessionId,
    params: VcsDiffParams,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<VcsRemoteResult<VcsDiffResult>> {
    return this.read(signal, () => this.service.diff(this.session(sessionId), params, this.options(signal, requestId)));
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  log(
    sessionId: SessionId,
    params: VcsLogParams = {},
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<VcsRemoteResult<VcsLogResult>> {
    return this.read(signal, () => this.service.log(this.session(sessionId), params, this.options(signal, requestId)));
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  show(
    sessionId: SessionId,
    params: VcsShowParams,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<VcsRemoteResult<VcsShowResult>> {
    return this.read(signal, () => this.service.show(this.session(sessionId), params, this.options(signal, requestId)));
  }

  private options(signal: AbortSignal | undefined, requestId: string | undefined): { signal?: AbortSignal; requestId?: string } {
    return {
      ...(signal === undefined ? {} : { signal }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  private session(sessionId: SessionId): Session {
    const session = this.lookup(sessionId);
    if (session === undefined) {
      throw new VcsHostError("no_working_directory", "the requested Session is not live on this Host");
    }
    return session;
  }

  private async read<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<VcsRemoteResult<T>> {
    if (isAborted(signal)) {
      throw new RemoteError("gateway/cancelled", "Libra VCS read was cancelled", {});
    }
    try {
      const data = await operation();
      if (isAborted(signal)) {
        throw new RemoteError("gateway/cancelled", "Libra VCS read was cancelled", {});
      }
      return { ok: true, data };
    } catch (error) {
      if (isAborted(signal)) {
        throw new RemoteError("gateway/cancelled", "Libra VCS read was cancelled", {}, { cause: error });
      }
      if (error instanceof VcsHostError) {
        return {
          ok: false,
          error: { kind: error.kind, message: error.message, retryable: error.retryable },
        };
      }
      return {
        ok: false,
        error: { kind: "internal", message: "Libra VCS read failed", retryable: false },
      };
    }
  }
}
