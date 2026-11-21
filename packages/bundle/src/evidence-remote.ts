/**
 * Client-to-Host Remote namespace for live Libra bridge diagnostics
 * (plan-20261118 LVC-05).
 *
 * The panel shows the evidence the Host recorded for the Session's live bridge
 * in LVC-03: resolved executable, its SHA-256, child PID, the frozen
 * `initialize` result, and the running bundle entry path and hash. Values are
 * read from the Host registry, never from a separately spawned probe or a
 * configuration guess, and the whole record is Host-only.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/** Evidence frozen when a bridge was created. */
export type BridgeEvidenceInfo = {
  readonly executable: string;
  readonly executableSha256: string;
  readonly childPid: number | undefined;
  readonly initialize: {
    readonly protocol: { readonly major: number; readonly minor: number };
    readonly limits: unknown;
    readonly methods: readonly string[];
    readonly source: string;
  };
  readonly bundlePackageDir: string;
  readonly bundleEntryPath: string;
  readonly bundleEntrySha256: string;
};

/** Everything the panel may show for one bound Session. */
export type SessionEvidence = {
  readonly identity: {
    readonly worktreeId: string;
    readonly worktreeRootHash: string;
    readonly headOid: string | null;
    readonly branch: string | null;
    readonly unborn: boolean;
  };
  readonly bindingKey: string;
  readonly sessionCount: number;
  readonly evidence: BridgeEvidenceInfo;
};

export type EvidenceResult =
  | { ok: true; data: SessionEvidence }
  | { ok: false; error: { kind: string; message: string } };

/** Resolve the live evidence of one Session; Host-owned registry only. */
export type EvidenceResolver = (sessionId: SessionId) => EvidenceResult;

/** The Client-facing Remote namespace `libraEvidence`. */
export class LibraEvidenceRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly resolve: EvidenceResolver) {
    super(ctx, "libraEvidence");
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  session(sessionId: SessionId): EvidenceResult {
    return this.resolve(sessionId);
  }
}
