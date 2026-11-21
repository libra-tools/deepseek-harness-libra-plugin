/**
 * Libra version-control panel registration, pure view logic and component
 * flows (plan-20261118 LVC-05).
 *
 * The Client bundle is a single `__ModuleLoader__` module, so this spec captures
 * its factory and drives it with a small React hook runtime plus deferred
 * Remote answers. That exercises mount, refresh, cancellation, pagination,
 * history merge, diagnostics and failure-after-diff without a browser.
 */
import { beforeAll, describe, expect, it } from "vitest";

type Captured = { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> };
let captured: Captured | undefined;

interface Element {
  args: [string, Record<string, unknown> | null, ...unknown[]];
}

interface Hook {
  kind: "state" | "ref" | "effect";
  value?: unknown;
  deps?: unknown[];
  cleanup?: () => void;
}

class Runtime {
  readonly hooks: Hook[] = [];
  dirty = true;
  renders = 0;
  tree: unknown;
  unmounted = false;
  private index = 0;
  private readonly effects: Hook[] = [];

  constructor(readonly Component: (props: unknown) => unknown, readonly props: unknown) {}

  render(): void {
    if (this.unmounted) return;
    this.index = 0;
    this.effects.length = 0;
    this.renders += 1;
    this.tree = this.Component(this.props);
    for (const effect of this.effects) effect.cleanup?.();
    for (const effect of this.effects) effect.cleanup = (effect.value as () => void | undefined)?.() ?? undefined;
    this.dirty = false;
  }

  async settle(): Promise<void> {
    for (let step = 0; step < 20; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.dirty) continue;
      this.render();
    }
    if (this.dirty) this.render();
  }

  unmount(): void {
    this.unmounted = true;
    for (const effect of this.hooks) effect.cleanup?.();
  }

  useRef(initial: unknown): { current: unknown } {
    const position = this.index++;
    const hook = this.hooks[position] ?? (this.hooks[position] = { kind: "ref", value: { current: initial } });
    return hook.value as { current: unknown };
  }

  useState(initial: unknown): [unknown, (next: unknown) => void] {
    const position = this.index++;
    const hook = this.hooks[position] ?? (this.hooks[position] = { kind: "state", value: initial });
    const set = (next: unknown): void => {
      if (this.unmounted) return;
      hook.value = typeof next === "function" ? (next as (current: unknown) => unknown)(hook.value) : next;
      this.dirty = true;
    };
    return [hook.value, set];
  }

  useEffect(run: () => void | (() => void), deps?: unknown[]): void {
    const position = this.index++;
    const hook = this.hooks[position] ?? (this.hooks[position] = { kind: "effect" });
    const changed = deps === undefined
      || hook.deps === undefined
      || deps.length !== hook.deps.length
      || deps.some((value, index) => value !== hook.deps![index]);
    if (!changed) return;
    hook.deps = deps;
    hook.value = run;
    this.effects.push(hook);
  }
}

let runtime: Runtime | undefined;
const fakeReact = {
  createElement: (...args: [string, Record<string, unknown> | null, ...unknown[]]): Element => ({ args }),
  useState: (initial: unknown) => runtime!.useState(initial),
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => runtime!.useEffect(run, deps),
  useRef: (initial: unknown) => runtime!.useRef(initial),
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
  internal: Record<string, (...args: never[]) => unknown> & { LibraPanel?: (props: unknown) => unknown };
} {
  if (captured === undefined) throw new Error("bundle was not captured");
  const api = captured.factory((name) => {
    if (name === "react") return fakeReact;
    throw new Error(`unexpected require(${name})`);
  }) as never;
  return api;
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
        return values === undefined ? text : `${text}:${JSON.stringify(values)}`;
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
      inject: (name: string, callback: () => () => void) => {
        const dispose = callback();
        return () => { void name; dispose(); };
      },
      register: (definition: Record<string, unknown>) => {
        slots.push(definition as never);
        return () => undefined;
      },
    },
    remote: {},
    effect: (factory: () => () => void, label: string) => { void label; effects.push(factory()); return () => undefined; },
  };
  return { ctx, effects, tabTypes, slots, dictionaries };
}

