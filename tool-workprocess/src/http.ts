/**
 * workprocess 的**浏览器只读数据面**（`GET /workprocess/api/stages` + `GET /workprocess/api/events`）。
 *
 * 【为什么在这里】tool-workprocess 是宿主侧消费 `ctx.workprocess` 的唯一装配点；数据面与工具面
 * 吃同一份 {@link workWireOf} 投影，字段不可能漂移。
 *
 * 【装载形状】照 `dsh-pmboard` 先例：`ctx.inject(['webServer'], cb)` **惰性注入**——
 * 宿主没有 web 载体（纯 CLI 形态）时 `inject` 不存在，本模块零行为；`webCtx.effect` 的
 * 返回值就是路由撤销句柄（宿主卸载时自动清）。
 *
 * 【降级口径】无流程 = **`404 { error: 'no-process' }`**（明确缺失，不是 500、也不是空表）；
 * 缺 `scope` = 400；未知路径 = 404。SSE：连上先发一帧 `event: stages` 全量（没有流程发
 * `process: null`——客户端据此"整条不渲染"），之后每次 `work/changed`（scope 相符）推一帧
 * 全量；25s 心跳；`req close` 退订清心跳。
 *
 * @module tool-workprocess/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { onWorkChanged, workWireOf, type WorkprocessService } from 'workprocess'

/** 路由前缀（`kind: 'prefix'` 一次注册，路径分发在 handler 里做）。 */
export const WORKPROCESS_API_PREFIX = '/workprocess/api'

/** `ctx.webServer.register` 的最小投影（只声明用到的形状；对齐 pmboard 的 ExactRouteRegistrar）。 */
export interface WorkApiRouteRegistrar {
  register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/** web 载体投影：`effect` 挂生命周期 + `webServer` 路由注册面（两者都缺省 = 零行为）。 */
interface WebCarrierLike {
  effect?: (fn: () => void | (() => void), label?: string) => void
  webServer?: WorkApiRouteRegistrar
}

/**
 * 把数据面挂到宿主（惰性）：宿主缺 web 载体时不注册任何东西。
 * @param ctx - 插件上下文（取惰性注入面 + 订阅 `work/changed`）。
 * @param domain - `ctx.workprocess` 域服务。
 */
export function registerWorkprocessApi(ctx: Context, domain: WorkprocessService): void {
  const host = ctx as unknown as { inject?: (services: string[], cb: (webCtx: WebCarrierLike) => void) => void }
  host.inject?.(['webServer'], (webCtx: WebCarrierLike) => {
    webCtx.effect?.(() => {
      if (webCtx.webServer === undefined) return undefined
      return webCtx.webServer.register({
        kind: 'prefix',
        path: WORKPROCESS_API_PREFIX,
        handler: createWorkprocessApiHandler(domain, (scope, listener) =>
          onWorkChanged(ctx, (payload) => {
            if (payload.scope === scope) listener()
          })),
      })
    }, 'tool-workprocess: stages api')
  })
}

/** 处理器工厂（独立导出便于单测：订阅口注入，测试里用假订阅）。 */
export function createWorkprocessApiHandler(
  domain: WorkprocessService,
  subscribe: (scope: string, listener: () => void) => () => boolean,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleApiRequest(domain, subscribe, req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }))
    })
  }
}

async function handleApiRequest(
  domain: WorkprocessService,
  subscribe: (scope: string, listener: () => void) => () => boolean,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://workprocess.api')
  const scope = url.searchParams.get('scope')
  if (scope === null || scope === '') {
    jsonReply(res, 400, { error: 'missing-scope', message: '缺少 scope（归属域键）' })
    return
  }
  if (url.pathname === WORKPROCESS_API_PREFIX + '/stages') {
    await serveStages(domain, scope, res)
    return
  }
  if (url.pathname === WORKPROCESS_API_PREFIX + '/events') {
    serveEvents(domain, subscribe, scope, req, res)
    return
  }
  jsonReply(res, 404, { error: 'unknown-path', message: '未知路径 ' + url.pathname })
}

/** `GET /stages?scope=`：全量快照；无流程 = 404 明确缺失（缺失 ≠ 空表、≠ 500）。 */
async function serveStages(domain: WorkprocessService, scope: string, res: ServerResponse): Promise<void> {
  const process = await domain.process(scope)
  if (process === undefined) {
    jsonReply(res, 404, { scope, error: 'no-process', message: '该归属域还没有流程' })
    return
  }
  const activation = await domain.activation(scope)
  jsonReply(res, 200, { scope, ...workWireOf(process, activation) })
}

/**
 * `GET /events?scope=`：SSE。首帧全量（无流程发 `process: null`）→ 每次 scope 相符的
 * `work/changed` 推一帧全量 → 25s 心跳 → `close` 退订清心跳。
 */
function serveEvents(
  domain: WorkprocessService,
  subscribe: (scope: string, listener: () => void) => () => boolean,
  scope: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })
  res.write(': connected\n\n')

  const send = (process: Awaited<ReturnType<WorkprocessService['process']>>): void => {
    try {
      res.write('event: stages\n')
      res.write('data: ' + JSON.stringify({
        scope,
        process: process === undefined ? null : workWireOf(process),
      }) + '\n\n')
    } catch {
      /* 连接已断：后续订阅与心跳会各自清理。 */
    }
  }
  const push = (): void => {
    void domain.process(scope).then(send, () => { /* 读失败：本帧静默跳过，等下一次变更。 */ })
  }

  push() // 首帧全量
  const unsubscribe = subscribe(scope, push)
  const heartbeat = setInterval(() => {
    try {
      res.write(': hb\n\n')
    } catch {
      /* 连接已断。 */
    }
  }, 25_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}

function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
