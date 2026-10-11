/**
 * dsh-workprocess 插件：**装配面**（六个工具真注册）+ 归属缺省（本会话）+ 真人判定 +
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
import { apply, name, inject, storageDomainStoreOf, workprocessDomain, tickAtBoundary } from 'dsh-workprocess'
import { WORK_TOOL_REGISTRY } from 'tool-workprocess'
import { applyWorkEvent } from 'workprocess'

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
  session: { id: string; snapshotEvents(): readonly HostEvent[] }
  domain: ReturnType<typeof fakeDomainFacility>
  /** 投一条会话事件（走插件真挂上的 handler，等它跑完）。 */
  emit(event: unknown): Promise<void>
  setEvents(events: readonly HostEvent[]): void
  setOpenTurn(start: number | null): void
  record(scope?: string): { workProcess?: unknown; rounds?: { started?: number } } | undefined
  exec(): unknown
}

function fakeHost(): FakeHost {
  let events: readonly HostEvent[] = []
  let openTurnStartSeq: number | null = null
  const sent: Sent[] = []
  const handlers: Array<(s: unknown, e: unknown) => void | Promise<void>> = []
  const session = { id: 'session-1', snapshotEvents: () => events }
  const agent = {
    id: 'session-1', status: 'running', session,
    // 语义等价于宿主的 `agent.followup(message)`：留住投出去的那条，供断言。
    followup: (message: unknown): void => { sent.push(message as Sent) },
  }
  const tools: Record<string, ToolLike> = {}
  const hooks: string[] = []
  const domain = fakeDomainFacility()
  const ctx = {
    agents: { get: (id: string) => (id === agent.id ? agent : undefined), currentInitiator: () => agent },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq }) },
    storageDomain: domain.facility,
    tools: { register: (t: unknown) => { const tool = t as { name: string } & ToolLike; tools[tool.name] = tool; return (): void => {} } },
    on: (event: string, cb: (s: unknown, e: unknown) => void | Promise<void>) => { hooks.push(event); handlers.push(cb) },
    // 宿主 cordis 的服务注册口（本插件把 `ctx.workprocess` 提供出去，命令行包消费它）。
    provide: (serviceName: string, value: unknown) => { (ctx as Record<string, unknown>)[serviceName] = value; return undefined },
  }
  return {
    ctx: ctx as never, tools, hooks, sent, session, domain,
    store: storageDomainStoreOf(ctx as never),
    emit: async (event: unknown) => { for (const h of handlers) await h(session, event) },
    setEvents: (next) => { events = next },
    setOpenTurn: (start) => { openTurnStartSeq = start },
    record: (scope = 'session-1') => domain.recordsOf('processes').get(scope) as never,
    exec: () => ({ agent }),
  }
}

let host: FakeHost

beforeEach(() => {
  host = fakeHost()
  apply(host.ctx, {})
})

const call = (tool: string, args: Record<string, unknown> = {}) => host.tools[tool].execute(args, host.exec())
const idle = { type: 'session/start' }
const roundAccepted = (round: number): HostEvent => ({
  type: 'user/message', data: { source: { kind: 'work', round, taskId: 'wt:prep:1', revision: 1 } },
})

describe('插件装配面', () => {
  it('声明 name / inject，并按登记表注册六个工具（名字逐字一致）', () => {
    expect(name).toBe('workprocess')
    expect(inject).toEqual(['agents', 'tools', 'sessionProjections', 'storageDomain'])
    expect(Object.keys(host.tools).sort()).toEqual(WORK_TOOL_REGISTRY.map((e) => e.toolName).sort())
    expect(host.hooks).toEqual(['session/event'])
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
    await tickAtBoundary(host.ctx, host.store, host.session)
    await call('update_worktask', { task_id: 'wt:prep:1', action: 'complete' })
    expect((await call('update_workstage', { stage_key: 'prep', action: 'done' })).code).toBe('WORK_NO_PERMISSION')
  })

  it('本回合有人的消息 ⇒ 授权为 direct-human，收口落章', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    await call('create_worktask', { stage_key: 'prep', objective: '清洗数据' })
    await tickAtBoundary(host.ctx, host.store, host.session)
    await call('update_worktask', { task_id: 'wt:prep:1', action: 'complete' })
    host.setOpenTurn(0)
    host.setEvents([{}, { type: 'user/message', data: { source: { kind: 'user' } } }])
    expect(await call('update_workstage', { stage_key: 'prep', action: 'done' }))
      .toMatchObject({ success: true, close_policy: 'human', changed: true })
  })
})

