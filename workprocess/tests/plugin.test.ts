/**
** workprocess 插件（组合根，已并入内核）：**装配面**（六个工具真注册）+ 归属缺省（本会话）+ 真人判定 +
 * 回合边界驱动（开工 / auto 收口 / **续跑投递**）+ 归属记录落**宿主存储域**。
 *
 * 【守护什么】这层是组合根，测的是"三件库接起来之后**用真宿主形状的假 ctx 还能不能跑通**"：
 *   ① 六个工具按登记表注册（名字逐字一致）、域声明合法、快照校验用内核解码器；
 *   ② 不传 scope 时归属自动落到**本会话**；写必须走域（耐久面），幂等时一个字节都不写；
 *   ③ 真人判定：没人发言 ⇒ human 策略的收口被拒；本回合有人的消息 ⇒ 放行；
 *   ④ 回合边界：pending 阶段自动开工、auto 阶段自动收口、活动轮次不动手；
 *   ⑤ 续跑投递：空闲边界投一轮（source=**work**，绝不冒充人）、同一轮不重复投、
 *      接手后计数耐久前进、到上限落盘 block 并停止投递。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { apply, name, inject, storageDomainStoreOf, workprocessDomain } from 'workprocess'
import { WORK_TOOL_REGISTRY } from 'tool-workprocess'
import { apply as applyTools } from 'tool-workprocess/plugin.js'
import { apply as applyDriver } from 'workprocess-round-driver'
import { applyWorkEvent, startWorkStage } from 'workprocess'

interface ToolLike { execute(args: Record<string, unknown>, exec?: unknown): Promise<Record<string, unknown>> }
interface HostEvent { type?: string; data?: { source?: { kind?: string; round?: number; taskId?: string; revision?: number } } }
interface Sent { readonly content: unknown; readonly source: Record<string, unknown> }

/** 假域设施：把域后端换成内存表（键→记录），并记录写次数。 */
function fakeDomainFacility() {
  const tables = new Map<string, Map<string, unknown>>()
  const writes: string[] = []
  const opened: string[] = []
  return {
    writes,
    opened,
    facility: {
      async open(spec: { name: string }): Promise<{ table(n: string): unknown }> {
        opened.push(spec.name)
        return {
          table: (n: string) => {
            const map = tables.get(n) ?? new Map<string, unknown>()
            tables.set(n, map)
            return {
              get: (k: string): unknown => map.get(k),
              put: async (k: string, v: unknown): Promise<void> => { writes.push(k); map.set(k, v) },
            }
          },
        }
      },
    },
    recordsOf: (table: string): Map<string, unknown> => tables.get(table) ?? new Map<string, unknown>(),
  }
}

interface FakeHost {
  ctx: never
  tools: Record<string, ToolLike>
  store: ReturnType<typeof storageDomainStoreOf>
  hooks: string[]
  sent: Sent[]
  /** `exec.deferContext` 收下的通告（工具回执之后的那条消息）。 */
  deferred: unknown[]
  /** 注册进 systemPrompt 的策略段。 */
  policySections: Array<{ name: string; order: number; text: string }>
  /** `ctx.emit` 收下的载荷（work/changed 断言用）。 */
  emitted: Array<{ name: string; payload: unknown }>
  session: { id: string; snapshotEvents(): readonly HostEvent[] }
  domain: ReturnType<typeof fakeDomainFacility>
  /** 投一条会话事件（走插件真挂上的 handler，等它跑完）。 */
  emit(event: unknown): Promise<void>
  /** 投一条 `agent/status`（宿主空闲边界的真信号），并把 agent 状态设成它。 */
  emitStatus(status: string): Promise<void>
  setStatus(status: string): void
  /** 让 `ctx.get('userQuestions')` 返回一个假服务，按队列回答（`undefined` = 没有通道）。 */
  setUserAnswers(answers: Array<{ id: string; selected: string[]; custom?: string } | 'ASK_CANCELLED' | 'NO_PROVIDER'>): void
  setEvents(events: readonly HostEvent[]): void
  setOpenTurn(start: number | null): void
  record(scope?: string): { workProcess?: unknown; rounds?: { started?: number } } | undefined
  exec(): unknown
}

