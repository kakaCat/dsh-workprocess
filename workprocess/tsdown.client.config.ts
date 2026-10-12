import { defineConfig } from 'tsdown'
import { clientConfig } from './tsdown.client.ts'

/**
 * **只打客户端半**（`pnpm build:client`）：产物 `lib/client.js`。
 *
 * 【为什么单独一个入口】产物契约测试（`tests/client.spec.ts`）读的就是 `lib/client.js`，
 * 而整包构建（`tsdown.config.ts`）的 node 面要先有 `tsc` 出的 `dist/types/`；
 * 这个入口不依赖那一步，于是 `pnpm test` 前的 `pretest` 能只花一次客户端构建的时间。
 */
export default defineConfig([clientConfig])
