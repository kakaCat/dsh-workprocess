# dsh-workprocess「弹框有问题」：出口清单、复现、根因与修复

> 用户所报原话只有一句：「dsh-workprocess 的弹框有问题」。本文件把「弹框」这个词先钉成**可点名的出口清单**，
> 再依次收窄到复现、根因、修复。四节分别由 `wt:repro:1 / 2 / 3` 与 `wt:fix:2` 填。
>
> 锚点格式：`路径:行号` + 该行原文片段——可用 `node scripts/check-popup-exits.mjs` 逐条复核（片段必须是该行子串）。

## 出口清单

先说清楚一件容易混的事：这个仓里叫「弹框」的东西有**两类**，机制完全不同。

- **原生弹框**（宿主 UI 里真弹一个框）：只有一处——工具面的**阶段收口确认**，由工具自己调 `ctx.userQuestions.ask`
  （对齐宿主 `plan-mode` 的 `exit_plan_mode`）。人怎么点，工具**直接**拿裁决，不靠模型转述。
- **收口确认轮**（不弹框，而是投一轮提示词把「请人确认」摆到人面前）：驱动器在阶段边界/流程边界投的 ask 轮，
  它让 agent 去调上面那个工具（或直接开口）。它自己**不弹框**。

### A. 工具面：原生弹框（`ctx.userQuestions.ask`）

| id | 出口（谁触发 / 何时 / 期望结局） | 锚点 | 该行原文片段 |
|---|---|---|---|
| A1 | 弹框口声明：`askHuman` 缺省不存在 = 没弹框通道 | `tool-workprocess/src/tools.ts:139` | `readonly askHuman?:` |
| A2 | 端口契约：宿主 `userQuestions` 的最小读取面（只用 `ask`） | `tool-workprocess/src/authority.ts:261` | `最小读取面` |
| A3 | 组合根接线：把工具面请求接到宿主服务上 | `tool-workprocess/src/index.ts:108` | `askHuman: (exec, request) => askHumanOf(ctx, exec, request),` |
| A4 | 无服务（CLI/无头/没 provider）= `no-channel` | `tool-workprocess/src/authority.ts:291` | `return { kind: 'no-channel' }` |
| A5 | 服务取用：`ctx.get('userQuestions')` | `tool-workprocess/src/authority.ts:290` | `ctx.get?.('userQuestions')` |
| A6 | 触发条件：有弹框口 + 策略 `human` + 阶段 active 且任务全达成才去打扰人 | `tool-workprocess/src/tools.ts:526` | `const askable = deps.askHuman !== undefined && closePolicy === 'human'` |
| A7 | 弹框载荷：问题/选项/`approve` 指向哪个标签 | `tool-workprocess/src/tools.ts:531` | `const verdict = await deps.askHuman!(exec, {` |
| A8 | 弹框里给人复核的细节（阶段陈述 + 达成判据 + 任务清单） | `tool-workprocess/src/tools.ts:206` | `function stageDetailOf(stage: WorkStage): string {` |
| A9 | 答案回收：按 `id` 找回答项 | `tool-workprocess/src/authority.ts:308` | `answer.answers.find((a) => a.id === request.id)` |
| A10 | 判「同意」：选中了 `approve` **且**没有自定义输入 | `tool-workprocess/src/authority.ts:310` | `item.selected.includes(request.approve) && item.custom === undefined` |
| A11 | 判「不同意」：自定义输入为空串也算不同意（不是补充） | `tool-workprocess/src/authority.ts:316` | `item.custom === ''` |
| A12 | 异常映射：`NO_PROVIDER` ⇒ `no-channel`，其余 ⇒ `cancelled` | `tool-workprocess/src/authority.ts:322` | `reason === 'NO_PROVIDER'` |
| A13 | 人「还要补做」⇒ 拒并转达人的话 | `tool-workprocess/src/tools.ts:543` | `WORK_TOOL_HUMAN_DECLINED` |
| A14 | 人没答/打断 ⇒ 停手等人，不自己收口 | `tool-workprocess/src/tools.ts:550` | `WORK_TOOL_HUMAN_UNAVAILABLE` |
| A15 | `no-channel` ⇒ 退回「拒绝并指路」，不假装问过 | `tool-workprocess/src/tools.ts:529` | `requireActionAuthority('stage_done', authority, { stageClosePolicy: closePolicy })` |
| A16 | 工具码登记表（两个码必须在此登记才发得出） | `tool-workprocess/src/codes.ts:45` | `'WORK_TOOL_HUMAN_DECLINED',` |
| A17 | 同上 | `tool-workprocess/src/codes.ts:47` | `'WORK_TOOL_HUMAN_UNAVAILABLE',` |

