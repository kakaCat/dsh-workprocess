/**
 * tool-workprocess：登记表自洽 + 授权口径 + 处理器行为。
 *
 * 【守护什么】
 *   ① 登记表与处理器**同名可达**（漏登记/改名不留悬空引用），命名 = 宿主口径 `get/create/update_*`；
 *   ② 真人专属动作：`task_edit`（改目标）、`task_resume`（改人的意图）恒为真人专属；
 *      `stage_done`（收口）按**目标阶段的收口策略**判——`human` 真人专属、`auto` 放行自治；
 *   ③ 处理器的错误口径：内核错误如实转码（不吞不编），缺参 / 非法动词当场拒；
 *   ④ `changed:false` 必须带**内核给的原因**（幂等重放与"会被拒"分得清）。
 */
import { describe, it, expect } from 'vitest'
import * as tools from 'tool-workprocess'
import {
  WORK_TOOL_REGISTRY, authorityFromEvents, isActionAuthorized, requireActionAuthority,
  createWorkstage, createWorktask, getWorkstage, getWorktask, updateWorkstage, updateWorktask,
  type WorkToolDeps, type WorkHumanVerdict,
} from 'tool-workprocess'
import type { WorkRecordLike, WorkStoreLike } from 'workprocess'
import { createWorkprocessService, startWorkStage } from 'workprocess'

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
  it('缺省策略（human）下：stage_done（收口确认）+ task_edit / process_edit（改目标）+ task_resume（改人的意图）+ process_discard（撤流程）+ process_arm（放行/收回续跑）都是真人专属', () => {
    for (const action of ['stage_done', 'task_edit', 'process_edit', 'task_resume', 'process_discard', 'process_arm'] as const) {
      expect(isActionAuthorized(action, { kind: 'autonomous' })).toBe(false)
      expect(isActionAuthorized(action, { kind: 'direct-human' })).toBe(true)
    }
    for (const action of ['task_pause', 'task_block', 'task_complete', 'task_clear'] as const) {
      expect(isActionAuthorized(action, { kind: 'autonomous' })).toBe(true)
    }
  })

  it('越权时抛结构化错误（WORK_NO_PERMISSION，指路宿主界面 / 策略开关）', () => {
    expect(() => requireActionAuthority('stage_done', { kind: 'autonomous' }))
      .toThrowError(/本阶段收口策略是 `human`/)
    expect(() => requireActionAuthority('stage_done', { kind: 'autonomous' }, { stageClosePolicy: 'auto' })).not.toThrow()
    try {
      requireActionAuthority('task_resume', { kind: 'autonomous' })
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('WORK_NO_PERMISSION')
    }
  })

  it('stage_done 的授权按**目标阶段**的收口策略判：human 真人专属；auto 放行自治（不缺上下文就按保守侧）', () => {
    expect(isActionAuthorized('stage_done', { kind: 'autonomous' }, { stageClosePolicy: 'human' })).toBe(false)
    expect(isActionAuthorized('stage_done', { kind: 'autonomous' }, { stageClosePolicy: 'auto' })).toBe(true)
    // 策略缺省 = human：拿不准就别放行自治（与内核的缺省口径同源）。
    expect(isActionAuthorized('stage_done', { kind: 'autonomous' })).toBe(false)
    expect(isActionAuthorized('stage_done', { kind: 'autonomous' }, {})).toBe(false)
    // 收口策略不改变其余真人专属动作：edit / resume / 丢流程永远要人直接发起。
    for (const action of ['task_edit', 'process_edit', 'task_resume', 'process_discard'] as const) {
      expect(isActionAuthorized(action, { kind: 'autonomous' }, { stageClosePolicy: 'auto' })).toBe(false)
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
    expect(created).toMatchObject({ success: true, scope: 'ws-a', created: true, changed: true })
    // 回执自带"下一步归谁"：开工是驱动器的动作（模型不该去找开工动词）
    expect(created).toMatchObject({ current_stage: 'prep', allows_start: true })
    expect(String(created.next_step)).toContain('驱动器')

    const got = await getWorkstage(deps, { scope: 'ws-a' })
    expect(got.success).toBe(true)
    expect(got.process_id).toBe('wp:ws-a')
    expect(got.current_stage).toBe('prep')
    expect(got.allows_start).toBe(true)
    expect(got.allows_close).toBe(false)
    expect(got.stages).toEqual([
      { key: 'prep', statement: '准备数据', state: 'pending', done_criteria: ['数据可用'], close_policy: 'human', tasks: 0, tasks_done: 0 },
      { key: 'train', statement: '训练模型', state: 'pending', done_criteria: [], close_policy: 'human', tasks: 0, tasks_done: 0 },
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
      success: true, scope: 'ws-a', stage_key: 'prep', action: 'done', close_policy: 'human', changed: true,
    })
  })

  it('阶段收口策略：human（缺省）= 真人专属；auto = 自治回合也放行；非法值不静默当缺省', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const agent = depsOf(records)
    const badStages = [{ key: 'prep', statement: '准备数据', close_policy: 'always' }]
    expect(String((await createWorkstage(agent, { scope: 'ws-a', objective: 'x', stages: badStages })).error))
      .toContain('只认 human / auto')

    await createWorkstage(agent, {
      scope: 'ws-a', objective: 'x',
      stages: [{ key: 'prep', statement: '准备数据', close_policy: 'auto' }, { key: 'train', statement: '训练模型' }],
    })
    const got = await getWorkstage(agent, { scope: 'ws-a' })
    expect((got.stages as Array<{ close_policy: string }>).map((s) => s.close_policy)).toEqual(['auto', 'human'])

    await createWorktask(agent, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    await startWorkStage(agent, 'ws-a', 'prep')
    // 判据没齐时 auto 也不放行：策略只决定"谁有权落"，不决定"够不够格落"。
    expect(String((await updateWorkstage(agent, { scope: 'ws-a', stage_key: 'prep', action: 'done' })).reason))
      .toContain('未全部 complete')
    await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' })
    expect(await updateWorkstage(agent, { scope: 'ws-a', stage_key: 'prep', action: 'done' })).toEqual({
      success: true, scope: 'ws-a', stage_key: 'prep', action: 'done', close_policy: 'auto', changed: true,
    })

    // 策略按**阶段**读（不是全局开关）：下一段缺省 human，agent 自写照样被拒。
    await createWorktask(agent, { scope: 'ws-a', stage_key: 'train', objective: '调参' })
    await startWorkStage(agent, 'ws-a', 'train')
    await updateWorktask(agent, { scope: 'ws-a', task_id: 'wt:train:1', action: 'complete' })
    const denied = await updateWorkstage(agent, { scope: 'ws-a', stage_key: 'train', action: 'done' })
    expect(denied.code).toBe('WORK_NO_PERMISSION')
    expect(String(denied.error)).toContain('close_policy')
  })

  it('action=discard：丢整条流程（真人专属；幂等；不需要 stage_key）', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const agent = depsOf(records)
    const human = depsOf(records, true)
    await createWorkstage(agent, { scope: 'ws-a', objective: '误建的流程', stages: STAGES })
    await createWorktask(agent, { scope: 'ws-a', stage_key: 'prep', objective: '误建的任务' })

    // 自撤流程 = 越权：会抹掉"这里曾经有一条流程"这段历史
    const denied = await updateWorkstage(agent, { scope: 'ws-a', action: 'discard' })
    expect(denied.code).toBe('WORK_NO_PERMISSION')
    expect(String(denied.error)).toContain('不可逆')

    // 人删：不需要 stage_key；删完读不到流程（明说的缺失）
    expect(await updateWorkstage(human, { scope: 'ws-a', action: 'discard' }))
      .toEqual({ success: true, scope: 'ws-a', action: 'discard', changed: true })
    expect(await getWorkstage(agent, { scope: 'ws-a' }))
      .toMatchObject({ success: false, error: '该归属域还没有流程（先调 create_workstage 建流程）' })

    // 幂等：没有流程 ⇒ 零写入（changed:false，不报错）
    expect(await updateWorkstage(human, { scope: 'ws-a', action: 'discard' }))
      .toEqual({ success: true, scope: 'ws-a', action: 'discard', changed: false })

    // 再建是**新**流程（revision 1），不是复活
    await createWorkstage(agent, { scope: 'ws-a', objective: '重来', stages: STAGES })
    expect((await getWorkstage(agent, { scope: 'ws-a' })).revision).toBe(1)
  })

  it('action=edit：改流程目标（真人专属；阶段与任务原样保留；幂等；要 objective）', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const agent = depsOf(records)
    const human = depsOf(records, true)
    await createWorkstage(agent, { scope: 'ws-a', objective: '把模型发上线', stages: STAGES })
    await createWorktask(agent, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })

    // agent 自行改目标 = 越权：改的是"这条流程要达成什么"
    const denied = await updateWorkstage(agent, { scope: 'ws-a', action: 'edit', objective: '顺手改成别的' })
    expect(denied.code).toBe('WORK_NO_PERMISSION')
    expect(String(denied.error)).toContain('改流程目标')

    // 缺 objective 当场拒（不静默当"没变"）
    expect(String((await updateWorkstage(human, { scope: 'ws-a', action: 'edit' })).error))
      .toContain('edit 需要 objective')

    // 人改：目标换掉，阶段与任务原样保留（不是丢弃重来）
    expect(await updateWorkstage(human, { scope: 'ws-a', action: 'edit', objective: '把模型发上线（v2）' }))
      .toEqual({ success: true, scope: 'ws-a', action: 'edit', objective: '把模型发上线（v2）', changed: true })
    const after = await getWorkstage(agent, { scope: 'ws-a' })
    expect(after.objective).toBe('把模型发上线（v2）')
    expect((after.stages as Array<{ key: string }>).map((s) => s.key)).toEqual(['prep', 'train'])
    expect((await getWorktask(agent, { scope: 'ws-a', stage_key: 'prep' })).tasks).toHaveLength(1)

    // 幂等：同值重放零写入，且不需要 stage_key
    expect(await updateWorkstage(human, { scope: 'ws-a', action: 'edit', objective: '把模型发上线（v2）' }))
      .toEqual({ success: true, scope: 'ws-a', action: 'edit', objective: '把模型发上线（v2）', changed: false })
  })

  it('action 非法 / done 缺 stage_key：当场拒并说明（edit / discard 不需要 stage_key）', async () => {
    const deps = depsOf({ 'ws-a': { updatedAt: 1 } }, true)
    await createWorkstage(deps, { scope: 'ws-a', objective: 'x', stages: STAGES })
    expect(String((await updateWorkstage(deps, { scope: 'ws-a', stage_key: 'prep', action: 'start' })).error))
      .toContain('阶段开工是驱动器的动作')
    expect(String((await updateWorkstage(deps, { scope: 'ws-a', action: 'done' })).error)).toContain('缺少 stage_key')
  })
})