function fakeHost(): FakeHost {
  let events: readonly HostEvent[] = []
  let openTurnStartSeq: number | null = null
  let status = 'running'
  const sent: Sent[] = []
  const handlers = new Map<string, Array<(a: unknown, b?: unknown) => void | Promise<void>>>()
  const session = { id: 'session-1', snapshotEvents: () => events }
  const agent = {
    id: 'session-1',
    get status(): string { return status },
    session,
    // 语义等价于宿主的 `agent.followup(message)`：留住投出去的那条，供断言。
    followup: (message: unknown): void => { sent.push(message as Sent) },
    // 竞态围栏读的两条队列（驱动器会把投出去的那条算作"自己那条"）。
    inbox: { nextStep: [] as unknown[], nextTurn: [] as unknown[] },
  }
  const tools: Record<string, ToolLike> = {}
  const hooks: string[] = []
  const deferred: unknown[] = []
  const policySections: Array<{ name: string; order: number; text: string }> = []
  const emitted: Array<{ name: string; payload: unknown }> = []
  let userAnswers: Array<{ id: string; selected: string[]; custom?: string } | 'ASK_CANCELLED' | 'NO_PROVIDER'> = []
  const questionsService = {
    ask: async (): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }> => {
      const next = userAnswers.shift()
      // 没排队 = 没有 answerer 接下这一问（真宿主此时抛 NO_PROVIDER，ask 会一直等人答）。
      if (next === undefined) throw Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' })
      if (next === 'ASK_CANCELLED') throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
      if (next === 'NO_PROVIDER') throw Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' })
      return { answers: [next] }
    },
  }
  const domain = fakeDomainFacility()
  // 驱动器起的那条串行 run（`withoutInitiator`）：harness 靠它把"投递完成"等到确定点上。
  const runs: Array<Promise<unknown>> = []
  const teardowns: Array<() => void> = []
  const ctx = {
    agents: {
      get: (id: string) => (id === agent.id ? agent : undefined),
      currentInitiator: () => agent,
      // 宿主同款：驱动器在"无发起者"作用域里跑（不把自动回合记成人的动作）。
      withoutInitiator: <T,>(fn: () => T): T => {
        const out = fn()
        if (out instanceof Promise) runs.push(out as Promise<unknown>)
        return out
      },
    },
    // 驱动器就绪判据读的 fiber 状态（FiberState.ACTIVE = 2）。
    fiber: { state: 2 },
    // 耐久检查点口（驱动器在两次推进之间 flush 一次）。
    sessions: { flush: async (): Promise<boolean> => true },
    logger: { warn: (): void => {} },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq }) },
    storageDomain: domain.facility,
    tools: { register: (t: unknown) => { const tool = t as { name: string } & ToolLike; tools[tool.name] = tool; return (): void => {} } },
    on: (event: string, cb: (a: unknown, b: unknown) => void | Promise<void>) => {
      hooks.push(event)
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
    },
    // 宿主 cordis 的 effect：跑一遍生成器，把 yield 出来的卸载器收好（fiber 卸载时调用）。
    effect: (fn: () => Generator<unknown, void, unknown>) => {
      const iter = fn()
      for (let next = iter.next(); !next.done; next = iter.next()) {
        const yielded = next.value
        if (typeof yielded === 'function') teardowns.push(yielded as () => void)
      }
      return (): void => { for (const teardown of teardowns.splice(0)) teardown() }
    },
    // 宿主 cordis 的服务注册口（本插件把 `ctx.workprocess` 提供出去，命令行包消费它）。
    provide: (serviceName: string, value: unknown) => { (ctx as Record<string, unknown>)[serviceName] = value; return undefined },
    // 宿主的问题服务（`ctx.get('userQuestions')`）：策略 human 的收口确认走它。
    get: (name: string) => (name === 'userQuestions' ? questionsService : undefined),
    // 宿主事件总线：`ctx.emit` 收在这里（work/changed 断言用）。
    emit: (name: string, payload: unknown) => { emitted.push({ name, payload }) },
    // 系统提示词面（策略段）：槽位数与宿主 SECTION_ORDERS.TOOL_GOAL 一致。
    systemPrompt: {
      section: (section: { name: string; order: number; text: string }) => { policySections.push(section); return (): void => {} },
      getSectionOrder: (name: string) => (name === 'TOOL_GOAL' ? 2400 : 0),
    },
  }
  /** 等到驱动器那条串行 run 收敛（它有 retire → 可能再起一条）。 */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      const pending = runs.splice(0)
      if (pending.length === 0) {
        await Promise.resolve()
        if (runs.length === 0) return
        continue
      }
      await Promise.allSettled(pending)
    }
  }
  return {
    ctx: ctx as never, tools, hooks, sent, deferred, policySections, emitted, session, domain,
    store: storageDomainStoreOf(ctx as never),
    emit: async (event: unknown) => {
      for (const h of handlers.get('session/event') ?? []) await h(session, event)
      await settle()
    },
    emitStatus: async (next: string) => {
      status = next
      for (const h of handlers.get('agent/status') ?? []) await h({ agent, status: next })
      await settle()
    },
    setStatus: (next: string) => { status = next },
    setUserAnswers: (answers) => { userAnswers = [...answers] },
    setEvents: (next) => { events = next },
    setOpenTurn: (start) => { openTurnStartSeq = start },
    record: (scope = 'session-1') => domain.recordsOf('processes').get(scope) as never,
    // 宿主 `ToolRunContext.deferContext`：把通告收在这里（真宿主会附到 tool/result 之后）。
    exec: () => ({ agent, deferContext: (message: unknown) => { deferred.push(message) } }),
  }
}