### B. 驱动器：收口确认轮（不弹框，投一轮提示词）

| id | 出口（谁触发 / 何时 / 期望结局） | 锚点 | 该行原文片段 |
|---|---|---|---|
| B1 | 决策：阶段任务全达成且策略 `human` ⇒ 投 `ask-stage-done` | `workprocess-round-driver/src/decide.ts:204` | `reason: 'ask-stage-done-asked:' + stage.key` |
| B2 | 决策：全部阶段 done ⇒ 投 `ask-close` | `workprocess-round-driver/src/decide.ts:158` | `reason: 'ask-close-asked'` |
| B3 | 造轮：`askDeliveryOf`（stage-done / close 两种载荷） | `workprocess-round-driver/src/index.ts:326` | `export function askDeliveryOf(` |
| B4 | stage-done 载荷渲染 | `workprocess-round-driver/src/index.ts:336` | `prompt: renderWorkAskPrompt({` |
| B5 | close 载荷渲染 | `workprocess-round-driver/src/index.ts:348` | `kind: 'close' }),` |
| B6 | 投递分支：ask 轮（不消耗任务回合预算） | `workprocess-round-driver/src/index.ts:613` | `case 'ask-stage-done':` |
| B7 | 投递 + 落「已经问过」耐久记号 | `workprocess-round-driver/src/index.ts:626` | `if (reserveAndQueue(state, 'ask', delivery)) {` |
| B8 | 去重：同一修订只问一次（耐久记号 + 内存快挡） | `workprocess-round-driver/src/index.ts:576` | `humanAskAsked: (askKey) =>` |
| B9 | 轮次文案：`renderWorkAskPrompt` | `workprocess-round-driver/src/prompt.ts:171` | `export function renderWorkAskPrompt(` |
| B10 | 无弹框通道时，让 agent 用 `ask_user_question`（或直接开口） | `workprocess-round-driver/src/prompt.ts:180` | `请把这件事摆到人面前并等他回答（用` |
| B11 | 交代 agent：收口确认由**工具**弹框，不要自己问一遍 | `workprocess-round-driver/src/prompt.ts:202` | `工具会自己弹框请人确认` |

### C. 交代层：常驻策略段里对「弹框」的说明（决定 agent 走 A 还是 B）

| id | 出口（谁触发 / 何时 / 期望结局） | 锚点 | 该行原文片段 |
|---|---|---|---|
| C1 | 策略段：`human` 策略下「工具会自己弹框」 | `workprocess-round-driver/src/prompt.ts:81` | `判据齐了**请人确认**（工具会自己弹框）` |

### D. 边界：本仓能复现到哪、哪些只能真机看

- **能在本地跑（vitest + 假件）**：A 段的**工具面逻辑**——假弹框可断言「四种裁决各自落成哪条回执」：
  `tool-workprocess/tests/workprocess-tools.spec.ts:349`（造「任务全达成 + 策略 human + 非人发起」的流程并挂假弹框）、
  `:380`（`WORK_TOOL_HUMAN_DECLINED`）、`:388`（`WORK_TOOL_HUMAN_UNAVAILABLE`）。B/C 段是纯字符串/决策，也能本地断言。
- **只能在真机看（本仓不随宿主包）**：`node_modules/@deepseek-ai` 不存在（已核），宿主源码在兄弟目录
  `/Users/mac/Documents/ai/dsh/deepseek-harness`。真机才能观测的三件：
  ① 弹框**是否真的弹出来**（UI 面）；② 人作答的**真实形状**（`selected` / `custom` 的归一化——是不是空串而不是缺省）；
  ③ `agent` / `signal` 传递与 `NO_PROVIDER` 是否真的发生。
- **宿主契约（读源码即可，不必真机）**：`deepseek-harness/packages/interaction/user-questions/src/types.ts:36`
  （`AskUserQuestionItem`：`id/question/detail?/header?/options?/multiSelect?/intent?`）、
  `:60`（`custom?: string`）、`deepseek-harness/packages/interaction/user-questions/src/index.ts:86`（`ask()` 实现）。
  我们传的键（`questions/agent/signal`，问题里 `id/header/question/detail/options`）都在契约内；
  **待验**的是答案侧的两处形状假设（A10 的「`custom === undefined` 才算纯选项」、A9 的「`answers[].id` 回显」）——
  这是唯一一处「我们假设了宿主怎么答」，也正是收口确认最可能的断点，留给 `wt:repro:2` 复现。

