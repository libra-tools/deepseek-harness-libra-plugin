#!/usr/bin/env node
// A controlled JSON-RPC peer, not a replacement DSH runtime. Each test owns cwd.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const log = (event) => appendFileSync("bridge-events.jsonl", JSON.stringify(event) + "\n");
const active = new Set();
const episodes = new Map();
log({ event: "started", pid: process.pid });
process.on("SIGTERM", () => { log({ event: "stopped" }); process.exit(0); });
async function handle(frame) {
  log({ event: "request", method: frame.method, params: frame.params });
  const control = existsSync("control.json") ? JSON.parse(readFileSync("control.json", "utf8")) : {};
  if (control.hold === frame.method) {
    while (!existsSync("release")) await delay(5);
  }
  if (control.fail === frame.method) {
    log({ event: "error", method: frame.method });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: {
      code: -32603, message: "controlled capture failure",
      data: { stable_code: "LBR-MEMORY-005", retryable: false },
    } }) + "\n");
    return;
  }
  const id = frame.params?.session_id;
  let result;
  switch (frame.method) {
    case "initialize":
      result = {
        protocol: { major: 1, minor: 2 }, source: "deepseek-harness",
        methods: ["initialize", "session.open", "session.close", "memory.recall", "memory.episode.record"],
        limits: { max_frame_bytes: 262144, max_inflight: 64, max_batch_events: 64,
          max_batch_bytes: 262144, max_event_bytes: 262144, max_result_bytes: 262144,
          max_page: 100, request_deadline_secs: 30 },
      };
      break;
    case "session.open": active.add(id); result = { opened: true }; break;
    case "session.close": active.delete(id); result = { closed: true }; break;
    case "memory.episode.record":
      episodes.set(id, frame.params);
      result = { schema_version: 1, data: { task_id: "task", note_id: "note", revision_oid: "revision" } };
      break;
    case "memory.recall": {
      if (!active.has(id)) throw new Error("recall before session.open");
      const query = frame.params.query_text;
      const text = query === "zero-hit" ? "" : query === "recorded-episode"
        ? JSON.stringify(episodes.get(id) ?? null) : `Memory for ${query}`;
      result = { schema_version: 1, data: { delivery: query === "null-delivery" ? null : {
        prompt_section: text, receipt_id: `receipt-${id}`, view_hash: `sha256:${"1".repeat(64)}`,
        bundle_hash: `sha256:${query === "hash-mismatch" ? "0".repeat(64) : createHash("sha256").update(text).digest("hex")}`,
        selected_count: text ? 1 : 0, token_budget: 1600,
      } } };
      break;
    }
    default: throw new Error(`unexpected method ${frame.method}`);
  }
  log({ event: "response", method: frame.method });
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
}
createInterface({ input: process.stdin }).on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => { console.error(error); process.exit(1); });
});
