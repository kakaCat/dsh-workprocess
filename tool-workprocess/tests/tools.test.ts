/**
 * tool-workprocess · 工具壳（`defineTool` 协议面）。
 *
 * 【守护什么】
 *   ① 登记表是唯一手写清单：工厂键集合 == 登记表的 `handler` 集合，且**名字与自述逐字取自上表**
 *      （改一处忘另一处即红）；
 *   ② 协议面真的通：`execute` 从建流程一路走到由人确认，回执字段与处理器同源；
 *   ③ 真人专属动作在**协议面**也被拦（不是只在处理器里拦）。
 */
import { describe, it, expect } from 'vitest'
import { WORK_TOOL_REGISTRY } from 'tool-workprocess/registry.js'
import { WORK_TOOL_FACTORIES } from 'tool-workprocess'
import type { WorkToolDeps } from 'tool-workprocess'
import type { WorkRecordLike } from 'workprocess'
import { startWorkStage } from 'workprocess'

interface ToolLike {
  name?: string
  description?: string
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>
}

function storeOf(records: Record<string, WorkRecordLike>) {
  return {
    records,
    get: async (scope: string) => records[scope],
    mutate: async (scope: string, fn: (draft: WorkRecordLike) => unknown) => {
      const record = records[scope]
      if (record === undefined) return { changed: false }
      const out = fn(record)
      return { changed: (out as { changed?: boolean } | undefined)?.changed === true }
    },
  }
}

function depsOf(records: Record<string, WorkRecordLike>, human = false): WorkToolDeps {
  return {
    store: storeOf(records) as never,
    now: () => 1_000,
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

const STAGES = [{ key: 'prep', statement: '准备数据', done_criteria: ['数据可用'] }, { key: 'train', statement: '训练模型' }]

describe('工具壳 · 与登记表同源', () => {
  it('工厂键集合 == 登记表 handler 集合；名字与自述逐字一致', () => {
    expect(Object.keys(WORK_TOOL_FACTORIES).sort()).toEqual(WORK_TOOL_REGISTRY.map((e) => e.handler).sort())
    const tools = allTools(depsOf({ 'ws-a': { updatedAt: 1 } }))
    for (const entry of WORK_TOOL_REGISTRY) {
      expect(tools[entry.handler].name).toBe(entry.toolName)
      expect(tools[entry.handler].description).toBe(entry.description)
    }
  })
})

describe('工具壳 · 协议面走通', () => {
  it('建流程 → 读阶段 → 建任务 → 完成任务 → 由人确认（update 的 action 形状）', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const human = allTools(depsOf(records, true))

    const created = await human.createWorkstage.execute({ scope: 'ws-a', objective: '把模型发上线', stages: STAGES })
    expect(created).toMatchObject({ success: true, created: true, changed: true })

    const got = await human.getWorkstage.execute({ scope: 'ws-a' })
    expect(got).toMatchObject({ success: true, current_stage: 'prep', allows_start: true, allows_close: false })

    const task = await human.createWorktask.execute({ scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    expect(task).toMatchObject({ success: true, task_id: 'wt:prep:1' })

    // 阶段还没开工：由人确认也要过内核的收口条件（理由要说清，不是含混的"没变"）
    const notStarted = await human.updateWorkstage.execute({ scope: 'ws-a', stage_key: 'prep', action: 'done' })
    expect(String(notStarted.reason)).toContain('不是 active')

    // **开工是驱动器的动作**（decision `start-stage`），工具面刻意不暴露——这里直接用内核开工。
    await startWorkStage(depsOf(records, true), 'ws-a', 'prep')

    expect((await human.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' })).changed).toBe(true)
    expect(await human.updateWorkstage.execute({ scope: 'ws-a', stage_key: 'prep', action: 'done' }))
      .toMatchObject({ success: true, action: 'done', changed: true })

    // 阶段收口后，串行门放行下一阶段
    const after = await human.getWorkstage.execute({ scope: 'ws-a' })
    expect(after.current_stage).toBe('train')
    expect(after.allows_start).toBe(true)
  })

  it('真人专属动作在协议面也被拦（stage_done / task_edit / task_resume）', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const agent = allTools(depsOf(records))
    await agent.createWorkstage.execute({ scope: 'ws-a', objective: 'x', stages: STAGES })
    await agent.createWorktask.execute({ scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })

    expect((await agent.updateWorkstage.execute({ scope: 'ws-a', stage_key: 'prep', action: 'done' })).code).toBe('WORK_NO_PERMISSION')
    expect((await agent.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:1', action: 'resume' })).code).toBe('WORK_NO_PERMISSION')
    expect((await agent.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:1', action: 'edit', objective: 'x' })).code).toBe('WORK_NO_PERMISSION')
  })
})
