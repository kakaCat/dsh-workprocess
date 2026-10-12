/**
 * workprocess 内核：**两层模型**的行为钉死（层1 workStage 串行分组 / 层2 workTask = 宿主 goal 语义）。
 *
 * 【守护什么（任一被回退即红）】
 *   ① 结构：一个阶段装多个任务（层1 是"一组任务的集合"，不是"一个任务"）；
 *   ② **串行门**：前序阶段全部 done 才允许下一阶段开工；阶段收口要求任务非空且全 complete；
 *   ③ 层2 相位机与宿主 goal 同构：complete 是终态、block 必须带结构化原因、幂等重放零写入；
 *   ④ 身份：任务编号 `wt:<stage>:<seq>` 在 clear 后**不复用**（墓碑守）；
 *   ⑤ 聚合 CAS：两层的写共用一个 revision；记录的快照必须与事件重算逐字段一致。
 */
import { describe, it, expect } from 'vitest'
import type { WorkChange, WorkEvent } from 'workprocess/domain.js'
import { applyWorkEvent, checkWorkInvariants, decodeWorkEvent, decodeWorkProcess, foldWorkProcess, processAllowsClose, sameProcess, workProgressOf } from 'workprocess/fold.js'
import { WorkError } from 'workprocess/runtime.js'
import type { WorkProcess, WorkStageDraft } from 'workprocess/types.js'
import {
  clearWorkTask, closeWorkProcess, completeWorkStage, completeWorkTask, createWorkProcess, createWorkTask,
  defineWorkStages, discardWorkProcess, editWorkObjective, markWorkAsked, progressOf, setWorkActivation,
  stageClosePolicyOf, startWorkStage, workActivationOf, workAskedOf, workProcessOf, workProcessViewOf, workTaskOf,
  type WorkRecordLike,
} from 'workprocess'

const STAGES: readonly WorkStageDraft[] = [
  { key: 'prep', statement: '准备数据', doneCriteria: ['数据可用'] },
  { key: 'train', statement: '训练模型' },
  { key: 'release', statement: '发布上线' },
]

const INIT: WorkEvent = { kind: 'init', id: 'wp:ws-a', objective: '把模型发上线', stages: STAGES }

/** 从 init 事件折出一个流程（多数用例的起点）。 */
function initProcess(): WorkProcess {
  const r = applyWorkEvent(undefined, INIT)
  if (!r.changed || r.next === undefined) throw new Error('夹具失败：init 未成立')
  return r.next
}

/** 一条耐久变更（事件 + 结果快照）：折叠/解码用例的手工构造入口。 */
function change(event: WorkEvent, process: WorkProcess): WorkChange {
  return { kind: 'work/change', version: 1, event, process }
}

/** 走一遍"建任务 → 完成"的便捷折线（返回最新快照）。 */
function apply(process: WorkProcess, event: WorkEvent): WorkProcess {
  const r = applyWorkEvent(process, event)
  if (!r.changed || r.next === undefined) throw new Error('夹具失败：事件未成立（' + event.kind + '：' + r.reason + '）')
  return r.next
}

describe('两层结构 · init', () => {
  it('建流程：阶段表初值全 pending、无任务、revision=1', () => {
    const p = initProcess()
    expect(p.id).toBe('wp:ws-a')
    expect(p.revision).toBe(1)
    expect(p.stages.map((s) => [s.key, s.state, s.tasks.length])).toEqual([
      ['prep', 'pending', 0], ['train', 'pending', 0], ['release', 'pending', 0],
    ])
  })

  it('幂等：同 id + 同陈述 + 同阶段表重放 → 零写入', () => {
    const r = applyWorkEvent(initProcess(), INIT)
    expect(r.changed).toBe(false)
    expect(r.reason).toBe('init:idempotent-replay')
  })

  it('身份冲突：同一 id 想建成另一条流程 → 零写入', () => {
    const r = applyWorkEvent(initProcess(), { ...INIT, objective: '换了目标' })
    expect(r.changed).toBe(false)
    expect(r.reason).toBe('init:identity-conflict')
  })

  it('阶段定义非法（重复键 / 空 statement）→ 零写入，不静默丢一段', () => {
    const dup = applyWorkEvent(undefined, { kind: 'init', id: 'wp:ws-b', objective: 'x', stages: [STAGES[0], STAGES[0]] })
    expect(dup.changed).toBe(false)
    expect(dup.reason).toContain('阶段键重复')
    const empty = applyWorkEvent(undefined, { kind: 'init', id: 'wp:ws-b', objective: 'x', stages: [{ key: 'a', statement: '  ' }] })
    expect(empty.changed).toBe(false)
    expect(empty.reason).toContain('statement')
  })
})

