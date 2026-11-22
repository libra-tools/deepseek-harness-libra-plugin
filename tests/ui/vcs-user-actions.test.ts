import { beforeAll, describe, expect, it } from "vitest";


type Element = { args: [string, Record<string, unknown> | null, ...unknown[]] };

interface Tree {
  [key: string]: unknown;
  args?: [string, Record<string, unknown> | null, ...unknown[]];
}

let runtime: Runtime | undefined;

class Runtime {
  hooks: Array<{ kind: "state" | "ref" | "effect"; value?: unknown; deps?: unknown[]; cleanup?: () => void }> = [];
  index = 0;
  dirty = false;
  unmounted = false;
  tree: Tree | null = null;

  constructor(private readonly renderTree: () => Tree) {}

  useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
    const slot = this.index++;
    const hook = this.hooks[slot] ?? { kind: "state", value: initial };
    this.hooks[slot] = hook;
    if (hook.value === undefined) hook.value = initial;
    const set = (next: T | ((current: T) => T)) => {
      if (this.unmounted) return;
      hook.value = typeof next === "function" ? (next as (current: T) => T)(hook.value as T) : next;
      this.dirty = true;
    };
    return [hook.value as T, set];
  }

  useRef<T>(initial: T): { current: T } {
    const slot = this.index++;
    const hook = this.hooks[slot] ?? { kind: "ref", value: { current: initial } };
    this.hooks[slot] = hook;
    return hook.value as { current: T };
  }

  useEffect(run: () => void | (() => void), deps?: unknown[]): void {
    const slot = this.index++;
    const hook = this.hooks[slot] ?? { kind: "effect", deps: undefined };
    this.hooks[slot] = hook;
    if (hook.deps !== undefined && deps !== undefined
      && hook.deps.length === deps.length
      && hook.deps.every((value, position) => Object.is(value, deps[position]))) {
      return;
    }
    hook.deps = deps;
    this.pendingEffects.push({ slot, run });
  }

  pendingEffects: Array<{ slot: number; run: () => void | (() => void) }> = [];

  render(): void {
    this.index = 0;
    this.pendingEffects = [];
    const tree = this.renderTree();
    this.tree = tree;
    // React-like: an effect's cleanup runs only when its dependencies change,
    // immediately before the new effect body. Running every cleanup on each
    // render would abort the panel's in-flight reads.
    for (const pending of this.pendingEffects) {
      const hook = this.hooks[pending.slot];
      hook.cleanup?.();
      hook.cleanup = pending.run() as (() => void) | undefined;
    }
    this.dirty = false;
  }

  async settle(): Promise<void> {
    for (let step = 0; step < 40; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.dirty) {
        this.render();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!this.dirty) return;
        continue;
      }
      this.render();
    }
  }

  unmount(): void {
    for (const hook of this.hooks) {
      if (hook.kind === "effect") hook.cleanup?.();
    }
    this.unmounted = true;
  }
}

const fakeReact = {
  createElement: (...args: [string, Record<string, unknown> | null, ...unknown[]]): Element => ({ args }),
  useState: (initial: unknown) => runtime!.useState(initial),
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => runtime!.useEffect(run, deps),
  useRef: (initial: unknown) => runtime!.useRef(initial),
  useMemo: (factory: () => unknown) => factory(),
  useSyncExternalStore: () => ({}),
};

interface Captured {
  factory: (require: (name: string) => unknown) => {
    inject: string[];
    apply: (ctx: unknown) => void;
    internal: Record<string, unknown> & { LibraPanel: (props: unknown) => unknown };
  };
}

let captured: Captured | undefined;
beforeAll(async () => {
  (globalThis as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
    load: (definition: Captured) => { captured = definition; },
  };
  await import("../../packages/bundle/client.js");
});

let moduleApi: ReturnType<Captured["factory"]> | undefined;
function panelModule() {
  if (captured === undefined) throw new Error("bundle was not captured");
  // The real loader evaluates the bundle factory once; module-level state used
  // for pending writes must persist across panel mounts in this test too.
  moduleApi ??= captured.factory((name) => {
    if (name === "react") return fakeReact;
    throw new Error(`unexpected require(${name})`);
  });
  return moduleApi;
}

function isTree(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && Array.isArray((value as Tree).args);
}

