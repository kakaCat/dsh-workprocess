/**
 * **不变量伴生插件**的契约测试（对齐宿主 `dsh-goal/lib/invariant.js` 的两件事）：
 *   ① **发布前的流校验**：`internal/dispatch` 拦下每一格 `work/changed`，用影子折叠验证
 *      "事件能把上一份快照折成载荷里那一份"——漏发 / 乱序 / 事件与快照不一致都在这里现形；
 *   ② **启动时重放已落盘历史**：审计整张表，发现即点名本包；通过审计的快照用来给影子状态播种。
 *
 * 载荷不手工造：全部由**真内核**写出来（`createWorkProcess` / `startWorkStage` 触发的通知就是
 * 线上同形的 `work/changed` 载荷）。
 */
import { describe, it, expect } from 'vitest'
import { createWorkProcess, startWorkStage } from 'workprocess'
import type { WorkChangedPayload } from 'workprocess'
import { apply, inject, name } from 'workprocess/invariant-plugin.js'
import type { WorkRecordLike } from 'workprocess'

/** 假 store（记录要先存在，与内核测试同口径）。 */
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

/** 用真内核写出一条真载荷序列（`[init, stage-start, …]`）。 */
async function realPayloads(): Promise<WorkChangedPayload[]> {
  const records: Record<string, WorkRecordLike> = { 'ws-a': { updatedAt: 1 } }
  const out: WorkChangedPayload[] = []
  const deps = {
    store: storeOf(records) as never,
    now: () => 1_000,
    onChanged: (n: { scope: string; change: unknown }) => { out.push({ scope: n.scope, change: n.change as WorkChangedPayload['change'] }) },
  }
  await createWorkProcess(deps, 'ws-a', { objective: '把模型发上线', stages: [{ key: 'p', statement: '准备' }] })
  await startWorkStage(deps, 'ws-a', 'p')
  return out
}

/** 假宿主：invariants 服务 + `workprocess` 服务 + 事件总线。 */
function harness(options: { snapshots?: readonly { scope: string; process: unknown }[]; findings?: readonly { scope: string; problem: string }[] } = {}) {
  const fails: string[] = []
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  let installer: (((ctx: unknown, fail: (m: string) => never) => unknown) & { inject?: readonly string[] }) | undefined
  let registered: string | undefined
  const domain = {
    audit: async () => ({ findings: options.findings ?? [], snapshots: options.snapshots ?? [] }),
  }
  const ctx = {
    get: (serviceName: string) => (serviceName === 'invariants'
      ? { register: (pkg: string, inst: typeof installer) => { registered = pkg; installer = inst; return () => {} } }
      : undefined),
    workprocess: domain,
    on: (eventName: string, cb: (...args: unknown[]) => unknown) => {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), cb])
      return () => {}
    },
  }
  const fail = (message: string): never => {
    fails.push(message)
    throw new Error('InvariantError: ' + message)
  }
  return {
    ctx, fails, fail,
    registered: () => registered,
    install: () => installer!(ctx, fail),
    installerShape: () => installer,
    /** 投一格 `internal/dispatch`（发布前那一拍）。 */
    dispatch: (payload: unknown) => {
      for (const h of handlers.get('internal/dispatch') ?? []) h('emit', 'work/changed', [payload])
    },
    /** 投一格真 `work/changed`（发布那一拍）。 */
    publish: (payload: unknown) => {
      for (const h of handlers.get('work/changed') ?? []) h(payload)
    },
  }
}

describe('不变量伴生插件（宿主 goal invariant 同款）', () => {
  it('形状：name / inject 对宿主同款；以**包名**注册进 invariants 服务', () => {
    expect(name).toBe('workprocess-invariant')
    expect(inject).toEqual(['invariants'])
    const h = harness()
    apply(h.ctx as never)
    expect(h.registered()).toBe('workprocess')
  })

  it('安装器声明自注入面（校验要经服务面读状态：域由领域插件独占打开）', () => {
    const h = harness()
    apply(h.ctx as never)
    expect(h.installerShape()?.inject).toEqual(['workprocess'])
  })

  it('干净的流：每一格事件都能折成载荷快照 ⇒ 不报违规（先验后发布）', async () => {
    const [init, start] = await realPayloads()
    const h = harness()
    apply(h.ctx as never)
    h.install()
    h.dispatch(init)
    h.publish(init)
    h.dispatch(start)
    h.publish(start)
    expect(h.fails).toEqual([])
  })

  it('事件与快照不一致（有东西绕过领域服务直接改状态）⇒ 点名本包', async () => {
    const [init, start] = await realPayloads()
    const h = harness()
    apply(h.ctx as never)
    h.install()
    h.dispatch(init)
    h.publish(init)
    const tampered = {
      scope: 'ws-a',
      change: { ...(start.change as object), process: { ...(start.change!.process), revision: 99 } },
    }
    expect(() => h.dispatch(tampered)).toThrow(/折叠结果与载荷快照不一致/)
    // 包名归属由宿主 registry 加（`InvariantError(packageName, …)`）：我们的文案只说事实。
    expect(h.fails[0]).toContain('stage-start')
  })

  it('漏发 / 乱序（事件在影子状态上不成立）⇒ 点名', async () => {
    const [, start] = await realPayloads()
    const h = harness()          // 没播种：影子状态是空的
    apply(h.ctx as never)
    h.install()
    expect(() => h.dispatch(start)).toThrow(/不成立（漏发 \/ 乱序 \/ 重复？）/)
  })

  it('归属边界不符（快照 id 与 scope 对不上）⇒ 点名', async () => {
    const [init] = await realPayloads()
    const h = harness()
    apply(h.ctx as never)
    h.install()
    const wrongScope = { scope: 'ws-other', change: init.change }
    expect(() => h.dispatch(wrongScope)).toThrow(/归属边界不符/)
  })

  it('未经影子折叠校验就发布 ⇒ 点名（internal/dispatch 那一拍没拦到）', async () => {
    const [init] = await realPayloads()
    const h = harness()
    apply(h.ctx as never)
    h.install()
    expect(() => h.publish(init)).toThrow(/未经影子折叠校验就发布/)
  })

  it('启动重放：已落盘的历史过不了审计 ⇒ 装载那一刻就点名', async () => {
    const [init] = await realPayloads()
    const h = harness({
      snapshots: [{ scope: 'ws-a', process: init.change!.process }],
      findings: [{ scope: 'ws-b', problem: '快照过不了严格解码：stages 必须是数组' }],
    })
    apply(h.ctx as never)
    h.install()
    await Promise.resolve()      // audit 是异步的
    await Promise.resolve()
    expect(h.fails[0]).toContain('ws-b')
    expect(h.fails[0]).toContain('不自洽')
  })

  it('启动重放的快照给影子状态播种：接着来的事件能折上去（跨进程续上）', async () => {
    const [init, start] = await realPayloads()
    const h = harness({ snapshots: [{ scope: 'ws-a', process: init.change!.process }] })
    apply(h.ctx as never)
    h.install()
    await Promise.resolve()
    await Promise.resolve()
    // 进程重启后拿到的是"下一格事件"：没有播种就会判"漏发"，播种之后必须顺利通过。
    h.dispatch(start)
    h.publish(start)
    expect(h.fails).toEqual([])
  })
})
