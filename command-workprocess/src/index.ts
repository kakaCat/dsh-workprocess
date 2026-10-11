/**
 * `/work` 命令行 —— **独立包、独立装载行**（与宿主 `@deepseek-ai/dsh-command-goal` 同形）。
 *
 * 【为什么单独一个包】宿主里 `/goal` 也不是塞在 `dsh-goal` 里的，而是 `dsh-command-goal`：
 * 命令是**人**的入口，工具是**模型**的入口，两者的依赖面不同（命令只要 `commands` + 领域服务）。
 * 拆开之后：没装命令行的组合不影响工具面；命令行也可以单独换。
 *
 * 【它怎么拿数据】只消费 `ctx.workprocess`（由 `dsh-workprocess` 提供）——不自己开存储域
 * （同名域重复 `open` 是响亮拒绝），也不绕内核改状态。动作按 `invocation.agent` 定位会话。
 *
 * 【命令天然的授权】命令由人敲出来，所以 `discard` / `resume` 这类真人专属动作在这一层是合法的
 * （与工具面的授权口径同源，不是开后门）。
 *
 * @module dsh-command-workprocess
 */
import type { WorkprocessService, WorkprocessStatus } from 'dsh-workprocess'
import type { WorkStage, WorkTask } from 'workprocess-core'

/** 插件名（装载行 id 同源）。 */
export const name = 'command-workprocess'

/** 装配依赖：命令注册面 + workprocess 领域服务（由 `dsh-workprocess` 提供）。 */
export const inject = ['commands', 'workprocess']

const USAGE = '用法：/work [pause|resume|discard]'

type WorkCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'discard' }
  | { readonly kind: 'unknown'; readonly raw: string }

/** 解析 `/work` 的语法（不认识的子命令如实报错，不当成别的东西）。 */
export function parseWorkCommand(rawInput: string): WorkCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  switch (input.toLowerCase()) {
    case 'pause': return { kind: 'pause' }
    case 'resume': return { kind: 'resume' }
    case 'discard': return { kind: 'discard' }
    default: return { kind: 'unknown', raw: input }
  }
}

/** 命令调用（宿主 `CommandInvocation` 的最小面）。 */
export interface WorkCommandInvocation {
  readonly rawInput: string
  readonly agent: unknown
}

/** 命令结果（宿主 `CommandResult` 的最小面）。 */
export interface WorkCommandResult {
  readonly kind: 'success' | 'error'
  readonly text: string
}

/** 阶段一行（key / 态 / 收口策略 / 任务计数）。 */
function stageLine(stage: WorkStage, isCurrent: boolean): string {
  const done = stage.tasks.filter((t) => t.phase === 'complete').length
  return (isCurrent ? '▶ ' : '  ')
    + stage.key + '：' + stage.state + '（收口 ' + (stage.closePolicy ?? 'human') + '，任务 '
    + String(done) + '/' + String(stage.tasks.length) + '）—— ' + stage.statement
}

/** 任务一行（相位 + 阻塞原因 + 陈述）。 */
function taskLine(task: WorkTask): string {
  const blocked = task.blockedReason === undefined ? '' : '（' + task.blockedReason.code + '：' + task.blockedReason.message + '）'
  return '  · ' + task.id + ' ' + task.phase + blocked + ' —— ' + task.objective
}

