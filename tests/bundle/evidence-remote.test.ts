/**
 * Host bridge-evidence Remote namespace (plan-20261118 LVC-05).
 *
 * The panel reads the Host's recorded evidence through `libraEvidence`; the
 * namespace must carry the session resource and return the typed failure for an
 * unbound Session instead of inventing a probe.
 */
import { describe, expect, it } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { LibraEvidenceRemote, type SessionEvidence } from "@libra/dsh-bundle";

const evidence: SessionEvidence = {
  identity: { worktreeId: "wt-1", worktreeRootHash: "r".repeat(64), headOid: null, branch: "main", unborn: true },
  bindingKey: "key-1",
  sessionCount: 1,
  evidence: {
    executable: "/opt/libra/libra",
    executableSha256: "e".repeat(64),
    childPid: 42,
    initialize: { protocol: { major: 1, minor: 2 }, limits: {}, methods: ["vcs.status"], source: "deepseek-harness" },
    bundlePackageDir: "/pkg",
    bundleEntryPath: "/pkg/dist/index.js",
    bundleEntrySha256: "b".repeat(64),
  },
};

describe("libraEvidence namespace", () => {
  it("declares a Session-scoped method and returns the Host record", () => {
    const service = new LibraEvidenceRemote(new Context(), (sessionId) =>
      String(sessionId) === "s-1" ? { ok: true, data: evidence } : { ok: false, error: { kind: "no_working_directory", message: "unbound" } });

    const markers = remoteMethods(service);
    expect(markers.map((marker) => marker.method)).toEqual(["session"]);
    expect(markers[0]?.resources?.session).toBeDefined();
    expect(service.session("s-1" as never)).toEqual({ ok: true, data: evidence });
    expect(service.session("missing" as never)).toEqual({
      ok: false,
      error: { kind: "no_working_directory", message: "unbound" },
    });
  });

  it("returns the recorded hashes unchanged for panel display", () => {
    const result = new LibraEvidenceRemote(new Context(), () => ({ ok: true, data: evidence })).session("s-1" as never);
    expect(result).toMatchObject({
      ok: true,
      data: {
        evidence: {
          executableSha256: "e".repeat(64),
          bundleEntrySha256: "b".repeat(64),
          bundleEntryPath: "/pkg/dist/index.js",
          initialize: { protocol: { major: 1, minor: 2 }, methods: ["vcs.status"] },
        },
      },
    });
  });
});
