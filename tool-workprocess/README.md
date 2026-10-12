# tool-workprocess

> 本包自带装载行（`dsh.bundle.patch: ./cordis.patch.yml`，只插自己那一行）：profile 的
> `dsh.profile.bundles` 里列上本包即生效。

**插件形态**（对齐宿主 `dsh-tool-goal`）：`name` / `inject: ['tools','workprocess','agents','sessionProjections','systemPrompt']` / `apply(ctx, config)`。
**数据口只有 `ctx.workprocess`**——存储域由领域插件独占打开（同名域重复 `open` 是响亮拒绝），
本面不碰 store、不绕内核；授权判据 / 通告（`exec.deferContext`）/ 人机确认（`ctx.userQuestions`）
/ 常驻策略段都归本面，装配由 `apply` 一次接好。


workprocess 的**工具面**：两层各三工具（`src/tools.ts` 顶部的登记表是唯一手写清单）。

**命名与形状对齐宿主 dsh**：`get_* / create_* / update_*`（动词在前），状态变更**收进 `update` 的 `action`**
（对齐 `get_goal / create_goal / update_goal`）——不是为每个动词各开一个工具。

| 工具 | 层 | 作用 |
|---|---|---|
| `get_workstage` | 层1 | 读阶段表（顺序即串行顺序）+ 当前阶段 + 串行门 + 收口条件 + 每阶段的收口策略（`close_policy`） |
| `create_workstage` | 层1 | 建流程（带阶段表：`key / statement / done_criteria? / close_policy?`）或整体替换阶段表；会丢掉**非空**阶段的一律被内核拒 |
| `update_workstage` | 层1 | `action=done`：阶段收口落定——按**该阶段 `close_policy`** 判谁来落（`human` = **真人专属**；`auto` = 驱动器/自治回合可落）；任务须非空且全部 complete。`action=edit`：**改流程目标**（要 `objective`；阶段与任务原样保留；**真人专属**）。`action=discard`：**丢弃整条流程**（不需要 `stage_key`，不可逆，**真人专属**）。`action=arm` / `disarm`：**续跑许可**（**真人专属**；`disarm` 时驱动器停手，`arm` 由人在说"继续"时放回） |
| `get_worktask` | 层2 | 读任务（给 `task_id` 读一条 / 给 `stage_key` 读一阶段 / 都不给读全部） |
| `create_worktask` | 层2 | 在某阶段建任务；身份由内核分配 `wt:<阶段键>:<序号>`，回执直接给 `task_id` 与**聚合 `revision`** |
| `update_worktask` | 层2 | `action` 六动词：`edit / pause / resume / block / complete / clear`（`edit`、`resume` = **真人专属**，`block` 必须给原因，且门槛轮数由配置渲染进自述） |

**阶段开工没有动词**（有意）：`update_workstage` 的动词只有 `done` / `edit` / `discard` / `arm` / `disarm`
——开工是**驱动器的动作**（`workprocess-round-driver` 的 `start-stage` 决策，串行门放行才开工），
避免两条开工入口。

### 模型面措辞（工具自述怎么写）

六个自述是**给模型看的**（进宿主工具清单，每轮都在上下文里），所以按宿主 `dsh-tool-goal` 的三条
自述立了五条纪律（`src/tools.ts` 登记表上方有同一份）：

