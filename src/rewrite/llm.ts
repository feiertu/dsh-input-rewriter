/**
 * dsh 适配器：把 `ctx.llm.stream` 包装成框架无关的 `LlmLike`。
 * 流式 chunk 组装、finish 校验、文本提取在此处理；超时/取消由核心侧负责。
 * 仅依赖 `@deepseek-ai/dsh-llm` 的 provider 无关词汇，适配任意已注册 adapter。
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason } from '@deepseek-ai/dsh-llm'
import type { LlmLike } from '../core'
import { isModelSelectionConfigured, type RewriteModelSettings } from '../settings'

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

/** 把 `ctx.llm.stream` 包装成 `LlmLike`；provider/model 经 `getSelection` 在调用时解析。 */
export function dshLlmLike(ctx: Context, getSelection: () => RewriteModelSettings): LlmLike {
  return {
    async complete({ system, user, maxTokens, signal }) {
      const selection = getSelection()
      if (!isModelSelectionConfigured(selection)) {
        throw new Error('改写模型未配置')
      }
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({
        provider: selection.provider,
        model: selection.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin', plugin: 'dsh-input-rewriter' },
        })],
        system,
        maxTokens,
        signal,
      })) {
        assembler.push(chunk)
      }
      const err = finishError(assembler.finish)
      if (err !== undefined) throw err
      return extractText(assembler.blocks())
    },
  }
}
