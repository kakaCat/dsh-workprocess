import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/**
 * workprocess **客户端面**的构建配置（单独一个模块，两个入口共用）：
 *   · `tsdown.config.ts` —— 整包构建（node 面 + client 面）时把它拼进去；
 *   · `tsdown.client.config.ts` —— **只打客户端半**（`pnpm build:client`），
 *     供 `pnpm test` 前的 `pretest` 用：产物契约测试要读 `lib/client.js`，而它不依赖 node 面的中间态。
 *
 * 产物契约与宿主 `packages/client/tsdown.client.ts` 一致：CJS + `window.__ModuleLoader__.load({id, factory})`
 * 包壳，`react` / `react/jsx-runtime` 保持 `require` 外置（宿主模块表提供），CSS Modules 由 lightningcss
 * 编译成哈希类名 + 文本、在模块执行时注入一条带 `data-plugin-css` 的 `<style>`。
 */

/** 客户端插件 id：宿主 `__ModuleLoader__` 的注册键（同时是注入样式的 data-plugin 标记）。 */
export const CLIENT_ID = 'workprocess'

/** CSS Modules 的虚拟模块前缀（**不能以 `.css` 结尾**：tsdown 自己的 css 管线会来抢）。 */
const CSS_VIRTUAL = '\0workprocess-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** 客户端半的构建配置（一个入口 → `lib/client.js`）。 */
export const clientConfig: UserConfig = {
  name: `${CLIENT_ID}/client`,
  entry: { client: 'client/index.tsx' },
  // 与 node 面同目录（宿主客户端包也是单个 lib/ 产物目录）；clean 必须关，否则会擦掉 node 面产物。
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: false,
  deps: {
    // `react`（+ 自动 JSX 的 `react/jsx-runtime`）是宿主模块表的行：保持 `require` 外置。
    // 其余一律内联——本模块除 react 外不 import 任何东西（图标 / 样式自足）。
    neverBundle: (specifier: string) => specifier === 'react' || specifier.startsWith('react/'),
    alwaysBundle: (specifier: string) => specifier !== 'react' && !specifier.startsWith('react/'),
  },
  plugins: [
    {
      name: 'workprocess-css-modules',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const file = importer === undefined ? source : resolve(dirname(importer), source)
        return CSS_VIRTUAL + file + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL)) return null
        const file = virtualId.slice(CSS_VIRTUAL.length, -CSS_VIRTUAL_SUFFIX.length)
        // 虚拟 id 会遮住物理样式表：登记进 watch 图，改样式能触发重建。
        this.addWatchFile(file)
        const { code, exports } = transform({
          filename: file,
          code: await readFile(file),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(exports ?? {})) classMap[local] = exp.name
        const tagId = `${CLIENT_ID}/${basename(file)}`
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          'if (typeof document !== \'undefined\''
            + ' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(CLIENT_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    // 产物契约：模块加载器认的闭包工厂（`require` 由加载器注入；exports 由 footer 交回）。
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}
