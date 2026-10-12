/**
 * 端到端：**按两层模型跑完一条三段流程**（走 `defineTool` 协议面，不是直接调内核）。
 *
 * 【这条用例证明什么】把 workprocess 当成真流程用一遍：
 *   建流程 → 逐阶段「开工 → 建任务 → 跑任务 → 由人确认」→ 串行门放行下一段 → 全部收口。
 * 单元用例钉的是单条判据；这条钉的是**判据串起来仍然自洽**（阶段态、任务态、串行门、
 * 人工确认、身份分配、越权拦截在一条真实操作序列里同时成立）。
 */
import { describe, it, expect } from 'vitest'
import { WORK_TOOL_REGISTRY } from 'tool-workprocess'
import { WORK_TOOL_FACTORIES } from 'tool-workprocess'
import type { WorkToolDeps } from 'tool-workprocess'
import type { WorkRecordLike, WorkStoreLike } from 'workprocess'
import { createWorkprocessService, startWorkStage } from 'workprocess'

interface ToolLike {
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>
}

function storeOf(records: Record<string, WorkRecordLike>) {
  return {
    get: async (scope: string) => records[scope],
    mutate: async (scope: string, fn: (draft: WorkRecordLike) => unknown) => {
      const record = records[scope]
      if (record === undefined) return { changed: false }
      const out = fn(record)
      return { changed: (out as { changed?: boolean } | undefined)?.changed === true }
    },
  }
}

/**
 * 测试依赖：工具面要的 `domain`（域服务）+ 直接落内核动作（如开工）要的 `store` / `now`。
 * 三者共享**同一个 store 实例**——域服务就是架在它上面的。
 */
type TestDeps = WorkToolDeps & { readonly store: WorkStoreLike; readonly now: () => number }

function depsOf(records: Record<string, WorkRecordLike>, human = false): TestDeps {
  const store = storeOf(records) as never
  const now = () => 1_000
  return {
    store, now,
    domain: createWorkprocessService({ store, now }),
    ...(human ? { resolveAuthority: () => ({ kind: 'direct-human' as const }) } : {}),
  }
}

function allTools(deps: WorkToolDeps): Record<string, ToolLike> {
  const out: Record<string, ToolLike> = {}
  for (const entry of WORK_TOOL_REGISTRY) {
    const factory = WORK_TOOL_FACTORIES[entry.handler as keyof typeof WORK_TOOL_FACTORIES]
    out[entry.handler] = factory(deps) as unknown as ToolLike
  }
  return out
}

const STAGES = [
  { key: 'prep', statement: '准备数据', done_criteria: ['数据可用'] },
  { key: 'train', statement: '训练模型', done_criteria: ['指标达标'] },
  { key: 'release', statement: '发布上线', done_criteria: ['线上可回滚'] },
]

