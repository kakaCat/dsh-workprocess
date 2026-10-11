/**
 * 回合提示词渲染（对齐宿主 `goal-round-driver/src/prompt.ts` 的职责：
 * 把"这一段要达成什么 + 这一轮跑什么 + 边界"写成投给模型的那条消息）。
 *
 * 【两层怎么写进提示词】提示词必须让模型一眼看出**自己在哪一层做事**：
 *   · 流程目标（层0）—— 为什么有这条流程；
 *   · 当前阶段 + 达成判据（层1）—— 参照系，也是"什么时候收口、由谁收口"的判据（收口策略）；
 *   · 这一轮的任务（层2）—— 唯一要动手的事。
 * 阶段间串行这条纪律写在边界里：**不许越阶段开工**（越界由 `stage-start` 的串行门兜底）。
 *
 * 纯函数：只吃结构化入参、返回字符串（可穷举单测；不读时钟、不读记录）。
 *
 * @module workprocess/round/prompt
 */
import { stageClosePolicyOf } from 'workprocess-core'
import type { WorkStageClosePolicy } from 'workprocess-core'

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
export function renderWorkRoundPrompt(input: WorkRoundPromptInput): string {
  const criteria = input.stage.doneCriteria.length === 0
    ? ['（本阶段未登记达成判据——按阶段陈述推进）']
    : input.stage.doneCriteria.map((c) => '- ' + c)
  const cap = input.maxRounds === undefined ? '不限' : String(input.maxRounds)
  // 收口策略的两条路都要写清：策略错写会让模型"替人收口"或"该自动却停手等人"。
  const closeLine = stageClosePolicyOf(input.stage) === 'auto'
    ? '2. 本阶段收口（stage-done）策略是 `auto`：任务全达成后**由驱动器自动收口**，你不要自写完成。'
    : '2. 本阶段收口（stage-done）是**人工确认**（策略 `human`）：判据齐了请人确认，不要自写完成。'
  return [
    '# 工作轮次（workprocess）',
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
    '回合：第 ' + String(input.round) + ' 轮（上限 ' + cap + '）',
    '',
    '## 边界',
    '1. 只做本阶段**本任务**的事，不越阶段开工（阶段间串行：前一阶段全部达成后才轮到下一阶段）。',
    closeLine,
    '3. 任务达成（task-complete）由你按判据自评后落库；被中断就 block 并写清原因。',
    '',
    '## 停手条件',
    '- 判据未齐又推不动：block 任务并说明被什么挡住（等人/等上游）。',
    '- 任务已达成：task-complete 后停手，不要顺手开新任务。',
  ].join('\n')
}