let host: FakeHost

beforeEach(() => {
  host = fakeHost()
  // 真机装配的形状：领域插件（provide ctx.workprocess）在前，工具与驱动器随后消费它。
  apply(host.ctx)
  applyTools(host.ctx)
  applyDriver(host.ctx, {})
})

const call = (tool: string, args: Record<string, unknown> = {}) => host.tools[tool].execute(args, host.exec())
const roundAccepted = (round: number): HostEvent => ({
  type: 'user/message', data: { source: { kind: 'work', round, taskId: 'wt:prep:1', revision: 1 } },
})

/**
 * 走**真路径**把当前阶段开工：空闲边界一拍（宿主信号 = `agent/status → idle`），
 * 然后回到 running（模型接着干活）。旧写法是直接调 `tickAtBoundary` 读 turnBoundary——
 * 那正是真机上"驱动器一枪不放"的病根，故这里也按真信号驱动。
 */
async function idleTick(h: FakeHost = host): Promise<void> {
  await h.emitStatus('idle')
  h.setStatus('running')
}

describe('插件装配面', () => {
  it('声明 name / inject，并按登记表注册六个工具（名字逐字一致）', () => {
    expect(name).toBe('workprocess')
    // 领域插件只 inject 存储域：工具面/驱动器各是独立插件、各有自己的 inject 表。
    expect(inject).toEqual(['storageDomain'])
    expect(Object.keys(host.tools).sort()).toEqual(WORK_TOOL_REGISTRY.map((e) => e.toolName).sort())
    // 事件订阅 = 领域插件（session/event）+ 驱动器（宿主 goal driver 同款那张表）。
    expect(host.hooks).toEqual([
      'agent/created', 'agent/disposed', 'agent/error', 'agent/status', 'work/changed',
      'session/event', 'agent/inbox/inserted', 'agent/inbox/claimed', 'agent/inbox/discarded',
    ])
  })

  it('归属记录域：声明合法，且快照的严格性由**内核解码器**在耐久边界把住', () => {
    expect(workprocessDomain.name).toBe('workprocess')
    expect(workprocessDomain.version).toBe(1)
    const schema = workprocessDomain.tables.processes.valueSchema
    expect(schema.parse({}).workProcess).toBeUndefined()
    const built = applyWorkEvent(undefined, {
      kind: 'init', id: 'wp:x', objective: 'x', stages: [{ key: 'prep', statement: '准备' }],
    })
    expect(built.changed).toBe(true)
    expect(schema.parse({ workProcess: built.next }).workProcess).toBeDefined()
    expect(() => schema.parse({ workProcess: { id: 'wp:x' } })).toThrow()
    expect(() => schema.parse({ workProcess: { ...built.next, revision: 0 } })).toThrow()
  })

  it('归属缺省 = 本会话：不传 scope 也能建流程、建任务、读回来；写真的进了域', async () => {
    expect(await call('create_workstage', { objective: '把模型发上线', stages: [{ key: 'prep', statement: '准备数据' }] }))
      .toMatchObject({ success: true, scope: 'session-1', created: true })
    expect(await call('create_worktask', { stage_key: 'prep', objective: '清洗数据' })).toMatchObject({ task_id: 'wt:prep:1' })
    const got = await call('get_workstage')
    expect(got).toMatchObject({ success: true, scope: 'session-1', current_stage: 'prep', allows_start: true })
    expect(host.domain.opened).toContain('workprocess')
    expect(host.domain.recordsOf('processes').has('session-1')).toBe(true)
  })

  it('幂等（changed:false）时一个字节都不写', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    const writesAfterCreate = host.domain.writes.length
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    expect(host.domain.writes.length).toBe(writesAfterCreate)
  })

  it('归属缺省不影响显式 scope（多流程并存时仍可指定）', async () => {
    await call('create_workstage', { scope: 'ws-other', objective: 'x', stages: [{ key: 'only', statement: '唯一阶段' }] })
    expect((await call('get_workstage', { scope: 'ws-other' })).scope).toBe('ws-other')
    expect((await call('get_workstage')).success).toBe(false)
  })
})

