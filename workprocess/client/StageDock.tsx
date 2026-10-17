/**
 * `StageDock`：`conversation.input.dock` 槽里的「阶段」卡片（与 todo / goal 同槽、排在它们之后）。
 *
 * 【只读】不提供推进 / 收口按钮——那些是工具面与人工门的事；点主行只是本地展开折叠。
 * 【形态 / 映射 / 降级】照 `docs/workprocess-ui-design.md`（D-1~D-5）与
 * `docs/workprocess-ui-contract.md` 的展示契约；穷举映射与裁决在 `./model.ts`（可单测）。
 *
 * @module workprocess/client/StageDock
 */
import { useState } from 'react'
import { STAGE_LABEL, TASK_LABEL, dockActivationBadge, stageDotState, taskDotState } from './model.js'
import type { WorkStageWire, WorkTaskWire } from '../src/view.js'
import { useWorkWire } from './useWorkWire.js'
import styles from './StageDock.module.css'

/** dock 槽给 occupant 的标准 prop（本条目只用 `sessionId`）。 */
export interface StageDockProps {
  /** 会话 id = 归属键（缺省）——数据面的 `scope`。 */
  readonly sessionId?: string
}

/** 状态点：done=绿 / warning=琥珀 / idle=灰 / ongoing=旋转环（对齐宿主 StateDot 语义）。 */
function Dot({ state }: { readonly state: string | undefined }) {
  const stateClass = state === undefined ? '' : styles[state]
  return <span className={[styles.dot, stateClass].filter(Boolean).join(' ')} aria-hidden="true" />
}

/** 折叠指示箭头。 */
function Chevron({ up }: { readonly up: boolean }) {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden="true" className={styles.chevron}>
      <path
        d={up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 头行图标：小清单（三条线 + 三个勾）。 */
function StagesIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className={styles.icon}>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <path
        d="M1.5 4l1 1 1.6-1.8M1.5 8l1 1 1.6-1.8M1.5 12l1 1 1.6-1.8"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 一段一行（判据缺失时 tooltip 明说——D-5）。 */
function StageRow({ stage }: { readonly stage: WorkStageWire }) {
  const statement = stage.done_criteria.length > 0 ? stage.done_criteria.join('\n') : '未登记达成判据'
  return (
    <li className={styles.item} data-state={stage.state}>
      <Dot state={stageDotState(stage.state)} />
      <span className={styles.key}>{stage.key}</span>
      <span className={styles.statement} title={statement}>{stage.statement}</span>
      <span className={styles.itemLabel}>{STAGE_LABEL[stage.state]}</span>
    </li>
  )
}

/** 当前阶段的一个在办任务（被挡住时把原因挂 tooltip）。 */
function TaskRow({ task }: { readonly task: WorkTaskWire }) {
  return (
    <li className={styles.task} data-phase={task.phase} title={task.blocked_message}>
      <Dot state={taskDotState(task.phase)} />
      <span className={styles.taskId}>{task.id}</span>
      <span className={styles.statement}>{task.objective}</span>
      <span className={styles.itemLabel}>{TASK_LABEL[task.phase]}</span>
    </li>
  )
}

/**
 * dock 条目：`conversation.input.dock` 的 occupant（函数组件）。
 *
 * @param props - 槽的标准 prop；`sessionId` 即数据面的 `scope`。
 */
export function StageDock(props: StageDockProps) {
  const scope = props.sessionId
  const model = useWorkWire(scope)
  const [collapsed, setCollapsed] = useState(true)

  if (model.kind === 'loading' || model.kind === 'none') return null
  if (model.kind === 'error') {
    return (
      <section className={[styles.dock, styles.error].join(' ')} aria-label="阶段">
        <div className={styles.body}>阶段读数不可用</div>
      </section>
    )
  }

  const wire = model.wire
  const stages = wire.stages
  const done = stages.filter((s) => s.state === 'done').length
  const current = wire.current_stage
  // 续跑许可被收回 ⇒ 头行挂徽标（**折叠时也看得见**：它改变的是"这屏会不会自己往下走"）。
  const activation = dockActivationBadge(wire)
  const openTasks = current === null
    ? []
    : wire.tasks.filter((t) => t.stage_key === current && t.phase !== 'complete')

  return (
    <section
      className={[styles.dock, model.stale ? styles.stale : ''].filter(Boolean).join(' ')}
      aria-label="阶段"
      data-scope={typeof scope === 'string' ? scope : undefined}
    >
      <div className={styles.body}>
        <button
          type="button"
          className={styles.header}
          aria-expanded={collapsed ? 'false' : 'true'}
          onClick={() => { setCollapsed((v) => !v) }}
        >
          <StagesIcon />
          <span className={styles.title}>阶段</span>
          <span className={styles.progress}>
            {String(done) + '/' + String(stages.length) + (current !== null ? ' · ' + current : ' · 全部收口')}
          </span>
          {activation !== undefined && (
            <span className={styles.disarmed} title={activation.hint}>{activation.text}</span>
          )}
          <Chevron up={collapsed} />
        </button>
        {!collapsed && (
          <ul className={styles.list}>
            {stages.map((s) => <StageRow key={s.key} stage={s} />)}
            {openTasks.length > 0 && (
              <li className={styles.tasks}>
                <ul className={styles.tasklist}>
                  {openTasks.map((t) => <TaskRow key={t.id} task={t} />)}
                </ul>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  )
}
