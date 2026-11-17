import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "packages/bundle");
const dist = join(bundle, "dist");
const patch = join(bundle, "cordis.patch.yml");
const publishManifest = join(bundle, "package.publish.json");
const client = join(bundle, "client.js");
const locale = join(bundle, "locale");
const icon = join(bundle, "icon.svg");
const readme = join(root, "README.md");
const license = join(root, "LICENSE");
if (
  !existsSync(dist)
  || !existsSync(patch)
  || !existsSync(publishManifest)
  || !existsSync(client)
  || !existsSync(locale)
  || !existsSync(icon)
  || !existsSync(readme)
  || !existsSync(license)
) {
  console.error("bundle dist/patch/client/locale/icon/publish manifest missing; run pnpm build first");
  process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), "libra-dsh-bundle-"));
cpSync(dist, join(staging, "dist"), { recursive: true });
cpSync(patch, join(staging, "cordis.patch.yml"));
cpSync(client, join(staging, "client.js"));
cpSync(locale, join(staging, "locale"), { recursive: true });
cpSync(icon, join(staging, "icon.svg"));
cpSync(readme, join(staging, "README.md"));
cpSync(license, join(staging, "LICENSE"));
const publish = JSON.parse(
  readFileSync(publishManifest, "utf8"),
);
writeFileSync(join(staging, "package.json"), JSON.stringify(publish, null, 2));
const peers = join(bundle, "node_modules");
if (existsSync(peers)) {
  symlinkSync(peers, join(staging, "node_modules"));
}
console.log(staging);
