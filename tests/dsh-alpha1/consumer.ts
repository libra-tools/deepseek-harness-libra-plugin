import type { Context } from "@deepseek-ai/cordis";
import type { Message } from "@deepseek-ai/dsh-llm";
import { apply, type Config } from "@libra-tools/dsh-bundle";

// Compile against the artifact's public exports, not the plugin workspace.
export const config: Config = { captureMemoryEpisodes: true, memoryModel: "deepseek-chat" };
export const mount: (ctx: Context, config: Config) => Promise<void> = apply;
export function receipt(message: Message): string | undefined {
  if (message.source.kind === "libra-memory") {
    const count: number = message.source.selectedCount;
    return count > 0 ? message.source.receiptId : undefined;
  }
  return undefined;
}
