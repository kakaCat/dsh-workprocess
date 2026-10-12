# dsh-workprocess

**两层工作模型**的独立实现：一条流程（`workProcess`）由若干**阶段**（`workStage`，严格串行）组成，
每个阶段装若干**任务**（`workTask`，会被自动续跑推动的工作单元）。

零第三方领域依赖：内核（`workprocess` 包的 types/domain/fold/invariant/runtime/stages/client
七个模块）不 import 任何东西——由 `tests/kernel-purity.test.ts` 逐文件机械守卫；工具插件
依赖宿主工具 SDK（`@deepseek-ai/dsh-tools`）把六个工具注册进宿主。**运行时依赖只认 `@deepseek-ai` 官方包与工作区包**：唯一的 `zod`
在 `dsh-workprocess` 走 `peerDependencies`——`@deepseek-ai/dsh-storage-domain` 自己声明
`zod: ^4.4.3` 且其公开 API `domainTable(schema: ZodType<V>)` 的类型即来自 'zod'，是官方契约
钦定的 schema 语言，由官方栈提供而非我们自选。

## 模型

```
workProcess  id=wp:<scope>   revision（两层的写共用同一个 CAS）
│  ✗ 没有自己的相位字段：相位只活在层2 的每个任务上
│  stages[]  ← 数组顺序 = 串行顺序
├── workStage  key=prep      state: pending → active → done；closePolicy: human / auto（收口由谁落）
│   ├── workTask  wt:prep:1  phase: active / paused / blocked / complete
│   └── workTask  wt:prep:2  + objective / revision / maxRounds / blockedReason
├── workStage  key=train     ← 串行门：prep 不全 done 就不许开工
└── workStage  key=release
```

一条流程的生命周期：

```
建流程 ──▶ 阶段开工（串行门放行）──▶ 建任务 ──▶ 跑任务（相位机）
   ▲                                                        │
   │                                             任务全 complete
   │                                                        │
   │                      ┌── close_policy=human ──▶ 人工确认收口
   │                      └── close_policy=auto  ──▶ 自动收口（驱动器落 done）
   └──── 下一阶段（串行门放行）◀────────────────────────────┘
                                    │
                        全部阶段 done ⇒ 具备收口条件（流程无"完成"态：成没成是判据）
```

任务相位机：`create → active ⇄ paused/blocked`；`complete` 是**终态不可逆**；
`clear` 摘掉任务但编号 `wt:<阶段键>:<序号>` **不复用**（墓碑守身份）。

## 四个包（`workprocess` 已由"内核 + 组合根"合并而成，对齐宿主 `dsh-goal` 的单包形态）

| 包 | 作用 | 依赖 |
|---|---|---|
| `workprocess` | **领域插件**（对齐宿主 `dsh-goal`，含不变量伴生入口 `workprocess/invariant`）：内核（两层快照 / 事件表 / 折叠 / 七条不变量 / 严格解码 / 服务：CAS + 幂等 + 身份分配）＋ 归属记录落宿主存储域（`ctx.storageDomain`，域由本插件**独占**打开）/ 回合边界驱动（开工 · auto 收口 · 落盘 block · **续跑投递**）/ 提供 **`ctx.workprocess`**（域 API：读 + 全部写动词 + 人机干预）/ 发 **`work/changed`** typed 宿主事件（对齐 `goal/changed`）。内核纯度守在**模块边界**（内核七文件零外部 import，由 `tests/kernel-purity.test.ts` 机械守卫） | `workprocess-round-driver`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-llm`（cordis 与 zod 走 peer：前者是宿主单例符号包，后者是官方存储域钦定 schema 语言——都由官方栈提供） |
| `workprocess-round-driver` | 回合驱动器：纯决策树（闸 → 串行门 → 相位机）+ 提示词渲染 | `workprocess` |
| `tool-workprocess` | **工具插件**（对齐宿主 `dsh-tool-goal`：`name`/`inject`/`apply(ctx, config)`）：`get_/create_/update_*` 六个工具 + 授权判据 + 通告（`exec.deferContext`）+ 人机确认（`ctx.userQuestions`）+ 常驻策略段；数据只经 **`ctx.workprocess`** | `workprocess`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`（cordis/dsh-agent/dsh-session-projection/dsh-system-prompt 走 peer，type-only） |
| `command-workprocess` | **命令行插件** `/work`（`<目标>` 让 agent 拆阶段建流程 · `edit <目标>` 改目标 · `pause` / `resume` / `clear`）——独立包、独立装载行（对齐宿主 `dsh-command-goal`），只消费 `ctx.workprocess` 的四个人机干预方法，**结构化动作投话给 agent 做** | `workprocess`（类型）、`@deepseek-ai/dsh-llm`（cordis/dsh-commands 走 peer，type-only） |

工具面命名与形状对齐宿主 dsh 的 `get_goal / create_goal / update_goal`：
`get_workstage / create_workstage / update_workstage` 与 `get_worktask / create_worktask / update_worktask`，
**状态变更收进 `update` 的 `action`**。

