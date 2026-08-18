# 输入重写插件 — 设计文档

> 状态：已实现（待评审）
> 日期：2026-08-17
> 目标平台：dsh（DeepSeek Harness）Web UI

## 1. 背景与目标

在 dsh 的 Web 对话界面中，用户输入的原始文本往往口语化、含糊、结构松散，直接发给下游模型会降低回答质量。本插件在**发送前**把用户输入改写成一个应用了「提示词工程方法论」的更优 prompt，从而让下游主模型答得更好。

核心价值主张：**把「改写」这件事本身做成一套可复用的提示词工程知识库**（按场景划分，覆盖 CoT / ToT / GoT / RAG / RAR / CoVe / 注意力引导等方法论），由插件自动选场景、自动套方法论，用户零操作即可获得改写结果。

## 2. 范围

### 做什么

1. 在输入框紧挨上方提供改写预览条：草稿停止输入约 2s 后**自动**改写并展示结果（无「改写」触发按钮）。
2. 预览条右侧提供「发送改写」动作（另有「×」取消）；输入框 Enter 始终发原文。
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
| 场景选择 | 全自动识别（零操作）；一个输入可命中多场景（启发式预筛 Top-K + 模型综合应用） |
| 改写形态 | 单次改写（prompt 增强），不真执行方法论 |
| 改写触发 | 自动防抖（草稿停止变化约 2s 后触发），无显式「改写」按钮 |
| 发送交互 | 预览条「发送改写」负责发送改写版（输入框保持原文，Enter 发原文） |
| 模型配置 | 复用 dsh Models 页「Add custom provider」，插件只放模型下拉 |
| playbook 格式 | YAML frontmatter（元数据）+ Markdown（改写指令） |
| 源码位置 | `d:/git/输入重写` |
| 依赖机制 | 通过 Cordis 服务注入（`inject`）对外复用，不引入事件总线 |
| 架构形态 | 保持「服务 + 纯函数改写引擎」，不做类继承 / 事件驱动 |
| **包内 RPC** | **编译 npm 包 + `connection.rpc`**（宿主 `rpc.handle` ↔ 浏览器 `rpc.call`） |
| 对外复用 | 改写引擎暴露为可注入服务 `ctx.rewrite`；playbook 注册为 dsh 原生 skill（见 §14） |

## 4. 架构总览：双面编译包

dsh 里要同时做到「原生设置分区」+「输入框上方 UI」，插件必须是一个**双面（dual-half）编译型 npm 包**：

```
┌─────────────────────────────────────────────────┐
│  宿主面（host half）— Node 进程，ESM，full-trust  │
│  · 改写引擎（场景识别 + 套方法论 + 单次 LLM 调用）  │
│  · 设置 namespace（改写模型下拉的数据面）          │
│  · 加载提示词库（skills/ playbook）               │
│  · 注册 /input-rewriter RPC（connection.rpc.handle）│
└───────────────────┬─────────────────────────────┘
                    │ 包内 RPC（connection.rpc，JSON-only）
┌───────────────────▼─────────────────────────────┐
│  浏览器面（browser half）— 沙箱闭包，CJS bundle   │
│  · 预览条 UI（conversation.input.dock 槽）        │
│  · 设置面板 UI（settings.section 槽）             │
│  · 读草稿、调 connection.rpc.call、触发发送       │
└─────────────────────────────────────────────────┘
```