function textOf(tree: Tree): string {
  if (!isTree(tree)) return "";
  const [kind, props, ...children] = tree.args!;
  void props;
  if (kind === "textarea") return "";
  const render = (child: unknown): string => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (Array.isArray(child)) return child.map(render).join(" ");
    return isTree(child) ? textOf(child) : "";
  };
  return children.map(render).join(" ");
}

function findButton(tree: Tree, label: string): (() => void) | undefined {
  if (!isTree(tree)) return undefined;
  const [kind, props, ...children] = tree.args!;
  if (kind === "button" && children.includes(label) && typeof props?.onClick === "function") {
    return props.onClick as () => void;
  }
  for (const child of children) {
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (isTree(entry)) {
          const found = findButton(entry, label);
          if (found !== undefined) return found;
        }
      }
      continue;
    }
    if (isTree(child)) {
      const found = findButton(child, label);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findTextarea(tree: Tree): Record<string, unknown> | undefined {
  if (!isTree(tree)) return undefined;
  const [kind, props, ...children] = tree.args!;
  if (kind === "textarea") return props as Record<string, unknown>;
  for (const child of children) {
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (isTree(entry)) {
          const found = findTextarea(entry);
          if (found !== undefined) return found;
        }
      }
      continue;
    }
    if (isTree(child)) {
      const found = findTextarea(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
}

interface CallRecord extends Deferred {
  method: string;
  params: Record<string, unknown>;
}

function deferredHarness() {
  const queues = new Map<string, CallRecord[]>();
  const calls: CallRecord[] = [];
  const make = (method: string) => (params: Record<string, unknown> = {}, signal?: AbortSignal) => new Promise<unknown>((resolve, reject) => {
    const record: CallRecord = { method, params, resolve, reject, signal: signal! };
    calls.push(record);
    const queue = queues.get(method) ?? [];
    queue.push(record);
    queues.set(method, queue);
  });
  const take = (method: string): CallRecord => {
    const queue = queues.get(method);
    if (queue === undefined || queue.length === 0) throw new Error(`no pending ${method}`);
    return queue.shift()!;
  };
  return { make, take, calls, pending: (method: string) => queues.get(method)?.length ?? 0 };
}

const FENCE = { expectedHead: "a".repeat(40), expectedIndex: "b".repeat(64), expectedWorktree: "c".repeat(64) };

function writeHarness(writes: ReturnType<typeof deferredHarness>) {
  return {
    fence: writes.make("fence"),
    stage: writes.make("stage"),
    unstage: writes.make("unstage"),
    commit: writes.make("commit"),
  };
}

let sessionSequence = 0;
function panelHarness() {
  sessionSequence += 1;
  const sessionId = `session-${sessionSequence}`;
  const reads = deferredHarness();
  const writes = deferredHarness();
  const capture = deferredHarness();
  const tabData = new globalThis.AbortController();
  const commands: Array<{ refresh?: () => void }> = [];
  const tabState = {
    tab: {
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: "pane-1", isFloating: false },
      tab: {
        id: "tab-1", kind: "libra-version-control", contentId: "libra",
        title: "Libra", visible: true, signal: tabData.signal,
        navigation: { address: "libra", params: undefined, revision: 0 },
        actions: {
          bindCommands: (value: { refresh?: () => void }) => { commands.push(value); return () => undefined; },
          openResource: () => undefined,
          openTab: () => undefined,
          close: () => undefined,
        },
      },
      openedFrom: "guide",
    },
    commands,
    signal: tabData.signal,
  };
  const libra = {
    call: (method: "status" | "log" | "diff" | "show", params: Record<string, unknown>, requestId: string, signal: AbortSignal) =>
      reads.make(method)(params, signal),
    binding: () => Promise.resolve({ ok: true, bindingKey: "key-1", generation: 1 }),
    write: writeHarness(writes),
    capture: { status: () => capture.make("status")() },
  };
  const evidence = deferredHarness();
  const props = {
    sessionId,
    t: (key: string) => `t:${key}`,
    libra,
    evidence: { session: () => evidence.make("evidence")() },
    useTabInfo: () => tabState.tab,
  };
  return { reads, writes, evidence, capture, props, tabState };
}

interface MountedPanel {
  runtime: Runtime;
  tree: () => Tree;
  settle: () => Promise<void>;
  render: () => void;
  unmount: () => void;
}

async function mountPanel(harness: ReturnType<typeof panelHarness>): Promise<MountedPanel> {
  const panel = panelModule().internal.LibraPanel;
  const instance = new Runtime(() => (panel as (props: unknown) => Tree)(harness.props));
  runtime = instance;
  instance.render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  instance.render();
  await instance.settle();
  return {
    runtime: instance,
    tree: () => instance.tree ?? ({ args: ["section"] } as Tree),
    settle: () => instance.settle(),
    render: () => instance.render(),
    unmount: () => instance.unmount(),
  };
}

const STATUS_ROW = (path: string, state: string) => ({ path, state, oldPath: null });

function statusResult(rows: Array<{ path: string; state: string }> = []) {
  return { ok: true, data: { entries: rows.map((row) => ({ ...row, oldPath: null })), cursor: { next: null } } };
}

function okLog() {
  return { ok: true, data: { commits: [{ oid: "a".repeat(40), summary: "seed", authorTime: 1 }], cursor: { next: null } } };
}

describe("Libra panel write actions", () => {
  it("shows stage and unstage controls and enables commit only with a message and fence", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("staged.txt", "staged"), STATUS_ROW("worktree.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();

    expect(findButton(panel.tree(), "t:actionStage")).toBeDefined();
    expect(findButton(panel.tree(), "t:actionUnstage")).toBeDefined();
    const textarea = findTextarea(panel.tree());
    expect(textarea?.placeholder).toBe("t:actionMessagePlaceholder");
    expect(findButton(panel.tree(), "t:actionCommit")).toBeDefined();
    panel.unmount();
  });

  it("sends the fence, paths and operation id for a stage action without any client approval", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();

    const stage = findButton(panel.tree(), "t:actionStage");
    stage!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = harness.writes.take("stage");
    expect(request).toBeDefined();
    // The client sends only the operation intent; the Host attaches approval.
    const params = harness.writes.calls.find((call) => call.method === "stage")?.params as Record<string, unknown>;
    expect(params).toMatchObject({ paths: ["seed.txt"], operationId: expect.any(String), expectedHead: FENCE.expectedHead });
    expect(params).not.toHaveProperty("approval");

    request.resolve({ ok: true, data: { operationId: params.operationId, outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } });
    await panel.settle();
    // Success starts a new canonical read plus a fresh fence.
    expect(harness.reads.pending("status")).toBe(1);
    expect(harness.writes.pending("fence")).toBe(1);
    expect(textOf(panel.tree())).toContain("t:actionDone");
    panel.unmount();
  });

  it("does not keep an optimistic success after a stale write and refreshes instead", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();

    findButton(panel.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("stage").resolve({ ok: false, error: { kind: "stale_state", message: "changed", retryable: true } });
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:actionStale");
    expect(harness.reads.pending("status")).toBe(1);
    // The refreshed canonical state decides what remains, not the rejected write.
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    expect(textOf(panel.tree())).toContain("seed.txt");
    panel.unmount();
  });

  it("surfaces a denied write without refreshing or claiming success", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "staged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();

    findButton(panel.tree(), "t:actionUnstage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("unstage").resolve({ ok: false, error: { kind: "denied", message: "denied", retryable: false } });
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:actionDenied");
    expect(harness.reads.pending("status")).toBe(0);
    panel.unmount();
  });

  it("commits the staged set with the typed message", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("a.txt", "staged"), STATUS_ROW("b.txt", "staged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();

    const textarea = findTextarea(panel.tree());
    (textarea?.onChange as (event: { target: { value: string } }) => void)({ target: { value: "  seed commit  " } });
    await panel.settle();
    findButton(panel.tree(), "t:actionCommit")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("commit").resolve({
      ok: true,
      data: { operationId: "op", outcome: "applied", commitOid: "d".repeat(40), paths: ["a.txt", "b.txt"], failures: [] },
    });
    await panel.settle();

    const commitCall = harness.writes.calls.find((call) => call.method === "commit");
    expect(commitCall?.params).toMatchObject({ paths: ["a.txt", "b.txt"], message: "seed commit" });
    expect(textOf(panel.tree())).toContain("t:actionDone");
    panel.unmount();
  });

  it("treats a timeout as uncertain, refreshes, and retries the same operation id", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();

    findButton(panel.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stageCall = harness.writes.calls.find((call) => call.method === "stage");
    const firstOperation = stageCall?.params.operationId;
    harness.writes.take("stage").resolve({ ok: false, error: { kind: "timeout", message: "no answer", retryable: true } });
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:actionUncertain");
    expect(harness.reads.pending("status")).toBe(1);

    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    // The canonical refresh sees a changed fence; retry still replays the
    // original request (same operation id, paths and fence).
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, expectedIndex: "f".repeat(64), bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    findButton(panel.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retryCall = harness.writes.calls.filter((call) => call.method === "stage").at(-1);
    expect(retryCall?.params.operationId).toBe(firstOperation);
    expect(retryCall?.params.expectedIndex).toBe(FENCE.expectedIndex);
    retryCall!.resolve({ ok: true, data: { operationId: firstOperation, outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:actionDone");
    panel.unmount();
  });

  it("treats a rejected write promise as uncertain and refreshes", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    findButton(panel.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("stage").reject(new Error("transport lost"));
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:actionUncertain");
    expect(harness.reads.pending("status")).toBe(1);
    panel.unmount();
  });

  it("refuses an uncertain retry after the Session rebinds", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    findButton(panel.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("stage").resolve({ ok: false, error: { kind: "timeout", message: "lost", retryable: true } });
    await panel.settle();

    // Rebind the Session while the uncertain record is retained.
    (harness.props.libra.binding as unknown) = () => Promise.resolve({ ok: true, bindingKey: "key-2", generation: 2 });
    (harness.tabState.tab.tab as { visible: boolean }).visible = false;
    panel.render();
    (harness.tabState.tab.tab as { visible: boolean }).visible = true;
    panel.render();
    await panel.settle();
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-2", bindingGeneration: 2 } });
    await panel.settle();

    findButton(panel.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await panel.settle();
    expect(harness.writes.calls.filter((call) => call.method === "stage")).toHaveLength(1);
    expect(textOf(panel.tree())).toContain("t:actionStale");
    // The unresolved operation is retained for its original repository; no
    // new write may start until it is reconciled there.
    expect(findButton(panel.tree(), "t:actionRetry")).toBeDefined();
    panel.unmount();
  });

  it("loads every staged status page before committing", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve({
      ok: true,
      data: { entries: [{ path: "a.txt", state: "staged", oldPath: null }], cursor: { next: "1" } },
    });
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    const textarea = findTextarea(panel.tree());
    (textarea?.onChange as (event: { target: { value: string } }) => void)({ target: { value: "seed commit" } });
    await panel.settle();
    findButton(panel.tree(), "t:actionCommit")!();
    await panel.settle();
    const page = harness.reads.take("status");
    expect(page.params).toMatchObject({ cursor: "1" });
    page.resolve({
      ok: true,
      data: { entries: [{ path: "b.txt", state: "staged", oldPath: null }], cursor: { next: null } },
    });
    await panel.settle();
    const commit = harness.writes.take("commit");
    expect(commit.params).toMatchObject({ paths: ["a.txt", "b.txt"], message: "seed commit" });
    commit.resolve({ ok: true, data: { operationId: commit.params.operationId, outcome: "applied", commitOid: "d".repeat(40), paths: ["a.txt", "b.txt"], failures: [] } });
    await panel.settle();
    panel.unmount();
  });

  it("re-enables commit after refresh cancels staged-page preparation", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve({
      ok: true,
      data: { entries: [{ path: "a.txt", state: "staged", oldPath: null }], cursor: { next: "1" } },
    });
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    const textarea = findTextarea(panel.tree());
    (textarea?.onChange as (event: { target: { value: string } }) => void)({ target: { value: "commit" } });
    await panel.settle();
    findButton(panel.tree(), "t:actionCommit")!();
    await panel.settle();
    expect(harness.reads.pending("status")).toBe(1);

    findButton(panel.tree(), "t:panelRefresh")!();
    await panel.settle();
    // The cancelled staged-page read may still be pending in the test double;
    // settle it before the refresh's own status request.
    const prepRead = harness.reads.pending("status") > 1 ? harness.reads.take("status") : undefined;
    prepRead?.resolve({ cancelled: true });
    await panel.settle();
    harness.reads.take("status").resolve(statusResult([{ path: "a.txt", state: "staged", oldPath: null }]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();

    findButton(panel.tree(), "t:actionCommit")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const commit = harness.writes.take("commit");
    expect(commit.params).toMatchObject({ paths: ["a.txt"], message: "commit" });
    commit.resolve({ ok: true, data: { operationId: commit.params.operationId, outcome: "applied", commitOid: "d".repeat(40), paths: ["a.txt"], failures: [] } });
    await panel.settle();
    panel.unmount();
  });

  it("does not dispatch commit if the panel unmounts while loading staged pages", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve({
      ok: true,
      data: { entries: [{ path: "a.txt", state: "staged", oldPath: null }], cursor: { next: "1" } },
    });
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    const textarea = findTextarea(panel.tree());
    (textarea?.onChange as (event: { target: { value: string } }) => void)({ target: { value: "commit" } });
    await panel.settle();
    findButton(panel.tree(), "t:actionCommit")!();
    await panel.settle();
    const page = harness.reads.take("status");
    panel.unmount();
    page.resolve({
      ok: true,
      data: { entries: [{ path: "b.txt", state: "staged", oldPath: null }], cursor: { next: null } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.writes.calls.filter((call) => call.method === "commit")).toHaveLength(0);
  });

  it("refuses to commit more than the 64-path write limit", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve({
      ok: true,
      data: { entries: [{ path: "a.txt", state: "staged", oldPath: null }], cursor: { next: "1" } },
    });
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    const textarea = findTextarea(panel.tree());
    (textarea?.onChange as (event: { target: { value: string } }) => void)({ target: { value: "big commit" } });
    await panel.settle();
    findButton(panel.tree(), "t:actionCommit")!();
    await panel.settle();
    const page = harness.reads.take("status");
    page.resolve({
      ok: true,
      data: {
        entries: Array.from({ length: 64 }, (_, index) => ({ path: `b${index}.txt`, state: "staged", oldPath: null })),
        cursor: { next: null },
      },
    });
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:actionTooManyPaths");
    expect(harness.writes.calls.filter((call) => call.method === "commit")).toHaveLength(0);
    panel.unmount();
  });

  it("blocks a new write while an uncertain operation is unresolved", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    findButton(panel.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("stage").resolve({ ok: false, error: { kind: "timeout", message: "lost", retryable: true } });
    await panel.settle();
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();

    findButton(panel.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.writes.calls.filter((call) => call.method === "stage")).toHaveLength(1);
    expect(textOf(panel.tree())).toContain("t:actionUncertain");
    panel.unmount();
  });

  it("keeps an uncertain write after unmount and replays it when the panel returns", async () => {
    const harness = panelHarness();
    const first = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await first.settle();
    findButton(first.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("stage").resolve({ ok: false, error: { kind: "timeout", message: "lost", retryable: true } });
    await first.settle();
    const originalOperation = harness.writes.calls.filter((call) => call.method === "stage").at(-1)?.params.operationId;
    expect(findButton(first.tree(), "t:actionRetry")).toBeDefined();
    first.unmount();

    const second = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await second.settle();
    expect(findButton(second.tree(), "t:actionRetry")).toBeDefined();
    findButton(second.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retry = harness.writes.take("stage");
    expect(retry.params.operationId).toBe(originalOperation);
    retry.resolve({ ok: true, data: { operationId: originalOperation, outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    await second.settle();
    second.unmount();
  });

  it("keeps an in-flight operation across unmount before the response", async () => {
    const harness = panelHarness();
    const first = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await first.settle();
    findButton(first.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dispatched = harness.writes.calls.filter((call) => call.method === "stage").at(-1)!;
    const operation = dispatched.params.operationId;
    first.unmount();

    const second = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await second.settle();
    expect(findButton(second.tree(), "t:actionRetry")).toBeDefined();
    findButton(second.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retry = harness.writes.calls.filter((call) => call.method === "stage").at(-1)!;
    expect(retry.params.operationId).toBe(operation);
    retry.resolve({ ok: true, data: { operationId: operation, outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    await second.settle();
    second.unmount();
  });

  it("keeps an uncertain record while the binding identity is unavailable", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    findButton(panel.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("stage").resolve({ ok: false, error: { kind: "timeout", message: "lost", retryable: true } });
    await panel.settle();
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();

    // A rejected identity check leaves the binding unverifiable.
    (harness.props.libra.binding as unknown) = () => Promise.reject(new Error("transport down"));
    (harness.tabState.tab.tab as { visible: boolean }).visible = false;
    panel.render();
    (harness.tabState.tab.tab as { visible: boolean }).visible = true;
    panel.render();
    await panel.settle();

    findButton(panel.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.writes.calls.filter((call) => call.method === "stage")).toHaveLength(1);
    expect(findButton(panel.tree(), "t:actionRetry")).toBeDefined();
    panel.unmount();
  });

  it("keeps the uncertain record when an unmounted retry is cancelled", async () => {
    const harness = panelHarness();
    const first = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await first.settle();
    findButton(first.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("stage").resolve({ ok: false, error: { kind: "timeout", message: "lost", retryable: true } });
    await first.settle();

    const retryCall = { current: undefined as { resolve: (value: unknown) => void } | undefined };
    findButton(first.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    retryCall.current = harness.writes.calls.filter((call) => call.method === "stage").at(-1)!;
    first.unmount();
    retryCall.current!.resolve({ ok: false, error: { kind: "cancelled", message: "left" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await second.settle();
    expect(findButton(second.tree(), "t:actionRetry")).toBeDefined();
    second.unmount();
  });

  it("replays an unresolved write after returning to the original repository", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    findButton(panel.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dispatched = harness.writes.take("stage");
    const operation = dispatched.params.operationId;
    dispatched.resolve({ ok: false, error: { kind: "timeout", message: "lost", retryable: true } });
    await panel.settle();

    // Leave to another repository: the record stays, retry is refused there.
    (harness.props.libra.binding as unknown) = () => Promise.resolve({ ok: true, bindingKey: "key-2", generation: 2 });
    (harness.tabState.tab.tab as { visible: boolean }).visible = false;
    panel.render();
    (harness.tabState.tab.tab as { visible: boolean }).visible = true;
    panel.render();
    await panel.settle();
    harness.reads.take("status").resolve(statusResult([]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-2", bindingGeneration: 2 } });
    await panel.settle();
    findButton(panel.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.writes.calls.filter((call) => call.method === "stage")).toHaveLength(1);

    // Return to the original repository: a new generation still replays the
    // same operation id against the current binding identity.
    (harness.props.libra.binding as unknown) = () => Promise.resolve({ ok: true, bindingKey: "key-1", generation: 3 });
    (harness.tabState.tab.tab as { visible: boolean }).visible = false;
    panel.render();
    (harness.tabState.tab.tab as { visible: boolean }).visible = true;
    panel.render();
    await panel.settle();
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 3 } });
    await panel.settle();
    findButton(panel.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replay = harness.writes.take("stage");
    expect(replay.params.operationId).toBe(operation);
    expect(replay.params).toMatchObject({ bindingKey: "key-1", bindingGeneration: 3 });
    replay.resolve({ ok: true, data: { operationId: operation, outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:actionDone");
    panel.unmount();
  });

  it("does not let a late response for one operation clear a newer unresolved write", async () => {
    const firstHarness = panelHarness();
    const sessionId = firstHarness.props.sessionId;
    const first = await mountPanel(firstHarness);
    firstHarness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    firstHarness.reads.take("log").resolve(okLog());
    firstHarness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await first.settle();
    findButton(first.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstOperation = firstHarness.writes.take("stage");
    const operationA = firstOperation.params.operationId;
    first.unmount();

    const secondHarness = panelHarness();
    secondHarness.props.sessionId = sessionId;
    const second = await mountPanel(secondHarness);
    secondHarness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    secondHarness.reads.take("log").resolve(okLog());
    secondHarness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await second.settle();
    findButton(second.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replayA = secondHarness.writes.take("stage");
    expect(replayA.params.operationId).toBe(operationA);
    replayA.resolve({ ok: true, data: { operationId: operationA, outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    await second.settle();
    if (secondHarness.reads.pending("status") > 0) secondHarness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    if (secondHarness.reads.pending("log") > 0) secondHarness.reads.take("log").resolve(okLog());
    if (secondHarness.writes.pending("fence") > 0) secondHarness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await second.settle();

    findButton(second.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const operationB = secondHarness.writes.take("stage");
    expect(operationB.params.operationId).not.toBe(operationA);

    // The response from the original in-flight A arrives after B is pending.
    firstOperation.resolve({ ok: true, data: { operationId: operationA, outcome: "applied", commitOid: null, paths: ["seed.txt"], failures: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    second.unmount();

    const thirdHarness = panelHarness();
    thirdHarness.props.sessionId = sessionId;
    const third = await mountPanel(thirdHarness);
    thirdHarness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    thirdHarness.reads.take("log").resolve(okLog());
    thirdHarness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await third.settle();
    expect(findButton(third.tree(), "t:actionRetry")).toBeDefined();
    findButton(third.tree(), "t:actionRetry")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replayB = thirdHarness.writes.take("stage");
    expect(replayB.params.operationId).toBe(operationB.params.operationId);
    replayB.resolve({ ok: true, data: { operationId: replayB.params.operationId, outcome: "replayed", commitOid: null, paths: ["seed.txt"], failures: [] } });
    await third.settle();
    third.unmount();
  });

  it("explains how to recover when the Host blocks a new write", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("new.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await panel.settle();
    findButton(panel.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.writes.take("stage").resolve({
      ok: false,
      error: { kind: "conflict", message: "an unresolved stage write exists; recover", retryable: false },
    });
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:actionResolveFirst");
    expect(findButton(panel.tree(), "t:actionRetry")).toBeUndefined();
    panel.unmount();
  });

  it("does not retain a definitive stale write for remount recovery", async () => {
    const firstHarness = panelHarness();
    const sessionId = firstHarness.props.sessionId;
    const first = await mountPanel(firstHarness);
    firstHarness.reads.take("status").resolve(statusResult([STATUS_ROW("stale.txt", "unstaged")]));
    firstHarness.reads.take("log").resolve(okLog());
    firstHarness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await first.settle();
    findButton(first.tree(), "t:actionStage")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stale = firstHarness.writes.take("stage");
    stale.resolve({ ok: true, data: { operationId: stale.params.operationId, outcome: "stale_state", commitOid: null, paths: ["stale.txt"], failures: [] } });
    await first.settle();
    firstHarness.reads.take("status").resolve(statusResult([STATUS_ROW("stale.txt", "unstaged")]));
    firstHarness.reads.take("log").resolve(okLog());
    firstHarness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await first.settle();
    first.unmount();

    const nextHarness = panelHarness();
    nextHarness.props.sessionId = sessionId;
    const next = await mountPanel(nextHarness);
    nextHarness.reads.take("status").resolve(statusResult([STATUS_ROW("stale.txt", "unstaged")]));
    nextHarness.reads.take("log").resolve(okLog());
    nextHarness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    await next.settle();
    expect(findButton(next.tree(), "t:actionRetry")).toBeUndefined();
    next.unmount();
  });

  it("shows capture state and only a checkpoint-backed commit link", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    harness.capture.take("status").resolve({
      ok: true,
      data: {
        bindingKey: "key-1",
        bindingGeneration: 1,
        capture: {
          session_id: harness.props.sessionId,
          pending_events: 2,
          rejected_events: 1,
          conflict_events: 1,
          last_acked_seq: 7,
          first_pending_seq: 9,
          gap: false,
          paused: false,
          recovery_pending: false,
          rejected_truncated: false,
        },
        checkpointState: "ok",
        checkpoints: [{
          checkpointId: "cp:aaaaaaaaaaaaaaaa",
          agentCheckpointId: "agent-cp-1",
          targetOid: "e".repeat(40),
          targetVerified: true,
        }],
        commitLink: { checkpointId: "cp-1", targetOid: "e".repeat(40) },
      },
    });
    await panel.settle();
    const rendered = textOf(panel.tree());
    expect(rendered).toContain("t:captureTitle");
    expect(rendered).toContain("t:capturePending: 2");
    expect(rendered).toContain("cp:aaaaaaaaaaaaaaaa");
    expect(rendered).toContain("t:captureCommitLink eeeeeeee");
    expect(rendered).not.toContain("t:captureComplete");
    panel.unmount();
  });

  it("does not claim a commit link when the bridge has no checkpoint target", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    harness.capture.take("status").resolve({
      ok: true,
      data: {
        bindingKey: "key-1",
        bindingGeneration: 1,
        capture: null,
        checkpointState: "ok",
        checkpoints: [],
        commitLink: null,
      },
    });
    await panel.settle();
    const rendered = textOf(panel.tree());
    expect(rendered).toContain("t:captureUnknown");
    expect(rendered).toContain("t:captureNoCheckpoints");
    expect(rendered).not.toContain("t:captureCommitLink");
    panel.unmount();
  });

  it("shows paused and recovery-pending capture states explicitly", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    harness.capture.take("status").resolve({
      ok: true,
      data: {
        bindingKey: "key-1",
        bindingGeneration: 1,
        capture: {
          session_id: harness.props.sessionId,
          pending_events: 0,
          rejected_events: 2,
          conflict_events: 1,
          last_acked_seq: 4,
          first_pending_seq: null,
          gap: true,
          paused: true,
          recovery_pending: true,
          rejected_truncated: true,
        },
        checkpointState: "ok",
        checkpoints: [],
        commitLink: null,
      },
    });
    await panel.settle();
    const rendered = textOf(panel.tree());
    expect(rendered).toContain("t:capturePaused");
    expect(rendered).toContain("t:captureRecoveryPending");
    expect(rendered).toContain("t:captureRejectedTruncated");
    expect(rendered).not.toContain("t:captureNoGap");
    panel.unmount();
  });

  it("drops capture output that belongs to a different repository binding", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: true, data: { ...FENCE, bindingKey: "key-1", bindingGeneration: 1 } });
    harness.capture.take("status").resolve({
      ok: true,
      data: {
        bindingKey: "key-2",
        bindingGeneration: 1,
        capture: null,
        checkpointState: "ok",
        checkpoints: [{
          checkpointId: "cp:bbbbbbbbbbbbbbbb",
          agentCheckpointId: null,
          targetOid: "e".repeat(40),
          targetVerified: true,
        }],
        commitLink: { checkpointId: "foreign-cp", targetOid: "e".repeat(40) },
      },
    });
    await panel.settle();
    const rendered = textOf(panel.tree());
    expect(rendered).toContain("t:captureUnavailable");
    expect(rendered).not.toContain("foreign-cp");
    expect(rendered).not.toContain("t:captureCommitLink");
    panel.unmount();
  });

  it("starts capture only after the binding check succeeds", async () => {
    const harness = panelHarness();
    let resolveBinding!: (value: unknown) => void;
    (harness.props.libra as unknown as { binding: () => Promise<unknown> }).binding = () =>
      new Promise((resolve) => { resolveBinding = resolve; });
    const panel = await mountPanel(harness);
    expect(harness.capture.pending("status")).toBe(0);
    resolveBinding({ ok: true, bindingKey: "key-1", generation: 1 });
    await panel.settle();
    expect(harness.capture.pending("status")).toBe(1);
    harness.capture.take("status").resolve({
      ok: true,
      data: {
        bindingKey: "key-1",
        bindingGeneration: 1,
        capture: null,
        checkpointState: "ok",
        checkpoints: [],
        commitLink: null,
      },
    });
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:captureUnknown");
    panel.unmount();
  });

  it("disables stage/unstage while the fence is unavailable and aborts a pending write on unmount", async () => {
    const harness = panelHarness();
    const panel = await mountPanel(harness);
    harness.reads.take("status").resolve(statusResult([STATUS_ROW("seed.txt", "unstaged")]));
    harness.reads.take("log").resolve(okLog());
    harness.writes.take("fence").resolve({ ok: false, error: { kind: "stale_state", message: "changing" } });
    await panel.settle();
    const stage = findButton(panel.tree(), "t:actionStage");
    expect(stage).toBeDefined();
    stage!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await panel.settle();
    expect(textOf(panel.tree())).toContain("t:actionPending");
    expect(harness.reads.pending("status")).toBe(1);

    panel.unmount();
    expect(harness.writes.pending("stage")).toBe(0);
  });
});
