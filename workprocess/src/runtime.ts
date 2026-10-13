/**
 * 运行时构造器与协议常量（对齐宿主 `@deepseek-ai/dsh-goal/src/runtime.ts`：
 * 宿主在这里放 `GOAL_CHANGE_VERSION` / `GoalId()` 品牌化 / `GoalError`）。
 *
 * @module workprocess/runtime
 */
import type { WorkProcessId as WorkProcessIdType, WorkTaskId as WorkTaskIdType } from './types.js'
import type { WorkErrorCode } from './domain.js'

/** 变更载荷版本（对齐宿主 `GOAL_CHANGE_VERSION`；写入与解码两侧同源）。 */
export const WORK_CHANGE_VERSION = 1

/**
 * 流程身份构造（唯一入口：别处手拼 `'wp:' + scope` 会漂移）。
 * 一次流程一个 id，由**归属键**（scope）派生——与宿主"一会话一 goal"同构，只是归属键由调用方给。
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

/**
 * 域错误码**住在域词汇表**（`domain.ts` 的 `WORK_ERROR_CODES`），本文件只 import 进来给
 * `WorkError` 用——与宿主 `goal/src/runtime.ts` 逐字同形（那里也是
 * `import type { GoalErrorCode } from './domain.ts'`）。再导出一次是为了不打断既有消费方。
 */
export type { WorkErrorCode } from './domain.js'

/** workprocess 域边界错误（对齐宿主 `GoalError`：message 人话 + code 机器可路由）。 */
export class WorkError extends Error {
  readonly code: WorkErrorCode
  constructor(message: string, code: WorkErrorCode) {
    super(message)
    this.name = 'WorkError'
    this.code = code
  }
}
