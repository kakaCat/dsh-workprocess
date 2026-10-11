/**
 * workprocess 工具面**独立插件入口**的接线冒烟（降级纪律）：
 *   ① 无 inject / 无 tools 服务 → 不抛、返回空数组（装不上只降级）；
 *   ② 正常宿主 → 六件全部注册，名字与 `WORK_TOOL_REGISTRY` 逐字一致（不带域前缀）；
 *   ③ 返回的卸载器可调用（dispose 不抛）。
 */
import { describe, it, expect } from 'vitest'
import { applyWorkToolSurface } from 'tool-workprocess/plugin.js'
import { WORK_TOOL_REGISTRY } from 'tool-workprocess/registry.js'
import type { WorkToolDeps } from 'tool-workprocess'

const deps = {
  store: { get: async () => undefined, mutate: async () => ({ changed: false }) },
  now: () => 1_000,
} as unknown as WorkToolDeps

interface Stub {
  registered: Array<{ name?: string }>
  disposers: Array<() => void>
  ctx: unknown
}

function stubCtx(withTools: boolean): Stub {
  const s: Stub = { registered: [], disposers: [], ctx: undefined }
  s.ctx = {
    inject: (services: string[], cb: (c: unknown) => void) => {
      expect(services).toEqual(['tools'])
      cb({
        effect: (fn: () => void) => { fn() },
        ...(withTools
          ? {
            tools: {
              register: (t: { name?: string }) => {
                s.registered.push(t)
                const dispose = () => {}
                s.disposers.push(dispose)
                return dispose
              },
            },
          }
          : {}),
      })
    },
  }
  return s
}

describe('applyWorkToolSurface（独立插件入口）', () => {
  it('无 inject → 不抛、返回空数组（降级）', () => {
    expect(() => applyWorkToolSurface({}, deps)).not.toThrow()
    expect(applyWorkToolSurface({}, deps)).toEqual([])
  })

  it('有 inject 但无 tools 服务 → 不抛、返回空数组（降级）', () => {
    const { ctx } = stubCtx(false)
    expect(() => applyWorkToolSurface(ctx, deps)).not.toThrow()
    expect(applyWorkToolSurface(ctx, deps)).toEqual([])
  })

  it('正常宿主 → 六件按登记表顺序注册，名字逐字一致', () => {
    const stub = stubCtx(true)
    const disposers = applyWorkToolSurface(stub.ctx, deps)
    expect(stub.registered.map((t) => t.name)).toEqual(WORK_TOOL_REGISTRY.map((e) => e.toolName))
    expect(disposers).toHaveLength(WORK_TOOL_REGISTRY.length)
    for (const dispose of disposers) expect(() => dispose()).not.toThrow()
  })
})
