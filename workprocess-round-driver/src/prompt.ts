/**
 * **提示词渲染**（纯字符串函数，零 I/O）：任务轮 / 阶段规划轮 / 收口确认轮 / 终局收束轮。
 *
 * 对齐宿主 `dsh-goal-round-driver` 的 `renderGoalRoundPrompt`（它内联在 index 里，
 * 我们因为有多种轮次而单独立一个模块）。
 *
 * 【写作标准】
 * - 标签即身份：`<workprocess_*>` 已说明"这是自动投递的一轮"，正文不再重复报名；
 * - 先事实后动作：一段事实（目标 / 阶段 / 判据 / 任务 / 轮号），再写"做什么 + 调什么"；
 * - 只写指令，不附辩护词：设计理由与踩坑史留在代码注释，不进投递正文；
 * - 人称统一用"你"；工具调用写成可照抄的**合法 JSON** 行内码（key 带引号、参数原值），不用缩进伪代码块；
 * - 停手条件并入动作分支，不单独开节；
 * - 跨轮不变的规则（串行 / 预算 / 授权）归常驻策略段（`tool:workprocess`），投递不复述；
 * - 信息契约一个字不少：判据原文、轮号、门槛数字、收口策略都是逐阶段数据，
 *   要模型"对着判据说"，就得把判据投给它。
 *
 * @module workprocess-round-driver/prompt
 */
import { stageClosePolicyOf } from 'workprocess'
import type { WorkStageClosePolicy } from 'workprocess'

/** 层1阶段在提示词里的投影（三种轮次共用）。 */
interface StageProjection {
  readonly key: string
  readonly statement: string
  readonly doneCriteria: readonly string[]
  readonly closePolicy?: WorkStageClosePolicy
}

/** 渲染「当前阶段」事实行：陈述 + 达成判据（没登记就如实说，不编造）。 */
function stageSection(stage: StageProjection, emptyNote: string): string[] {
  const criteria = stage.doneCriteria.length === 0
    ? ['（' + emptyNote + '）']
    : stage.doneCriteria.map((c) => '- ' + c)
  return [
    '阶段 `' + stage.key + '`：' + stage.statement,
    '达成判据：',
    ...criteria,
  ]
}

/** 一轮提示词的输入（由适配器从归属记录投影成窄事实）。 */
export interface WorkRoundPromptInput {
  /** 流程（聚合根）：目标。 */
  readonly processObjective: string
  /** 层1：当前阶段（键 + 陈述 + 达成判据 + 收口策略）。 */
  readonly stage: StageProjection
  /** 层2：这一轮要跑的任务。 */
  readonly task: { readonly id: string; readonly objective: string }
  /** 本轮回合号（正整数的已准入回合号）。 */
  readonly round: number
  /** 生效回合上限（缺省 = 不限，仅陈述）。 */
  readonly maxRounds?: number
  /**
   * 落 `block` 的前置轮数门槛（缺省 {@link DEFAULT_BLOCKED_AFTER_ROUNDS}）。
   *
   * 【为什么必须投给它、而不能由提示词自己写死】门槛是**工具面的装载配置**
   * （`tool-workprocess` 的 `blockedAfterRounds`），提示词写死就与真实的拦截面漂移：
   * 模型按 3 去试、内核按 5 拒，白跑一轮（真机踩过同款：任务轮只说"推不动就 block"却不提门槛）。
   * 与 `maxRounds` 同款，数字由装载层给、并由消息来源自署（不变量伴生件重建提示词要靠它）。
   */
  readonly blockedAfterRounds?: number
}

/**
 * 落 `block` 的前置轮数门槛缺省值。
 *
 * 【为什么这里也有一份】`workprocess-round-driver` 与 `tool-workprocess` 是**两个独立的包**
 * （一包一 patch，各自的装载行、各自的 `config`），驱动器读不到工具面的配置。故：驱动器这里给
 * 一份缺省、并**必须与工具面那份取同一个数**（两处装载行都写着同一个值；`workprocess` 的全栈测试
 * 有一条门禁钉住"两边的缺省值必须一致"）。
 */
export const DEFAULT_BLOCKED_AFTER_ROUNDS = 3