## 复现（`wt:repro:2` 填）

### 已落地的红用例（本地可复现）

- 用例：`workprocess/tests/plugin.spec.ts` › `人机确认接线` ›
  **「人点了『跳过』（宿主 UI 编码 selected: []、无 custom）⇒ 不算『还要补做』，停手等人」**
- 命令：`npx vitest run workprocess/tests/plugin.spec.ts -t "跳过"`
- 现状（红）：`expected ... "code": "WORK_TOOL_HUMAN_UNAVAILABLE" / received "code": "WORK_TOOL_HUMAN_DECLINED"`——
  失败断言就钉在缺陷上：宿主 UI 的「跳过」被我们的适配器报成了「人选了还要补做」。

### 触发链（从人到回执）

1. 人在弹框里点「跳过」。宿主弹框 UI 对「跳过」的编码是 `{ id, selected: [] }`、**不带** `custom`
   （`deepseek-harness/packages/client/ui-user-questions/src/client/QuestionComposer.tsx:214`：`if (value.skipped) return { id: item.id, selected: [] }`）。
2. 我们的适配器（现行行号：批准测试在 `authority.ts:310`，declined 兜底在 `authority.ts:316-318`）：
   `selected.includes('确认收口')` 为 false → 落到 `custom === undefined || custom === ''` → 判 `declined`（无反馈）。
   **这里把「没回答」和「回答了还要补做」坍缩成了同一个裁决。**
3. 工具面 `tool-workprocess/src/tools.ts:543` 把 `declined` 报成 `WORK_TOOL_HUMAN_DECLINED`，
   回执文案写明「人在弹框里选了『还要补做』」——**替人编造了一句没说过的话**，
   并指示 agent「按人说的用 create_worktask 补任务」。后果：人只想跳过，agent 却可能据此建出一堆没人要的任务。

### 真机会话证据（辅助，非判据）

会话桶 `~/.dsh/sessions/--Users-mac-Documents-ai-dsh-dsh-workprocess--`（zstd 压缩，用 `zstdcat` 扫）里，
`WORK_TOOL_HUMAN_DECLINED` 出现 100+ 次、`WORK_TOOL_HUMAN_UNAVAILABLE` 100+ 次，另有 `CALLER_NOT_LIVE` /
`DELEGATED_CALLER` 若干。**注意**：这些会话同时在读/改本仓源码，计数混入了代码文本，只能作旁证、不能当结论。
真正可靠的复现是上面的红用例。

### 另存一条真机待验线索（不在本次修复面）

日志里的 `CALLER_NOT_LIVE` / `DELEGATED_CALLER` 指向另一种可能症状：宿主 `ask()` 校验
「传入的 agent 必须是注册表里那个活的 root」（`deepseek-harness/packages/interaction/user-questions/src/index.ts`
的 `ask` 实现），若我们传入的 `exec.agent` 在真机上不是 live root，弹框根本不会打开，直接落
`WORK_TOOL_HUMAN_UNAVAILABLE`。这条依赖宿主运行时形态，本地无法忠实复现——真机步骤：
把某阶段建成 `close_policy: human`、任务做完、等驱动器投收口确认轮后 agent 调 `update_workstage done`；
观察弹框是否弹出。弹出后点「跳过」→ 若 agent 回报「人选了还要补做」即本缺陷；若弹框根本没弹、
直接 `WORK_TOOL_HUMAN_UNAVAILABLE(CALLER_NOT_LIVE)` 则是另一条线，另立修复。

## 根因（`wt:repro:3` 填）

### 定论

**缺口在适配器 `askHumanOf` 的裁决映射：它只按「选中标签」二分，漏了宿主作答协议的第三种形状——「跳过」。**

- 宿主契约侧：答案项是 `{ id, selected: string[], custom?: string }`
  （`deepseek-harness/packages/interaction/user-questions/src/types.ts:54-61`），`selected` 为空是合法形状；
  弹框 UI 对「跳过」按钮的编码正是 `{ id, selected: [] }`、不带 `custom`
  （`QuestionComposer.tsx:214`），且 UI 在 custom 为空时**省略**该键（`QuestionComposer.tsx:219`）。
