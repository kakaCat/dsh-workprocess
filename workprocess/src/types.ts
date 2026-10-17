/**
 * workprocess 域的**纯类型**：client-safe（不 import 任何宿主包/上层包）。
 *
 * 【模型：两层】（用户决定；参考宿主 `@deepseek-ai/dsh-goal` 的事件表与判据形状）
 *   · 层1 `WorkStage` —— **阶段**：一组任务的集合、大块分组；一个阶段里可含多个 workTask；
 *     阶段之间**串行**——A 的全部任务完成后才进入 B（大数据 / 模型训练 / 发布流程的形态）。
 *   · 层2 `WorkTask` —— **任务**：单个工作单元，语义对齐宿主 goal
 *     （objective / phase / revision / blockedReason / maxRounds），是自动续跑真正推动的单位。
 *   · `WorkProcess` —— 聚合根：一次完整流程，持有**顺序化**的 stages（数组顺序即串行顺序）。
 *
 * 【与宿主 dsh-goal 的对齐】层2 逐字段对齐宿主 `GoalSnapshot`：`phase` 同名同值、
 * blocked 必带结构化原因、`revision` 是 CAS 身份；层1 是本包相对宿主的**加层**——
 * 宿主只有单层 goal，本包把"一组任务的大块分组 + 串行门"显式建模出来。
 *
 * 客户端命名空间投影见 `./client.js`（零内容重复）。
 *
 * @module workprocess/types
 */

/** 流程身份（跨修订稳定；形态 `wp:<scope>`，scope = 归属键）。 */
export type WorkProcessId = string

/** 任务身份（跨修订稳定；形态 `wt:<stageKey>:<seq>`，seq 在该阶段内不复用）。 */
export type WorkTaskId = string

/**
 * **层2** 的任务相位（与宿主 `GoalPhase` 同名同值）。
 *
 * pause / resume / block / complete 的迁移表与宿主逐条一致——层2 不是"类 goal"，
 * 而是**同一个相位机**换了个名字：这样"续跑能不能起轮"这类判据两边不会漂。
 */
export type WorkTaskPhase = 'active' | 'paused' | 'blocked' | 'complete'

/**
 * **层1** 的阶段态。
 *
 * 为什么不是复用 `WorkTaskPhase`：阶段的语义是**串行门**（前序全 done 才可开工），
 * 与层2 的"暂停/阻塞"不是一回事——混用一个枚举会让"阶段被 block"这种不存在的态出现。
 */
export type WorkStageState = 'pending' | 'active' | 'done'

/**
 * **层1** 的收口策略：谁来把阶段标 `done`。
 *
 *   · `human`（缺省）——**人工确认**收口：agent 只提议，不落 done；
 *   · `auto` ——**自动收口**：本阶段任务全 `complete` 后由驱动器直接落 done，阶段边界不必等人。
 *
 * 缺省为什么是 `human`：收口是"这一段算不算成了"的判定，而一旦 `done`，串行门就放行下一段——
 * 判错的代价是"下一段建在没验完的地基上"。故默认交给人，只有**显式声明** `auto` 的阶段才自动推进。
 */
export type WorkStageClosePolicy = 'human' | 'auto'

/** 进程内续跑许可（对齐宿主 `GoalActivation`）。 */
export type WorkActivation = 'armed' | 'disarmed'

/**
 * **谁收回的**续跑许可（只在 `disarmed` 时有意义，`armed` 时恒缺省）：
 *   · `'human'`——人亲手按的（`/work disarm`、`update_workstage action=disarm`）：**明确意图，粘性**
 *     ——机器的同名重写（宿主重启时驱动器自动再收一次）不许覆盖它，goal 的 `resume`（"继续"口令）
 *     也不放回它——人亲手收的要人亲手放；
 *   · `'driver'`——驱动器落的（resume / error / 非本轮的 aborted / max-tokens / 装载 / 检查点失败）：
 *     人**不知情**的停手，停手通告轮与"goal resume 顺带放回"都只认这一格。
 */
export type WorkActivationBy = 'driver' | 'human'

/**
 * 阻塞原因（对齐宿主 `GoalBlockReason`：**结构化**，不是自由文本）。
 * 人靠 `code` 判断"该找谁"（额度 / 鉴权 / 等人裁 / 等上游）；`message` 才是给人看的那句。
 */
export interface WorkBlockReason {
  /** 稳定的 lower-kebab-case 分类（由阻塞策略选）。 */
  readonly code: string
  /** 非空的人话解释。 */
  readonly message: string
}

/** 一次修订的 CAS 身份（对齐宿主 `GoalRef`）。 */
export interface WorkTaskRef {
  readonly id: WorkTaskId
  /** 正整数；每次有效变更 +1。 */
  readonly revision: number
}

/**
 * **层2** 任务快照：挂在一个阶段下，是该阶段里的一个工作单元。
 *
 * **不含回合计数**：回合数与许可来自归属记录（`WorkRecordLike.rounds`），
 * 本包只做派生读——不新增第二份存储。
 */