describe('串行门 · 阶段之间串行（一个阶段装多个任务）', () => {
  it('前序阶段未 done 时，后一阶段不许开工', () => {
    const p = initProcess()
    const r = applyWorkEvent(p, { kind: 'stage-start', stageKey: 'train' })
    expect(r.changed).toBe(false)
    expect(r.reason).toBe('stage-start:serial-blocked')
  })

  it('阶段开工 → active；已开工再开工零写入', () => {
    const p = apply(initProcess(), { kind: 'stage-start', stageKey: 'prep' })
    expect(p.stages[0].state).toBe('active')
    const again = applyWorkEvent(p, { kind: 'stage-start', stageKey: 'prep' })
    expect(again.changed).toBe(false)
    expect(again.reason).toBe('stage-start:not-pending:active')
  })

  it('阶段收口：无任务 / 有未完成任务 一律拒（缺失 ≠ 达成）', () => {
    let p = apply(initProcess(), { kind: 'stage-start', stageKey: 'prep' })
    const empty = applyWorkEvent(p, { kind: 'stage-done', stageKey: 'prep' })
    expect(empty.changed).toBe(false)
    expect(empty.reason).toBe('stage-done:tasks-open')

    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: '清洗数据' } })
    const open = applyWorkEvent(p, { kind: 'stage-done', stageKey: 'prep' })
    expect(open.changed).toBe(false)
    expect(open.reason).toBe('stage-done:tasks-open')
  })

  it('一个阶段可装多个任务；全部 complete 后阶段可收口，下一阶段才放行', () => {
    let p = apply(initProcess(), { kind: 'stage-start', stageKey: 'prep' })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: '清洗数据' } })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:2', stageKey: 'prep', objective: '对齐口径' } })
    expect(p.stages[0].tasks.length).toBe(2)

    p = apply(p, { kind: 'task-complete', taskId: 'wt:prep:1' })
    expect(applyWorkEvent(p, { kind: 'stage-done', stageKey: 'prep' }).changed).toBe(false)
    p = apply(p, { kind: 'task-complete', taskId: 'wt:prep:2' })
    p = apply(p, { kind: 'stage-done', stageKey: 'prep' })
    expect(p.stages.map((s) => s.state)).toEqual(['done', 'pending', 'pending'])

    p = apply(p, { kind: 'stage-start', stageKey: 'train' })
    expect(p.stages[1].state).toBe('active')
  })

  it('已收口的阶段不许再塞任务（要加活先重开）', () => {
    let p = apply(initProcess(), { kind: 'stage-start', stageKey: 'prep' })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: '清洗数据' } })
    p = apply(p, { kind: 'task-complete', taskId: 'wt:prep:1' })
    p = apply(p, { kind: 'stage-done', stageKey: 'prep' })
    const r = applyWorkEvent(p, { kind: 'task-create', task: { id: 'wt:prep:2', stageKey: 'prep', objective: '补一条' } })
    expect(r.changed).toBe(false)
    expect(r.reason).toBe('task-create:stage-done:prep')
  })

  it('收口判据：全阶段 done 才算流程可收口（空阶段表恒不可）', () => {
    expect(processAllowsClose(initProcess())).toBe(false)
    let p = apply(initProcess(), { kind: 'stage-define', stages: [{ key: 'only', statement: '独苗' }] })
    p = apply(p, { kind: 'stage-start', stageKey: 'only' })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:only:1', stageKey: 'only', objective: '干完' } })
    p = apply(p, { kind: 'task-complete', taskId: 'wt:only:1' })
    p = apply(p, { kind: 'stage-done', stageKey: 'only' })
    expect(processAllowsClose(p)).toBe(true)
  })
})

describe('层2 相位机 · 与宿主 goal 同构', () => {
  function withTask(): { p: WorkProcess; id: string } {
    const p = apply(apply(initProcess(), { kind: 'stage-start', stageKey: 'prep' }),
      { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: '清洗数据' } })
    return { p, id: 'wt:prep:1' }
  }

  it('created 任务初态 active / revision=1，挂在所属阶段下', () => {
    const { p } = withTask()
    expect(p.stages[0].tasks[0]).toEqual({ id: 'wt:prep:1', stageKey: 'prep', objective: '清洗数据', phase: 'active', revision: 1 })
  })

  it('pause → paused；resume → active；同值重放零写入', () => {
    const { p, id } = withTask()
    const paused = apply(p, { kind: 'task-pause', taskId: id })
    expect(paused.stages[0].tasks[0].phase).toBe('paused')
    const replay = applyWorkEvent(paused, { kind: 'task-pause', taskId: id })
    expect(replay.changed).toBe(false)
    expect(replay.reason).toBe('task-pause:not-active:paused')
    expect(apply(paused, { kind: 'task-resume', taskId: id }).stages[0].tasks[0].phase).toBe('active')
  })

  it('block 必须带结构化原因（空 code/message 一律拒）', () => {
    const { p, id } = withTask()
    const bad = applyWorkEvent(p, { kind: 'task-block', taskId: id, reason: { code: ' ', message: '等人' } })
    expect(bad.changed).toBe(false)
    expect(bad.reason).toBe('task-block:reason-required')
    const blocked = apply(p, { kind: 'task-block', taskId: id, reason: { code: 'wait-human', message: '等人确认' } })
    expect(blocked.stages[0].tasks[0].blockedReason).toEqual({ code: 'wait-human', message: '等人确认' })
  })

  it('complete 是终态：之后再 pause / 再 complete 一律零写入', () => {
    const { p, id } = withTask()
    const done = apply(p, { kind: 'task-complete', taskId: id })
    expect(done.stages[0].tasks[0].phase).toBe('complete')
    expect(applyWorkEvent(done, { kind: 'task-pause', taskId: id }).changed).toBe(false)
    expect(applyWorkEvent(done, { kind: 'task-complete', taskId: id }).reason).toBe('task-complete:terminal')
  })

  it('任务相位一改，所属阶段立刻不可收口（跨层联动）', () => {
    const { p, id } = withTask()
    const done = apply(apply(p, { kind: 'task-complete', taskId: id }), { kind: 'stage-done', stageKey: 'prep' })
    expect(done.stages[0].state).toBe('done')
    const back = applyWorkEvent(done, { kind: 'task-resume', taskId: id })
    expect(back.changed).toBe(false)   // complete 不可逆 → 阶段也不会被拖着走
  })
})

