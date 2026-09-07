import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import type { Agent } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit";
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@libra-tools/dsh-bundle";
import { afterEach, describe, expect, it } from "vitest";

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  failNext = false;
  onRequest?: () => void;
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    this.onRequest?.();
    if (this.failNext) {
      this.failNext = false;
      yield { type: "finish", reason: { kind: "error", failure: { code: "CONTEXT_LENGTH_EXCEEDED", message: "test overflow" } } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "verified response" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "verified response" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
const user = (text: string) => createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });
const memories = (request: GenerateOptions) => request.messages.filter((message) => message.source.kind === "libra-memory");
interface PeerEvent { event: string; method?: string; params?: { session_id?: string; query_text?: string; goal?: string; response_text?: string } }

describe("real Cordis/DSH memory lifecycle", () => {
  const contexts: Context[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    // Release a held peer even after an assertion fails, then drain real fibers.
    for (const dir of directories) writeFileSync(join(dir, "release"), "");
    await Promise.all(contexts.map((ctx) => ctx.fiber.dispose()));
    for (const dir of directories) rmSync(dir, { recursive: true, force: true });
    contexts.length = 0;
    directories.length = 0;
  });

  async function setup(captureMemoryEpisodes = false, preexisting = false, beforeMount?: (ctx: Context) => void) {
    const dir = mkdtempSync(join(tmpdir(), "libra-lifecycle-"));
    directories.push(dir);
    const ctx = new Context();
    contexts.push(ctx);
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(AgentLoop, { agents: [] });
    const adapter = new CaptureAdapter();
    ctx.llm.registerAdapter(["capture"], adapter);
    const create = (id: string) => ctx.agentLoop.create(SessionId(id), { provider: "capture", model: "capture" });
    const existing = preexisting ? create("existing") : undefined;
    beforeMount?.(ctx);
    await ctx.plugin(Loader, { baseUrl: import.meta.url });
    const mount = async () => {
      const id = await ctx.loader.create({ name: "@libra-tools/dsh-bundle", config: {
        libraExecutable: process.env.LIBRA_LIFECYCLE_PEER, repositoryRoot: dir, captureMemoryEpisodes,
      } });
      await ctx.loader.await();
      expect(ctx.loader.resolve(id)?.fiber).toBeDefined();
      return id;
    };
    const id = await mount();
    const events = (): PeerEvent[] => readFileSync(join(dir, "bridge-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const requests = (method: string) => events().filter((event) => event.event === "request" && event.method === method);
    const hold = (method: string) => writeFileSync(join(dir, "control.json"), JSON.stringify({ hold: method }));
    const fail = (method: string) => writeFileSync(join(dir, "control.json"), JSON.stringify({ fail: method }));
    const release = () => writeFileSync(join(dir, "release"), "");
    const unmount = async () => { await ctx.loader.remove(id); await ctx.loader.await(); };
    const turn = async (agent: Agent, query: string) => {
      const idle = new Promise<void>((resolve) => {
        const off = ctx.on("agent/status", ({ agent: subject, status }) => {
          if (subject === agent && status === "idle") { off(); resolve(); }
        });
      });
      agent.followup(user(query));
      await idle;
    };
    return { ctx, adapter, create, existing, mount, events, requests, hold, fail, release, unmount, turn };
  }

  it.each(["zero-hit", "null-delivery"])("replaces old memory on %s without deleting durable history", async (query) => {
    const h = await setup(false, true);
    const agent = h.existing!;
    await h.turn(agent, "first fact");
    expect(memories(h.adapter.requests[0]!)).toHaveLength(1);
    await h.turn(agent, query);
    expect(memories(h.adapter.requests[1]!)).toHaveLength(0);
    expect(agent.session.events.some((event) => event.type === "user/message" && event.data.source.kind === "libra-memory")).toBe(true);
    expect(h.requests("session.open")).toHaveLength(1);
    expect(h.requests("memory.recall").map((event) => event.params?.query_text)).toEqual(["first fact", query]);
  });

  it("settles capture before session flush and subsequent recall", async () => {
    const h = await setup(true);
    const agent = h.create("capture");
    h.hold("memory.episode.record");
    await h.turn(agent, "remember fact");
    await expect.poll(() => h.requests("memory.episode.record").length).toBe(1);
    let flushed = false;
    const flush = h.ctx.sessions.flush(agent.session).then(() => { flushed = true; });
    const second = h.turn(agent, "recorded-episode");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(flushed).toBe(false);
    expect(h.requests("memory.recall")).toHaveLength(1);
    h.release();
    await Promise.all([flush, second]);
    expect(flushed).toBe(true);
    expect(h.requests("memory.episode.record")[0]?.params).toMatchObject({ goal: "remember fact", response_text: "verified response" });
    expect(JSON.stringify(memories(h.adapter.requests[1]!))).toContain("remember fact");
  });

  it.each(["session.open", "memory.recall", "memory.episode.record"])("unload drains delayed %s and leaves DSH's session alive", async (method) => {
    const h = await setup(true);
    const agent = h.create("drain");
    h.hold(method);
    const turn = h.turn(agent, "delayed fact");
    await expect.poll(() => h.requests(method).length).toBe(1);
    let removed = false;
    const unload = h.unmount().then(() => { removed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(removed).toBe(false);
    expect(h.events().some((event) => event.event === "stopped")).toBe(false);
    h.release();
    await Promise.all([turn, unload]);
    expect(h.events().at(-1)?.event).toBe("stopped");
    expect(h.ctx.sessions.list()).toContain(agent.session);
    expect(h.requests("session.close")).toHaveLength(0);
    if (method !== "memory.episode.record") expect(memories(h.adapter.requests[0]!)).toHaveLength(0);
    await h.mount();
    await h.turn(agent, "after reload");
    expect(memories(h.adapter.requests.at(-1)!)).toHaveLength(1);
  });

  it("isolates two sessions and two independent Context mounts", async () => {
    const a = await setup();
    const b = await setup();
    await Promise.all([a.turn(a.create("same-id"), "alpha"), a.turn(a.create("other-id"), "beta"), b.turn(b.create("same-id"), "gamma")]);
    expect(a.requests("memory.recall").map((event) => event.params?.query_text).sort()).toEqual(["alpha", "beta"]);
    expect(b.requests("memory.recall").map((event) => event.params?.query_text)).toEqual(["gamma"]);
    for (const request of [...a.adapter.requests, ...b.adapter.requests]) expect(memories(request)).toHaveLength(1);
  });

  it.each(["reject", "cancel"])("does not recall after downstream %s", async (kind) => {
    const h = await setup();
    const agent = h.create(kind);
    h.ctx.on("agent/pre-step", async ({ agent }, next) => {
      if (kind === "reject") return { kind: "reject" };
      agent.cancel({ kind: "user" });
      return next();
    });
    await h.turn(agent, "must not recall");
    expect(h.requests("session.open")).toHaveLength(0);
    expect(h.requests("memory.recall")).toHaveLength(0);
    expect(h.adapter.requests).toHaveLength(0);
  });

  it("uses only downstream-admitted user input and preserves request-series decisions", async () => {
    const h = await setup();
    const agent = h.create("admitted");
    h.ctx.on("agent/pre-step", async ({ step }, next) => {
      const decision = await next();
      if (decision.kind === "reject") return decision;
      return step === 1 ? { ...decision, messages: [user("admitted query"), createUserMessage({
        content: [{ type: "text", text: "not a user query" }],
        source: { kind: "plugin", plugin: "test", form: "snapshot", sections: [] },
      })] } : { ...decision, startsRequestSeries: true };
    });
    h.adapter.onRequest = () => { if (h.adapter.requests.length === 1) agent.steer(user("continue")); };
    await h.turn(agent, "replaced original");
    expect(h.adapter.requests).toHaveLength(2);
    expect(h.requests("memory.recall").map((event) => event.params?.query_text)).toEqual(["admitted query"]);
    expect(agent.session.events.some((event) => event.type === "request/header" && event.data.reason === "series")).toBe(true);
  });

  it.each(["pre-step", "request-error"])("refreshes after real surface replacement in %s", async (hook) => {
    const replace = (agent: Agent) => {
      const nodes = [...agent.session.surface.nodes];
      agent.session.append("user/message", user("compacted context"), {
        surfaceOp: { op: "replace", start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: nodes,
      });
    };
    // Recovery may be installed before Libra and own retry without calling next.
    const h = await setup(false, false, hook === "request-error" ? (ctx) => {
      ctx.on("agent/request-error", async ({ agent }) => { replace(agent); return { kind: "retry" }; });
    } : undefined);
    const agent = h.create(hook);
    if (hook === "pre-step") {
      h.adapter.onRequest = () => { if (h.adapter.requests.length === 1) agent.steer(user("continue")); };
      h.ctx.on("agent/pre-step", async ({ step }, next) => {
        const decision = await next();
        if (step === 2) replace(agent);
        return decision;
      });
    } else {
      h.adapter.failNext = true;
    }
    await h.turn(agent, "original query");
    expect(h.adapter.requests).toHaveLength(2);
    expect(h.requests("memory.recall").map((event) => event.params?.query_text)).toEqual(["original query", "original query"]);
    expect(agent.session.surface.replaceGeneration).toBeGreaterThan(0);
    expect(memories(h.adapter.requests[1]!)).toHaveLength(1);
    expect(JSON.stringify(h.adapter.requests[1]!.messages)).toContain("compacted context");
    expect(memories(h.adapter.requests[1]!)[0]?.id).not.toBe(memories(h.adapter.requests[0]!)[0]?.id);
  });

  it("rejects a mismatched delivery hash before a model request", async () => {
    const h = await setup();
    const agent = h.create("bad-hash");
    await h.turn(agent, "hash-mismatch");
    expect(h.adapter.requests).toHaveLength(0);
    expect(agent.session.events.some((event) => event.type === "turn/end" && event.data.reason.kind === "error")).toBe(true);
  });

  it("observes capture failure without blocking flush or claiming an Episode", async () => {
    const h = await setup(true);
    const warnings: string[] = [];
    h.ctx.logger.exporter({ levels: { default: 3 }, export: (message) => {
      if (message.type === "warn") warnings.push(message.args.map(String).join(" "));
    } });
    h.fail("memory.episode.record");
    const agent = h.create("failed-capture");
    await h.turn(agent, "unrecorded fact");
    await h.ctx.sessions.flush(agent.session);
    expect(h.events().filter((event) => event.event === "error" && event.method === "memory.episode.record")).toHaveLength(1);
    expect(warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Episode capture failed.*LBR-MEMORY-005/)]));
    await h.turn(agent, "recorded-episode");
    expect(memories(h.adapter.requests[1]!)[0]?.content).toEqual([{ type: "text", text: "null" }]);
  });

  it("waits for the retired Session close before opening a reused id", async () => {
    const h = await setup();
    const first = await h.ctx.agents.create({
      sessionId: SessionId("reused"), agentOptions: { provider: "capture", model: "capture" },
    });
    await h.turn(first.agent, "old session");
    h.hold("session.close");
    await first.dispose();
    await expect.poll(() => h.requests("session.close").length).toBe(1);
    expect(h.ctx.sessions.get(SessionId("reused"))).toBeUndefined();
    const second = h.create("reused");
    expect(second.session).not.toBe(first.agent.session);
    const turn = h.turn(second, "new session");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.requests("session.open")).toHaveLength(1);
    h.release();
    await turn;
    expect(h.requests("session.open")).toHaveLength(2);
    const events = h.events();
    const closeResponse = events.findIndex((event) => event.event === "response" && event.method === "session.close");
    expect(events.findLastIndex((event) => event.event === "request" && event.method === "session.open")).toBeGreaterThan(closeResponse);
    expect(memories(h.adapter.requests.at(-1)!)).toHaveLength(1);
  });

  it("does not publish a late recall after the real Agent is cancelled", async () => {
    const h = await setup();
    const agent = h.create("cancel-inflight");
    h.hold("memory.recall");
    const turn = h.turn(agent, "cancelled fact");
    await expect.poll(() => h.requests("memory.recall").length).toBe(1);
    agent.cancel({ kind: "user" });
    h.release();
    await turn;
    expect(h.adapter.requests).toHaveLength(0);
    expect(agent.session.events.some((event) => event.type === "user/message" && event.data.source.kind === "libra-memory")).toBe(false);
    await h.turn(agent, "next fact");
    expect(memories(h.adapter.requests[0]!)).toHaveLength(1);
  });
});
