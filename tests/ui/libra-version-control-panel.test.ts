/**
 * Libra version-control panel registration and pure view logic
 * (plan-20261118 LVC-05).
 *
 * The Client bundle is a single `__ModuleLoader__` module. This spec captures
 * its factory, supplies a fake React runtime, and asserts the tab type, the
 * keyed slot registrations and the pure helpers the panel renders from.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Captured = { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> };
let captured: Captured | undefined;

const fakeReact = {
  createElement: vi.fn((...args: unknown[]) => ({ args })),
  useState: (initial: unknown) => [initial, () => undefined],
  useEffect: () => undefined,
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (factory: () => unknown) => factory(),
  useSyncExternalStore: () => ({}),
};

beforeAll(async () => {
  (globalThis as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
    load: (definition: Captured) => { captured = definition; },
  };
  await import("../../packages/bundle/client.js");
});

function moduleApi(): {
  inject: string[];
  apply: (ctx: unknown) => void;
  internal: Record<string, (...args: never[]) => unknown>;
} {
  if (captured === undefined) throw new Error("bundle was not captured");
  return captured.factory((name) => {
    if (name === "react") return fakeReact;
    throw new Error(`unexpected require(${name})`);
  }) as never;
}

function fakeContext() {
  const effects: Array<() => void> = [];
  const tabTypes: Record<string, unknown>[] = [];
  const slots: Array<{ name: string; key?: string; locale?: string; inject?: (id: string) => unknown }> = [];
  const dictionaries: Record<string, Record<string, string>> = {};
  const ctx = {
    locale: {
      bind: () => (key: string, values?: Record<string, string>) => {
        const text = `t:${key}`;
        if (values === undefined) return text;
        return `${text}:${JSON.stringify(values)}`;
      },
      register: (namespace: string, value: Record<string, Record<string, string>>) => {
        dictionaries[namespace] = value;
        return () => undefined;
      },
    },
    configForms: { get: () => ({ subscribe: () => () => undefined, getSnapshot: () => ({ value: {} }), mutate: async () => false }) },
    sidebarRightTabs: {
      register: (definition: Record<string, unknown>) => {
        tabTypes.push(definition);
        return () => undefined;
      },
    },
    slots: {
      inject: (name: string, callback: () => () => void) => { void name; return callback(); },
      register: (definition: Record<string, unknown>) => {
        slots.push(definition as never);
        return () => undefined;
      },
    },
    remote: {
      libraVcs: {
        status: async () => ({ ok: true, data: { entries: [], cursor: { next: null } } }),
        log: async () => ({ ok: true, data: { commits: [], cursor: { next: null } } }),
        diff: async () => ({ ok: true, data: { sides: "worktree-vs-index", byteCap: 1024, truncated: false, truncation: "none", files: [] } }),
        show: async () => ({ ok: true, data: { oid: "", summary: "", parents: [], files: [], cursor: { next: null } } }),
      },
      libraEvidence: { session: () => ({ ok: false, error: { kind: "no_working_directory", message: "unbound" } }) },
    },
    effect: (factory: () => () => void, label: string) => { void label; effects.push(factory()); return () => undefined; },
  };
  return { ctx, effects, tabTypes, slots, dictionaries };
}

describe("Libra panel registration", () => {
  it("registers a page-type Libra tab with a guide entry", () => {
    const api = moduleApi();
    const harness = fakeContext();
    api.apply(harness.ctx);

    expect(harness.tabTypes).toHaveLength(1);
    const definition = harness.tabTypes[0]! as {
      id: string; kind: string; patterns?: string[]; title: () => string;
      guide: { id: string; order: number; title: () => string; description: () => string }[];
    };
    expect(definition.id).toBe(api.internal.TAB_ID);
    expect(definition.kind).toBe(api.internal.TAB_KIND);
    expect(definition.patterns).toBeUndefined();
    expect(definition.title()).toBe("t:panelTitle");
    expect(definition.guide).toHaveLength(1);
    expect(definition.guide[0]!.title()).toBe("t:panelGuideTitle");
    expect(definition.guide[0]!.description()).toBe("t:panelGuideDescription");
  });

  it("registers the body under the tab id and injects session-scoped callers", () => {
    const api = moduleApi();
    const harness = fakeContext();
    api.apply(harness.ctx);

    const body = harness.slots.find((slot) => slot.name === "sidebar.right.pane.tab");
    expect(body?.key).toBe(api.internal.TAB_ID);
    expect(body?.locale).toBe("libra.settings");
    expect(typeof body?.inject).toBe("function");
    const injected = body!.inject!("session-1") as {
      libra: { call: (method: string, params: unknown, requestId: string, signal: AbortSignal) => Promise<unknown> };
      evidence: { session: () => unknown };
    };
    expect(injected.libra).toBeDefined();
    expect(injected.evidence).toBeDefined();

    const title = harness.slots.find((slot) => slot.name === "sidebar.right.pane.tab.title");
    expect(title?.key).toBe(api.internal.TAB_ID);
  });

  it("keeps matching en and zh panel dictionaries", () => {
    const api = moduleApi();
    const harness = fakeContext();
    api.apply(harness.ctx);
    const dictionaries = harness.dictionaries["libra.settings"] as { en: Record<string, string>; zh: Record<string, string> };
    const en = Object.keys(dictionaries.en).sort();
    const zh = Object.keys(dictionaries.zh).sort();
    expect(en).toEqual(zh);
    for (const key of [
      "panelTitle", "panelGuideTitle", "panelLoading", "panelRefresh", "panelUnbound",
      "panelNotRepository", "panelUnsupported", "panelDisconnected", "panelMoved", "panelError",
      "statusStaged", "statusUnstaged", "statusUntracked", "statusRename", "statusConflict",
      "diffTitle", "diffSidesWorktree", "diffSidesIndex", "diffBinary", "diffTruncated",
      "historyTitle", "historyMore", "detailTitle",
      "diagTitle", "diagExecutable", "diagExecutableHash", "diagPid", "diagProtocol",
      "diagMethods", "diagBundleDir", "diagBundleEntry", "diagBundleHash",
    ]) {
      expect(dictionaries.en).toHaveProperty(key);
      expect(dictionaries.zh).toHaveProperty(key);
    }
    expect(dictionaries.zh.panelTitle).toBe("Libra");
    expect(dictionaries.en.diffTruncated).toContain("{reason}");
    expect(dictionaries.zh.diffTruncated).toContain("{reason}");
  });
});

describe("Libra panel view logic", () => {
  const api = () => moduleApi();

  it("groups entries in a stable order and keeps unknown states visible", () => {
    const groups = api().internal.groupStatusEntries([
      { path: "a.ts", state: "unstaged", oldPath: null },
      { path: "b.ts", state: "staged", oldPath: null },
      { path: "c.ts", state: "conflict", oldPath: null },
      { path: "d.ts", state: "future", oldPath: null },
    ]) as { state: string; labelKey: string; rows: unknown[] }[];
    expect(groups.map((group) => group.state)).toEqual(["conflict", "staged", "unstaged", "other"]);
    expect(groups[0]!.rows).toHaveLength(1);
    expect(groups[3]!.labelKey).toBe("statusFile");
  });

  it("names the comparison sides a status entry uses", () => {
    expect(api().internal.sidesForState("staged")).toBe("index-vs-head");
    expect(api().internal.sidesForState("rename")).toBe("index-vs-head");
    expect(api().internal.sidesForState("unstaged")).toBe("worktree-vs-index");
    expect(api().internal.sidesForState("untracked")).toBe("worktree-vs-index");
    expect(api().internal.sidesLabelKey("index-vs-head")).toBe("diffSidesIndex");
    expect(api().internal.sidesLabelKey("worktree-vs-oid")).toBe("diffSidesOid");
    expect(api().internal.sidesLabelKey("worktree-vs-index")).toBe("diffSidesWorktree");
  });

  it("maps every typed Host failure to a distinct visible state", () => {
    const cases: Array<[string, string]> = [
      ["no_working_directory", "unbound"],
      ["not_a_repository", "not_repo"],
      ["cwd_changed", "moved"],
      ["unsupported_capability", "unsupported"],
      ["protocol_mismatch", "unsupported"],
      ["bridge_unavailable", "disconnected"],
      ["disconnected", "disconnected"],
      ["cancelled", "cancelled"],
      ["internal", "error"],
    ];
    for (const [kind, state] of cases) {
      expect(api().internal.failureState({ ok: false, error: { kind, message: "x" } })).toMatchObject({
        state,
        key: expect.stringMatching(/^panel/),
      });
    }
    expect(api().internal.failureState({ ok: true, data: {} })).toEqual({ state: "ok" });
  });

  it("merges a history page instead of replacing it", () => {
    const merged = api().internal.mergeHistory(
      { commits: [{ oid: "a".repeat(40), summary: "first", authorTime: 1 }], next: "1" },
      { commits: [{ oid: "b".repeat(40), summary: "second", authorTime: 2 }], cursor: { next: null } },
    ) as { commits: unknown[]; next: string | null };
    expect(merged.commits).toHaveLength(2);
    expect(merged.next).toBeNull();
  });

  it("formats commit summaries without leaking a full oid as the label", () => {
    const label = api().internal.describeCommit({ oid: "a".repeat(40), summary: "feat: x", authorTime: 1 });
    expect(label).toEqual({ label: "aaaaaaaa feat: x", oid: "a".repeat(40) });
  });

  it("describes Host evidence only when it is available", () => {
    expect(api().internal.describeEvidence({ ok: false, error: { kind: "no_working_directory" } })).toEqual({ available: false });
    const described = api().internal.describeEvidence({
      ok: true,
      data: {
        identity: { worktreeId: "wt-1", branch: "main", headOid: null, unborn: true },
        bindingKey: "key-1",
        sessionCount: 2,
        evidence: {
          executable: "/usr/local/bin/libra", executableSha256: "e".repeat(64), childPid: 42,
          initialize: { protocol: { major: 1, minor: 2 }, methods: ["vcs.status"], source: "deepseek-harness" },
          bundlePackageDir: "/pkg", bundleEntryPath: "/pkg/dist/index.js", bundleEntrySha256: "b".repeat(64),
        },
      },
    }) as { available: boolean; protocol: string; methods: string[]; unborn: boolean };
    expect(described).toMatchObject({ available: true, protocol: "1.2", unborn: true });
    expect(described.methods).toEqual(["vcs.status"]);
  });
});
