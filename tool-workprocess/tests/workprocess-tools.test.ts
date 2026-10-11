/**
 * tool-workprocess：登记表自洽 + 授权口径 + 处理器行为。
 *
 * 【守护什么】
 *   ① 登记表与处理器**同名可达**（漏登记/改名不留悬空引用），命名 = 宿主口径 `get/create/update_*`；
 *   ② 真人专属动作：`stage_done`（人工确认）、`task_edit`（改目标）、`task_resume`（改人的意图）；
 *   ③ 处理器的错误口径：内核错误如实转码（不吞不编），缺参 / 非法动词当场拒；
 *   ④ `changed:false` 必须带**内核给的原因**（幂等重放与"会被拒"分得清）。
 */
import { describe, it, expect } from 'vitest'
import * as tools from 'tool-workprocess'
import {
  WORK_TOOL_REGISTRY, authorityFromEvents, isActionAuthorized, requireActionAuthority,
  createWorkstage, createWorktask, getWorkstage, getWorktask, updateWorkstage, updateWorktask,
  type WorkToolDeps,
} from 'tool-workprocess'
import type { WorkRecordLike } from 'workprocess'
import { startWorkStage } from 'workprocess'

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

const STAGES = [
  { key: 'prep', statement: '准备数据', done_criteria: ['数据可用'] },
  { key: 'train', statement: '训练模型' },
]

describe('登记表自洽（两层 × get/create/update，命名对齐宿主 dsh）', () => {
  it('六个工具名动词在前；注册名唯一；处理器逐个存在', () => {
    expect(WORK_TOOL_REGISTRY.map((e) => e.toolName)).toEqual([
      'get_workstage', 'create_workstage', 'update_workstage',
      'get_worktask', 'create_worktask', 'update_worktask',
    ])
    expect(new Set(WORK_TOOL_REGISTRY.map((e) => e.toolName)).size).toBe(6)
    expect(WORK_TOOL_REGISTRY.filter((e) => e.layer === 'stage')).toHaveLength(3)
    expect(WORK_TOOL_REGISTRY.filter((e) => e.layer === 'task')).toHaveLength(3)
    for (const entry of WORK_TOOL_REGISTRY) {
      const handler = (tools as unknown as Record<string, unknown>)[entry.handler]
      expect(typeof handler, '处理器缺失：' + entry.handler).toBe('function')
    }
  })
})

describe('授权口径（对齐宿主 update 政策）', () => {
  it('真人专属 = stage_done（确认）+ task_edit（改目标）+ task_resume（改人的意图）', () => {
    for (const action of ['stage_done', 'task_edit', 'task_resume'] as const) {
      expect(isActionAuthorized(action, { kind: 'autonomous' })).toBe(false)
      expect(isActionAuthorized(action, { kind: 'direct-human' })).toBe(true)
    }
    for (const action of ['task_pause', 'task_block', 'task_complete', 'task_clear'] as const) {
      expect(isActionAuthorized(action, { kind: 'autonomous' })).toBe(true)
    }
  })

  it('越权时抛结构化错误（WORK_NO_PERMISSION，指路宿主界面）', () => {
    expect(() => requireActionAuthority('stage_done', { kind: 'autonomous' })).toThrowError(/需要人显式发起/)
    try {
      requireActionAuthority('task_resume', { kind: 'autonomous' })
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('WORK_NO_PERMISSION')
    }
  })

  it('authorityFromEvents：本轮人发言 / 精确命中的续跑回合 / 不匹配即无授权', () => {
    const expected = { taskId: 'wt:prep:1', revision: 2, round: 3 }
    const human = [{ type: 'user/message', data: { source: { kind: 'user' } } }]
    expect(authorityFromEvents(human, -1, true)).toEqual({ kind: 'direct-human' })
    expect(authorityFromEvents(human, -1, false)).toBeUndefined()

    const exact = [{ type: 'user/message', data: { source: { kind: 'work', taskId: 'wt:prep:1', revision: 2, round: 3 } } }]
    expect(authorityFromEvents(exact, -1, true, expected)).toEqual({ kind: 'autonomous' })
    const stale = [{ type: 'user/message', data: { source: { kind: 'work', taskId: 'wt:prep:1', revision: 1, round: 3 } } }]
    expect(authorityFromEvents(stale, -1, true, expected)).toBeUndefined()
    const other = [{ type: 'user/message', data: { source: { kind: 'work', taskId: 'wt:prep:9', revision: 2, round: 3 } } }]
    expect(authorityFromEvents(other, -1, true, expected)).toBeUndefined()
  })
})

