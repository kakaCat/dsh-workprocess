/**
 * `/work` 命令行 —— **独立包、独立装载行**（与宿主 `@deepseek-ai/dsh-command-goal` 同形）。
 *
 * 【为什么单独一个包】宿主里 `/goal` 也不是塞在 `dsh-goal` 里的，而是 `dsh-command-goal`：
 * 命令是**人**的入口，工具是**模型**的入口，两者的依赖面不同（命令只要 `commands` + 领域服务）。
 * 拆开之后：没装命令行的组合不影响工具面；命令行也可以单独换。
 *
 * 【语法逐字对齐 `/goal`】`/work [<目标>|edit <目标>|pause|resume|clear]`
 *   · 缺省 = 看状态（人看的一屏：走到哪了 / 谁该动 / 能做什么）；
 *   · `<目标>` = **把目标交给 agent**（见下）；
 *   · `edit <目标>` = **让 agent 改目标**；
 *   · `pause` / `resume` / `clear` = 命令**直接落**（机械的控制动作，不该求模型帮忙）。
 *
 * 【创建为什么是"投话"而不是命令自己建】goal 的目标是一句话，命令自己就能落库；
 * workprocess 的流程**必须带阶段表**，而"这条目标该拆成哪几段"是判断，不是机械转换——
 * 故命令只把目标转成一条投给会话的指令（`agent.followup`），由 agent 用工具面自己拆阶段建流程。
 * 命令绝不替它猜阶段表（猜出来的阶段表会把模型绑在一个它没同意过的结构上）。
 *
 * 【消息来源为什么自署 `user`】这一轮是**人敲了命令**才发生的（`/goal` 提交附件同款）：
 * 授权面据此判"本回合由人发起"，`update_workstage action=edit` 这类**真人专属**动作才落得下章。
 * 若省略 source 会被当成 user（同样的判定），但显式自署是"这是人发起的一轮"的诚实声明。
 *
 * 【它怎么拿数据】只消费 `ctx.workprocess`（由 `dsh-workprocess` 提供）——不自己开存储域
 * （同名域重复 `open` 是响亮拒绝），也不绕内核改状态。动作按 `invocation.agent` 定位会话。
 *
 * 【命令天然的授权】命令由人敲出来，所以 `edit` / `resume` / `clear` 这类真人专属动作在这一层是合法的
 * （与工具面的授权口径同源，不是开后门）。
 *
 * @module dsh-command-workprocess
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { WorkprocessService, WorkprocessStatus } from 'dsh-workprocess'
import type { WorkStage, WorkTask } from 'workprocess-core'

/** 插件名（装载行 id 同源）。 */
export const name = 'command-workprocess'

/** 装配依赖：命令注册面 + workprocess 领域服务（由 `dsh-workprocess` 提供）。 */
export const inject = ['commands', 'workprocess']

const USAGE = '用法：/work [<目标>|edit <目标>|pause|resume|clear]'

type WorkCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'invalid-edit' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'clear' }

/**
 * 解析 `/work` 的语法（与 `/goal` 逐字同形：**只吃掉自己的控制词，其余一律当目标**）。
 *
 * 认领的控制词：`pause` / `resume` / `clear`（另收 `discard` 作 `clear` 的老写法别名）。
 * `edit` 单独出现 = 缺新目标（报错，不当成目标叫 "edit"）。
 * 目标就是"人写的那句话"——命令不修剪、不改写、不校验（那是 agent 与内核的活）。
 */
export function parseWorkCommand(rawInput: string): WorkCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'clear' || control === 'discard') return { kind: 'clear' }
  if (control === 'pause') return { kind: 'pause' }
  if (control === 'resume') return { kind: 'resume' }
  if (control === 'edit') return { kind: 'invalid-edit' }
  if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() }
  return { kind: 'create', objective: input }
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

