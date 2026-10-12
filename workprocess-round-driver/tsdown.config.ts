import { defineConfig } from 'tsdown'

/**
 * 每个**装载入口**打成**一个** bundle（对齐宿主 `@deepseek-ai/dsh-goal` 的 tsdown.config.ts）。
 *
 * 【为什么】DSH 的加载器只认 package.json 的 `main`：运行时读到的就是这一个文件。
 * tsc 先出中间态 `dist/types/*.js`（逐模块，便于与源码一一比对），tsdown 再按入口收成
 * `dist/index.js`（伴生件另有 `dist/invariant.js`）；`.d.ts` 随中间态发（见 package.json 的 `files`）。
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
])
