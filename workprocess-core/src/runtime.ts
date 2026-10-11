/**
 * 运行时构造器与协议常量（对齐宿主 `@deepseek-ai/dsh-goal/src/runtime.ts`：
 * 宿主在这里放 `GOAL_CHANGE_VERSION` / `GoalId()` 品牌化 / `GoalError`）。
 *
 * @module workprocess-core/runtime
 */
import type { WorkProcessId as WorkProcessIdType, WorkTaskId as WorkTaskIdType } from './types.js'

/** 变更载荷版本（对齐宿主 `GOAL_CHANGE_VERSION`；写入与解码两侧同源）。 */
export const WORK_CHANGE_VERSION = 1

/**
 * 流程身份构造（唯一入口：别处手拼 `'wp:' + scope` 会漂移）。
 * 一次流程一个 id，由**归属域键**（scope）派生——与宿主"一会话一 goal"同构，只是归属键由调用方给。
 */
export function WorkProcessId(scope: string): WorkProcessIdType {
  return 'wp:' + scope
}

/**
 * 任务身份构造（唯一入口）。
 *
 * `seq` = 该阶段内第几个任务（含被 clear 掉的历史编号）——留这个序号是为了
 * "清掉的身份不许复用"那条纪律：重建不得抹掉"这里曾经有过任务"这段历史。
 */
export function WorkTaskId(stageKey: string, seq = 1): WorkTaskIdType {
  return 'wt:' + stageKey + ':' + String(seq)
}

/** workprocess 域的稳定错误码（机器可路由；对齐宿主 `GoalErrorCode` 的形态）。 */
export type WorkErrorCode =
  /** 该归属域没有流程（读/写的前提不成立）。 */
  | 'WORK_NO_PROCESS'
  /** 按 id 找不到任务 / 阶段。 */
  | 'WORK_NOT_FOUND'
  /** 建流程/建任务却没给陈述（空 objective 写进去就是自造坏记录）。 */
  | 'WORK_OBJECTIVE_REQUIRED'
  /** 同一个 id 想建成另一个东西（身份冲突）。 */
  | 'WORK_IDENTITY_CONFLICT'
  /** CAS 失败：调用方拿着旧 revision 在改（对齐宿主 `goalRef` 的乐观锁拒绝）。 */
  | 'WORK_CONFLICT'
  /** 阶段键不存在 / 重复 / 非法。 */
  | 'WORK_STAGE_NOT_FOUND'
  | 'WORK_STAGE_DUPLICATE'
  /** 串行门：前序阶段没全 done，本阶段不许开工。 */
  | 'WORK_STAGE_SERIAL_BLOCKED'
  /** 阶段收口条件不满足（本阶段还有没 complete 的任务）。 */
  | 'WORK_STAGE_NOT_READY'
  /** 整体替换阶段表会丢掉已有任务的阶段（静默丢任务是最坏的一类缺陷，故拒）。 */
  | 'WORK_STAGE_HAS_TASKS'
  /** 任务相位迁移不成立（终态不可逆 / 非 active 不许 pause 等）。 */
  | 'WORK_TASK_PHASE'
  /** block 没给结构化原因。 */
  | 'WORK_REASON_REQUIRED'
  /** 该动作需要人显式发起（agent 自行调用会推翻人的意图）。 */
  | 'WORK_NO_PERMISSION'
  /** 耐久快照/变更流解码失败：字段缺漏、类型不符或迁移链断裂（对齐宿主严格解码器）。 */
  | 'WORK_CORRUPT'
  /** 折叠结果违反域不变量（INV-1~6）——规则实现坏了，不是业务拒绝。 */
  | 'WORK_INVARIANT'

/** workprocess 域边界错误（对齐宿主 `GoalError`：message 人话 + code 机器可路由）。 */
export class WorkError extends Error {
  readonly code: WorkErrorCode
  constructor(message: string, code: WorkErrorCode) {
    super(message)
    this.name = 'WorkError'
    this.code = code
  }
}
