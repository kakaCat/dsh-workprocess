/**
 * 我们自署的**回合消息来源**（`source.kind = 'work'`）。
 *
 * 【为什么必须自署】授权面就是按这个字段判"这一轮是人打的字还是自动续跑"：
 * `Agent.followup()` 省略 source 时会被当成 **user**（`authority.ts` 的注释引的是宿主同款口子），
 * 那会让自动回合冒充人话——于是 agent 就能靠自动续跑替人收口 `human` 策略的阶段。
 * 自署 `work` 之后：自动回合 = `autonomous`，`human` 策略的收口照样落不了章。
 *
 * 【模块增强】与宿主 `goal` 同款：往 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 里加一格。
 * 运行时不查来源白名单（持久化只查 surface 内容），所以这只是类型面的事。
 *
 * @module workprocess/message
 */
import type {} from '@deepseek-ai/dsh-llm'

/** 续跑回合的来源载荷（进程 / 阶段 / 任务 / 修订 / 回合号：授权面按它精确匹配）。 */
export interface WorkRoundMessageSource {
  readonly kind: 'work'
  readonly processId: string
  /** 本轮所在的阶段（任务轮与**阶段规划轮**都带）。 */
  readonly stageKey?: string
  /**
   * 这一轮跑的**任务**；**阶段规划轮没有任务**（它在请 agent 给本阶段建任务），
   * 也因此没有 `round`——规划轮不消耗任务的回合预算，不该推进 `rounds.started`。
   */
  readonly taskId?: string
  readonly revision: number
  readonly round?: number
}

/**
 * **工具通告**的来源载荷（对齐宿主 `dsh-tool-goal` 的 `{ kind: 'tool-goal', form: 'notice', summary }`）。
 *
 * 与 `work` 分开是**有意的**：`work` 是"自动续跑回合"（授权面据此判自治），
 * 而工具通告只是挂在某次工具回执之后的说明——**它不该授予任何人任何权限**
 * （`kind` 既不是 `user` 也不是 `work`，授权面解析结果保持保守侧）。
 */
export interface WorkToolNoticeSource {
  readonly kind: 'work-tool'
  readonly form: 'notice'
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** workprocess 的自动续跑回合（**不是人**）。 */
    work: WorkRoundMessageSource
    /** workprocess 工具回执之后的通告（附在 tool/result 之后；不授任何权限）。 */
    'work-tool': WorkToolNoticeSource
  }
}
