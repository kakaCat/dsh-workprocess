#!/usr/bin/env node
// 复核 docs/workprocess-popup-repro.md 的「出口清单」：每条锚点 `路径:行号` 必须**真的**在该行含有所写的片段。
//
// 为什么需要它：清单的价值全在"可点名"——行号会随编辑漂移，而锈掉的清单比没有更坏（照它去读会读到别的代码）。
// 用法：node scripts/check-popup-exits.mjs   （退出码 0 = 全部命中；1 = 有漂移/对不上）
//
// 宿主侧行（`deepseek-harness/...`）按兄弟目录解析；宿主树不在这台机器上时**如实跳过**（不假装通过、也不判失败）。
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const doc = join(root, 'docs/workprocess-popup-repro.md')
const hostRoot = resolve(root, process.env.DSH_HOST_ROOT ?? '../deepseek-harness')

/** 一行表格 → { id, anchor 的 path/line, fragment }；不是锚点行则返回 undefined。 */
function rowOf(line) {
  const cells = line.split('|')
  if (cells.length < 6) return undefined
  const id = cells[1].trim()
  if (!/^[A-Z]\d+$/.test(id)) return undefined
  const anchor = cells[3].trim().replace(/`/g, '')
  const matched = /^(.+):(\d+)$/.exec(anchor)
  if (matched === undefined) return undefined
  return { id, path: matched[1], line: Number(matched[2]), anchor, fragment: cells[4].trim().replace(/`/g, '') }
}

/** 锚点路径 → 本机绝对路径；宿主侧行按 hostRoot 解析。 */
function resolveAnchor(path) {
  return path.startsWith('deepseek-harness/')
    ? { file: join(hostRoot, path.slice('deepseek-harness/'.length)), host: true }
    : { file: join(root, path), host: false }
}

const rows = readFileSync(doc, 'utf8').split('\n').map(rowOf).filter((r) => r !== undefined)
let ok = 0
let skipped = 0
const failures = []

for (const row of rows) {
  const { file, host } = resolveAnchor(row.path)
  if (!existsSync(file)) {
    if (host) {
      skipped += 1
      console.log(`skip  ${row.id}  ${row.anchor}  （宿主源码不在本机：${file}）`)
      continue
    }
    failures.push(`${row.id} ${row.anchor}：文件不存在 ${file}`)
    continue
  }
  const text = readFileSync(file, 'utf8').split('\n')[row.line - 1]
  if (text === undefined) {
    failures.push(`${row.id} ${row.anchor}：文件只有 ${readFileSync(file, 'utf8').split('\n').length} 行`)
    continue
  }
  if (!text.includes(row.fragment)) {
    failures.push(`${row.id} ${row.anchor}：该行不含片段「${row.fragment}」\n      实际：${text.trim()}`)
    continue
  }
  ok += 1
}

console.log(`出口清单锚点：${ok}/${rows.length} 命中${skipped === 0 ? '' : `，${skipped} 条宿主侧跳过`}`)
for (const failure of failures) console.log('FAIL  ' + failure)
process.exit(failures.length === 0 ? 0 : 1)
