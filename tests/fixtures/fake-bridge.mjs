#!/usr/bin/env node
// Controlled transport peer for handshake/framing/deadline tests only.
import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";

const limits = {
  max_frame_bytes: 262144, max_inflight: 64, max_batch_events: 64,
  max_batch_bytes: 262144, max_event_bytes: 262144, max_result_bytes: 262144,
  max_page: 100, request_deadline_secs: 30,
};
const methods = ["initialize", "session.open", "memory.recall", "status.get"];
const writeResponse = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
if (process.env.LIBRA_SKIP_WEB_BUILD?.includes("close-delay")) {
  process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 75); });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  const id = frame.id;
  if (frame.method === "initialize") {
    if (process.env.LIBRA_SKIP_WEB_BUILD?.includes("stderr-flood")) process.stderr.write(Buffer.alloc(1024 * 1024, "x"));
    writeResponse({ jsonrpc: "2.0", id, result: { protocol: { major: 1, minor: 2 }, limits, methods, source: "deepseek-harness" } });
    return;
  }
  const kind = frame.params?.kind;
  if (kind === "delay") {
    setTimeout(() => writeResponse({ jsonrpc: "2.0", id, result: { delayed: true } }), frame.params.delay_ms);
  } else if (kind === "retryable" || kind === "fatal") {
    writeResponse({ jsonrpc: "2.0", id, error: {
      code: kind === "retryable" ? 1010 : 1006, message: kind,
      data: { stable_code: kind === "retryable" ? "LBR-AGENT-036" : "LBR-AGENT-032", retryable: kind === "retryable" },
    } });
  } else {
    writeResponse({ jsonrpc: "2.0", id, result: kind === "partial" ? { partial: true } : { ok: true } });
  }
});
