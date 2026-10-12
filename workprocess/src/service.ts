/**
 * `ctx.workprocess` 服务面（**给别的插件消费**的那一层，与宿主 `ctx.goals` 同形）。
 *
 * 【为什么要它】命令行（`dsh-command-workprocess`）是**独立包**、独立装载行：它不该自己开存储域
 * （`storageDomain.open` 对同一个域名"已经打开"是**响亮拒绝**的，两个插件各开一次必撞），
 * 也不该绕过内核直接改状态。所以本插件把"读/干预"做成服务提供出去，命令包只消费。
 *
 * 【口径】动作都按 `agent` 定位（`agent.session.id` = 归属域），与 `ctx.goals.get(agent)` 同款；
 * 命令天然由人发起，故 `discard` / `resumePaused` 这类真人专属动作在这一层是合法的。
 *
 * @module workprocess/service
 */
import {
  currentStageOf, discardWorkProcess, pauseWorkTask, resumeWorkTask, workProcessOf,
} from './kernel.js'
import type { WorkStage, WorkStoreLike } from './kernel.js'

/** 会话的最小读取面（与 authority/message 同源的窄类型）。 */
interface AgentLike { readonly session?: { readonly id?: string } }

/** 命令/看板要读的流程概览（够排版即可；没有 ⇒ undefined）。 */
export interface WorkprocessStatus {
  readonly objective: string
  readonly stages: readonly WorkStage[]
  /** 当前阶段（全阶段 done ⇒ 缺省）。 */
  readonly currentStageKey?: string
  /** 已准入回合数（耐久在归属记录里）。 */
  readonly roundsStarted: number
  /** 流程收口时间戳（缺省 = 未收口）：已收口的流程一切写被内核拒。 */
  readonly closedAt?: number
  /** 当前阶段首个任务生效的回合上限（没写 max_rounds ⇒ 缺省不展示）。 */
  readonly maxRounds?: number
}

/** `ctx.workprocess`：读 + 人可做的三种干预。 */
export interface WorkprocessService {
  /** 读该 agent 会话的流程概览（没有流程 ⇒ undefined；缺失 ≠ 空）。 */
  view(agent: unknown): Promise<WorkprocessStatus | undefined>
  /** 丢弃整条流程（幂等：没有流程 ⇒ false）。 */
  discard(agent: unknown): Promise<boolean>
  /** 暂停**当前阶段**的活动任务；返回被暂停的任务 id。 */
  pauseActive(agent: unknown): Promise<readonly string[]>
  /** 恢复当前阶段被暂停的任务；返回被恢复的任务 id。 */
  resumePaused(agent: unknown): Promise<readonly string[]>
}

/** 归属域键 = 调用者会话（命令与动作都挂在这条会话上）。 */
function scopeOfAgent(agent: unknown): string | undefined {
  const id = (agent as AgentLike | undefined)?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** 造服务面（组合根唯一实例：与打开的那个存储域同源）。
 * @param onCleared 整条流程被丢弃时的墓碑通知（组合根接到宿主 `work/changed`，change = undefined）。
 */
export function createWorkprocessService(
  store: WorkStoreLike, onCleared?: (scope: string) => void,
): WorkprocessService {
  const now = (): number => Date.now()
  const stageOf = async (scope: string) => {
    const process = await workProcessOf({ store }, scope)
    return process === undefined ? undefined : { process, stage: currentStageOf(process) }
  }
  const pauseOrResume = async (scope: string, from: 'active' | 'paused'): Promise<readonly string[]> => {
    const found = await stageOf(scope)
    if (found?.stage === undefined) return []
    const targets = found.stage.tasks.filter((t) => t.phase === from)
    const moved: string[] = []
    for (const task of targets) {
      const changed = from === 'active'
        ? await pauseWorkTask({ store, now }, scope, task.id)
        : await resumeWorkTask({ store, now }, scope, task.id)
      if (changed) moved.push(task.id)
    }
    return moved
  }
  return {
    async view(agent) {
      const scope = scopeOfAgent(agent)
      if (scope === undefined) return undefined
      const found = await stageOf(scope)
      if (found === undefined) return undefined
      const cap = found.stage?.tasks[0]?.maxRounds
      return {
        objective: found.process.objective,
        stages: found.process.stages,
        ...(found.stage === undefined ? {} : { currentStageKey: found.stage.key }),
        roundsStarted: (await store.get(scope))?.rounds?.started ?? 0,
        ...(cap === undefined ? {} : { maxRounds: cap }),
        ...(found.process.closedAt === undefined ? {} : { closedAt: found.process.closedAt }),
      }
    },
    async discard(agent) {
      const scope = scopeOfAgent(agent)
      if (scope === undefined) return false
      const changed = await discardWorkProcess({ store, now }, scope)
      if (changed) onCleared?.(scope)
      return changed
    },
    async pauseActive(agent) {
      const scope = scopeOfAgent(agent)
      return scope === undefined ? [] : pauseOrResume(scope, 'active')
    },
    async resumePaused(agent) {
      const scope = scopeOfAgent(agent)
      return scope === undefined ? [] : pauseOrResume(scope, 'paused')
    },
  }
}
