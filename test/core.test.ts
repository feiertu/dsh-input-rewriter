import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRewriter, SCENES, type LlmLike, type Playbook } from '../src/core'

const playbooks: readonly Playbook[] = SCENES.map((scene) => ({ scene, content: `PLAYBOOK_${scene.id}` }))

const okLlm = (text: string): LlmLike => ({ complete: async () => text })

describe('createRewriter.rewrite', () => {
  afterEach(() => { vi.useRealTimers() })

  it('从 core 导出 SCENES 供外部消费者构建 playbook', () => {
    expect(SCENES).toHaveLength(7)
    expect(SCENES.map((s) => s.id)).toContain('general')
  })

  it('命中场景并返回改写结果', async () => {
    const rewriter = createRewriter({ llm: okLlm('改写后'), playbooks })
    const result = await rewriter.rewrite('帮我写一个 python 爬虫')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.scenes).toEqual(['coding'])
      expect(result.rewritten).toBe('改写后')
    }
  })

  it('附件（代码块）改写后原位拼回', async () => {
    const code = '```python\nprint(1)\n```'
    const rewriter = createRewriter({ llm: okLlm('解释见【附件1】'), playbooks })
    const result = await rewriter.rewrite(`解释这段\n${code}`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rewritten).toContain(code)
    }
  })

  it('complete 抛错映射 llm-failed', async () => {
    const llm: LlmLike = { complete: async () => { throw new Error('boom') } }
    const rewriter = createRewriter({ llm, playbooks })
    const result = await rewriter.rewrite('hello')
    expect(result).toEqual({ ok: false, code: 'llm-failed', message: 'boom' })
  })

  it('complete 返回空串映射 empty-result', async () => {
    const rewriter = createRewriter({ llm: okLlm('   '), playbooks })
    const result = await rewriter.rewrite('hello')
    expect(result).toEqual({ ok: false, code: 'empty-result', message: '改写模型未输出文本' })
  })

  it('超时映射 timeout', async () => {
    vi.useFakeTimers()
    const llm: LlmLike = {
      complete: ({ signal }) => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('timed out')))
      }),
    }
    const rewriter = createRewriter({ llm, playbooks, timeoutMs: 1000 })
    const pending = rewriter.rewrite('hello')
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending
    expect(result).toMatchObject({ ok: false, code: 'timeout' })
  })
})