describe('身份 · 编号与墓碑（清掉的不复用）', () => {
  it('clear 之后新建的任务编号递增，不复用被清掉的号', () => {
    let p = apply(initProcess(), { kind: 'stage-start', stageKey: 'prep' })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: 'a' } })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:2', stageKey: 'prep', objective: 'b' } })
    p = apply(p, { kind: 'task-clear', taskId: 'wt:prep:2', clearedAt: 1_000 })
    expect(p.stages[0].tasks.map((t) => t.id)).toEqual(['wt:prep:1'])
    expect(p.cleared).toEqual([{ id: 'wt:prep:2', revision: 1, clearedAt: 1_000 }])
    const reuse = applyWorkEvent(p, { kind: 'task-create', task: { id: 'wt:prep:2', stageKey: 'prep', objective: 'c' } })
    expect(reuse.changed).toBe(false)
    expect(reuse.reason).toBe('task-create:identity-reuse:wt:prep:2')
  })
})

describe('聚合 CAS 与严格解码', () => {
  it('折叠校验链：revision 未恰好 +1 → 抛 WORK_CORRUPT', () => {
    const p = initProcess()
    const skip = change({ kind: 'stage-start', stageKey: 'prep' }, { ...p, revision: p.revision + 2 })
    expect(() => foldWorkProcess([change(INIT, p), skip])).toThrow(WorkError)
  })

  it('折叠校验链：记录的快照与事件重算不一致 → 抛 WORK_CORRUPT', () => {
    const p = initProcess()
    const started = applyWorkEvent(p, { kind: 'stage-start', stageKey: 'prep' }).next!
    const forged: WorkProcess = { ...started, stages: started.stages.map((s) => (s.key === 'prep' ? { ...s, state: 'done' } : s)) }
    expect(() => foldWorkProcess([change(INIT, p), change({ kind: 'stage-start', stageKey: 'prep' }, forged)])).toThrow(WorkError)
  })

  it('严格解码：坏快照当场响亮（多字段 / 串行门被破 / 任务归属不符）', () => {
    const p = initProcess()
    expect(() => decodeWorkProcess({ ...p, extra: 1 })).toThrow(WorkError)
    expect(() => decodeWorkProcess({ ...p, stages: [p.stages[0], { ...p.stages[1], state: 'done' }, p.stages[2]] })).toThrow(WorkError)
    const started = applyWorkEvent(p, { kind: 'stage-start', stageKey: 'prep' }).next!
    const moved = applyWorkEvent(started, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: 'x' } }).next!
    expect(() => decodeWorkProcess({ ...moved, stages: moved.stages.map((s) => (s.key === 'train' ? { ...s, tasks: moved.stages[0].tasks } : s)) })).toThrow(WorkError)
  })

  it('幂等重放不产出变更：sameProcess 是唯一的"没变"口径', () => {
    const p = initProcess()
    expect(sameProcess(p, initProcess())).toBe(true)
    expect(sameProcess(p, apply(p, { kind: 'stage-start', stageKey: 'prep' }))).toBe(false)
  })
})

describe('阶段表整体替换（stage-define）', () => {
  it('同值零写入；新增阶段为 pending；改名保留原有任务与态', () => {
    const p = initProcess()
    expect(applyWorkEvent(p, { kind: 'stage-define', stages: STAGES }).reason).toBe('stage-define:idempotent-replay')

    const started = applyWorkEvent(p, { kind: 'stage-start', stageKey: 'prep' }).next!
    const withTask = applyWorkEvent(started, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: 'x' } }).next!
    const redefined = applyWorkEvent(withTask, {
      kind: 'stage-define',
      stages: [{ key: 'prep', statement: '准备数据（改名）' }, { key: 'ship', statement: '发布' }],
    })
    expect(redefined.changed).toBe(true)
    expect(redefined.next?.stages[0].statement).toBe('准备数据（改名）')
    expect(redefined.next?.stages[0].state).toBe('active')
    expect(redefined.next?.stages[0].tasks.length).toBe(1)
    expect(redefined.next?.stages[1]).toEqual({ key: 'ship', statement: '发布', doneCriteria: [], state: 'pending', tasks: [] })
  })

  it('会被丢掉的非空阶段一律拒（不静默丢任务）', () => {
    const started = applyWorkEvent(initProcess(), { kind: 'stage-start', stageKey: 'prep' }).next!
    const withTask = applyWorkEvent(started, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: 'x' } }).next!
    const r = applyWorkEvent(withTask, { kind: 'stage-define', stages: [{ key: 'train', statement: '训练' }] })
    expect(r.changed).toBe(false)
    expect(r.reason).toBe('stage-define:would-drop-tasks:prep')
  })

  it('重排后串行门被破坏 → 拒（不能把 active 阶段排到未完成阶段后面）', () => {
    const started = applyWorkEvent(initProcess(), { kind: 'stage-start', stageKey: 'prep' }).next!
    const r = applyWorkEvent(started, {
      kind: 'stage-define',
      stages: [{ key: 'train', statement: '训练' }, { key: 'prep', statement: '准备数据' }],
    })
    expect(r.changed).toBe(false)
    expect(r.reason).toContain('串行门被破坏')
  })

  it('进度投影：阶段与任务两层分别计数', () => {
    const started = applyWorkEvent(initProcess(), { kind: 'stage-start', stageKey: 'prep' }).next!
    const withTasks = applyWorkEvent(started, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: 'x' } }).next!
    const done = applyWorkEvent(withTasks, { kind: 'task-complete', taskId: 'wt:prep:1' }).next!
    expect(workProgressOf(done)).toEqual({ stages: { total: 3, done: 0 }, tasks: { total: 1, done: 1 } })
  })
})

/* -------------------------------------------------------------------------- */
/* 服务层（I/O 编排）：store 假件 + 幂等判据靠 writes 计数                          */

