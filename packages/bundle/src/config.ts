import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";

/** Deployment-owned locations. Memory policy remains server-owned by Libra. */
export interface Config {
  libraExecutable?: string;
  repositoryRoot?: string;
  captureMemoryEpisodes?: boolean;
  memoryModel?: string;
}

export const Config: z<Config> = z.object({
  libraExecutable: z.string(),
  repositoryRoot: z.string(),
  captureMemoryEpisodes: z.boolean().default(false),
  memoryModel: z.string().default("deepseek-chat"),
});

export interface ResolvedConfig {
  libraExecutable: string;
  repositoryRoot: string;
  captureMemoryEpisodes: boolean;
  memoryModel: string;
}

export async function resolveConfig(config: Config): Promise<ResolvedConfig> {
  const configuredBinary = config.libraExecutable ?? process.env.LIBRA_BINARY;
  if (!configuredBinary) {
    throw new Error("libraExecutable or LIBRA_BINARY must be configured");
  }
  if (!isAbsolute(configuredBinary)) {
    throw new Error("libraExecutable must be an absolute path");
  }
  const libraExecutable = await realpath(configuredBinary);
  const executableStat = await stat(libraExecutable);
  if (!executableStat.isFile()) throw new Error("libraExecutable must name a file");
  await access(libraExecutable, constants.X_OK);

  const configuredRepository = config.repositoryRoot ?? process.env.LIBRA_REPO ?? process.cwd();
  const repositoryRoot = await realpath(resolve(configuredRepository));
  const repositoryStat = await stat(repositoryRoot);
  if (!repositoryStat.isDirectory()) throw new Error("repositoryRoot must name a directory");
  return {
    libraExecutable, repositoryRoot,
    captureMemoryEpisodes: config.captureMemoryEpisodes ?? false,
    memoryModel: config.memoryModel ?? "deepseek-chat",
  };
}
