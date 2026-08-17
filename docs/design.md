# 输入重写插件 — 设计文档

> 状态：待评审
> 日期：2026-08-17
> 目标平台：dsh（DeepSeek Harness）Web UI

## 1. 背景与目标

在 dsh 的 Web 对话界面中，用户输入的原始文本往往口语化、含糊、结构松散，直接发给下游模型会降低回答质量。本插件在**发送前**自动把用户输入改写成一个应用了「提示词工程方法论」的更优 prompt，从而让下游主模型答得更好。

核心价值主张：**把「改写」这件事本身做成一套可复用的提示词工程知识库**（按场景划分，覆盖 CoT / ToT / GoT / RAG / RAR / CoVe / 注意力引导等方法论），由插件自动选场景、自动套方法论，用户零操作即可获得改写结果。

## 2. 范围

### 做什么

1. 在输入框紧挨上方实时预览改写后的输入，可编辑。
2. 预览条上提供「发送改写」与「发送原文」两个动作（组合键在预览条获焦时生效）。
3. 在 dsh 原生设置区提供一个「改写模型」下拉，复用 dsh 现有 Models 页的模型配置。
4. 内置一份按场景划分的提示词工程 playbook 库，驱动改写。

### 不做什么（本阶段）

- 不做多步编排（不真的执行检索、跑验证链、展开思维树），改写是**单次 prompt 增强**。
- 不做全局键盘快捷键（dsh 无 keymap 服务），不替换内置输入框组件。
- 不自建模型供应商 / 凭据存储，完全复用 dsh 现有 Models 页。
- 不做多语言改写策略（首版中文优先，playbook 结构对语言无关）。

## 3. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 推进方式 | 提示词库优先，集成壳从简 |
| 场景选择 | 全自动识别（零操作） |
| 改写形态 | 单次改写（prompt 增强），不真执行方法论 |
| 发送交互 | 预览条负责发送（输入框保持原文） |
| 模型配置 | 复用 dsh Models 页「Add custom provider」，插件只放模型下拉 |
| 源码位置 | `d:/git/输入重写` |

## 4. 架构总览：双面插件

dsh 里要同时做到「原生设置分区」+「输入框上方 UI」，插件必须是一个**双面（dual-half）npm 包**：

```
┌─────────────────────────────────────────────────┐
│  宿主面（host half）— Node 进程，full-trust       │
│  · 改写引擎（场景识别 + 套方法论 + 单次 LLM 调用）  │
│  · 设置 namespace（改写模型下拉）                  │
│  · 加载提示词库（skills/ playbook）               │
│  · 通过 ctx.llm.stream 调用改写模型                │
└───────────────────┬─────────────────────────────┘
                    │ 包内 RPC（JSON-only，host.call）
┌───────────────────▼─────────────────────────────┐
│  浏览器面（browser half）— 沙箱闭包               │
│  · 预览条 UI（conversation.input.dock 槽）        │
│  · 设置面板 UI（settings.section 槽）             │
│  · 读草稿、调 host.call('rewrite')、触发发送       │
└─────────────────────────────────────────────────┘
```

- **宿主面**：由 `cordis.yml` 的 `insert` 加载，普通 Cordis 插件，拥有完整 `ctx` 服务面（`ctx.llm`、`ctx.settings`、`ctx.skills` 等）与无限制 Node 环境。
- **浏览器面**：由 `package.json` 的 `dsh.client` manifest（`inject` + `platform: "web"`）与 `exports["./client"]` 声明。运行在沙箱闭包里，符号面只有 `React` / `console` / `styles` / `host`，无 `import`，标记用 `React.createElement`、样式用 `styles.insert(css)`。所有重逻辑都在宿主面，浏览器面通过包内 RPC（`host.call`）调用。

### 插件生命周期（对齐 dsh 框架）

- `inject` 声明依赖，框架等依赖服务就绪后才执行 `apply`。
- 一切注册（`ctx.tools.register`、`ctx.slots.register`、`ctx.effect`）在插件卸载时自动清理，无需手动撤销。
- 需要手动清理的资源用 `ctx.effect(() => { ...; return () => cleanup() })`。
- 修改源文件配合 HMR 自动重载（旧注册被清理）。

## 5. 提示词库（核心内容）

### 5.1 场景 taxonomy 与方法论映射

| # | 场景 | 主方法论 | 备选 | 改写要点 |
|---|------|---------|------|---------|
| 1 | 日常生活 | 注意力引导 | CoT | 去歧义、明确目标、口语转清晰 |
| 2 | 工作职场 | CoT + CoVe | 注意力引导 | 结构化、分步、可校验 |
| 3 | 学术研究 | RAG + CoVe | RAR | 检索+验证、引证 |
| 4 | 技术编程 | CoT + 注意力引导 | GoT | 约束聚焦、多方案 |
| 5 | 创意写作 | GoT / ToT | — | 多分支发散、组合创新 |
| 6 | 通用兜底 | CoT | 注意力引导 | 默认分步、澄清 |

### 5.2 方法论在「改写」语境下的含义

改写引擎是**单次 prompt 增强**——把方法论作为**指令**注入改写后的 prompt，由下游主模型去执行，插件自己不真跑。各方法论指令含义：

| 方法论 | 注入改写后 prompt 的指令效果 |
|---|---|
| CoT 链式思考 | 「请逐步推理、展示思考过程」 |
| ToT 思维树 | 「请探索多个候选思路再选最优」 |
| GoT 思维图 | 「请把想法组织成图、交叉组合」 |
| RAG 检索增强 | 「请先检索相关资料再作答」 |
| RAR 改写增强检索 | 「请先澄清/改写查询，再检索作答」 |
| CoVe 验证链 | 「作答后请自查校验」 |
| 注意力引导 | 「重点 X、忽略 Y、按 Z 格式输出」 |