/** One controllable call; the panel's AbortSignal only rejects it. */
interface DeferredCall {
  readonly method: "status" | "log" | "diff" | "show";
  readonly params: Record<string, unknown>;
  readonly requestId: string;
  readonly signal: AbortSignal;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

function remoteHarness() {
  const calls: DeferredCall[] = [];
  const pending = new Map<string, DeferredCall[]>();
  const deferred = (method: DeferredCall["method"]) => (
    _sessionId: string,
    params: Record<string, unknown> = {},
    requestId = "",
    signal?: AbortSignal,
  ) => new Promise<unknown>((resolve, reject) => {
    const call: DeferredCall = { method, params, requestId, signal: signal!, resolve, reject };
    calls.push(call);
    const queue = pending.get(method) ?? [];
    queue.push(call);
    pending.set(method, queue);
    signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
  const libra = { call: (method: DeferredCall["method"], params: Record<string, unknown>, requestId: string, signal: AbortSignal) => {
    switch (method) {
      case "status": return deferred("status")("s-1", params, requestId, signal);
      case "log": return deferred("log")("s-1", params, requestId, signal);
      case "diff": return deferred("diff")("s-1", params, requestId, signal);
      case "show": return deferred("show")("s-1", params, requestId, signal);
    }
  } };
  return {
    calls,
    libra,
    take(method: DeferredCall["method"]): DeferredCall {
      const queue = pending.get(method);
      if (queue === undefined || queue.length === 0) throw new Error(`no pending ${method}`);
      return queue.shift()!;
    },
    pendingCount(method: DeferredCall["method"]): number {
      return pending.get(method)?.length ?? 0;
    },
  };
}

function tabHarness() {
  const commands: Array<{ refresh?: () => void }> = [];
  const data = new globalThis.AbortController();
  const tab = {
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: "pane-1", isFloating: false },
    tab: {
      id: "tab-1", kind: "libra-version-control", contentId: "libra",
      title: "Libra", visible: true, signal: data.signal,
      navigation: { address: "libra", params: undefined, revision: 0 },
      actions: {
        bindCommands: (value: { refresh?: () => void }) => { commands.push(value); return () => { const index = commands.indexOf(value); if (index >= 0) commands.splice(index, 1); }; },
        openResource: () => undefined,
        openTab: () => undefined,
        close: () => undefined,
      },
    },
  };
  return { tab, commands, useTabInfo: () => tab, abortSignal: data.signal };
}

async function mountPanel(tracker: ReturnType<typeof remoteHarness>, tabState: ReturnType<typeof tabHarness>, evidence: () => unknown) {
  const api = moduleApi();
  runtime = new Runtime(api.internal.LibraPanel!, {
    t: (key: string, values?: Record<string, string>) => (values === undefined ? `t:${key}` : `t:${key}:${JSON.stringify(values)}`),
    libra: tracker.libra,
    evidence: { session: evidence },
    useTabInfo: tabState.useTabInfo,
    sessionId: "s-1",
  });
  runtime.render();
  // The mount effect starts its Remote calls in a microtask.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return runtime;
}

function textOf(tree: unknown): string {
  if (typeof tree === "string") return tree;
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  if (tree !== null && typeof tree === "object" && "args" in (tree as object)) {
    const element = tree as Element;
    return [element.args[0], textOf(Array.from(element.args).slice(1))].join(" ");
  }
  return "";
}

function button(tree: unknown, label: string): (() => void) | undefined {
  if (tree === null || typeof tree !== "object") return undefined;
  if (Array.isArray(tree)) {
    for (const child of tree) { const found = button(child, label); if (found !== undefined) return found; }
    return undefined;
  }
  if (!("args" in (tree as object))) return undefined;
  const element = tree as Element;
  if (element.args[0] === "button" && textOf(Array.from(element.args).slice(2)).includes(label)) {
    return (element.args[1] as { onClick?: () => void }).onClick;
  }
  for (const child of Array.from(element.args).slice(1)) { const found = button(child, label); if (found !== undefined) return found; }
  return undefined;
}

const statusPage = (entries: Array<Record<string, unknown>>, next: string | null = null) => ({
  ok: true,
  data: { entries: entries.map((entry) => ({ oldPath: null, ...entry })), cursor: { next } },
});
const logPage = (summary: string, next: string | null = null) => ({
  ok: true,
  data: { commits: [{ oid: "a".repeat(40), summary, authorTime: 1 }], cursor: { next } },
});
/** Let a click's Remote dispatch (scheduled in a microtask) reach the harness. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferredEvidence() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((settle) => { resolve = settle; });
  return { session: () => promise, resolve };
}

const evidenceOk = {
  ok: true,
  data: {
    identity: { worktreeId: "wt-1", branch: "main", headOid: null, unborn: true },
    bindingKey: "key-1", sessionCount: 1,
    evidence: {
      executable: "/opt/libra/bin/libra", executableSha256: "e".repeat(64), childPid: 42,
      initialize: { protocol: { major: 1, minor: 2 }, methods: ["vcs.status", "vcs.diff"], source: "deepseek-harness" },
      bundlePackageDir: "/pkg", bundleEntryPath: "/pkg/dist/index.js", bundleEntrySha256: "b".repeat(64),
    },
  },
};

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
  });

  it("registers body and title through slot injection under the tab id", () => {
    const api = moduleApi();
    const harness = fakeContext();
    api.apply(harness.ctx);

    for (const name of ["sidebar.right.pane.tab", "sidebar.right.pane.tab.title"]) {
      const slot = harness.slots.find((entry) => entry.name === name);
      expect(slot?.key).toBe(api.internal.TAB_ID);
      expect(slot?.locale).toBe("libra.settings");
    }
    const body = harness.slots.find((entry) => entry.name === "sidebar.right.pane.tab")!;
    const injected = body.inject!("session-1") as {
      libra: { call: (method: string, params: unknown, requestId: string, signal: AbortSignal) => Promise<unknown> };
      evidence: { session: () => unknown };
    };
    expect(injected.libra).toBeDefined();
    expect(injected.evidence).toBeDefined();
  });

  it("keeps matching en and zh panel dictionaries", () => {
    const api = moduleApi();
    const harness = fakeContext();
    api.apply(harness.ctx);
    const dictionaries = harness.dictionaries["libra.settings"] as { en: Record<string, string>; zh: Record<string, string> };
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries.zh).sort());
    for (const key of ["panelTitle", "panelUnbound", "panelNotRepository", "panelUnsupported", "panelDisconnected", "panelMoved", "statusStaged", "statusMore", "diffTruncated", "historyMore", "diagExecutableHash"]) {
      expect(dictionaries.en).toHaveProperty(key);
      expect(dictionaries.zh).toHaveProperty(key);
    }
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
    expect(groups[3]!.labelKey).toBe("statusFile");
  });

  it("names comparison sides and maps failures to distinct states", () => {
    expect(api().internal.sidesForState("staged")).toBe("index-vs-head");
    expect(api().internal.sidesForState("unstaged")).toBe("worktree-vs-index");
    expect(api().internal.sidesLabelKey("worktree-vs-oid")).toBe("diffSidesOid");
    for (const [kind, state] of [["no_working_directory", "unbound"], ["not_a_repository", "not_repo"], ["cwd_changed", "moved"], ["unsupported_capability", "unsupported"], ["bridge_unavailable", "disconnected"], ["internal", "error"]] as const) {
      expect(api().internal.failureState({ ok: false, error: { kind, message: "x" } })).toMatchObject({ state });
    }
  });

  it("merges history pages and bounds labels", () => {
    const merged = api().internal.mergeHistory(
      { commits: [{ oid: "a".repeat(40), summary: "first", authorTime: 1 }], next: "1" },
      { commits: [{ oid: "b".repeat(40), summary: "second", authorTime: 2 }], cursor: { next: null } },
    ) as { commits: unknown[]; next: string | null };
    expect(merged.commits).toHaveLength(2);
    expect(merged.next).toBeNull();
    expect(api().internal.describeCommit({ oid: "a".repeat(40), summary: "feat: x", authorTime: 1 })).toEqual({ label: "aaaaaaaa feat: x", oid: "a".repeat(40) });
    expect(api().internal.describeEvidence({ ok: false, error: { kind: "no_working_directory" } })).toEqual({ available: false });
  });
});

describe("Libra panel component flows", () => {
  it("paints grouped changes, history, status pagination and refresh binding", async () => {
    const tracker = remoteHarness();
    const tabState = tabHarness();
    const panel = await mountPanel(tracker, tabState, () => evidenceOk);

    expect(tracker.pendingCount("status")).toBe(1);
    expect(tracker.pendingCount("log")).toBe(1);
    tracker.take("status").resolve(statusPage([
      { path: "a.ts", state: "staged" },
      { path: "b.ts", state: "unstaged" },
    ], "2"));
    tracker.take("log").resolve(logPage("first"));
    await panel.settle();

    expect(textOf(panel.tree)).toContain("t:statusStaged (1)");
    expect(textOf(panel.tree)).toContain("a.ts");
    expect(textOf(panel.tree)).toContain("t:historyTitle");
    expect(textOf(panel.tree)).toContain("aaaaaaaa first");
    expect(tabState.commands).toHaveLength(1);

    // Status pagination accumulates the next page instead of replacing it.
    const more = button(panel.tree, "t:statusMore");
    expect(more).toBeDefined();
    more!();
    await tick();
    expect(tracker.pendingCount("status")).toBe(1);
    tracker.take("status").resolve(statusPage([{ path: "c.ts", state: "staged" }], null));
    await panel.settle();
    expect(textOf(panel.tree)).toContain("t:statusStaged (2)");
    expect(textOf(panel.tree)).toContain("c.ts");

    // Refresh binds through the tab and starts a fresh generation.
    const refresh = tabState.commands[0]!.refresh!;
    refresh();
    await tick();
    await panel.settle();
    expect(tracker.pendingCount("status")).toBe(1);
    expect(tracker.pendingCount("log")).toBe(1);
    const refreshed = tracker.take("status");
    expect(refreshed.requestId).toMatch(/^panel-status-/);
    expect(refreshed.requestId).not.toBe(tracker.calls[0]!.requestId);
    refreshed.resolve(statusPage([{ path: "d.ts", state: "staged" }], null));
    tracker.take("log").resolve(logPage("second"));
    await panel.settle();
    expect(textOf(panel.tree)).toContain("d.ts");
    expect(textOf(panel.tree)).toContain("aaaaaaaa second");
    expect(textOf(panel.tree)).not.toContain("a.ts");

    // Unmount releases the refresh binding; the tab lifetime also releases it.
    panel.unmount();
    expect(tabState.commands).toHaveLength(0);
  });

  it("shows an explicit unbound state and clears repository data", async () => {
    const tracker = remoteHarness();
    const tabState = tabHarness();
    const panel = await mountPanel(tracker, tabState, () => ({ ok: true, data: { entries: [] } }));
    tracker.take("status").resolve({ ok: false, error: { kind: "no_working_directory", message: "unbound" } });
    tracker.take("log").resolve(logPage("never"));
    await panel.settle();
    expect(textOf(panel.tree)).toContain("t:panelUnbound");
    expect(textOf(panel.tree)).not.toContain("never");
    panel.unmount();
  });

  it("keeps a loaded diff inert after a mid-read move and clears it on the binding failure", async () => {
    const tracker = remoteHarness();
    const tabState = tabHarness();
    const panel = await mountPanel(tracker, tabState, () => evidenceOk);
    tracker.take("status").resolve(statusPage([{ path: "a.ts", state: "unstaged" }]));
    tracker.take("log").resolve(logPage("first"));
    await panel.settle();

    const select = button(panel.tree, "a.ts");
    select!();
    await tick();
    expect(tracker.pendingCount("diff")).toBe(1);
    tracker.take("diff").resolve({ ok: true, data: { sides: "worktree-vs-index", byteCap: 1024, truncated: false, truncation: "none", files: [{ path: "a.ts", oldPath: null, patch: "PATCH-ONE", truncated: false, truncation: "none" }] } });
    await panel.settle();
    expect(textOf(panel.tree)).toContain("PATCH-ONE");

    // The Session moves during a later read: the stale diff must disappear.
    const commit = button(panel.tree, "aaaaaaaa first");
    commit!();
    await tick();
    tracker.take("show").resolve({ ok: false, error: { kind: "cwd_changed", message: "moved" } });
    await panel.settle();
    expect(textOf(panel.tree)).toContain("t:panelMoved");
    expect(textOf(panel.tree)).not.toContain("PATCH-ONE");
    panel.unmount();
  });

  it("renders diagnostics from the Host record and history pagination", async () => {
    const tracker = remoteHarness();
    const tabState = tabHarness();
    const panel = await mountPanel(tracker, tabState, () => evidenceOk);
    tracker.take("status").resolve(statusPage([]));
    tracker.take("log").resolve(logPage("first", "1"));
    await panel.settle();

    const show = button(panel.tree, "t:diagShow");
    show!();
    await panel.settle();
    const text = textOf(panel.tree);
    expect(text).toContain("/opt/libra/bin/libra");
    expect(text).toContain("e".repeat(64));
    expect(text).toContain("1.2");
    expect(text).toContain("vcs.status");
    expect(text).toContain("/pkg/dist/index.js");

    const more = button(panel.tree, "t:historyMore");
    more!();
    await tick();
    expect(tracker.pendingCount("log")).toBe(1);
    tracker.take("log").resolve(logPage("second", null));
    await panel.settle();
    expect(textOf(panel.tree)).toContain("aaaaaaaa second");
    expect(textOf(panel.tree)).not.toContain("t:historyMore");
    panel.unmount();
  });

  it("ignores late results from a generation superseded by refresh", async () => {
    const tracker = remoteHarness();
    const tabState = tabHarness();
    const panel = await mountPanel(tracker, tabState, () => evidenceOk);
    const firstStatus = tracker.take("status");
    const firstLog = tracker.take("log");

    tabState.commands[0]!.refresh!();
    await tick();
    expect(firstStatus.signal.aborted).toBe(true);
    expect(firstLog.signal.aborted).toBe(true);

    tracker.take("status").resolve(statusPage([{ path: "new.ts", state: "staged" }]));
    tracker.take("log").resolve(logPage("new"));
    await panel.settle();
    expect(textOf(panel.tree)).toContain("new.ts");
    expect(textOf(panel.tree)).not.toContain("old");

    // The superseded promises already rejected; resolving them cannot repaint.
    firstStatus.resolve(statusPage([{ path: "old.ts", state: "staged" }]));
    firstLog.resolve(logPage("old"));
    await panel.settle();
    expect(textOf(panel.tree)).not.toContain("old.ts");
    panel.unmount();
  });

  it("cancels a pending commit detail across refresh", async () => {
    const tracker = remoteHarness();
    const tabState = tabHarness();
    const panel = await mountPanel(tracker, tabState, () => evidenceOk);
    tracker.take("status").resolve(statusPage([]));
    tracker.take("log").resolve(logPage("first"));
    await panel.settle();

    const commit = button(panel.tree, "aaaaaaaa first");
    commit!();
    await tick();
    const pendingShow = tracker.take("show");
    tabState.commands[0]!.refresh!();
    await tick();
    expect(pendingShow.signal.aborted).toBe(true);
    tracker.take("status").resolve(statusPage([]));
    tracker.take("log").resolve(logPage("second"));
    await panel.settle();
    expect(textOf(panel.tree)).not.toContain("t:detailTitle");
    pendingShow.resolve({ ok: true, data: { oid: "b".repeat(40), summary: "stale", parents: [], files: [], cursor: { next: null } } });
    await panel.settle();
    expect(textOf(panel.tree)).not.toContain("t:detailTitle");
    panel.unmount();
  });

  it("clears diagnostics on a binding failure and refuses a late evidence answer", async () => {
    const tracker = remoteHarness();
    const tabState = tabHarness();
    const evidence = deferredEvidence();
    const panel = await mountPanel(tracker, tabState, () => evidence.session());
    tracker.take("status").resolve(statusPage([{ path: "a.ts", state: "unstaged" }], "2"));
    tracker.take("log").resolve(logPage("first"));
    evidence.resolve(evidenceOk);
    await panel.settle();

    const show = button(panel.tree, "t:diagShow");
    show!();
    await panel.settle();
    expect(textOf(panel.tree)).toContain("/opt/libra/bin/libra");

    // A later status page reports a moved Session: every channel is invalidated.
    const more = button(panel.tree, "t:statusMore");
    more!();
    await tick();
    tracker.take("status").resolve({ ok: false, error: { kind: "cwd_changed", message: "moved" } });
    await panel.settle();
    expect(textOf(panel.tree)).toContain("t:panelMoved");
    expect(textOf(panel.tree)).not.toContain("/opt/libra/bin/libra");

    // A late diagnostics answer cannot repopulate the panel.
    evidence.resolve(evidenceOk);
    await panel.settle();
    expect(textOf(panel.tree)).not.toContain("/opt/libra/bin/libra");
    panel.unmount();
  });

  it("keeps two mounted Sessions isolated", async () => {
    const first = remoteHarness();
    const second = remoteHarness();
    const firstTab = tabHarness();
    const secondTab = tabHarness();
    const firstPanel = await mountPanel(first, firstTab, () => evidenceOk);
    first.take("status").resolve(statusPage([{ path: "session-a.ts", state: "staged" }], "2"));
    first.take("log").resolve(logPage("session-a"));
    await firstPanel.settle();
    expect(textOf(firstPanel.tree)).toContain("session-a.ts");

    // Left pending on purpose: its late result must not reach another Session.
    const lateMore = button(firstPanel.tree, "t:statusMore");
    lateMore!();
    await tick();
    const lateStatus = first.take("status");

    // The first Session's body unmounts when its record disappears; a second
    // Session mounts independently and never inherits its rows.
    firstPanel.unmount();
    const secondPanel = await mountPanel(second, secondTab, () => evidenceOk);
    second.take("status").resolve(statusPage([{ path: "session-b.ts", state: "staged" }]));
    second.take("log").resolve(logPage("session-b"));
    await secondPanel.settle();
    expect(textOf(secondPanel.tree)).toContain("session-b.ts");
    expect(textOf(secondPanel.tree)).not.toContain("session-a.ts");

    // A late result aimed at the unmounted Session cannot repaint anything.
    lateStatus.resolve(statusPage([{ path: "late.ts", state: "staged" }]));
    await firstPanel.settle();
    expect(textOf(secondPanel.tree)).not.toContain("late.ts");
    secondPanel.unmount();
  });
});
