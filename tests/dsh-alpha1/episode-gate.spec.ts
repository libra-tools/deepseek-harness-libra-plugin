import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit";
import {
  createUserMessage, LlmAdapter, type GenerateOptions,
  type LlmResolvedModelInfo, type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@libra-tools/dsh-bundle";
import { expect, it } from "vitest";

class EpisodeGateAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model });
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const text = "For dshcedarepisode, the deployment color is violet.";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

// Run inside the pinned DSH checkout. The DSH model is deterministic; Libra's
// Episode compiler calls the real configured DeepSeek API.
it("generates an Episode from a real DSH turn, persists it, and recalls it after remount", async () => {
  const binary = process.env.LIBRA_BINARY;
  if (!binary) throw new Error("LIBRA_BINARY must identify the current Libra build");
  const previousKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.LIBRA_GATE_KEY_FILE) {
    process.env.DEEPSEEK_API_KEY = readFileSync(process.env.LIBRA_GATE_KEY_FILE, "utf8").trim();
  }
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DeepSeek compiler credentials are required");
  const repositoryRoot = mkdtempSync(join(tmpdir(), "libra-dsh-episode-"));
  const run = (...args: string[]): string => execFileSync(binary, args, {
    cwd: repositoryRoot, encoding: "utf8", env: process.env,
  });
  run("init");
  run("config", "--local", "user.name", "DSH Episode Gate");
  run("config", "--local", "user.email", "dsh-gate@example.invalid");
  writeFileSync(join(repositoryRoot, "README.md"), "DSH Episode generation fixture.\n");
  run("add", "README.md");
  run("commit", "--no-verify", "--no-gpg-sign", "-m", "Initialize isolated Memory gate");
  const database = join(repositoryRoot, ".libra", "libra.db");
  const query = (sql: string): Array<Record<string, unknown>> => JSON.parse(execFileSync(
    "sqlite3", ["-cmd", ".timeout 5000", "-json", database, sql], { encoding: "utf8" },
  ) || "[]");
  const ctx = new Context();
  try {
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(AgentLoop, { agents: [] });
    const model = new EpisodeGateAdapter();
    ctx.llm.registerAdapter(["episode-gate"], model);
    await ctx.plugin(Loader, { baseUrl: import.meta.url });
    const mount = async (captureMemoryEpisodes: boolean): Promise<string> => {
      const id = await ctx.loader.create({
        name: "@libra-tools/dsh-bundle",
        config: { libraExecutable: binary, repositoryRoot, captureMemoryEpisodes },
      });
      await ctx.loader.await();
      expect(ctx.loader.resolve(id)?.fiber).toBeDefined();
      return id;
    };
    const firstMount = await mount(true);
    const first = ctx.agentLoop.create(SessionId("episode-gate-writer"), {
      provider: "episode-gate", model: "episode-gate",
    });
    first.followup(createUserMessage({
      content: [{ type: "text", text: "Record the deployment result for dshcedarepisode." }],
      source: { kind: "user" },
    }));
    await first.whenIdle();
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.messages.some((m) => m.source.kind === "libra-memory")).toBe(false);
    // Unload waits for the completed turn's compiler/write operation.
    await ctx.loader.remove(firstMount);
    await ctx.loader.await();
    const episodes = query("SELECT note_id, revision_oid, root_id, completion_status, code_change_status, goal, summary FROM memory_episode_search_doc");
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ completion_status: "completed", code_change_status: "unchanged" });
    expect(JSON.stringify(episodes[0])).toContain("violet");
    expect(query("SELECT * FROM memory_head WHERE live_revision_oid IS NOT NULL")).toHaveLength(1);
    expect(query("SELECT * FROM memory_revision_index")).toHaveLength(1);
    const structuredNote = JSON.parse(run("cat-file", "-p", String(episodes[0]!.revision_oid)));
    expect(structuredNote.episode.summary.claim).toContain("violet");
    expect(query("SELECT state FROM memory_compile_job")).toEqual([{ state: "idle" }]);

    await mount(false);
    const second = ctx.agentLoop.create(SessionId("episode-gate-reader"), {
      provider: "episode-gate", model: "episode-gate",
    });
    second.followup(createUserMessage({
      content: [{ type: "text", text: "What is the dshcedarepisode deployment color?" }],
      source: { kind: "user" },
    }));
    await second.whenIdle();
    expect(model.requests).toHaveLength(2);
    const injected = model.requests[1]!.messages.find((m) => m.source.kind === "libra-memory");
    expect(injected).toBeDefined();
    const text = injected!.content.map((b) => b.type === "text" ? b.text : "").join("");
    expect(text).toContain("violet");
    const source = injected!.source;
    if (source.kind !== "libra-memory") throw new Error("expected the plugin's typed Memory source");
    expect(source.bundleHash).toBe(`sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`);
    expect(second.session.events.some((event) => event.type === "user/message"
      && JSON.stringify(event.data) === JSON.stringify(injected))).toBe(true);
    expect(query(`SELECT receipt_id FROM context_selection_receipt WHERE receipt_id = '${source.receiptId}'`)).toHaveLength(1);
    const result = { repositoryRoot, database, episode: episodes[0], structuredNote, receiptId: source.receiptId, bundleHash: source.bundleHash };
    console.info(JSON.stringify(result));
    if (process.env.LIBRA_GATE_RECEIPT_FILE) writeFileSync(process.env.LIBRA_GATE_RECEIPT_FILE, JSON.stringify(result, null, 2));
  } finally {
    await ctx.fiber.dispose();
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
}, 240_000);
