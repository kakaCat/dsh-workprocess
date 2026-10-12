/**
 * **内核纯度守卫**（合并 workprocess-core 后的模块级纪律）。
 *
 * 原先把"内核零依赖"守在包边界（独立 workprocess-core 包）；合并进 `workprocess` 后包本身
 * 依赖官方包（cordis / dsh-storage-domain），纪律下沉到**模块边界**：内核**六个**文件只允许
 * 相对导入——不 import 任何东西（对齐宿主 `dsh-goal` 的做法：fold 纯、包里有 cordis）。
 *
 * 为什么是六个而不是七个：`invariant.ts` 已**让位给伴生插件入口**（对齐宿主
 * `dsh-goal/src/invariant.ts` 的角色），域不变量的纯检查并进了 `fold.ts`（同宿主：严格校验
 * 沉在折叠层）。伴生件**必须**有不纯的 import（cordis 类型 + 事件总线），所以它不在本名单里，
 * 由下面第二条守卫按"伴生件形态"单独钉。
 *
 * 这条测试把纪律机械化：谁往内核文件里加了外部 import，当场红。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

/** 内核模块（相对导入以外的一律拒）。 */
const KERNEL_FILES = ['types.ts', 'domain.ts', 'fold.ts', 'runtime.ts', 'stages.ts', 'client.ts']

describe('内核纯度：内核模块不 import 任何东西（合并后的模块级纪律）', () => {
  it('内核六个文件只允许相对导入（非相对 import 即红）', () => {
    const srcDir = new URL('../src/', import.meta.url)
    const present = KERNEL_FILES.filter((f) => readdirSync(srcDir).includes(f))
    expect(present.length).toBe(KERNEL_FILES.length)
    for (const file of KERNEL_FILES) {
      const src = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
      const bad = src.split('\n').filter((line) => /^import\s.*from\s+['"](?!\.)/.test(line.trim()))
      expect(bad, file + ' 引入了外部依赖：\n' + bad.join('\n')).toEqual([])
    }
  })

  it('伴生件 `invariant.ts` 是**入口**而不是内核（形态与宿主 invariant.js 同构）', () => {
    const src = readFileSync(new URL('../src/invariant.ts', import.meta.url), 'utf8')
    // ① 宿主同款三件套：`name` / `inject: ['invariants']` / `apply`
    expect(src).toMatch(/export const name = 'workprocess-invariant'/)
    expect(src).toMatch(/export const inject = \['invariants'\]/)
    expect(src).toMatch(/export const apply = /)
    // ② 它必须真的是"不纯的入口"：要 import cordis（否则就是纯检查又混回来了）
    expect(src).toMatch(/^import .*from '@deepseek-ai\/cordis'/m)
    // ③ 领域入口**不得**再导出它：伴生件只在宿主挂了 invariants 服务时单独装载
    for (const entry of ['index.ts', 'kernel.ts']) {
      const entrySrc = readFileSync(new URL('../src/' + entry, import.meta.url), 'utf8')
      expect(entrySrc, entry + ' 不应再导出 ./invariant.js（那是伴生入口）')
        .not.toMatch(/export \* from '\.\/invariant\.js'/)
    }
  })

  it('错误码的家在**域词汇表**：码表定义在 domain.ts，runtime.ts 只 import（对齐宿主 GoalErrorCode）', () => {
    const domainSource = readFileSync(new URL('../src/domain.ts', import.meta.url), 'utf8')
    expect(domainSource).toMatch(/export const WORK_ERROR_CODES = \[/)
    const runtimeSource = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8')
    // 宿主 `goal/src/runtime.ts` 就是这一句：`import type { GoalErrorCode } from './domain.ts'`
    expect(runtimeSource).toMatch(/import type \{ WorkErrorCode \} from '\.\/domain\.js'/)
    expect(runtimeSource).not.toMatch(/export const WORK_ERROR_CODES/)
    // 工具面的政策码不许在域侧定义（两本各回各家；文案里提一句不算）。
    expect(runtimeSource).not.toMatch(/'WORK_TOOL_/)
    expect(domainSource).not.toMatch(/'WORK_TOOL_/)
  })
})