function storeOf(records: Record<string, WorkRecordLike>) {
  let writes = 0
  return {
    records,
    get writes() { return writes },
    get: async (scope: string) => records[scope],
    mutate: async (scope: string, fn: (draft: WorkRecordLike) => unknown) => {
      const record = records[scope]
      if (record === undefined) return { changed: false }
      const out = fn(record)
      const changed = (out as { changed?: boolean } | undefined)?.changed === true
      if (changed) writes += 1
      return { changed }
    },
  }
}

describe('服务层 · 读写收口', () => {
  it('建流程 → 落记录 + 通知；幂等重放零写盘', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1 } })
    const notes: string[] = []
    const deps = { store: st as never, now: () => 1_000, onChanged: (n: { change: { event: WorkEvent } }) => { notes.push(n.change.event.kind) } }

    expect(await createWorkProcess(deps, 'ws-a', { objective: '把模型发上线', stages: STAGES })).toBe(true)
    expect(st.writes).toBe(1)
    expect(notes).toEqual(['init'])
    expect(await createWorkProcess(deps, 'ws-a', { objective: '把模型发上线', stages: STAGES })).toBe(false)
    expect(st.writes).toBe(1)
    expect(notes).toEqual(['init'])
  })

  it('建任务：身份由服务分配（wt:<stage>:<seq>），clear 后不回头', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1 } })
    const deps = { store: st as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', { objective: 'x', stages: STAGES })
    await startWorkStage(deps, 'ws-a', 'prep')
    await createWorkTask(deps, 'ws-a', { stageKey: 'prep', objective: 'a' })
    await createWorkTask(deps, 'ws-a', { stageKey: 'prep', objective: 'b' })
    await clearWorkTask(deps, 'ws-a', 'wt:prep:2')
    expect(await createWorkTask(deps, 'ws-a', { stageKey: 'prep', objective: 'c' })).toBe(true)
    const ids = await workTaskOf(deps, 'ws-a', 'wt:prep:3')
    expect(ids?.objective).toBe('c')
  })

  it('CAS：拿旧 revision 改 → WORK_CONFLICT（写前拒）', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1 } })
    const deps = { store: st as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', { objective: 'x', stages: STAGES })
    await startWorkStage(deps, 'ws-a', 'prep')
    await expect(startWorkStage(deps, 'ws-a', 'prep', 1)).rejects.toMatchObject({ code: 'WORK_CONFLICT' })
  })

  it('没有流程就建任务 → WORK_NO_PROCESS（不落半份状态）', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1 } })
    const deps = { store: st as never, now: () => 1_000 }
    await expect(createWorkTask(deps, 'ws-a', { stageKey: 'prep', objective: 'a' }))
      .rejects.toMatchObject({ code: 'WORK_NO_PROCESS' })
    expect(st.writes).toBe(0)
  })

  it('域层**允许**给后续阶段先落任务**（刻意的能力，不是漏洞）：驱动器按"计划先落任务、开工归驱动器"用它', async () => {
    // 与工具面的纪律（`WORK_TOOL_REGISTRY` 的 create_worktask 自述 / 策略段"不要提前给后续阶段建任务"）
    // **分开看**：那条纪律是 agent 行为面的，牙长在工具面（`WORK_NOT_CURRENT_STAGE`）；域是通用引擎，
    // 不该把 agent 的纪律变成状态规则（驱动器的环测、service/view 的读投影都依赖这个能力）。
    const st = storeOf({ 'ws-a': { updatedAt: 1 } })
    const deps = { store: st as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', { objective: 'x', stages: STAGES })
    await startWorkStage(deps, 'ws-a', 'prep')
    expect(await createWorkTask(deps, 'ws-a', { stageKey: 'train', objective: '先拆好' })).toBe(true)
    const process = await workProcessOf(deps, 'ws-a')
    expect(process?.stages.map((s) => [s.key, s.state, s.tasks.length]))
      .toEqual([['prep', 'active', 0], ['train', 'pending', 1], ['release', 'pending', 0]])
    // 严格解码（持久化边界用的同一份规则）接受它——所以它不会被判成坏数据。
    expect(() => decodeWorkProcess(process)).not.toThrow()
  })

  it('视图：计数与许可派生自归属记录（不另存第二份）', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1, rounds: { started: 4, activation: 'armed' } } })
    const deps = { store: st as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', { objective: 'x', stages: STAGES })
    const view = await workProcessViewOf(deps, 'ws-a')
    expect(view?.roundsStarted).toBe(4)
    expect(view?.activation).toBe('armed')
    expect(await progressOf(deps, 'ws-a')).toEqual({ stages: { total: 3, done: 0 }, tasks: { total: 0, done: 0 } })
  })

  it('阶段推进链：人工确认收口后才放行下一阶段', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1 } })
    const deps = { store: st as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', { objective: 'x', stages: STAGES })
    await startWorkStage(deps, 'ws-a', 'prep')
    await createWorkTask(deps, 'ws-a', { stageKey: 'prep', objective: 'a' })
    await completeWorkTask(deps, 'ws-a', 'wt:prep:1')
    expect(await completeWorkStage(deps, 'ws-a', 'prep')).toBe(true)
    expect(await startWorkStage(deps, 'ws-a', 'train')).toBe(true)
    expect(await defineWorkStages(deps, 'ws-a', [{ key: 'prep', statement: '准备数据', doneCriteria: ['数据可用'] }, { key: 'train', statement: '训练模型' }, { key: 'release', statement: '发布上线' }])).toBe(false)
  })
})

