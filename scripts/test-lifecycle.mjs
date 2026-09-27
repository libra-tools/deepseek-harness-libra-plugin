import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = process.env.DSH_CHECKOUT;
if (!checkout) throw new Error("DSH_CHECKOUT is required");
const revision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (revision !== "cd5ef8148158c3a752a658978873241fdf8e2bbc") throw new Error("Use pinned DSH alpha.1");
const smoke = join(checkout, "packages/test-support/loader-smoke");
const bundle = join(smoke, "node_modules/@libra-tools/dsh-bundle");
const name = `libra-lifecycle-${process.pid}.spec.ts`;
const target = join(smoke, "tests", name);
const consumer = join(smoke, "tests", `libra-consumer-${process.pid}.ts`);
const typeConfig = join(smoke, `libra-consumer-${process.pid}.json`);
if ([bundle, target, consumer, typeConfig].some(existsSync)) throw new Error("Reserved lifecycle test paths already exist");
const scratch = mkdtempSync(join(tmpdir(), "libra-lifecycle-peer-"));
try {
  mkdirSync(bundle, { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, "packages/bundle/dist"), join(bundle, "dist"), { recursive: true });
  cpSync(join(root, "packages/bundle/package.publish.json"), join(bundle, "package.json"));
  cpSync(join(root, "tests/dsh-alpha1/lifecycle-gate.spec.ts"), target);
  cpSync(join(root, "tests/dsh-alpha1/consumer.ts"), consumer);
  for (const file of readdirSync(join(bundle, "dist")).filter((name) => name.endsWith(".d.ts"))) {
    if (readFileSync(join(bundle, "dist", file), "utf8").includes("@libra/")) {
      throw new Error(`Public declaration ${file} leaks an unpublished workspace dependency`);
    }
  }
  writeFileSync(typeConfig, JSON.stringify({
    extends: join(root, ".dsh-types.json"),
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, noEmit: true, skipLibCheck: false, types: ["node"] },
    files: [consumer],
  }));
  execFileSync(process.execPath, [join(checkout, "node_modules/typescript/bin/tsc"), "-p", typeConfig], { stdio: "inherit" });
  console.log("Public artifact declaration consumer passed");
  const peer = join(scratch, "bridge.mjs");
  cpSync(join(root, "tests/fixtures/lifecycle-bridge.mjs"), peer);
  chmodSync(peer, 0o700);
  const result = spawnSync(process.execPath, [join(checkout, "node_modules/vitest/vitest.mjs"),
    "run", `packages/test-support/loader-smoke/tests/${name}`, "--reporter=verbose"], {
    cwd: checkout, env: { ...process.env, LIBRA_LIFECYCLE_PEER: peer }, stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(target, { force: true });
  rmSync(consumer, { force: true });
  rmSync(typeConfig, { force: true });
  rmSync(bundle, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
