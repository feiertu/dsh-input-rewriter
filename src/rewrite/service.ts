/**
 * 改写服务：暴露 `ctx.rewrite`，聚合场景识别、模型选择、设置持久化与单次改写。
 * 模型选择经 `installSettingsSection` 可选叠加在 settings 服务之上，未挂载时回落
 * 到插件 Config 的组合默认值；两者都缺省时改写返回 `no-model`。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { buildSystemPrompt, buildUserText, detectScenes, recombine, splitInput, type SceneId } from './engine'
import { generateRewrite, type RewriteGeneration } from './llm'
import {
  isModelSelectionConfigured,
  REWRITE_MODEL_SETTINGS_NAMESPACE,
  REWRITE_MODEL_SETTINGS_SCHEMA,
  type RewriteModelSettings,
} from '../settings'
import type { Playbook } from '../core'

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
  private readonly maxOutputTokens: number
  private readonly timeoutMs: number
  private readonly playbookContentById: ReadonlyMap<SceneId, string>
  private source: () => RewriteModelSettings

  constructor(ctx: Context, config: RewriteServiceConfig) {
    super(ctx, 'rewrite')
    this.maxOutputTokens = config.maxOutputTokens
    this.timeoutMs = config.timeoutMs
    this.playbookContentById = new Map(config.playbooks.map((playbook) => [playbook.scene.id, playbook.content]))

    const entry: RewriteModelSettings = { provider: config.provider, model: config.model }
    this.source = () => entry
    installSettingsSection(ctx, REWRITE_MODEL_SETTINGS_NAMESPACE, REWRITE_MODEL_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      onChange: () => { /* 值已由 setSource 捕获，无额外副作用 */ },
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

  /** 核心：识别命中场景（可多场景综合），装配相关 playbook，单次调用改写原始输入。 */
  async rewrite(text: string, signal?: AbortSignal): Promise<RewriteResult> {
    const selection = this.source()
    if (!isModelSelectionConfigured(selection)) {
      return { ok: false, code: 'no-model', message: '尚未配置改写模型，请在设置中选择' }
    }

    const scenes = detectScenes(text)
    const system = buildSystemPrompt(
      scenes
        .map((id) => this.playbookContentById.get(id))
        .filter((content): content is string => content !== undefined),
    )

    // 分段：附件（代码块/多行 JSON/长 token）不进改写模型，改写后逐字拼回。
    const { instruction, attachments } = splitInput(text)
    const userText = buildUserText(instruction, attachments)

    const result: RewriteGeneration = await generateRewrite({
      ctx: this.ctx,
      provider: selection.provider,
      model: selection.model,
      system,
      userText,
      maxOutputTokens: this.maxOutputTokens,
      timeoutMs: this.timeoutMs,
      signal,
    })

    if (!result.ok) {
      return result
    }
    return { ok: true, rewritten: recombine(result.text, attachments), scenes }
  }
}
