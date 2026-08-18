/**
 * 模型适配层：把一次「输入改写」包装为单次 `ctx.llm.stream` 调用，
 * 组装流式 chunk、校验 finish、提取文本，并施加超时与取消。
 * 仅依赖 `@deepseek-ai/dsh-llm` 的 provider 无关词汇，天然适配任意已注册 adapter。
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'

/** 一次改写生成的入参（已解析 provider/model，与 UI/会话无关）。 */
export interface RewriteGenerationInput {
  ctx: Context
  provider: string
  model: string
  /** 组装好的系统 prompt（通用角色 + 全部 playbook + 输出约束）。 */
  system: string
  /** 用户原始输入。 */
  userText: string
  maxOutputTokens: number
  timeoutMs: number
  /** 调用方取消信号（可选）。 */
  signal?: AbortSignal
}

/** 改写生成结果：成功返回文本，失败返回机器可读 code + 展示用 message。 */
export type RewriteGeneration =
  | { ok: true; text: string }
  | { ok: false; code: 'llm-failed' | 'empty-result' | 'timeout'; message: string }

/** 从组装后的 ContentBlock 里提取纯文本（过滤图片/工具调用等非文本块）。 */
function extractText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim()
}

/** 把终态 finish reason 映射为失败错误（stop/tool-calls 视为成功）。 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new Error(finish.failure.message)
    case 'max-tokens':
      return new Error('改写结果被 token 上限截断')
    default:
      return undefined
  }
}

/** 执行一次改写生成。 */
export async function generateRewrite(input: RewriteGenerationInput): Promise<RewriteGeneration> {
  const { ctx, provider, model, system, userText, maxOutputTokens, timeoutMs } = input

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`改写超时（${timeoutMs}ms）`))
  }, timeoutMs)
  const propagate = () => controller.abort(input.signal?.reason)
  if (input.signal !== undefined) {
    if (input.signal.aborted) propagate()
    else input.signal.addEventListener('abort', propagate, { once: true })
  }

  try {
    const options: GenerateOptions = {
      provider,
      model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: userText }],
        source: { kind: 'plugin', plugin: 'dsh-input-rewriter' },
      })],
      system,
      maxTokens: maxOutputTokens,
      signal: controller.signal,
    }

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) {
      assembler.push(chunk)
    }

    const terminalError = finishError(assembler.finish)
    if (terminalError !== undefined) {
      return { ok: false, code: timedOut ? 'timeout' : 'llm-failed', message: terminalError.message }
    }

    const text = extractText(assembler.blocks())
    if (text.length === 0) {
      return { ok: false, code: 'empty-result', message: '改写模型未输出文本' }
    }
    return { ok: true, text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: timedOut ? 'timeout' : 'llm-failed', message }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', propagate)
  }
}
