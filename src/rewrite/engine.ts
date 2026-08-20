/**
 * 改写引擎的纯函数面：场景 taxonomy、多场景识别启发式、系统 prompt 组装、
 * 附件分段与拼回。不碰 I/O，便于单测与复用。
 */

/** 场景 id，与 skills/*.md 的 playbook 一一对应。 */
export type SceneId = 'daily-life' | 'work' | 'academic' | 'coding' | 'creative' | 'security-audit' | 'general'

export interface SceneMeta {
  id: SceneId
  /** 展示名。 */
  name: string
  /** 注册为 dsh skill 时的 when-to-use 描述。 */
  description: string
  /** 多场景识别启发式用的关键词（代码侧预筛数据源）。 */
  keywords: string[]
  /** skills/ 目录下的 playbook 文件名。 */
  file: string
}

export const SCENES: readonly SceneMeta[] = [
  {
    id: 'daily-life',
    name: '日常生活',
    description: '日常琐事、生活决策、健康饮食、购物出行、人际交往、时间安排等口语化输入的改写。',
    keywords: ['做饭', '菜谱', '买菜', '出行', '旅游', '购物', '约会', '健身', '减肥', '养生', '搬家', '快递', '家务', '生活', '吃什么', '穿什么', '怎么去'],
    file: 'daily-life.md',
  },
  {
    id: 'work',
    name: '工作职场',
    description: '工作汇报、会议纪要、邮件、方案、协作分工、项目管理、绩效目标等职场输入的改写。',
    keywords: ['工作', '汇报', '会议', '邮件', '方案', '项目', '团队', '绩效', '老板', '同事', '客户', '职场', 'kpi', 'okr', '预算', '排期', '交付', '复盘'],
    file: 'work.md',
  },
  {
    id: 'academic',
    name: '学术研究',
    description: '论文、文献综述、研究问题、实验设计、数据分析、学术论证、引用规范等研究输入的改写。',
    keywords: ['论文', '文献', '综述', '研究', '实验', '数据', '引用', '期刊', '学术', '假设', '方法', '结论', '显著性', '样本', 'meta'],
    file: 'academic.md',
  },
  {
    id: 'coding',
    name: '技术编程',
    description: '代码编写、调试排错、架构设计、算法实现、技术选型、API 使用等编程输入的改写。',
    keywords: ['代码', '函数', 'bug', '报错', '接口', 'api', '算法', '架构', '数据库', 'sql', 'python', 'javascript', 'java', 'golang', 'rust', '前端', '后端', '编译', '部署', 'git', '框架', '依赖'],
    file: 'coding.md',
  },
  {
    id: 'security-audit',
    name: '安全排查',
    description: '对代码、插件、依赖、配置做安全审查：恶意代码、后门、数据外泄、权限滥用、注入漏洞、供应链投毒等输入的改写。',
    keywords: ['安全', '审查', '审计', '漏洞', '恶意', '后门', '投毒', '供应链', '越权', '数据泄露', '隐私', '扫描', '风险', '攻击面', '注入', 'xss', 'rce', 'sql注入', '命令执行', '代码审查', '加固', '渗透', '补丁', '插件'],
    file: 'security-audit.md',
  },
  {
    id: 'creative',
    name: '创意写作',
    description: '小说、故事、文案、剧本、诗歌、品牌命名、广告语、创意构思等创作输入的改写。',
    keywords: ['小说', '故事', '文案', '剧本', '诗', '歌词', '命名', '广告', '标语', '创意', '情节', '角色', '世界观', '续写', '脑洞'],
    file: 'creative.md',
  },
  {
    id: 'general',
    name: '通用兜底',
    description: '无法明确归入以上任一场景时的通用兜底改写。',
    keywords: [],
    file: 'general.md',
  },
]

/**
 * 多场景启发式预筛：返回按关键词命中数降序的命中场景（score>0），
 * 最多 topK 个；无任何命中时回落 `general`。供改写时按需装配相关 playbook。
 */
