/**
 * 取数（浏览器 API）：首次全量 `GET /workprocess/api/stages?scope=` +
 * 变更订阅 `GET /workprocess/api/events?scope=`（SSE：首帧全量、变更推全量、断线由 `EventSource` 自带重连）。
 *
 * 【字段谁定】数据面的字段以 `tool-workprocess/src/http.ts` 为准、与工具面回执同源
 * （`workprocess/src/view.ts` 是全量线值的唯一定义处），这里只消费不解释。
 *
 * @module workprocess/client/useWorkWire
 */
import { useEffect, useState } from 'react'
import { viewModelOf, type WorkSnapshot, type WorkViewModel } from './model.js'

/** 数据面根路径（宿主把插件 HTTP 面挂在包名路径下）。 */
const API_BASE = '/workprocess/api'

/**
 * 订阅某归属的全量线值。
 *
 * @param scope - 归属键（dock 槽的标准 prop `sessionId`）。
 * @returns 降级三态裁决结果（渲染侧只认它，不自己判空）。
 */
export function useWorkWire(scope: unknown): WorkViewModel {
  const [snapshot, setSnapshot] = useState<WorkSnapshot | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (typeof scope !== 'string' || scope === '') return undefined
    let alive = true
    /** 拉一帧全量（SSE 首帧也有，双保险：HTTP 缓存 / 代理场景下先出内容）。 */
    const pull = (): void => {
      fetch(API_BASE + '/stages?scope=' + encodeURIComponent(scope))
        .then((r) => (r.ok ? r.json() : r.json().then((b: { error?: string }) => Promise.reject(new Error(b.error ?? String(r.status))))))
        .then((j: WorkSnapshot) => { if (alive) { setSnapshot(j); setFailed(false) } })
        .catch(() => { if (alive) setFailed(true) })
    }
    pull()
    let es: EventSource | undefined
    try {
      es = new EventSource(API_BASE + '/events?scope=' + encodeURIComponent(scope))
      es.addEventListener('stages', (ev) => {
        try {
          const j = JSON.parse((ev as MessageEvent<string>).data) as WorkSnapshot
          if (alive) { setSnapshot(j); setFailed(false) }
        } catch {
          /* 单帧解析失败：保留上一帧（whole-value 语义，下一帧会整份盖掉）。 */
        }
      })
      es.onerror = () => { if (alive) setFailed(true) } // EventSource 自带重连；重连后第一帧即全量
    } catch {
      /* EventSource 不可用（理论外形态）：只剩失败态标灰。 */
    }
    return () => { alive = false; if (es !== undefined) es.close() }
  }, [scope])
  return viewModelOf(snapshot, failed)
}