describe('阶段收口策略（human 人工确认 / auto 自动收口）', () => {
  const POLICY_STAGES: readonly WorkStageDraft[] = [
    { key: 'prep', statement: '准备数据', closePolicy: 'auto' },
    { key: 'train', statement: '训练模型' },   // 缺省 = human
  ]
  const POLICY_INIT: WorkEvent = { kind: 'init', id: 'wp:ws-p', objective: 'x', stages: POLICY_STAGES }

  function initPolicy(): WorkProcess {
    const r = applyWorkEvent(undefined, POLICY_INIT)
    if (!r.changed || r.next === undefined) throw new Error('夹具失败：init 未成立')
    return r.next
  }

  it('建流程带入策略；缺省不写 = human（缺失 ≠ auto）', () => {
    const p = initPolicy()
    expect(p.stages[0].closePolicy).toBe('auto')
    expect(p.stages[1].closePolicy).toBeUndefined()
    expect(stageClosePolicyOf(p.stages[0])).toBe('auto')
    expect(stageClosePolicyOf(p.stages[1])).toBe('human')
  })

  it('init 判据把策略算进"同一条流程"：同陈述同策略 = 幂等；换了策略 = 身份冲突', () => {
    expect(applyWorkEvent(initPolicy(), POLICY_INIT).reason).toBe('init:idempotent-replay')
    const conflict = applyWorkEvent(initPolicy(), {
      ...POLICY_INIT,
      stages: [{ key: 'prep', statement: '准备数据', closePolicy: 'human' }, { key: 'train', statement: '训练模型' }],
    })
    expect(conflict.changed).toBe(false)
    expect(conflict.reason).toBe('init:identity-conflict')
  })

  it('stage-define：策略是**定义**的一部分（可改），运行态（态 / 任务）保留；草案不写即回到 human', () => {
    let p = apply(initPolicy(), { kind: 'stage-start', stageKey: 'prep' })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: '清洗数据' } })

    const flipped = apply(p, {
      kind: 'stage-define',
      stages: [{ key: 'prep', statement: '准备数据', closePolicy: 'human' }, { key: 'train', statement: '训练模型', closePolicy: 'auto' }],
    })
    expect(flipped.stages.map((s) => stageClosePolicyOf(s))).toEqual(['human', 'auto'])
    expect(flipped.stages[0].state).toBe('active')      // 运行态保留
    expect(flipped.stages[0].tasks.length).toBe(1)

    const same = applyWorkEvent(flipped, {
      kind: 'stage-define',
      stages: [{ key: 'prep', statement: '准备数据', closePolicy: 'human' }, { key: 'train', statement: '训练模型', closePolicy: 'auto' }],
    })
    expect(same.changed).toBe(false)                    // 同值重放零写入
    expect(same.reason).toBe('stage-define:idempotent-replay')

    const reset = applyWorkEvent(flipped, {
      kind: 'stage-define',
      stages: [{ key: 'prep', statement: '准备数据' }, { key: 'train', statement: '训练模型' }],
    })
    expect(reset.changed).toBe(true)
    expect(reset.next!.stages.map((s) => stageClosePolicyOf(s))).toEqual(['human', 'human'])
  })

  it('非法策略零写入（写进去的东西必须读得回来）', () => {
    const bad = applyWorkEvent(initPolicy(), {
      kind: 'stage-define',
      stages: [{ key: 'prep', statement: '准备数据', closePolicy: 'always' as never }, { key: 'train', statement: '训练模型' }],
    })
    expect(bad.changed).toBe(false)
    expect(String(bad.reason)).toContain('收口策略不认识')
  })

  it('策略不改收口判据：auto 也要求任务非空且全 complete；收口后策略随阶段保留', () => {
    let p = apply(initPolicy(), { kind: 'stage-start', stageKey: 'prep' })
    expect(applyWorkEvent(p, { kind: 'stage-done', stageKey: 'prep' }).reason).toBe('stage-done:tasks-open')   // 没任务
    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: '清洗数据' } })
    expect(applyWorkEvent(p, { kind: 'stage-done', stageKey: 'prep' }).reason).toBe('stage-done:tasks-open')   // 任务没完成
    p = apply(p, { kind: 'task-complete', taskId: 'wt:prep:1' })
    const done = apply(p, { kind: 'stage-done', stageKey: 'prep' })
    expect(done.stages[0].state).toBe('done')
    expect(done.stages[0].closePolicy).toBe('auto')
  })

  it('严格解码：策略只认 human / auto；缺省合法（老快照向后兼容）', () => {
    const p = decodeWorkProcess(initPolicy())
    expect(p.stages[0].closePolicy).toBe('auto')
    const legacy = decodeWorkProcess({ ...p, stages: p.stages.map((s) => ({ ...s, closePolicy: undefined })) })
    expect(legacy.stages[0].closePolicy).toBeUndefined()
    expect(stageClosePolicyOf(legacy.stages[0])).toBe('human')
    expect(() => decodeWorkProcess({
      ...p, stages: p.stages.map((s, i) => (i === 0 ? { ...s, closePolicy: 'always' } : s)),
    })).toThrowError(WorkError)
  })

  it('迁移链：记录的快照必须与事件重算逐字段一致（收口策略也在内）', () => {
    const p = initPolicy()
    const event: WorkEvent = {
      kind: 'stage-define',
      stages: [{ key: 'prep', statement: '准备数据', closePolicy: 'human' }, { key: 'train', statement: '训练模型' }],
    }
    const right = apply(p, event)
    expect(foldWorkProcess([change(POLICY_INIT, p), change(event, right)]).process?.stages[0].closePolicy).toBe('human')
    const forged = { ...right, stages: right.stages.map((s, i) => (i === 0 ? { ...s, closePolicy: 'auto' as const } : s)) }
    expect(() => foldWorkProcess([change(POLICY_INIT, p), change(event, forged)])).toThrowError(WorkError)
  })
})