export interface WorkTask {
  readonly id: WorkTaskId
  /** 所属阶段键（与所在 `WorkStage.key` 必须一致：跨层一致性由不变量守）。 */
  readonly stageKey: string
  /** 人话陈述：这个工作单元要达成什么。 */
  readonly objective: string
  readonly phase: WorkTaskPhase
  /** **只在 `blocked` 时出现**（对齐宿主：present exactly while phase is blocked）。 */
  readonly blockedReason?: WorkBlockReason
  /** 自动续跑回合的上限（对齐宿主 `maxGoalRounds`）；缺省 = 调用方配置。 */
  readonly maxRounds?: number
  /** 乐观锁（每次有效变更 +1；CAS 身份）。 */
  readonly revision: number
}

/** **层1** 阶段快照：一组任务的集合 + 串行门状态。 */
export interface WorkStage {
  /** 阶段键（同流程内唯一、非空；数组顺序即串行顺序）。 */
  readonly key: string
  /** 人话陈述：这个阶段要达成什么。 */
  readonly statement: string
  /** 阶段达成判据（进提示词；缺省空数组）。 */
  readonly doneCriteria: readonly string[]
  /** 收口策略（缺省 `human` = 人工确认；`auto` = 任务全完成即自动收口）。读它请用 `stageClosePolicyOf()`。 */
  readonly closePolicy?: WorkStageClosePolicy
  /** 串行门：`pending` → `active` → `done`（前序阶段全 `done` 才可 `active`）。 */
  readonly state: WorkStageState
  /** 本阶段的任务（层2）；可空。 */
  readonly tasks: readonly WorkTask[]
}

/**
 * 被清除任务的**墓碑**（对齐宿主 `GoalClearChangeMeta`，落在任务层）。
 *
 * 为什么必须留：清掉的身份**不许复用**——否则重建会伪装成"从未有过这个任务"，
 * 把"做了一半就被清掉"这段历史抹平。任务 id 的编号因此按"含墓碑的序号"分配。
 */
export interface WorkTaskTombstone {
  readonly id: WorkTaskId
  readonly revision: number
  readonly clearedAt: number
}

/**
 * 流程聚合根（一次完整流程 = 一个归属对象的一条 workProcess）。
 *
 * 无相位字段：相位活在**层2 的每个任务**上（对齐宿主 goal）；流程的"整体成没成"
 * 是**判据**（`processAllowsClose`）而不是存下来的第四个状态——多存一份就会与阶段态打架。
 * `closedAt` 是**终止水印**而非相位：它不参与任何状态迁移，只标记"这条记录已终结、
 * 除 discard 外不再接受写"（方案 B 的轻量收口落点，见 fold 的 `process-close`）。
 */
export interface WorkProcess {
  readonly id: WorkProcessId
  /** 人话陈述：这条流程要达成什么。 */
  readonly objective: string
  /** 聚合级乐观锁（每次有效变更 +1；两层的写都共用它）。 */
  readonly revision: number
  /** 顺序化阶段表（数组顺序 = 串行顺序）。 */
  readonly stages: readonly WorkStage[]
  /** 已清除任务的墓碑（身份不复用的依据；缺省 = 还没清过）。 */
  readonly cleared?: readonly WorkTaskTombstone[]
  /** 收口时间戳（缺省 = 未收口）：最后一段 done 后落 `process-close`，记录随之终止。 */
  readonly closedAt?: number
}

/** 建阶段表的输入（`init` / `define-stages` 的载荷）：只有定义，不带态。 */
export interface WorkStageDraft {
  readonly key: string
  readonly statement: string
  readonly doneCriteria?: readonly string[]
  /** 收口策略（缺省 `human`；`define-stages` 是**整体替换定义**，缺省即改回人工确认）。 */
  readonly closePolicy?: WorkStageClosePolicy
}

/** 建任务的输入（`task-create` 的载荷）：id 由调用方按 `WorkTaskId()` 分配。 */
export type WorkTaskDraft = Omit<WorkTask, 'phase' | 'revision'>

/** 建流程请求（对齐宿主 `CreateGoalRequest` 的形态）。 */
export interface CreateWorkProcessRequest {
  readonly objective: string
  readonly stages: readonly WorkStageDraft[]
}

/** 建任务请求。 */
export interface CreateWorkTaskRequest {
  readonly stageKey: string
  readonly objective: string
  readonly maxRounds?: number
}

/** 改任务请求（对齐宿主 `EditGoalRequest`：至少要给一项）。 */
export interface EditWorkTaskRequest {
  readonly objective?: string
  readonly maxRounds?: number
}

/** 聚合视图（对齐宿主 `GoalView`：快照 + 派生只读的计数与许可）。 */
export interface WorkProcessView {
  readonly process: WorkProcess
  /** 已准入回合数（**派生**自归属记录的 `rounds.started`）。 */
  readonly roundsStarted: number
  /** 进程内续跑许可（**派生**自归属记录的 `rounds.activation`）。 */
  readonly activation: WorkActivation
}

/** 一层的进度计数（进归属记录的**有界投影**；正文不进城）。 */
export interface WorkProgress {
  /** 阶段层：总数与已 done 数。 */
  readonly stages: { readonly total: number; readonly done: number }
  /** 任务层：总数与已 complete 数。 */
  readonly tasks: { readonly total: number; readonly done: number }
}

/** 相位判据输入的最小形状（供 fold/predicates 复用）。 */
export interface WorkTaskPhaseView {
  readonly phase: WorkTaskPhase
}
