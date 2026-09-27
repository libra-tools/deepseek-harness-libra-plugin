import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, "packages/bundle/package.json"), "utf8")).dshCompatibility;
if (!process.env.DSH_CHECKOUT) throw new Error("Set DSH_CHECKOUT to the pinned, installed DSH checkout");
const checkout = realpathSync(process.env.DSH_CHECKOUT);
const sha = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (sha !== pin.commit) throw new Error(`DSH_CHECKOUT must be ${pin.release} (${pin.commit})`);
execFileSync("git", ["-C", checkout, "diff", "--exit-code", "HEAD", "--", "vendor", "packages", "tsconfig.base.json"], { stdio: "pipe" });
// Build only the official Agent declaration dependency closure, not the DSH app.
execFileSync(process.execPath, [
  "--max-old-space-size=4096", join(checkout, "node_modules/typescript/bin/tsc"),
  "-b", "packages/core/agent",
], { cwd: checkout, stdio: "inherit" });

const link = join(root, ".dsh-dev");
let existing;
try { existing = lstatSync(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing) {
  if (!existing.isSymbolicLink() || realpathSync(link) !== checkout) {
    throw new Error(".dsh-dev already exists and is not this checkout; choose its owner before replacing it");
  }
} else {
  symlinkSync(checkout, link, "dir");
}

// Use upstream's published declaration exports. These are generated lookup
// paths, never replacement declarations or vendored Host interfaces.
const paths = {};
const directories = (path) => readdirSync(path, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
for (const directory of [
  ...directories(join(checkout, "vendor")),
  ...directories(join(checkout, "packages")).flatMap(directories),
]) {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (!target || typeof target !== "object" || typeof target.types !== "string") continue;
    paths[pkg.name + (subpath === "." ? "" : subpath.slice(1))] = [
      `./.dsh-dev/${relative(checkout, join(directory, target.types)).split("\\").join("/")}`,
    ];
  }
}
for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-session", "@deepseek-ai/dsh-llm"]) {
  if (!paths[name] || !existsSync(resolve(root, paths[name][0]))) {
    throw new Error(`Official declarations missing for ${name}`);
  }
}
writeFileSync(join(root, ".dsh-types.json"), JSON.stringify({
  compilerOptions: { paths },
}, null, 2) + "\n");
console.log(`Prepared official DSH declaration paths at ${sha}`);