### 5.3 playbook 文件结构

每场景一份 Markdown playbook，存于 `skills/` 目录，作为改写引擎拼系统 prompt 的素材。单份 playbook 至少包含：

1. **场景描述**：什么输入属于此场景（供模型自判）。
2. **改写目标**：该场景下「更优 prompt」长什么样。
3. **方法论指令模板**：主/备选方法论的指令文本。
4. **输出规范**：改写后的 prompt 应满足的格式约束。

> 「skill」落地为插件自带内容文件（playbook）。可选地再 `ctx.skills.register` 一份让其在 dsh 技能系统里可见（非必需，本阶段不做）。

## 6. 改写引擎（单次改写流程）

因为「全自动 + 单次」，场景识别折叠进同一次 LLM 调用，避免额外往返：

```
原始输入 text
   │
   ▼
组装系统 prompt = 通用改写角色说明
                + 全部 6 个场景 playbook（含场景判定说明 + 方法论指令）
                + 输出格式约束
   │
   ▼
ctx.llm.stream({ provider, model, messages: [system, user=text] })
   │
   ▼
模型输出 = 改写后的 prompt（仅文本，无前缀解释）
   │
   ▼
返回浏览器面 → 预览条渲染
```

- **一次调用**完成「判场景 → 套方法论 → 改写」，延迟可控，适合实时预览。
- 模型由设置里的「改写模型」下拉决定（`provider` + `model`），baseURL / API key 由 dsh 已配置的 adapter 解析。

## 7. 设置（模型下拉，复用 Models 页）

- 用户先在 dsh 现有 **Settings → Models 页「Add custom provider」** 配好改写用的 gateway（route / baseURL / protocol / API key / models）。key 由 dsh 存 `~/.dsh/.credentials.yaml`，插件不碰明文。
- 插件在原生设置区注册一个「改写模型」下拉（`settings.section` 槽 + 宿主侧 settings namespace），选项来自 dsh 已配置的模型目录（宿主面枚举后经 RPC 提供给浏览器面）。
- 插件只存一个选择值（如 `{ provider, model }`），调 `ctx.llm.stream` 时用它。

## 8. UI（预览条）

- 注册 `conversation.input.dock` 槽（`list`，session 作用域）——dsh 专为此设计的「输入卡片上方独占一行」，每次输入变化自动把最新草稿作为 props 传入。
- 流程：
  1. 读草稿 `draft`。
  2. 防抖（约 500ms 停笔后）触发 `host.call('rewrite', { text })`。
  3. 宿主面返回改写文本，预览条渲染为可编辑文本框。
  4. 两个动作：
     - **发送改写**：`inputActions.setDraft(改写后) + inputActions.submit()`。
     - **发送原文**：直接 `inputActions.submit()`。
  5. 组合键（预览条获焦时生效）：`Ctrl+Enter` = 发送改写，`Alt+Enter` = 发送原文。
- 输入框本身始终保留用户原文；内置 Enter 行为不变（发原文，作兜底）。

## 9. 数据流

```
用户输入 → 浏览器面读 draft → 防抖
  → host.call('rewrite', { text })
  → 宿主面：组装系统 prompt（场景 playbook 全集）→ ctx.llm.stream 调改写模型
  → 返回改写文本 → 浏览器面预览条渲染（可编辑）
  → 用户点「发送改写」/「发送原文」/ 组合键 → submit
```

## 10. 错误处理

| 情形 | 行为 |
|---|---|
| 未配置改写模型（下拉为空） | 预览条提示「请先在 Models 页配置改写模型」，不打扰输入 |
| LLM 调用失败 / 超时 | 预览条显示错误，自动回退为原文可正常发送 |
| 改写结果为空 | 视为失败，回退原文 |
| 浏览器面渲染崩溃 | 依赖 dsh 槽系统的错误边界，不阻断输入 |

## 11. 项目结构

```
d:/git/输入重写/
├── package.json          # name + dsh.client manifest + exports["./client"]
├── cordis.patch.yml      # bundle patch：insert 宿主插件
├── tsdown.config.ts      # 构建（宿主 + 浏览器两面）
├── src/                  # 宿主面
│   ├── index.ts          # 入口（apply）
│   ├── rewrite/          # 改写引擎
│   │   ├── engine.ts     # 单次改写 + 系统 prompt 组装
│   │   └── llm.ts        # ctx.llm 调用封装
│   ├── settings.ts       # 改写模型下拉 settings namespace
│   └── skills.ts         # 加载 skills/ playbook
├── client/               # 浏览器面
│   └── index.tsx         # 预览条 + 设置面板 UI
├── skills/               # 提示词库 playbook（每场景一份）
│   ├── daily-life.md
│   ├── work.md
│   ├── academic.md
│   ├── coding.md
│   ├── creative.md
│   └── general.md
├── docs/
│   └── design.md
└── README.md
```

## 12. 非目标 / 后续方向

- 多步编排（真检索 / 真验证链 / 思维树展开）——当前明确不做，属未来增强。
- 全局快捷键、替换输入框——受 dsh 能力边界限制，不做。
- 把 playbook 注册为 dsh 原生 skill 以便用户在技能系统里看到/调用——可选后续。
- 改写结果的「采纳率/质量」统计、多候选改写（一次给 N 个版本）——后续。
