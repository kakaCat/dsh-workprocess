# dsh-workprocess

**两层工作模型**的独立实现：一条流程（`workProcess`）由若干**阶段**（`workStage`，严格串行）组成，
每个阶段装若干**任务**（`workTask`，会被自动续跑推动的工作单元）。

零第三方领域依赖：内核（`workprocess` 包的 types/domain/fold/runtime/stages/client
**六个**模块——域不变量的纯检查住在 `fold` 里，`invariant.ts` 这个名字留给伴生插件入口）不 import
任何东西——由 `tests/kernel-purity.spec.ts` 逐文件机械守卫；工具插件
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
│   └── workTask  wt:prep:2  + objective / revision / maxRounds / blockedReason / **自己的回合账**
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
| `workprocess` | **领域插件**（对齐宿主 `dsh-goal`，含不变量伴生入口 `workprocess/invariant`）：内核（两层快照 / 事件表 / 折叠 / 六条不变量 / 严格解码 / 服务：CAS + 幂等 + 身份分配）＋ 归属记录落宿主存储域（`ctx.storageDomain`，域由本插件**独占**打开）/ 提供 **`ctx.workprocess`**（域 API：读 + 全部写动词 + 人机干预 + 逐任务回合账）/ 发 **`work/changed`** typed 宿主事件（对齐 `goal/changed`）。内核纯度守在**模块边界**（内核六文件零外部 import，由 `tests/kernel-purity.spec.ts` 机械守卫）。**驱动器不在这里**（在下一个包；本包不 import 它） | `@deepseek-ai/dsh-storage-domain`（cordis 与 zod 走 peer：前者是宿主单例符号包，后者是官方存储域钦定 schema 语言——都由官方栈提供） |
| `workprocess-round-driver` | 回合驱动器：纯决策树（闸 → 串行门 → 相位机）+ 提示词渲染 + 不变量伴生入口 `workprocess-round-driver/invariant`（自动回合消息与重建载荷逐字节比对） | `workprocess` |
| `tool-workprocess` | **工具插件**（对齐宿主 `dsh-tool-goal`：`name`/`inject`/`apply(ctx, config)`）：`get_/create_/update_*` 六个工具 + 授权判据 + 通告（`exec.deferContext`）+ 人机确认（`ctx.userQuestions`）+ 常驻策略段；数据只经 **`ctx.workprocess`** | `workprocess`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`（cordis/dsh-agent/dsh-session-projection/dsh-system-prompt 走 peer，type-only） |
| `command-workprocess` | **命令行插件** `/work`（`<目标>` 让 agent 拆阶段建流程 · `edit <目标>` 改目标 · `pause` / `resume` / `clear`）——独立包、独立装载行（对齐宿主 `dsh-command-goal`），只消费 `ctx.workprocess` 的四个人机干预方法，**结构化动作投话给 agent 做** | `workprocess`（类型）、`@deepseek-ai/dsh-llm`（cordis/dsh-commands 走 peer，type-only） |

工具面命名与形状对齐宿主 dsh 的 `get_goal / create_goal / update_goal`：
`get_workstage / create_workstage / update_workstage` 与 `get_worktask / create_worktask / update_worktask`，
**状态变更收进 `update` 的 `action`**。

## 产物形状：一个装载入口 = 一个文件（对齐宿主 `dsh-goal`）

宿主加载器只认 `package.json` 的 `main`，所以每个**装载入口**都收成**一个** bundle：

```
src/（多模块）── tsc ──▶ dist/types/*.js + *.d.ts（中间态；只发其中的 .d.ts）
                        └─ tsdown ─▶ dist/index.js（+ 伴生件 dist/invariant.js）
client/*.tsx ──────────────── tsdown ─▶ lib/client.js（CJS + __ModuleLoader__ 工厂；react 走模块表）
```

| 包 | 运行时产物（`files` 白名单发的就是这些） | 浏览器半 |
|---|---|---|
| `workprocess` | `dist/index.js` + `dist/invariant.js` | `lib/client.js`（由 `client/*.tsx` 构建：tsdown + lightningcss 编译 CSS Modules） |
| `workprocess-round-driver` | `dist/index.js` + `dist/invariant.js` | — |
| `tool-workprocess` | `dist/index.js` | — |
| `command-workprocess` | `dist/index.js` | — |

`exports` 只开必要子路径（`./invariant` 给伴生件装载行、`./client` 给浏览器半），**不再有 `"./*"` 通配**：
`dist/types/*.js` 是构建中间态，不是公开面。

### 与宿主 goal 的对齐：能对齐的 / 学不了的

| 维度 | 宿主 `dsh-goal` 一线 | 我们 | 结论 |
|---|---|---|---|
| 包拓扑 | 4 个包（领域 / 驱动器 / 工具 / 命令） | 同样 4 个 | 已对齐 |
| 伴生件 | `src/invariant.ts` 一个文件（`name`/`inject`/`apply`） | 同样一个文件（纯检查沉进 `fold.ts`） | 已对齐 |
| 产物 | tsdown 按入口打成 `lib/index.js`（+ `lib/invariant.js`） | 同形（目录名仍是 `dist/`） | 已对齐 |
| 测试命名 | `*.spec.ts` | `*.spec.ts` | 已对齐 |
| 状态真源 | **会话日志**（`session.append('goal/change')` + 会话投影） | 宿主**存储域**（`ctx.storageDomain`） | **学不了**：仓外插件 append 自定义事件没有 `ignorable` 标记，持久化读路径会拒绝解释整条会话日志 |
| 客户端面 | 会话投影 → 客户端 `useProjection('goal')` | 自建只读数据面（HTTP + SSE，**默认只服务本机**：Host 须 loopback + Origin 须同源，见 `tool-workprocess/README.md`） | **学不了**：投影只吃会话事件；转发白名单是宿主自有文件 |
| 装载行 | 写在宿主 `packages/bundle/base`（仓内 bundle） | 各包自带 `dsh.bundle.patch` | **学不了**：改不了宿主仓内的 bundle |

## 快速开始

```bash
pnpm install
pnpm typecheck
pnpm test          # 282 条（17 个 *.spec.ts）：领域插件 128（内核 59 · 插件 38 · 伴生件 9 · 服务 8
                   #        · 视图 4 · 客户端 7 · 内核纯度 3）/ 回合驱动器 72（决策 26 · 插件 14
                   #        · 伴生件 20 · 循环 12）/ 工具面 64（登记表+授权 28 · 工具壳 14 · HTTP 13 · 端到端 2 · 插件 5）/ 命令行 18
                   #   ↑ `pretest` 先跑 `workprocess` 的 `build:client`：客户端契约测试读的是产物 lib/client.js
pnpm build         # tsc 出中间态 dist/types/（逐模块 + .d.ts），tsdown 按**装载入口**收成
                   # dist/index.js（+ 伴生件 dist/invariant.js）——宿主加载的就是那一个文件
                   #（对齐宿主 dsh-goal 的 tsdown.config.ts；外部依赖不打包，兄弟包走 node_modules 声明）
```

## 装进宿主（DSH profile）

**一包一 patch**（对齐宿主**实验性 bundle 包**的做法，如 `voice-input-bundle` / `auto-review`）：
四个包各自声明 `dsh.bundle.patch: ./cordis.patch.yml`，各自的 patch 只插**自己**那一行
（工具面 `blockedAfterRounds`、驱动器 `tick/drive/defaultMaxRounds/close/disarmOnResume` 等配置
跟着各自的包走）。

> 口径更正：宿主 `dsh-goal` 那一线**不是**这么装的——它的装载行写在宿主的
> `packages/bundle/base/cordis.patch.yml`（仓内 bundle）里，包本身没有 patch 文件。
> 我们不在宿主仓内、改不了 base bundle，所以走"包自带 patch"这条宿主为**仓外插件**准备的路。
> profile 侧要做两件事：

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
| **agent**（自治回合） | 在**这个任务上**跑满 **3 轮**（该任务的回合账，耐久）才允许宣告"被挡住"；不够 ⇒ 拒并给 `WORK_TOOL_BLOCK_THRESHOLD`（对齐 goal 的 `GOAL_TOOL_BLOCK_THRESHOLD`） | `update_worktask action=resume`（**真人专属**）；或 `update_workstage action=arm` 放回续跑许可 |
| **真人**（直接发起） | 无门槛（人在场，随时可以叫停） | 同上 |
| **内核**（回合预算到顶） | 到顶即落盘 block（`round-limit`），不需要"连续"判据 | `update_worktask action=resume`——**resume 一个 blocked 任务会追加一份预算**（见下节），否则放回 `active` 下一拍又到顶 |

阈值可配：工具插件 `blockedAfterRounds`（缺省 3）。

## 回合预算：**按任务计**（不是一个流程一个数）

| 读数 | 落点 | 谁在用 |
|---|---|---|
| 任务的回合账 | `rounds.tasks[<taskId>] = { rounds, grants }` | **回合上限闸**（`decideWorkRound` 比 `used` vs 任务自己的 `maxRounds`）；**落 block 的轮数门槛**（"在这个任务上撑满 N 轮"）；轮号（`第 N 轮`，按任务从 1 起） |
| 全流程累计数 | `rounds.started`（按增量累加，跨任务） | 只有一个读者：`/work` 的"全程累计"读数（"整条流程真跑过几轮"） |

- **生效上限 = 任务基础上限 × (1 + grants)**（`effectiveCapOf`，唯一一处换算）：`grants` 是**人追加的预算份数**，
  人 `resume` 一个 `blocked` 任务时 +1（`paused` 任务 resume 只是继续，不追加）。不这么算，
  `resume` 把任务放回 `active`、下一拍又判到顶——恢复路径等于没做。
- **轮号跨任务不可比**（每个任务从第 1 轮起），所以任何"这个任务撑满 N 轮"的门槛都要读**该任务的账**，
  不能读全流程累计数、更不能读轮号。
- 修的是这样一类缺陷（**不是真机暴露的，是评审 + 探针**）：早先只有一个全流程计数、却拿它比任务上限
  ⇒ 第二个任务继承前一个花掉的额度，一开拍就判到顶（阶段越多越明显），而 README 写的恢复路径
  `resume` 又是空头支票。真机验收那次没炸，只因任务都在规划轮内做完、`rounds.started` 没前进。
  防回归：驱动器环里有"前一段花光额度不妨碍下一段"+ "`tickWorkprocess` 实测：累计数不吃新任务额度"
  两条（把旧口径放回去，它们会红）。

## 审计（`ctx.workprocess.audit()` + `scripts/audit-storage.mjs`）

| 检查项 | 谁在查 |
|---|---|
| 快照形状 / 阶段串行 / id 唯一性 / 墓碑一致性 | **存储层 schema 的 `superRefine`**（就是内核严格解码器）——写时拒、载入时由存储层报 |
| 归属边界（`workProcess.id` == `wp:<记录键>`） | **审计**（schema 不查这条） |
| `rounds.started` 与逐任务回合账（`rounds.tasks`）是非负安全整数 / `activation` 合法 | **审计**（`z.number()` 会放过负数与小数） |

所以审计的增量是**记录级那两件**，不是"抓坏快照"（那件在更早的一层就被拦了）。

真机可验的形态是命令（不需要宿主、不需要服务、不需要重启）：

```bash
pnpm build                                 # 先构建（脚本 import 的是 dist/index.js，与宿主加载的是同一份）
node scripts/audit-storage.mjs             # 审 ~/.dsh/storages/workprocess.json，逐条打勾
node scripts/audit-storage.mjs <文件>      # 审指定文件（拿副本验证它真会抓问题）
```

**判据只有一份**：记录级规则抽成内核的纯函数 `auditWorkRecord`，进程内那份（装载时自审 +
`ctx.workprocess.audit()`）与这个脚本都调它——脚本曾经抄过一份规则，抄漏了"逐任务回合账"那条
（头注释还写着"与内核/服务同口径"）。同一判据三处副本必然漂移，故现在只留调用方。

进程内那份保留：装载时发现即记一行警告（不阻断装载）；**有问题的记录不播种**进不变量伴生件的影子状态
（读起来就不可信，别拿它当基准）。

## 真机才暴露的三个坑（都已修 + 防回归测试）

| 坑 | 症状 | 修法 |
|---|---|---|
| 规划轮把任务轮挤掉 | 两阶段跑完 `rounds.started` 仍是 0 ⇒ 回合预算与 block 门槛形同虚设 | 规划轮只建任务、不动手（`458f4f4`） |
| 重启后新建流程继承残留的 `disarmed` | 新流程一开就静默停住 | **域层**：`discard` 把整本回合账（含许可）一起摘掉（记录里留下的任何一格都是上一个对象的结论）；工具面兜底：人发起的新建再把许可打开（老记录也纠正），自治回合不动这个开关（`3a3b2f5` + 本轮） |
| 投递即消耗（预约撤得太早） | 任务轮与 blocked 收束轮**同时**到手：预算被烧光、agent 一次手都没动 | 撤预约只在 `agent/status → idle`（真·空闲转换）里做；`drive()` 见预约挂着就直接返回（宿主同款） |

## 两处去重记号都是耐久的

| 记号 | 落点 | 作废条件 |
|---|---|---|
| "已经问过"（规划轮 / 收口确认轮，各一次） | 归属记录 `asked.{plan,ask} = { key, revision }` | 流程修订一变即作废；丢弃流程时清 |
| 续跑许可（`activation`） | 归属记录 `rounds.activation` | 会话 `resume` 自动置 `disarmed`；人 `arm` 放回；**丢弃流程**时整格随账一起没（下一条流程不继承） |

于是"重启后重复打扰"在两处都不存在：同一状态不重问（修订未变），流程一旦往前走该问就问。

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
  **不做阶段间 DAG**。
- **阶段内的多个任务是"轮流待跑"，不是并发跑**（口径更正）：一条空闲边界只投**一条**消息，驱动器的
  选择规则是"数组里第一个 `active` 的任务"（先跑完前面的，才轮到后面的）——它们**各有自己的回合预算**，
  但续跑是一轮一轮串着来的。要"同时铺开"就得先做投递并发（一次边界多条消息 = 模型同时拿到互相打架的
  指令），那是另一件事，**本轮不做**；这条口径原先写成"阶段内的任务是并列的"，与实现不符，已改回实话。
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
  **CAS 与写在同一个临界区**：`store.mutate` 按 scope 串行（`get → 改草稿 → put` 中间隔着真 I/O，
  不串行化就有两个写者各读一份旧草稿、后写的盖掉先写的——丢更新；三个写者同在一个进程里：
  工具面 / 命令行 / 驱动器）。校验放区外时它只是装饰：并发下两个写者会双双通过。
  防回归：`plugin.spec` 的「读-改-写是串行的」「并发同 revision 只有一个能落」两条（旧实现下双双红）。
