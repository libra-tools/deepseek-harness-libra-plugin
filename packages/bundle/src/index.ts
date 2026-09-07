import type { Context } from "@deepseek-ai/cordis";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { resolveConfig, type Config } from "./config.js";
import { mountMemory } from "./memory.js";
import "./memory-source.js";

export { Config } from "./config.js";
export const name = "@libra-tools/dsh-bundle";
export const inject = ["agents", "sessions"];

/** Cordis owns this mount and invokes its ordered resource cleanup on unload. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = await resolveConfig(config);
  const bridge = new BridgeClient({
    executable: resolved.libraExecutable,
    cwd: resolved.repositoryRoot,
    requestTimeoutMs: resolved.captureMemoryEpisodes ? 180_000 : 30_000,
    env: {
      PATH: process.env.PATH ?? "",
      LIBRA_SKIP_WEB_BUILD: "1",
      ...(resolved.captureMemoryEpisodes ? {
        LIBRA_DSH_MEMORY_MODEL: resolved.memoryModel,
        ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
      } : {}),
    },
  });
  await mountMemory(ctx, resolved, bridge);
}
