/**
 * 框架无关改写核心：LlmLike 抽象 + createRewriter 工厂。
 * 零 dsh 依赖（仅 import engine 的纯函数/类型），可在 Node / browser / edge 运行。
 *
 * @module dsh-input-rewriter/core
 */

import {
  buildSystemPrompt,
  buildUserText,
  detectScenes,
  recombine,
  splitInput,
  type SceneId,
  type SceneMeta,
} from './rewrite/engine'
export { SCENES } from './rewrite/engine'
export type { SceneId, SceneMeta } from './rewrite/engine'

/** 调用方提供的单次文本生成能力（框架无关；具体 SDK 由调用方适配）。 */
export interface LlmLike {
  complete(input: {
    system: string
    user: string
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<string>
}

/** 改写结果：成功返回改写文本与命中场景，失败返回机器可读 code + 展示用 message。 */
export type CoreRewriteResult =
  | { ok: true; rewritten: string; scenes: SceneId[] }
  | { ok: false; code: 'llm-failed' | 'empty-result' | 'timeout'; message: string }

/** 一份 playbook：场景元数据 + 改写指令原文。 */
export interface Playbook {
  scene: SceneMeta
  content: string
}

export interface CreateRewriterOptions {
  llm: LlmLike
  playbooks: readonly Playbook[]
  /** 单次改写最大输出 token，默认 2048。 */
  maxOutputTokens?: number
  /** 单次改写超时（毫秒），默认 60000。 */
  timeoutMs?: number
}

export interface Rewriter {
  rewrite(text: string, signal?: AbortSignal): Promise<CoreRewriteResult>
}

/** 组装框架无关的改写器：全链路（场景识别→附件分段→拼 playbook→调 LLM→拼回）。 */
export function createRewriter(options: CreateRewriterOptions): Rewriter {
  const { llm, playbooks } = options
  const maxOutputTokens = options.maxOutputTokens ?? 2048
  const timeoutMs = options.timeoutMs ?? 60_000

  const playbookContentById = new Map(playbooks.map((playbook) => [playbook.scene.id, playbook.content]))

  return {
    async rewrite(text: string, signal?: AbortSignal): Promise<CoreRewriteResult> {
      const scenes = detectScenes(text)
      const system = buildSystemPrompt(
        scenes
          .map((id) => playbookContentById.get(id))
          .filter((content): content is string => content !== undefined),
      )

      const { instruction, attachments } = splitInput(text)
      const user = buildUserText(instruction, attachments)

      const controller = new AbortController()
      let timedOut = false
      let cancelled = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`改写超时（${timeoutMs}ms）`))
      }, timeoutMs)
      const propagate = () => {
        cancelled = true
        controller.abort(signal?.reason)
      }
      if (signal !== undefined) {
        if (signal.aborted) propagate()
        else signal.addEventListener('abort', propagate, { once: true })
      }

      try {
        const result = await llm.complete({
          system,
          user,
          maxTokens: maxOutputTokens,
          signal: controller.signal,
        })
        if (result.trim().length === 0) {
          return { ok: false, code: 'empty-result', message: '改写模型未输出文本' }
        }
        return { ok: true, rewritten: recombine(result, attachments), scenes }
      } catch (error) {
        if (timedOut) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, code: 'timeout', message }
        }
        if (cancelled) return { ok: false, code: 'llm-failed', message: '改写已取消' }
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, code: 'llm-failed', message }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', propagate)
      }
    },
  }
}