/** 渲染一轮任务提示词。 */
export function renderWorkRoundPrompt(input: WorkRoundPromptInput): string {
  const cap = input.maxRounds === undefined ? '不限' : String(input.maxRounds)
  // 门槛数字来自**装载配置**（缺省 3）：写死就与工具面真实的拦截面漂移（见 `WorkRoundPromptInput`）。
  const blockedAfter = input.blockedAfterRounds ?? DEFAULT_BLOCKED_AFTER_ROUNDS
  // 本阶段的收口策略是**逐阶段数据**（每个阶段可能不同），必须在投递里报出来——
  // 策略错写会让模型"替人收口"或"该自动却停手等人"。
  const closeHint = stageClosePolicyOf(input.stage) === 'auto'
    ? '本阶段收口策略 `auto`：判据齐了由驱动器自动收口。'
    : '本阶段收口策略 `human`：任务全达成后需人确认（工具会自行弹框）。'
  return wrap('workprocess_round', [
    '流程目标：' + input.processObjective,
    '',
    ...stageSection(input.stage, '本阶段未登记达成判据——按阶段陈述推进'),
    '',
    '任务 `' + input.task.id + '`（第 ' + String(input.round) + ' 轮，上限 ' + cap + '）：' + input.task.objective,
    closeHint,
    '',
    '完成本任务，按结果二选一：',
    '- 仅当在本任务上先撑满 ' + String(blockedAfter) + ' 轮仍推不动 → '
      + '`update_worktask { "task_id": "' + input.task.id + '", "action": "block", "reason": "被什么挡住、等谁" }`'
      + '；落 block 后停手等人裁。',
    '- 判据通过 → `update_worktask { "task_id": "' + input.task.id + '", "action": "complete" }`；'
      + '然后停手，下一轮由驱动器投递。',
  ])
}

/** 阶段规划轮的输入（本阶段已开工但还没有任务）。 */
export interface WorkPlanPromptInput {
  /** 流程（聚合根）：目标。 */
  readonly processObjective: string
  /** 层1：当前阶段（键 + 陈述 + 达成判据）。 */
  readonly stage: StageProjection
}

/**
 * 渲染**阶段规划轮**的提示词：当前阶段已开工、**还没有任务**，请 agent 给本阶段建任务。
 *
 * 【为什么由驱动器发这一轮】阶段串行决定了"任务只属于当前阶段"，于是每过一个阶段边界新阶段必然是空的；
 * 决策层不臆造任务（怎么拆是判断），但**必须有人把"这个阶段是空的"这件事告诉 agent**——
 * 否则自动推进在每个阶段边界上都会停死。
 *
 * 【为什么这一轮不带轮号】规划轮不消耗任何任务的回合预算，也**不会重投**（同一阶段只问一次，
 * 之后决策树改停手等人）——投"第几轮"只会误导模型以为还有下一次。
 *
 * 【为什么"只建不动手"】真机踩过：规划轮写着"建完直接动手"，两阶段流程跑完 `rounds.started`
 * 还是 0——回合预算与 block 门槛都按任务轮计数，在这一轮把活干掉等于它们都没启用。
 */
export function renderWorkPlanPrompt(input: WorkPlanPromptInput): string {
  return wrap('workprocess_plan', [
    '流程目标：' + input.processObjective,
    '',
    ...stageSection(input.stage, '本阶段未登记达成判据——按阶段陈述拆任务'),
    '',
    '本阶段已开工、还没有任务。用 `create_worktask`（`stage_key: "' + input.stage.key + '"`）把本阶段拆成任务：',
    '一个任务一个判据——objective 写成可核验的陈述（跑什么、看到什么算过），拆几个由你定。',
    '这一轮只建任务、不要动手执行：任务轮由驱动器另行投递（回合预算与 block 门槛按任务轮计数）。',
    '建完任务、或判定本阶段无事可做，都用一句话回报然后停手——本轮只问一次，不会重投。',
  ])
}

