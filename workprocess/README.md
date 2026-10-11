# workprocess

**两层工作模型的纯内核**：零依赖、纯函数、可被 core 引用（反向禁止）。

## 模型：两层

```
WorkProcess（聚合根：一次完整流程，一个归属对象一条）
├── WorkStage  ← 层1「阶段」：一组任务的集合、大块分组；阶段之间**串行**
│   ├── WorkTask  ← 层2「任务」：单个工作单元，语义对齐宿主 dsh 的 goal
│   └── WorkTask
└── WorkStage …
```

- **层1（`WorkStage`）**：一个阶段里可以含**多个** `WorkTask`；阶段态 `pending → active → done`，
  开工受**串行门**约束（前序阶段全部 `done` 才允许 `active`），收口要求本阶段任务非空且全部 `complete`。
  **严格串行是决定，不是省略**（用户决定）：唯一合法形态 `[done…][active?][pending…]`——
  跳阶段 / 两个阶段并行 / 后阶段先收口一律拒；**不做阶段间 DAG**。注意被禁的并行只在**阶段之间**：
  阶段内的多个 `WorkTask` 本来就是并列的。
  收口**由谁落**是**每阶段的策略** `closePolicy: 'human' | 'auto'`（缺省 `human`）：
  `human` = 人工确认（agent 只提议）；`auto` = 任务全 `complete` 后由驱动器直接落 done。
  策略只决定"谁有权落"，不改收口判据（`auto` 同样要求任务非空且全 complete）；读它一律走
  `stageClosePolicyOf()`（缺省口径的唯一定义处）。
- **层2（`WorkTask`）**：相位机与宿主 `GoalSnapshot` **逐条对齐**（`active/paused/blocked/complete`、
  `revision` 乐观锁、`blockedReason` 结构化、`maxRounds` 回合上限）——自动续跑真正推动的就是它。
- **聚合根（`WorkProcess`）**：持顺序化阶段表；两层的写**共用同一个 CAS revision**（分开两个版本号必然打架）。

## 文件布局

| 本包 | 宿主对应 | 语义 |
|---|---|---|
| `src/types.ts` | `packages/goal/goal/src/types.ts` | 纯类型（client-safe）：两层快照 + DTO + 进度投影 |
| `src/domain.ts` | `packages/goal/goal/src/domain.ts` | 事件与变更词汇：两层动词共用**一条**耐久变更流 |
| `src/fold.ts` | `packages/goal/goal/src/fold.ts` | 纯折叠与判据：`applyWorkEvent` / 严格解码 `decodeWorkProcess`+`decodeWorkChange` / 迁移链 `applyWorkChange` / `foldWorkProcess`（严格）与 `tryFoldWorkProcess`（`failure` 哨兵）/ 串行门判据 `stageAllowsStart` / `stageIsFinishable` / `processAllowsClose` / `taskAllowsRound` / `workProgressOf` |
| `src/invariant.ts` | `packages/goal/goal/src/invariant.ts` | 六条不变量（INV-1~6）+ 写路径断言 `assertWorkInvariants()` |
| `src/stages.ts` | 无（宿主只有单层 goal） | **阶段表投影**（读侧单点）：`currentStageOf` / `stageIndexOf` / `nextStageOf` / `previousStagesDone` / `stageClosePolicyOf`（收口策略缺省口径）——驱动、工具面、折叠读的是同一份"当前阶段 / 串行门前半 / 谁落 done" |
| `src/runtime.ts` | `packages/goal/goal/src/runtime.ts` | 构造器与常量：`WorkProcessId()` / `WorkTaskId()` / `WORK_CHANGE_VERSION` / `WorkError` |
| `src/client.ts` | `packages/goal/goal/src/client.ts` | 客户端命名空间纯再导出 |
| `src/index.ts` | `packages/goal/goal/src/index.ts` | 服务本体：端口契约 + 读写收口（建流程 / 阶段表 / 阶段开工收口 / 任务五动作）+ 身份分配 |

**为什么只给投影、不给模板**：阶段表由**调用方定义**（大数据 / 训练 / 发布各不同），
本包只提供"当前阶段是谁 / 串行门前半"的读投影，**不预置任何阶段键**——
模板属于调用方的领域（本包与任何具体流程无关）。

## 六条不变量（INV-5 / INV-6 是两层模型特有的）

| 编号 | 内容 |
|---|---|
| INV-1 | 层2 终态：`complete` 的任务只能原样保留或被 `clear`，不得再被改写 |
| INV-2 | 有效变更 revision 恰好 +1（建流程为 1）；无效变更**零变化**（幂等是硬语义） |
| INV-3 | `blocked` 必带非空结构化原因（`code` 必须 lower-kebab-case + `message`） |
| INV-4 | 身份稳定：流程 id 不变；存活任务的 id / `stageKey` 不变；`objective` 只在 `init` 下确立 |
| INV-5 | **串行门**：任一阶段非 `pending` 时其前序阶段必须全 `done`（最多一个 `active`） |
| INV-6 | **阶段收口自洽**：阶段 `done` ⇒ 其任务非空且全部 `complete` |

## 依赖方向

```
workprocess  ←  workprocess-round-driver（决策/提示词）
             ←  tool-workprocess（工具面）
             ←  dsh-workprocess（领域插件：存储域 / 真人判定 / 回合驱动 / ctx.workprocess 服务）
             ←  command-workprocess（/work 命令行，只消费 ctx.workprocess）
```

本包是**新建的独立体系**：不依赖仓内其它插件包，也不改动它们——
它与"谁在用"无关，接入与否由调用方决定。

## 测试

```bash
cd workprocess/workprocess && pnpm test      # 41 条：两层结构 / 串行门 / 收口策略 / 丢弃流程 / 相位机 / 身份不复用 / CAS / 值域
```
