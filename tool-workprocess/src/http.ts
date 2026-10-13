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
 * 【响应形状】`/stages` 的 200 体与 SSE 帧**同构**：`{ scope, process: WorkWire }`——正是客户端
 * `WorkSnapshot`（`workprocess/client/model.ts`），两路一套解析，不允许各自漂移（跨侧契约测试
 * 钉在 `tests/http.spec.ts`）。
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

/**
 * 数据面的**访问判据**（纯函数；只看请求头 + 允许的主机名）。
 *
 * 【守的是哪个门】这条面是**本机数据**（流程目标 / 阶段 / 任务 / 判据），却是宿主 webServer 上的
 * 一个普通 GET——不加判据的话，任何能到达该端口的**网页**都能读（跨源 `fetch` 会带 `Origin`，
 * SSE 的 `EventSource` 也带；而我们不发 CORS 头，浏览器本来就会拦**响应**，但 DNS rebinding
 * 那类攻击在浏览器看来是"同源"，CORS 帮不上忙）。故两道：
 *   ① **Host 必须是 loopback**（localhost / 127.0.0.1 / ::1），除非装载层显式把该主机名列进
 *      `apiHosts`（`'*'` = 全放行）——挡 DNS rebinding（攻击者域名解析到 127.0.0.1）；
 *   ② **Origin 若在，必须与 Host 同源**（`Sec-Fetch-Site: cross-site` 一律拒）——挡跨源读。
 *      非 http(s) 的 Origin（Electron 壳的 `app://` 之类）**放行**：网页伪造不出这种 Origin。
 *
 * 缺 `Host` 一律拒（浏览器必带 Host；不带的是畸形请求）。想从别的机器访问，把主机名写进
 * 装载层的 `apiHosts`——默认只认本机，因为这条面读的是你本机的流程数据。
 */
export interface ApiAccessDenial {
  readonly status: number
  readonly error: string
  readonly message: string
}

/** loopback 主机名（Host 头里的端口与 IPv6 方括号在比较前剥掉）。 */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1']

/** 取 Host 头里的主机名（去端口、去 IPv6 方括号、小写）。 */
function hostNameOf(host: string): string {
  const value = host.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end < 0 ? value : value.slice(1, end)
  }
  const colon = value.indexOf(':')
  return colon < 0 ? value : value.slice(0, colon)
}

/**
 * 判据本体（导出便于单测）：返回 `undefined` = 放行。
 * @param headers - 请求头（Node 的 `req.headers`，键小写）
 * @param allowedHosts - 装载层额外允许的主机名（`'*'` = 全放行）
 */
export function checkApiAccess(
  headers: { readonly host?: string; readonly origin?: string; readonly 'sec-fetch-site'?: string },
  allowedHosts: readonly string[] = [],
): ApiAccessDenial | undefined {
  const host = typeof headers.host === 'string' ? headers.host : ''
  if (host === '') {
    return { status: 403, error: 'missing-host', message: '请求缺少 Host 头（本数据面只服务浏览器/本机客户端）' }
  }
  const anyHost = allowedHosts.includes('*')
  const name = hostNameOf(host)
  const allowed = anyHost || LOOPBACK_HOSTS.includes(name)
    || allowedHosts.some((entry) => entry.toLowerCase() === host.toLowerCase() || entry.toLowerCase() === name)
  if (!allowed) {
    return {
      status: 403,
      error: 'host-not-allowed',
      message: '主机名 ' + JSON.stringify(host) + ' 不在允许名单里（本数据面默认只认本机）——'
        + '确实要从别的地址访问本插件的数据面，请把该主机名写进装载层配置 `apiHosts`。',
    }
  }
  const site = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'].toLowerCase() : ''
  if (site === 'cross-site') {
    return { status: 403, error: 'cross-site', message: '跨站请求（Sec-Fetch-Site: cross-site）：本数据面只服务同源页面' }
  }
  const origin = typeof headers.origin === 'string' ? headers.origin : ''
  if (origin !== '' && origin !== 'null') {
    let parsed: URL | undefined
    try {
      parsed = new URL(origin)
    } catch {
      parsed = undefined
    }
    // 非 http(s) 的来源（Electron 壳 / 扩展）不是网页能伪造的，放行；网页的跨源 Origin 必须与 Host 同源。
    if (parsed !== undefined && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host.toLowerCase() !== host.toLowerCase()) {
      return {
        status: 403,
        error: 'cross-origin',
        message: '跨源请求（Origin ' + JSON.stringify(origin) + ' 与 Host ' + JSON.stringify(host) + ' 不同源）：'
          + '本数据面只服务同源页面',
      }
    }
  }
  return undefined
}

