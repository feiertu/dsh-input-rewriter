/**
 * 输入重写插件（宿主面，Node 进程）。
 *
 * 编译型 Cordis 插件：加载 playbook → 注册 `ctx.rewrite` 服务 → 注册 playbook
 * 为 dsh skill → 注册 `/input-rewriter` RPC 通道供浏览器面调用。所有注册均经
 * ctx.effect / ctx.plugin / installSettingsSection 绑定到插件生命周期，支持 HMR 干净卸载。
 *
 * @module dsh-input-rewriter
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { loadPlaybooks } from './playbooks'
import { registerPlaybookSkills } from './skills'
import { RewriteService } from './rewrite/service'
import { registerRewriteRpc } from './rpc'

/** 插件运行时名（与包名一致，便于 bundle 注册统一键）。 */
export const name = 'dsh-input-rewriter'

/** 必需服务：llm 提供改写模型，connection 提供宿主↔浏览器 RPC。 */
export const inject = ['llm', 'connection']

/** 插件配置：provider/model 为可选的组合默认值，缺省时以设置里的选择为准。 */
export interface Config {
  provider?: string
  model?: string
  maxOutputTokens?: number
  timeoutMs?: number
}

/** 插件配置 schema。 */
export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  maxOutputTokens: z.number().min(64).default(2048),
  timeoutMs: z.number().min(1000).default(60_000),
})

/** 插件入口。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const playbooks = await loadPlaybooks()

  // 直接在当前 ctx 上实例化服务：Service 构造器经 ctx.reflect.provide 把 `rewrite`
  // 注册到本 fiber，供同一 ctx 的 rpc.ts 直接访问 ctx.rewrite。若改用 ctx.plugin 会
  // 在隔离的子上下文上提供，父 ctx 访问 ctx.rewrite 会抛 “cannot get property
  // "rewrite" without inject”。服务随本 fiber 卸载自动移除，HMR 可干净重载。
  new RewriteService(ctx, {
    provider: config.provider,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens ?? 2048,
    timeoutMs: config.timeoutMs ?? 60_000,
    playbooks,
  })

  registerPlaybookSkills(ctx, playbooks)
  registerRewriteRpc(ctx)
}
