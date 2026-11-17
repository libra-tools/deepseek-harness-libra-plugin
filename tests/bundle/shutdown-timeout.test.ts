import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import { BridgeClient } from "@libra/dsh-bridge-client";
import { apply } from "@libra/dsh-bundle";
import { expect, it, vi } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/fake-bridge.mjs", import.meta.url));

it("bounds shutdown of a silent append and preserves its unacknowledged outbox", async () => {
  const directory = mkdtempSync(join(tmpdir(), "libra-shutdown-"));
  const executable = join(directory, "bridge.mjs");
  const outboxRoot = join(directory, "outbox");
  const source = readFileSync(fixture, "utf8").replace('  const kind = frame.params?.kind;', '  if (frame.method === "event.append") return;\n  const kind = frame.params?.kind;');
  writeFileSync(executable, source);
  chmodSync(executable, 0o755);
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
  const session = { id: "silent-session", header: {}, surface: { replaceGeneration: 0, nodes: [] }, ownEvents: () => [] };
  const ctx = {
    sessions: { list: () => [session] },
    logger: { warn: () => undefined },
    get: () => undefined,
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => { const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1); };
    },
  } as unknown as Context;
  let bridge: BridgeClient | undefined;
  const original = BridgeClient.prototype.requestMethod;
  const rememberBridge = (client: BridgeClient): void => { bridge = client; };
  const spy = vi.spyOn(BridgeClient.prototype, "requestMethod").mockImplementation(function (method, params) {
    rememberBridge(this);
    return original.call(this, method, params);
  });
  try {
    const dispose = await apply(ctx, { libraExecutable: executable, repositoryRoot: repoRoot, outboxRoot, injectContext: false });
    for (const listener of listeners.get("session/event") ?? []) {
      listener(session as never, { seq: 1, type: "user/message", data: { text: "keep me" } } as never);
    }
    const flush = Promise.all((listeners.get("session/flush") ?? []).map((listener) => listener(session as never)));
    await vi.waitFor(() => expect(bridge?.listRequests().some((request) => request.method === "event.append" && request.state === "pending")).toBe(true));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      dispose().then(() => "disposed"),
      new Promise<string>((resolve) => { timeout = setTimeout(() => resolve("timed out"), 2500); }),
    ]);
    clearTimeout(timeout);
    expect(result).toBe("disposed");
    await flush;
    const files = readdirSync(outboxRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.some((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8").includes("keep me"))).toBe(true);
  } finally {
    await bridge?.close();
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