describe('真人判定（组合根接线之后）', () => {
  it('本回合没有人的发言 ⇒ human 策略的收口被拒（agent 只提议）', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    await call('create_worktask', { stage_key: 'prep', objective: '清洗数据' })
    await idleTick()
    await call('update_worktask', { task_id: 'wt:prep:1', action: 'complete' })
    expect((await call('update_workstage', { stage_key: 'prep', action: 'done' })).code).toBe('WORK_NO_PERMISSION')
  })

  it('本回合有人的消息 ⇒ 授权为 direct-human，收口落章', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    await call('create_worktask', { stage_key: 'prep', objective: '清洗数据' })
    await idleTick()
    await call('update_worktask', { task_id: 'wt:prep:1', action: 'complete' })
    host.setOpenTurn(0)
    host.setEvents([{}, { type: 'user/message', data: { source: { kind: 'user' } } }])
    expect(await call('update_workstage', { stage_key: 'prep', action: 'done' }))
      .toMatchObject({ success: true, close_policy: 'human', changed: true })
  })
})

describe('空闲边界驱动（开工 / auto 收口 / 只在 agent 空闲时动手）', () => {
  it('pending 阶段在空闲边界自动开工；auto 阶段任务齐了自动收口', async () => {
    await call('create_workstage', {
      objective: 'x', stages: [{ key: 'prep', statement: '准备', close_policy: 'auto' }],
    })
    await call('create_worktask', { stage_key: 'prep', objective: '清洗数据' })
    await host.emitStatus('idle')
    expect((await call('get_workstage')).stages).toMatchObject([{ state: 'active', close_policy: 'auto' }])
    await call('update_worktask', { task_id: 'wt:prep:1', action: 'complete' })
    await host.emitStatus('idle')
    expect((await call('get_workstage')).stages).toMatchObject([{ state: 'done' }])
  })

  it('agent 不空闲（running）⇒ 一拍都不动：改流程会和模型正在做的事打架', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    await host.emitStatus('running')
    expect((await call('get_workstage')).stages).toMatchObject([{ state: 'pending' }])
    // 会话事件兜底那条路也按 agent 状态判：running 时不动手
    await host.emit({ type: 'session/start' })
    expect((await call('get_workstage')).stages).toMatchObject([{ state: 'pending' }])
  })

  it('兜底：`agent/status` 那一拍错过时，会话事件到达且 agent 空闲 → 补一拍', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    host.setStatus('idle')
    await host.emit({ type: 'session/start' })
    expect((await call('get_workstage')).stages).toMatchObject([{ state: 'active' }])
  })
})

