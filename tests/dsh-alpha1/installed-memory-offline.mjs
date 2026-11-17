#!/usr/bin/env node
/* global process, structuredClone, console */
// Run with ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/dsh-alpha1/installed-memory-offline.mjs
// Requires LIBRA_BINARY. No profile or network is used; all state is temporary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.ok(process.versions.electron, 'Use the ASAR-aware DSH_NODE_EXECUTABLE with ELECTRON_RUN_AS_NODE=1');
const install = process.env.DSH_INSTALL_DIR;
assert.ok(install, 'DSH_INSTALL_DIR is required');
const runtimeRequire = createRequire(join(install, 'package.json'));
const manifest = runtimeRequire('@deepseek-ai/dsh/package.json');
assert.equal(manifest.version, '0.2.2-rc.3');
const moduleOf = async (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href);
const { Context } = await moduleOf('@deepseek-ai/cordis');
const llm = await moduleOf('@deepseek-ai/dsh-llm');
const { SessionId } = await moduleOf('@deepseek-ai/dsh-session');
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceRequire = createRequire(join(sourceRoot, 'package.json'));
const esbuild = workspaceRequire('esbuild');

class OfflineAdapter extends llm.LlmAdapter {
  requests = [];
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(options) {
    this.requests.push(structuredClone(options.messages));
    const text = 'The deployment color is violet, marker dsh-memory-offline-91ac.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const root = await mkdtemp(join(tmpdir(), 'dsh-installed-memory-'));
const ctx = new Context();
let pluginDispose;
try {
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-agent-loop']) {
    const mod = await moduleOf(name);
    await ctx.plugin(mod.default ?? mod, name.endsWith('dsh-agent-loop') ? { agents: [] } : {});
  }
  assert.ok(ctx.agentLoop && ctx.sessions && ctx.agents && ctx.llm && ctx.sessionProjections, 'Real DSH services did not start');
  const adapter = new OfflineAdapter();
  ctx.llm.registerAdapter(['offline-memory-test'], adapter);
  const options = { provider: 'offline-memory-test', model: 'offline-memory-test' };
  const prompt = (text) => llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
  const smoke = await ctx.agentLoop.create(SessionId('installed-runtime-smoke'), options, { cwd: root });
  smoke.followup(prompt('Confirm the offline test runtime.'));
  await smoke.whenIdle();
  assert.equal(adapter.requests.length, 1, `Installed AgentLoop did not call the offline adapter: ${JSON.stringify(smoke.session.ownEvents())}`);
  console.log('PASS: installed DSH 0.2.2-rc.3 Cordis, Session and AgentLoop ran an offline model request');

  // Compile against the installed DSH peers, without changing the workspace.
  const output = join(root, 'plugin.mjs');
  await esbuild.build({ entryPoints: [join(sourceRoot, 'packages/bundle/src/index.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'bundle', plugins: [{ name: 'installed-dsh', setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\// }, (args) => ({ path: pathToFileURL(runtimeRequire.resolve(args.path)).href, external: true }));
  } }] });
  // The bundled protocol receiver resolves both files relative to import.meta.url.
  // Preserve the original schema and its authority receipt without modification.
  const protocolDir = join(root, 'protocol');
  await mkdir(protocolDir);
  for (const name of ['agent-bridge.v1.schema.json', 'agent-bridge.v1.receipt.json']) {
    await copyFile(join(sourceRoot, 'protocol', name), join(protocolDir, name));
  }
  // Check the same import-relative lookup before attempting a bridge connection.
  const receiverOutput = join(root, 'receiver-check.mjs');
  await esbuild.build({ entryPoints: [join(sourceRoot, 'packages/protocol/src/receiver.ts')], outfile: receiverOutput, bundle: true, platform: 'node', format: 'esm' });
  const receiver = await import(pathToFileURL(receiverOutput).href);
  assert.equal(receiver.loadProtocolReceiver().status, 'ready', 'Copied protocol fixture or receipt is invalid');
  const plugin = await import(pathToFileURL(output).href);
  console.log('PASS: current plugin source compiled against installed DSH peers and original protocol fixture validated');
  const binary = process.env.LIBRA_BINARY;
  if (!binary) throw new Error('LIBRA_BINARY is required for the real Libra turn A/B test; no fake bridge is substituted');
  const repo = join(root, 'repo');
  await mkdir(repo);
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), LIBRA_HOME: join(root, 'libra-home'), LIBRA_CONFIG_GLOBAL_DB: join(root, 'global.sqlite3'), LIBRA_CONFIG_SYSTEM_DB: join(root, 'system.sqlite3'), NO_PROXY: '*', no_proxy: '*' };
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'LIBRA_HOME']) await mkdir(env[key], { recursive: true });
  const run = (...args) => execFileSync(resolve(binary), args, { cwd: repo, env, timeout: 30000, encoding: 'utf8' });
  run('init', '--vault', 'false');
  run('status', '--short');
  run('config', 'set', '--local', 'bridge.conversationMemory', 'true');
  const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
  const wrapper = join(root, 'unique-libra-wrapper');
  await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(' ')} ${quote(resolve(binary))} "$@"\n`, { mode: 0o700 });

  pluginDispose = await plugin.apply(ctx, { libraExecutable: wrapper, repositoryRoot: repo, outboxRoot: join(root, 'outbox'), captureMemoryEpisodes: true, injectContext: false, memoryTokenBudget: 0, memoryModel: 'offline', workspaceLeaseTtlMs: 30000 });
  const agent = await ctx.agentLoop.create(SessionId('installed-memory-turns'), options, { cwd: repo });
  agent.followup(prompt('Remember the deployment color for project cedar is violet, marker dsh-memory-offline-91ac.'));
  await agent.whenIdle();
  assert.equal(adapter.requests.length, 2, 'Turn A did not reach the real model request');
  assert.equal(adapter.requests[1].some((m) => m.source.kind === 'libra-memory'), false, 'Temporary repository was not empty');
  assert.equal(await ctx.sessions.flush(agent.session), true, 'Turn A has no durability listener');
  const second = await ctx.agentLoop.create(SessionId('installed-memory-second'), options, { cwd: repo });
  assert.notEqual(second.session.id, agent.session.id);
  second.followup(prompt('What color was used for the cedar deployment?'));
  await second.whenIdle();
  assert.equal(adapter.requests.length, 3, 'Turn B did not reach the real model request');
  const memory = adapter.requests[2].find((m) => m.source.kind === 'libra-memory');
  assert.ok(memory, 'Turn B model request lacks libra-memory');
  const text = memory.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert.match(text, /violet|dsh-memory-offline-91ac/i);
  assert.equal(memory.source.bundleHash, `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`);
  assert.match(memory.source.viewHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(memory.source.receiptId);
  const loggedMemory = second.session.ownEvents().find((e) => e.type === 'user/message' && e.data.id === memory.id);
  assert.ok(loggedMemory, 'Memory not present in the second real Session log');
  assert.deepEqual(loggedMemory.data, memory, 'Session event and model request differ');
  console.log(`PASS: real Libra captured turn A and turn B injected libra-memory into the installed DSH model request; bundleHash=${memory.source.bundleHash}`);
} finally {
  try { await pluginDispose?.(); } finally {
    try { await ctx.fiber.dispose(); } finally {
      const [parent, actual] = await Promise.all([realpath(tmpdir()), realpath(root)]);
      assert.ok(actual.startsWith(`${parent}/dsh-installed-memory-`), 'Refusing to remove non-test directory');
      await rm(actual, { recursive: true, force: true });
    }
  }
}
