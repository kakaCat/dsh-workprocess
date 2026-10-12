/**
 * tool-workprocess · 工具壳（`defineTool` 协议面）。
 *
 * 【守护什么】
 *   ① 登记表是唯一手写清单：工厂键集合 == 登记表的 `handler` 集合，且**名字与自述逐字取自上表**
 *      （改一处忘另一处即红）；
 *   ② 协议面真的通：`execute` 从建流程一路走到由人确认，回执字段与处理器同源；
 *   ③ 真人专属动作在**协议面**也被拦（不是只在处理器里拦）；
 *   ④ **模型面措辞**（对齐宿主 `dsh-tool-goal`）：自述是"给模型看的一句话"——单行、无内部术语、
 *      取数来源点名到具体工具、语义只写一处（`update_*` 的权限/不可逆性归 `action` 的 enum）。
 */
import { describe, it, expect } from 'vitest'
import { WORK_TOOL_REGISTRY, workPolicyText } from 'tool-workprocess'
import { STAGE_ACTIONS, WORK_TOOL_FACTORIES } from 'tool-workprocess'
import type { WorkToolDeps } from 'tool-workprocess'
import type { WorkRecordLike, WorkStoreLike } from 'workprocess'
import { createWorkprocessService, startWorkStage } from 'workprocess'

interface ToolLike {
  name?: string
  description?: string
  /** 编译后的参数 JSON Schema（`defineTool` 原样透出；模型看到的就是它）。 */
  parameters?: { properties: Record<string, { description?: string }> }
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