describe('端到端 · 一条三段流程（两层模型）', () => {
  it('建流程 → 逐段开工/建任务/跑任务/由人确认 → 串行推进 → 全部收口', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const human = allTools(depsOf(records, true))
    const agent = allTools(depsOf(records))

    // ① 还没有流程：明说的缺失（不是空表）
    expect(await human.getWorkstage.execute({ scope: 'ws-a' })).toMatchObject({
      success: false, error: '该归属域还没有流程（先调 create_workstage 建流程）',
    })

    // ② 建流程：三段，初态全 pending、全无任务
    expect(await human.createWorkstage.execute({ scope: 'ws-a', objective: '把模型发上线', stages: STAGES }))
      .toMatchObject({ success: true, created: true, changed: true })
    const fresh = await human.getWorkstage.execute({ scope: 'ws-a' })
    expect(fresh).toMatchObject({ current_stage: 'prep', allows_start: true, allows_close: false })
    expect((fresh.stages as Array<{ state: string }>).map((s) => s.state)).toEqual(['pending', 'pending', 'pending'])

    // ③ 三道门在开工前就位：串行门（train 不是 active）／人工确认（agent 确认越权）／收口条件
    const trainEarly = await human.updateWorkstage.execute({ scope: 'ws-a', stage_key: 'train', action: 'done' })
    expect(String(trainEarly.reason)).toContain('不是 active')
    expect((await agent.updateWorkstage.execute({ scope: 'ws-a', stage_key: 'prep', action: 'done' })).code)
      .toBe('WORK_TOOL_AUTHORITY_REQUIRED')

    // ④ 逐阶段：开工（驱动器的动作）→ 建两个任务 → 一张完成还不许收口 → 两张都完成 → 由人确认
    for (const stage of ['prep', 'train', 'release']) {
      await startWorkStage(depsOf(records, true), 'ws-a', stage)

      const first = await human.createWorktask.execute({ scope: 'ws-a', stage_key: stage, objective: stage + '-任务1' })
      const second = await human.createWorktask.execute({ scope: 'ws-a', stage_key: stage, objective: stage + '-任务2' })
      expect(first.task_id).toBe('wt:' + stage + ':1')
      expect(second.task_id).toBe('wt:' + stage + ':2')

      await human.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:' + stage + ':1', action: 'complete' })
      const half = await human.updateWorkstage.execute({ scope: 'ws-a', stage_key: stage, action: 'done' })
      expect(String(half.reason)).toContain('未全部 complete')

      await human.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:' + stage + ':2', action: 'complete' })
      expect(await human.updateWorkstage.execute({ scope: 'ws-a', stage_key: stage, action: 'done' }))
        .toMatchObject({ success: true, action: 'done', changed: true })

      // 已收口的阶段不再接受新任务（编号也不复用）
      await human.createWorktask.execute({ scope: 'ws-a', stage_key: stage, objective: '补一张' })
      const tasks = await human.getWorktask.execute({ scope: 'ws-a', stage_key: stage })
      expect((tasks.tasks as unknown[]).length).toBe(2)
    }

    // ⑤ 全部收口：没有当前阶段，且具备收口条件
    const end = await human.getWorkstage.execute({ scope: 'ws-a' })
    expect(end).toMatchObject({ current_stage: null, allows_close: true })
    expect((end.stages as Array<{ state: string }>).map((s) => s.state)).toEqual(['done', 'done', 'done'])

    // ⑥ 整条流程里两层的写共用一个聚合 revision（每次都 +1），并可从回执读到
    expect(typeof end.revision).toBe('number')
    expect(end.revision as number).toBeGreaterThan(1)
  })

  it('阶段内多个任务并列：跑其中一个不影响另一张，全完才收口', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const human = allTools(depsOf(records, true))
    await human.createWorkstage.execute({ scope: 'ws-a', objective: 'x', stages: STAGES })
    await startWorkStage(depsOf(records, true), 'ws-a', 'prep')
    await human.createWorktask.execute({ scope: 'ws-a', stage_key: 'prep', objective: '任务1' })
    await human.createWorktask.execute({ scope: 'ws-a', stage_key: 'prep', objective: '任务2' })

    // 任务2 先完成、任务1 阻塞：阶段仍可收口吗？——不行（有非 complete 的任务）
    await human.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:2', action: 'complete' })
    await human.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:1', action: 'block', reason: '等上游数据' })
    const blocked = await human.updateWorkstage.execute({ scope: 'ws-a', stage_key: 'prep', action: 'done' })
    expect(String(blocked.reason)).toContain('未全部 complete')

    // 相位如实回读：任务1 确实 block 住了（`changed:false` 不是"悄悄改了"）
    const before = await human.getWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:1' })
    expect((before.tasks as Array<{ phase: string }>)[0].phase).toBe('blocked')

    // 解阻（真人 resume）→ 完成 → 收口
    expect((await human.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:1', action: 'resume' })).changed).toBe(true)
    await human.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' })
    expect(await human.updateWorkstage.execute({ scope: 'ws-a', stage_key: 'prep', action: 'done' }))
      .toMatchObject({ success: true, changed: true })
  })
})
