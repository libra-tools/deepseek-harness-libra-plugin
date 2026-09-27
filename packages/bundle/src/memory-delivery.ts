import { createHash } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import type { CompletedRequest } from "@libra/dsh-bridge-client";
import "./memory-source.js";

export interface MemoryDelivery {
  promptSection: string;
  receiptId: string;
  viewHash: string;
  bundleHash: string;
  selectedCount: number;
  tokenBudget: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
  return text;
}

function requireNatural(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
  return value;
}

export function parseDelivery(result: unknown): MemoryDelivery | null {
  if (!isRecord(result)) throw new Error("memory.recall returned an invalid envelope");
  assertExactKeys(result, ["schema_version", "data"], "envelope");
  if (result.schema_version !== 1 || !isRecord(result.data)) {
    throw new Error("memory.recall returned an unsupported schema version");
  }
  assertExactKeys(result.data, ["delivery"], "data envelope");
  if (result.data.delivery === null) return null;
  if (!isRecord(result.data.delivery)) throw new Error("memory.recall returned an invalid delivery");
  const delivery = result.data.delivery;
  assertExactKeys(delivery, [
    "prompt_section",
    "receipt_id",
    "view_hash",
    "bundle_hash",
    "selected_count",
    "token_budget",
  ], "delivery");
  if (typeof delivery.prompt_section !== "string") {
    throw new Error("memory.recall returned an invalid prompt_section");
  }
  const parsed: MemoryDelivery = {
    promptSection: delivery.prompt_section,
    receiptId: requireString(delivery.receipt_id, "receipt_id"),
    viewHash: requireSha256(delivery.view_hash, "view_hash"),
    bundleHash: requireSha256(delivery.bundle_hash, "bundle_hash"),
    selectedCount: requireNatural(delivery.selected_count, "selected_count"),
    tokenBudget: requireNatural(delivery.token_budget, "token_budget"),
  };
  if (parsed.tokenBudget !== 1600) {
    throw new Error("memory.recall returned an unexpected token_budget");
  }
  if ((parsed.selectedCount === 0) !== (parsed.promptSection.length === 0)) {
    throw new Error("memory.recall returned inconsistent selection content");
  }
  const calculated = `sha256:${createHash("sha256").update(Buffer.from(parsed.promptSection, "utf8")).digest("hex")}`;
  if (calculated !== parsed.bundleHash) {
    throw new Error("memory.recall bundle hash mismatch");
  }
  return parsed;
}

export function completedResult(request: CompletedRequest): unknown {
  if (request.state === "success" && request.error === undefined) return request.result;
  const stableCode = request.error?.data?.stable_code ?? "LBR-AGENT-UNKNOWN";
  const retryable = request.error?.data?.retryable === true;
  throw new Error(`${request.method} failed (${stableCode}, retryable=${String(retryable)})`);
}

export function memoryMessage(delivery: MemoryDelivery): UserMessage {
  const text = delivery.promptSection;
  return createUserMessage({
    content: [{ type: "text", text }],
    source: {
      kind: "libra-memory",
      receiptId: delivery.receiptId,
      viewHash: delivery.viewHash,
      bundleHash: delivery.bundleHash,
      selectedCount: delivery.selectedCount,
      tokenBudget: delivery.tokenBudget,
      form: "snapshot",
      sections: [{ name: "libra-memory", text }],
    },
  });
}

const MEMORY_CLEAR_TEXT = "Libra Memory snapshot cleared. Earlier Libra Memory snapshots no longer apply.";

function memoryClearMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text: MEMORY_CLEAR_TEXT }],
    source: {
      kind: "libra-memory-clear",
      form: "snapshot",
      sections: [{ name: "libra-memory", text: MEMORY_CLEAR_TEXT }],
    },
  });
}

function visibleMemorySequences(session: Session): number[] {
  return session.surface.nodes.filter((sequence) => {
    const event = session.events[sequence];
    return event?.type === "user/message"
      && event.data.source.kind === "libra-memory";
  });
}

export function retireVisibleMemory(session: Session): void {
  for (const sequence of visibleMemorySequences(session)) {
    session.append("user/message", memoryClearMessage(), {
      surfaceOp: { op: "replace", start: sequence, end: sequence },
      sourceEventSeqs: [sequence],
    });
  }
}

export function acceptedUserQuery(messages: readonly UserMessage[]): string | undefined {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.source.kind !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text") blocks.push(block.text);
    }
  }
  return blocks.length === 0 ? undefined : blocks.join("\n");
}