| 纪律 | 宿主范本 | 本面落地 |
|---|---|---|
| 说清**是什么 + 什么时候用**（含**反触发**） | `create_goal`：…even if the user did not say "goal"; **not for single-turn work** | `create_workstage`：要跨多轮做成的事才建；单轮任务不要建流程 |
| 取数**来源点名** | `get_goal`：including the id and revision that `update_goal` requires | `get_workstage` / `get_worktask` 自述里点名"`update_*` 要的 `revision` 在这里取"；每个 id / revision 参数写清去哪个工具的回执取 |
| **语义只写一处** | `update_goal` 自述只有一句 "Update the current goal."，权限与门槛全在 `action` 的 enum 里 | `update_*` 自述只说"有哪些 action"，**权限 / 不可逆性 / 门槛**全归 enum 描述（原来两处近乎逐字重复，且自述那份漏了 `arm` / `disarm`） |
| **不写内部术语** | —— | 自述与参数描述里不许出现层0/层1/层2、组合根、串行门、CAS 这类只有维护者才懂的词（模型看到只会当噪声） |
| **id 的形状 ≠ 可以自己拼** | `update_goal`：Exact id **returned by** `get_goal` | `task_id`：照抄回执原值（`wt:<阶段键>:<序号>` 只是形状；清掉的不复用） |

**门槛数字不许写死**（对齐宿主 `guidance(blockedAfterConsecutiveRounds)`）：`block` 的前置轮数是
**装载配置**，故 `update_worktask` 的 action 自述与常驻策略段都由 `workPolicyText(blockedAfterRounds)`
按生效配置渲染（`apply` 里一次算好）。写死一个数 = 配置一改，模型就按错的门槛去试、白跑一轮
（真机踩过"只说 block 会被拒"的坑，同一个坑的第二种形态）。

**这个数还有第二处**：驱动器也要在**投递的任务轮**里写它（`workprocess-round-driver` 的
`blockedAfterRounds`）——真正拒 `block` 的是本包，驱动器只负责告诉模型几轮。两个包各自独立装载、
读不到对方的 `config`，所以两处装载行必须写同一个数；全栈测试有一条门禁钉住"两边缺省一致"
（`workprocess/tests/plugin.spec.ts` 的「门槛数字两处必须同值」）。

**回执里的数必须能直接喂给下一句**（真机实测出来的坑）：`create_worktask` 原来把**新建任务自己的**
`revision`（恒为 1）当 `revision` 回给模型，而 `update_worktask` 的 `revision` 参数校的是**聚合**修订
⇒ 模型照着回执递 CAS 必得 `WORK_CONFLICT`（"期望 revision=1，当前=3"）。现在回执给聚合修订
（e2e 第⑥条契约：两层的写共用一个 revision，"每次 +1，并可从回执读到"），并有防回归断言钉住。

### 纪律与牙的位置：任务只属于当前阶段

策略段那条「不要提前给后续阶段建任务」的牙长在**本包**（`create_worktask` 写前拒，
`WORK_TOOL_NOT_CURRENT_STAGE`），**不在内核**——这是刻意的分工：

- **域是通用引擎**：`createTask` 允许给任何未收口的阶段落任务（"计划先落任务、开工归驱动器"），
  驱动器的环测与 `service.view` / `workWireOf` 的读投影都按这个状态写。把 agent 的纪律做成状态规则，
  等于把那批能力与夹具一起作废（试过：4 处夹具当场红）。
- **与 `blockedAfterRounds` 完全同形**：内核不知道的 **agent 政策**由**策略段的作者（本面）**执行。
  内核只管状态完整性（已收口阶段不许塞任务 / 串行门 / 身份不复用 / CAS）。
- **拒因必须说出口**：`mutateWork` 把 `changed:false` 折成静默 false（幂等重放必须静默），
  只靠域层拒的话模型看到的是"没变化"，然后拿同一个阶段键反复试——所以本面写前拒并给出人话理由。
  已收口阶段那条仍走域层的静默零写入（既有缺口，不在本次射程内，有用例钉住现状）。

### 与宿主 dsh 的两处必然差异

1. **六个而不是三个**：workprocess **分两层**（宿主只有单层 goal），故两层各一套 get/create/update。
2. **动词集不同**：`clear` 是本包加项（撤掉误建的任务，编号不复用）；宿主"一会话一 goal"没有这个动作。
   其余口径一致：`edit` / `resume` 需人直接发起，`pause` / `block` / `complete` 可由 agent 发起；
   阶段收口 `stage_done` 多一条**按阶段策略分流**（`human` 人工确认 / `auto` 自动收口）。

