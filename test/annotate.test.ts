import { describe, expect, it } from 'vitest'
import {
  normalizeVerb,
  parseAnnotation,
  serializeTrainingLine,
  toTrainingSample,
} from '../src/rewrite/annotate'

describe('parseAnnotation', () => {
  it('解析纯净 JSON', () => {
    expect(parseAnnotation('{"verb":"沟通","input":"有人问你在干嘛"}')).toEqual({
      verb: '沟通',
      input: '有人问你在干嘛',
    })
  })

  it('剥掉 markdown 围栏后解析', () => {
    expect(parseAnnotation('```json\n{"verb":"汇报","input":"向领导汇报进展"}\n```')).toEqual({
      verb: '汇报',
      input: '向领导汇报进展',
    })
  })

  it('非 JSON 返回 undefined', () => {
    expect(parseAnnotation('这不是 JSON')).toBeUndefined()
  })

  it('字段缺失返回 undefined', () => {
    expect(parseAnnotation('{"verb":"沟通"}')).toBeUndefined()
  })
})

describe('normalizeVerb', () => {
  it('清单内的动词原样返回', () => {
    expect(normalizeVerb('商榷')).toBe('商榷')
  })

  it('清单外的动词回落「沟通」', () => {
    expect(normalizeVerb('闲聊')).toBe('沟通')
  })
})

describe('toTrainingSample', () => {
  it('组装 instruction/output 并规整动词', () => {
    const sample = toTrainingSample('关你屁事。', '沟通', '有人问你在干嘛')
    expect(sample).toEqual({
      instruction: '以用户语气沟通',
      input: '有人问你在干嘛',
      output: '关你屁事。',
    })
  })
})

describe('serializeTrainingLine', () => {
  it('输出一行 JSONL（末尾带换行）', () => {
    const line = serializeTrainingLine({ instruction: '以用户语气沟通', input: 'a', output: 'b' })
    expect(line).toBe('{"instruction":"以用户语气沟通","input":"a","output":"b"}\n')
  })
})
