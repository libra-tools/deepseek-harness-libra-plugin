/**
 * Deployment locations for the Libra bridge.
 *
 * Config values may be plain strings (tests and direct apply calls) or Cordis
 * volatile refs (the settings document). Missing or unusable locations do not
 * throw: the caller logs and leaves the plugin inert.
 */
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_LEASE_TTL_MS = 30_000;

/** A value or the live settings ref Cordis passes for a volatile field. */
export type MaybeLive<T> = T | { get(): T };

export interface DeploymentConfig {
  libraExecutable?: MaybeLive<string>;
  repositoryRoot?: MaybeLive<string>;
  outboxRoot?: MaybeLive<string>;
  injectContext?: MaybeLive<boolean>;
  workspaceLeaseTtlMs?: MaybeLive<number>;
  memoryTokenBudget?: MaybeLive<number>;
  captureMemoryEpisodes?: MaybeLive<boolean>;
  memoryModel?: MaybeLive<string>;
}

export interface ResolvedDeployment {
  libraExecutable: string;
  repositoryRoot: string;
  outboxRoot?: string;
  injectContext: boolean;
  workspaceLeaseTtlMs: number;
  /** Positive budget forwarded to `memory.recall`; absent means unbounded. */
  memoryTokenBudget?: number;
  captureMemoryEpisodes: boolean;
  memoryModel: string;
}

export function readLive<T extends string | number | boolean>(
  value: MaybeLive<T> | undefined,
): T | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object" && value !== null && typeof value.get === "function") return value.get();
  return undefined;
}

function blank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Locate a configured binary: absolute, relative, or a name on `PATH`. */
export async function resolveExecutable(raw: string): Promise<string | undefined> {
  const candidate = isAbsolute(raw) || raw.includes("/") || raw.includes("\\")
    ? resolve(raw)
    : await searchPath(raw);
  if (candidate === undefined) return undefined;
  try {
    const executable = await realpath(candidate);
    const executableStat = await stat(executable);
    if (!executableStat.isFile()) return undefined;
    await access(executable, constants.X_OK);
    return executable;
  } catch {
    return undefined;
  }
}

async function searchPath(name: string): Promise<string | undefined> {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next PATH entry
    }
  }
  return undefined;
}

/**
 * Resolve the current settings snapshot. Returns undefined when no usable
 * Libra binary or repository is configured; `reason` explains the warning.
 */
export async function resolveDeployment(
  config: DeploymentConfig,
  trustedWorkingDirectory?: string,
): Promise<{ deployment?: ResolvedDeployment; reason?: string }> {
  const configuredBinary = blank(readLive(config.libraExecutable)) ?? blank(process.env.LIBRA_BINARY);
  if (!configuredBinary) return { reason: "no libra executable configured (libraExecutable or LIBRA_BINARY)" };
  const libraExecutable = await resolveExecutable(configuredBinary);
  if (!libraExecutable) {
    return { reason: `libra executable not found or not executable: ${configuredBinary}` };
  }

  const configuredRepository = trustedWorkingDirectory
    ?? blank(readLive(config.repositoryRoot))
    ?? blank(process.env.LIBRA_REPO)
    ?? process.cwd();
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(resolve(configuredRepository));
    const repositoryStat = await stat(repositoryRoot);
    if (!repositoryStat.isDirectory()) {
      return { reason: `repositoryRoot is not a directory: ${configuredRepository}` };
    }
  } catch {
    return { reason: `repositoryRoot is not available: ${configuredRepository}` };
  }

  const outbox = blank(readLive(config.outboxRoot));
  const budget = readLive(config.memoryTokenBudget);
  const inject = readLive(config.injectContext);
  const model = blank(readLive(config.memoryModel));
  return {
    deployment: {
      libraExecutable,
      repositoryRoot,
      ...(outbox !== undefined ? { outboxRoot: resolve(outbox) } : {}),
      injectContext: inject !== false,
      workspaceLeaseTtlMs: positive(readLive(config.workspaceLeaseTtlMs), DEFAULT_LEASE_TTL_MS),
      ...(typeof budget === "number" && Number.isFinite(budget) && budget > 0
        ? { memoryTokenBudget: Math.floor(budget) }
        : {}),
      captureMemoryEpisodes: readLive(config.captureMemoryEpisodes) === true,
      memoryModel: model ?? "deepseek-chat",
    },
  };
}
