/**
 * 微调样本采集的纯函数面：注释 prompt 组装、语气动词清单、注释结果解析、
 * JSONL 行序列化。不碰 I/O，便于单测。采集独立于改写主链路，任何失败静默丢弃。
 */

/** 交流语气动词清单（instruction 固定为「以用户语气<动词>」）。 */
export const TONE_VERBS = [
  '沟通', '聊天', '互动', '探讨', '商榷', '切磋', '交际',
  '汇报', '报告', '述职', '总结', '通报', '叮嘱', '交代', '告诫',
] as const

/** 一条「模仿用户口吻」的微调样本（LLaMA-Factory / alpaca 格式）。 */
export interface TrainingSample {
  instruction: string
  input: string
  output: string
}

/** 注释模型的系统 prompt：给定 output（用户原文），反推语气动词与上下文 input。 */
export const ANNOTATION_SYSTEM_PROMPT = [
  '你是一个「用户口吻」微调数据标注助手。',
  '给定一条用户原始消息（output），你需要：',
  '1. 从下面的语气动词清单里选一个最贴切的，填入 verb。',
  `语气动词清单：${TONE_VERBS.join('、')}`,
  '2. 反推一个合理的上下文 input：即会引出这条 output 的问题或情境，用自然中文描述。',
  '',
  '只输出一个 JSON 对象，形如 {"verb":"沟通","input":"…"}。不要任何解释、不要 Markdown 代码块。',
].join('\n')

/** 注释模型的单次输出 token 上限（结果仅一个短 JSON）。 */
export const ANNOTATION_MAX_TOKENS = 256

/** 注释模型的单次调用超时（毫秒）。 */
export const ANNOTATION_TIMEOUT_MS = 30_000

/** 从注释模型返回的原文里解析出 { verb, input }；无法解析时返回 undefined。 */
export function parseAnnotation(raw: string): { verb: string; input: string } | undefined {
  const text = raw.trim()
  // 容错：剥掉 ```json … ``` 围栏（部分模型会额外包裹）。
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
  const body = fenced !== null ? fenced[1] : text
  try {
    const parsed = JSON.parse(body) as { verb?: unknown; input?: unknown }
    if (typeof parsed.verb === 'string' && typeof parsed.input === 'string') {
      const verb = parsed.verb.trim()
      const input = parsed.input.trim()
      if (verb.length > 0 && input.length > 0) return { verb, input }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 把 verb 规整到清单内（不在清单时回落「沟通」，保持 taxonomy 稳定）。 */
export function normalizeVerb(verb: string): string {
  return (TONE_VERBS as readonly string[]).includes(verb) ? verb : '沟通'
}

/** 组装一条微调样本（instruction 固定为「以用户语气<动词>」，output 为用户原文）。 */
export function toTrainingSample(output: string, verb: string, input: string): TrainingSample {
  return {
    instruction: `以用户语气${normalizeVerb(verb)}`,
    input,
    output,
  }
}

/** 序列化为一行 JSONL（末尾带换行，可多次 appendFile 拼接）。 */
export function serializeTrainingLine(sample: TrainingSample): string {
  return JSON.stringify(sample) + '\n'
}
