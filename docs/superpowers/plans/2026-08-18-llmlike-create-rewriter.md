# LlmLike 抽象 + 框架无关 createRewriter 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 dsh-input-rewriter 抽出一个零 dsh 依赖的 `createRewriter` 核心 + `LlmLike` 抽象，使改写能力可被外部 agent（后续 MCP/CLI/HTTP）复用，同时保持 dsh 插件对外契约不变。

**Architecture:** 改写引擎本就是纯函数，唯一 dsh 绑定是 `ctx.llm.stream`。把这条 LLM 执行链抽象成单次 `complete()` 的 `LlmLike` 接口，把「场景识别 → 附件分段 → 拼 playbook → 调 LLM → 拼回」全链路收敛进框架无关的 `createRewriter`；dsh 侧用 `dshLlmLike` 适配器包装 `ctx.llm.stream`，`RewriteService` 改为委托。

**Tech Stack:** TypeScript（strict）、tsdown（构建）、vitest（测试）、Cordis/dsh（现有宿主框架）。

**Spec:** [2026-08-18-llmlike-create-rewriter-design.md](../specs/2026-08-18-llmlike-create-rewriter-design.md)

## Global Constraints

- 硬约束：dsh 对外契约不变——`ctx.rewrite.rewrite` 返回类型、`/input-rewriter` RPC 四端点（`rewrite`/`models`/`getModel`/`setModel`）、浏览器预览条行为、`no-model` 错误码全部照旧。
- `src/core.ts` 必须零 `@deepseek-ai/*` import（框架无关的判据）。
- `lib/` 构建产物随仓库提交（`.gitignore` 不排除），每次改 src 后跑 `pnpm build` 并连同 lib/ 一起提交。
- Node ≥ 20，pnpm ≥ 10。
- 提交信息用中文 conventional commit，末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

### Task 1: 引入 vitest + engine 纯函数特征测试

**Files:**
- Modify: `package.json`（加 `test` script）
- Modify: `pnpm-lock.yaml`（`pnpm add` 自动更新）
- Create: `test/engine.test.ts`

**Interfaces:**
- Consumes: 现有 `src/rewrite/engine.ts` 导出的 `detectScenes` / `splitInput` / `recombine` / `buildSystemPrompt` / `buildUserText`。
- Produces: 锁住这些纯函数当前行为的特征测试（后续 Task 2/3 重构的回归网）。

- [ ] **Step 1: 安装 vitest**

Run: `pnpm add -D vitest`
Expected: `package.json` 的 devDependencies 出现 `vitest`，`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 加 test script**

在 `package.json` 的 `scripts` 中加入：

```json
"test": "vitest run",
```

最终 scripts 应为：

```json
"scripts": {
  "build": "tsdown",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "dev": "tsdown --watch"
},
```

- [ ] **Step 3: 写 engine 特征测试**

创建 `test/engine.test.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过（特征测试，应全绿）**

Run: `pnpm test`
Expected: 全部 PASS（这些函数已存在，测试锁现状）。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml test/engine.test.ts
git commit -m "test: 引入 vitest 并为 engine 纯函数补特征测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: engine.ts 去 dsh 化（移 extractText/finishError 到 llm.ts）

**Files:**
- Modify: `src/rewrite/engine.ts`（删除 `extractText`/`finishError` 与 dsh-llm 类型 import）
- Modify: `src/rewrite/llm.ts`（就地定义 `extractText`/`finishError`，删掉对 engine 的 import）

**Interfaces:**
- Consumes: 无新依赖。
- Produces: `engine.ts` 零 dsh import（Task 3 的 `core.ts` 依赖此点）；`llm.ts` 内 `extractText`/`finishError` 变为本地函数。

- [ ] **Step 1: 从 engine.ts 删除 dsh 类型 import 与两个函数**

编辑 `src/rewrite/engine.ts`：

删除第 6 行的 import：

```ts
import type { ContentBlock, FinishReason } from '@deepseek-ai/dsh-llm'
```

