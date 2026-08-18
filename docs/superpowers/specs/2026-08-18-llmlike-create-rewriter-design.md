# LlmLike 抽象 + 框架无关 createRewriter — 设计

> 状态：已评审通过（待实现）
> 日期：2026-08-18
> 目标：为 dsh-input-rewriter 抽出一个零 dsh 依赖的改写核心，使外部 agent（后续 MCP / CLI / HTTP）能复用改写能力

## 1. 背景与目标

改写引擎的核心逻辑（场景识别 + 附件分段 + 拼 playbook + 拼回附件）已经是纯函数，唯一绑死 dsh 的地方是 LLM 执行层 [src/rewrite/llm.ts](../../../src/rewrite/llm.ts) 里的 `ctx.llm.stream`。本设计把这层抽象成一个极小的 `LlmLike` 接口，并暴露一个框架无关的 `createRewriter` 工厂，使「改写」能力不依赖 dsh 运行时即可被调用。

**做**：

1. 定义 `LlmLike` 接口（单次 `complete()` 返回全文）。
2. 定义框架无关的 `createRewriter` 工厂，覆盖全链路改写（场景识别 → 附件分段 → 拼 playbook → 调 LLM → 拼回附件）。
3. 把 `ctx.llm.stream` 隔离成 dsh 适配器 `dshLlmLike`。
4. `RewriteService.rewrite` 改为委托 `createRewriter`，消除编排逻辑副本。
5. `engine.ts` 去 dsh 依赖（移除 `ContentBlock`/`FinishReason` 类型导入）。
6. 新增 `./core` 子入口导出 + `vitest` 测试框架 + 核心单测。

**不做**（本阶段）：MCP / CLI / HTTP 薄壳（后续独立步骤）、多步编排、多候选改写、改浏览器面 / RPC 契约。

**硬约束**：dsh 插件对外契约不变——`ctx.rewrite.rewrite` 的返回类型、`/input-rewriter` RPC 的四个端点（`rewrite`/`models`/`getModel`/`setModel`）、浏览器预览条行为全部保持；`no-model` 等错误码照旧。

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| `LlmLike` 形态 | 单次 `complete()` 返回全文（流式拼装留在 dsh 适配器内部，不进抽象） |
| `createRewriter` 范围 | 全链路（`ctx.rewrite.rewrite` 的框架无关等价物） |
| 与 `RewriteService` 关系 | 重构为委托（单一事实来源，无编排副本） |
| playbook 加载 | 注入数据（`createRewriter({ llm, playbooks })`），fs 读取留在 dsh 宿主层 |
| 子入口命名 | `./core`（`dsh-input-rewriter/core`） |
| 测试框架 | 新增 `vitest`（devDep） |

## 3. 目标文件布局

```
src/
  core.ts                 # 新：框架无关 createRewriter + LlmLike + Playbook + CoreRewriteResult
  index.ts                # dsh 宿主入口：loadPlaybooks(fs) → createRewriter(dshLlmLike) → 服务/skill/RPC
  playbooks.ts            # 仅剩 fs 加载器（import Playbook/SCENES 类型），不再定义 Playbook
  rpc.ts                  # 不变
  settings.ts             # 不变
  skills.ts               # 不变
  rewrite/
    engine.ts             # 纯函数面：去掉 dsh-llm 的 extractText/finishError/类型导入
    llm.ts                # dsh 适配器：dshLlmLike() + 移入的 extractText/finishError/BlockAssembler
    service.ts            # RewriteService：委托 createRewriter
test/
  core.test.ts            # createRewriter + stub LlmLike 单测
  engine.test.ts          # engine 纯函数单测
```

## 4. 核心接口（`src/core.ts`，零 dsh import）

```ts
import type { SceneId, SceneMeta } from './rewrite/engine'

export interface LlmLike {
  complete(input: {
    system: string
    user: string
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<string>          // 返回全文；失败/非正常终态 throw Error
}

export type CoreRewriteResult =
  | { ok: true; rewritten: string; scenes: SceneId[] }
  | { ok: false; code: 'llm-failed' | 'empty-result' | 'timeout'; message: string }

export interface Playbook { scene: SceneMeta; content: string }

export interface CreateRewriterOptions {
  llm: LlmLike
  playbooks: readonly Playbook[]
  maxOutputTokens?: number   // 默认 2048
  timeoutMs?: number         // 默认 60000
}

export function createRewriter(
  opts: CreateRewriterOptions,
): { rewrite(text: string, signal?: AbortSignal): Promise<CoreRewriteResult> }
```

`createRewriter.rewrite` 内部流程：

```
detectScenes(text)
  → buildSystemPrompt(命中场景 playbook 内容)
  → splitInput(text) → { instruction, attachments }
  → buildUserText(instruction, attachments)
  → llm.complete({ system, user, maxTokens, signal })  // 核心自建 AbortController 链超时/取消
  → 空结果 → empty-result；throw → timeout / llm-failed
  → recombine(结果, attachments)
  → { ok: true, rewritten, scenes }
```

- **超时/取消信号链**：从 [src/rewrite/llm.ts](../../../src/rewrite/llm.ts) 的 `setTimeout + AbortController + signal 转发` 逻辑移入核心，用 `AbortController` + `setTimeout`（web 标准，Node/browser/edge 通用）。超时由核心触发 abort，映射为 `timeout`；其余 throw 映射为 `llm-failed`。
- **`empty-result`** 由核心判断（`complete()` 返回空串，trim 后为空）。
- **不碰 `no-model`**：模型选择是 dsh 概念（依赖 settings），由 `RewriteService` 在委托前检查。

## 5. dsh 适配器 + 委托

