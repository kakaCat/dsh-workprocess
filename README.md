# dsh-workprocess

**两层工作模型**的独立实现：一条流程（`workProcess`）由若干**阶段**（`workStage`，严格串行）组成，
每个阶段装若干**任务**（`workTask`，会被自动续跑推动的工作单元）。

零第三方领域依赖：内核不 import 任何东西；只有工具面依赖宿主工具 SDK（`@deepseek-ai/dsh-tools`）
用于把工具注册进宿主。

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

## 五个包

| 包 | 作用 | 依赖 |
|---|---|---|
| `workprocess-core` | 内核：两层快照 / 事件表 / 折叠 / 六条不变量 / 严格解码 / 服务（CAS + 幂等 + 身份分配） | 无 |
| `workprocess-round-driver` | 回合驱动器：纯决策树（闸 → 串行门 → 相位机）+ 提示词渲染 | `workprocess-core` |
| `tool-workprocess` | 工具面：`get_/create_/update_*` 六个工具 + 授权判据 + 独立插件入口 | `workprocess-core`、`@deepseek-ai/dsh-tools` |
| `dsh-workprocess` | **领域插件（组合根）**：归属记录落宿主存储域（`ctx.storageDomain`）/ 真人判定（会话事件切面）/ 回合边界驱动（开工 · auto 收口 · 落盘 block · **续跑投递**）/ 提供 **`ctx.workprocess`** 服务 + `apply(ctx, config)` | 上面三个、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-llm`、`zod` |
| `command-workprocess` | **命令行插件** `/work`（`<目标>` 让 agent 拆阶段建流程 · `edit <目标>` 改目标 · `pause` / `resume` / `clear`）——独立包、独立装载行（对齐宿主 `dsh-command-goal`），只消费 `ctx.workprocess`，**结构化动作投话给 agent 做** | `workprocess-core`、`dsh-workprocess`（类型）、`@deepseek-ai/dsh-llm` |

工具面命名与形状对齐宿主 dsh 的 `get_goal / create_goal / update_goal`：
`get_workstage / create_workstage / update_workstage` 与 `get_worktask / create_worktask / update_worktask`，
**状态变更收进 `update` 的 `action`**。

## 快速开始

```bash
pnpm install
pnpm typecheck
pnpm test          # 132 条：内核 45 / 驱动 26 / 工具 25 / 领域插件 23 / 命令行插件 13（含端到端）
pnpm build         # 出 dist/（宿主加载的是 JS，不是 TS）
```

## 装进宿主（DSH profile）

宿主按 `dsh.profile.bundles` 装载：依赖写 `link:<repo>/dsh-workprocess`、bundles 里列 `dsh-workprocess`、
`node_modules/dsh-workprocess` 指向本包；`dsh-workprocess/cordis.patch.yml` 给出装载层条目。
注意：**`dsh.bundle.patch` 指向的文件读不到，宿主会整个跳过这个 bundle**（现象：重启也不见工具）。
改完重启 DSH 生效；排障与回滚见 `dsh-workprocess/README.md`。

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