- 我们的适配器侧（缺口时刻的代码）：`tool-workprocess/src/authority.ts:310` 先测「选中 approve 且无 custom」⇒ approved；
  其余全部落到 declined 兜底（`authority.ts:316-318`「custom 空 ⇒ declined（无反馈）」）。
  「跳过」= `selected:[]` + 无 custom，走了 declined 分支——**「没作答」被坍缩成「回答了还要补做」**。
- 工具面放大器：`tools.ts:543-547` 把 declined 叙述成「人在弹框里选了『还要补做』……请按人说的用
  create_worktask 补任务」——一句人没说过的话 + 一个可能引出垃圾任务的指令。
  而正确的桶本来就在隔壁：`tools.ts:549-553` 的 `WORK_TOOL_HUMAN_UNAVAILABLE`（没问成 ⇒ 停手等人）。

一句因果：**输入契约有三种形状（批准 / 明确拒绝 / 跳过），调用方只画了两种格子，第三种滑进「拒绝」格，
被工具面叙述成一条虚构的人类指令。**

### 其余出口为什么不是所报症状（逐条排除）

- **驱动器收口确认轮（B 段）**：自己不弹框，只投提示词让 agent 去调工具（`workprocess-round-driver/src/index.ts:326` 造轮、`prompt.ts:171` 渲染文案）；红用例绕开驱动器、直接走工具调用路径就复现了误报，说明断点不在轮次本身。去重闸（`index.ts:576`）只影响问几次，不影响裁决语义。
- **通道与接线（A2/A4/A5）**：无服务 ⇒ `no-channel`（`authority.ts:290-291`）⇒ 工具退回「拒绝并指路」（`tools.ts:529`），回执是 `WORK_TOOL_AUTHORITY_REQUIRED`——不是本案的「虚构人话」。
- **弹框内容渲染（A8）**：`stageDetailOf`（`tools.ts:206`）只决定人看到什么，不碰裁决。
- **常驻策略段（C1）**：`prompt.ts:81` 纯文案，无运行时效果。
- **`CALLER_NOT_LIVE` / `DELEGATED_CALLER` 线索**：那是「弹框根本没打开」的另一症状（宿主 `ask()` 校验调用 agent 必须是活的 root），落的是 UNAVAILABLE 不是 DECLINED——与红用例的误报路径不同，且需真机确认，保持「另存线索」状态，不进本次修复面。

### 修复方向（wt:repro:3 时点的判断）

- **改哪里**：只动 `tool-workprocess/src/authority.ts` 的裁决映射（`askHumanOf` 内、approved 测试之后、
  declined 兜底之前）：「`selected` 为空 且 custom 空/缺省」⇒ `{ kind: 'cancelled', reason: 'skipped' }`，
  与 `ASK_CANCELLED` 同桶（没问成 ⇒ 停手等人，不编造人话）。明确选了非 approve 项、或带 custom 的，仍走 declined。
- **为什么这样改**：工具面已有 UNAVAILABLE 这个「没问成」的桶（`tools.ts:549-553`），只需让适配器把跳过送进去；
  不改工具面、不改驱动器、不新增工具码。与宿主 plan-mode 的差异是**有意的**：plan-mode
  （`deepseek-harness/packages/plan/plan-mode/src/index.ts:343-346`）把跳过也并入「keep planning」，
  无害（计划继续写而已）；我们的 declined 会驱动 agent 建任务，必须分清。
- **要加的断言**：① 「跳过」用例（`workprocess/tests/plugin.spec.ts:686`）转绿——核心回归锁；
  ② 既有「人选择还要补做」用例（`tool-workprocess/tests/workprocess-tools.spec.ts:380`）保持 declined 绿；
  ③ 既有「人确认」用例（`workprocess/tests/plugin.spec.ts:660` 一带）保持 approved 绿——证明修复没碰另外两格。

### 现状与时间线（如实交代）

落笔此节时，**修复已在工作区里**：`authority.ts` 的 mtime 为 Oct 13 11:18，缺口处现在就是上面方向的
5 行实现（`authority.ts:311-315`，跳过 ⇒ `cancelled`/`skipped`）。它**不是**本任务轮次写的——
时间线：11:15 红用例失败（收到 DECLINED）→ 11:18 `authority.ts` mtime 更新 → 11:21 同一条用例转绿，
全量 287/287 绿。即：根因复现与修复方向由本流程钉死，代码修复由并行工作落进（与本节方向逐字吻合），
红用例成为现成的回归锁。