## 人机确认（工具自己问人）

`update_workstage { action: 'done' }` 在**缺授权**（策略 `human` 且本轮不是人发起的）时，
不再直接拒：经 `WorkToolDeps.askHuman` 端口调宿主的 `ctx.userQuestions.ask(...)` **自己弹框问人**
（与宿主 `plan-mode` 的 `exit_plan_mode` 同款）。四种裁决，**只有 `approved` 算同意**：

| 裁决 | 工具回什么 | 效果 |
|---|---|---|
| `approved` | 正常落章 | 阶段 done（与"人直接在会话里说一句"等价） |
| `declined`（选了别的 / 自定义输入） | `WORK_TOOL_HUMAN_DECLINED` + 人的原话 | 不收口，模型按人说的补任务 |
| `cancelled`（打断去说话 / 中止） | `WORK_TOOL_HUMAN_UNAVAILABLE` | 不收口，停手等人开口 |
| `no-channel`（没弹框通道 / 没人接这一问） | 退回 `WORK_TOOL_AUTHORITY_REQUIRED`（带指路） | CLI / 无头 / 子 agent 场景的原口径 |

**顺序纪律**：先判权、再判状态——越权者不会因为"阶段没做完"拿到另一个口径；而"确实做得成"
（active 且任务全达成）才会去打扰人。

## 错误码：两本各回各家（对齐宿主 goal）

宿主 goal 的分法是**两本词汇、各有一个家**：**域规则**的码是 `GoalErrorCode`（`GOAL_*`，闭联合，
住在域词汇表 `goal/src/domain.ts`，随 `GoalError` 抛出）；**工具面政策**的码一律 `GOAL_TOOL_*`，
抛在判据旁边（`tool-goal` 的 `authority.ts` / `index.ts`），**不并进域联合**。本仓照此办理：

| 本 | 码 | 家 | 谁抛 / 谁回 |
|---|---|---|---|
| **域码** | `WORK_*`（`WORK_ERROR_CODES`，闭联合） | `workprocess/src/domain.ts`（`runtime.ts` 只 `import type`，与宿主 `runtime.ts` 逐字同形） | 内核状态规则；工具面把它**原样搬进回执**（不重造同义的第二个码） |
| **工具码** | `WORK_TOOL_*`（`WORK_TOOL_CODES`，闭联合） | **本包** `src/codes.ts` | 工具面自己拦的：`WORK_TOOL_AUTHORITY_REQUIRED`（越权）/ `WORK_TOOL_CALLER_REQUIRED`（调用者不是活跃根 agent）/ `WORK_TOOL_INVALID_ARGS`（参数形状）/ `WORK_TOOL_NOT_CURRENT_STAGE`（agent 纪律）/ `WORK_TOOL_BLOCK_THRESHOLD`（撑满 N 轮）/ `WORK_TOOL_HUMAN_DECLINED`、`WORK_TOOL_HUMAN_UNAVAILABLE`（弹框结局） |

**回执里的码** = 两本的并集（`WorkReceiptCode`）：域码从 `WorkError` 冒泡，工具码由 `denyTool()` 给。
两处的选择由**类型**守着——`denyTool()` 只收 `WorkToolCode`，`denyDomain()` 只收 `WorkErrorCode`；
拒绝点不再有裸字面量（真发生过：`WORK_NO_PERMISSION` 是工具的政策却住在域联合里，
`WORK_NOT_CURRENT_STAGE` 是工具纪律却起了个域码的名字，两条都已按宿主口径改名）。

**机械守卫**（`tests/tools.spec.ts` 的「两套词汇」那组 + `workprocess/tests/kernel-purity.spec.ts`）：
两本表各自的码唯一且前缀正确、域码里不许混进 `WORK_TOOL_*`、工具面源码里的独立码字面量必须已登记、
`workprocess/src` 里不许出现工具码字面量、码表定义必须住在 `domain.ts`。