describe('丢弃流程（连根拔掉，不是状态迁移）', () => {
  it('丢弃后读不到流程、回合计数归零、再建是 revision 1 的新流程；重放幂等', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1, rounds: { started: 7, activation: 'armed' } } })
    const deps = { store: st as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', { objective: 'x', stages: STAGES })
    await startWorkStage(deps, 'ws-a', 'prep')
    const before = st.writes
    expect(await discardWorkProcess(deps, 'ws-a')).toBe(true)
    expect(st.writes).toBe(before + 1)
    expect(await workProcessOf(deps, 'ws-a')).toBeUndefined()
    // 记录还在（归属没变），但流程没了、回合计数归零
    expect(st.records['ws-a'].workProcess).toBeUndefined()
    expect(st.records['ws-a'].rounds?.started).toBe(0)
    // 幂等：没有流程 ⇒ 零写入
    const after = st.writes
    expect(await discardWorkProcess(deps, 'ws-a')).toBe(false)
    expect(st.writes).toBe(after)
    // 再建 = **新**流程（revision 1），不是"复活"旧流程
    expect(await createWorkProcess(deps, 'ws-a', { objective: 'y', stages: STAGES })).toBe(true)
    expect((await workProcessOf(deps, 'ws-a'))?.revision).toBe(1)
  })

  it('CAS：拿旧 revision 丢弃 → WORK_CONFLICT（写前拒，流程还在）', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1 } })
    const deps = { store: st as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', { objective: 'x', stages: STAGES })
    await expect(discardWorkProcess(deps, 'ws-a', 9)).rejects.toMatchObject({ code: 'WORK_CONFLICT' })
    expect(await workProcessOf(deps, 'ws-a')).toBeDefined()
  })
})

describe('改流程目标（objective-edit：人改目标，不丢历史）', () => {
  it('折进新目标：revision +1、阶段与任务原样保留', () => {
    let p = apply(initProcess(), { kind: 'stage-start', stageKey: 'prep' })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: '清洗数据' } })
    const before = p.revision
    const edited = apply(p, { kind: 'objective-edit', objective: '把模型发上线（v2）' })
    expect(edited.objective).toBe('把模型发上线（v2）')
    expect(edited.revision).toBe(before + 1)
    expect(edited.stages.map((s) => [s.key, s.state, s.tasks.length]))
      .toEqual([['prep', 'active', 1], ['train', 'pending', 0], ['release', 'pending', 0]])
    expect(edited.stages[0].tasks[0].objective).toBe('清洗数据')
  })

  it('幂等与非法输入：同值重放零写入；空目标零写入；没有流程零写入', () => {
    const p = initProcess()
    const same = applyWorkEvent(p, { kind: 'objective-edit', objective: p.objective })
    expect(same.changed).toBe(false)
    expect(same.reason).toBe('objective-edit:idempotent-replay')
    const blank = applyWorkEvent(p, { kind: 'objective-edit', objective: '   ' })
    expect(blank.changed).toBe(false)
    expect(blank.reason).toBe('objective-edit:objective-required')
    const orphan = applyWorkEvent(undefined, { kind: 'objective-edit', objective: 'x' })
    expect(orphan.changed).toBe(false)
    expect(orphan.reason).toBe('objective-edit:no-process')
  })

  it('严格解码：字段集精确（多一个字段即拒）；空目标拒', () => {
    expect(decodeWorkEvent({ kind: 'objective-edit', objective: 'x' })).toEqual({ kind: 'objective-edit', objective: 'x' })
    expect(() => decodeWorkEvent({ kind: 'objective-edit', objective: 'x', extra: 1 })).toThrowError(WorkError)
    expect(() => decodeWorkEvent({ kind: 'objective-edit', objective: '  ' })).toThrowError(WorkError)
  })

  it('迁移链：改目标也走"事件重算 = 记录快照"（伪造目标即拒）', () => {
    const p = initProcess()
    const event: WorkEvent = { kind: 'objective-edit', objective: '换一个目标' }
    const right = apply(p, event)
    expect(foldWorkProcess([change(INIT, p), change(event, right)]).process?.objective).toBe('换一个目标')
    const forged = { ...right, objective: '偷偷换的' }
    expect(() => foldWorkProcess([change(INIT, p), change(event, forged)])).toThrowError(WorkError)
  })

  it('不变量：非 init / objective-edit 的事件顺手改 objective 会被 INV-4 拦下', () => {
    const p = initProcess()
    const event: WorkEvent = { kind: 'stage-start', stageKey: 'prep' }
    const tampered = { ...apply(p, event), objective: '被顺手改掉的' }
    const violations = checkWorkInvariants(p, { changed: true, next: tampered }, 'stage-start')
    expect(violations.map((v) => v.inv)).toContain('INV-4')
  })

  it('服务层：改目标 +1 且幂等零写入；空目标抛 WORK_OBJECTIVE_REQUIRED；CAS 旧值即拒', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1 } })
    const deps = { store: st as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', { objective: 'x', stages: STAGES })
    expect(await editWorkObjective(deps, 'ws-a', 'y')).toBe(true)
    expect((await workProcessOf(deps, 'ws-a'))?.objective).toBe('y')
    const writes = st.writes
    expect(await editWorkObjective(deps, 'ws-a', 'y')).toBe(false)
    expect(st.writes).toBe(writes)
    await expect(editWorkObjective(deps, 'ws-a', '  ')).rejects.toMatchObject({ code: 'WORK_OBJECTIVE_REQUIRED' })
    await expect(editWorkObjective(deps, 'ws-a', 'z', 9)).rejects.toMatchObject({ code: 'WORK_CONFLICT' })
  })
})