describe('人机确认（工具自己问人：对齐宿主 plan-mode 的 exit 工具）', () => {
  /** 造一条"任务全达成、策略 human、且本轮不是人发起"的流程，并挂上假弹框。 */
  async function seededAsk(verdict: WorkHumanVerdict) {
    const base = depsOf({ 'ws-a': { updatedAt: 1 } })          // human=false ⇒ 本轮自治
    const asks: Array<{ id: string; detail?: string; approve: string }> = []
    const deps = {
      ...base,
      askHuman: async (_e: unknown, request: { id: string; detail?: string; approve: string }) => {
        asks.push(request)
        return verdict
      },
    }
    await createWorkstage(deps, { scope: 'ws-a', objective: 'x', stages: STAGES })
    await startWorkStage(deps, 'ws-a', 'prep')
    await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    await updateWorktask(deps, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' })
    return { deps, asks }
  }

  it('人确认 ⇒ 落章（弹框里问清阶段与判据；不靠模型转述）', async () => {
    const { deps, asks } = await seededAsk({ kind: 'approved' })
    const out = await updateWorkstage(deps, { scope: 'ws-a', stage_key: 'prep', action: 'done' })
    expect(out).toMatchObject({ success: true, changed: true, close_policy: 'human' })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ id: 'workprocess-stage-done:prep', approve: '确认收口' })
    expect(String(asks[0].detail)).toContain('清洗数据')          // 给人复核的是任务清单
    expect(((await getWorkstage(deps, { scope: 'ws-a' })).stages as Array<{ state: string }>)[0]).toMatchObject({ state: 'done' })
  })

  it('人选「还要补做」⇒ 不收口，把人的话转达给模型', async () => {
    const { deps } = await seededAsk({ kind: 'declined', feedback: '还要加触控' })
    const out = await updateWorkstage(deps, { scope: 'ws-a', stage_key: 'prep', action: 'done' })
    expect(out.code).toBe('WORK_HUMAN_DECLINED')
    expect(String(out.error)).toContain('还要加触控')
    expect(((await getWorkstage(deps, { scope: 'ws-a' })).stages as Array<{ state: string }>)[0]).toMatchObject({ state: 'active' })
  })

  it('人打断了去说话 ⇒ 不收口，也不当成同意', async () => {
    const { deps } = await seededAsk({ kind: 'cancelled', reason: 'ASK_CANCELLED' })
    const out = await updateWorkstage(deps, { scope: 'ws-a', stage_key: 'prep', action: 'done' })
    expect(out.code).toBe('WORK_HUMAN_UNAVAILABLE')
    expect(((await getWorkstage(deps, { scope: 'ws-a' })).stages as Array<{ state: string }>)[0]).toMatchObject({ state: 'active' })
  })

  it('没弹框通道 ⇒ 退回原来的"拒绝并指路"（不假装问过）', async () => {
    const { deps } = await seededAsk({ kind: 'no-channel' })
    const out = await updateWorkstage(deps, { scope: 'ws-a', stage_key: 'prep', action: 'done' })
    expect(out.code).toBe('WORK_NO_PERMISSION')
    expect(String(out.error)).toContain('close_policy')
  })

  it('阶段还不能收口（任务没做完）⇒ 不去打扰人，直接说清原因', async () => {
    const base = depsOf({ 'ws-a': { updatedAt: 1 } })
    let asked = 0
    const deps = { ...base, askHuman: async (): Promise<WorkHumanVerdict> => { asked += 1; return { kind: 'approved' } } }
    await createWorkstage(deps, { scope: 'ws-a', objective: 'x', stages: STAGES })
    await startWorkStage(deps, 'ws-a', 'prep')
    await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    const out = await updateWorkstage(deps, { scope: 'ws-a', stage_key: 'prep', action: 'done' })
    expect(out.code).toBe('WORK_NO_PERMISSION')      // 先判权：越权者不因为"没做完"拿到别的口径
    expect(asked).toBe(0)
  })
})