/** **收口确认轮**的输入（阶段级 / 流程级两种）。 */
export interface WorkAskPromptInput {
  /** 流程（聚合根）：目标。 */
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
 * 【为什么必须投这一轮】`human` 策略下 done 由人落、agent 只提议（授权检查把 agent 自写拒掉）。
 * 但"提议"得真的**说出口**：没有这一轮，流程会安静地停在阶段边界上——**看起来就是卡死**
 * （真机踩过：任务全 complete、策略 human、没有任何人被告知）。
 *
 * 【为什么必须走工具确认，而不是 ask_user_question】宿主把人的答复只记成 `ask_user_question`
 * 的工具结果，不产生 `user/message` 事件 ⇒ 授权面看不见，模型问完再自己落定必然被拒（真机踩过）。
 * 故收口确认由 `update_workstage` 工具自己弹框问人。
 */
export function renderWorkAskPrompt(input: WorkAskPromptInput): string {
  if (input.kind === 'close' || input.stage === undefined) {
    return wrap('workprocess_ask', [
      '流程收口待人工判断。',
      '',
      '流程目标：' + input.processObjective,
      '',
      '全部阶段都已收口，但流程没有"完成"态——算不算达成由人来判。',
      '请把这件事摆到人面前并等他回答（`ask_user_question` 或直接开口说清）：目标达成了没有？还有没有要补做的？',
      '- 达成 → 如实转告结果，停手等下一条指令，不要自己宣布完成；',
      '- 还要做 → 用 `create_workstage` 替换阶段表（或新起一条流程）。',
    ])
  }
  const stage = input.stage
  return wrap('workprocess_ask', [
    '阶段收口待人工确认。',
    '',
    '流程目标：' + input.processObjective,
    '',
    ...stageSection(stage, '本阶段未登记达成判据——按阶段陈述与人核对'),
    '',
    '本阶段任务已全部达成，收口策略为 `human`（需人确认）。直接调用：',
    '',
    '`update_workstage { "action": "done", "stage_key": "' + stage.key + '" }`',
    '',
    '工具会自行弹框请人确认——不要先用 `ask_user_question` 问：答复不走工具，系统不认。'
      + '若要求 CAS revision，先 `get_workstage` 取当前值。三种结果：',
    '- 人确认 → 落 done，下一阶段由驱动器开工；',
    '- 人选「还要补做」（或写了补充）→ 工具回 `WORK_TOOL_HUMAN_DECLINED` 并转达：'
      + '按人说的用 `create_worktask` 补任务，不要再提请收口；',
    '- 人未答 / 被打断 → 工具回 `WORK_TOOL_HUMAN_UNAVAILABLE`：停手等人开口。',
  ])
}

/** **终局收束轮**的输入：流程收口（complete）或停住等人（blocked）。 */
export interface WorkWrapupPromptInput {
  /** 流程（聚合根）：目标。 */
  readonly processObjective: string
  /** `complete` = 全阶段收口、流程落幕；`blocked` = 机器停住了，等人裁。 */
  readonly kind: 'complete' | 'blocked'
  /** 已收口的阶段（收束语里报账用；判据一并带上——要模型"对着判据说"，就得让它看得见）。 */
  readonly doneStages?: readonly {
    readonly key: string
    readonly statement: string
    readonly doneCriteria?: readonly string[]
  }[]
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
  const done = (input.doneStages ?? []).map((s) => {
    const criteria = (s.doneCriteria ?? []).length === 0 ? '' : '（判据：' + s.doneCriteria!.join('；') + '）'
    return '- `' + s.key + '`：' + s.statement + criteria
  })
  if (input.kind === 'complete') {
    return wrap('workprocess_done', [
      '流程目标：' + input.processObjective,
      ...(done.length === 0 ? [] : ['', '已收口的阶段：', ...done]),
      '',
      '这条流程已经全部收口落幕，自动续跑到此结束。给用户写一句结束语：',
      '- 做成了什么（对着流程目标与各阶段判据说，不复述过程）；',
      '- 怎么验的（跑过什么、看到什么）；',
      '- 还需要人看什么（若有）。',
      '这一轮只说话：不要再调任何工具，后续工作等人下一条指令。',
      '只报真正确立的事，不确定就说不确定。',
    ])
  }
  return wrap('workprocess_blocked', [
    '流程目标：' + input.processObjective,
    ...(input.blockedReason === undefined ? [] : ['', '停住的原因：' + input.blockedReason]),
    '',
    '这条流程停住了，需要人来裁。给用户写清：已经做到哪一步、具体被什么挡住、需要人做什么才能继续。',
    '这一轮只说话：不要再调任何工具，也不要自己"再试一次"绕过刹车。',
    '只报真正确立的事，不确定就说不确定。',
  ])
}

/**
 * 把一段提示词包进标签（对齐宿主 `goal-round-driver` 的 `<goal_round>`）。
 *
 * 【为什么值得包】这些投递**都不是人打的字**——标签让模型一眼分清
 * "这是我被自动投递的一轮"与"人在跟我说话"，也让常驻策略段能按标签名引用它们。
 */
function wrap(tag: string, lines: readonly string[]): string {
  return '<' + tag + '>\n' + lines.join('\n') + '\n</' + tag + '>'
}
