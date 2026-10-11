import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * 包内自跑配置：只声明「本包扫哪些文件」与跨包别名（本仓自洽，不依赖任何外部仓的基座）。
 *
 * 用法：`cd workprocess/command-workprocess && pnpm test`（或仓根 `pnpm test` 全跑）。
 */
const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'workprocess/': at('../workprocess/src/'),
      'workprocess': at('../workprocess/src/index.ts'),
      'dsh-workprocess/': at('../dsh-workprocess/src/'),
      'dsh-workprocess': at('../dsh-workprocess/src/index.ts'),
      'dsh-command-workprocess/': at('../command-workprocess/src/'),
      'dsh-command-workprocess': at('../command-workprocess/src/index.ts'),
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
})