describe('工具通告（deferContext 适配：把"下一步"说在决策点上）', () => {
  /** 收集通告的 deps（模拟组合根接上的 deferNotice）。 */
  function noticedDeps(human = false) {
    const notices: Array<{ summary: string; text: string }> = []
    const deps = { ...depsOf({ 'ws-a': { updatedAt: 1 } }, human), deferNotice: (_e: unknown, n: { summary: string; text: string }) => { notices.push(n) } }
    return { deps, notices }
  }

  it('task-complete 发出收尾通告（到此为止 / 别开新任务 / 别自己收口）', async () => {
    const { deps, notices } = noticedDeps()
    await createWorkstage(deps, { scope: 'ws-a', objective: 'x', stages: STAGES })
    await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    expect(notices).toHaveLength(0)                       // 建任务不发通告
    await updateWorktask(deps, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' })
    expect(notices).toHaveLength(1)
    expect(notices[0].summary).toContain('task-complete: wt:prep:1')
    expect(notices[0].text).toContain('到此为止')
    expect(notices[0].text).toContain('不要顺手开新任务')
  })

  it('幂等重放（changed:false）不发通告：没发生的事不该被说成发生了', async () => {
    const { deps, notices } = noticedDeps()
    await createWorkstage(deps, { scope: 'ws-a', objective: 'x', stages: STAGES })
    await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    await updateWorktask(deps, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' })
    notices.length = 0
    await updateWorktask(deps, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' })
    expect(notices).toHaveLength(0)
  })

  it('stage-done / discard 各有收尾通告（说清"下一段归驱动器"与"不可逆"）', async () => {
    const { deps, notices } = noticedDeps(true)
    await createWorkstage(deps, { scope: 'ws-a', objective: 'x', stages: STAGES })
    await startWorkStage(deps, 'ws-a', 'prep')            // 开工是驱动器的动作，测试里直接落
    await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    await updateWorktask(deps, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' })
    notices.length = 0
    await updateWorkstage(deps, { scope: 'ws-a', stage_key: 'prep', action: 'done' })
    expect(notices[0].text).toContain('下一阶段由驱动器')
    notices.length = 0
    await updateWorkstage(deps, { scope: 'ws-a', action: 'discard' })
    expect(notices[0].text).toContain('不可逆')
  })

  it('没接通告口（缺省）⇒ 一个字节都不发，工具照常成功', async () => {
    const deps = depsOf({ 'ws-a': { updatedAt: 1 } })
    await createWorkstage(deps, { scope: 'ws-a', objective: 'x', stages: STAGES })
    await createWorktask(deps, { scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    expect(await updateWorktask(deps, { scope: 'ws-a', task_id: 'wt:prep:1', action: 'complete' }))
      .toMatchObject({ success: true, changed: true })
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

describe('续跑许可（工具面：arm / disarm + get_workstage 显示）', () => {
  it('真人可 disarm / arm；agent 自发起一律被拒（自签通行证）', async () => {
    const records: Record<string, WorkRecordLike> = { 'ws-a': { updatedAt: 1 } }
    const human = depsOf(records, true)
    const agent = depsOf(records)
    const built = tools.createWorkstage(human, { scope: 'ws-a', objective: '把模型发上线', stages: [{ key: 'prep', statement: '准备' }] })
    await built
    const update = (args: Record<string, unknown>) => tools.updateWorkstage(human, args)
    const agentUpdate = (args: Record<string, unknown>) => tools.updateWorkstage(agent, args)

    // 自治回合：即便流程在那儿，也不许自己把许可收回去或放回来（都是"改人的意图"一类）。
    await expect(agentUpdate({ action: 'disarm' })).resolves.toMatchObject({ success: false })
    await expect(agentUpdate({ action: 'arm' })).resolves.toMatchObject({ success: false })

    // 真人：disarm 收许可（幂等第二次 changed:false）→ get_workstage 如实显示。
    const off = await update({ scope: 'ws-a', action: 'disarm' })
    expect(off).toMatchObject({ success: true, action: 'disarm', activation: 'disarmed', changed: true })
    expect(await update({ scope: 'ws-a', action: 'disarm' })).toMatchObject({ changed: false })
    expect(await tools.getWorkstage(human, { scope: 'ws-a' })).toMatchObject({ success: true, activation: 'disarmed' })

    // 人说"继续" ⇒ arm 放回去。
    expect(await update({ scope: 'ws-a', action: 'arm' })).toMatchObject({ success: true, activation: 'armed', changed: true })
    expect(await tools.getWorkstage(human, { scope: 'ws-a' })).toMatchObject({ activation: 'armed' })
  })
})
