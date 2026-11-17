import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";
import type { CompletedRequest } from "@libra/dsh-bridge-client";

const execFileAsync = promisify(execFile);
const libraBinary = process.env.LIBRA_BINARY;
const requireLibra = it.skipIf(libraBinary === undefined);
const rootPromise = libraBinary === undefined
  ? Promise.resolve(undefined)
  : mkdtemp(join(tmpdir(), "dsh-libra-memory-flow-"));

interface Episode {
  session_id: string;
  turn: number;
  goal: string;
  response_text: string;
}

interface MemoryDelivery {
  prompt_section: string;
  receipt_id: string;
  view_hash: string;
  bundle_hash: string;
  selected_count: number;
  token_budget: number;
}

interface RecordResult {
  recorded: boolean;
  content_hash: string;
}

interface TestRepository {
  cwd: string;
  globalDb: string;
  systemDb: string;
}

function result(request: CompletedRequest): Record<string, unknown> {
  expect(request.error, JSON.stringify(request, null, 2)).toBeUndefined();
  expect(request.state).toBe("success");
  expect(request.result).toBeTypeOf("object");
  expect(request.result).not.toBeNull();
  return request.result as Record<string, unknown>;
}

function delivery(request: CompletedRequest): MemoryDelivery | null {
  const envelope = result(request);
  expect(envelope).toMatchObject({ schema_version: 1 });
  const data = envelope.data as { delivery?: MemoryDelivery | null };
  if (data.delivery === null) return null;
  expect(data.delivery).toBeDefined();
  const value = data.delivery as MemoryDelivery;
  expect(value.receipt_id.length).toBeGreaterThan(0);
  expect(value.view_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(value.bundle_hash).toBe(`sha256:${createHash("sha256").update(value.prompt_section, "utf8").digest("hex")}`);
  expect(value.token_budget).toBeGreaterThanOrEqual(0);
  expect(value.selected_count > 0).toBe(value.prompt_section.length > 0);
  return value;
}

async function call(bridge: BridgeClient, method: string, params: Record<string, unknown>) {
  return result(await bridge.requestMethod(method, params));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isolatedEnvironment(root: string, repo: TestRepository): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    LIBRA_HOME: join(root, "libra-home"),
    LIBRA_CONFIG_GLOBAL_DB: repo.globalDb,
    LIBRA_CONFIG_SYSTEM_DB: repo.systemDb,
    // No caller credentials or provider configuration cross the boundary.
    NO_PROXY: "*",
    no_proxy: "*",
  };
}

async function cli(root: string, repo: TestRepository, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(libraBinary!, args, {
    cwd: repo.cwd,
    env: isolatedEnvironment(root, repo),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function newRepository(root: string, name: string): Promise<TestRepository> {
  const repo: TestRepository = {
    cwd: join(root, name),
    globalDb: join(root, `${name}-global.sqlite3`),
    systemDb: join(root, `${name}-system.sqlite3`),
  };
  await mkdir(repo.cwd);
  const env = isolatedEnvironment(root, repo);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "LIBRA_HOME"]) {
    await mkdir(env[key]!, { recursive: true });
  }
  await cli(root, repo, "init", "--vault", "false");
  // The real bridge resolves libra.repoid from this temporary repository.
  await cli(root, repo, "status", "--short");
  return repo;
}

async function openBridge(root: string, repo: TestRepository, name: string): Promise<BridgeClient> {
  // BridgeClient keeps its fixed argv and env allowlist. A test-owned wrapper
  // supplies isolation after that allowlist and then execs the explicit binary.
  // Its env is derived afresh on each exec, so no user setting survives it.
  const env = isolatedEnvironment(root, repo);
  const assignments = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value ?? "")}`).join("\n");
  const wrapper = join(repo.cwd, `.isolated-libra-${name}`);
  await writeFile(wrapper, `#!/bin/sh\nset -eu\n${assignments}\nexec ${shellQuote(resolve(libraBinary!))} "$@"\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(wrapper, 0o700);
  const bridge = new BridgeClient({
    executable: wrapper,
    cwd: repo.cwd,
    env: { PATH: process.env.PATH ?? "" },
    requestTimeoutMs: 15_000,
  });
  try {
    const initialized = await bridge.connect();
    expect(initialized.protocol).toEqual({ major: 1, minor: 2 });
    expect(initialized.methods).toContain("memory.recall");
    expect(initialized.methods).toContain("memory.episode.record");
    return bridge;
  } catch (error) {
    await bridge.close();
    throw error;
  }
}

