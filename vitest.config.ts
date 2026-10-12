import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/** 仓根配置：只负责「扫哪些文件」；跨包别名与包内一致（本仓自洽）。 */
const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'workprocess/': at('./workprocess/src/'),
      'workprocess': at('./workprocess/src/index.ts'),
      'workprocess-round-driver/': at('./workprocess-round-driver/src/'),
      'workprocess-round-driver': at('./workprocess-round-driver/src/index.ts'),
      'tool-workprocess/': at('./tool-workprocess/src/'),
      'tool-workprocess': at('./tool-workprocess/src/index.ts'),
      'workprocess/': at('./workprocess/src/'),
      'workprocess': at('./workprocess/src/index.ts'),
      'dsh-command-workprocess/': at('./command-workprocess/src/'),
      'dsh-command-workprocess': at('./command-workprocess/src/index.ts'),
    },
  },
  test: { include: ['*/tests/**/*.spec.ts'] },
})