  it('回执渲染必须是内容块数组（宿主口径）：返回裸字符串会在宿主侧炸', () => {
    const tools = allTools(depsOf({ 'ws-a': { updatedAt: 1 } }))
    for (const entry of WORK_TOOL_REGISTRY) {
      const output = (tools[entry.handler] as { output?: { render?: (a: unknown, v: unknown) => unknown } }).output
      const blocks = output?.render?.({}, { success: true, stages: [{ state: 'done' }] }) as Array<{ type?: string; text?: string }>
      expect(Array.isArray(blocks), entry.toolName + ' 的 render 必须返回数组').toBe(true)
      expect(blocks[0]).toMatchObject({ type: 'text' })
      expect(typeof blocks[0].text).toBe('string')
      // 渲染的是**第二个**形参（宿主口径 render(args, value)）：读成第一个只会渲染出一行"未成功"。
      expect(String(blocks[0].text)).toContain('已收口')
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

  it('回执给的 revision 必须能**直接**用于下一句（create_worktask 给聚合修订，不是任务自己的）', async () => {
    // 真机陷阱（实测出来的）：`create_worktask` 原来把**新建任务自己的** revision（恒为 1）当 `revision`
    // 回给模型，而 `update_worktask` 的 `revision` 参数校的是**聚合**修订 ⇒ 模型照着回执递 CAS
    // 必得 `WORK_CONFLICT`（"期望 revision=1，当前=3"）。回执里的数必须能直接喂给下一句。
    const records = { 'ws-a': { updatedAt: 1 } }
    const human = allTools(depsOf(records, true))
    await human.createWorkstage.execute({ scope: 'ws-a', objective: 'x', stages: STAGES })
    const created = await human.createWorktask.execute({ scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })
    const stage = await human.getWorkstage.execute({ scope: 'ws-a' })
    expect(created.revision, '建任务回执的 revision 必须与阶段面读到的聚合修订一致').toBe(stage.revision)
    expect(await human.updateWorktask.execute({
      scope: 'ws-a', task_id: created.task_id, action: 'complete', revision: created.revision,
    })).toMatchObject({ success: true, changed: true })
  })

  it('真人专属动作在协议面也被拦（缺省 human 策略的 stage_done / task_edit / task_resume）', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const agent = allTools(depsOf(records))
    await agent.createWorkstage.execute({ scope: 'ws-a', objective: 'x', stages: STAGES })
    await agent.createWorktask.execute({ scope: 'ws-a', stage_key: 'prep', objective: '清洗数据' })

    expect((await agent.updateWorkstage.execute({ scope: 'ws-a', stage_key: 'prep', action: 'done' })).code).toBe('WORK_NO_PERMISSION')
    expect((await agent.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:1', action: 'resume' })).code).toBe('WORK_NO_PERMISSION')
    expect((await agent.updateWorktask.execute({ scope: 'ws-a', task_id: 'wt:prep:1', action: 'edit', objective: 'x' })).code).toBe('WORK_NO_PERMISSION')
  })
})

describe('工具 schema 与运行期白名单同源（防"改了白名单忘了 schema"）', () => {
  it('update_workstage 的 action enum 必须逐字等于 STAGE_ACTIONS', () => {
    const deps = { domain: {} as never, defaultScope: () => 'ws-a' } as never
    const tool = WORK_TOOL_FACTORIES.updateWorkstage(deps) as {
      parameters?: { properties?: { action?: { enum?: readonly string[] } } }
    }
    expect(tool.parameters?.properties?.action?.enum).toEqual([...STAGE_ACTIONS])
  })
})

describe('模型面措辞 · 对齐宿主 tool-goal 的写法', () => {
  /** 内部术语（模型没有这些上下文，出现在模型面就是噪声）。 */
  const JARGON = ['层0', '层1', '层2', '相位', '组合根', 'CAS']
  /** 自述是"一句话"：超过这个长度说明又开始往里塞语义了（语义该在 enum 里）。 */
  const DESC_MAX = 160

  const toolsWith = (extra?: Partial<WorkToolDeps>) =>
    allTools({ ...depsOf({ 'ws-a': { updatedAt: 1 } }), ...extra })
  const propsOf = (tools: Record<string, ToolLike>, handler: string) =>
    tools[handler].parameters?.properties ?? {}
  const descOf = (tools: Record<string, ToolLike>, handler: string) => String(tools[handler].description)

  it('自述：单行、不超长、无内部术语', () => {
    const tools = toolsWith()
    for (const entry of WORK_TOOL_REGISTRY) {
      const text = descOf(tools, entry.handler)
      expect(text.includes('\n'), entry.toolName + ' 的自述必须单行').toBe(false)
      expect(text.length, entry.toolName + ' 的自述过长（语义该写进参数的 enum）').toBeLessThanOrEqual(DESC_MAX)
      for (const word of JARGON) {
        expect(text.includes(word), entry.toolName + ' 的自述里出现了内部术语 ' + word).toBe(false)
      }
    }
  })

  it('参数描述：都有字、无内部术语、取数来源点名到具体工具', () => {
    const tools = toolsWith()
    for (const entry of WORK_TOOL_REGISTRY) {
      for (const [param, spec] of Object.entries(propsOf(tools, entry.handler))) {
        const text = String(spec.description ?? '')
        const at = entry.toolName + '.' + param
        expect(text.length, at + ' 缺参数描述').toBeGreaterThan(0)
        for (const word of JARGON) {
          expect(text.includes(word), at + ' 的描述里出现了内部术语 ' + word).toBe(false)
        }
      }
    }
    // 取数来源点名（goal 的 `Exact id returned by get_goal`）：凡是要"从别处读来的值"，
    // 都必须写清去哪个工具的回执取——原来六个工具共用一句"给 get 里读到的 revision"，指错层是必然的。
    const wiring: readonly (readonly [string, string, string])[] = [
      ['updateWorkstage', 'revision', 'get_workstage'],
      ['updateWorkstage', 'stage_key', 'get_workstage'],
      ['updateWorktask', 'revision', 'get_worktask'],
      ['updateWorktask', 'task_id', 'get_worktask'],
      ['createWorktask', 'stage_key', 'get_workstage'],
      ['getWorktask', 'stage_key', 'get_workstage'],
    ]
    for (const [handler, param, source] of wiring) {
      expect(String(propsOf(tools, handler)[param]?.description), handler + '.' + param + ' 必须点名取数来源')
        .toContain(source)
    }
  })

  it('语义只写一处：update_* 的权限 / 不可逆性归 action 的 enum，自述不重复', () => {
    // 每个 update 工具：enum 必须拥有这些语义读点，自述**一律不许**出现（两处都写必然漂移）。
    const owned: readonly (readonly [string, readonly string[]])[] = [
      ['updateWorkstage', ['真人专属', '不可逆', 'close_policy']],
      ['updateWorktask', ['真人专属', '不可逆']],
    ]
    const tools = toolsWith()
    for (const [handler, tokens] of owned) {
      const enumText = String(propsOf(tools, handler).action?.description ?? '')
      const selfText = descOf(tools, handler)
      for (const token of tokens) {
        expect(enumText, handler + ' 的 action 描述必须写清 ' + token).toContain(token)
        expect(selfText.includes(token), handler + ' 的自述不许重复 enum 的语义（' + token + '）').toBe(false)
      }
    }
  })

  it('block 门槛数字由配置渲染（自述与策略段同源，不写死 3）', () => {
    const tools = toolsWith()
    const at = (tools: Record<string, ToolLike>) => String(propsOf(tools, 'updateWorktask').action?.description ?? '')
    // 缺省 = 3：自述与策略段说的是同一个数。
    expect(at(tools)).toContain('撑过 3 轮')
    expect(workPolicyText(3)).toContain('撑过 3 轮')
    // 配成 5 ⇒ 两处都必须跟着变成 5（写死就会教模型按一个错的数去试，白跑一轮）。
    const five = toolsWith({ blockedAfterRounds: 5 })
    expect(at(five)).toContain('撑过 5 轮')
    expect(at(five).includes('3 轮')).toBe(false)
    expect(workPolicyText(5)).toContain('撑过 5 轮')
    expect(workPolicyText(5).includes('3 轮')).toBe(false)
  })
})
