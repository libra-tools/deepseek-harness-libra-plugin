# DeepSeek Harness 中的 Libra 版本管理插件计划（2026-11-18）

> **模板适配声明：** 本计划按相邻 `libra-backend` 仓库的 [`plan-template.md`](https://github.com/libra-tools/libra-backend/blob/cf/docs/plan/plan-template.md) v1.0 编写（本机 checkout：`/Volumes/Data/gitmono/libra-backend/docs/plan/plan-template.md`）。该模板移植自 Libra `docs/development/plan/plan-template.md` v2.16，并按 Libra Backend、Cloudflare Workers 与 `.libra` 工作流适配。任务计划归属本插件仓；模板留在最初请求的当前工作区。此计划只规划跨仓实施，不代表任何功能已经完成或已发布。
>
> **交付流程：** 本计划文件属于 `deepseek-harness-libra-plugin`，当前 branch `main`；本仓只有 `.libra/`，计划文件用 `libra add`、`libra commit -s -m`、`libra push origin main` 提交。模板文件属于 `libra-backend` 的 `cf` 分支，按本计划模板的对应流程单独提交推送。实施任务各自遵守所属仓库当前 AGENTS/计划规则。
>
> **目标仓库与基线（成稿时观察；实施前必须刷新）：**
>
> | 仓库 | 基线 | 状态与实施规则 |
> |---|---|---|
> | `libra-backend` | branch `cf`, `a0782cf78bc43209a59c6b7c51c75c760e0c773e` | 本计划与模板为新增文件；保持 `cf`，Libra 命令提交并推送。 |
> | `deepseek-harness-libra-plugin` | branch `main`, `27da28137bb9450a3a6f2ec14954bfccc5ed5dbd` | clean at plan inspection. Implement only after refreshing source and package compatibility. |
> | `libra` | branch `main`, `e8a21142fcba79d3ef30ece0ed43ca27cc1a5db6` | Inspection checkout contains unrelated unstaged changes in bridge, docs, and tests. Preserve them; before implementation establish a clean, reviewed task baseline and re-read its AGENTS/plan instructions. Facts below are checkout observations, not claims that those local edits are in the pinned commit. |
>
> DSH Desktop runtime is `0.2.2-rc.3`. The Libra plugin repo README identifies this source tree as unpublished `0.2.0`, while npm is `0.1.0`; do not describe source-tree capabilities as released package behavior. The compatibility receipt must be revalidated against the exact bridge executable and its `initialize.methods` response at implementation and release time.
>
> **User product constraint:** A supported Harness workspace is a Libra repository with `.libra`; it does not contain `.git` alongside `.libra`. This plan does not build a Git adapter, Git/Libra selector, dual-repository mode, or import/migration flow. The panel reads Libra repository truth. It does not replace the separate DSH turn-change card.

## 文档职责

**目标:** 在 DeepSeek Harness 中提供与 Git 面板相近、但由 Libra 原生仓库数据驱动的版本管理工作区：查看仓库状态和差异、浏览提交历史、暂存与提交，并明确展示相关 Agent 捕获状态。

**适用范围:**

- `libra`: 类型化 bridge 仓库状态、差异、历史和安全写方法，复用 Libra VCS 核心。
- `deepseek-harness-libra-plugin`: 以每个 Harness Session 的可信工作目录绑定 Libra 仓库，管理按仓隔离的 bridge/状态，并提供共享 Host 操作、Agent tools 与 Client UI。
- `libra-backend`: 只更新与已实现和已发布能力一致的网站接入文档；不在 Workers 中运行 Libra 二进制，也不访问本机仓库。

**非目标:**

- Git 支持或 Git/Libra 混合仓库：永久非目标，依据用户明确的产品约束——受支持工作区只有 `.libra`。
- 远端 push/pull/fetch、PR、合并、分支切换与解决冲突 UI：本计划首发永久非目标；将来如需支持，必须另立计划并定义各自安全/并发语义。
- 在 DSH Workers 网站执行本地 VCS 操作：永久非目标，网站只发布文档。
- 用 Memory recall 替代 Agent 捕获、或把回合 diff 当作持久仓库状态：永久非目标，语义不同。
- 以解析 CLI 人类可读文本、SQL 直读 Libra 数据库或通用 shell tool 充当 VCS API：永久非目标，接口必须来自 Libra 类型化 bridge/服务。

**成功定义:** 用户打开一个 `.libra` 工作区时，Harness 只显示该 Session 仓库的结构化状态；从文件可进入范围明确的 diff；提交历史可分页浏览；用户能暂存/取消暂存并提交；Agent 发起的写操作经 DSH approval；并可区分 Session 事件已确认、待发送、被拒绝/冲突、checkpoint 已存在和 commit 是否确实关联 Session。非受支持 bridge 明确显示能力不足，不显示伪造的空状态。多仓 Session 并行时无跨仓数据或写入。

## 事实基线

> 下列位置由 plan creation 时的只读源码/运行时查询核实。实现卡开工前刷新行号、分支、版本及目标合同。

| 类别 | 当前事实 | 证据 |
|---|---|---|
| 产品仓库 | 用户规定 Harness workspace 只含 `.libra`；本计划不需要 Git 并存选择。 | 本轮用户明确约束，2026-11-18 |
| Libra runtime | 本机 `libra --version` 为 `0.30.207`；版本号本身不能证明某个发布二进制含当前 checkout 的全部协议改动。 | `/Users/eli/.libra/bin/libra --version`; Libra Cargo.toml at `e8a2114` |
| Bridge allowlist | 已有 v1 方法 allowlist 含 `status.get`, `diff.get`, `history.search`, `commit.create`, checkpoint 与 workspace lease 等；未知方法 fail-closed。 | `libra/src/internal/ai/agent_bridge/protocol.rs:63-97` |
| 当前 `status.get` | 返回 bridge session/event/checkpoint 统计，而非 index/worktree 状态或 branch。 | `libra/src/internal/ai/agent_bridge/methods.rs:155-174` |
| 当前 `history.search` | 搜索 bridge sessions/events，不是 repository commit log。 | `libra/src/internal/ai/agent_bridge/methods.rs:176-197` |
| 当前 bridge diff | `diff.get` 有封闭 mode `worktree`/`staged`/`checkpoint`、受限 repo-relative paths、页数和 128 KiB patch cap；没有完整结构化工作树状态与提交历史详情接口。 | `libra/src/internal/ai/agent_bridge/methods.rs:248-272`; `libra/src/internal/ai/agent_bridge/vcs.rs:48-81` |
| 当前 plugin root | 一个 bundle runtime 启动一个共享 bridge，cwd 固定为 deployment repositoryRoot；配置 root 改变时现有 bridge 拒绝请求并要求 reload。 | `deepseek-harness-libra-plugin/packages/bundle/src/index.ts:540-604`; `packages/bundle/src/deployment.ts:93-114` |
| 当前工具面 | 已注册 `libra_context`, `libra_status`, `libra_diff`, `libra_history_search`, checkpoint、commit、review、restore 等 10 个工具；它们尚未组成完整 VCS panel。 | `deepseek-harness-libra-plugin/packages/tools/src/facade.ts:15-96` |
| 当前 Client UI | Libra 的配置 UI 注册 `plugins.bundle.config`；不是仓库状态页面。 | `deepseek-harness-libra-plugin/packages/bundle/client.js:147-159` |
| 当前 DSH turn changes | `workspaceChanges.summary/diff` 只服务仍活跃于本 Host 进程的 Session；这是回合快照比较，不是 Libra 暂存区、持久 history 或 capture receipt。 | Host Inspect `Service.listService(workspaceChanges)`; installed `@deepseek-ai/dsh-workspace-changes/README.md:10-12,84-97` |
| DSH UI 插槽 | 运行时有 Session-scoped keyed slot `sidebar.right.pane.tab`。该 slot 允许贡献 pane 内容；实际 tab type/registration contract 必须在 LVC-01 通过正式 UI 包/API 源码确认，不能只把 Inspect 当业务调用。 | Client Inspect `Slots.listSubTree(root="sidebar.right.pane.tab")` |
| DSH UI 操作模式 | Host operation 可以由 UI remote entry point 与 Agent tool 共享；授权行为仍只由用户执行，agent 写入遵守 approval。 | installed DSH `skills/dsh-doc/references/user-actions.md:5-15` |
| DSH Session cwd | `workingDirectory.get(session)` 可取得 effective directory；`libra rev-parse --show-toplevel` 支持从可信目录发现 Libra root。 | Host Inspect `Service.listService(workingDirectory)`; local CLI `libra rev-parse --help` |
| Website runtime | 网站部署在 Cloudflare Workers；不能在网站运行时使用 `fs`, `path`, `child_process`。 | `AGENTS.md`; `apps/tanstack-app/AGENTS.md` |

## 当前缺口

| ID | 缺口 | 影响 | 证据 | 计划动作 |
|---|---|---|---|---|
| GAP-01 | `status.get` 是捕获/bridge 计数，不是 Libra 工作区 status。 | 类似 Git 的 Changes 面板无法正确显示 staged/unstaged/untracked/conflict。 | `libra/.../methods.rs:155-174` | LVC-01, LVC-02 |
| GAP-02 | bridge 无结构化 commit history/detail API。 | 不能提供可靠的版本历史浏览。 | `methods.rs:176-197`; protocol allowlist | LVC-01, LVC-03 |
| GAP-03 | 插件将一个全局 repositoryRoot 用作单 bridge cwd。 | 多个 Harness workspaces/session 不能安全隔离。 | `packages/bundle/src/index.ts:540-604` | LVC-04 |
| GAP-04 | 没有对应 Host UI page/tab，现有 Client 仅含 bundle settings。 | 用户无法用 UI 操作 Libra VCS。 | `packages/bundle/client.js:147-159` | LVC-05 |
| GAP-05 | 现有 commit 工具未覆盖 stage/unstage 交互；UI 写操作和 Agent tool 需要相同操作服务。 | 手动与 Agent 操作可能行为不一致，审批/并发安全不完整。 | protocol allowlist + `skills/dsh-doc/references/user-actions.md` | LVC-06, LVC-07 |
| GAP-06 | Outbox/capture 与 checkpoint/commit 关联状态未在面板以逐项可靠状态呈现。 | 用户可能把 flush/Session closed 错当成完整捕获。 | plugin `packages/session/src/outbox.ts:84-187`; README capture description | LVC-08 |
| GAP-07 | 文档尚无已发布版本的完整 VCS UI 能力说明。 | 用户会混淆 development bundle 和 published package。 | plugin README `:3-7`; backend DSH guide | LVC-09 |

## 与其它计划的关系

| 计划/文档 | 关系 | 本计划处理 |
|---|---|---|
| `libra/docs/development/plan/plan-template.md` v2.16 | 上游流程模板 | 结构与粒度继承；本计划在三个仓分别遵守其实际 AGENTS/计划制度，不复制其 Rust 发布假设到网站仓。 |
| `libra-backend/docs/plan/plan-template.md` v1.0 | 本计划模板 | 规范本仓文档/网站任务和跨仓登记。 |
| plugin `README.md`, `docs/compatibility.md`, `docs/protocol/agent-bridge-v1.md` | 插件架构与 compatibility authority | 发布 bundle 前更新并核实 package version 与握手清单。 |
| DSH `workspaceChanges` | 并存能力 | 不替换、不复用为 repository status；保留其回合 diff 语义。 |
| 现有 Libra bridge Memory 方法 | 可选独立能力 | 不作为版本管理依赖；不同版本可没有 Memory。 |

## 设计决策

### ADR-01: Libra 是该工作区唯一版本管理后端

- **决定:** 插件把当前 Harness Session 的可信 working directory 解析为唯一 `.libra` repository；不探测或切换 Git。非 Libra 目录返回清楚的不可用状态。
- **理由:** 用户确认受支持工作区只有 `.libra`；重复仓库抽象会制造错误选择与写入风险。
- **后果:** DSH 自带 Git-based workspace changes 可能只覆盖其自身定义的文件编辑范围；Libra 插件只对 Libra VCS 真值负责。

### ADR-02: Host 拥有仓库绑定与操作，UI 和 Agent tools 共用实现

- **决定:** Host Service 在边界校验 Session → repository binding、能力、路径、expected state 和 approval；Client 只读/提交 UI intent；Agent tools 调同一个 Host operation。
- **理由:** DSH user-actions pattern 明确要求同一 operation 两种 caller；Inspect 只发现合同，不承载业务调用。
- **后果:** 需在 LVC-01 验证适当的远程 Host entry point、tab route/props、actor/approval 传递方式，并以服务端判权。

### ADR-03: 每个 Session 以可信目录绑定到规范化 Libra root

- **决定:** Host 从 `workingDirectory.get(session)` 取路径；由 Libra 自己的 repository discovery 解析根路径；bridge/runtime/cache/outbox 按 canonical repo identity 隔离。模型输入不能指定 root。
- **理由:** 当前全局固定 root 会串仓。路径验证由 Libra 核心复用；Harness cwd 可能变化，因此每次 operation 校验已绑定 root 与当前 Session cwd 一致。
- **后果:** 多仓并行需要 bridge pool 或等效隔离；worktree/session cwd 改变时拒绝并要求明确重新绑定，不静默迁移既有 outbox。

### ADR-04: VCS 与 Agent 捕获分层呈现

- **决定:** 同一 Libra 面板可提供两个区域/分段：VCS (`status`, staged, diff, commits) 与 Agent history (`sessions`, capture delivery, checkpoints, confirmed linkage)。memory recall 是单独的 optional capability。
- **理由:** Session event ack、checkpoint 和 commit 是独立事实；flush success 不等于 capture complete 或 commit linked。
- **后果:** UI 需要 pending/accepted/duplicate/rejected/conflict/gap/unknown 等状态，不可用单一绿色完整标记替代。

### ADR-05: 新方法可协商，返回结构化有界结果

- **决定:** 新增 typed bridge methods 与 schema/fixture、capability negotiation；状态/历史分页，diff 字节限额与截断原因显式，文件路径必须 repository-relative 且拒绝 pathspec magic。
- **理由:** 现有 v1 allowlist fail-closed，当前 status/history 名称是 bridge history 语义；不能重解释旧方法而破坏已有客户端。
- **后果:** 旧 peer 明确显示 unsupported；不得把空 response 当作空仓库。

## 实施顺序

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| Phase 0 — contract spike | 确认 DSH tab/remote operation contract、Libra root discovery 与数据来源，并冻结 schemas/能力矩阵。 | LVC-01 Codex PASS；接口无依赖 shell 文本/DB 直读；已验证多 Session cwd 入口。 |
| Phase 1 — read-only VCS | LVC-02 and LVC-03 may run in parallel after LVC-01; then LVC-04 Host reads and LVC-05 read-only panel. | Two `.libra` workspaces are isolated; old bridge capabilities show unsupported; status/diff/log work. |
| Phase 2 — safe local writes | LVC-06 Libra stage/unstage/commit follows LVC-02 on shared bridge files; LVC-07 adds shared Host/UI/tool actions. | stale state does not mutate; repeat operation is idempotent; Agent writes require approval. |
| Phase 3 — capture context | LVC-08 shows outbox ack/reject/gap, checkpoints and confirmed commit linkage. | pending/rejected/gap/unknown are distinct; linkage is shown only when Libra confirms it. |
| Phase 4 — release and site publish | Complete docs in each behavior card; release Libra then plugin, and deploy the accumulated website guide only after both. | Exact artifacts/handshake evidence pass; Cloudflare deploy and live routes are verified. |

## 依赖登记表

| DEP-ID | 提供方 | 消费方 | 产物 | 状态 |
|---|---|---|---|---|
| DEP-01 | LVC-01 | LVC-02, LVC-03 | frozen DSH/Libra contracts and repository-binding rules | planned |
| DEP-02 | LVC-02 | LVC-04, LVC-05, LVC-06 | negotiated typed read contract and generated fixture/TS types | planned |
| DEP-03 | LVC-03 | LVC-04, LVC-05, LVC-07, LVC-08 | per-Session binding and per-repository bridge service | planned |
| DEP-04 | LVC-04 | LVC-05 | Host read service and readonly tool contracts | planned |
| DEP-05 | LVC-05 | LVC-07 | read-only panel shell and selected-session UI context | planned |
| DEP-06 | LVC-06 | LVC-07 | fenced stage/unstage/commit bridge contract | planned |
| DEP-07 | LVC-07 | LVC-08 | shared UI/Agent mutation service | planned |
| DEP-08 | LVC-08 | LVC-09 | capture status projection and verified linkage contract | planned |
| DEP-09 | Libra release point | plugin release point | released bridge artifact + exact handshake compatibility evidence | planned |

## 任务卡

### Task LVC-01: Freeze DSH operation and Libra repository contracts

**Task type:** `spike`

**Lifecycle / Acceptance:** `pending` / ` `

**Description:** 用运行时 Inspect 和已安装 DSH package source 验证 Session cwd、sidebar tab registration/props、Host remote operation / action entry points；对照 Libra command/core 确认 status/index/log/discovery 数据来源，冻结 read/write schemas 和错误状态。行为轴：接口合同。

**Out of scope:** 不实现代码（本卡产物供 LVC-02..08）；不开发 Git 支持（永久非目标）；不读取用户数据库或秘密（永久非目标）。

**Current evidence:**

| 事实 | 证据 |
|---|---|
| keyed pane slot 存在但 slot type registration/props 仍需从正式 source 验证。 | Runtime Inspect `Slots.listSubTree(sidebar.right.pane.tab)` |
| 当前 `status.get` 和 `history.search` 不是 VCS status/log。 | `libra/src/internal/ai/agent_bridge/methods.rs:155-197` |
| 当前 install CLI 可从 working directory 查 Libra top-level。 | `/Users/eli/.libra/bin/libra rev-parse --help` |

**Acceptance criteria:**

- [ ] 记录正式的 DSH Client tab 注册与点击/刷新 operation 远程入口、props、生命周期，引用已安装 source 文件/版本；如 pane tab 不适用，给出已验证的兼容 surface。
- [ ] 定义 `repo identity`, status entry, cursor, diff sides/truncation, commit page/detail, write fence, operation result, capture status 的 JSON schema 与错误语义；所有名称标为 proposed 或来源合同。
- [ ] 确认每个 Session 从可信 cwd 绑定到一个 `.libra`；cwd 变化与 repo 不存在时 fail closed；不存在 Git 探测路径。
- [ ] 输出明确的 version/capability matrix：published plugin/libra 与 development source 分开，Memory optional。
- [ ] ER-06/ER-12：本卡只改计划文件/可能新增 ADR 文件须先登记；此卡无代码和运行时配置改动。

**Verification:**

- [ ] Inspect queries `workingDirectory`, `Slots.listSubTree`, remote callable Host services；引用运行时 DSH `0.2.2-rc.3`。
- [ ] Libra source/unit/read-only CLI 交叉核对，记录所用 commit 和相关测试名，不以 CLI 人类文本作为正式协议。
- [ ] Codex review 此卡产物，所有 P0/P1 关闭。

**Full-suite trigger:** `none`（只读合同 spike）

**Dependencies:** 无。

**Deliverables:** 本计划 ADR-01..05 更新与 schemas/contracts 决策小节；不得新增证据文件夹。

**Implementation write set:** `deepseek-harness-libra-plugin: docs/plan/plan-20261118-libra-version-control.md`; backend template is a read-only dependency, and Libra source is read-only during this spike.

**Release write set:** `N/A`

**Files likely touched:** 本计划文件。

**Docs and compatibility impact:** 本计划文件；N/A for product docs because no public behavior is implemented.

**Rollback mode:** `revert`

**Migration and rollback:** N/A。

**Security and privacy:** 不读取用户仓库内容或数据库；只用 synthetic fixtures 和 help/source。

**Performance budget:** N/A。

**Estimated scope:** `S`

**Version increment:** `N/A`

**Release boundary:** `no-release`

**C/D coverage from:** `self`

**Split/dependency notes:** 后续实现不得在 contract 未冻结前并行开发。

**修订历史:** 初稿。

### Task LVC-02: Add typed Libra VCS read protocol

**Task type:** `implementation`

**Lifecycle / Acceptance:** `pending` / ` `

**Description:** 在 Libra bridge 增加协商式、分页且有界的仓库 identity/status、diff 与 commit history/detail 查询，复用 Libra VCS 核心。行为轴：只读 VCS 状态合同。

**Out of scope:** plugin Host/Agent tool integration（LVC-04）及 Client panel（LVC-05）；所有写方法（LVC-06）；Git。

**Current evidence:** `status.get`/`history.search` 语义和现有 `diff.get` 限额见事实基线。

**Acceptance criteria:**

- [ ] 新增协议能力是 additive/minor-negotiated；旧 1.x peer 的既有行为不变，未知/未协商方法 fail closed。
- [ ] Status 返回 repo identity、branch/HEAD/unborn 与分页状态项，区分 staged/unstaged/untracked/conflict/rename；无仓库与能力不足是结构化状态，不能伪装为空仓。
- [ ] Log/detail 有 cursor pagination；diff 使用封闭 comparison enum 和 repo-relative path；binary/oversized/truncated 明示；响应 obey method/frame/page/byte limits。
- [ ] 值全部来自 Libra 核心服务，禁止 SQL 直读、外部 `git` 进程、shell 文本解析或任意 revision/path。
- [ ] 同步 Libra protocol fixture/schema、compatibility record、tests index 与相关 developer/command docs；注明 `status.get` 仍是 bridge telemetry。
- [ ] ER-06/ER-12/ER-14：本卡同卡更新 Libra developer/protocol docs、plugin protocol schema 与 receiver contract；plugin README/site guide 为 N/A，理由是 Host/UI 尚未公开消费这些方法（由 LVC-04/05 在可用 slice 更新）；CLI command docs 为 N/A unless command/help behavior changes. 每项判定按仓记录。

**Verification:**

- [ ] From Libra repo root: `cargo test --test agent_bridge_vcs_test --test agent_bridge_read_methods_test --test agent_bridge_protocol_test --test agent_bridge_schema_test` (new cases marked `(new)` in existing targets; do not add a new test target unless this card also registers it and updates `tests/INDEX.md`).
- [ ] From Libra repo root: `cargo +nightly fmt --all --check`.
- [ ] From Libra repo root: `cargo clippy --all-targets --all-features -- -D warnings`.

**Full-suite trigger:** `T-1`: 跨 protocol、VCS、compatibility/schema surfaces 的公共 bridge 合同变更；最终全量门仍由收口阶段执行。

**Dependencies:** `DEP-01`。可与 LVC-03 并行；LVC-06 必须等待本卡，因为两卡共享 Libra protocol/method/VCS 写集。

**Deliverables:** Libra typed bridge read API、fixture/schema、focused tests、兼容记录与 docs。

**Implementation write set:** `libra: src/internal/ai/agent_bridge/protocol.rs; src/internal/ai/agent_bridge/methods.rs; src/internal/ai/agent_bridge/vcs.rs; tests/agent_bridge_vcs_test.rs; tests/agent_bridge_read_methods_test.rs; tests/agent_bridge_protocol_test.rs; tests/agent_bridge_schema_test.rs; tests/INDEX.md; docs/development/tracing/deepseek-harness.md; COMPATIBILITY.md; deepseek-harness-libra-plugin: protocol/agent-bridge.v1.schema.json; docs/protocol/agent-bridge-v1.md; tests/protocol/receiver.test.ts; libra-backend: N/A because these bridge methods are not yet exposed through the plugin UI/tool surface (documented at LVC-04/05)`.

**Release write set:** `Inherited from REL-01 Libra bridge release`。

**Files likely touched:** Libra bridge protocol, methods, VCS adapter, fixture and focused tests/docs.

**Docs and compatibility impact:** Same-card Libra developer protocol docs (`docs/development/tracing/deepseek-harness.md`, `COMPATIBILITY.md`, protocol compatibility docs, `tests/INDEX.md`) and plugin `protocol/agent-bridge.v1.schema.json` + `docs/protocol/agent-bridge-v1.md` receiver contract. Update `docs/commands/agent.md` + zh-CN twin only if CLI command/help behavior changes, otherwise record N/A with source-based reason. Plugin README and website guide are N/A because no plugin tool or Client behavior exposes these methods yet; those surfaces update at LVC-04/05.

**Rollback mode:** `forward-only` after bridge release; before release revert additive methods/fixture together.

**Migration and rollback:** No database schema migration expected; if implementation requires one, stop and revise this plan with migration/rollback tests.

**Security and privacy:** Validate every path/cursor/revision selector; no absolute user path in model-facing read tool output; bound output and redact sensitive repository fields.

**Performance budget:** Status and first history page ≤ 1 second on synthetic 10k-entry repo; cursor pages bounded; no full-history scan per UI refresh.

**Estimated scope:** `M`

**Version increment:** Libra release version per Libra plan.

**Release boundary:** `independent, REL-01` (release the additive bridge protocol before plugin depends on it).

**C/D coverage from:** `self`

**Split/dependency notes:** schema names are finalized by LVC-01; do not repurpose legacy `status.get`, `history.search`, or `diff.get` semantics.

**修订历史:** 初稿。

### Task LVC-03: Bind bridge runtime per Harness Session repository

**Task type:** `implementation`

**Lifecycle / Acceptance:** `pending` / ` `

**Description:** 将插件从单一固定 repositoryRoot bridge 改为基于可信 Session effective cwd 的 repository binding，并按 canonical `.libra` repo 隔离 bridge 生命周期和相关 state。行为轴：Session-to-repository binding。

**Out of scope:** Git detection/dual mode；writes and panel UI；自动把已有 session/outbox 跨仓迁移。

**Current evidence:** 当前 bundle 单 bridge cwd 取 deployment root，配置变更后 reload required：`packages/bundle/src/index.ts:540-604`；Libra CLI root query 在事实基线中验证。

**Acceptance criteria:**

- [ ] 每次 Session 首次访问时从 Host trusted workingDirectory 获取 cwd，并用 Libra repository discovery 得出 canonical root/id；不接受 model-provided path。
- [ ] 缺 `.libra` / 不可用 bridge / 版本能力不足分别给出可见、机器可判别结果；不退回 Git、process cwd 或其他 Session repository。
- [ ] 多仓 Session 并行时 bridge process、lease、state、outbox 与 request binding 均按 repo 隔离；cwd 后续变化而 repository identity 不同则 fail closed 并要求明确重绑定。
- [ ] 共享 bridge pool 正确引用计数/关闭；plugin unload 清理所有实例；关闭期间事件可靠保留；旧单 root Config 有明确弃用/迁移路径。
- [ ] 测试两个以上 synthetic Libra roots、并发 request、cwd change、not-repo、process restart、shutdown 与 outbox 不跨仓。
- [ ] 每个运行中的 bridge 记录自己的身份证据：resolved executable 绝对路径、该文件的 SHA-256、child PID、以及该 bridge `initialize` 返回的完整 protocol/limits/methods；Host 同时记录**当前实际加载的 bundle** 的包目录与 `dist/index.js` 的 SHA-256（取自运行进程自身的模块位置，不读取配置文件推断）。这些值通过只读 Host 诊断接口暴露（不可由模型选择或篡改），供 LVC-05 面板与 LVC-09 验收直接读取，而不是另起进程推断。
- [ ] ER-06/ER-12/ER-14：同卡更新 plugin README/config/compatibility/profile docs 和 website guide 的 workspace-binding 段；只改源文件不部署，REL-03 前保持不公开；逐仓列入写集。

**Verification:**

- [ ] From plugin repo root: `pnpm test -- tests/bundle/repository-binding.test.ts tests/bridge-client/repository-pool.test.ts` (new specs in existing Vitest target; new test cases marked `(new)`).
- [ ] From plugin repo root: `pnpm check`.
- [ ] From `/Volumes/Data/gitmono/libra-backend`: `pnpm typecheck && pnpm build` and `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/specs/docs.spec.ts`.
- [ ] 使用隔离临时 `.libra` fixtures 做 Host/bridge smoke；不访问用户仓库或数据库。

**Full-suite trigger:** `T-1`: Session lifecycle、bridge pool、outbox 与 repository isolation 跨切面；收口阶段跑全仓 gates。

**Dependencies:** `DEP-01`。LVC-02 与本卡可在冻结合同后并行；本卡不消费 VCS read methods。

**Deliverables:** session-scoped Host repository registry/pool，配置迁移说明和隔离测试。

**Implementation write set:** `deepseek-harness-libra-plugin: packages/bundle/src/deployment.ts; packages/bundle/src/index.ts; packages/bundle/src/repository-binding.ts (new); packages/bridge-client/src/client.ts; packages/session/src/outbox.ts; tests/bundle/repository-binding.test.ts (new); tests/bridge-client/repository-pool.test.ts (new); README.md; docs/compatibility.md; docs/profile.md; libra-backend: apps/tanstack-app/content/docs/getting-started/deepseek-harness.en.md (workspace-binding section; source only, no deploy before REL-03)`.

**Release write set:** `Inherited from REL-02 plugin release`。

**Files likely touched:** plugin deployment, bridge client, session outbox, bundle tests and compatibility docs.

**Docs and compatibility impact:** Same-card updates: plugin README, `docs/compatibility.md`, `docs/profile.md`, and the named website guide section. Keep website source on `cf`; do not run `pnpm deploy:cf` before REL-03. Verify in LVC-01 whether pushing `cf` triggers an automatic deployment.

**Rollback mode:** `revert` before release; `forward-only` after release if saved config migration has shipped.

**Migration and rollback:** Existing repositoryRoot config maps to the Session repository only when it matches Session cwd discovery; otherwise show actionable warning and allow explicit user-scoped opt-in only if LVC-01 approves a secure contract. No silent fallback.

**Security and privacy:** Repo binding from Host session state; prevent path traversal/root confusion; do not expose host absolute path to model; no credentials or database access.

**Performance budget:** Reuse one bridge per canonical root, not per tool call; bound pool idle/active instances and close only after references/flush drain.

**Estimated scope:** `M`

**Version increment:** plugin release per plugin package workflow.

**Release boundary:** `independent, REL-02` after REL-01.

**C/D coverage from:** `self`

**Split/dependency notes:** Must land before UI can concurrently address two workspaces.

**修订历史:** 初稿。

### Task LVC-04: Add paginated Libra repository history and diff detail to the Host service

**Task type:** `implementation`

**Lifecycle / Acceptance:** `pending` / ` `

**Description:** Extend the plugin Host service with typed, bounded reads that invoke only negotiated bridge methods and retain repo binding for every request. Behavior axis: read-only Host API.

**Out of scope:** Client components and mutation tools; model does not receive unbounded history or absolute workspace paths.

**Current evidence:** Current tool facade’s diff/history semantics are documented in `packages/tools/src/facade.ts:15-96`; VCS methods to be added by LVC-02.

**Acceptance criteria:**

- [ ] Status/diff/log/detail Host methods use repository id from session binding, typed validated params and cursors; cannot choose another root.
- [ ] Missing/unadvertised method yields explicit `unsupported_capability`; disconnected/permission/stale/cursor errors remain distinct.
- [ ] Diffs preserve scope labels and truncated/binary/oversized metadata; UI refresh can cancel stale requests.
- [ ] Host service contract is consumable by Client UI and readonly Agent tools; no duplicate CLI parsing path.
- [ ] ER-06/ER-12/ER-14 same-card plugin README/tools/compatibility docs and website VCS-read section are updated; website source stays undeployed until REL-03.

**Verification:**

- [ ] From plugin repo root: `pnpm test -- tests/bridge-client/libra-vcs-read.test.ts tests/tools/vcs-read-tools.test.ts` (new specs in existing Vitest target; new test cases marked `(new)`).
- [ ] From plugin repo root: `pnpm typecheck && pnpm build`.
- [ ] From `/Volumes/Data/gitmono/libra-backend`: `pnpm typecheck && pnpm build` and `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/specs/docs.spec.ts`.

**Full-suite trigger:** `none` for isolated typed adapter; included in final integration full suite.

**Dependencies:** `DEP-02`, `DEP-03`.

**Deliverables:** typed Host service and readonly tool schemas.

**Implementation write set:** `deepseek-harness-libra-plugin: packages/bundle/src/index.ts; packages/bundle/src/vcs-read.ts (new); packages/tools/src/facade.ts; packages/tools/src/vcs-read.ts (new); packages/bridge-client/src/client.ts; packages/bridge-client/src/vcs-methods.ts (new); protocol/agent-bridge.v1.schema.json; tests/bridge-client/libra-vcs-read.test.ts (new); tests/tools/vcs-read-tools.test.ts (new); README.md; docs/tools.md; libra-backend: apps/tanstack-app/content/docs/getting-started/deepseek-harness.en.md (VCS read tools section; source only, do not deploy before REL-03)`.

**Release write set:** `Inherited from REL-02`。

**Files likely touched:** Host read facade, Agent readonly tools, protocol types, tests and same-card product documentation.

**Docs and compatibility impact:** Same-card plugin README, `docs/tools.md`, `docs/compatibility.md`, and the named website guide section. Do not deploy the website before REL-03.

**Rollback mode:** `revert`

**Migration and rollback:** N/A.

**Security and privacy:** Do not pass UI display data from another repo; validate tool inputs and minimize model-visible repository metadata.

**Performance budget:** Cursor pages and diff size are bounded by Libra contract; avoid duplicate calls per render.

**Estimated scope:** `M`

**Version increment:** plugin release per plugin package workflow.

**Release boundary:** `independent, REL-02` (serialized with LVC-03/LVC-05/LVC-06).

**C/D coverage from:** `self`

**Split/dependency notes:** LVC-04 = Host integration, not Libra protocol LVC-02.

**修订历史:** 初稿。

### Task LVC-05: Implement the read-only Libra panel

**Task type:** `implementation`

**Lifecycle / Acceptance:** `pending` / ` `

**Description:** Add the Libra session tab showing repository identity, branch/HEAD, staged/unstaged/untracked/conflict sections, bounded file diff and commit history. Behavior axis: read-only Client experience.

**Out of scope:** stage/commit buttons (LVC-07); replacing DSH workspace changes; remote operations.

**Current evidence:** `sidebar.right.pane.tab` exists in installed Client Inspect; `packages/bundle/client.js` currently only registers config UI. Formal tab type contract is LVC-01 deliverable.

**Acceptance criteria:**

- [ ] Shows explicit `Libra` tab only for a bound `.libra` Session; status/error/unsupported/loading/empty are distinct.
- [ ] Lists status groups and counts with file state, rename/conflict representation, pagination and refresh; selected file diff names its comparison sides.
- [ ] History pagination and commit detail work for the same repository; changing active Session cannot flash or reuse prior Session data.
- [ ] Uses DSH theme/i18n and installed Client slot contracts; English and zh-CN keys match; no hardcoded visible UI text.
- [ ] Keyboard navigation, loading/empty/error states, bounded diff rendering, and cancellation verified in browser.
- [ ] A read-only diagnostics area in the panel shows, for the current Session's live bridge: resolved executable path, that file's SHA-256, child PID, negotiated protocol version, and the complete negotiated method list returned by that bridge's `initialize`, plus the loaded bundle's package directory and `dist/index.js` SHA-256. Values come from the Host record (LVC-03), never from a separately spawned probe or a config-file guess.
- [ ] ER-06/ER-12 same-card plugin README/UI docs, compatibility range and website panel guide section are accurate; website deployment remains gated on REL-03.

**Verification:**

- [ ] From plugin repo root: `pnpm test -- tests/ui/libra-version-control-panel.test.ts` (new spec in existing Vitest target; new test cases marked `(new)`).
- [ ] From plugin repo root: `pnpm check`.
- [ ] From `/Volumes/Data/gitmono/libra-backend`: `pnpm typecheck && pnpm build` and `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/specs/docs.spec.ts`.
- [ ] Install the bundle in a disposable profile on the target DSH `0.2.2-rc.3` runtime with a released Libra binary, and configure that profile's `libraExecutable` to the exact released binary path (see LVC-09 for the profile/artifact procedure). Open two separate `.libra` workspaces and verify status, scoped diff, commit history, unsupported-capability and offline states in the Libra tab. Confirm no `.git` is present, switching Sessions never leaks repository rows/diffs, and record exact DSH/Libra artifact versions, binary SHA-256 and outcomes in this plan.

**Full-suite trigger:** `T-1`: new Client UI slot and Host read-service composition crosses plugin modules.

**Dependencies:** `DEP-03`, `DEP-04`.

**Deliverables:** localized Libra VCS tab, settings-free repository status display and UI tests.

**Implementation write set:** `deepseek-harness-libra-plugin: packages/bundle/client.js; packages/bundle/client/libra-tab.js (new; validate loader contract in LVC-01); packages/bundle/package.json (only if module export/files list changes); tests/ui/libra-version-control-panel.test.ts (new); README.md; docs/ui.md; libra-backend: apps/tanstack-app/content/docs/getting-started/deepseek-harness.en.md (read-only panel section; source only, no deploy before REL-03)`.

**Release write set:** `Inherited from REL-02`。

**Files likely touched:** Client bundle, UI renderer, locales, slots declaration and UI tests.

**Docs and compatibility impact:** Same-card updates: plugin README, `docs/ui.md`, compatibility range and backend guide's read-only panel section. Keep backend source change on `cf`; do not deploy it before REL-03.

**Rollback mode:** `revert`

**Migration and rollback:** N/A.

**Security and privacy:** Render only current user’s local workspace metadata; escape filenames; never render untrusted markdown as HTML; do not leak absolute path or raw content to logs.

**Performance budget:** Virtualize or page large status lists; render only selected bounded diff; stale requests canceled.

**Estimated scope:** `M`

**Version increment:** plugin release per package workflow.

**Release boundary:** `independent, REL-02`。

**C/D coverage from:** `self`

**Split/dependency notes:** Depends on LVC-04 Host read API. If required tab API differs, update plan before implementation rather than monkey-patching DSH UI.

**修订历史:** 初稿。

### Task LVC-06: Add safe Libra stage, unstage and commit protocol

**Task type:** `implementation`

**Lifecycle / Acceptance:** `pending` / ` `

**Description:** Add explicit local write operations to Libra bridge using Libra VCS core and concurrency fences. Behavior axis: safe index and commit mutations.

**Out of scope:** discard/reset, branch checkout, merge, push/pull/fetch; each is future plan due to destructive/remote semantics.

**Current evidence:** Existing allowlist has `commit.create` and `checkpoint.restore`, but no stage/unstage; VCS path selector validation and commit message limits exist in `vcs.rs`.

**Acceptance criteria:**

- [ ] Add negotiated typed `stage`, `unstage`, and `commit` methods; no reinterpreting legacy `commit.create` semantics.
- [ ] Inputs are bounded repository-relative literal paths, action enum, idempotency `operation_id`, and expected HEAD/index/worktree fence; no raw ref/pathspec/revision string.
- [ ] Stale fence returns structured `stale_state` without mutation; repeated operation ID returns same recorded outcome; partial file failures identify each path.
- [ ] Commit result includes commit OID and exact affected paths; session/evidence linkage only if explicitly requested and bridge confirms it.
- [ ] No shell interpolation; operations call Libra internals, approval enforcement remains at the plugin/DSH boundary; bridge still validates repository scope.
- [ ] Same-card ER-06/ER-12/ER-14 updates Libra bridge/developer protocol docs, `tests/INDEX.md`, compatibility record, and plugin protocol schema/receiver docs. Add `(new)` cases to the existing `agent_bridge_vcs_test`, `agent_bridge_mutation_test`, `agent_bridge_approval_test`, and `agent_bridge_protocol_test` targets; do not add targets unless registered in this card. Plugin user guide and website page are N/A until UI/tool exposure in LVC-07; CLI docs are N/A unless command/help behavior changes, with per-file rationale recorded.

**Verification:**

- [ ] From Libra repo root, add `(new)` test functions to the existing targets and run: `cargo test --test agent_bridge_vcs_test --test agent_bridge_mutation_test --test agent_bridge_approval_test --test agent_bridge_protocol_test`.
- [ ] `cargo +nightly fmt --all --check`
- [ ] From Libra repo root: `cargo clippy --all-targets --all-features -- -D warnings`; use only synthetic repositories.

**Full-suite trigger:** `T-1` and `T-5`: new public write protocol and explicit approval/fence contract.

**Dependencies:** `DEP-01`, `DEP-02`。LVC-02 必须先于本卡，因为两卡共享 protocol/method/VCS 写集；LVC-03 可与 LVC-02 并行。

**Deliverables:** bridge write methods, idempotency/fence handling, schema/fixture and focused tests.

**Implementation write set:** `libra: src/internal/ai/agent_bridge/protocol.rs; src/internal/ai/agent_bridge/methods.rs; src/internal/ai/agent_bridge/vcs.rs; tests/agent_bridge_vcs_test.rs; tests/agent_bridge_mutation_test.rs; tests/agent_bridge_approval_test.rs; tests/agent_bridge_protocol_test.rs; tests/INDEX.md; COMPATIBILITY.md; docs/development/tracing/deepseek-harness.md; deepseek-harness-libra-plugin: protocol/agent-bridge.v1.schema.json; docs/protocol/agent-bridge-v1.md; tests/protocol/receiver.test.ts; plugin README/site guide: N/A because stage/unstage/commit are not exposed until LVC-07.

**Release write set:** `Inherited from REL-01`; serialize protocol additions with LVC-02 in one Libra release point if same branch and no independent compatible release can be cut.

**Files likely touched:** Libra bridge protocol and VCS service plus tests/schema/docs.

**Docs and compatibility impact:** Same-card Libra protocol/developer docs and `COMPATIBILITY.md`; `docs/commands/agent.md` + zh-CN twin only if user-visible CLI behavior changes, otherwise N/A with evidence. Plugin and website docs are N/A because the methods are not yet exposed; LVC-07 updates those files in the same card that exposes the UI/tool operations.

**Rollback mode:** `forward-only` after release; pre-release revert all schemas and methods together.

**Migration and rollback:** No persistent schema required unless idempotency storage needs durable records; if so, stop and add explicit migration/backfill/rollback tests before proceeding.

**Security and privacy:** approval by action and selected paths; preserve symlink/path containment rules; no data loss on stale state; no operation on repo other than trusted session binding.

**Performance budget:** one mutation request bounded by existing bridge deadlines/limits; path count ≤ current bridge contract cap or stricter; no full status scan after each per-file operation if batch API suffices.

**Estimated scope:** `M`

**Version increment:** Libra release version per Libra plan.

**Release boundary:** `independent, REL-01`。

**C/D coverage from:** `self`

**Split/dependency notes:** Must be released before plugin exposes write actions.

**修订历史:** 初稿。

### Task LVC-07: Share mutation operations between UI and Agent tools

**Task type:** `implementation`

**Lifecycle / Acceptance:** `pending` / ` `

**Description:** Add a Host operation service for stage/unstage/commit and expose it to UI and Agent tools with matching params/results; Agent write calls require DSH approval, UI remains explicit user-driven. Behavior axis: one shared mutation path.

**Out of scope:** Implementing separate UI and tool handlers; Agent can never authorize/approve its own operation.

**Current evidence:** Installed DSH user-action reference requires one Host operation called by UI and Agent tool; current plugin write tools request approval before bridge.

**Acceptance criteria:**

- [ ] Host methods enforce Session → repo binding and call LVC-06 methods; UI and Agent tool share the same method and error/result contract.
- [ ] Agent stage/unstage/commit requires the existing DSH approval path with operation/path summary; denial performs no bridge write.
- [ ] UI action cannot be forged by model tool payload; approval decision remains a user-only authority.
- [ ] UI refreshes canonical Libra state after success; on stale result it refreshes and asks user to retry; no optimistic success survives server rejection.
- [ ] Contract tests compare operation effects, return values and failures through UI entrypoint and Agent tool.
- [ ] ER-06/ER-12/ER-14 same-card plugin tool/approval/privacy docs and website stage/commit guide are updated; website source is not deployed before REL-03.

**Verification:**

- [ ] From plugin repo root: `pnpm test -- tests/tools/vcs-write-tools.test.ts tests/ui/vcs-user-actions.test.ts` (new specs in existing Vitest target; new test cases marked `(new)`).
- [ ] From plugin repo root: `pnpm check`.
- [ ] From `/Volumes/Data/gitmono/libra-backend`: `pnpm typecheck && pnpm build` and `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/specs/docs.spec.ts`.
- [ ] In the target DSH `0.2.2-rc.3` profile that has `libraExecutable` set to the exact released binary (see LVC-09), with two disposable `.libra` roots, perform stage/unstage/commit from the UI; deny an Agent write and confirm no mutation; approve one write and confirm the resulting OID; change the index externally, retry with the old fence, and confirm `stale_state` plus refreshed UI. Check the same paths in `libra status`/`libra log`; record the binary SHA-256, DSH version, package version and outcomes in this plan.

**Full-suite trigger:** `T-1` shared UI/Agent operation and DSH approval path.

**Dependencies:** `DEP-03`, `DEP-05`, `DEP-06`.

**Deliverables:** Host mutation service, UI remote action, Agent tool schemas and parity tests.

**Implementation write set:** `deepseek-harness-libra-plugin: packages/bundle/src/index.ts; packages/bundle/src/vcs-write.ts (new); packages/tools/src/facade.ts; packages/tools/src/vcs-write.ts (new); packages/bundle/client.js; packages/bundle/client/version-control-actions.js (new; tab/remote contract per LVC-01); tests/tools/vcs-write-tools.test.ts (new); tests/ui/vcs-user-actions.test.ts (new); tests/bundle/vcs-write-service.test.ts (new); README.md; docs/tools.md; docs/ui.md; docs/security.md; libra-backend: apps/tanstack-app/content/docs/getting-started/deepseek-harness.en.md (stage/commit and approval sections; source only, no deploy before REL-03)`.

**Release write set:** `Inherited from REL-02`。

**Files likely touched:** Host service, Agent tool facade, UI action adapter, locales and tests.

**Docs and compatibility impact:** Same-card updates: plugin README, `docs/tools.md`, `docs/ui.md`, `docs/security.md`, compatibility record and the named website guide sections. Keep website source on `cf`; deploy only at REL-03.

**Rollback mode:** `revert`

**Migration and rollback:** N/A.

**Security and privacy:** no self-approval, repo binding is Host-controlled, confirmation names action and exact file set, never log secret contents.

**Performance budget:** batch file actions; a single refresh after action; no N+1 per-file status round trips.

**Estimated scope:** `M`

**Version increment:** plugin release per package workflow.

**Release boundary:** `independent, REL-02` after REL-01.

**C/D coverage from:** `self`

**Split/dependency notes:** UI button operation is user-intent, not authority delegation; only Agent writes pass through approval.

**修订历史:** 初稿。

### Task LVC-08: Show truthful Agent capture, checkpoint and commit linkage

**Task type:** `implementation`

**Lifecycle / Acceptance:** `pending` / ` `

**Description:** Add per-Session capture status to the Libra panel so users can distinguish buffered/accepted/rejected/conflicting/gapped event delivery from checkpoint existence and confirmed commit linkage. Behavior axis: truthful capture status projection.

**Out of scope:** Memory recall UI; full conversation transcript display; deriving capture completeness from Session lifecycle flags alone.

**Current evidence:** plugin outbox tracks pending/acked/rejected states and per-event acknowledgements; current README says capture is a separate outbox layer.

**Acceptance criteria:**

- [ ] Status is derived from outbox/bridge durable acknowledgement and Session projection; display pending, accepted/duplicate, rejected/conflict, gap, unknown/unavailable distinctly.
- [ ] Checkpoint and commit linkage are displayed only when bridge returns a concrete record id/OID tied to that Session; ordinary commit is not implicitly labeled captured.
- [ ] UI never claims complete solely because `session.flush`, `session.close`, or bridge process shutdown succeeded.
- [ ] Redaction and payload privacy guarantees are unchanged; only safe counts/status/ids are displayed by default.
- [ ] Restart/recovery and duplicate acknowledgement tests prove no false complete and no cross-repo event attribution.
- [ ] ER-06/ER-12 same-card plugin privacy/compatibility docs and website capture/linkage guide section are accurate; website source remains undeployed until REL-03.

**Verification:**

- [ ] From plugin repo root: `pnpm test -- tests/session/session-projection.test.ts tests/bundle/tools-outbox.test.ts tests/ui/capture-status.test.ts` (new capture-status spec in existing Vitest target; new test cases marked `(new)`).
- [ ] From plugin repo root: `pnpm check`.
- [ ] From `/Volumes/Data/gitmono/libra-backend`: `pnpm typecheck && pnpm build` and `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/specs/docs.spec.ts`.
- [ ] From Libra repo root, add `(new)` cases to existing targets and run `cargo test --test agent_bridge_vcs_test --test agent_bridge_checkpoint_test --test agent_bridge_read_methods_test`; verify confirmed Session/commit relation on synthetic `.libra` repo.

**Full-suite trigger:** `T-1` across Session event, outbox, bridge durable records and Client projection.

**Dependencies:** `DEP-03`, `DEP-07`.

**Deliverables:** capture status query/projection, panel presentation and regression tests.

**Implementation write set:** `deepseek-harness-libra-plugin: packages/session/src/outbox.ts; packages/session/src/projection.ts; packages/bundle/src/index.ts; packages/bundle/src/capture-status.ts (new); packages/bundle/client.js; packages/bundle/client/capture-status.js (new); tests/session/session-projection.test.ts; tests/bundle/tools-outbox.test.ts; tests/ui/capture-status.test.ts (new); README.md; docs/privacy.md; docs/compatibility.md; libra-backend: apps/tanstack-app/content/docs/getting-started/deepseek-harness.en.md (capture status and commit linkage sections; source only until REL-03)`. If a new Libra protocol method is needed, stop and register a dependent card before changing Libra.

**Release write set:** `Inherited from REL-02`。

**Files likely touched:** outbox projection, bridge adapter, Client capture view, plugin privacy docs, website guide and tests.

**Docs and compatibility impact:** Same-card updates: plugin README, `docs/privacy.md`, `docs/compatibility.md`, and the named website guide sections; publish site only at REL-03.

**Rollback mode:** `revert`

**Migration and rollback:** N/A unless adding persistent projection schema; such schema requires a separate migration card/review.

**Security and privacy:** Counts/status by default; do not expose raw transcript in the VCS panel; redact identifiers according to current policy.

**Performance budget:** status projection read must not rescan full Session event history; bounded page and cached projection.

**Estimated scope:** `M`

**Version increment:** plugin release per package workflow.

**Release boundary:** `independent, REL-02`。

**C/D coverage from:** `self`

**Split/dependency notes:** Must not couple VCS state to Memory feature flags.

**修订历史:** 初稿。

### Task LVC-09: Publish accurate plugin and website documentation

**Task type:** `docs`

**Lifecycle / Acceptance:** `pending` / ` `

**Description:** After compatible Libra and plugin artifacts exist, finalize exact package/bridge compatibility evidence and publish the accumulated user guide. Behavior axis: release compatibility and documentation deployment; feature documentation itself is maintained in each user-visible behavior card under ER-06.

**Out of scope:** Claiming unpublished development bundle methods are available in npm stable; deploying code changes to Cloudflare except the documented website update.

**Current evidence:** backend DSH guide exists at `apps/tanstack-app/content/docs/getting-started/deepseek-harness.en.md`; generator imports English docs and mirrors them at zh-CN routes.

**Acceptance criteria:**

- [ ] Plugin README/detail/compatibility records package version, supported DSH/libra bridge versions and negotiated capability table from actual release artifacts.
- [ ] Libra user/developer docs accurately describe new VCS APIs/commands and unsafe/unsupported operations.
- [ ] Backend guide explains `.libra`-only contract, panel interactions, Agent approval, capture semantics, supported versions, unsupported versions and no Git fallback; zh-CN route behavior stated accurately without adding a false separate translation file.
- [ ] Every visible string added for plugin UI has matching en/zh locale keys.
- [ ] Update exact released versions/handshake methods in the compatibility records changed by earlier cards; do not change product semantics or add unsupported claims.
- [ ] Run docs generator, typecheck/build and the exact docs browser test; verify live URLs and Cloudflare deployment record before marking published.

**Verification:**

- [ ] From `/Volumes/Data/gitmono/libra-backend`: `pnpm typecheck && pnpm build`.
- [ ] From `/Volumes/Data/gitmono/libra-backend`: `python3 scripts/sync-libra-command-docs.py --libra-root ../libra --check`; review drift and do not hand-edit generated command pages.
- [ ] From `/Volumes/Data/gitmono/libra-backend`: `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/specs/docs.spec.ts`.
- [ ] Final backend full suite from `/Volumes/Data/gitmono/libra-backend`: run `pnpm test`, then `pnpm test:api`, then `pnpm test:e2e`; all three must pass under this T-2 release card and ER-13.
- [ ] From `/Volumes/Data/gitmono/deepseek-harness-libra-plugin`: `pnpm check`; `pnpm test:contract -- --protocol-version 1`; and, with `LIBRA_BINARY` and `LIBRA_REPO` pointing at the released binary and a disposable `.libra` repo, `pnpm test:contract -- --libra-release <released-libra-version>`. The `--events`, `--tools` and `--workspace` contract flags were removed from `scripts/test-contract.mjs` and must not be used.
- [ ] From plugin repo root, set `DSH_CHECKOUT` to the DSH source checkout pinned to `cd5ef8148158c3a752a658978873241fdf8e2bbc`, verify `test "$(git -C "$DSH_CHECKOUT" rev-parse HEAD)" = cd5ef8148158c3a752a658978873241fdf8e2bbc`, then run `DSH_CHECKOUT="$DSH_CHECKOUT" pnpm test:lifecycle`. This is the existing pinned bundle lifecycle/artifact gate; it is not the target-version UI acceptance gate.
- [ ] Target-version UI acceptance uses the released Libra binary, the REL-02 bundle artifact, DSH `0.2.2-rc.3`, and two synthetic Libra roots. Profiles: `dsh --profile desktop` is refused because the Desktop profile is managed exclusively by the Electron application, so the scripted gate runs in a dedicated CLI profile and the Desktop GUI check is performed in the Electron app with the same artifact settings. Prepare the fixtures and artifacts:

  ```bash
  set -euo pipefail
  : "${LIBRA_BINARY:?set to the released Libra executable}"
  : "${PLUGIN_TARBALL:?set to the REL-02 bundle tarball}"
  VCS_TEST_ROOT="$(mktemp -d)"
  mkdir -p "$VCS_TEST_ROOT/a" "$VCS_TEST_ROOT/b"
  "$LIBRA_BINARY" init --vault false "$VCS_TEST_ROOT/a"
  "$LIBRA_BINARY" init --vault false "$VCS_TEST_ROOT/b"
  (cd "$VCS_TEST_ROOT/a" && "$LIBRA_BINARY" config set user.name 'VCS Fixture' && "$LIBRA_BINARY" config set user.email 'vcs-fixture@example.invalid' && printf 'alpha seed\n' > seed.txt && "$LIBRA_BINARY" add seed.txt && "$LIBRA_BINARY" commit -m 'seed alpha' && printf 'alpha changed\n' >> seed.txt)
  (cd "$VCS_TEST_ROOT/b" && "$LIBRA_BINARY" config set user.name 'VCS Fixture' && "$LIBRA_BINARY" config set user.email 'vcs-fixture@example.invalid' && printf 'beta seed\n' > seed.txt && "$LIBRA_BINARY" add seed.txt && "$LIBRA_BINARY" commit -m 'seed beta')
  test ! -e "$VCS_TEST_ROOT/a/.git" && test ! -e "$VCS_TEST_ROOT/b/.git"
  dsh plugin --profile lvc-vcs add "$PLUGIN_TARBALL"
  cat > "$VCS_TEST_ROOT/lvc-vcs.patch.yml" <<YAML
  - id: libra
    name: '@libra-tools/dsh-bundle'
    config:
      libraExecutable: $LIBRA_BINARY
  YAML
  dsh --profile lvc-vcs --patch "$VCS_TEST_ROOT/lvc-vcs.patch.yml" --dump-config | grep -A3 "dsh-bundle"
  shasum -a 256 "$LIBRA_BINARY" "$PLUGIN_TARBALL"
  ```

  The composed profile must show the `libra` row with that exact `libraExecutable`, and the SHA-256 values identify the binary and tarball under test.

  Then boot the acceptance profile and use the UI: `dsh --profile lvc-vcs --patch "$VCS_TEST_ROOT/lvc-vcs.patch.yml" web`. In the running session's Libra panel diagnostics, record the evidence produced by the bridge that session actually launched: the resolved executable path, `shasum -a 256` of that exact path, the child PID, `ps -o pid=,command= -p <pid>` showing that executable, the negotiated protocol version, and the **complete** `initialize` method list (no truncation). The gate fails if the response carries a JSON-RPC error, omits `methods`, the path or hash differs from `$LIBRA_BINARY`, or the method list lacks the VCS methods this plan adds.

  Open the two directories as separate Sessions; verify each Libra tab's status/diff/log against `cd "$VCS_TEST_ROOT/a" && "$LIBRA_BINARY" status` and the corresponding `b` commands; exercise stage/unstage/commit, Agent approval denial and approval, and stale-fence refresh. Confirm switching Sessions never leaks repo rows or diffs.

  Desktop GUI equivalent, with its own artifact and runtime evidence: in the Electron app, open Plugins and install or update the Libra bundle **from the exact REL-02 tarball** (do not keep a previously installed development copy), confirm the row's version matches the REL-02 artifact, set the Libra binary field to the same absolute released-binary path, save, and reload the plugin. Then record the same live-session evidence set (resolved path, its SHA-256, PID + `ps` line, protocol version, complete method list) and the running Host's loaded-bundle identity (package directory plus `dist/index.js` SHA-256), and compare both sides:

  ```bash
  tar -xOf "$PLUGIN_TARBALL" package/dist/index.js | shasum -a 256   # artifact side
  # running side: the loaded-bundle path and dist/index.js hash from the Desktop panel diagnostics
  ```

  Acceptance fails if the artifact-side and running-side hashes differ, if the running loaded-bundle path or hash cannot be obtained from the running session, or if the bridge method list differs from the one captured in the CLI profile. Do not infer the loaded bundle from a profile file or an installed directory alone. Record temporary root paths, DSH/Libra/package versions, both bundle hashes, binary SHA-256, method lists, commit OIDs and outcomes. The existing `scripts/test-integration.mjs` is Memory receipt testing and is not used as this VCS gate.
- [ ] From backend root, run `pnpm preview:cf` and manually verify English/zh-CN guide routes; after REL-01/02, run `pnpm deploy:cf`, query `wrangler deployments list --name libra-backend --json`, and fetch public routes. Do not claim publish before these checks.

**Full-suite trigger:** `T-2`: cross-repo release point and public docs contract.

**Dependencies:** `DEP-08`, `DEP-09`; all public UI/API behavior cards locally accepted and Libra/plugin artifacts released.

**Deliverables:** updated docs, compatibility records and release/deployment evidence recorded here.

**Implementation write set:** `libra-backend: apps/tanstack-app/content/docs/getting-started/deepseek-harness.en.md; apps/tanstack-app/content/docs/getting-started/index.en.md; apps/tanstack-app/content/docs/getting-started/meta.en.json; apps/tanstack-app/content/docs/index.en.mdx; plugin: README.md; docs/compatibility.md; docs/protocol/agent-bridge-v1.md; docs/tools.md; docs/ui.md; docs/privacy.md; Libra: COMPATIBILITY.md and docs/development/tracing/deepseek-harness.md only to record final released compatibility; docs/commands/agent.md and zh-CN twin only if CLI behavior/help changed.`

**Release write set:** Website deploy `N/A` if docs are not yet public release; otherwise site deployment under `REL-03` after plugin artifact publication.

**Files likely touched:** three repos' user docs, plugin locales, site doc navigation.

**Docs and compatibility impact:** This is the docs card; each changed file listed in Implementation write set must be added to final file inventory and checked.

**Rollback mode:** `revert` for docs before deploy; follow site deployment rollback policy after publish.

**Migration and rollback:** N/A.

**Security and privacy:** No credentials, account identifiers or raw user data in examples/screenshots.

**Performance budget:** N/A.

**Estimated scope:** `M`

**Version increment:** Libra/plugin release increments inherited from their implementation release points; backend `N/A`.

**Release boundary:** `independent, REL-03` website docs publish after REL-01 and REL-02.

**C/D coverage from:** `self`

**Split/dependency notes:** If source APIs change, return to relevant implementation task; do not paper over contract drift with docs.

**修订历史:** 初稿。

## 发布分组

| REL-ID | 成员卡 | 触发面 | 部署点 | 状态 |
|---|---|---|---|---|
| `REL-01` | LVC-02, LVC-06 | Libra bridge protocol / binary release | Libra repo release workflow, exact commit + tag/artifact according to Libra AGENTS and plan template | planned |
| `REL-02` | LVC-03, LVC-04, LVC-05, LVC-07, LVC-08 | `@libra-tools/dsh-bundle` package | plugin repo package/release workflow; must consume REL-01 artifact | planned |
| `REL-03` | LVC-09 | DSH integration guide/navigation | website push to `cf`, `pnpm deploy:cf`; verify Cloudflare deployment history and live routes | planned |

## 任务卡粒度审计表

| 任务卡 | 卡型 | 行为轴 | 生产文件数估算 | 写集 | 回滚模式 | 发布面 | 拆分来源 | 例外 |
|---|---|---|---:|---|---|---|---|---|
| LVC-01 | spike | Freeze API contracts | 0 | plan only | revert | N/A | none | none |
| LVC-02 | implementation | Typed read bridge | ≤8 primary | libra | forward-only/revert pre-release | REL-01 | none | none |
| LVC-03 | implementation | Session repo binding | ≤8 primary | plugin | revert | REL-02 | none | none |
| LVC-04 | implementation | Host read API | ≤8 primary | plugin | revert | REL-02 | LVC-03 | none |
| LVC-05 | implementation | Read-only Client panel | ≤8 primary | plugin | revert | REL-02 | LVC-04 | none |
| LVC-06 | implementation | Typed bridge mutations | ≤8 primary | libra | forward-only/revert pre-release | REL-01 | none | none |
| LVC-07 | implementation | Shared UI/tool mutations | ≤8 primary | plugin | revert | REL-02 | LVC-06 | none |
| LVC-08 | implementation | Capture status projection | ≤8 primary per repo | plugin (+ Libra only if new contract card) | revert | REL-02 | LVC-03/07 | none |
| LVC-09 | docs | Published docs | ≤20 | all three by explicit list | revert | REL-03 | all feature cards | none |

**粒度核对:** Implementation 卡的“≤8 primary”是估计，不是允许超额的批准；执行前按最终文件数确认。跨仓切分必须先冻结接口，所有共享目录写入串行化。若任何卡超过 G-03，必须在实现前拆卡并更新本表/依赖，不得事后解释。

## 并发声明

- LVC-01 必须先完成；其他卡不得与其并行。
- LVC-02 与 LVC-03 在 LVC-01 冻结合同后可并行；LVC-06 与 LVC-02 共写 Libra protocol/method/VCS 文件，必须等 LVC-02 完成后串行执行。
- LVC-04 等待 LVC-02 + LVC-03；LVC-05 等待 LVC-04 与 LVC-03。
- LVC-06 等待 LVC-02；LVC-07 等待 LVC-05（UI shell）、LVC-06（写协议）和 LVC-03（repo binding）。
- LVC-08 等待 LVC-07；不得与 LVC-03/LVC-07 并行修改 `packages/session/src/outbox.ts`。
- LVC-09 等待 LVC-08 与 REL-01/02 的实际发布产物；每个用户可见 slice 的文档源修改随其行为卡交付，网站 deployment 统一延迟到 REL-03。
- 不同仓的每一张跨仓卡先提交/推送行为实现仓，再提交/推送同卡文档源仓；只在 REL-03 部署网站。每一步记录相邻仓 SHA；发布序列严格 REL-01 → REL-02 → REL-03。
- In each individual checkout, follow its own branch/working-tree/commit rules; do not reset or overwrite unrelated files. Current Libra source checkout has unrelated uncommitted work and is not an implementation sandbox until separately cleared/isolated under its AGENTS policy.

## 追溯表

| 任务卡 | 承接的缺口 | 产出物 | 验证命令锚点 |
|---|---|---|---|
| LVC-01 | GAP-01..07 | verified API/UI contracts | Inspect + source evidence; Codex review |
| LVC-02 | GAP-01, GAP-02 | typed read bridge | `cargo test --test agent_bridge_vcs_test --test agent_bridge_read_methods_test --test agent_bridge_protocol_test --test agent_bridge_schema_test` |
| LVC-03 | GAP-03 | per-session repo binding | plugin focused vitest + disposable roots |
| LVC-04 | GAP-01, GAP-02 | Host read service/tools | plugin focused vitest and typecheck |
| LVC-05 | GAP-04 | read-only Client panel | plugin UI tests + DSH browser validation |
| LVC-06 | GAP-05 | stage/unstage/commit API | `cargo test --test agent_bridge_vcs_test --test agent_bridge_mutation_test --test agent_bridge_approval_test --test agent_bridge_protocol_test` |
| LVC-07 | GAP-05 | shared operation/UI/tool | plugin action parity tests + real bridge fixture |
| LVC-08 | GAP-06 | capture status/linkage | session/outbox/UI tests + crash/restart fixture |
| LVC-09 | GAP-07 | published docs and release records | `pnpm typecheck && pnpm build`; `pnpm test`; `pnpm test:api`; `pnpm test:e2e`; compatibility checks |

## 风险表

| 风险 | 影响 | 缓解 | 承接卡 |
|---|---|---|---|
| DSH tab or remote-action API differs from assumption | UI cannot safely bind service operations | LVC-01 source/Inspect proof before coding; revise surface if needed | LVC-01 |
| Session cwd changes after binding | accidental write to wrong repository | re-resolve identity on every operation; reject changed binding; explicit user rebind | LVC-01, LVC-03 |
| File state changes between render and write | overwrite/stage/commit unexpected files | expected HEAD/index/worktree fences; structured stale response; refresh and require retry | LVC-06, LVC-07 |
| Old bridge only supports protocol baseline | false empty state or unsupported tool call | capability negotiation, explicit unsupported state, version matrix from actual binaries | LVC-02, LVC-04 |
| Outbox flush is mistaken for complete capture | false audit/attribution claim | per-event statuses and explicit unknown/gap; do not infer from lifecycle events | LVC-08 |
| Current source Libra checkout has unrelated local edits | data loss or misleading implementation baseline | preserve; use approved clean baseline per Libra AGENTS, refresh commit and tests before work | all Libra cards |
| DSH built-in turn card depends on Git snapshots | shell edits may not appear there in `.libra`-only workspace | describe separate scope; Libra panel is repository VCS truth, turn card remains DSH capture UX | LVC-05/LVC-09 |
| Cross-repo API drift | one component deployed against incompatible peer | REL-01 bridge artifact first; plugin validates initialize methods; docs publish last | REL-01..03 |

## 测试矩阵

| 门 | 命令 | 覆盖 |
|---|---|---|
| Libra read focused (cwd: `/Volumes/Data/gitmono/libra`) | `cargo test --test agent_bridge_vcs_test --test agent_bridge_read_methods_test --test agent_bridge_protocol_test --test agent_bridge_schema_test` | typed read status/diff/history contract; new cases marked `(new)` inside existing targets |
| Libra writes focused (cwd: `/Volumes/Data/gitmono/libra`) | `cargo test --test agent_bridge_vcs_test --test agent_bridge_mutation_test --test agent_bridge_approval_test --test agent_bridge_protocol_test` | fences, idempotency, approval boundary; new cases marked `(new)` |
| Libra format/lint (cwd: `/Volumes/Data/gitmono/libra`) | `cargo +nightly fmt --all --check`; `cargo clippy --all-targets --all-features -- -D warnings` | formatting and lint gates |
| Plugin focused | `pnpm test -- tests/bundle/repository-binding.test.ts tests/bridge-client/repository-pool.test.ts tests/bridge-client/libra-vcs-read.test.ts tests/tools/vcs-read-tools.test.ts tests/ui/libra-version-control-panel.test.ts tests/tools/vcs-write-tools.test.ts tests/ui/vcs-user-actions.test.ts tests/session/session-projection.test.ts tests/bundle/tools-outbox.test.ts tests/ui/capture-status.test.ts` (cwd: plugin root) | bridge client, session binding, tools, UI |
| Plugin full | `pnpm check` (cwd: plugin root) | lint, typecheck, all unit tests, build |
| Plugin contracts | `pnpm test:contract -- --protocol-version 1`; with `LIBRA_BINARY`/`LIBRA_REPO` set, `pnpm test:contract -- --libra-release <released-libra-version>` (cwd: plugin root) | fixture validation against the protocol fixture and a real released binary; the removed `--events`/`--tools`/`--workspace` flags must not be passed |
| Website docs | `pnpm typecheck && pnpm build` (cwd: backend root) | doc manifest, i18n, Workers build |
| Website full closeout | `pnpm test`; `pnpm test:api`; `pnpm test:e2e` (each cwd: backend root) | required by ER-13/T-2: unit, API and browser suites |
| Website focused docs browser | `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/specs/docs.spec.ts` (cwd: backend root) | guide routes and links |
| Browser VCS acceptance | LVC-09 procedure: isolated `.libra` fixture script, `dsh --profile lvc-vcs --patch … --dump-config` composition check, tarball/binary SHA-256, Desktop install of the exact tarball, `tar -xOf … package/dist/index.js \| shasum -a 256` compared with the running Host's loaded-bundle hash, and live-session diagnostics (resolved executable path + hash, PID/`ps` line, protocol version, complete `initialize` method list) | status/diff/history/write actions, approvals, stale fence, cross-Session isolation, and proof that each running session loaded the tested bundle and launched the tested binary |
| Existing plugin lifecycle artifact gate | Set `DSH_CHECKOUT` to the pinned `cd5ef8148158c3a752a658978873241fdf8e2bbc`, then run `DSH_CHECKOUT="$DSH_CHECKOUT" pnpm test:lifecycle` (cwd: plugin root) | published declaration and bundle lifecycle smoke only; does not replace target-version UI acceptance |
| Website preview/deploy | `pnpm preview:cf`; after REL-01/02, `pnpm deploy:cf` (cwd: backend root) | docs links and public deployment |
| Libra full-suite closeout | `source .env.test && source .env.live-test && cargo nextest run --all --no-fail-fast --retries 2` (cwd: Libra root), plus `cargo +nightly fmt --all --check` and `cargo clippy --all-targets --all-features -- -D warnings` | all Rust regression gates per Libra plan template v2.16; recheck commands against current Libra instructions before execution |

No test command is claimed as run by this design plan.

## 完成判据

- [ ] 所有非延后任务卡 `Lifecycle=done` 且 `Acceptance=complete`；`done` 不能先于 `complete`。
- [ ] 所有执行卡指定的 focused verification 均通过；全部卡完成后按各仓权威计划跑最终全量收口门。
- [ ] 最终全量收口门暴露且归属本计划的失败全部前滚修复并重跑至全绿；判定为基线失败的用例附基线复现证据并登记延期。
- [ ] LVC-01 contracts are verified and Codex-reviewed; all P0/P1 review findings closed.
- [ ] Libra protocol reads and writes are typed, bounded, negotiated, scoped and tested; legacy bridge behavior remains compatible.
- [ ] Session workspace binding comes from trusted Host cwd; multiple `.libra` workspaces cannot share state, outbox or operation routing.
- [ ] Read-only pane accurately shows status/diff/history; unsupported, stale, truncated and error states are distinguishable.
- [ ] UI and Agent tools call the same Host operations; Agent writes require approval; fences prevent stale writes.
- [ ] Capture statuses and confirmed checkpoint/commit links cannot be inferred from `flush`/`close` alone.
- [ ] plugin package and Libra artifact versions/handshake methods are verified; published documentation describes released behavior only.
- [ ] `pnpm typecheck`, `pnpm build`, plugin `pnpm check`, backend `pnpm test` / `pnpm test:api` / `pnpm test:e2e`, and Libra repo-mandated tests all pass; the target-version DSH browser acceptance is recorded with artifact versions.
- [ ] Each cross-repo review has final Codex `PASS`; every P0/P1 is closed; P2 is either fixed or explicitly accepted by named owner.
- [ ] Libra release, plugin package publication, and website `cf` push/deployment follow REL-01 → REL-02 → REL-03 and are verified with artifact/deployment evidence recorded in this file.
- [ ] No evidence directory/file was created; test summaries, version hashes, run IDs, CI/deployment IDs and outcomes are recorded in this plan's execution notes.
- [ ] This plan's revision history records normative changes after review.

## 执行证据汇总

> 仅执行计划时填写；本 plan creation 尚未运行实现测试、构建或部署。

| 时间 UTC | Task/门 | 命令或操作 | 版本/commit/artifact | 结果 | 证据/备注 |
|---|---|---|---|---|---|
| 2026-11-18 | Plan baseline | `libra status --short --branch`; `libra log -1` in each repo | backend `a0782cf`; plugin `27da281`; Libra `e8a2114` | Recorded | Libra checkout has unrelated dirty files; preserve and revalidate. |
| 2026-11-18 | Runtime contracts | Host/Client Inspect, installed CLI `--help`, package source reads | DSH `0.2.2-rc.3`; local Libra CLI `0.30.207` | Read-only design evidence | No repository data/database read. |

## 修订历史

| 日期 | 作者/评审 | 变更 | 结论 |
|---|---|---|---|
| 2026-11-18 | Codex (author) | 初稿：记录 `.libra`-only 产品约束，分离 VCS 与 Agent capture，按三个仓拆分接口、Host binding、UI、写操作、capture status 与发布文档任务。 | R1 待 review |
| 2026-11-18 | Codex R1 | FAIL：P1 dependency cycles/order conflicts and docs/write-set/template ER conflicts; P2 verification placeholders and missing lifecycle/full-suite closeout. Rewrote dependency DAG, per-card documentation scope/write sets, exact cwd-bound commands and final acceptance gates. | 修复后再审 |
| 2026-11-18 | Codex R2 | FAIL：P1 `pnpm test:integration` 的 `DSH_CLI`/flags 与实际 runner 不符且只测 Memory；P2 站点全量门缺少 `pnpm test` 等命令。改为固定 `test:lifecycle` 门 + 目标版本 DSH UI 手工验收（含两个 `.libra` 根与 `dsh plugin add` 步骤），并补齐站点 `pnpm test`/`test:api`/`test:e2e` 全量门。 | 修复后再审 |
| 2026-11-18 | Codex R3 | FAIL：P1 目标版本 UI 门未证明 Desktop 实际使用已安装 bundle 与指定二进制（profile 选择、`libraExecutable` 配置、运行期证据缺失）。补充 profile 事实（desktop profile 由 Electron 独占管理、CLI profile 可 `--dump-config`）、profile patch 配置 `libraExecutable`、`shasum` 与 bridge `initialize` 握手证据、Desktop 插件页等价步骤；同时按实际 runner 更正 `test:contract` 可用参数（`--events/--tools/--workspace` 已被移除）。 | 修复后再审 |
| 2026-11-18 | Codex R4 | FAIL：P1 Desktop 工件身份未证明（未从 REL-02 tarball 安装/未绑定已加载包）；P1 握手来自旁路进程而非被测会话，且 `head -c` 截断。改为：LVC-03 记录每个 bridge 的 resolved 路径/SHA-256/PID/完整 `initialize` 并只读暴露；LVC-05 面板诊断区展示该会话证据；LVC-09 从运行中会话取完整方法列表并校验无 JSON-RPC error、Desktop 从同一 tarball 安装并记录 `dist/index.js` hash。 | 修复后再审 |
| 2026-11-18 | Codex R5 | FAIL：P1 仅记录安装目录 hash，未与 tarball 内 `dist/index.js` 对比，也未证明该路径就是 Desktop 实际加载的 bundle。补充：LVC-03 由运行进程记录已加载 bundle 包目录与 `dist/index.js` SHA-256；LVC-05 诊断区展示；LVC-09 计算 `tar -xOf "$PLUGIN_TARBALL" package/dist/index.js` 的 SHA-256 并与运行侧比对，不一致/无法取得即失败。 | 修复后再审 |
| 2026-11-18 | Codex R6 | PASS：R5 的 P1 已闭合，未发现新的 P0/P1 或实质性事实/模板问题；`.libra`-only 约束、依赖 DAG、同卡文档门、跨仓发布顺序、测试命令与工件身份链均通过复审。 | **PASS** |