## 快速开始

```bash
pnpm install
pnpm typecheck
pnpm test          # 172 条：内核（含纯度守卫）53 / 回合驱动器 34（决策 25 · 循环 3 · 设计契约 6）
                   #        / 工具面 35（工具 29 · 插件 4 · 端到端 2）/ 领域插件 37 / 命令行 13
pnpm build         # 出 dist/（宿主加载的是 JS，不是 TS）。四包拓扑序直出：构建期关掉源码 paths，
                   # 兄弟包按 node_modules → dist 声明解析（循环已断，两段式过渡桥已撤除）
```

## 装进宿主（DSH profile）

**一包一 patch**（对齐宿主：每个 `@deepseek-ai/*` 包自带自己那一行）：
四个包各自声明 `dsh.bundle.patch: ./cordis.patch.yml`，各自的 patch 只插**自己**那一行
（工具面 `blockedAfterRounds`、驱动器 `tick/drive/defaultMaxRounds/close/disarmOnResume` 等配置
跟着各自的包走）。profile 侧要做两件事：

1. `package.json` 的 `dependencies` 里四个包都写 `link:<repo>/<包目录>`，`node_modules/` 下有对应软链；
2. `dsh.profile.bundles` 里**四个包都列**（顺序建议 领域 → 驱动器 → 工具 → 命令行；
   真正的先后由 cordis 的 `inject` 保证——消费方等提供方）。

于是每一层都独立可装可卸：只列 `workprocess` = 只有领域服务没有工具/驱动器；只列 `tool-workprocess`
而不列领域包 = 工具装不上（`inject` 等不到 `workprocess`）。

注意：**`dsh.bundle.patch` 指向的文件读不到，宿主会整个跳过这个 bundle**（现象：重启也不见本包生效）。
改完重启 DSH 生效。

## 真机验收（一条全 auto 流程）

单测只能证明"我构造的状态合法"，闭环要靠真机。**判据一条**：一条全 `auto` 的流程，
从开工到流程收口全部由驱动器推完，中间不用人点。

```bash
python3 scripts/observe-workflow.py            # 取最近更新的那条流程
python3 scripts/observe-workflow.py <会话 id>   # 指定会话
```

它把两处证据拼成一条时间线：归属记录（流程/阶段/任务的**当前**状态 + 耐久回合计数）
与会话日志（驱动器**投过什么**，来源自署 `work`），并按里程碑逐项打勾。

真机跑法（在**新会话**里发一条，`/work` 的用法见 `command-workprocess/README.md`）：

```
/work 两阶段全自动验收：阶段一（close_policy: auto）写 hello.txt 内容是 hello workprocess；
阶段二（close_policy: auto）往 hello.txt 末尾追加一行 second stage。每阶段 1 个任务，max_rounds 各 2。
```

期望序列：阶段开工 → （阶段空着时）规划轮 → 任务轮 1 → 阶段一收口 → 阶段二开工 → 任务轮 2 →
阶段二收口 → **流程收口**（`closedAt` 落下）。跑完 `observe-workflow.py` 的"里程碑对账"应全 ✓。

**最近一次真机验收（2026-10-12，两阶段全 auto）**：通过 ✅ —— 12:42:13 投 v1 规划轮 → 12:42:31 投 v2 规划轮，
两个阶段各自 auto 收口、流程 `closedAt` 落下，全程零人工介入。账：6 条投递中 2 条规划轮、
`rounds.started` 未前进（任务都在规划轮内做完，没消耗任务轮）。

## block 语义（对齐宿主 goal 的"连续 N 轮"纪律）

| 谁落 | 门槛 | 恢复 |
|---|---|---|
| **agent**（自治回合） | 至少跑满 **3 轮**（`rounds.started`，耐久）才允许宣告"被挡住"；不够 ⇒ 拒并给 `WORK_TOOL_BLOCK_THRESHOLD`（对齐 goal 的 `GOAL_TOOL_BLOCK_THRESHOLD`） | `update_worktask action=resume`（**真人专属**）；或 `update_workstage action=arm` 放回续跑许可 |
| **真人**（直接发起） | 无门槛（人在场，随时可以叫停） | 同上 |
| **内核**（回合预算到顶） | 到顶即落盘 block（`round-limit`），不需要"连续"判据 | 同上 |

阈值可配：工具插件 `blockedAfterRounds`（缺省 3）。

## 审计（`ctx.workprocess.audit()` + `scripts/audit-storage.mjs`）

| 检查项 | 谁在查 |
|---|---|
| 快照形状 / 阶段串行 / id 唯一性 / 墓碑一致性 | **存储层 schema 的 `superRefine`**（就是内核严格解码器）——写时拒、载入时由存储层报 |
| 归属边界（`workProcess.id` == `wp:<记录键>`） | **审计**（schema 不查这条） |
| `rounds.started` 非负安全整数 / `activation` 合法 | **审计**（`z.number()` 会放过负数与小数） |

所以审计的增量是**记录级那两件**，不是"抓坏快照"（那件在更早的一层就被拦了）。