> 第三套词是**浏览器数据面**的 wire 级错误名（`missing-host` / `cross-origin` / `cross-site` /
> `host-not-allowed` / `method-not-allowed` / `missing-scope` / `no-process` / `unknown-path`，
> 小写 kebab）：那是客户端协议，不是给模型看的回执码，故不收进两本（见 `src/codes.ts` 的说明）。

## 模型面指令（对齐宿主 `dsh-tool-goal` 的另两种提示词）

宿主 goal 有三处模型面文本：**回合投递**（驱动包）、**常驻策略段**（工具包 `ctx.systemPrompt.section`）、
**工具回执之后的通告**（工具包 `exec.deferContext`，如 `<goal_complete>`）。本仓对齐后两处：

| 位置 | 给模型什么 |
|---|---|
| `create_workstage` / `create_worktask` 回执 | 下一步归谁：**开工是驱动器的动作**；任务建完直接做 |
| `update_worktask complete` ⇒ 通告 | `<workprocess_task_complete>`：本轮到此为止、不要顺手开新任务、不要替阶段收口 |
| `update_workstage done` ⇒ 通告 | `<workprocess_stage_done>`：下一阶段由驱动器开工与规划，不许越阶段 |
| `update_workstage discard` ⇒ 通告 | `<workprocess_discarded>`：不可逆，别再引用旧阶段键 / 任务 id |

通告经 `WorkToolDeps.deferNotice` 端口发出：本面**只产出「摘要 + 文本」**，消息形状与来源由组合根落成
（本面不 import 宿主 llm 包）。幂等重放（`changed:false`）**不发**通告——没发生的事不说成发生了。

## 授权口径（对齐宿主 dsh 的 update 政策）

- **真人专属**：`task_edit`（改目标——对齐宿主 dsh「edit, pause, and resume require a direct top-level human request」）、
  `process_edit`（改**整条流程**的目标——agent 自行改会让流程悄悄跑偏到另一件事上）、
  `task_resume`（改人的意图——agent 自行 continue 会推翻人的暂停）、
  `process_discard`（丢整条流程——agent 自撤会抹掉"这里曾经有一条流程"这段历史；误建流程的补救口只给人）。
- **按阶段的收口策略判**：`stage_done` 的目标阶段 `close_policy=human`（缺省）时是**人工确认**（真人专属）；
  `close_policy=auto` 时**放行自治回合**——阶段自己声明了"任务全完成即自动收口"，此时再按人工确认拦
  等于把声明作废。策略从流程里读（`stageClosePolicyOf`），**授权面不自己猜**；拿不到上下文就按保守的
  `human` 判。两条路都要过内核的收口判据（任务非空且全 complete）。
- **agent 可发起**：`task_pause` / `task_block` / `task_complete` / `task_clear`。
- `authorityFromEvents(...)`：从开放回合的事件切面判定"本轮是人打的字"还是"**精确命中**的续跑回合"
  （`taskId + revision + round` 三项全对；旧回合、改过的目标一律不授自治权）。
- 越权抛 `WorkToolError('WORK_TOOL_AUTHORITY_REQUIRED')`，回执里给出路（由人在宿主界面确认 / 由人直接调 /
  `human` 策略下落不了的阶段，由人把 `close_policy` 改成 `auto`）。

## 结构（3 个模块，与宿主 `dsh-tool-goal` 同粒度）

宿主那个包源码也是三个模块（`authority` / `wrapup` / `index`），发布前打成一个 `lib/index.js`
（见其打包分区标记）；我们按同样的粒度切：

