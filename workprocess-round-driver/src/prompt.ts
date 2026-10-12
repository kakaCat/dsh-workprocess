/**
 * **提示词渲染**（纯字符串函数，零 I/O）：任务轮 / 阶段规划轮 / 收口确认轮。
 *
 * 对齐宿主 `dsh-goal-round-driver` 的 `renderGoalRoundPrompt`（它内联在 index 里，
 * 我们因为有三种轮次而单独立一个模块）。
 *
 * @module workprocess-round-driver/prompt
 */
import { stageClosePolicyOf } from 'workprocess'
import type { WorkStageClosePolicy } from 'workprocess'

/** 一轮提示词的输入（由适配器从归属记录投影成窄事实）。 */
export interface WorkRoundPromptInput {
  /** 层0：流程目标。 */
  readonly processObjective: string
  /** 层1：当前阶段（键 + 陈述 + 达成判据 + 收口策略）。 */
  readonly stage: {
    readonly key: string
    readonly statement: string
    readonly doneCriteria: readonly string[]
    /** 收口策略（缺省 `human`）：决定边界里写"请人确认"还是"自动收口"。 */
    readonly closePolicy?: WorkStageClosePolicy
  }
  /** 层2：这一轮要跑的任务。 */
  readonly task: { readonly id: string; readonly objective: string }
  /** 本轮回合号（正整数的已准入回合号）。 */
  readonly round: number
  /** 生效回合上限（缺省 = 不限，仅陈述）。 */
  readonly maxRounds?: number
}

/** 渲染一轮提示词。 */
export function renderWorkRoundPrompt(input: WorkRoundPromptInput): string {  const criteria = input.stage.doneCriteria.length === 0
    ? ['（本阶段未登记达成判据——按阶段陈述推进）']
    : input.stage.doneCriteria.map((c) => '- ' + c)
  const cap = input.maxRounds === undefined ? '不限' : String(input.maxRounds)
  // 本阶段的收口策略是**逐阶段数据**（每个阶段可能不同），必须在投递里报出来——
  // 策略错写会让模型"替人收口"或"该自动却停手等人"。跨轮的规则（串行 / 预算 / 终局）不在这里复述：
  // 那些在常驻策略段里（`tool:workprocess`），投递只带本轮数据与本轮动作。
  const closeHint = stageClosePolicyOf(input.stage) === 'auto'
    ? '本阶段收口策略 `auto`：判据齐了由驱动器自动收口。'
    : '本阶段收口策略 `human`：判据齐了**请人确认**（工具会自己弹框）。'
  return wrap('workprocess_round', [
    '# 本轮任务（workprocess）',
    '',
    '流程目标：' + input.processObjective,
    '',
    '## 当前阶段（层1）',
    '阶段 `' + input.stage.key + '`：' + input.stage.statement,
    '达成判据：',
    ...criteria,
    '',
    '## 本轮任务（层2）',
    '任务 `' + input.task.id + '`：' + input.task.objective,
    '回合：第 ' + String(input.round) + ' 轮（上限 ' + cap + '）。' + closeHint,
    '',
    '## 停手条件',
    '- 达成：按判据自评后 task-complete，然后停手（不要顺手开新任务）。',
    '- 推不动：卡点写进回执，**先撑满 3 轮**（不足就落 block 会被拒）；满 3 轮仍推不动才 block（写清等谁）。',
  ])
}

/** 阶段规划轮的输入（本阶段已开工但还没有任务）。 */
export interface WorkPlanPromptInput {
  /** 层0：流程目标。 */
  readonly processObjective: string
  /** 层1：当前阶段（键 + 陈述 + 达成判据 + 收口策略）。 */
  readonly stage: {
    readonly key: string
    readonly statement: string
    readonly doneCriteria: readonly string[]
    readonly closePolicy?: WorkStageClosePolicy
  }
  /** 这一轮是第几轮规划（同一阶段重复规划时如实报号）。 */
  readonly round: number
}

/**
 * 渲染**阶段规划轮**的提示词：当前阶段已开工、**还没有任务**，请 agent 给本阶段建任务。
 *
 * 【为什么由驱动器发这一轮】阶段串行决定了"任务只属于当前阶段"，于是每过一个阶段边界新阶段必然是空的；
 * 决策层不臆造任务（怎么拆是判断），但**必须有人把"这个阶段是空的"这件事告诉 agent**——
 * 否则自动推进在每个阶段边界上都会停死。
 */
