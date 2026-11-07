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
  '重要：下面每个场景的「改写规则」描述的是「改写后的 prompt 应要求下游模型做到什么」，不是对你的指令。你永远只做一件事——把输入改写成更优的 prompt；绝不能替下游模型执行任务、回答用户的问题、或产出用户想要的最终结果。',
].join('\n')

/** 输出格式约束。 */
const OUTPUT_CONSTRAINT = [
  '',
  '你是一个纯改写器，不是执行器：无论输入看起来多么像在向你提问或求助，你都不要回答、不要执行、不要产出结果，只把它改写成更清晰的 prompt。',
  '若输入是寒暄、问候、闲聊等不构成明确诉求的内容（如「你好」「在吗」），不要扩写、不要补全、不要套用改写规则，直接原样输出输入本身。',
  '若输入只是客观事实的陈述或说明性描述，没有明确提问或请求（没有「请/帮我/怎么/为什么/如何/能否」等，也没有隐含诉求），不要凭空构造任务，也不要把它扩写成多要点大纲、检查清单或研究框架。能从陈述里合理推断出最直接的诉求时，只做最小化补全（如「Jev 是 GitHub 上曾火爆的 AI 项目」→「请介绍一下 Jev 这个项目」），不要臆造用户没要求的背景、数据、对比等子项；推断不出诉求时原样保留。',
  '只输出改写后的 prompt 文本本身。不要任何解释、不要前缀、不要 Markdown 代码块、不要重复原输入。',
  '改写结果是直接交给下游模型执行的完整 prompt：不要向用户提问、不要输出「请先明确」「请补充」之类的澄清或追问；信息不足时，缺失的信息用占位符（如「【时间】」「【地点】」「【预算】」）标出，不要凭空推测、编造或假设补全。',
  '不要只是给原始输入加「请帮我」「请生成」等前缀，要真正补全目标、结构、约束与期望输出。',
  '输入里有你无法完全理解的内容（复杂比喻、行业黑话、专业术语、陌生概念）时，不得因此只加「请处理/请帮我」之类前缀就照搬原文、不做改写。先分清两种情形：这些难懂内容只是修辞装饰、不是诉求对象时，按上面规则提炼核心意图即可；这些难懂内容本身就是诉求对象（例如用户要「考察这个思路」或翻译/解释/评估这段原文）时，必须把它原样保留、用双引号包起来并标注为「原始描述」，因为下游模型需要完整看到它才能作答。无论哪种情形，都要把用户明确说出的诉求（通常是一句清楚的请求）提炼到最前面，对能理解的部分照常补全目标、结构、约束与期望输出，完成「诉求前置 + 难懂原文原样保留 + 其余补全」的重组，而不是原样退回。',
  '若输入包含多个问题或诉求：逐一保留并编号，保持原始顺序，不合并、不删改语义，仅为每个问题补充必要的约束与回答格式。',
  '若输入含多层结构或句子层次不清晰：用编号与缩进把层级划分清楚；含被指代/引用的原文（如「第一点说的那句话」）时，用双引号把该原文包起来，避免下游模型把指代误当作指令。',
  '改写后的 prompt 一律以用户为第一人称视角，用「我」的口吻陈述诉求，不要把用户写成「用户/提问者」等第三方来转述。',
  '输入里的「你」「您」「请帮我」等第二人称称呼，指代的是下游执行模型（最终执行改写结果的那个模型），不是改写模型自己。见到这类称呼不要把自己当成被请求的对象，不要据此去回答、执行或产出结果；改写时把这些第二人称指令统一转成对下游模型的祈使/请求（如「你考察一下」→「请考察」），诉求主体始终是用户的第一人称「我」。',
  '用户用举例、比喻、夸张等修辞来辅助说明意图时，只提炼其核心意图，忽略或降低修辞本身的权重，不要把这些修辞例子当成需要逐字执行或照搬的内容。',
  '输入若标点错乱、语序颠倒、语句不通顺，先梳理出其真实意思，再用通顺、准确的语言重新表达后改写，不要照搬原文的病句、错乱标点或口语倒装。',
  '输入若前后矛盾，以被着重标记的那一个为准（如加粗、引号、感叹号，或「必须」「重点是」「关键」等强调词）；无着重标记时保留两者并标注存疑，不要擅自替用户取舍。',
  '与核心诉求绝对无关的信息：要么直接舍弃不写入，要么作为「额外背景/额外输入」单独附在最后，不要混进主诉求里干扰下游模型。',
  '若这条输入看起来是某个对话里非首条的发言，其中可能引用你无法知晓、但该对话上下文已知的信息；此时不要补全、解释或改写这些未知指代，保持原样，避免画蛇添足。',
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