describe('回合边界驱动（开工 / auto 收口 / 空闲才动手）', () => {
  it('pending 阶段在边界上自动开工；auto 阶段任务齐了自动收口', async () => {
    await call('create_workstage', {
      objective: 'x', stages: [{ key: 'prep', statement: '准备', close_policy: 'auto' }],
    })
    await call('create_worktask', { stage_key: 'prep', objective: '清洗数据' })
    host.setOpenTurn(null)
    await tickAtBoundary(host.ctx, host.store, host.session)
    expect((await call('get_workstage')).stages).toMatchObject([{ state: 'active', close_policy: 'auto' }])
    await call('update_worktask', { task_id: 'wt:prep:1', action: 'complete' })
    await tickAtBoundary(host.ctx, host.store, host.session)
    expect((await call('get_workstage')).stages).toMatchObject([{ state: 'done' }])
  })

  it('活动轮次（有开放回合）不动手：改流程会和模型正在做的事打架', async () => {
    await call('create_workstage', { objective: 'x', stages: [{ key: 'prep', statement: '准备' }] })
    host.setOpenTurn(7)
    await tickAtBoundary(host.ctx, host.store, host.session)
    expect((await call('get_workstage')).stages).toMatchObject([{ state: 'pending' }])
  })
})

describe('续跑投递（drive）', () => {
  /** 起一条流程 + 一个任务（驱动配置由用例给）。 */
  async function seeded(config: Record<string, unknown> = { drive: true }) {
    const local = fakeHost()
    apply(local.ctx, config)
    await local.tools.create_workstage.execute(
      { objective: '把模型发上线', stages: [{ key: 'prep', statement: '准备' }] }, local.exec(),
    )
    await local.tools.create_worktask.execute({ stage_key: 'prep', objective: '清洗数据' }, local.exec())
    return local
  }

  it('空闲边界投一轮：source 自署 work（绝不冒充人）、同一轮不重复投', async () => {
    const h = await seeded()
    await h.emit(idle)                     // 第一拍：开工（没有可投的轮）
    expect(h.sent).toHaveLength(0)
    await h.emit(idle)                     // 第二拍：该跑了 → 投一轮
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].source).toMatchObject({ kind: 'work', processId: 'wp:session-1', taskId: 'wt:prep:1', revision: 1, round: 1 })
    const text = JSON.stringify(h.sent[0].content)
    expect(text).toContain('清洗数据')      // 提示词里带着本轮任务
    expect(text).toContain('不越阶段开工')   // 边界也在
    await h.emit(idle)                     // 还没接手：同一轮不重复投
    expect(h.sent).toHaveLength(1)
  })

  it('drive 关着（缺省）⇒ 一拍都不投，只做开工/收口', async () => {
    const h = await seeded({})
    await h.emit(idle)
    await h.emit(idle)
    expect(h.sent).toHaveLength(0)
  })

  it('回合被接手 ⇒ 计数耐久前进；到上限落盘 block 并停止投递', async () => {
    const h = await seeded({ drive: true, defaultMaxRounds: 1 })
    await h.emit(idle)                      // 开工
    await h.emit(idle)                      // 投第 1 轮
    expect(h.sent).toHaveLength(1)
    await h.emit(roundAccepted(1))          // 宿主侧：这条回合消息被接受
    expect(h.record()?.rounds?.started).toBe(1)
    await h.emit(idle)                      // 到上限 ⇒ 落盘 block（不再投第 2 轮）
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
