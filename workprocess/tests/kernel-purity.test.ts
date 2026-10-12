/**
 * **内核纯度守卫**（合并 workprocess-core 后的模块级纪律）。
 *
 * 原先把"内核零依赖"守在包边界（独立 workprocess-core 包）；合并进 `workprocess` 后包本身
 * 依赖官方包（cordis / dsh-storage-domain），纪律下沉到**模块边界**：内核六个文件只允许
 * 相对导入——不 import 任何东西（对齐宿主 `dsh-goal` 的做法：fold 纯、包里有 cordis）。
 *
 * 这条测试把纪律机械化：谁往内核文件里加了外部 import，当场红。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

/** 内核模块（相对导入以外的一律拒）。 */
const KERNEL_FILES = ['types.ts', 'domain.ts', 'fold.ts', 'invariant.ts', 'runtime.ts', 'stages.ts', 'client.ts']

describe('内核纯度：内核模块不 import 任何东西（合并后的模块级纪律）', () => {
  it('内核七个文件只允许相对导入（非相对 import 即红）', () => {
    const srcDir = new URL('../src/', import.meta.url)
    const present = KERNEL_FILES.filter((f) => readdirSync(srcDir).includes(f))
    expect(present.length).toBe(KERNEL_FILES.length)
    for (const file of KERNEL_FILES) {
      const src = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
      const bad = src.split('\n').filter((line) => /^import\s.*from\s+['"](?!\.)/.test(line.trim()))
      expect(bad, file + ' 引入了外部依赖：\n' + bad.join('\n')).toEqual([])
    }
  })
})
