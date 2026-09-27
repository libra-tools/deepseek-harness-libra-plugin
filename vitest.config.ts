import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@libra/dsh-protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
      "@libra/dsh-bridge-client": fileURLToPath(
        new URL("./packages/bridge-client/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    environment: "node",
  },
});
