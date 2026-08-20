import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEBOUNCE_MS,
  REWRITE_MODEL_SETTINGS_SCHEMA,
} from '../src/settings'

describe('REWRITE_MODEL_SETTINGS_SCHEMA', () => {
  it('缺省 debounceMs 为 2000、collectEnabled 为 false', () => {
    const out = REWRITE_MODEL_SETTINGS_SCHEMA({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(out.debounceMs).toBe(DEFAULT_DEBOUNCE_MS)
    expect(out.collectEnabled).toBe(false)
  })

  it('越界 debounceMs（低于下限）抛校验错误', () => {
    expect(() => REWRITE_MODEL_SETTINGS_SCHEMA({
      provider: 'deepseek',
      model: 'deepseek-chat',
      debounceMs: 50,
    })).toThrow()
  })

  it('越界 debounceMs（高于上限）抛校验错误', () => {
    expect(() => REWRITE_MODEL_SETTINGS_SCHEMA({
      provider: 'deepseek',
      model: 'deepseek-chat',
      debounceMs: 20000,
    })).toThrow()
  })
})
