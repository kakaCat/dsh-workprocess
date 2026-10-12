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

/**
 * 假请求：url + headers + close 监听。
 * 缺省带头 =「本机同源」（Host 127.0.0.1:3000，无 Origin / Sec-Fetch-Site）——访问判据放行的形态；
 * 要测被拦的形态就显式传 headers。
 */
function mockReq(
  url: string,
  headers: Record<string, string> = { host: '127.0.0.1:3000' },
  method = 'GET',
): IncomingMessage & { close(): void } {
  const listeners = new Map<string, () => void>()
  const req = {
    url,
    method,
    headers,
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

describe('访问判据（本机数据面：跨源 / 跨站 / 非本机 Host 一律拦）', () => {
  const call = async (
    headers: Record<string, string>,
    hosts?: readonly string[],
    url = '/workprocess/api/stages?scope=session-1',
    method = 'GET',
  ) => {
    const domain = await seededDomain()
    const res = mockRes()
    createWorkprocessApiHandler(domain, mockSubscribe().subscribe, hosts === undefined ? undefined : { hosts })(
      mockReq(url, headers, method), res as unknown as ServerResponse)
    await flush()
    return res
  }

  it('同源（Origin 与 Host 同源）+ loopback Host ⇒ 放行', async () => {
    const res = await call({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })
    expect(res.status).toBe(200)
    expect(await call({ host: 'localhost:3000' })).toMatchObject({ status: 200 })
    expect(await call({ host: '[::1]:3000' })).toMatchObject({ status: 200 })   // IPv6 字面量
  })

  it('跨源 Origin ⇒ 403 cross-origin（任意网页读不到本机流程）', async () => {
    const res = await call({ host: '127.0.0.1:3000', origin: 'http://evil.example' })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body).error).toBe('cross-origin')
  })

  it('跨站（Sec-Fetch-Site: cross-site）⇒ 403，即便 Host 看着是本机', async () => {
    const res = await call({ host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body).error).toBe('cross-site')
  })

  it('非 loopback Host（DNS rebinding 的形态）⇒ 403，消息点名 apiHosts', async () => {
    const res = await call({ host: 'evil.example:3000', origin: 'http://evil.example:3000' })
    expect(res.status).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('host-not-allowed')
    expect(body.message).toContain('apiHosts')
  })

  it('缺 Host ⇒ 403 missing-host（浏览器必带 Host）', async () => {
    const res = await call({})
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body).error).toBe('missing-host')
  })

  it('装载层把主机名列进 apiHosts 就放行；`*` = 全放行', async () => {
    expect((await call({ host: 'mybox.lan:8080', origin: 'http://mybox.lan:8080' }, ['mybox.lan:8080'])).status).toBe(200)
    expect((await call({ host: 'mybox.lan:8080' }, ['mybox.lan'])).status).toBe(200)     // 名单写名，端口随意
    expect((await call({ host: 'evil.example:3000' }, ['*'])).status).toBe(200)
    // 放行 Host ≠ 放行跨源：Origin 仍须与 Host 同源。
    expect((await call({ host: 'mybox.lan:8080', origin: 'http://evil.example' }, ['mybox.lan:8080'])).status).toBe(403)
  })

  it('非 http(s) 的 Origin（Electron 壳 / 扩展）放行：网页伪造不出这种来源', async () => {
    expect((await call({ host: '127.0.0.1:3000', origin: 'app://dsh' })).status).toBe(200)
  })

  it('只读面：非 GET/HEAD ⇒ 405', async () => {
    const res = await call({ host: '127.0.0.1:3000' }, undefined, '/workprocess/api/stages?scope=session-1', 'POST')
    expect(res.status).toBe(405)
    expect(JSON.parse(res.body).error).toBe('method-not-allowed')
  })
})
