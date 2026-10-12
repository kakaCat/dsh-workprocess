/**
 * 浏览器只读数据面（`GET /workprocess/api/stages` + `GET /workprocess/api/events`）的处理器测试。
 *
 * 【守护什么】
 *   ① `stages`：200 + 与 `workWireOf` 同名字段的全量 JSON；无流程 = 404 `no-process`（缺失 ≠ 500）；
 *      缺 scope = 400；未知路径 = 404；
 *   ② `events`：SSE 头 + `: connected` 首帧 + **首帧全量**（无流程发 `process: null`）；
 *      `work/changed`（scope 相符）触发再推一帧全量；`close` 退订并清心跳。
 */
import { describe, it, expect, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWorkprocessApiHandler } from 'tool-workprocess/http'
import { createWorkprocessService, createWorkProcess, createWorkTask, startWorkStage } from 'workprocess'
import type { WorkRecordLike, WorkStoreLike } from 'workprocess'

function mapStore(): WorkStoreLike & { records: Map<string, WorkRecordLike> } {
  const records = new Map<string, WorkRecordLike>()
  return {
    records,
    get: async (scope: string) => records.get(scope),
    mutate: async (scope: string, fn: (draft: WorkRecordLike) => unknown) => {
      const record = records.get(scope) ?? {}
      const out = fn(record)
      if ((out as { changed?: boolean } | undefined)?.changed !== true) return { changed: false }
      records.set(scope, record)
      return { changed: true }
    },
  }
}

async function seededDomain() {
  const store = mapStore()
  const domain = createWorkprocessService({ store, now: () => 1_000 })
  await createWorkProcess({ store, now: () => 1_000 }, 'session-1', {
    objective: '修 bug',
    stages: [{ key: 'repro', statement: '复现' }],
  })
  await startWorkStage({ store, now: () => 1_000 }, 'session-1', 'repro')
  await createWorkTask({ store, now: () => 1_000 }, 'session-1', { stageKey: 'repro', objective: '抓栈' })
  return domain
}

/** 假请求：只带 url 与 close 监听。 */
function mockReq(url: string): IncomingMessage & { close(): void } {
  const listeners = new Map<string, () => void>()
  const req = {
    url,
    on(ev: string, cb: () => void) {
      listeners.set(ev, cb)
      return req
    },
    close() {
      listeners.get('close')?.()
    },
  }
  return req as unknown as IncomingMessage & { close(): void }
}

/** 假响应：收集 writeHead / write / end。 */
function mockRes() {
  const r = {
    status: 0,
    headers: {} as Record<string, string | number>,
    body: '',
    headersSent: false,
    writeHead(status: number, headers: Record<string, string | number>) {
      r.status = status
      r.headers = headers
      r.headersSent = true
      return r
    },
    write(chunk: string) {
      r.body += chunk
      return true
    },
    end(chunk?: string) {
      if (chunk !== undefined) r.body += chunk
      return r
    },
  }
  return r
}

/** 假订阅：记录 listener，返回可断言的退订。 */
function mockSubscribe() {
  const listeners = new Map<string, () => void>()
  return {
    listeners,
    subscribe: (scope: string, listener: () => void) => {
      listeners.set(scope, listener)
      return () => listeners.delete(scope)
    },
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('GET /workprocess/api/stages', () => {
  it('200 + 全量 JSON（字段与 workWireOf 同源）', async () => {
    const domain = await seededDomain()
    const res = mockRes()
    createWorkprocessApiHandler(domain, mockSubscribe().subscribe)(
      mockReq('/workprocess/api/stages?scope=session-1'), res as unknown as ServerResponse)
    await flush()
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.scope).toBe('session-1')
    expect(body.objective).toBe('修 bug')
    expect(body.stages[0]).toMatchObject({ key: 'repro', state: 'active', tasks: 1, tasks_done: 0 })
    expect(body.current_stage).toBe('repro')
    expect(body.tasks[0]).toMatchObject({ id: 'wt:repro:1', stage_key: 'repro', phase: 'active' })
  })

  it('无流程 = 404 no-process（缺失 ≠ 空表 ≠ 500）', async () => {
    const domain = await seededDomain()
    const res = mockRes()
    createWorkprocessApiHandler(domain, mockSubscribe().subscribe)(
      mockReq('/workprocess/api/stages?scope=nope'), res as unknown as ServerResponse)
    await flush()
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body).error).toBe('no-process')
  })

  it('缺 scope = 400；未知路径 = 404', async () => {
    const domain = await seededDomain()
    const res = mockRes()
    createWorkprocessApiHandler(domain, mockSubscribe().subscribe)(
      mockReq('/workprocess/api/stages'), res as unknown as ServerResponse)
    await flush()
    expect(res.status).toBe(400)
    const res2 = mockRes()
    createWorkprocessApiHandler(domain, mockSubscribe().subscribe)(
      mockReq('/workprocess/api/whatever?scope=session-1'), res2 as unknown as ServerResponse)
    await flush()
    expect(res2.status).toBe(404)
    expect(JSON.parse(res2.body).error).toBe('unknown-path')
  })
})

describe('GET /workprocess/api/events（SSE）', () => {
  it('SSE 头 + : connected + 首帧全量；变更推第二帧；close 退订清心跳', async () => {
    vi.useFakeTimers()
    try {
      const domain = await seededDomain()
      const { subscribe, listeners } = mockSubscribe()
      const res = mockRes()
      const req = mockReq('/workprocess/api/events?scope=session-1')
      createWorkprocessApiHandler(domain, subscribe)(req, res as unknown as ServerResponse)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toContain('text/event-stream')
      expect(res.body).toContain(': connected')

      await vi.advanceTimersByTimeAsync(0)
      expect(res.body).toContain('event: stages')
      const first = res.body.split('data: ')[1]
      expect(JSON.parse(first).process.stages[0].key).toBe('repro')

      // 变更 → 第二帧（同一 scope 的 work/changed 触发重读重推）。
      listeners.get('session-1')!()
      await vi.advanceTimersByTimeAsync(0)
      const frames = res.body.split('event: stages').length - 1
      expect(frames).toBe(2)

      // 心跳与清理。
      await vi.advanceTimersByTimeAsync(25_000)
      expect(res.body).toContain(': hb')
      req.close()
      expect(listeners.has('session-1')).toBe(false)
      const before = res.body.length
      await vi.advanceTimersByTimeAsync(50_000)
      expect(res.body.length).toBe(before)   // 心跳已清：close 之后不再写
    } finally {
      vi.useRealTimers()
    }
  })

  it('无流程的首帧是 process: null（客户端据此整条不渲染）', async () => {
    const domain = await seededDomain()
    const res = mockRes()
    createWorkprocessApiHandler(domain, mockSubscribe().subscribe)(
      mockReq('/workprocess/api/events?scope=nope'), res as unknown as ServerResponse)
    await flush()
    expect(res.status).toBe(200)
    const first = res.body.split('data: ')[1]
    expect(JSON.parse(first)).toEqual({ scope: 'nope', process: null })
  })
})