真机可验的形态是命令（不需要宿主、不需要服务、不需要重启）：

```bash
node scripts/audit-storage.mjs            # 审 ~/.dsh/storages/workprocess.json，逐条打勾
node scripts/audit-storage.mjs <文件>      # 审指定文件（拿副本验证它真会抓问题）
```

进程内那份（装载时自审 + `ctx.workprocess.audit()`）保留：装载时发现即记一行警告（不阻断装载）。

## 真机才暴露的三个坑（都已修 + 防回归测试）

| 坑 | 症状 | 修法 |
|---|---|---|
| 规划轮把任务轮挤掉 | 两阶段跑完 `rounds.started` 仍是 0 ⇒ 回合预算与 block 门槛形同虚设 | 规划轮只建任务、不动手（`458f4f4`） |
| 重启后新建流程继承残留的 `disarmed` | 新流程一开就静默停住 | 人发起的新建把许可打开；自治回合不动这个开关（`3a3b2f5`） |
| 投递即消耗（预约撤得太早） | 任务轮与 blocked 收束轮**同时**到手：预算被烧光、agent 一次手都没动 | 撤预约只在 `agent/status → idle`（真·空闲转换）里做；`drive()` 见预约挂着就直接返回（宿主同款） |

## 续跑许可（`activation`：耐久；对齐宿主 goal 的 arm/disarm）

| | 说明 |
|---|---|
| 落点 | 归属记录的 `rounds.activation`（**不进事件表、不发 `work/changed`**：它是控制面读数，不是领域值） |
| 读 | `get_workstage` 回执里的 `activation`；服务面 `ctx.workprocess.activation(scope)` |
| 自动收 | 会话 **`resume`**（宿主重启后从盘上加载）⇒ 驱动器落 `disarmed`，一拍都不推进（对齐 goal："after session resume or fork, an active goal is disarmed"） |
| 人工放 | `update_workstage action=arm`（**真人专属**；agent 自发起 = 自签通行证，一律拒） |
| 人工收 | `update_workstage action=disarm`（同上，真人专属） |
| 关掉自动收 | 驱动器配置 `disarmOnResume: false`（长时间无人值守的流程要跨重启继续跑时用） |

`disarmed` 顺带解决"重启后重复打扰"：驱动器停手 ⇒ 既不重投规划轮，也不重问收口确认。

## 六条不变量

| 编号 | 内容 |
|---|---|
| INV-1 | `complete` 的任务只能原样保留或被 `clear`，不得再被改写（终态不可逆） |
| INV-2 | 有效变更 revision 恰好 +1（建流程为 1）；无效变更**零变化**（幂等是硬语义） |
| INV-3 | `blocked` 必带非空结构化原因（`code` 为 lower-kebab-case + `message`） |
| INV-4 | 身份稳定：流程 id 不变；存活任务的 id / `stageKey` 不变；`objective` 只在 `init` 下确立 |
| INV-5 | **串行门**：任一阶段非 `pending` 时其前序阶段必须全 `done`（最多一个 `active`） |
| INV-6 | **阶段收口自洽**：阶段 `done` ⇒ 其任务非空且全部 `complete` |

## 几条已定的设计决定

- **阶段严格串行**：唯一合法形态 `[done…][active?][pending…]`——跳阶段 / 两个阶段并行 / 后阶段先收口一律拒；
  **不做阶段间 DAG**。被禁的并行只在**阶段之间**：阶段内的多个任务是并列的。
- **阶段收口有两条路**（逐个阶段选，`close_policy`）：`human`（缺省）= **人工确认**——agent 只提议、
  done 由人落；`auto` = **自动收口**——本阶段任务全 `complete` 后由驱动器直接落 done，阶段边界不必等人。
  两条路都要过**同一条判据**（任务非空且全 complete）：策略只决定"谁有权落"，不决定"够不够格落"
  （否则 `auto` 就是绕过判据的后门）。策略属于**定义**，故改它走 `create_workstage` 替换阶段表，
  不新增状态动词。
- **要人确认的动作**：流程 `edit`（改整条流程的目标）/ 任务 `edit`（改目标）/ `resume`（改人的意图）、
  阶段 `done`（收口——**仅 `human` 策略的阶段**）、`discard`（丢整条流程）。
  `pause` / `block` / `complete` / `clear` 可由 agent 发起。
- **目标可改但不是随手改**：`objective-edit` 是**真人专属**状态动词（阶段与任务原样保留，
  不靠"丢弃重来"换目标）；INV-4 只放行 `init` 与它两个动词改写 `objective`。
- **阶段开工不是工具动词**：串行门放行后由**驱动器**开工（`decideWorkRound` 的 `start-stage` 决策）。
- **命令行的两条路**：结构化动作（`/work <目标>`、`/work edit <目标>`）**投话给 agent** 做
  （拆阶段是判断）；机械控制（`pause` / `resume` / `clear`）命令**直接落**领域。
- **幂等 + CAS**：`changed:false` 的调用零写入；写路径带 `revision` 时旧值即拒。