async function record(bridge: BridgeClient, episode: Episode, recorded: boolean): Promise<RecordResult> {
  const envelope = await call(bridge, "memory.episode.record", { ...episode });
  const value = envelope.data as RecordResult;
  expect(value.recorded).toBe(recorded);
  expect(value.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  return value;
}

async function recall(bridge: BridgeClient, episode: Episode, queryText = episode.goal) {
  return delivery(await bridge.requestMethod("memory.recall", {
    session_id: episode.session_id,
    query_text: queryText,
    turn: episode.turn,
  }));
}

describe("Libra conversation Memory across real bridge processes", () => {
  let root: string | undefined;
  let repo: TestRepository;
  let otherRepo: TestRepository;
  let disabledRepo: TestRepository;
  let firstEpisode: Episode;
  let secondEpisode: Episode;
  let firstReceipt: MemoryDelivery;
  let secondReceipt: MemoryDelivery;
  let retriedResult: RecordResult;

  beforeAll(async () => {
    root = await rootPromise;
    if (root === undefined) return;
    repo = await newRepository(root, "memory-repo");
    otherRepo = await newRepository(root, "isolated-repo");
    disabledRepo = await newRepository(root, "disabled-repo");
    await cli(root, repo, "config", "set", "--local", "bridge.conversationMemory", "true");
    await cli(root, otherRepo, "config", "set", "--local", "bridge.conversationMemory", "true");
    expect((await cli(root, disabledRepo, "config", "get", "--default", "false", "--local", "bridge.conversationMemory")).trim()).toBe("false");
  }, 90_000);

  afterAll(async () => {
    const temporaryRoot = root;
    if (temporaryRoot === undefined) return;
    const [temporary, canonical] = await Promise.all([realpath(tmpdir()), realpath(temporaryRoot)]);
    expect(canonical.startsWith(`${temporary}/`)).toBe(true);
    expect(canonical).toContain("dsh-libra-memory-flow-");
    await rm(canonical, { recursive: true, force: true });
  });

  requireLibra("denies recording and returns null recall in a never-enabled repository", async () => {
    const episode: Episode = {
      session_id: "memory-disabled",
      turn: 1,
      goal: "Disabled Memory must not persist this marker",
      response_text: "dsh-disabled-memory-6c3941",
    };
    const bridge = await openBridge(root!, disabledRepo, "disabled");
    try {
      await call(bridge, "session.open", { session_id: episode.session_id });
      const write = await bridge.requestMethod("memory.episode.record", episode);
      expect(write.error?.data?.stable_code, JSON.stringify(write)).toBe("LBR-AGENT-035");
      const read = await bridge.requestMethod("memory.recall", {
        session_id: episode.session_id,
        query_text: episode.goal,
        turn: episode.turn,
      });
      const envelope = result(read);
      expect(envelope).toMatchObject({ schema_version: 1, data: { delivery: null } });
      await call(bridge, "session.close", { session_id: episode.session_id });
    } finally {
      await bridge.close();
    }
    const nextProcess = await openBridge(root!, disabledRepo, "disabled");
    try {
      await call(nextProcess, "session.open", { session_id: "memory-disabled-recall" });
      expect(await recall(nextProcess, { ...episode, session_id: "memory-disabled-recall" })).toBeNull();
      await call(nextProcess, "session.close", { session_id: "memory-disabled-recall" });
    } finally {
      await nextProcess.close();
    }
    await expect(readFile(join(disabledRepo.cwd, ".libra", "conversation-memory", "memory.sqlite3")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  requireLibra("recalls recorded content after closing and reopening the process and session", async () => {
    firstEpisode = {
      session_id: "memory-process-one",
      turn: 1,
      goal: "Remember that the 部署颜色 is violet, with marker dsh-memory-9e4f17.",
      response_text: "The durable conversation marker is dsh-memory-9e4f17.",
    };
    const bridge = await openBridge(root!, repo, "main");
    try {
      await call(bridge, "session.open", { session_id: firstEpisode.session_id });
      const firstRecord = await record(bridge, firstEpisode, true);
      const repeated = await record(bridge, firstEpisode, false);
      expect(repeated.content_hash).toBe(firstRecord.content_hash);
      await call(bridge, "session.close", { session_id: firstEpisode.session_id });
    } finally {
      await bridge.close();
    }

    const nextProcess = await openBridge(root!, repo, "main");
    try {
      await call(nextProcess, "session.open", { session_id: "memory-process-two" });
      const recalled = await recall(nextProcess, { ...firstEpisode, session_id: "memory-process-two" }, "部署颜色是什么？");
      expect(recalled).not.toBeNull();
      firstReceipt = recalled!;
      expect(firstReceipt.prompt_section).toContain("dsh-memory-9e4f17");
      await call(nextProcess, "session.close", { session_id: "memory-process-two" });
    } finally {
      await nextProcess.close();
    }
  });

  requireLibra("isolates another repository and replays the same record idempotently across processes", async () => {
    const isolated = await openBridge(root!, otherRepo, "other");
    try {
      await call(isolated, "session.open", { session_id: "isolated-memory-session" });
      const missing = await recall(isolated, { ...firstEpisode, session_id: "isolated-memory-session" });
      if (missing !== null) {
        expect(missing.prompt_section).not.toContain(firstEpisode.response_text);
        expect(missing.selected_count).toBe(0);
      }
      await call(isolated, "session.close", { session_id: "isolated-memory-session" });
    } finally {
      await isolated.close();
    }

    secondEpisode = {
      session_id: "memory-process-three",
      turn: 1,
      goal: "Which marker belongs only to a second conversation?",
      response_text: "The second durable conversation marker is dsh-memory-72c0ae.",
    };
    const bridge = await openBridge(root!, repo, "main");
    try {
      await call(bridge, "session.open", { session_id: secondEpisode.session_id });
      retriedResult = await record(bridge, secondEpisode, true);
    } finally {
      // Closing the process without session.close exercises durable recovery.
      await bridge.close();
    }

    const nextProcess = await openBridge(root!, repo, "main");
    try {
      await call(nextProcess, "session.open", { session_id: secondEpisode.session_id });
      const replay = await record(nextProcess, secondEpisode, false);
      expect(replay.content_hash).toBe(retriedResult.content_hash);
      await call(nextProcess, "session.close", { session_id: secondEpisode.session_id });
      await call(nextProcess, "session.open", { session_id: "memory-process-four" });
      const recallEpisode = { ...secondEpisode, session_id: "memory-process-four" };
      const recalled = await recall(nextProcess, recallEpisode);
      expect(recalled).not.toBeNull();
      secondReceipt = recalled!;
      expect(secondReceipt.prompt_section).toContain("dsh-memory-72c0ae");
      expect(secondReceipt.prompt_section).not.toContain("dsh-disabled-memory-6c3941");
      expect(await recall(nextProcess, recallEpisode)).toEqual(secondReceipt);
      await call(nextProcess, "session.close", { session_id: "memory-process-four" });
    } finally {
      await nextProcess.close();
    }
  });
});