| 模块 | 职责 | 对应宿主 |
|---|---|---|
| `src/authority.ts` | 授权：**判据**（真人专属集合 + 按阶段收口策略的 `stage_done` 判据 + 精确授权三元组 + `requireActionAuthority`）＋ **宿主对话面**（授权判据读取 `authorityResolverOf`、通告 `exec.deferContext`、人机确认 `ctx.userQuestions`、`work-tool` 来源声明） | `authority.ts` + `wrapup.ts`（都是"工具与宿主/人的边界"） |
| `src/tools.ts` | 六个工具：登记表（唯一手写清单）+ `defineTool` 壳（协议面）+ 处理器（协议无关，**不需要宿主即可单测**） | 宿主 `index` 里的工具定义 + 处理器 |
| `src/index.ts` | 插件装配：`name` / `inject` / `apply(ctx, config)` + **常驻策略段**（模型面纪律） | 宿主 `index` 里的 `apply` + `ctx.systemPrompt.section` |

数据口只有 `ctx.workprocess`（`WorkToolDeps.domain`）；`apply` 从宿主 ctx 一次接好授权、通告、人机确认。

**配置**（装载层 `config` 段）：`policySection`（缺省 true，策略段是否注册）、
`blockedAfterRounds`（缺省 3，自治回合落 `block` 的前置轮数，对齐宿主 goal 的 `blockedAfterConsecutiveRounds`；
判据读**这个任务自己**已准入的回合数（`rounds.tasks[<task_id>].rounds`）——早先读的是全流程累计数
`rounds.started`，那等于"别的任务跑过的轮数"也给这个任务当资格（新任务第一轮就能宣告被挡住；
与回合预算同一类错误）。**同时决定策略段与 `update_worktask` action 自述里写的那个数**，且必须与
`workprocess-round-driver` 的同名配置同值——见上面「门槛数字不许写死」）、
`apiHosts`（缺省空，浏览器只读数据面的**额外允许主机名**，见下节）。

## 浏览器只读数据面（HTTP + SSE）：默认只服务本机

`src/http.ts` 惰性注入宿主 `webServer`，注册 `GET /workprocess/api/stages?scope=`（全量 JSON）与
`GET /workprocess/api/events?scope=`（SSE：首帧全量 → 变更推全量 → 25s 心跳）；宿主没有 web 载体时零行为。
客户端半（`workprocess/lib/client.js`）走的是**相对路径**，故与界面同源。

**这条面读的是本机流程数据，所以门口有判据**（`checkApiAccess`，纯函数可单测）：

| 请求形态 | 裁决 |
|---|---|
| 缺 `Host` | 403 `missing-host`（浏览器必带 Host） |
| `Host` 非 loopback（`localhost` / `127.0.0.1` / `::1`）且不在 `apiHosts` 里 | 403 `host-not-allowed`——挡 **DNS rebinding**（攻击者域名解析到 127.0.0.1，浏览器看来是"同源"，CORS 帮不上忙）；消息里点名 `apiHosts` |
| `Sec-Fetch-Site: cross-site` | 403 `cross-site` |
| `Origin` 是 http(s) 且与 `Host` 不同源 | 403 `cross-origin`——挡**跨源读**（网页 `fetch` / `EventSource` 都带 Origin）。非 http(s) 的 Origin（Electron 壳 `app://`）放行：网页伪造不出那种来源 |
| 非 `GET` / `HEAD` | 405（只读面） |

`apiHosts` 是**显式开的口子**：从局域网地址 / 隧道域名 / 反代域名打开界面时，把那个主机名（可带端口）
列进来即可；`'*'` = 全放行（自己清楚暴露面时用）。放行 Host **不等于**放行跨源——Origin 仍须与 Host 同源。

## 测试

```bash
cd workprocess/tool-workprocess && pnpm test   # 64 条：登记表自洽 / 模型面措辞（单行·无术语·取数点名·语义只写一处·门槛随配置）/ 授权口径（含收口策略与 process_edit）/ 六工具行为（含"任务只属于当前阶段"的写前拒）/ 回执 CAS 可用性 / 人机确认（userQuestions）/ 工具通告（deferContext 适配）/ 数据面访问判据（跨源·跨站·非本机 Host·只读方法）/ **两套词汇的机械守卫**（码表自洽·不许串门·不许手写未登记的码）
```
