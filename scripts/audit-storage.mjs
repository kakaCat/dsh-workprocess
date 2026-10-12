#!/usr/bin/env node
/**
 * **存储审计**（真机可验版）：直接对 `~/.dsh/storages/workprocess.json` 跑一遍
 * `ctx.workprocess.audit()` 的同款检查，并逐条给出裁决。
 *
 * 【为什么要有它】`ctx.workprocess.audit()` 的真机可观测面很窄：宿主桌面**不挂** `invariants`
 * 服务（没有 provider），插件装载时那条 `logger.warn` 也读不到（当前运行不写日志）。
 * 而"已落盘的状态还自洽吗"这件事本身值得随时能查——于是把它做成命令：
 * 不需要宿主、不需要服务、不需要重启，读一遍盘就出裁决。
 *
 * 【判据在哪】**内核的纯函数 `auditWorkRecord`**（`workprocess/dist`），本脚本只读盘 + 排版。
 * 这里曾经抄过一份规则，抄漏了"逐任务回合账"那条（头注释还写着"与内核/服务同口径"）——
 * 同一个判据三处副本必然漂移，故判据只此一处，本脚本只做调用方。
 *   ① 严格解码：形状 / 阶段串行 / id 唯一性 / 墓碑一致性（`decodeWorkProcess`）
 *   ② 归属边界：`workProcess.id` 必须等于 `wp:<记录键>`
 *   ③ 读数合法：`rounds.started` 与逐任务回合账（`rounds.tasks`）是非负安全整数；
 *      `rounds.activation` ∈ {armed, disarmed}
 *
 * 前置：先 `pnpm build`（本脚本 import 的是构建产物，与宿主加载的是同一份）。
 * 用法：node scripts/audit-storage.mjs [存储文件路径]
 * 退出码：0 = 全部通过（含"没有流程"）；1 = 有发现。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { auditWorkRecord } from '../workprocess/dist/index.js'

const file = process.argv[2] ?? join(homedir(), '.dsh', 'storages', 'workprocess.json')
const raw = JSON.parse(readFileSync(file, 'utf8'))
const records = raw?.tables?.processes ?? {}

let problems = 0
let flows = 0
console.log('审计文件：' + file)
for (const [scope, record] of Object.entries(records)) {
  const findings = auditWorkRecord(scope, record)
  const hasFlow = record?.workProcess !== undefined
  if (hasFlow) flows += 1
  if (findings.length === 0) {
    console.log(`  ✓ ${scope}${hasFlow ? '' : '（无流程记录）'}`)
    continue
  }
  problems += findings.length
  console.log(`  ✗ ${scope}`)
  for (const finding of findings) console.log('      - ' + finding)
}
console.log(`\n流程记录 ${flows} 条，问题 ${problems} 条。`)
process.exit(problems === 0 ? 0 : 1)