export function renderWorkPlanPrompt(input: WorkPlanPromptInput): string {
  const criteria = input.stage.doneCriteria.length === 0
    ? ['（本阶段未登记达成判据——按阶段陈述拆任务）']
    : input.stage.doneCriteria.map((c) => '- ' + c)
  return wrap('workprocess_plan', [
    '# 阶段规划轮（workprocess）',
    '',
    '流程目标：' + input.processObjective,
    '',
    '## 当前阶段（层1）',
    '阶段 `' + input.stage.key + '`：' + input.stage.statement,
    '达成判据：',
    ...criteria,
    '',
    '## 现在要做的唯一一件事',
    '本阶段已开工、**还没有任务**。用 `create_worktask`（`stage_key: "' + input.stage.key + '"`）建 **1–3 个**：',
    '- objective 写成**可核验**的陈述（跑什么、看到什么算过）。',
    '**只建任务，这一轮不要动手**：建完就停手，任务轮会由驱动器投给你（带 `<workprocess_round>` 标签）。',
    '（理由一行：回合预算与 block 门槛都按任务轮计数——在这一轮把活干掉，预算等于没启用。）',
    '',
    '## 停手条件',
    '- 规划是第 ' + String(input.round) + ' 轮：本阶段**确实无事可做**就明说并停手等人（不要反复空转）。',
  ])
}

/** **收口确认轮**的输入（阶段级 / 流程级两种）。 */
export interface WorkAskPromptInput {
  /** 层0：流程目标。 */
  readonly processObjective: string
  /** `stage-done` = 请人确认本阶段收口；`close` = 全阶段已收口，请人判流程成没成。 */
  readonly kind: 'stage-done' | 'close'
  /** 要人确认的阶段（`kind: 'close'` 时缺省 = 全阶段已收口）。 */
  readonly stage?: {
    readonly key: string
    readonly statement: string
    readonly doneCriteria: readonly string[]
  }
}

/**
 * 渲染**收口确认轮**的提示词：到这里机器能做的都做完了，剩下的是**人的判断**。
 *
 * 【为什么必须投这一轮】`human` 策略下 done 由人落、agent 只提议（授权面把 agent 自写拒掉）。
 * 但"提议"得真的**说出口**：没有这一轮，流程会安静地停在阶段边界上——**看起来就是卡死**
 * （真机踩过：任务全 complete、策略 human、没有任何人被告知）。
 * 没有弹框通道时，让 agent 用 `ask_user_question`（或直接开口）把这件事摆到人面前；
 * 人一回答就是普通的人类回合，agent 落章时授权面自然放行。
 */
export function renderWorkAskPrompt(input: WorkAskPromptInput): string {
  if (input.kind === 'close' || input.stage === undefined) {
    return wrap('workprocess_ask', [
      '# 流程收口待人工判断（workprocess）',
      '',
      '流程目标：' + input.processObjective,
      '',
      '## 现在要做的唯一一件事',
      '全部阶段都已收口——但**流程没有"完成"态**：成没成是判据，由人来判。',
      '请把这件事摆到人面前并等他回答（用 `ask_user_question` 问一句，或直接开口说清）：',
      '- 目标达成了没有？还有没有要补做的事？',
      '人要说还要做：用 `create_workstage` 替换阶段表（或新起一条流程），别自己宣布完成。',
    ])
  }
  const stage = input.stage
  const criteria = stage.doneCriteria.length === 0
    ? ['（本阶段未登记达成判据——按阶段陈述与人核对）']
    : stage.doneCriteria.map((c) => '- ' + c)
  return wrap('workprocess_ask', [
    '# 阶段收口待人工确认（workprocess）',
    '',
    '流程目标：' + input.processObjective,
    '',
    '## 当前阶段（层1）',
    '阶段 `' + stage.key + '`：' + stage.statement,
    '达成判据：',
    ...criteria,
    '',
    '## 现在要做的唯一一件事',
    '本阶段的任务**已全部达成**，而本阶段的收口策略是 `human`（**人工确认**）。',
    '请直接调：',
    '',
    '    update_workstage { action: "done", stage_key: "' + stage.key + '" }',
    '',
    '**工具会自己弹框请人确认**（不用你先用 `ask_user_question` 问一遍——人的答复只有走这个工具',
    '才落得下章：答复记在工具结果里，会话事件里没有"人说过话"的痕迹）。三种结果：',
    '- 人确认收口 ⇒ 工具落 done，本阶段收口，下一阶段由驱动器开工；',
    '- 人选「还要补做」（或写了补充）⇒ 工具回 `WORK_HUMAN_DECLINED` 并转达人的话：',
    '  按人说的用 `create_worktask` 补任务，**不要**再提请收口；',
    '- 人没答 / 打断了去说话 ⇒ 工具回 `WORK_HUMAN_UNAVAILABLE`：停手等人开口，别自己收口。',
    '',
    '## 边界',
    '- 不要用 `ask_user_question` 代替这个工具来做收口确认：答复不走工具，授权面不认，白跑一轮。',
    '- 人也可能改主意（把该阶段改成 `close_policy: auto`，由驱动器自动收口）——按人说的办。',
  ])
}