describe('流程收口（process-close：轻量终止水印）', () => {
  /** 起一条流程并把全阶段做完（收口用例的起点）。 */
  function finishedProcess(): WorkProcess {
    let p = apply(initProcess(), { kind: 'stage-start', stageKey: 'prep' })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:prep:1', stageKey: 'prep', objective: '清洗' } })
    p = apply(p, { kind: 'task-complete', taskId: 'wt:prep:1' })
    p = apply(p, { kind: 'stage-done', stageKey: 'prep' })
    p = apply(p, { kind: 'stage-start', stageKey: 'train' })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:train:1', stageKey: 'train', objective: '训练' } })
    p = apply(p, { kind: 'task-complete', taskId: 'wt:train:1' })
    p = apply(p, { kind: 'stage-done', stageKey: 'train' })
    p = apply(p, { kind: 'stage-start', stageKey: 'release' })
    p = apply(p, { kind: 'task-create', task: { id: 'wt:release:1', stageKey: 'release', objective: '发布' } })
    p = apply(p, { kind: 'task-complete', taskId: 'wt:release:1' })
    return apply(p, { kind: 'stage-done', stageKey: 'release' })
  }

  it('全阶段 done ⇒ 落 closedAt、revision +1、其余字段原样', () => {
    const p = finishedProcess()
    const before = p.revision
    const closed = apply(p, { kind: 'process-close', closedAt: 1_000 })
    expect(closed.closedAt).toBe(1_000)
    expect(closed.revision).toBe(before + 1)
    expect(closed.objective).toBe(p.objective)
    expect(closed.stages.every((s) => s.state === 'done')).toBe(true)
  })

  it('判据：阶段没全 done ⇒ 拒（stages-open）；已收口再收 ⇒ 拒（already-closed，零写入）', () => {
    const open = apply(initProcess(), { kind: 'stage-start', stageKey: 'prep' })
    const blocked = applyWorkEvent(open, { kind: 'process-close', closedAt: 1 })
    expect(blocked.changed).toBe(false)
    expect(blocked.reason).toBe('process-close:stages-open')
    const done = finishedProcess()
    const closed = apply(done, { kind: 'process-close', closedAt: 1 })
    const again = applyWorkEvent(closed, { kind: 'process-close', closedAt: 2 })
    expect(again.changed).toBe(false)
    expect(again.reason).toBe('process-close:already-closed')
  })

  it('收口总闸：已收口的流程拒绝一切写（task-create / stage-define / objective-edit 全部零写入）', () => {
    const closed = apply(finishedProcess(), { kind: 'process-close', closedAt: 1 })
    const writes: WorkEvent[] = [
      { kind: 'task-create', task: { id: 'wt:x:1', stageKey: 'prep', objective: 'x' } },
      { kind: 'stage-define', stages: [{ key: 'again', statement: '重来' }] },
      { kind: 'objective-edit', objective: '换个目标' },
      { kind: 'stage-start', stageKey: 'prep' },
    ]
    for (const event of writes) {
      const r = applyWorkEvent(closed, event)
      expect(r.changed).toBe(false)
      expect(r.reason).toBe('process-closed')
    }
    // init 重建也被闸住（须先 discard）
    expect(applyWorkEvent(closed, { ...INIT }).reason).toBe('process-closed')
  })

  it('严格解码：事件字段精确；快照放行 closedAt、坏值拒', () => {
    expect(decodeWorkEvent({ kind: 'process-close', closedAt: 5 })).toEqual({ kind: 'process-close', closedAt: 5 })
    expect(() => decodeWorkEvent({ kind: 'process-close', closedAt: 5, extra: 1 })).toThrowError(WorkError)
    const closed = apply(finishedProcess(), { kind: 'process-close', closedAt: 5 })
    expect(decodeWorkProcess(closed).closedAt).toBe(5)
    expect(() => decodeWorkProcess({ ...closed, closedAt: 'x' })).toThrowError(WorkError)
    expect(decodeWorkProcess({ ...closed, closedAt: undefined }).closedAt).toBeUndefined()
  })

  it('不变量：非 process-close 事件改 closedAt 会被 INV-4 拦下；未全 done 却收口会被 INV-7 拦下', () => {
    const p = finishedProcess()
    const tampered = { ...p, closedAt: 9 }
    expect(checkWorkInvariants(p, { changed: true, next: tampered }, 'stage-start').map((v) => v.inv))
      .toContain('INV-4')
    // INV-7 在 fold 已拒，这里直接构造坏快照验证检查本身
    const halfDone = { ...p, stages: p.stages.map((s, i) => (i === 0 ? s : { ...s, state: 'pending' as const })), closedAt: 9 }
    expect(checkWorkInvariants(p, { changed: true, next: halfDone }, 'process-close').map((v) => v.inv))
      .toContain('INV-7')
  })

  it('服务层：收口 +1 且幂等零写入；CAS 旧值即拒；未全 done 时 zero-write', async () => {
    const st = storeOf({ 'ws-a': { updatedAt: 1 } })
    const deps = { store: st as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', { objective: 'x', stages: [{ key: 'only', statement: '唯一' }] })
    // 阶段没收口 ⇒ close 零写入
    expect(await closeWorkProcess(deps, 'ws-a')).toBe(false)
    await startWorkStage(deps, 'ws-a', 'only')
    await createWorkTask(deps, 'ws-a', { stageKey: 'only', objective: '干活' })
    await completeWorkTask(deps, 'ws-a', 'wt:only:1')
    await completeWorkStage(deps, 'ws-a', 'only')
    expect(await closeWorkProcess(deps, 'ws-a')).toBe(true)
    expect((await workProcessOf(deps, 'ws-a'))?.closedAt).toBe(1_000)
    const writes = st.writes
    expect(await closeWorkProcess(deps, 'ws-a')).toBe(false)
    expect(st.writes).toBe(writes)
    await expect(closeWorkProcess(deps, 'ws-a', 999)).rejects.toMatchObject({ code: 'WORK_CONFLICT' })
  })

  it('迁移链：收口也走"事件重算 = 记录快照"（伪造 closedAt 即拒）', () => {
    // 从 init 逐事件搭一条真实变更链（收口必须接在合法前态上重算）。
    const EVENTS: WorkEvent[] = [
      { kind: 'init', id: 'wp:ws-a', objective: 'x', stages: [{ key: 'only', statement: '唯一' }] },
      { kind: 'stage-start', stageKey: 'only' },
      { kind: 'task-create', task: { id: 'wt:only:1', stageKey: 'only', objective: '干活' } },
      { kind: 'task-complete', taskId: 'wt:only:1' },
      { kind: 'stage-done', stageKey: 'only' },
    ]
    let cur: WorkProcess | undefined
    const chain = EVENTS.map((event) => {
      const r = applyWorkEvent(cur, event)
      if (!r.changed || r.next === undefined) throw new Error('夹具失败：' + event.kind)
      cur = r.next
      return change(event, r.next)
    })
    const closeEvent: WorkEvent = { kind: 'process-close', closedAt: 42 }
    const closed = apply(cur!, closeEvent)
    expect(foldWorkProcess([...chain, change(closeEvent, closed)]).process?.closedAt).toBe(42)
    expect(() => foldWorkProcess([...chain, change(closeEvent, { ...closed, closedAt: 43 })]))
      .toThrowError(WorkError)
  })
})

describe('续跑许可（rounds.activation：耐久，goal 那套 disarm 的落点）', () => {
  const deps = (records: Record<string, WorkRecordLike>) => ({ store: storeOf(records), now: () => 1_000 })

  it('缺省 armed；disarm 写进记录（耐久），幂等零写入', async () => {
    const records: Record<string, WorkRecordLike> = { 'ws-a': { updatedAt: 1 } }
    const d = deps(records)
    await createWorkProcess(d, 'ws-a', { objective: 'x', stages: [{ key: 'p', statement: 's' }] })
    expect(await workActivationOf(d, 'ws-a')).toBe('armed')          // 缺省 = 允许自动跑
    expect(await setWorkActivation(d, 'ws-a', 'disarmed')).toBe(true)
    expect(await workActivationOf(d, 'ws-a')).toBe('disarmed')
    expect(records['ws-a'].rounds?.activation).toBe('disarmed')      // 落在记录里，不是内存态
    expect(await setWorkActivation(d, 'ws-a', 'disarmed')).toBe(false)  // 幂等
    expect(await setWorkActivation(d, 'ws-a', 'armed')).toBe(true)      // 人能放回去
  })

  it('没有流程 ⇒ 零写入 false（没有可授权的对象）', async () => {
    const records: Record<string, WorkRecordLike> = {}
    expect(await setWorkActivation(deps(records), 'ws-none', 'disarmed')).toBe(false)
    expect(await workActivationOf(deps(records), 'ws-none')).toBeUndefined()
  })

  it('CAS：给旧 revision 即拒（先读再改）', async () => {
    const records: Record<string, WorkRecordLike> = { 'ws-a': { updatedAt: 1 } }
    const d = deps(records)
    await createWorkProcess(d, 'ws-a', { objective: 'x', stages: [{ key: 'p', statement: 's' }] })
    await expect(setWorkActivation(d, 'ws-a', 'disarmed', 99)).rejects.toThrow(WorkError)
  })

  it('视图把许可带出来（get_workstage / 消费方都看得到）', async () => {
    const records: Record<string, WorkRecordLike> = { 'ws-a': { updatedAt: 1 } }
    const d = deps(records)
    await createWorkProcess(d, 'ws-a', { objective: 'x', stages: [{ key: 'p', statement: 's' }] })
    await setWorkActivation(d, 'ws-a', 'disarmed')
    const view = await workProcessViewOf(d, 'ws-a')
    expect(view?.activation).toBe('disarmed')
  })
})

describe('"已经问过"的耐久记号（跨重启不重复打扰；修订一变即作废）', () => {
  const deps = (records: Record<string, WorkRecordLike>) => ({ store: storeOf(records), now: () => 1_000 })
  const stage = [{ key: 'prep', statement: '准备' }]

  it('记一次读得到；同键同修订幂等；没有流程 ⇒ false', async () => {
    const records: Record<string, WorkRecordLike> = { 'ws-a': { updatedAt: 1 } }
    const d = deps(records)
    await createWorkProcess(d, 'ws-a', { objective: 'x', stages: stage })
    expect(await workAskedOf(d, 'ws-a')).toBeUndefined()
    expect(await markWorkAsked(d, 'ws-a', 'plan', 'prep', 1)).toBe(true)
    expect(await workAskedOf(d, 'ws-a')).toEqual({ plan: { key: 'prep', revision: 1 } })
    expect(await markWorkAsked(d, 'ws-a', 'plan', 'prep', 1)).toBe(false)   // 幂等
    expect(await markWorkAsked(d, 'ws-none', 'plan', 'prep', 1)).toBe(false)
  })

  it('丢弃流程时记号一并清掉（否则重建的流程会撞上旧记号：同阶段键 + 同 revision）', async () => {
    const records: Record<string, WorkRecordLike> = { 'ws-a': { updatedAt: 1 } }
    const d = deps(records)
    await createWorkProcess(d, 'ws-a', { objective: 'x', stages: stage })
    await markWorkAsked(d, 'ws-a', 'plan', 'prep', 1)
    expect(await discardWorkProcess(d, 'ws-a')).toBe(true)
    await createWorkProcess(d, 'ws-a', { objective: 'x', stages: stage })    // 重建（revision 又是 1）
    expect(await workAskedOf(d, 'ws-a')).toBeUndefined()                    // 旧记号已清
  })
})