/** 命令要投话时的 agent 最小面（宿主 `Agent.followup`）。 */
interface FollowupAgent {
  readonly followup?: (message: unknown) => void
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
  const hints = ['/work', ...(current === undefined ? [] : ['/work pause', '/work resume']), '/work edit <目标>', '/work clear']
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

/**
 * **建成指令**：把"人给的目标"转成一条给 agent 的活。
 *
 * 只交代"要什么 + 边界在哪"，**不预设阶段表**——怎么拆是模型该做的判断；
 * 但它必须知道两条硬口径：任务不该越阶段预建、收口策略按"能不能自动判定"选。
 */
export function createInstruction(objective: string): string {
  return [
    '请用 workprocess 工具为这条会话建立一条流程（人在输入框敲了 `/work`，下面是它给的目标）。',
    '',
    '流程目标：' + objective,
    '',
    '要求：',
    '1. 用 `create_workstage` 建流程（objective 用上面这句），并**自己拆阶段**：3–5 段，key 短（小写英文），',
    '   statement 说清这段做什么，done_criteria 写**可核验**的判据（跑什么、看到什么算过）。',
    '2. 收口策略按需选：能自动判定"任务全完成"的阶段给 `close_policy: auto`；需要人点头的留缺省（human）。',
    '3. 只建**当前阶段**该做的任务，不要把后续阶段的任务一次建满（阶段是串行的；',
    '   后续阶段到达时驱动器会再提醒你规划那一段）。',
    '4. 建完用一句话回报：分了哪几段、当前该做什么。',
  ].join('\n')
}

/**
 * **改目标指令**：`/work edit <目标>` 投给 agent 的活。
 *
 * 目标本身是**真人专属**动作（`update_workstage action=edit`）；命令以人的名义发起这一轮，故它能落章。
 */
export function editInstruction(objective: string): string {
  return [
    '请用 workprocess 工具改这条会话的流程目标（人在输入框敲了 `/work edit`）。',
    '',
    '新目标：' + objective,
    '',
    '要求：',
    '1. 用 `update_workstage`（`action: edit`，`objective` = 新目标）落目标——阶段与任务**原样保留**。',
    '2. 若阶段表也得跟着新目标重排，再用 `create_workstage` 整体替换（同名阶段保留其任务与态；',
    '   会被丢掉任务的阶段会被内核拒——先想清楚再换）。',
    '3. 回报改了什么。',
  ].join('\n')
}

/**
 * 把一条指令投给会话（命令**不自己建流程**：结构由 agent 拆）。
 *
 * 【必须保持方法调用】`agent.followup(...)`——**不能**把方法摘进变量再调：
 * 宿主 `AgentLoop.followup` 内部走 `this.send(...)`，脱离接收者调用会让 `this` 变 undefined，
 * 症状是 `Cannot read properties of undefined (reading 'send')`（真机踩过）。
 */
function deliver(invocation: WorkCommandInvocation, text: string, receipt: string): WorkCommandResult {
  const agent = invocation.agent as FollowupAgent | undefined
  if (typeof agent?.followup !== 'function') {
    return {
      kind: 'error',
      text: '这个宿主 agent 不支持 followup，没法把这条指令交给它（命令面不替它建流程）。'
        + '请直接在会话里说一句"用 workprocess 建一条流程：…"。',
    }
  }
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  return { kind: 'success', text: receipt }
}

/** 造命令 handler（对着 `ctx.workprocess` 服务做分派）。 */
export function workCommandHandler(service: WorkprocessService) {
  return async (invocation: WorkCommandInvocation): Promise<WorkCommandResult> => {
    const command = parseWorkCommand(invocation.rawInput)
    try {
      const status = await service.view(invocation.agent)
      if (command.kind === 'invalid-edit') {
        return { kind: 'error', text: '改目标需要给出新目标（`/work edit <目标>`）。\n' + USAGE }
      }
      if (command.kind === 'show') {
        return status === undefined
          ? { kind: 'success', text: '这条会话还没有流程（用 `/work <目标>` 让 agent 建一条）。\n' + USAGE }
          : renderWorkStatus('流程（workprocess）', status)
      }
      // 结构化动作（建流程 / 改目标）交给 agent：命令只把目标转成指令，不猜阶段表。
      if (command.kind === 'create') {
        if (status !== undefined) {
          return {
            kind: 'error',
            text: '这条会话已经有一条流程了（目标：' + status.objective + '）。'
              + '换目标用 `/work edit <目标>`，撤掉用 `/work clear`。',
          }
        }
        return deliver(
          invocation, createInstruction(command.objective),
          '已把目标交给 agent：' + command.objective + '\n它会用 workprocess 工具拆阶段建流程（建完用 `/work` 看进度）。',
        )
      }
      if (command.kind === 'edit') {
        if (status === undefined) {
          return { kind: 'error', text: '这条会话还没有流程，无从改目标——先用 `/work <目标>` 建一条。\n' + USAGE }
        }
        return deliver(
          invocation, editInstruction(command.objective),
          '已让 agent 把流程目标改成：' + command.objective + '（阶段与任务保留；要重排它会再做）',
        )
      }
      // 机械的控制动作：命令直接落（不求模型帮忙，模型不在也能用）。
      if (status === undefined) {
        return { kind: 'error', text: '还没有流程，/work ' + command.kind + ' 无事可做。\n' + USAGE }
      }
      if (command.kind === 'clear') {
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
    description: '建/看/干预这条流程（阶段 · 任务 · 回合）：给目标即让 agent 拆阶段建流程',
    input: { hint: '[<目标>|edit <目标>|pause|resume|clear]' },
    handler: workCommandHandler(ctx.workprocess),
  })
}