删除 `extractText`（原 118-125 行）与 `finishError`（原 127-138 行）两个导出函数（连同其上方的注释行）。

删除后，`engine.ts` 文件头部 import 区应只剩一个 import（如果有则保留 `SCENES` 等纯定义），文件内不再出现 `ContentBlock` / `FinishReason`。

- [ ] **Step 2: 在 llm.ts 就地定义这两个函数**

编辑 `src/rewrite/llm.ts`：

把顶部 import 从：

```ts
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { extractText, finishError } from './engine'
```

改为：

```ts
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'
```

并在文件内（`generateRewrite` 之前）加入这两个函数的定义（与 engine.ts 删掉的内容逐字一致）：

```ts
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
```

（注意：这两个函数从 `export` 改为模块内私有 `function`，因为不再有外部 import 者。）

- [ ] **Step 3: 类型检查 + 测试 + 构建**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全部通过。`engine.ts` 不再 import `@deepseek-ai/dsh-llm`，`llm.ts` 编译通过。

- [ ] **Step 4: Commit**

```bash
git add src/rewrite/engine.ts src/rewrite/llm.ts lib/
git commit -m "refactor: engine 去除 dsh-llm 类型依赖，extractText/finishError 移入 llm 适配层

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 新增框架无关 core.ts + 单测

**Files:**
- Create: `src/core.ts`
- Modify: `src/playbooks.ts`（`Playbook` 类型改从 core import）
- Modify: `src/skills.ts`（`Playbook` import 改指 `./core`）
- Modify: `src/rewrite/service.ts`（仅 `Playbook` import 行改指 `../core`）
- Create: `test/core.test.ts`

**Interfaces:**
- Consumes: `src/rewrite/engine.ts` 的 `detectScenes`/`splitInput`/`buildSystemPrompt`/`buildUserText`/`recombine`/`SCENES`/`SceneId`/`SceneMeta`。
- Produces: `createRewriter(opts): Rewriter`、`LlmLike`、`Playbook`、`CoreRewriteResult`、`CreateRewriterOptions`、`Rewriter`（Task 4 的 service.ts 依赖这些）。

- [ ] **Step 1: 写失败测试**

创建 `test/core.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRewriter, type LlmLike, type Playbook } from '../src/core'
import { SCENES } from '../src/rewrite/engine'

const playbooks: readonly Playbook[] = SCENES.map((scene) => ({ scene, content: `PLAYBOOK_${scene.id}` }))

const okLlm = (text: string): LlmLike => ({ complete: async () => text })

describe('createRewriter.rewrite', () => {
  afterEach(() => { vi.useRealTimers() })

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test`
Expected: FAIL——`Cannot find module '../src/core'`（core.ts 尚不存在）。

- [ ] **Step 3: 实现 core.ts**

创建 `src/core.ts`：

```ts
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
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`改写超时（${timeoutMs}ms）`))
      }, timeoutMs)
      const propagate = () => controller.abort(signal?.reason)
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
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, code: timedOut ? 'timeout' : 'llm-failed', message }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', propagate)
      }
    },
  }
}
```

- [ ] **Step 4: 移动 Playbook 类型到 core 并更新三个消费者 import**

编辑 `src/playbooks.ts`：

把：

```ts
import { SCENES, type SceneMeta } from './rewrite/engine'
```

和

```ts
export interface Playbook {
  scene: SceneMeta
  content: string
}
```

改为：删除 `Playbook` 接口定义，import 改为：

```ts
import { SCENES } from './rewrite/engine'
import type { Playbook } from './core'
```

（`loadPlaybooks` 的返回类型 `readonly Playbook[]` 不变。）

编辑 `src/skills.ts`：把 `import type { Playbook } from './playbooks'` 改为 `import type { Playbook } from './core'`。

编辑 `src/rewrite/service.ts`：把 `import type { Playbook } from '../playbooks'` 改为 `import type { Playbook } from '../core'`（其余逻辑本 Task 不动，Task 4 会整体重写）。

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS（core 单测 + engine 特征测试）；`tsc --noEmit` 通过（core.ts、playbooks.ts 类型正确）。

- [ ] **Step 6: Commit**

```bash
git add src/core.ts src/playbooks.ts src/skills.ts src/rewrite/service.ts test/core.test.ts
git commit -m "feat: 新增框架无关 createRewriter 核心与 LlmLike 抽象

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: llm.ts 改写为 dshLlmLike + service.ts 委托

