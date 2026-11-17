# Libra Harness 插件 × DeepSeek Harness 0.1.5-rc 兼容性分析

> 分析日期：2026-09-15（分析对象：本仓库 `main` 分支 HEAD `95786c8`）
> 对照 DSH 版本：CLI `@deepseek-ai/dsh@0.1.5-rc.1`，运行时子包实际解析到 `0.1.5-rc.2`
> （`dsh-session` / `dsh-agent` / `dsh-llm` / `dsh-tools` / `dsh-user-approval` / `dsh-session-projection` / `cordis@4.0.2`）

---

## 0. 实施状态（2026-09-16 更新）

本报告第 0–4 节的差距分析已按 P0→P3 全部实施完毕，最终门禁全绿：

| 优先级 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 内存模块迁移到真实 `0.1.5-rc.2` 类型面（`eventAt`/`surfaceOp replace`/`PreStepDecision`/`createUserMessage`） | ✅ |
| P1 | `libra_*` 工具注册为 DSH 工具（`ctx.tools.register(defineTool(...))`）、审批走 `ctx.approval`、outbox 接 `session/event`+`flush`+`disposed` | ✅ |
| P2 | 工作区租约绑定会话生命周期、首轮 `libra_context` 接地注入、工具 `presentCall`/`presentResult` 卡片 | ✅ |
| P3 | 内存投递追踪迁移到 `ctx.sessionProjections`（`libraMemory` 单元，带 scan 回退）、配置项化（`outboxRoot`/`injectContext`/`workspaceLeaseTtlMs`/`memoryTokenBudget`）、`apply()` 降级激活、文档/协议对齐 | ✅ |

实现位置：`packages/bundle/src/{index,memory-projection,libra-tools,outbox,workspace,context}.ts`；
新增测试：`tests/bundle/{tools-outbox,p2-mounts,p3-features}.test.ts`。
本地门禁：`pnpm typecheck` ✅ / `pnpm lint` ✅ / `pnpm test`（79 通过，2 跳过）✅ / `pnpm build`（esbuild dist）✅。
协议 fixture 已是协议 `1.1` / libra `0.21.25`，receipt 哈希与文件一致（`f60701ec…`）。
真实 DSH+Libra 集成门仍为 `remote-pending`（需 `LIBRA_BINARY`/`LIBRA_REPO`/固定 `DSH_CLI`）。

---

## 0b. 原始结论摘要

1. **内存模块（当前唯一真正挂进 DSH 的 Cordis 插件入口）在最新 DSH 上会直接崩溃**：
   - `session.events` 已被最新 `dsh-session` 移除 → `visibleMemorySequences()` 运行时 `TypeError`；
   - `session.append()` 的 `surfaceOp replace` 字段由 `{start,end}` 改为 `{startSeq,endSeq}` → 退场替换操作被运行时校验拒绝并抛错。
2. **除内存模块外的全部“核心能力”都只是独立库，从未接线到 DSH**（工具、事件投影/outbox、工作区租约、上下文注入、UI 卡片）。模型今天**根本看不到、也调不到** `libra_*` 工具。
3. **版本/pin 全面滞后**：peerDependencies 停在 `0.1.2-alpha.1`、cordis 精确 `4.0.1`；README/兼容文档声称 `dsh-v0.1.0-rc.7`；`dist/` 构建产物是旧的 REL-TS-01 工厂、不包含内存模块。
4. **要“完整使用”**，不是修修补补，而是把核心模块按最新 DSH 的机制（`ctx.tools.register(defineTool(...))`、`tools/pre-execute` + `ctx.approval`、`session/event`+`session/flush`、`agent.inject()`、tool presentation）重新接线，并修掉内存模块的 API 断点。

---

## 1. 现状：插件是如何“接”DSH 的

### 1.1 两个时代的代码并存

| 时代 | 提交 | 形态 | 是否接线 DSH |
| --- | --- | --- | --- |
| REL-TS-01（初版） | `e3883d7` | `createLibraBundleRuntime()` 纯库工厂，组装 bridge/tools/projection/workspace/context/ui | **否**，不订阅任何 DSH 事件/服务 |
| MEM-DSH-01（内存模块） | `a2201b3` | `packages/bundle/src/index.ts` 重写为真正的 Cordis 插件（`name`/`inject`/`Config`/`apply`） | **是**，仅内存 recall 一条链路 |

