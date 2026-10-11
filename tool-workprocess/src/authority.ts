/**
 * workprocess 工具的**执行期授权**（对齐宿主 `@deepseek-ai/dsh-tool-goal/src/authority.ts`
 * 那里判定"这次调用是人直接发起还是自动回合"，本包按同一纪律做 workprocess 版判定）。
 *
 * 【授权口径】（对齐宿主 dsh 的 update 政策，不是新发明）
 *   · `task_edit` = **direct-human only**——改目标（对齐宿主 `update_goal`：
 *     "edit, pause, and resume require a direct top-level human request"）；
 *   · `task_resume` = **direct-human only**——"继续"只有人能发起（对齐 `arm-explicit`：
 *     改人的意图只有人能发起；agent 自行 resume 会让"人显式暂停"被悄悄推翻）；
 *   · `stage_done` = **direct-human only**——阶段收口是**人工确认**（agent 只提议，不确认）；
 *   · `task_pause` / `task_block` / `task_complete` / `task_clear` = agent 可发起
 *     （运行时故障、等上游、判据达成、误建任务要撤，都可能是 agent 先知道的）。
 *
 * 【为什么留解析钩子】本包的工具执行面拿不到宿主的 `ctx.agents` / 会话事件切面。故这里定义
 * **判据**并把解析做成可注入的钩子：组合根能提供真人判定就接上；缺省 = `autonomous`
 * （保守侧：edit / resume / stage_done 被拒并指路宿主界面）。
 *
 * @module tool-workprocess/authority
 */
import { WorkError } from 'workprocess'

/** 一次状态变更调用获得的硬授权（对齐宿主 `GoalToolAuthority`）。 */
export type WorkToolAuthority =
  | { readonly kind: 'direct-human' }
  | { readonly kind: 'autonomous' }

/**
 * 续跑回合的**精确授权四元组**（对齐宿主 `isMatchingGoalRound`，本包加了 taskId 这一维）：
 * `taskId + revision + round` 三项都要与**当前**任务对得上，才算"正是该任务的续跑回合"：
 *   · taskId 不对   → 是别的任务的回合；
 *   · revision 不对 → 任务在回合开始后被改过（旧回合不代表当前目标）；
 *   · round 不对    → 不是最新准入的回合（旧回合 / 伪造回合）。
 */
export interface WorkRoundRef {
  readonly taskId: string
  readonly revision: number
  readonly round: number
}

/** 消息来源里与授权相关的字段（`taskId`/`revision` 是 `WorkMessageSource` 的对应半）。 */
interface AuthoritySource {
  readonly kind?: string
  readonly round?: number
  readonly taskId?: string
  readonly revision?: number
}

/** 来源是否**精确**命中四元组（缺 taskId 的旧消息：给了期望就不放行——严格侧）。 */
function isMatchingWorkRound(source: AuthoritySource | undefined, expected: WorkRoundRef): boolean {
  return source?.kind === 'work'
    && source.taskId === expected.taskId
    && source.revision === expected.revision
    && source.round === expected.round
}

/**
 * 从**会话事件**判定本回合的授权（对齐宿主 `hasDirectHumanInput` / `completionAuthority`）。
 *
 * 宿主扫 `user/message` 且 `source.kind === 'user'`；本包把它做成纯函数，
 * 组合根拿到事件切面后调用即可（缺省不判 = 退回 `autonomous`，见 `workToolExecution`）。
 *
 * @param events 有序事件数组（`seq` 即下标）
 * @param openTurnStartSeq 本回合起始 seq（**只扫它之后的事件**——历史里的人类消息不算本轮授权）
 * @param isRootAgent 调用者是否为顶层 agent
 * @param expected 当前任务的授权三元组（taskId + revision + round）
 */
export function authorityFromEvents(
  events: readonly { readonly type?: string; readonly data?: { readonly source?: AuthoritySource } }[],
  openTurnStartSeq: number,
  isRootAgent: boolean,
  expected?: WorkRoundRef,
): WorkToolAuthority | undefined {
  if (!isRootAgent) return undefined
  let workRound = false
  for (let seq = openTurnStartSeq + 1; seq < events.length; seq += 1) {
    const event = events[seq]
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind === 'user') return { kind: 'direct-human' }
    if (expected !== undefined ? isMatchingWorkRound(source, expected) : source?.kind === 'work') {
      workRound = true
    }
  }
  return workRound ? { kind: 'autonomous' } : undefined
}

/** 需要真人授权的**全部**动作（唯一一份：改这里即改全部调用点）。 */
export type WorkAuthorityAction =
  | 'task_edit' | 'task_pause' | 'task_resume' | 'task_block' | 'task_complete' | 'task_clear'
  | 'stage_done'

/** 调用者解析结果（对齐宿主 `GoalToolExecution` 的最小面）。 */
export interface WorkToolExecution {
  readonly authority: WorkToolAuthority
  readonly agentId?: string
}

/**
 * 解析本次调用的授权。
 * @param exec 工具执行元数据（本包侧可能只有 `agent.id`）
 * @param resolveAuthority 组合根注入的真人判定（缺省 = 保守的 autonomous）
 * @param expected 当前任务的授权三元组（给了就必须精确命中才授 autonomous）
 */
export function workToolExecution(
  exec: unknown,
  resolveAuthority?: (exec: unknown, expected?: WorkRoundRef) => WorkToolAuthority | undefined,
  expected?: WorkRoundRef,
): WorkToolExecution {
  const agent = (exec as { agent?: { id?: string } } | undefined)?.agent
  const granted = resolveAuthority?.(exec, expected)
  return {
    authority: granted ?? { kind: 'autonomous' },
    ...(typeof agent?.id === 'string' ? { agentId: agent.id } : {}),
  }
}

/** 真人专属动作：改目标（`edit`）、继续（`resume`）、人工确认（`stage_done`）。 */
const HUMAN_ONLY: ReadonlySet<WorkAuthorityAction> = new Set<WorkAuthorityAction>(['task_edit', 'task_resume', 'stage_done'])

/** 该动作在当前授权下是否放行（纯函数，可单测）。 */
export function isActionAuthorized(action: WorkAuthorityAction, authority: WorkToolAuthority): boolean {
  if (!HUMAN_ONLY.has(action)) return true
  return authority.kind === 'direct-human'
}

/** 放行判定；不放行则抛结构化错误（`WorkError`，机器可路由）。 */
export function requireActionAuthority(action: WorkAuthorityAction, authority: WorkToolAuthority): void {
  if (isActionAuthorized(action, authority)) return
  throw new WorkError(
    '`' + action + '` 需要人显式发起（agent 自行 ' + action + ' 会推翻人的意图或越权确认）'
    + '——请由人在宿主界面上确认，或由人直接调本工具',
    'WORK_NO_PERMISSION',
  )
}
