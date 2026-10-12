import { defineConfig } from 'tsdown'
import { clientConfig } from './tsdown.client.ts'

/**
 * workprocess 的**整包构建**（node 面 + 客户端面）。
 *
 * 【node 面】每个**装载入口**收成**一个**文件：DSH 加载器只认 package.json 的 `main`。
 * tsc 先出中间态 `dist/types/*.js`（逐模块，便于与源码一一比对），tsdown 再收成
 * `dist/index.js`（伴生件另有 `dist/invariant.js`）；`.d.ts` 随中间态发（见 package.json 的 `files`）。
 *
 * 【client 面】`client/*.tsx` → `lib/client.js`：配置在 `tsdown.client.ts`（只打客户端半的
 * `tsdown.client.config.ts` 共用同一份）。
 */
export default defineConfig([
  {
    entry: ['dist/types/index.js'],
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['dist/types/invariant.js'],
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  clientConfig,
])
