// 构建配置：宿主面（Node）→ lib/index.js，浏览器面（browser）→ lib/client.js。
// 对齐 dsh 官方 client bundle 形态：CJS 产物 + window.__ModuleLoader__.load 包裹，
// 平台共享模块（react / @deepseek-ai/dsh-client-* / cordis）作为 external 由 shell 提供。
import { defineConfig } from 'tsdown'

/** 插件 id —— 必须等于 package.json 的 name，是宿主扫描 / __DSH_BOOT__ / bundle 注册的统一键。 */
const ID = 'dsh-input-rewriter'

/** shell 提供的平台共享模块（不打包进 client bundle，运行时由 dsh shell 注入）。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** 宿主面 runtime 依赖（由 profile pnpm 闭包注入，不打包）。 */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-apiproxy',
] as const

export default defineConfig([
  {
    // 宿主面（Node 进程，完整 Cordis 插件）
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: true,
    clean: false,
    // type: module 下输出 .js/.d.ts（而非固定 .mjs/.d.mts），对齐 package.json 的 main/types/exports。
    fixedExtension: false,
    deps: { neverBundle: [...HOST_EXTERNALS] },
  },
  {
    // 浏览器面（沙箱闭包，经 __ModuleLoader__ 注册）
    entry: { client: 'client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: { neverBundle: [...PLATFORM_MODULES] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