- **宿主面**：`src/index.ts` 编译为 `lib/index.js`（ESM）。由 `cordis.patch.yml` 的 `insert` 加载，普通 Cordis 插件，拥有完整 `ctx` 服务面（`ctx.llm`、`ctx.settings`、`ctx.skills`、`ctx.connection`）与无限制 Node 环境。
- **浏览器面**：`client/index.tsx` 经 tsdown 编译为 `lib/client.js`（CJS），以 `window.__ModuleLoader__.load({ id, factory })` 注入沙箱。JSX 在构建期编译，`react` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-client-*` 等作为 external 由 shell 提供。通过 `dsh.client` manifest（`inject` + `platform: "web"`）与 `exports["./client"]` 声明。
- **RPC**：宿主面 `ctx.connection.rpc.handle('/input-rewriter', handler, { authority: 'loopback' })` 注册通道；浏览器面 `ctx.get('connection').rpc.call('/input-rewriter', endpoint, payload)` 调用。四个端点：`rewrite` / `models` / `getModel` / `setModel`。传输层错误（`bad-request` / `internal`）与业务结果（`RewriteResult`，含改写失败）分离。

### 插件生命周期（对齐 dsh 框架）

- `inject` 声明依赖，框架等依赖服务就绪后才执行 `apply`。
- 一切注册（`new RewriteService(ctx)`、`installSettingsSection`、`ctx.skills.register`、`ctx.connection.rpc.handle`）在插件卸载时自动清理，无需手动撤销。
- 需要手动清理的资源用 `ctx.effect(() => dispose)` 绑定（RPC disposer 即此用法）。
- 修改源文件配合 HMR 自动重载（旧注册被清理）。

## 5. 提示词库（核心内容）

### 5.1 场景 taxonomy 与方法论映射

| # | 场景 | 主方法论 | 备选 | 改写要点 |
|---|------|---------|------|---------|
| 1 | 日常生活 | 注意力引导 | CoT | 去歧义、明确目标、口语转清晰 |
| 2 | 工作职场 | CoT + CoVe | 注意力引导 | 结构化、分步、可校验 |
| 3 | 学术研究 | RAG + CoVe | RAR | 检索+验证、引证 |
| 4 | 技术编程 | CoT + 注意力引导 | GoT | 约束聚焦、多方案 |
| 5 | 创意写作 | GoT / ToT | 注意力引导 | 多分支发散、组合创新 |
| 6 | 安全排查 | CoT + 注意力引导 | CoVe | 威胁模型、逐项排查、风险评级+证据 |
| 7 | 通用兜底 | CoT | 注意力引导 | 默认分步、补全假设 |

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

每场景一份 playbook，存于 `skills/` 目录，采用 **YAML frontmatter + Markdown 正文**双段结构，作为改写引擎拼系统 prompt 的素材：

```yaml
---
scene: academic           # 场景 id（与 engine.SCENES 对齐）
name: 学术研究             # 中文名
methodology: [RAG, CoVe]   # 主方法论（结构化索引）
fallback: [RAR]            # 备选方法论（结构化索引）
---
```

Markdown 正文固定两节：

1. `## 场景描述`：什么输入属于此场景（供模型多场景自判）。
2. `## 改写规则`：该场景的改写要点，把方法论翻译成注入改写后 prompt 的指令 + 输出规范（结构化列表）。

- **YAML frontmatter**：结构化元数据（`scene`/`name`/`methodology`/`fallback`），供代码侧索引、校验与扩展；方法论名是结构化标记，不直接进 prompt。
- **Markdown 正文**：是注入 prompt 的实质指令素材；`loadPlaybooks()` 读到的是整文件原文，直接作为该场景 playbook 内容。

> 「skill」落地为插件自带内容文件（playbook），并由宿主面 `skills.ts` 通过 `ctx.skills.register` 把每份 playbook 注册为 dsh 原生 skill（`input-rewrite-<scene>`，`source: 'runtime'`），使其在技能系统里可见/可调用（见 §14.2）。

## 6. 改写引擎（单次改写流程）

「全自动 + 单次」：代码侧先用启发式预筛收敛候选场景，再交给模型一次调用完成「判多场景 → 综合套方法论 → 改写」：