describe('续跑投递（drive）', () => {
  /** 起一条流程 + 一个任务（驱动配置由用例给）。 */
  async function seeded(config: Record<string, unknown> = { drive: true }) {
    const local = fakeHost()
    apply(local.ctx)
    applyTools(local.ctx)
    applyDriver(local.ctx, config)
    await local.tools.create_workstage.execute(
      { objective: '把模型发上线', stages: [{ key: 'prep', statement: '准备' }] }, local.exec(),
    )
    await local.tools.create_worktask.execute({ stage_key: 'prep', objective: '清洗数据' }, local.exec())
    return local
  }

  it('一个空闲边界内 **开工 + 投一轮**（source 自署 work，绝不冒充人）；同一轮不重复投', async () => {
    const h = await seeded()
    await h.emitStatus('idle')
    // 一拍只推进一件事，但空闲边界只来一次：开工之后必须接着投，否则流程停在那儿（真机症状）。
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].source).toMatchObject({ kind: 'work', processId: 'wp:session-1', taskId: 'wt:prep:1', revision: 1, round: 1 })
    const text = JSON.stringify(h.sent[0].content)
    expect(text).toContain('清洗数据')      // 提示词里带着本轮任务
    expect(text).toContain('不越阶段开工')   // 边界也在
    await h.emitStatus('idle')             // 还没接手：同一轮不重复投
    expect(h.sent).toHaveLength(1)
  })

  it('drive 关着（缺省）⇒ 一轮都不投，但开工/收口照做', async () => {
    const h = await seeded({})
    await h.emitStatus('idle')
    expect(h.sent).toHaveLength(0)
    const stages = await h.tools.get_workstage.execute({}, h.exec())
    expect(stages.stages).toMatchObject([{ state: 'active' }])
  })

  it('回合被接手 ⇒ 计数耐久前进；到上限落盘 block 并停止投递', async () => {
    const h = await seeded({ drive: true, defaultMaxRounds: 1 })
    await h.emitStatus('idle')              // 开工 + 投第 1 轮
    expect(h.sent).toHaveLength(1)
    await h.emit(roundAccepted(1))          // 宿主侧：这条回合消息被接受
    expect(h.record()?.rounds?.started).toBe(1)
    await h.emitStatus('idle')              // 到上限 ⇒ 落盘 block（不再投第 2 轮）
    expect(h.sent).toHaveLength(1)
    const tasks = await h.tools.get_worktask.execute({ stage_key: 'prep' }, h.exec())
    expect(tasks.tasks).toMatchObject([{ id: 'wt:prep:1', phase: 'blocked' }])
    expect(String((tasks.tasks as Array<{ blocked_message?: string }>)[0].blocked_message)).toContain('达到上限')
  })

  it('人的消息不是回合（计数不动）；旧回合重放也零写入', async () => {
    const h = await seeded({ drive: true, defaultMaxRounds: 5 })
    await h.emit({ type: 'user/message', data: { source: { kind: 'user' } } })
    expect(h.record()?.rounds?.started ?? 0).toBe(0)
    await h.emit(roundAccepted(2))
    expect(h.record()?.rounds?.started).toBe(2)
    const writes = h.domain.writes.length
    await h.emit(roundAccepted(2))           // 重复观察旧回合：零写入
    expect(h.domain.writes.length).toBe(writes)
  })
})

describe('阶段规划轮（阶段开工了却没任务 ⇒ 让 agent 建任务）', () => {
  /** 起一条流程（**不建任务**：模拟"刚跨过阶段边界"的新阶段）。 */
  async function seededEmpty(config: Record<string, unknown> = { drive: true }) {
    const local = fakeHost()
    apply(local.ctx)
    applyTools(local.ctx)
    applyDriver(local.ctx, config)
    await local.tools.create_workstage.execute(
      { objective: '实现一个俄罗斯方块小游戏', stages: [{ key: 'ui', statement: '界面与交互' }] }, local.exec(),
    )
    return local
  }

  it('一个空闲边界内：开工 + 投规划轮（请 agent 用 create_worktask 建本阶段任务）', async () => {
    const h = await seededEmpty()
    await h.emitStatus('idle')
    expect(h.sent).toHaveLength(1)
    const text = JSON.stringify(h.sent[0].content)
    expect(text).toContain('阶段规划轮')
    expect(text).toContain('create_worktask')
    expect(text).toContain('界面与交互')
    // 来源自署 work；**不带 round**（规划轮不消耗任务预算，不推进 rounds.started）
    expect(h.sent[0].source).toMatchObject({ kind: 'work', processId: 'wp:session-1', stageKey: 'ui' })
    expect(h.sent[0].source.round).toBeUndefined()
    expect(h.record()?.rounds?.started ?? 0).toBe(0)
  })

  it('同一阶段只问一次：再空闲也不重复投（不空转），把"阶段空着"留给人和状态面', async () => {
    const h = await seededEmpty()
    await h.emitStatus('idle')
    await h.emitStatus('idle')
    await h.emitStatus('idle')
    expect(h.sent).toHaveLength(1)
    // 阶段确实开工了（不是没动），只是没人接活
    expect((await h.tools.get_workstage.execute({}, h.exec())).stages).toMatchObject([{ state: 'active' }])
  })

  it('drive 关着 ⇒ 开工照做、规划轮不投（规划是"替 agent 起话头"，属于自动投递）', async () => {
    const h = await seededEmpty({})
    await h.emitStatus('idle')
    expect(h.sent).toHaveLength(0)
    expect((await h.tools.get_workstage.execute({}, h.exec())).stages).toMatchObject([{ state: 'active' }])
  })
})