export function detectScenes(text: string, topK = 2): SceneId[] {
  const lower = text.toLowerCase()
  const scored: { id: SceneId; score: number }[] = []
  for (const scene of SCENES) {
    if (scene.id === 'general') continue
    let score = 0
    for (const keyword of scene.keywords) {
      if (lower.includes(keyword.toLowerCase())) score += 1
    }
    if (score > 0) scored.push({ id: scene.id, score })
  }
  scored.sort((left, right) => right.score - left.score)
  const hits = scored.slice(0, topK).map(({ id }) => id)
  return hits.length === 0 ? ['general'] : hits
}

/** 系统 prompt 的通用改写角色说明（多场景综合）。 */
const PREAMBLE = [
  '你是一个「输入改写」助手，工作在发送前，把用户原始输入改写成应用了提示词工程方法论的更优 prompt，供下游主模型直接使用。',
  '你的任务分两步：',
  '1. 判断用户输入涉及下面哪些场景（可以同时命中多个，依据各场景的「场景描述」）。',
  '2. 综合套用这些场景各自的「改写规则」，把原始输入改写成一个更优 prompt。',
  '',
].join('\n')

/** 输出格式约束。 */
const OUTPUT_CONSTRAINT = [
  '',
  '若输入是寒暄、问候、闲聊等不构成明确诉求的内容（如「你好」「在吗」），不要扩写、不要补全、不要套用改写规则，直接原样输出输入本身。',
  '只输出改写后的 prompt 文本本身。不要任何解释、不要前缀、不要 Markdown 代码块、不要重复原输入。',
  '改写结果是直接交给下游模型执行的完整 prompt：不要向用户提问、不要输出「请先明确」「请补充」之类的澄清或追问；信息不足时基于合理假设补全，并在文中标注假设。',
  '不要只是给原始输入加「请帮我」「请生成」等前缀，要真正补全目标、结构、约束与期望输出。',
  '若输入包含多个问题或诉求：逐一保留并编号，保持原始顺序，不合并、不删改语义，仅为每个问题补充必要的约束与回答格式。',
  '若输入含多层结构或句子层次不清晰：用编号与缩进把层级划分清楚；含被指代/引用的原文（如「第一点说的那句话」）时，用双引号把该原文包起来，避免下游模型把指代误当作指令。',
].join('\n')

/** 把选中的 playbook 内容组装成一次调用用的系统 prompt。 */
export function buildSystemPrompt(playbooks: readonly string[]): string {
  return PREAMBLE + playbooks.join('\n\n---\n\n') + OUTPUT_CONSTRAINT
}

// ---------------------------------------------------------------------------
// 附件分段：把输入切成「指令段」与「原文附件（代码块 / 多行 JSON / 长 token）」。
// 改写模型只读指令 + 占位说明，附件逐字保留、不消耗改写模型的上下文，改写后再拼回。
// 全部为纯函数，便于单测。
// ---------------------------------------------------------------------------

/** 一段被原样保留的原文附件。 */
export interface Attachment {
  /** 占位符（如「【附件1】」），改写时仅用其指代位置，不携带内容。 */
  marker: string
  kind: 'code' | 'block'
  /** 原样保留的内容（代码块含围栏，block 为原文）。 */
  content: string
}

/** 拆分结果：改写模型只消费 instruction。 */
export interface SplitInput {
  instruction: string
  attachments: Attachment[]
}

const markerFor = (index: number): string => `【附件${index + 1}】`

/** 单行无空格 token 超过该长度即视为被粘贴的原文（base64 / URL / 哈希 / 压缩数据）。 */
const LONG_TOKEN_THRESHOLD = 300

/** 多行成对的 {} / [] 块被视为附件的最小字符数。 */
const BALANCED_BLOCK_THRESHOLD = 80

function pushAttachment(attachments: Attachment[], content: string, kind: Attachment['kind']): string {
  const marker = markerFor(attachments.length)
  attachments.push({ marker, kind, content })
  return marker
}