/** `ctx.webServer.register` 的最小投影（只声明用到的形状；对齐 pmboard 的 ExactRouteRegistrar）。 */
export interface WorkApiRouteRegistrar {
  register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/** web 载体投影：`effect` 挂生命周期 + `webServer` 路由注册面（两者都缺省 = 零行为）。 */
interface WebCarrierLike {
  effect?: (fn: () => void | (() => void), label?: string) => void
  webServer?: WorkApiRouteRegistrar
}

/** 数据面选项（装载层配置的窄投影）。 */
export interface WorkApiOptions {
  /** 额外允许的 Host（缺省只认 loopback；`'*'` = 全放行）。 */
  readonly hosts?: readonly string[]
}

/**
 * 把数据面挂到宿主（惰性）：宿主缺 web 载体时不注册任何东西。
 * @param ctx - 插件上下文（取惰性注入面 + 订阅 `work/changed`）。
 * @param domain - `ctx.workprocess` 域服务。
 * @param options - 访问判据的装载层配置（见 {@link checkApiAccess}）。
 */
export function registerWorkprocessApi(
  ctx: Context, domain: WorkprocessService, options?: WorkApiOptions,
): void {
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
          }), options),
      })
    }, 'tool-workprocess: stages api')
  })
}

/** 处理器工厂（独立导出便于单测：订阅口注入，测试里用假订阅 + 假允许名单）。 */
export function createWorkprocessApiHandler(
  domain: WorkprocessService,
  subscribe: (scope: string, listener: () => void) => () => boolean,
  options?: WorkApiOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleApiRequest(domain, subscribe, req, res, options?.hosts ?? []).catch((err: unknown) => {
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
  allowedHosts: readonly string[],
): Promise<void> {
  // ① 访问判据**先于**一切（不把路径/scope 的语义泄露给没资格的对象）：跨源、跨站、非本机 Host 一律拦。
  const denial = checkApiAccess(req.headers, allowedHosts)
  if (denial !== undefined) {
    jsonReply(res, denial.status, { error: denial.error, message: denial.message })
    return
  }
  // ② 只读面：非 GET/HEAD 一律 405（SSE 也是 GET）。
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    jsonReply(res, 405, { error: 'method-not-allowed', message: '本数据面只读（GET / HEAD）' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://workprocess.api')
  const scope = url.searchParams.get('scope')
  if (scope === null || scope === '') {
    jsonReply(res, 400, { error: 'missing-scope', message: '缺少 scope（归属键）' })
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

/**
 * `GET /stages?scope=`：全量快照；无流程 = 404 明确缺失（缺失 ≠ 空表、≠ 500）。
 * 200 体 = `{ scope, process }`，与 SSE 帧同构（客户端 `WorkSnapshot` 一套解析吃两路）。
 */
async function serveStages(domain: WorkprocessService, scope: string, res: ServerResponse): Promise<void> {
  const process = await domain.process(scope)
  if (process === undefined) {
    jsonReply(res, 404, { scope, error: 'no-process', message: '该归属还没有流程' })
    return
  }
  const activation = await domain.activation(scope)
  jsonReply(res, 200, { scope, process: workWireOf(process, activation) })
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
