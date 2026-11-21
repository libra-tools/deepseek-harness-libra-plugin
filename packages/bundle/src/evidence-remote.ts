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
  /** Binding generation; distinguishes a replacement bridge on the same worktree. */
  readonly generation: number;
  readonly sessionCount: number;
  readonly evidence: BridgeEvidenceInfo;
};

export type EvidenceResult =
  | { ok: true; data: SessionEvidence }
  | { ok: false; error: { kind: string; message: string } };

/** Inputs the Host gathers for one Session before deciding whether to show evidence. */
export interface EvidenceInput {
  /** Recorded binding failure for this Session, if any. */
  failure?: { kind: string };
  /** Whether the Session is live on this Host. */
  sessionLive: boolean;
  /** Whether the recorded binding still exists live. */
  recordKeyMatches: boolean;
  /** Whether the bridge child behind that binding is still connected. */
  connected: boolean;
  /** The Session's current Host directory and the directory recorded at bind time. */
  hostDirectory?: string;
  boundDirectory?: string;
  sameDirectory: (left: string, right: string) => boolean;
}

/**
 * Decide whether the recorded evidence describes the Session's current
 * repository. Pure so every isolation rule is unit-testable; the caller
 * supplies only Host-read facts.
 */
export function evaluateSessionEvidence(input: EvidenceInput): { ok: true } | { ok: false; error: { kind: string; message: string } } {
  if (input.failure !== undefined) {
    return { ok: false, error: { kind: input.failure.kind, message: "this Session's repository binding is not usable" } };
  }
  if (!input.sessionLive) {
    return { ok: false, error: { kind: "no_working_directory", message: "this Session is not live on this Host" } };
  }
  if (!input.recordKeyMatches || input.hostDirectory === undefined || input.boundDirectory === undefined
    || !input.sameDirectory(input.hostDirectory, input.boundDirectory)) {
    return { ok: false, error: { kind: "cwd_changed", message: "this Session is not bound to the repository its live bridge serves" } };
  }
  if (!input.connected) {
    return { ok: false, error: { kind: "disconnected", message: "the repository bridge is not connected" } };
  }
  return { ok: true };
}

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
