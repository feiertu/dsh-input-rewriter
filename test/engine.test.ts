import { describe, expect, it } from 'vitest'
import {
  buildSystemPrompt,
  buildUserText,
  detectScenes,
  recombine,
  splitInput,
} from '../src/rewrite/engine'

describe('detectScenes', () => {
  it('命中 coding 关键词', () => {
    expect(detectScenes('帮我写一个 python 爬虫，有 bug 要调')).toEqual(['coding'])
  })

  it('多场景按命中数降序取 Top-2', () => {
    const scenes = detectScenes('写个 python 脚本分析实验数据')
    expect(scenes).toContain('coding')
    expect(scenes).toContain('academic')
    expect(scenes).toHaveLength(2)
  })

  it('无命中回落 general', () => {
    expect(detectScenes('今天天气怎么样')).toEqual(['general'])
  })
})

describe('splitInput', () => {
  it('抽取代码围栏为附件', () => {
    const { instruction, attachments } = splitInput('帮我解释这段代码\n```python\nprint(1)\n```\n并说明思路')
    expect(attachments).toHaveLength(1)
    expect(attachments[0].kind).toBe('code')
    expect(attachments[0].content).toContain('print(1)')
    expect(instruction).not.toContain('print(1)')
    expect(instruction).toContain('【附件1】')
  })
})

describe('recombine', () => {
  it('占位符原位替换', () => {
    const attachments = [{ marker: '【附件1】', kind: 'code' as const, content: '```\ncode\n```' }]
    expect(recombine('答案见【附件1】', attachments)).toBe('答案见```\ncode\n```')
  })

  it('缺失附件追加末尾', () => {
    const attachments = [{ marker: '【附件1】', kind: 'block' as const, content: 'data' }]
    const out = recombine('没有占位的输出', attachments)
    expect(out).toContain('【附件1】')
    expect(out).toContain('data')
  })
})

describe('buildSystemPrompt', () => {
  it('包含前置说明、playbook 与输出约束', () => {
    const s = buildSystemPrompt(['PLAYBOOK_A'])
    expect(s).toContain('PLAYBOOK_A')
    expect(s).toContain('只输出改写后的 prompt 文本本身')
  })

  it('#1 寒暄/非诉求输入直接原样返回', () => {
    const s = buildSystemPrompt([])
    expect(s).toContain('不构成明确诉求')
    expect(s).toContain('直接原样输出输入本身')
  })

  it('#3 句子层次不明用编号/缩进分层并给被指代原文加双引号', () => {
    const s = buildSystemPrompt([])
    expect(s).toContain('用编号与缩进把层级划分清楚')
    expect(s).toContain('用双引号把该原文包起来')
  })
})

describe('buildUserText', () => {
  it('无附件时直接返回指令', () => {
    expect(buildUserText('指令', [])).toBe('指令')
  })

  it('有附件时附带占位说明', () => {
    const text = buildUserText('指令', [{ marker: '【附件1】', kind: 'code', content: 'x'.repeat(10) }])
    expect(text).toContain('指令')
    expect(text).toContain('【附件1】')
  })
})