## 修复（`wt:fix:2` 填）

### 落地的修复

- **位置**：`tool-workprocess/src/authority.ts:311-315`（`askHumanOf` 裁决映射内，approved 测试之后、declined 兜底之前）：
  `selected.length === 0 && (custom === undefined || custom === '')` ⇒ `{ kind: 'cancelled', reason: 'skipped' }`。
- **衔接**：工具面 `tools.ts:549-553` 的 UNAVAILABLE 桶原样接住——跳过 ⇒ 「收口确认没问成人（skipped）：本阶段不收口……停手等人」，
  不再替人编造选择，也不再驱动 agent 建任务。
- **为什么这能消掉根因**：根因是「三种作答形状只有两种格子」。这 5 行在 declined 兜底**之前**插入第三格，
  把「没作答」从「明确拒绝」中分出来，与 `ASK_CANCELLED` / `no-answer` 同桶——同一条纪律的两面：
  绝不把「没问成」当同意，也不把它当拒绝。明确选了非 approve 项、或带 custom 的，仍走 declined 兜底（`authority.ts:316-318`），一字未动。

### 回归锁（三格，全绿）

| 格子 | 用例 | 位置 |
|---|---|---|
| approve（批准） | 「agent 提请收口 ⇒ 工具弹框；人确认才落定」 | `workprocess/tests/plugin.spec.ts:658`（另有 `tool-workprocess/tests/workprocess-tools.spec.ts:367`） |
| decline（明确拒绝） | 「人选择『还要补做』⇒ 不收口，人的话原样转达」 | `workprocess/tests/plugin.spec.ts:667` |
| skip（跳过） | 「人点了『跳过』…停手等人」 | `workprocess/tests/plugin.spec.ts:686` |

### 回退实验（证明缺陷确实被这条用例锁住）

- **手法**：`git stash push -m "wt:fix:2-rollback-test" -- tool-workprocess/src/authority.ts`（只推这一个文件）→ 跑用例 → `git stash pop`。
- **守卫**：实验前 90 秒内工作区无任何写入（并行改动已收敛）；实验前后文件 md5 逐字节一致（`f989e77c…`），pop 无冲突。
- **读数**：回退到 HEAD（无修复）→ `expected "code": "WORK_TOOL_HUMAN_UNAVAILABLE" / received "code": "WORK_TOOL_HUMAN_DECLINED"`，
  **1 failed**（正是根因的误报形状）；恢复后 → **1 passed**。即「回退即红、恢复即绿」，回归锁生效。

### 真机走查脚本（wt:verify:1 用）

**前置**：`tool-workprocess/dist` 已含修复（11:35 构建验证过 `skipped` 在产物里）；profile 以 `link:` 直链本仓。
**需要人做**：①重启 DSH 桌面应用（让新 dist 生效）；②另开一个**新会话**（不要复用本流程这条，避免污染），
按下面四步点弹框；③把每次的实际回执/阶段状态读数（截图或转录）带回来，填入下表。

在一个新会话里对 agent 说：「用 workprocess 建一条单阶段流程（close_policy 用缺省的 human），
建一个任务并把它标完成，然后调 update_workstage 提议收口。」随后：

| 步 | 点法 | 预期（修复后） | 实际读数（人填） |
|---|---|---|---|
| ① | 只看弹框 | 弹出「阶段收口确认」：含「确认收口/还要补做」两选项 + 阶段陈述/判据/任务清单细节 | |
| ② | 点「确认收口」 | 工具回 `success:true, changed:true`，阶段落 `done` | |
| ③ | 再建一条同样流程，重走一遍，点「跳过」 | agent 收到 `WORK_TOOL_HUMAN_UNAVAILABLE`（reason `skipped`），说「停手等人」，**绝不**说「你选了还要补做」 | |
| ④ | 再建一条，点「还要补做」并填补充「测试补充」 | 工具回 `WORK_TOOL_HUMAN_DECLINED`，补充原样转达给 agent | |

⚠️ 若走查期间本仓 `tool-workprocess/src` 又有新改动（并行工作未停），需重新 `pnpm build` 并再次重启 DSH 后再走查。
