import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = process.env.DSH_CHECKOUT;
if (!checkout || !process.env.LIBRA_BINARY) {
  throw new Error("DSH_CHECKOUT and LIBRA_BINARY are required; run this gate in the development container");
}
const revision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (revision !== "cd5ef8148158c3a752a658978873241fdf8e2bbc") {
  throw new Error("DSH_CHECKOUT must be the pinned v0.1.2-alpha.1 revision");
}
const dist = join(root, "packages/bundle/dist");
const manifest = join(root, "packages/bundle/package.publish.json");
if (!existsSync(join(dist, "index.js")) || !existsSync(manifest)) {
  throw new Error("Run pnpm build before the Memory Episode gate");
}
// The upstream smoke package supplies the same DSH peers used by the Loader.
const smoke = join(checkout, "packages/test-support/loader-smoke");
const bundle = join(smoke, "node_modules/@libra-tools/dsh-bundle");
const testName = `libra-episode-gate-${process.pid}.spec.ts`;
const testFile = join(smoke, "tests", testName);
if (existsSync(bundle) || existsSync(testFile)) {
  throw new Error("The reserved Episode gate paths already exist; use a clean smoke environment");
}
try {
  mkdirSync(bundle, { recursive: true });
  mkdirSync(dirname(testFile), { recursive: true });
  cpSync(dist, join(bundle, "dist"), { recursive: true });
  cpSync(manifest, join(bundle, "package.json"));
  cpSync(join(root, "tests/dsh-alpha1/episode-gate.spec.ts"), testFile);
  const result = spawnSync(process.execPath, [
    join(checkout, "node_modules/vitest/vitest.mjs"), "run",
    `packages/test-support/loader-smoke/tests/${testName}`, "--reporter=verbose",
  ], { cwd: checkout, env: process.env, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(testFile, { force: true });
  rmSync(bundle, { recursive: true, force: true });
}