/** 状态排版：走到哪了 / 谁该动 / 能做什么。 */
export function renderWorkStatus(title: string, status: WorkprocessStatus): WorkCommandResult {
  const current = status.stages.find((s) => s.key === status.currentStageKey)
  const rounds = String(status.roundsStarted) + (status.maxRounds === undefined ? '' : '/' + String(status.maxRounds))
  const whoActs = current === undefined
    ? ['全部阶段已收口：流程没有"完成"态——成没成是判据（人判）。']
    : current.state === 'pending'
      ? ['当前阶段还没开工：空闲边界上驱动器会自动开工。']
      : current.tasks.some((t) => t.phase === 'active')
        ? ['当前阶段有活动任务：空闲边界上驱动器会自动投递续跑回合（受回合上限约束）。']
        : current.tasks.every((t) => t.phase === 'complete')
          ? [current.closePolicy === 'auto'
            ? '任务全部完成：策略 auto ⇒ 驱动器在边界上自动收口。'
            : '任务全部完成：策略 human ⇒ 等人确认（在会话里说一句，或让模型调 update_workstage done）。']
          : ['没有可跑的任务：等人在输入框里放行/补任务。']
  const hints = ['/work', ...(current === undefined ? [] : ['/work pause', '/work resume']), '/work discard']
  return {
    kind: 'success',
    text: [
      title,
      '目标：' + status.objective,
      '阶段：',
      ...status.stages.map((s) => stageLine(s, s.key === status.currentStageKey)),
      ...(current === undefined ? [] : ['当前阶段的任务：', ...current.tasks.map(taskLine)]),
      '已准入回合：' + rounds,
      '',
      ...whoActs,
      '命令：' + hints.join('、'),
    ].join('\n'),
  }
}

/** 造命令 handler（对着 `ctx.workprocess` 服务做分派）。 */
export function workCommandHandler(service: WorkprocessService) {
  return async (invocation: WorkCommandInvocation): Promise<WorkCommandResult> => {
    const command = parseWorkCommand(invocation.rawInput)
    try {
      const status = await service.view(invocation.agent)
      if (command.kind === 'unknown') {
        return { kind: 'error', text: '不认识的子命令：' + command.raw + '\n' + USAGE }
      }
      if (command.kind === 'show') {
        return status === undefined
          ? { kind: 'success', text: '这条会话还没有流程（用 create_workstage 建一条）。\n' + USAGE }
          : renderWorkStatus('流程（workprocess）', status)
      }
      if (status === undefined) {
        return { kind: 'error', text: '还没有流程，/work ' + command.kind + ' 无事可做。\n' + USAGE }
      }
      if (command.kind === 'discard') {
        const changed = await service.discard(invocation.agent)
        return { kind: 'success', text: changed ? '流程已丢弃（不可逆：任务墓碑与回合计数一并归零）。' : '没有流程可丢。' }
      }
      if (command.kind === 'pause') {
        const paused = await service.pauseActive(invocation.agent)
        return {
          kind: 'success',
          text: paused.length === 0 ? '当前阶段没有活动任务可暂停。' : '已暂停：' + paused.join('、') + '（自动续跑随之停下；/work resume 放行）',
        }
      }
      const resumed = await service.resumePaused(invocation.agent)
      return { kind: 'success', text: resumed.length === 0 ? '当前阶段没有被暂停的任务。' : '已恢复：' + resumed.join('、') }
    } catch (err) {
      // 领域拒绝（WorkError）都当"当前状态不允许"报出去，不把栈甩给人。
      return { kind: 'error', text: '这条命令在当前状态不成立：' + String((err as Error)?.message ?? err) }
    }
  }
}

/** 命令注册面的最小形状（宿主 `ctx.commands`）。 */
export interface WorkCommandSurface {
  register(definition: {
    readonly definitionId: unknown
    readonly name: string
    readonly description: string
    readonly input: { readonly hint: string; readonly attachments?: boolean }
    readonly handler: (invocation: WorkCommandInvocation) => Promise<WorkCommandResult>
  }): unknown
}

interface CommandCtx {
  readonly commands: WorkCommandSurface
  readonly workprocess: WorkprocessService
}

/**
 * 注册 `/work`。`definitionId` 在宿主侧是品牌字符串（`CommandDefinitionId(...)`，运行时就是字符串），
 * 这里给同款字面量——不为一行品牌函数引入宿主依赖。
 */
export function apply(ctx: CommandCtx): void {
  ctx.commands.register({
    definitionId: '@deepseek-ai/dsh-command-workprocess',
    name: 'work',
    description: '查看/干预这条流程（阶段 · 任务 · 回合）',
    input: { hint: '[pause|resume|discard]' },
    handler: workCommandHandler(ctx.workprocess),
  })
}