**Files:**
- Modify: `src/rewrite/llm.ts`（`generateRewrite` 替换为 `dshLlmLike`）
- Modify: `src/rewrite/service.ts`（`rewrite` 委托 `createRewriter`）

**Interfaces:**
- Consumes: Task 3 的 `createRewriter` / `LlmLike` / `Playbook` / `Rewriter`（来自 `../core`）；Task 2 后 `llm.ts` 内已有的 `extractText`/`finishError`。
- Produces: `dshLlmLike(ctx, getSelection): LlmLike`；`RewriteService` 保持对外 `RewriteResult`（含 `no-model`）与 `listModels`/`currentSelection`/`saveSelection` 不变。

- [ ] **Step 1: 改写 llm.ts**

用以下完整内容覆盖 `src/rewrite/llm.ts`：

```ts
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
```

- [ ] **Step 2: 改写 service.ts**

用以下完整内容覆盖 `src/rewrite/service.ts`：

```ts
/**
 * 改写服务：暴露 `ctx.rewrite`，聚合模型选择持久化与框架无关改写核心。
 * 模型选择经 `installSettingsSection` 可选叠加在 settings 服务之上，未挂载时回落
 * 到插件 Config 的组合默认值；两者都缺省时改写返回 `no-model`。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { createRewriter, type Playbook, type Rewriter } from '../core'
import { dshLlmLike } from './llm'
import type { SceneId } from './engine'
import {
  isModelSelectionConfigured,
  REWRITE_MODEL_SETTINGS_NAMESPACE,
  REWRITE_MODEL_SETTINGS_SCHEMA,
  type RewriteModelSettings,
} from '../settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rewrite: RewriteService
  }
}

/** 改写结果：成功返回改写文本与命中场景，失败返回可展示的错误。 */
export type RewriteResult =
  | { ok: true; rewritten: string; scenes: SceneId[] }
  | { ok: false; code: 'no-model' | 'llm-failed' | 'empty-result' | 'timeout'; message: string }

/** RewriteService 的已解析配置（默认值已在 apply() 落定）。 */
export interface RewriteServiceConfig {
  provider?: string
  model?: string
  maxOutputTokens: number
  timeoutMs: number
  playbooks: readonly Playbook[]
}

export class RewriteService extends Service {
  private readonly rewriter: Rewriter
  private source: () => RewriteModelSettings

  constructor(ctx: Context, config: RewriteServiceConfig) {
    super(ctx, 'rewrite')

    const entry: RewriteModelSettings = { provider: config.provider, model: config.model }
    this.source = () => entry
    installSettingsSection(ctx, REWRITE_MODEL_SETTINGS_NAMESPACE, REWRITE_MODEL_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      onChange: () => { /* 值已由 setSource 捕获，无额外副作用 */ },
    })

    this.rewriter = createRewriter({
      llm: dshLlmLike(ctx, () => this.source()),
      playbooks: config.playbooks,
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
    })
  }

  /** 当前生效的模型选择（provider/model 均缺省表示未配置）。 */
  currentSelection(): RewriteModelSettings {
    return this.source()
  }

  /** 持久化模型选择到 settings 服务（未挂载时静默忽略）。 */
  async saveSelection(next: RewriteModelSettings): Promise<void> {
    await this.ctx.get('settings')?.replace(REWRITE_MODEL_SETTINGS_NAMESPACE, {
      provider: next.provider ?? '',
      model: next.model ?? '',
    })
  }

  /** 列出所有可用模型（跨全部 provider，单个 provider 失败不影响其余）。 */
  async listModels(): Promise<LlmModelInfo[]> {
    const result: LlmModelInfo[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      try {
        result.push(...(await this.ctx.llm.listModels(provider.id)))
      } catch {
        // 单个 provider 失败不影响其余 provider 的模型列表。
      }
    }
    return result
  }

  /** 核心：检查模型选择后委托框架无关 rewriter 做单次改写。 */
  async rewrite(text: string, signal?: AbortSignal): Promise<RewriteResult> {
    const selection = this.source()
    if (!isModelSelectionConfigured(selection)) {
      return { ok: false, code: 'no-model', message: '尚未配置改写模型，请在设置中选择' }
    }
    return this.rewriter.rewrite(text, signal)
  }
}
```