describe('收口确认轮（任务全达成 + 策略 human ⇒ 请人拍板，而不是安静地停住）', () => {
  /** 起一条流程 + 一个任务并把它做完（策略由用例给）。 */
  async function seededDone(policy: 'human' | 'auto' = 'human') {
    const local = fakeHost()
    apply(local.ctx)
    applyTools(local.ctx)
    applyDriver(local.ctx, { drive: true })
    await local.tools.create_workstage.execute({
      objective: '实现一个俄罗斯方块小游戏',
      stages: [{ key: 'ui', statement: '界面与交互', close_policy: policy }],
    }, local.exec())
    await local.tools.create_worktask.execute({ stage_key: 'ui', objective: '画棋盘' }, local.exec())
    await local.emitStatus('idle')                       // 开工 + 投任务轮
    await local.tools.update_worktask.execute({ task_id: 'wt:ui:1', action: 'complete' }, local.exec())
    local.sent.length = 0                                 // 只关心收口这一段
    return local
  }

  it('策略 human：投一轮请 agent 向人确认（说清"done 由人落"，并给出落章路径）', async () => {
    const h = await seededDone('human')
    await h.emitStatus('idle')
    expect(h.sent).toHaveLength(1)
    const text = JSON.stringify(h.sent[0].content)
    expect(text).toContain('阶段收口待人工确认')
    expect(text).toContain('ask_user_question')
    expect(text).toContain('update_workstage')
    expect(text).toContain('ui')
    expect(h.sent[0].source).toMatchObject({ kind: 'work', processId: 'wp:session-1', stageKey: 'ui' })
    expect(h.sent[0].source.round).toBeUndefined()
    // 阶段**没有**被自己收口（human 策略：agent 只提议，done 由人落）
    expect((await h.tools.get_workstage.execute({}, h.exec())).stages).toMatchObject([{ state: 'active' }])
  })

  it('同一件事只问一次：人还没答，不重复投（不刷屏）', async () => {
    const h = await seededDone('human')
    await h.emitStatus('idle')
    await h.emitStatus('idle')
    await h.emitStatus('idle')
    expect(h.sent).toHaveLength(1)
  })

  it('策略 auto：驱动器自己收口，**不**投阶段确认轮；缺省 close:auto ⇒ 流程顺手收口', async () => {
    const h = await seededDone('auto')
    await h.emitStatus('idle')
    // 阶段被驱动器自动收口（没问人）
    expect((await h.tools.get_workstage.execute({}, h.exec())).stages).toMatchObject([{ state: 'done' }])
    // 缺省 close:'auto'：全阶段 done ⇒ 驱动器直接落 process-close——**不投**"流程级请判轮"
    expect(h.sent).toHaveLength(0)
    expect((h.record()?.workProcess as { closedAt?: number }).closedAt).toBeDefined()
  })
})

describe('模型面指令（对齐宿主 tool-goal：策略段 + 工具回执之后的通告）', () => {
  it('注册常驻策略段（tool:workprocess，槽位紧随 TOOL_GOAL）——工具自述之外的那几条纪律', () => {
    expect(host.policySections).toHaveLength(1)
    expect(host.policySections[0].name).toBe('tool:workprocess')
    expect(host.policySections[0].order).toBe(2400)
    expect(host.policySections[0].text).toContain('阶段严格串行')
    expect(host.policySections[0].text).toContain('只提议')
    expect(host.policySections[0].text).toContain('max_rounds')
  })

  it('任务达成 ⇒ 把收尾通告附在回执之后（自署 work-tool：**不是人**，不冒领授权）', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    await call('create_worktask', { stage_key: 'prep', objective: '清洗数据' })
    await call('update_worktask', { task_id: 'wt:prep:1', action: 'complete' })

    expect(host.deferred).toHaveLength(1)
    const message = host.deferred[0] as { content: Array<{ text: string }>; source: Record<string, unknown> }
    expect(message.content[0].text).toContain('到此为止')
    expect(message.source).toMatchObject({ kind: 'work-tool', form: 'notice' })
    expect(String(message.source.summary)).toContain('wt:prep:1')
    // 授权面只认 `user`（人）与 `work`（自动回合）：这条通告两边都不是 ⇒ 不授任何权限。
    expect(message.source.kind).not.toBe('user')
    expect(message.source.kind).not.toBe('work')
  })

  it('幂等重放不发通告：没发生的事不被说成发生了', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    await call('create_worktask', { stage_key: 'prep', objective: '清洗数据' })
    await call('update_worktask', { task_id: 'wt:prep:1', action: 'complete' })
    host.deferred.length = 0
    await call('update_worktask', { task_id: 'wt:prep:1', action: 'complete' })
    expect(host.deferred).toHaveLength(0)
  })
})

