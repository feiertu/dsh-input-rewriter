/**
 * 改写服务：暴露 `ctx.rewrite`，聚合模型选择持久化与框架无关改写核心。
 * 模型选择经 `installSettingsSection` 可选叠加在 settings 服务之上，未挂载时回落
 * 到插件 Config 的组合默认值；两者都缺省时改写返回 `no-model`。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { createRewriter, type LlmLike, type Playbook, type Rewriter } from '../core'
import { dshLlmLike } from './llm'
import type { SceneId } from './engine'
import {
  DEFAULT_DEBOUNCE_MS,
  isModelSelectionConfigured,
  REWRITE_MODEL_SETTINGS_NAMESPACE,
  REWRITE_MODEL_SETTINGS_SCHEMA,
  type RewriteModelSettings,
} from '../settings'
import {
  ANNOTATION_MAX_TOKENS,
  ANNOTATION_SYSTEM_PROMPT,
  ANNOTATION_TIMEOUT_MS,
  parseAnnotation,
  serializeTrainingLine,
  toTrainingSample,
} from './annotate'

/**
 * 采集样本写入的项目内 `data/` 目录：相对包根解析。产物态 `lib/index.js` 位于包内一层，
 * `import.meta.url` 的 `../data/` 即包根 `data/`；本模块经 tsdown 打包进 `lib/index.js`，
 * 运行时以产物态为准（与 `skills/` 目录的解析方式一致）。
 */
const COLLECT_FILE_DIR = fileURLToPath(new URL('../data/', import.meta.url))
const COLLECT_FILE = path.join(COLLECT_FILE_DIR, 'finetune.jsonl')

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
  private readonly llm: LlmLike
  private source: () => RewriteModelSettings

  constructor(ctx: Context, config: RewriteServiceConfig) {
    super(ctx, 'rewrite')

    const entry: RewriteModelSettings = {
      provider: config.provider,
      model: config.model,
      collectEnabled: false,
      debounceMs: DEFAULT_DEBOUNCE_MS,
    }
    this.source = () => entry
    installSettingsSection(ctx, REWRITE_MODEL_SETTINGS_NAMESPACE, REWRITE_MODEL_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      onChange: () => { /* 值已由 setSource 捕获，无额外副作用 */ },
    })

    // 改写与采集共用同一个 llm 适配器；provider/model 在调用时经 this.source() 解析。
    const llm = dshLlmLike(ctx, () => this.source())
    this.llm = llm
    this.rewriter = createRewriter({
      llm,
      playbooks: config.playbooks,
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
    })
  }

  /** 当前生效的模型选择（provider/model 均缺省表示未配置）。 */
  currentSelection(): RewriteModelSettings {
    return this.source()
  }

  /** 持久化模型选择到 settings 服务（未挂载时静默忽略；合并写，保留采集开关）。 */
  async saveSelection(next: RewriteModelSettings): Promise<void> {
    await this.ctx.get('settings')?.update(REWRITE_MODEL_SETTINGS_NAMESPACE, {
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

  /** 是否开启微调样本采集。 */
  isCollectionEnabled(): boolean {
    return this.source().collectEnabled === true
  }

  /** 持久化采集开关（未挂载 settings 时静默忽略）。 */
  async saveCollection(enabled: boolean): Promise<void> {
    await this.ctx.get('settings')?.update(REWRITE_MODEL_SETTINGS_NAMESPACE, { collectEnabled: enabled })
  }

  /** 当前生效的自动改写防抖时间（毫秒）；未配置时回落默认值。 */
  currentDebounceMs(): number {
    const value = this.source().debounceMs
    return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DEBOUNCE_MS
  }

  /** 持久化自动改写防抖时间；夹取到 [200, 10000] 并取整到 100 的倍数以匹配 schema。 */
  async saveDebounce(ms: number): Promise<void> {
    const clamped = Math.min(10000, Math.max(200, Math.round(ms / 100) * 100))
    await this.ctx.get('settings')?.update(REWRITE_MODEL_SETTINGS_NAMESPACE, { debounceMs: clamped })
  }

  /**
   * 采集一条微调样本：注释模型反推 { verb, input }，组装成「以用户语气<verb>」，
   * 追加写入本地 JSONL。开关关闭或注释失败时返回 false（静默丢弃，不影响主链路）。
   */
  async collect(output: string): Promise<boolean> {
    if (!this.isCollectionEnabled()) return false
    try {
      const raw = await this.annotate(output)
      const parsed = parseAnnotation(raw)
      if (parsed === undefined) return false
      const line = serializeTrainingLine(toTrainingSample(output, parsed.verb, parsed.input))
      await mkdir(COLLECT_FILE_DIR, { recursive: true })
      await appendFile(COLLECT_FILE, line, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** 导出累积的 JSONL 内容；文件尚不存在时返回空串。 */
  async exportCollected(): Promise<{ content: string; path: string }> {
    let content = ''
    try {
      content = await readFile(COLLECT_FILE, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { content, path: COLLECT_FILE }
  }

  /** 单次注释调用：复用改写模型，反推语气动词与上下文 input。 */
  private async annotate(output: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('采集标注超时')), ANNOTATION_TIMEOUT_MS)
    try {
      return await this.llm.complete({
        system: ANNOTATION_SYSTEM_PROMPT,
        user: output,
        maxTokens: ANNOTATION_MAX_TOKENS,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