describe('层1 处理器 · 阶段', () => {
  it('get_workstage：缺参 / 无流程（明说的缺失）/ 建好之后读到两层结构', async () => {
    const deps = depsOf({ 'ws-a': { updatedAt: 1 } })
    expect((await getWorkstage(deps, {})).error).toContain('缺少 scope')
    expect(await getWorkstage(deps, { scope: 'ws-a' })).toEqual({
      success: false, scope: 'ws-a', error: '该归属域还没有流程（先调 create_workstage 建流程）',
    })

    const created = await createWorkstage(deps, { scope: 'ws-a', objective: '把模型发上线', stages: STAGES })
    expect(created).toEqual({ success: true, scope: 'ws-a', created: true, changed: true })

    const got = await getWorkstage(deps, { scope: 'ws-a' })
    expect(got.success).toBe(true)
    expect(got.process_id).toBe('wp:ws-a')
    expect(got.current_stage).toBe('prep')
    expect(got.allows_start).toBe(true)
    expect(got.allows_close).toBe(false)
    expect(got.stages).toEqual([
      { key: 'prep', statement: '准备数据', state: 'pending', done_criteria: ['数据可用'], tasks: 0, tasks_done: 0 },
      { key: 'train', statement: '训练模型', state: 'pending', done_criteria: [], tasks: 0, tasks_done: 0 },
    ])
  })

  it('create_workstage：建流程要 objective；改阶段表时 changed:false 必须带内核给的原因', async () => {
    const deps = depsOf({ 'ws-a': { updatedAt: 1 } })
    expect((await createWorkstage(deps, { scope: 'ws-a', stages: STAGES })).error).toContain('objective')
    await createWorkstage(deps, { scope: 'ws-a', objective: 'x', stages: STAGES })

    const same = await createWorkstage(deps, { scope: 'ws-a', objective: 'x', stages: STAGES })
    expect(same).toEqual({ success: true, scope: 'ws-a', created: false, changed: false, reason: 'stage-define:idempotent-replay' })

    // 有任务的非空阶段被丢 → 内核拒，回执带原因（不是含混的 "changed:false"）
    const deps2 = depsOf({ 'ws-b': { updatedAt: 1 } })
    await createWorkstage(deps2, { scope: 'ws-b', objective: 'x', stages: STAGES })
    await createWorktask(deps2, { scope: 'ws-b', stage_key: 'prep', objective: '清洗数据' })
    const dropped = await createWorkstage(deps2, { scope: 'ws-b', stages: [{ key: 'train', statement: '训练模型' }] })
    expect(dropped.changed).toBe(false)
    expect(String(dropped.reason)).toContain('would-drop-tasks:prep')
  })

  it('update_workstage：只认 action=done；agent 越权被拒；由人确认也要过内核收口条件', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const agent = depsOf(records)
    const human = depsOf(records, true)
    await createWorkstage(agent, { scope: 'ws-a', objective: 'x', stages: STAGES })

    const badAction = await updateWorkstage(agent, { scope: 'ws-a', stage_key: 'prep', action: 'start' })
    expect(String(badAction.error)).toContain('阶段开工是驱动器的动作')

    const denied = await updateWorkstage(agent, { scope: 'ws-a', stage_key: 'prep', action: 'done' }, {})
    expect(denied.code).toBe('WORK_NO_PERMISSION')

    const notStarted = await updateWorkstage(human, { scope: 'ws-a', stage_key: 'prep', action: 'done' }, {})
    expect(notStarted.success).toBe(true)
    expect(String(notStarted.reason)).toContain('不是 active')

    await createWorktask(agent, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    await startWorkStage(agent, 'ws-a', 'prep')
    const openTask = await updateWorkstage(human, { scope: 'ws-a', stage_key: 'prep', action: 'done' }, {})
    expect(String(openTask.reason)).toContain('未全部 complete')

    // 任务真的完成了，由人确认才成立（agent 自写 done 那条路始终不存在）。
    expect((await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' })).changed).toBe(true)
    expect(await updateWorkstage(human, { scope: 'ws-a', stage_key: 'prep', action: 'done' }, {})).toEqual({
      success: true, scope: 'ws-a', stage_key: 'prep', action: 'done', changed: true,
    })
  })
})

describe('层2 处理器 · 任务', () => {
  async function seeded(human = false) {
    const records = { 'ws-a': { updatedAt: 1 } }
    const deps = depsOf(records, human)
    await createWorkstage(deps, { scope: 'ws-a', objective: '把模型发上线', stages: STAGES })
    await startWorkStage(deps, 'ws-a', 'prep')
    return deps
  }

  it('create_worktask：身份由内核分配，回执直接给 task_id', async () => {
    const deps = await seeded()
    const first = await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    expect(first.task_id).toBe('wt:prep:1')
    const second = await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep', objective: '对齐口径' })
    expect(second.task_id).toBe('wt:prep:2')

    const got = await getWorktask(deps, { scope: 'ws-a', stage_key: 'prep' })
    expect(got.tasks).toEqual([
      { id: 'wt:prep:1', stage_key: 'prep', objective: '清洗数据', phase: 'active', revision: 1 },
      { id: 'wt:prep:2', stage_key: 'prep', objective: '对齐口径', phase: 'active', revision: 1 },
    ])
  })

  it('create_worktask：缺 stage_key / objective 当场拒', async () => {
    const deps = await seeded()
    expect((await createWorktask(deps, { scope: 'ws-a', objective: 'x' })).error).toContain('stage_key')
    expect((await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep' })).error).toContain('objective')
  })

  it('update_worktask：动词白名单；edit/resume 真人专属；block 必须给原因', async () => {
    // 同一份记录上取两套授权（agent / 真人）：授权只影响放行，不改变状态。
    const records = { 'ws-a': { updatedAt: 1 } }
    const agent = depsOf(records)
    const human = depsOf(records, true)
    await createWorkstage(agent, { scope: 'ws-a', objective: '把模型发上线', stages: STAGES })
    await startWorkStage(agent, 'ws-a', 'prep')
    await createWorktask(agent, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })

    const bad = await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'finish' })
    expect(String(bad.error)).toContain('action 非法')
    expect((await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'resume' })).code).toBe('WORK_NO_PERMISSION')
    expect((await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'edit', objective: '改口径' })).code).toBe('WORK_NO_PERMISSION')

    // edit：至少要给一项；真人才放行。
    const empty = await updateWorktask(human, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'edit' })
    expect(String(empty.error)).toContain('至少要给一项')
    expect((await updateWorktask(human, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'edit', objective: '清洗并校验' })).changed).toBe(true)
    expect((await getWorktask(human, { scope: 'ws-a', task_id: 'wt:prep:1' })).tasks).toEqual([
      { id: 'wt:prep:1', stage_key: 'prep', objective: '清洗并校验', phase: 'active', revision: 2 },
    ])

    // 相位一：pause → resume（真人）——任务的相位机与内核逐条对齐。
    const paused = await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'pause' })
    expect(paused).toEqual({ success: true, scope: 'ws-a', task_id: 'wt:prep:1', action: 'pause', changed: true })
    expect((await updateWorktask(human, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'resume' })).changed).toBe(true)

    // 相位二：block 必须给原因，且原因码要 kebab-case（与严格解码器同口径）。
    const noReason = await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'block' })
    expect(String(noReason.error)).toContain('必须给原因')
    const badCode = await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'block', reason: '等人', reason_code: 'wait_human' })
    expect(String(badCode.error)).toContain('kebab-case')
    expect((await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'block', reason: '等人裁', reason_code: 'wait-human' })).changed).toBe(true)
  })

  it('update_worktask：CAS 用旧 revision 改 → WORK_CONFLICT；clear 后按 id 读不到', async () => {
    const deps = await seeded()
    await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    const conflict = await updateWorktask(deps, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'pause', revision: 1 })
    expect(conflict.code).toBe('WORK_CONFLICT')

    expect((await updateWorktask(deps, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'clear' })).changed).toBe(true)
    const missing = await getWorktask(deps, { scope: 'ws-a', task_id: 'wt:prep:1' })
    expect(String(missing.error)).toContain('任务不存在')
  })
})
