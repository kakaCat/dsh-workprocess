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
 * 【一条记录 = 一个归属】表名 `processes`，键 = 归属键（缺省即会话 id），
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
    .object({
      started: z.number().optional(),
      // 逐任务回合账（预算按任务计）：`rounds` = 该任务已准入回合数，`grants` = 人追加的预算份数。
      tasks: z.record(z.string(), z.object({ rounds: z.number(), grants: z.number() })).optional(),
      activation: z.enum(['armed', 'disarmed']).optional(),
      // 谁收回的（只在 disarmed 时有意义）：'human' = 人亲手按的（粘性，机器口令不碰）；'driver' = 驱动器落的。
      activationBy: z.enum(['driver', 'human']).optional(),
    })
    .optional(),
  asked: z
    .object({
      plan: z.object({ key: z.string(), revision: z.number() }).optional(),
      ask: z.object({ key: z.string(), revision: z.number() }).optional(),
    })
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
 *
 * **`mutate` 按 scope 串行**：`get → 改草稿 → put` 中间隔着真的 I/O（`await`），两个写者并发时
 * 会各读一份旧草稿、后写的把先写的盖掉（丢更新）——内核的 CAS 也就成了摆设。写者有三处
 * （工具面 / 命令行 / 驱动器）同在一个进程里，故串行化就放在这一层（唯一安排读写次序的地方）。
 */
export function storageDomainStoreOf(ctx: StorageDomainCtx): WorkStoreLike {
  const opened = ctx.storageDomain.open(workprocessDomain)
  const tableOf = async (): Promise<DomainTableHandle> => (await opened).table('processes')
  /** 每个 scope 一条串行链（前一个写完才轮到下一个；前一个失败不阻塞后一个）。 */
  const chains = new Map<string, Promise<unknown>>()
  const serialize = <T>(scope: string, run: () => Promise<T>): Promise<T> => {
    const previous = chains.get(scope) ?? Promise.resolve()
    const next = previous.then(run, run)
    const settled: Promise<unknown> = next.catch(() => undefined)
    chains.set(scope, settled)
    // 链尾没人等 ⇒ 把表项摘掉（别让 Map 按 scope 无限长；摘之前先确认它还是当前链尾）。
    void settled.then(() => {
      if (chains.get(scope) === settled) chains.delete(scope)
    })
    return next
  }
  return {
    async get(scope: string) {
      const record = (await tableOf()).get(scope)
      return record === undefined ? undefined : record as WorkRecordLike
    },
    /** 快照遍历（表句柄的 `entries()` 就是快照语义：迭代期间落盘的写不干扰本次遍历）。 */
    async entries(): Promise<IterableIterator<readonly [string, WorkRecordLike]>> {
      const table = await tableOf()
      const enumerate = (table as unknown as { entries?: () => IterableIterator<readonly [string, unknown]> }).entries
      // 后端不支持遍历 ⇒ 审计降级为"没有可审的"，绝不抛（审计是诊断，不是门禁）。
      return typeof enumerate === 'function'
        ? enumerate.call(table) as IterableIterator<readonly [string, WorkRecordLike]>
        : [][Symbol.iterator]()
    },
    mutate(scope: string, fn: (draft: WorkRecordLike) => unknown) {
      return serialize(scope, async () => {
        const table = await tableOf()
        const current = table.get(scope) as WorkRecordLike | undefined
        const draft: WorkRecordLike = current === undefined ? {} : { ...current }
        const out = fn(draft) as { changed?: boolean } | undefined
        // 幂等是硬语义：纯函数说没变，就不落盘（域后端也不会收到写请求）。
        if (out?.changed !== true) return { changed: false }
        await table.put(scope, draft)
        return { changed: true }
      })
    },
  }
}