当前 `packages/bundle/src/index.ts`（447 行）只做一件事：桥接 `memory.recall`，在 `agent/pre-step` 里把 Libra 记忆作为 `user/message` 注入，在 `agent/request-error` 里重试时刷新。**outbox 投影、工具、工作区、上下文、UI 卡片全部没有 Cordis 入口**——它们仍然只是 `packages/{tools,session,ui,workspace,context}` 里的独立类。

### 1.2 插件清单与加载方式（仍兼容最新 CLI）

- `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，`cordis.patch.yml` 插入 `{ id: libra, name: '@libra-tools/dsh-bundle' }`。
- 最新 CLI（`dsh/lib/plugin-*.js`）仍按 `dsh.bundle.patch` 识别“bundle 型依赖”并把其 patch 层并入 profile——**加载机制本身没问题**。
- Cordis 插件契约（`name`/`inject`/`Config`/`apply`）未变；`ctx.on(..., { prepend: true })` 仍受支持（`cordis/lib/types/events.d.ts`）。
- 插件声明的 `inject: ["agents", "sessions"]` 两个服务在最新 DSH 都存在（`ctx.agents` = `AgentRegistry`，`ctx.sessions` = `SessionStore`）。

**结论**：插件能“装上”，也能“激活”，但激活后内存模块会在第一个被接受的 turn 上炸掉，其余能力根本没接。

---

## 2. 硬性断点：内存模块在最新 DSH 上会崩的地方

证据全部来自最新 `@deepseek-ai/dsh-session@0.1.5-rc.2` 与 `@deepseek-ai/dsh-agent@0.1.5-rc.2` 的类型/实现。

### 2.1 `session.events` 已移除 → `TypeError`

`packages/bundle/src/index.ts:223-231`：

```ts
function visibleMemorySequences(session: Session): number[] {
  return session.surface.nodes.filter((sequence) => {
    const event = session.events[sequence];   // ← 最新 Session 没有 .events
    ...
```

最新 `Session`（`dsh-session/lib/types/index.d.ts`）只提供 `eventAt(seq)`、`snapshotEvents(from,to)`、`ownEvents()`，`events` 属性（含私有 `eventsSnapshot`）已不存在。首次刷新路径 `retireVisibleMemory()` 必然命中 → `TypeError: Cannot read properties of undefined`。

**修复**：改用 `session.eventAt(seq)` 或 `session.snapshotEvents()` 扫描。

### 2.2 `surfaceOp replace` 字段名变化 → `append()` 抛错

`packages/bundle/src/index.ts:233-240`：

```ts
session.append("user/message", memoryClearMessage(), {
  surfaceOp: { op: "replace", start: sequence, end: sequence },  // ← 旧字段
  sourceEventSeqs: [sequence],
});
```

最新 `SurfaceOp`（`dsh-session/lib/types/types.d.ts:429-433`）要求：

```ts
export type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq };
```

运行时校验（`dsh-session/lib/types/surface.js:169-173`）用 `Object.hasOwn(op,'startSeq') && Object.hasOwn(op,'endSeq')` 判断，`{start,end}` 会被判定为“invalid replace surfaceOp”并抛错。**这条路径在每次刷新（含 compaction 后重建）都会执行，属于必然失败。**

**修复**：改为 `{ op: "replace", startSeq: SessionSeq(sequence), endSeq: SessionSeq(sequence) }`。

### 2.3 其余仍兼容的部分（核对过，不用改）

- `agent/pre-step` 仍存在，waterfall 语义不变（`dsh-agent/lib/types/runtime-types.d.ts:313-319`）：payload 现在是 `{agent, messages, turn, step, signal}`，`next()` 仍返回 `PreStepDecision`（`reject | {kind:'enter', messages, startsRequestSeries?}`）；插件从 `next()` 结果取 `decision.messages` 的做法与官方 `dsh-tmux-context` 完全一致。
- `agent/request-error` 仍存在；payload 新增 `step/provider/failure/retryPolicy`，插件只读 `agent/turn/signal`，忽略多余字段即可。
- `session/created` / `session/disposed` 仍存在，payload 仍是 session 对象本身（`dsh-session/lib/types/index.d.ts:40-50`）。
- `session.surface.nodes` / `session.surface.replaceGeneration` 仍存在（`SessionSurface`）。
- `createUserMessage`（`@deepseek-ai/dsh-llm/message`）仍存在；`MessageSourceMap` 可扩展，`form:'snapshot' + sections` 与最新 `ContextFormed` 词汇一致。
- `ctx.on(..., {prepend:true})`、`inject`、`Config: z.object(...)` 契约不变。

---

## 3. “完整使用”缺失的接线（核心模块从未接入 DSH）

以下每一行在 README 里都宣传了，但在代码里都只是独立库。按最新 DSH 的机制逐条列出应如何接。

### 3.1 工具：模型根本调不到 `libra_*`（最关键的缺口）

现状：`packages/tools/src/facade.ts` 的 `ToolsFacade` 定义了自己的目录/校验/调用引擎，但没有注册到 DSH 的 `ctx.tools`（`dsh-tools` 的 `ToolRuntime`），模型侧看不到任何 libra 工具，`libra_commit` / `libra_restore_checkpoint` 等形同虚设。

最新 DSH 的注册方式是 `ctx.tools.register(defineTool({...}))`（官方范本：`dsh-tool-present`、`dsh-tool-*` 全系）：

```ts
import { defineTool } from "@deepseek-ai/dsh-tools";

ctx.tools.register(defineTool({
  name: "libra_commit",
  description: "...",
  parameters: { message: { type: "string", required: true }, ... }, // ParameterSchemaSpec
  output: {
    schema: { type: "object", additionalProperties: false, properties: {...} }, // 规范 JSON Schema
    render: (args, value) => [{ type: "text", text: ... }],                     // 模型可见内容
  },
  async execute(args, exec) { /* 调用 bridge.requestMethod("commit.create", {...}) */ },
  presentCall: (args) => ({ ... }),   // 可选：UI 卡片
  presentResult: (args, result) => ({ ... }), // 可选：UI 卡片
}));
```

要点：
- `execute` 拿到 `exec.agent.session`，可把 `session_id` 绑定为 `String(exec.agent.session.id)`，从而**彻底堵死模型伪造 actor/仓库路径**——比现在把 `session_id` 当作模型参数更安全。
- 保留 `ToolsFacade` 作为“桥接调用引擎”，但把它变成工具定义背后的实现，而不是暴露给模型的对象。
- `FORBIDDEN_MODEL_PARAMS` 仍然适用，但应该从“工具参数校验”上升为“参数 schema 里根本没有这些字段”。

### 3.2 审批：用自己的策略对象 → 走 `ctx.approval`

现状：`ApprovalPolicy {allowRead, allowWrite, allowRestore, allowPushPublish}` 是插件自己的；写/恢复工具默认“denied until approval”，并允许模型传 `approval` 参数（`facade.ts` 把 `params.approval` 转发给 bridge）。

最新 DSH 有原生审批缝：`dsh-user-approval` 的 `ApprovalService`（`ctx.approval`），会话策略 `'ask' | 'never'`，请求类型 `ApprovalRequest`（agent/toolName/callId/reason/signal），结果 `allowed-once | rejected | cancelled | unavailable`，且每次 ask/outcome 成对审计写入会话日志。

应改为：
- 写/恢复工具在 `tools/pre-execute` waterfall 里返回 `{ kind: "ask", reason: ... }`（DSH 会自动走 `ctx.approval` 解析，`never` 策略直接确定性拒绝）；
- 或注册 `ctx.tools.guard(...)` 做“策略前置闸门”；
- **删除模型可传的 `approval` 参数**——审批权交给 DSH 审批缝，模型只提供 `operation_id` 等业务参数。

顺带：本会话当前审批策略已切到 `never`（用户侧），插件必须依赖 `ctx.approval` 才能正确反映这种运行时切换，自己的策略对象做不到。

### 3.3 事件投影 / outbox：订阅 `session/event` + `session/flush`

现状：`SessionProjectionService`（`packages/session/src/projection.ts`）有 `capture()` / `open()` / `flush()` / `dispose()`，但没有任何 DSH 事件喂给它。`HarnessSessionEvent` 是插件自造类型，与 `dsh-session` 的 `SessionEvent` 无映射。

应接线：
- `session/created` → `projection.open(sessionId)`；
- `session/event` → 把 DSH `SessionEvent`（`seq/type/data`，已是 lossless JSON）映射为 bridge 的 `event.append` 载荷并 `capture()`（去重/红action由 outbox 处理）；
- `session/flush`（最新 DSH 的持久化 checkpoint 事件，`dsh-session` 明确说“persistence plugins buffer asynchronously; drain on session/flush”）→ `projection.flush(sessionId)`；
- `session/disposed` → `projection.dispose(sessionId)`。

注意最新 `SessionEvent` 的 `type` 词汇（`turn/start`、`user/message`、`assistant/message`、`tool/result` 等）与插件 README 里的“session events”描述需要对齐，bridge 协议 fixture（`protocol/agent-bridge.v1.schema.json`）也要确认与目标 libra 版本匹配（README 提到内存模块已按协议 1.1 / libra 0.21.25 验证，核心模块还停在 v1 / 0.21.22）。

### 3.4 工作区租约：绑定会话生命周期 + agent 作用域

现状：`WorkspaceBindingService` 用全局 `Map<sessionId, handle>`，claim/renew/release 都没有被任何 DSH 生命周期驱动。

应接线：在 `session/created`（或首个 agent turn）claim、按 `lease_ttl_ms` 定时 renew、`session/disposed` release。更贴近最新 DSH 的做法是注册在 `agent.ctx` 的 scoped effect 里（DSH 的 `dsh-scope` 机制：agent 卸载时 scoped effect 自动 unwind，租约随 agent 生命周期回收，而不是靠全局 Map 手动清理）。

### 3.5 上下文注入：`agent.inject()` / pre-step 注入（官方范本）

现状：`ContextInjector`（`packages/context/src/injector.ts`）调用 `libra_context` 工具取切片，然后调抽象 `host.injectContext(...)`——没有 host，等于没接。

最新 DSH 的两条正路：
- 内存模块已经在用的 **pre-step 注入**（`agent/pre-step` 返回额外 messages，范本：`dsh-tmux-context`、`dsh-time-context`）——继续用；
- 最新 `Agent` 还有显式 `agent.inject(message)`（“queue model-facing context for the next pre-step without waking the driver”），适合非 turn 边界（如文件变更通知、恢复/compaction 后）的注入。

source 建议用官方词汇：`{ kind: "plugin", plugin: name, form: "catalog" | "snapshot", sections: [...] }`（`ContextFormed`），客户端 UI 才能正确渲染；自定义 `kind` 仍合法但 UI 只能当普通文本。

### 3.6 UI 卡片：迁到 tool presentation + `tools/result` meta

现状：`UiCardService`（`packages/ui/src/cards.ts`）维护自己的卡片队列 + 抽象 `UiHost {isAvailable, publishCard, removeSession}`，从未有实现，README 里“renders redacted UI cards when the Harness host exposes those capabilities”落空。

最新 DSH 的卡片机制是**工具呈现 + 结果投影**：
- 工具定义上的 `presentCall(args)` / `presentResult(args, result)` 返回 `ToolCallView` / `ToolResultView`（`dsh-tools` presentation 类型），由 `dsh-client-ui-tool` 渲染；
- `tools/result` 事件（`dsh-tools`）给最终冻结结果，`tool/result` 会话事件可带工具私有 `meta`（opaque JSON，持久化并在回放时原样重现）——checkpoint/diff/commit/evidence/approval 卡片数据正好放 `meta`。

应把 checkpoint/diff/commit/evidence/approval 的“卡片投影”做成各工具定义的 `presentResult` + `meta`，删掉抽象 `UiHost`。

---

## 4. 内存模块的定向修复 + 可选现代化

### 4.1 必修（P0）

| # | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | `index.ts:224-230` `visibleMemorySequences` | `session.events[seq]` 已移除 | `session.eventAt(seq)` / `session.snapshotEvents()` |
| 2 | `index.ts:235-238` `retireVisibleMemory` | `surfaceOp replace {start,end}` 非法 | `{ op: "replace", startSeq: SessionSeq(seq), endSeq: SessionSeq(seq) }`，并确认 `sourceEventSeqs` 覆盖被替换节点 |

### 4.2 建议（P2，可选但推荐）

- **用 `sessionProjections` 替换 surface 扫描**：最新 `dsh-session-projection`（base profile 已带 `session-projection` + `session-projection-cache`）提供 `ctx.sessionProjections.register({key, stateSchema, init, apply, stateVersion})`。`dsh-tmux-context` 正是用它在 compaction/重启后追踪“上次注入的状态”的官方范本——比每次扫描 surface 找 `libra-memory` 节点更稳、更省。
- `tokenBudget !== 1600` 的硬编码校验（`index.ts:173-175`）应改为配置项或接受 Libra 下发的值，避免桥升级后误拒。
- `apply()` 目前是 `async` 且在函数体内 `await bridge.connect()`、config 缺 `libraExecutable` 直接 throw——桥不可用/未配置时整个插件层加载失败。建议改为延迟/降级激活（README 自己写了 `degraded-no-host`），把 `libraExecutable`/`repositoryRoot` 设为可选，桥可用后再建链。

---

## 5. 版本 / 清单 / 工程卫生

| 项 | 现状 | 应改为 |
| --- | --- | --- |
| `packages/bundle/package.json` peerDependencies | `dsh-agent@0.1.2-alpha.1`、`dsh-llm@0.1.2-alpha.1`、`dsh-session@0.1.2-alpha.1`、`cordis@4.0.1`（精确） | `^0.1.5-rc.2`（或锁定的目标发布）、`cordis@^4.0.2` |
| `dsh-contract.d.ts` 手写模块声明 | 与最新 API 不符（声明了已删除的 `Session.events`、旧的 `{start,end}`），掩盖了 2.1/2.2 的断点 | 删掉，改为在 workspace 安装真实包作为 devDependencies 编译，类型即真相 |
| `packages/bundle/dist/` | **陈旧**：`dist/index.js` 是旧 `createLibraBundleRuntime` 工厂（1389 行），不含内存模块；dist 被 gitignore | `pnpm build` 重新生成后再 stage/pack |
| `package.publish.json` | 与 build 脚本产物不一致（手写 `cordis>=0.1.0` vs 脚本写 `pkg.peerDependencies`） | 统一由 build 脚本生成，审阅最终发布清单 |
| README / `compatibility/*.md` | 声称 `dsh-v0.1.0-rc.7`（核心）/ `v0.1.2-alpha.1`（内存） | 更新为 0.1.5-rc.x 的兼容声明与验证记录 |
| 协议 fixture | `protocol/agent-bridge.v1.schema.json` 来自 libra 0.21.22 | 与目标 libra 版本（内存模块用的 0.21.25 / 协议 1.1）对齐，重签 receipt |

---

## 6. 建议的落地顺序

1. **P0 — 修内存模块两个 API 断点**（第 4.1 节），同步把 peer 依赖升到 `^0.1.5-rc.2`、删掉 `dsh-contract.d.ts` 换真实类型、重新 `pnpm build` + 跑 `test:integration`（`DSH_CLI` 指到 0.1.5-rc.x）。
2. **P1 — 把 `libra_*` 工具注册为 DSH 工具**（`ctx.tools.register(defineTool(...))`），审批走 `tools/pre-execute` + `ctx.approval`，删除模型侧 `approval` 参数。这是“模型真正能用上 Libra”的前提。
3. **P1 — outbox 接线**：`session/event` → capture，`session/flush` → flush，`session/created/disposed` → open/close。
4. **P2 — 工作区租约 + 上下文注入**接入会话生命周期与 `agent.inject()`。
5. **P2 — UI 卡片迁到 tool presentation + `tools/result` meta**。
6. **P3 — 内存模块迁移到 `sessionProjections`**，配置项化 `tokenBudget`，`apply()` 降级激活。
7. 更新 README / 兼容文档 / CHANGELOG，重签协议 receipt，按 README 的验证矩阵跑 `test:contract` 与真实 DSH+Libra 集成门。

---

## 附：最新 DSH 官方范本（本报告引用的参考实现）

| 用途 | 范本包 |
| --- | --- |
| pre-step 注入 + `sessionProjections` 追踪 | `@deepseek-ai/dsh-tmux-context`（`lib/index.js` 的 `apply()`） |
| `ctx.tools.register(defineTool(...))` 工具注册 | `@deepseek-ai/dsh-tool-present` |
| 审批缝（ask/never、audit） | `@deepseek-ai/dsh-user-approval` |
| 事件/工具流水线（`tools/pre-execute`、`tools/result`、presentation） | `@deepseek-ai/dsh-tools` |
| 会话投影注册表 | `@deepseek-ai/dsh-session-projection` |
| agent 事件词汇（`agent/pre-step`、`agent/request-error`、`Agent.inject`） | `@deepseek-ai/dsh-agent` |
| session 事件词汇与 `Session.append` 契约 | `@deepseek-ai/dsh-session` |
