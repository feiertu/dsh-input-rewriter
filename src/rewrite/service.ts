/**
 * 改写服务：暴露 `ctx.rewrite`，聚合模型选择持久化与框架无关改写核心。
 * 模型选择经 `installSettingsSection` 可选叠加在 settings 服务之上，未挂载时回落
 * 到插件 Config 的组合默认值；两者都缺省时改写返回 `no-model`。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { createRewriter, type Playbook, type Rewriter } from '../core'
import { dshLlmLike } from './llm'
import type { SceneId } from './engine'
import {
  isModelSelectionConfigured,
  REWRITE_MODEL_SETTINGS_NAMESPACE,
  REWRITE_MODEL_SETTINGS_SCHEMA,
  type RewriteModelSettings,
} from '../settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rewrite: RewriteService
  }
}

/** 改写结果：成功返回改写文本与命中场景，失败返回可展示的错误。 */
export type RewriteResult =
  | { ok: true; rewritten: string; scenes: SceneId[] }
  | { ok: false; code: 'no-model' | 'llm-failed' | 'empty-result' | 'timeout'; message: string }

/** RewriteService 的已解析配置（默认值已在 apply() 落定）。 */
export interface RewriteServiceConfig {
  provider?: string
  model?: string
  maxOutputTokens: number
  timeoutMs: number
  playbooks: readonly Playbook[]
}

export class RewriteService extends Service {
  private readonly rewriter: Rewriter
  private source: () => RewriteModelSettings

  constructor(ctx: Context, config: RewriteServiceConfig) {
    super(ctx, 'rewrite')

    const entry: RewriteModelSettings = { provider: config.provider, model: config.model }
    this.source = () => entry
    installSettingsSection(ctx, REWRITE_MODEL_SETTINGS_NAMESPACE, REWRITE_MODEL_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      onChange: () => { /* 值已由 setSource 捕获，无额外副作用 */ },
    })

    this.rewriter = createRewriter({
      llm: dshLlmLike(ctx, () => this.source()),
      playbooks: config.playbooks,
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
    })
  }

  /** 当前生效的模型选择（provider/model 均缺省表示未配置）。 */
  currentSelection(): RewriteModelSettings {
    return this.source()
  }

  /** 持久化模型选择到 settings 服务（未挂载时静默忽略）。 */
  async saveSelection(next: RewriteModelSettings): Promise<void> {
    await this.ctx.get('settings')?.replace(REWRITE_MODEL_SETTINGS_NAMESPACE, {
      provider: next.provider ?? '',
      model: next.model ?? '',
    })
  }

  /** 列出所有可用模型（跨全部 provider，单个 provider 失败不影响其余）。 */
  async listModels(): Promise<LlmModelInfo[]> {
    const result: LlmModelInfo[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      try {
        result.push(...(await this.ctx.llm.listModels(provider.id)))
      } catch {
        // 单个 provider 失败不影响其余 provider 的模型列表。
      }
    }
    return result
  }

  /** 核心：检查模型选择后委托框架无关 rewriter 做单次改写。 */
  async rewrite(text: string, signal?: AbortSignal): Promise<RewriteResult> {
    const selection = this.source()
    if (!isModelSelectionConfigured(selection)) {
      return { ok: false, code: 'no-model', message: '尚未配置改写模型，请在设置中选择' }
    }
    return this.rewriter.rewrite(text, signal)
  }
}