- [ ] **Step 3: 类型检查 + 测试 + 构建**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全部通过。`lib/index.js` 已把 core 内联进宿主产物（service.ts 现在 import `../core`）。

- [ ] **Step 4: Commit**

```bash
git add src/rewrite/llm.ts src/rewrite/service.ts lib/
git commit -m "refactor: llm 适配层改写为 dshLlmLike，RewriteService 委托核心

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 新增 ./core 子入口导出

**Files:**
- Modify: `tsdown.config.ts`（宿主构建 entry 加 `core`）
- Modify: `package.json`（`exports` 加 `./core`）

**Interfaces:**
- Consumes: Task 3 的 `src/core.ts`。
- Produces: 构建产物 `lib/core.js` + `lib/core.d.ts`，经 `package.json` 的 `./core` 导出，外部可 `import { createRewriter } from 'dsh-input-rewriter/core'`。

- [ ] **Step 1: tsdown 增加 core entry**

编辑 `tsdown.config.ts`，把第一个配置对象的 entry 从：

```ts
    entry: { index: 'src/index.ts' },
```

改为：

```ts
    entry: { index: 'src/index.ts', core: 'src/core.ts' },
```

- [ ] **Step 2: package.json 增加 ./core 导出**

编辑 `package.json` 的 `exports`，在 `"."` 之后加入：

```json
    "./core": { "types": "./lib/core.d.ts", "default": "./lib/core.js" },
```

最终 `exports` 应为：

```json
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./core": {
      "types": "./lib/core.d.ts",
      "default": "./lib/core.js"
    },
    "./client": {
      "default": "./lib/client.js"
    },
    "./package.json": "./package.json"
  },
```

- [ ] **Step 3: 构建并验证产物**

Run: `pnpm build`
Expected: 成功，产出 `lib/core.js` 与 `lib/core.d.ts`。

Run: `ls -la lib/core.js lib/core.d.ts`
Expected: 两个文件均存在。

- [ ] **Step 4: 验证核心零 dsh 依赖（框架无关判据）**

Run:

```bash
node --input-type=module -e "import('./lib/core.js').then(m => console.log(typeof m.createRewriter))"
```

Expected: 打印 `function`（若 core.js 意外 import 了 dsh 包，此命令会抛 `MODULE_NOT_FOUND`）。

Run:

```bash
grep -c "@deepseek-ai" lib/core.d.ts || true
```

Expected: 输出 `0`（core 的类型定义无 dsh 类型泄漏）。

- [ ] **Step 5: Commit**

```bash
git add tsdown.config.ts package.json lib/core.js lib/core.d.ts lib/core.js.map
git commit -m "build: 新增 ./core 子入口导出框架无关改写核心

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 完成验收（全部 Task 后）

```bash
pnpm typecheck && pnpm test && pnpm build
```

全部通过；`git status` 干净；`lib/core.js` 可被 Node 独立 `import` 且 `createRewriter` 为 function；dsh 侧 `ctx.rewrite.rewrite` / RPC 四端点 / 浏览器面契约未改动（本计划未触碰 `src/rpc.ts` / `src/skills.ts` / `src/index.ts` / `client/`）。
