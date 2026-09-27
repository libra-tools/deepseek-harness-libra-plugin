import type {} from "@deepseek-ai/dsh-llm/message";

interface LibraMemorySource {
  kind: "libra-memory";
  receiptId: string;
  viewHash: string;
  bundleHash: string;
  selectedCount: number;
  tokenBudget: number;
  form: "snapshot";
  sections: readonly [{ readonly name: "libra-memory"; readonly text: string }];
}

interface LibraMemoryClearSource {
  kind: "libra-memory-clear";
  form: "snapshot";
  sections: readonly [{ readonly name: "libra-memory"; readonly text: string }];
}

// Extend only the plugin-owned source variants, never the Host interfaces.
declare module "@deepseek-ai/dsh-llm/message" {
  interface MessageSourceMap {
    "libra-memory": LibraMemorySource;
    "libra-memory-clear": LibraMemoryClearSource;
  }
}