```
原始输入 text
   │
   ├─► detectScenes(text) 启发式预筛：按关键词命中数降序取 Top-K（默认 2）个场景；
   │    无任何命中回落 general（通用兜底）。
   │
   ├─► splitInput(text) 附件分段：代码围栏 → 多行 JSON/数组 → 超长单行 token，
   │    逐处替换为【附件N】占位符；返回 { instruction, attachments }。
   │
   ▼
组装系统 prompt = 通用改写角色说明（含「识别所有相关场景、综合应用」指引）
                + 命中场景对应的 playbook（多场景按序拼接）
                + 输出格式约束（含「多问题保留 + 结构化」）
   │
   ▼
ctx.llm.stream({ provider, model, messages: [system, user=buildUserText(instruction, attachments)] })
   │
   ▼
模型输出 = 改写后的 prompt（仅文本，无前缀解释）
   │
   ▼
recombine(输出, attachments) → 附件原文按占位符原位拼回（缺失则追加末尾）
   │
   ▼
返回浏览器面 → 预览条渲染
```

- **一次调用**完成「判多场景 → 综合套方法论 → 改写」，延迟可控，适合实时预览。
- **多场景综合**：一个输入可命中多个场景（如「写个 Python 脚本帮我分析实验数据」同时命中 coding + academic），系统 prompt 同时注入这些场景的「改写规则」，由模型综合应用；启发式预筛收敛候选，避免把 6 份 playbook 全量塞给模型。
- **附件分段**：长文本样本 / 代码块 / 多行 JSON / 长 token（base64、URL、哈希）不进改写模型——省 token、输出不被顶满 `maxOutputTokens`（默认 2048）、附件逐字保留不被改写污染；改写后按占位符原位拼回，缺失则追加末尾。
- **多提问**：输出约束要求逐一保留并编号、保序、不合并、不删改语义，只补约束与回答格式（「整合提炼 / 润色」留给后续显式 skill）。
- 模型由设置里的「改写模型」下拉决定（`provider` + `model`），baseURL / API key 由 dsh 已配置的 adapter 解析。
- 流式 chunk 经 `BlockAssembler` 组装，`FinishReason` 非正常终态（error/aborted/max-tokens）映射为失败；超时与取消经 `AbortController` + `signal` 链传递（见 §9 模型适配层）。

## 7. 设置（模型下拉，复用 Models 页）

- 用户先在 dsh 现有 **Settings → Models 页「Add custom provider」** 配好改写用的 gateway（route / baseURL / protocol / API key / models）。key 由 dsh 存 `~/.dsh/.credentials.yaml`，插件不碰明文。
- 插件在原生设置区注册一个「改写模型」下拉（`settings.section` 槽 + 宿主侧 settings namespace），选项来自 dsh 已配置的模型目录（宿主面 `listModels()` 枚举后经 RPC 提供给浏览器面）。
- 插件只存一个选择值（`{ provider, model }`），调 `ctx.llm.stream` 时用它。选择经 `installSettingsSection` 叠加在插件 `Config` 默认值之上；两者都缺省时改写返回 `no-model`。

## 8. UI（预览条）

- 注册 `conversation.input.dock` 槽（`list`，session 作用域）——dsh 专为此设计的「输入卡片上方独占一行」。owner 分享 `{ session, input }`，标准道具含 `inputActions`（`setDraft` / `submit` / `addImages` / `removeImage` / `pruneImages`）。
- 预览条与输入卡片同款胶囊形态（`border-radius: 22px` + dsh 设计 token），负外边距使下半部与输入框顶部重叠。
- 交互（**自动防抖触发**，无「改写」按钮）：

  1. 监听草稿 `input.draft`：每次变化清空旧计时器、取消在途请求（`AbortController`）。
  2. 草稿停止变化约 2s 后 → `connection.rpc.call('/input-rewriter', 'rewrite', { text })`。
  3. 宿主面返回改写文本，预览条渲染为**只读预览**（截断 + `title` 全量悬停）。
  4. 动作：
     - **发送改写**（预览条右侧）：`inputActions.setDraft(改写后) + inputActions.submit()`。
     - 「×」取消预览（该草稿不再自动改写，直到草稿再次变化）。
  5. 草稿在改写后又被编辑过 ⇒ 预览作废（隐藏），避免发送过期改写结果。