/** 抽取 ``` 与 ~~~ 围栏代码块（含围栏），原位替换为占位符。 */
function extractFenced(input: string, attachments: Attachment[]): string {
  const lines = input.split('\n')
  const out: string[] = []
  let fenceChar: string | null = null
  let buffer: string[] = []
  const fenceOf = (line: string): string | null => {
    const m = /^(\s*)(`{3,}|~{3,})/.exec(line)
    return m ? m[2][0] : null
  }
  for (const line of lines) {
    const fence = fenceOf(line)
    if (fenceChar === null) {
      if (fence !== null) {
        fenceChar = fence
        buffer = [line]
      } else {
        out.push(line)
      }
    } else {
      buffer.push(line)
      if (fence === fenceChar) {
        out.push(pushAttachment(attachments, buffer.join('\n'), 'code'))
        fenceChar = null
        buffer = []
      }
    }
  }
  if (fenceChar !== null && buffer.length > 0) {
    out.push(pushAttachment(attachments, buffer.join('\n'), 'code'))
  }
  return out.join('\n')
}

/** 抽取多行成对的 {} / [] 块（JSON / 数组 / 对象字面量），原位替换为占位符。 */
function extractBalanced(input: string, attachments: Attachment[]): string {
  const pairs: Record<string, string> = { '{': '}', '[': ']' }
  let out = ''
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch !== '{' && ch !== '[') {
      out += ch
      i++
      continue
    }
    const open = ch
    const close = pairs[ch]
    let depth = 0
    let j = i
    let inString = false
    let quote = ''
    let escaped = false
    let found = false
    for (; j < input.length; j++) {
      const c = input[j]
      if (inString) {
        if (escaped) { escaped = false; continue }
        if (c === '\\') { escaped = true; continue }
        if (c === quote) inString = false
        continue
      }
      if (c === '"' || c === "'") { inString = true; quote = c; continue }
      if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) { found = true; j++; break }
      }
    }
    if (!found) {
      out += ch
      i++
      continue
    }
    const span = input.slice(i, j)
    if (span.includes('\n') && span.length >= BALANCED_BLOCK_THRESHOLD) {
      out += pushAttachment(attachments, span, 'block')
    } else {
      out += span
    }
    i = j
  }
  return out
}

/** 抽取超长单行无空格 token（base64 / URL / 哈希 / 压缩数据），原位替换为占位符。 */
function extractLongTokens(input: string, attachments: Attachment[]): string {
  return input
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (trimmed.length >= LONG_TOKEN_THRESHOLD && !/\s/.test(trimmed)) {
        return pushAttachment(attachments, trimmed, 'block')
      }
      return line
    })
    .join('\n')
}

/**
 * 多场景识别前先把输入拆成指令与附件。附件的识别优先级：代码围栏 → 多行
 * JSON/数组块 → 超长单行 token；每处附件原位替换为【附件N】占位符。
 * 若拆分后指令为空（输入整体就是附件），回退为不拆分，避免改写无内容可依。
 */
export function splitInput(text: string): SplitInput {
  const attachments: Attachment[] = []
  let instruction = extractFenced(text, attachments)
  instruction = extractBalanced(instruction, attachments)
  instruction = extractLongTokens(instruction, attachments)
  instruction = instruction.replace(/\n{3,}/g, '\n\n').trim()
  if (instruction.length === 0) {
    return { instruction: text, attachments: [] }
  }
  return { instruction, attachments }
}

/** 组装发给改写模型的用户文本：指令 + 附件占位说明（不携带附件内容）。 */
export function buildUserText(instruction: string, attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return instruction
  const total = attachments.reduce((sum, a) => sum + a.content.length, 0)
  const markers = attachments.map((a) => a.marker).join('、')
  return [
    instruction,
    '',
    `（注：原输入附带 ${attachments.length} 处附件（${markers}），共约 ${total} 字符，内容已原样保留。`,
    '改写时请勿改动、复述或猜测附件内容，仅在需要时用对应的【附件N】占位符指代其位置。）',
  ].join('\n')
}

/** 把改写后的指令与附件拼回完整 prompt：占位符原位替换为附件原文，缺失的附件追加到末尾。 */
export function recombine(rewritten: string, attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return rewritten
  let out = rewritten
  const remaining: Attachment[] = []
  for (const attachment of attachments) {
    if (out.includes(attachment.marker)) {
      out = out.replace(attachment.marker, attachment.content)
    } else {
      remaining.push(attachment)
    }
  }
  if (remaining.length > 0) {
    out += '\n\n---\n\n' + remaining.map((a) => `${a.marker}\n${a.content}`).join('\n\n---\n\n')
  }
  return out
}