describe('人机确认接线（工具自己问人：宿主 userQuestions）', () => {
  /** 建一条流程 + 一个任务并做完（策略 human，agent 自治）。 */
  async function readyToClose() {
    const local = fakeHost()
    apply(local.ctx)
    applyTools(local.ctx)
    applyDriver(local.ctx, {})
    await local.tools.create_workstage.execute(
      { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] }, local.exec(),
    )
    await startWorkStage({ store: local.store, now: () => 1_000 }, 'session-1', 'prep')
    await local.tools.create_worktask.execute({ stage_key: 'prep', objective: '清洗数据' }, local.exec())
    await local.tools.update_worktask.execute({ task_id: 'wt:prep:1', action: 'complete' }, local.exec())
    return local
  }

  it('agent 提请收口 ⇒ 工具弹框；人确认才落章（不靠模型转述人的答复）', async () => {
    const h = await readyToClose()
    h.setUserAnswers([{ id: 'workprocess-stage-done:prep', selected: ['确认收口'] }])
    const out = await h.tools.update_workstage.execute({ stage_key: 'prep', action: 'done' }, h.exec())
    expect(out).toMatchObject({ success: true, changed: true })
    expect((await h.tools.get_workstage.execute({}, h.exec())).stages)
      .toMatchObject([{ key: 'prep', state: 'done' }])
  })

  it('人选择「还要补做」⇒ 不收口，人的话原样转达', async () => {
    const h = await readyToClose()
    h.setUserAnswers([{ id: 'workprocess-stage-done:prep', selected: ['还要补做'], custom: '再加个暂停' }])
    const out = await h.tools.update_workstage.execute({ stage_key: 'prep', action: 'done' }, h.exec())
    expect(out).toMatchObject({ success: false, code: 'WORK_HUMAN_DECLINED' })
    expect(String(out.error)).toContain('再加个暂停')
    expect((await h.tools.get_workstage.execute({}, h.exec())).stages)
      .toMatchObject([{ key: 'prep', state: 'active' }])
  })

  it('人打断去说话（ASK_CANCELLED）⇒ 不收口、也不当成同意', async () => {
    const h = await readyToClose()
    h.setUserAnswers(['ASK_CANCELLED'])
    const out = await h.tools.update_workstage.execute({ stage_key: 'prep', action: 'done' }, h.exec())
    expect(out).toMatchObject({ success: false, code: 'WORK_HUMAN_UNAVAILABLE' })
    expect((await h.tools.get_workstage.execute({}, h.exec())).stages)
      .toMatchObject([{ key: 'prep', state: 'active' }])
  })

  it('没有 answerer（NO_PROVIDER）⇒ 退回"拒绝并指路"，不假装问过', async () => {
    const h = await readyToClose()
    h.setUserAnswers(['NO_PROVIDER'])
    const out = await h.tools.update_workstage.execute({ stage_key: 'prep', action: 'done' }, h.exec())
    expect(out).toMatchObject({ success: false, code: 'WORK_NO_PERMISSION' })
  })
})

/** 读回收口测试要看的流程字段（record() 的 workProcess 是 unknown，集中一处收窄）。 */
function processOf(h: FakeHost): { closedAt?: number; stages: Array<{ state: string }> } {
  return h.record()?.workProcess as { closedAt?: number; stages: Array<{ state: string }> }
}