- 输入框本身始终保留用户原文；内置 Enter 行为不变（发原文，作兜底）。
- 请求进行中显示「改写中…」；失败态内联展示错误信息，输入与发送始终可用。

## 9. 模型适配层（`rewrite/llm.ts`）

把「输入改写」收敛为 provider 无关的单次 `ctx.llm.stream` 调用，天然适配任意已注册 adapter：

- **入参**：`{ ctx, provider, model, system, userText, maxOutputTokens, timeoutMs, signal? }`。
- **消息**：`createUserMessage({ content: [{ type:'text', text }], source: { kind:'plugin', plugin:'dsh-input-rewriter' } })`——`source` 标记改写来源，供审计/展示。
- **流式组装**：`BlockAssembler.push(chunk)` → `finish` 校验 → `blocks()` 提取纯文本（过滤非 text 块）。
- **超时**：`setTimeout` 触发 `AbortController.abort`；**取消**：外部 `signal` 的 `abort` 事件转发到内部 controller，二者在 `finally` 统一清理。
- **结果**：`{ ok:true, text }` 或 `{ ok:false, code:'llm-failed'|'empty-result'|'timeout', message }`。

## 10. 数据流

```
用户输入 → 浏览器面监听 input.draft（防抖约 2s，变化即取消在途）
  → connection.rpc.call('/input-rewriter', 'rewrite', { text })
  → 宿主面 RPC handler → ctx.rewrite.rewrite(text)
    → detectScenes 预筛命中场景 → splitInput 拆指令/附件 → 组装对应 playbook
    → ctx.llm.stream 调改写模型（仅发指令 + 附件占位说明）→ recombine 拼回附件原文
  → 返回 RewriteResult → 浏览器面预览条渲染（只读）
  → 用户点「发送改写」/「×」→ setDraft + submit / 取消
```

## 11. 异常处理

| 情形 | 行为 |
|---|---|
| 未配置改写模型（下拉为空） | 返回 `{ ok:false, code:'no-model' }`，预览条提示「请先选择改写模型」 |
| 请求参数非法（text 空 / 端点未知） | RPC `bad-request`，附 zod-style `issues` |
| LLM 调用失败 / 超时 / 空结果 | 返回对应 `code`，预览条显示错误，原文可正常发送 |
| RPC 内部异常 | `internal` 错误，不回传堆栈细节 |
| 浏览器面渲染崩溃 | 依赖 dsh 槽系统的错误边界，不阻断输入 |
| 草稿过期（改写后被编辑） | 预览作废隐藏，杜绝发送过期改写 |
| RPC 传输层失败 | 浏览器面捕获后内联展示，不影响发送原文 |

## 12. 日志机制（已移除）

本插件**不实现日志**。理由：dsh 的「轨迹」是会话事件账本（event ledger，贡献类型封闭），不是通用日志查看器，改写过程没有可落点的日志面板；插件自身的错误已通过 RPC `code` + 浏览器面内联错误 UI 呈现，日志没有用户可见价值，故完全删除，不引入 `ctx.logger`。

## 13. 热模块替换（HMR）

- 所有注册都绑定到插件 `ctx` 生命周期：`ctx.plugin(RewriteService)`、`installSettingsSection`、`ctx.skills.register`、`ctx.connection.rpc.handle`。
- RPC 的 disposer（`handle` 返回值）经 `ctx.effect(() => dispose)` 挂载，卸载/重载时框架自动调用，旧通道移除、新通道重建。
- 源文件修改触发重载时，旧 playbook 引用、旧服务实例、旧 RPC 通道全部清理，无泄漏、无重复注册。

## 14. 作为前置依赖：服务暴露与 skill 注册

本插件不作为「事件源」或「类继承基类」被依赖，而是通过两条 Cordis/dsh 原生通道对外复用：**能力层**暴露为可注入服务，**内容层**注册为 dsh 原生 skill。依赖关系一律用服务注入（`inject`）表达，不引入事件总线。