`src/rewrite/llm.ts` 变为一个工厂：

```ts
export function dshLlmLike(ctx: Context, getSelection: () => RewriteModelSettings): LlmLike {
  return {
    async complete({ system, user, maxTokens, signal }) {
      const { provider, model } = getSelection()
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({
        provider, model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin', plugin: 'dsh-input-rewriter' },
        })],
        system, maxTokens, signal,
      })) {
        assembler.push(chunk)
      }
      const err = finishError(assembler.finish)
      if (err !== undefined) throw err
      return extractText(assembler.blocks())   // 可能为空串，交由核心判 empty-result
    },
  }
}
```

`src/rewrite/service.ts`：

```ts
class RewriteService extends Service {
  private readonly rewriter: ReturnType<typeof createRewriter>

  constructor(ctx, config) {
    super(ctx, 'rewrite')
    // ...source/installSettingsSection 不变...
    this.rewriter = createRewriter({
      llm: dshLlmLike(ctx, () => this.source()),
      playbooks: config.playbooks,
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
    })
  }

  async rewrite(text: string, signal?: AbortSignal): Promise<RewriteResult> {
    const selection = this.source()
    if (!isModelSelectionConfigured(selection)) {
      return { ok: false, code: 'no-model', message: '尚未配置改写模型，请在设置中选择' }
    }
    return this.rewriter.rewrite(text, signal)
  }
}
```

- `RewriteService.rewrite` 的返回类型保持 dsh 侧 `RewriteResult`（含 `no-model`），`no-model` 检查留在委托前，RPC / 浏览器面零改动。
- `listModels` / `currentSelection` / `saveSelection` 方法不变。

## 6. 类型边界（engine 去 dsh 化）

当前 [src/rewrite/engine.ts](../../../src/rewrite/engine.ts) 顶层 `import type { ContentBlock, FinishReason } from '@deepseek-ai/dsh-llm'`，只被 `extractText` / `finishError` 使用。

- 把 `extractText` / `finishError` 连同该 `import type` 移入 `src/rewrite/llm.ts`（它们操作 dsh 的 `ContentBlock` / `FinishReason` 类型）。
- 移完后 `engine.ts` 零 dsh 依赖；`core.ts` 仅 `import type { SceneId, SceneMeta } from './rewrite/engine'`。
- `Playbook` 类型从 `src/playbooks.ts` 移到 `src/core.ts`（它是 `createRewriter` 的输入契约），`playbooks.ts` 改为 `import type { Playbook } from './core'`。

## 7. 构建与导出

- [tsdown.config.ts](../../../tsdown.config.ts) 宿主构建 entry 改为 `{ index: 'src/index.ts', core: 'src/core.ts' }`，多产出 `lib/core.js` + `lib/core.d.ts`（core 无外部依赖，自包含；`index.js` 会内联 core 与 engine，重复体积极小可接受）。
- [package.json](../../../package.json) `exports` 增加：

```json
"./core": { "types": "./lib/core.d.ts", "default": "./lib/core.js" }
```

- 外部 agent 可 `import { createRewriter } from 'dsh-input-rewriter/core'`，无需安装任何 dsh peer 依赖。
- `package.json` 的 `files` 已含 `lib`，`lib/core.*` 自动随包分发。

## 8. 测试

新增 `vitest` 作为 devDep，加 `"test": "vitest run"` 脚本。

- `test/core.test.ts`（stub `LlmLike`，断言 `rewrite`）：
  - 场景命中（`coding` / `academic` / `general` 兜底）。
  - 附件分段 + 拼回：代码块 / 多行 JSON / 长 token 逐字保留、原位拼回。
  - `complete()` 抛错 → `llm-failed`。
  - `complete()` 返回空串 → `empty-result`。
  - 超时 → `timeout`（用 `vi.useFakeTimers` 推进）。
- `test/engine.test.ts`（纯函数）：
  - `detectScenes`：关键词命中排序、无命中回落 `general`、Top-K 截断。
  - `splitInput`：代码围栏 / 多行 `{}`/`[]` / 超长 token 三类附件抽取与占位。
  - `recombine`：占位原位替换、缺失附件追加末尾。
  - `buildSystemPrompt` / `buildUserText`：结构断言。
- `dshLlmLike` 依赖真实 `ctx.llm`，本阶段不单测，由核心单测 + 现有 dsh 集成路径覆盖。

## 9. 数据流（不变）

```
用户输入 → 浏览器面 input.draft 防抖 → connection.rpc.call('rewrite')
  → 宿主 RPC → ctx.rewrite.rewrite(text)
    → (no-model 检查) → createRewriter.rewrite(text)
      → detectScenes → splitInput → buildSystemPrompt/buildUserText → dshLlmLike.complete → recombine
  → RewriteResult → 浏览器面预览条
```

## 10. 异常处理（契约不变）

| 情形 | 行为 |
|---|---|
| 未配置改写模型 | `RewriteService` 委托前返回 `{ ok:false, code:'no-model' }` |
| `complete()` 抛错 | 核心映射 `{ ok:false, code:'llm-failed' }` |
| 超时 | 核心映射 `{ ok:false, code:'timeout' }` |
| 空结果 | 核心映射 `{ ok:false, code:'empty-result' }` |
| 调用方取消信号 | `complete()` 内 `ctx.llm.stream` 因 abort 抛错，向上映射 `llm-failed`（与现状一致） |

## 11. 非目标 / 后续方向

- MCP tool / CLI / HTTP 薄壳：依赖本设计的 `./core` 入口，作为独立后续步骤。
- 多步编排、多候选改写、改写采纳率统计：沿用 [docs/design.md](../../design.md) §15 的既定非目标。