describe('流程收口（close: auto 缺省 / human 显式）', () => {
  /** 起一条单阶段流程并把它做完（auto 收口，配置由用例给）。 */
  async function seededFinished(config: Record<string, unknown> = {}) {
    const local = fakeHost()
    apply(local.ctx)
    applyTools(local.ctx)
    applyDriver(local.ctx, { drive: true, ...config })
    await local.tools.create_workstage.execute(
      { objective: '实现一个俄罗斯方块小游戏', stages: [{ key: 'only', statement: '唯一阶段', close_policy: 'auto' }] },
      local.exec(),
    )
    await local.tools.create_worktask.execute({ stage_key: 'only', objective: '干活' }, local.exec())
    await local.tools.update_worktask.execute({ task_id: 'wt:only:1', action: 'complete' }, local.exec())
    local.sent.length = 0
    return local
  }

  it('close: auto（缺省）：最后一段 done ⇒ 一个空闲边界内收口 stage + 落 process-close，不再投任何轮', async () => {
    const h = await seededFinished()
    await h.emitStatus('idle')
    expect(h.sent).toHaveLength(0)                        // 不问人、不投请判轮
    expect(processOf(h).closedAt).toBeDefined()          // 终止水印落盘
    expect(processOf(h).stages[0].state).toBe('done')
    // 收口后再空闲：hold('process-closed')，零写入零投递
    const writes = h.domain.writes.length
    await h.emitStatus('idle')
    expect(h.sent).toHaveLength(0)
    expect(h.domain.writes.length).toBe(writes)
  })

  it('close: human（显式）：全阶段 done ⇒ 投一次「流程级请判」轮；不再自动收口（方案 B 口径）', async () => {
    const h = await seededFinished({ close: 'human' })
    await h.emitStatus('idle')
    expect(processOf(h).closedAt).toBeUndefined()               // 不自动落 close
    expect(h.sent).toHaveLength(1)
    const text = JSON.stringify(h.sent[0].content)
    expect(text).toContain('流程收口待人工判断')
    // 问过一次不再问
    await h.emitStatus('idle')
    expect(h.sent).toHaveLength(1)
  })

  it('已收口的流程：一切写被拒（task-create 零写入），重建须先 discard', async () => {
    const h = await seededFinished()
    await h.emitStatus('idle')
    const out = await h.tools.create_worktask.execute({ stage_key: 'only', objective: '再干一件' }, h.exec())
    // 零写入被闸住（注：createWorktask 的 changed:false 回执不带 reason 是既有缺口，所有零写入路径皆然）
    expect(out).toMatchObject({ success: true, changed: false })
    // discard 照旧可用（服务层动作，不经事件表）。真人专属授权需要"开放回合 + 人的消息"两件套：
    h.setStatus('running')
    h.setOpenTurn(0)
    h.setEvents([{}, { type: 'user/message', data: { source: { kind: 'user' } } }])
    expect(await h.tools.update_workstage.execute({ action: 'discard' }, h.exec())).toMatchObject({ success: true, changed: true })
    expect(h.record()?.workProcess).toBeUndefined()
  })
})

describe('work/changed 宿主事件（对齐 goal/changed：写路径统一从组合根进事件总线）', () => {
  it('有效写入 ⇒ emit work/changed（scope + 事件 + 全量快照，与耐久状态同源）', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    await call('create_worktask', { stage_key: 'prep', objective: '清洗数据' })
    const changes = host.emitted.filter((e) => e.name === 'work/changed' && (e.payload as { change: unknown }).change !== undefined)
    expect(changes.length).toBe(2)                       // init + task-create
    const first = changes[0].payload as { scope: string; change: { event: { kind: string }; process: { revision: number } } }
    expect(first.scope).toBe('session-1')
    expect(first.change.event.kind).toBe('init')
    expect(first.change.process.revision).toBe(1)
    const second = changes[1].payload as { change: { event: { kind: string } } }
    expect(second.change.event.kind).toBe('task-create')
  })

  it('幂等零写入 ⇒ 不发事件（changed:false 没有变更就没有事件）', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    host.emitted.length = 0
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    expect(host.emitted.filter((e) => e.name === 'work/changed')).toHaveLength(0)
  })

  it('discard ⇒ 发墓碑（change = undefined）——丢弃不经事件表，单独报', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    host.emitted.length = 0
    // 真人专属授权的两件套
    host.setStatus('running')
    host.setOpenTurn(0)
    host.setEvents([{}, { type: 'user/message', data: { source: { kind: 'user' } } }])
    await call('update_workstage', { action: 'discard' })
    const tomb = host.emitted.filter((e) => e.name === 'work/changed')
    expect(tomb).toHaveLength(1)
    expect((tomb[0].payload as { scope: string; change: unknown }).change).toBeUndefined()
    expect((tomb[0].payload as { scope: string }).scope).toBe('session-1')
  })

  it('驱动拍的机械动作也发事件（开工 stage-start 经内核写路径）', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    host.emitted.length = 0
    await host.emitStatus('idle')
    const kinds = host.emitted
      .map((e) => (e.payload as { change?: { event: { kind: string } } }).change?.event.kind)
      .filter(Boolean)
    expect(kinds).toContain('stage-start')
  })
})
