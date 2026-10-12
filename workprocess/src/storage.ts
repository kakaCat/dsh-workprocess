/**
 * workprocess 的**归属记录域**（宿主 storage domain 形态：schema 校验 + 写即耐久 + `domain/changed` 事件）。
 *
 * 【为什么不是自己的文件库】宿主已经把"非会话日志的耐久状态"做成了基础设施
 * （`@deepseek-ai/dsh-storage` 存储中枢 + `ctx.storageDomain` 域形态，后端可为 JSON / SQLite）。
 * 自己开路径、自己原子写会绕开它的 schema 校验、路由与变更事件；而会话日志那条路
 * （goal 的做法）对**仓外插件**在本 build 里走不通：`session.append` 没有地方能设
 * `ignorable: true`，持久化读路径对"不认识的类型 + 无 ignorable"是**拒绝解释整条会话日志**
 * （`session-persistence/src/storage-contract.ts` 的 `validateStoredEvents`）。
 *
 * 【一条记录 = 一个归属域】表名 `processes`，键 = 归属域键（缺省即会话 id），
 * 值 = `WorkRecordLike`（`workProcess` / `updatedAt` / `rounds`）。
 *
 * 【谁校验】`workProcess` 的**权威校验器是内核**（`decodeWorkProcess`）：本 schema 只查
 * "装的确实是那几个字段"，快照本身的严格校验由 `superRefine` 调内核解码器完成——
 * 于是持久化边界与读边界用的是同一份规则，不会各写一套。
 *
 * @module workprocess/domain
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
// 【依赖口径】zod 由官方栈提供（peerDependencies）：`@deepseek-ai/dsh-storage-domain` 自己声明
// `zod: ^4.4.3` 且其公开 API `domainTable(schema: ZodType<V>)` 的类型即 `import type { ZodType } from 'zod'`
// ——存储域的 schema 语言是官方契约钦定的，不是我们自选的三方包。
import { z, type ZodType } from 'zod'
import { decodeWorkProcess } from './kernel.js'
import type { WorkRecordLike, WorkStoreLike } from './kernel.js'

/** 域身份（名字与版本是**持久化契约**：改名或降版本等于换一个域）。 */
export const WORKPROCESS_DOMAIN = 'workprocess'
/** 域格式版本（首版；记录结构变化时 +1 并声明 `compatibleVersions`）。 */
export const WORKPROCESS_DOMAIN_VERSION = 1

/** 归属记录 schema（表 `processes` 的 `valueSchema`）。 */
const recordSchema = z.object({
  workProcess: z.unknown().optional(),
  updatedAt: z.number().optional(),
  rounds: z
    .object({ started: z.number().optional(), activation: z.enum(['armed', 'disarmed']).optional() })
    .optional(),
}).superRefine((value, ctx) => {
  if (value.workProcess === undefined) return
  try {
    decodeWorkProcess(value.workProcess)
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: '归属记录里的流程快照不合法（内核严格解码拒绝）：' + String((err as Error)?.message ?? err),
    })
  }
})

/** 声明本插件的域（`defineDomain` 在模块加载期就校验名字 / 版本 / 表名）。 */
export const workprocessDomain = defineDomain({
  name: WORKPROCESS_DOMAIN,
  version: WORKPROCESS_DOMAIN_VERSION,
  tables: {
    // 快照的严格性由内核解码器给（见文件头）：schema 的推导输出是"松散形状"
    //（workProcess 按 unknown 读），权威类型标注成 WorkRecordLike——断言只落在类型面，运行时校验照旧。
    processes: domainTable<string, WorkRecordLike>(recordSchema as unknown as ZodType<WorkRecordLike>),
  },
})

/** 域设施（`ctx.storageDomain`）的**最小读取面**。 */
export interface StorageDomainCtx {
  readonly storageDomain: {
    open(spec: unknown): Promise<{ table(name: string): DomainTableHandle }>
  }
}

/** 域表句柄的最小面（同步读 + 耐久写）。 */
export interface DomainTableHandle {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
}

/**
 * 用宿主存储域实现 `store` 端口（`WorkStoreLike`）。
 *
 * `open` 只在这里调一次（域打开是异步的，句柄随插件生命周期存活）；
 * 读是内存同步读，写等后端确认耐久后才 resolve——与内核"写成功才发通知"的口径一致。
 */
export function storageDomainStoreOf(ctx: StorageDomainCtx): WorkStoreLike {
  const opened = ctx.storageDomain.open(workprocessDomain)
  const tableOf = async (): Promise<DomainTableHandle> => (await opened).table('processes')
  return {
    async get(scope: string) {
      const record = (await tableOf()).get(scope)
      return record === undefined ? undefined : record as WorkRecordLike
    },
    async mutate(scope: string, fn: (draft: WorkRecordLike) => unknown) {
      const table = await tableOf()
      const current = table.get(scope) as WorkRecordLike | undefined
      const draft: WorkRecordLike = current === undefined ? {} : { ...current }
      const out = fn(draft) as { changed?: boolean } | undefined
      // 幂等是硬语义：纯函数说没变，就不落盘（域后端也不会收到写请求）。
      if (out?.changed !== true) return { changed: false }
      await table.put(scope, draft)
      return { changed: true }
    },
  }
}