### 14.1 能力层：改写引擎暴露为可注入服务 `ctx.rewrite`

- 把「场景识别 + 方法论映射 + 单次改写」（§6）抽成可注入服务 `RewriteService`，由宿主面 `ctx.plugin(RewriteService, config)` 注册（`declare module` 增强 `Context.rewrite`）。
- 服务职责（实现）：

  | 方法 | 职责 |
  |---|---|
  | `rewrite(text, signal?)` | 单次改写，复用 §6 全流程（多场景预筛 + 综合改写），返回 `RewriteResult` |
  | `listModels()` | 枚举全部可用模型（跨 provider，单 provider 失败不中断） |
  | `currentSelection()` | 当前生效的 `{ provider, model }` 选择 |
  | `saveSelection(next)` | 持久化模型选择到 settings |

- 其他插件在 `inject` / `cordis.yml` 声明依赖本项目，服务就绪后即可拿到 `ctx.rewrite`，复用改写能力而不重写 playbook。
- 为什么是服务而非事件：改写是「调用后拿回结果」的请求-响应语义，天然匹配服务注入；事件只适合无返回值的广播，本阶段不需要，故不采用（见 §15）。

### 14.2 内容层：playbook 注册为 dsh 原生 skill

- 宿主面 `skills.ts` 加载 `skills/*.md` 后，通过 `ctx.skills.register` 把每份 playbook 注册成 dsh 原生 skill（`name: input-rewrite-<scene>`，`source: 'runtime'`），使其在技能系统里可见/可调用。
- 「改写内置 skill」落地路径：内置 skill 在加载时 `inject` 依赖本项目 → 拿到 `ctx.rewrite` → 把原始 skill 文本作为输入、套场景方法论改写一次 → 再注册。复用本项目已有的场景判定与方法论指令，而非另写一套。

## 15. 非目标 / 后续方向

- 多步编排（真检索 / 真验证链 / 思维树展开）——当前明确不做，属未来增强。
- 全局快捷键、替换输入框——受 dsh 能力边界限制，不做。
- 事件总线 / 类形式事件驱动架构——不采用，依赖复用已由 §14 的服务注入 + skill 注册覆盖。
- 改写结果的「采纳率/质量」统计、多候选改写（一次给 N 个版本）——后续。

## 16. 项目结构

```
d:/git/输入重写/
├── package.json          # name + dsh.client manifest + exports["./client"]
├── cordis.patch.yml      # bundle patch：insert 宿主插件
├── tsconfig.json         # 类型检查（strict，noEmit）
├── tsdown.config.ts      # 构建：宿主 ESM（dts）+ 浏览器 CJS bundle
├── src/                  # 宿主面（Node）
│   ├── index.ts          # 入口 apply()：loadPlaybooks → ctx.plugin(RewriteService) → skills → rpc
│   ├── rpc.ts            # /input-rewriter RPC 通道注册（rewrite/models/getModel/setModel）
│   ├── playbooks.ts      # 读 skills/*.md（fail-loud）
│   ├── settings.ts       # 改写模型 settings namespace + schema
│   ├── skills.ts         # playbook → ctx.skills.register（source: runtime）
│   └── rewrite/
│       ├── engine.ts     # 场景 taxonomy + 识别 + 系统 prompt 组装 + 文本提取
│       ├── llm.ts        # ctx.llm.stream 封装（流式 + 超时/取消）
│       └── service.ts    # RewriteService → ctx.rewrite
├── client/               # 浏览器面（沙箱闭包）
│   └── index.tsx         # 预览条 + 模型设置段（两个 slot）
├── skills/               # 提示词库 playbook（每场景一份）
│   ├── daily-life.md
│   ├── work.md
│   ├── academic.md
│   ├── coding.md
│   ├── creative.md
│   ├── security-audit.md
│   └── general.md
├── docs/
│   └── design.md
└── README.md
```
