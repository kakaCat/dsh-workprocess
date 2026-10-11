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
├── workStage  key=prep      state: pending → active → done
│   ├── workTask  wt:prep:1  phase: active / paused / blocked / complete
│   └── workTask  wt:prep:2  + objective / revision / maxRounds / blockedReason
├── workStage  key=train     ← 串行门：prep 不全 done 就不许开工
└── workStage  key=release
```

一条流程的生命周期：

```
建流程 ──▶ 阶段开工（串行门放行）──▶ 建任务 ──▶ 跑任务（相位机）
   ▲                                                    │
   └──── 下一阶段 ◀── 阶段收口（人工确认，任务须全 complete）◀┘
                                    │
                        全部阶段 done ⇒ 具备收口条件（流程无"完成"态：成没成是判据）
```

任务相位机：`create → active ⇄ paused/blocked`；`complete` 是**终态不可逆**；
`clear` 摘掉任务但编号 `wt:<阶段键>:<序号>` **不复用**（墓碑守身份）。

## 三个包

| 包 | 作用 | 依赖 |
|---|---|---|
| `workprocess` | 内核：两层快照 / 事件表 / 折叠 / 六条不变量 / 严格解码 / 服务（CAS + 幂等 + 身份分配） | 无 |
| `workprocess-round-driver` | 回合驱动器：纯决策树（闸 → 串行门 → 相位机）+ 提示词渲染 | `workprocess` |
| `tool-workprocess` | 工具面：`get_/create_/update_*` 六个工具 + 授权判据 + 独立插件入口 | `workprocess`、`@deepseek-ai/dsh-tools` |

工具面命名与形状对齐宿主 dsh 的 `get_goal / create_goal / update_goal`：
`get_workstage / create_workstage / update_workstage` 与 `get_worktask / create_worktask / update_worktask`，
**状态变更收进 `update` 的 `action`**。

## 快速开始

```bash
pnpm install
pnpm typecheck
pnpm test          # 69 条：内核 30 / 驱动 20 / 工具 19（含两条端到端）
```

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
- **要人确认的动作**：任务 `edit`（改目标）/ `resume`（改人的意图）、阶段 `done`（收口）。
  `pause` / `block` / `complete` / `clear` 可由 agent 发起。
- **阶段开工不是工具动词**：串行门放行后由**驱动器**开工（`decideWorkRound` 的 `start-stage` 决策）。
- **幂等 + CAS**：`changed:false` 的调用零写入；写路径带 `revision` 时旧值即拒。