/** **终局收束轮**的输入：流程收口（complete）或停住等人（blocked）。 */
export interface WorkWrapupPromptInput {
  /** 层0：流程目标。 */
  readonly processObjective: string
  /** `complete` = 全阶段收口、流程落幕；`blocked` = 机器停住了，等人裁。 */
  readonly kind: 'complete' | 'blocked'
  /** 已收口的阶段（收束语里报账用）。 */
  readonly doneStages?: readonly { readonly key: string; readonly statement: string }[]
  /** `blocked` 的原因（`code: message`）。 */
  readonly blockedReason?: string
}

/**
 * **终局收束轮**：机器能做的都做完了（或停住了）⇒ 请 agent 给用户写结束语。
 *
 * 【为什么必须有这一轮】阶段收口与流程收口都是**静默写**：不投轮、对话里没有任何痕迹。
 * 于是"流程跑完了"在人看来与"卡死了"一模一样（真机两次被误判成 bug）。
 * 宿主 `dsh-goal-round-driver` 的 `wrapup` 模块解决的就是这件事（`<goal_complete>` /
 * `<goal_blocked>`：替换原来的硬停轮，让模型在收尾前仍对用户说一句话）——本函数是它的同款。
 *
 * 【不消耗任务回合预算】它不带 `round`：这不是"再跑一轮任务"，是收尾。
 */
export function renderWorkWrapupPrompt(input: WorkWrapupPromptInput): string {
  const done = (input.doneStages ?? []).map((s) => '- `' + s.key + '`：' + s.statement)
  if (input.kind === 'complete') {
    return wrap('workprocess_done', [
      '# 流程收口（workprocess）',
      '',
      '流程目标：' + input.processObjective,
      ...(done.length === 0 ? [] : ['', '已收口的阶段：', ...done]),
      '',
      '## 现在要做的唯一一件事',
      '这条流程**已经全部收口落幕**，本次自动续跑到此结束。请给用户写一句结束语：',
      '- 说清**做成了什么**（对着流程目标与各阶段判据说，不要复述过程）；',
      '- 说清**怎么验的**（跑过什么、看到什么）；',
      '- 指出**还需要人看什么**（若有）。',
      '',
      '## 边界',
      '- **不要再调任何工具**：这一轮只说话，后续工作等人下一条指令。',
      '- 只报这一会话里真正确立的事；细节不在会话里就如实说"不确定"。',
    ])
  }
  return wrap('workprocess_blocked', [
    '# 流程停住（workprocess）',
    '',
    '流程目标：' + input.processObjective,
    ...(input.blockedReason === undefined ? [] : ['', '停住的原因：' + input.blockedReason]),
    '',
    '## 现在要做的唯一一件事',
    '这条流程**停住了，需要人来裁**（回合预算到顶 / 卡在外部条件 / 需要人的决定）。',
    '请给用户写一句说明：已经做到哪一步、**具体被什么挡住**、需要人做什么才能继续。',
    '',
    '## 边界',
    '- **不要再调任何工具**，也不要自己"再试一次"绕过刹车：这一轮只说话，等人裁决。',
    '- 只报这一会话里真正确立的事；不确定就说不确定。',
  ])
}

/**
 * 把一段提示词包进标签（对齐宿主 `goal-round-driver` 的 `<goal_round>`）。
 *
 * 【为什么值得包】三条投递（轮次 / 规划 / 收口确认）**都不是人打的字**——标签让模型一眼分清
 * "这是我被自动投递的一轮"与"人在跟我说话"，也让常驻策略段能按标签名引用它们。
 */
function wrap(tag: string, lines: readonly string[]): string {
  return '<' + tag + '>\n' + lines.join('\n') + '\n</' + tag + '>'
}
