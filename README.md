# dsh-input-rewriter

DeepSeek Harness（dsh）插件：在**发送前**用提示词工程 playbook 把用户输入自动改写为更优 prompt。

双面（dual-half）**编译型 bundle 插件**——宿主面跑在 Node 进程（完整 Cordis 插件），浏览器面跑在沙箱闭包（React UI），两面通过 `connection.rpc` 通信。

## 功能

在 dsh **发送前**把用户输入自动改写成应用了提示词工程方法论的更优 prompt——**零操作、不打扰**。核心优势：

- **全自动触发**：停止输入约 2s 后自动改写，无需任何按钮；在途请求随草稿变化自动取消，过期预览自动作废，绝不给用户发送过时结果。
- **附件分段改写（省 token、不污染原文）**：代码块、多行 JSON、超长 token（base64 / URL / 哈希）等「附件」被自动识别并**跳过改写模型**——省 token、输出不再被截断、附件逐字保留不被改写污染；改写后原位拼回，再一起交给任务模型。
- **多场景智能识别**：内置 7 大场景 playbook（日常生活 / 工作职场 / 学术研究 / 技术编程 / 创意写作 / 安全排查 / 通用兜底），一个输入可命中多场景，启发式预筛 + 模型综合应用 CoT / ToT / GoT / RAG / RAR / CoVe / 注意力引导等方法论。
- **多提问不丢信息**：多个问题逐一保留、编号、保序，只补约束与回答格式，绝不擅自合并或删改语义。。
- **安全**：插件只保存 `{ provider, model }` 选择值，不接触任何 API key 明文。
- **对外可复用**：改写引擎暴露为可注入服务 `ctx.rewrite`；每份 playbook 注册为 dsh 原生 skill（`input-rewrite-<scene>`），供其它插件 / 技能直接复用。
- **框架无关核心**：改写引擎抽成零 dsh 依赖的 `dsh-input-rewriter/core` 子入口，暴露 `createRewriter` + `LlmLike`；外部 agent（MCP / CLI / HTTP 薄壳）无需安装任何 dsh 依赖即可复用同一套改写能力。
- **健壮**：全链路异常处理（超时 / 取消 / 空结果 / 未选模型 / 传输失败），playbook 加载 fail-loud，HMR 干净卸载。
- **其他**：支持通过源码增删改查skill逻辑


## 安装

### 环境准备

- `dsh`（`dsh --version` 验证）
- `pnpm` ≥ 10（`dsh plugin` 底层把参数转发给 pnpm 在 profile 目录执行）
- `git`（从 GitHub / Git 源安装时需要）
- Node.js ≥ 20

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-input-rewriter
```

### 从 GitHub 仓库安装

```bash
dsh plugin --profile web add github:feiertu/dsh-input-rewriter
```

等价 Git URL 写法：`dsh plugin --profile web add git+https://github.com/feiertu/dsh-input-rewriter.git`

### 本地目录安装（开发调试）

在插件源码根目录执行：

```bash
dsh plugin --profile web add .
```

### 生效

安装成功后，`dsh` 会自动把本插件（声明了 `dsh.bundle.patch`）挂载进 `dsh.profile.bundles`，**重启 `dsh web` 并刷新浏览器**即可生效；可用 `dsh --profile web --dump-config` 验证插件已进入配置树。

> 本插件 `lib/` 构建产物已随仓库提交，且无 `prepare` 脚本，从 Git 源安装时**无需**在 `pnpm-workspace.yaml` 配置 `allowBuilds`；安装中出现的 `missing peer` 警告（`@deepseek-ai/cordis`、`react` 等）由 DSH 宿主运行时提供，可忽略，命令末尾出现 `Done` 即安装成功。

## 发布与分发

DSH 插件即一个 npm 包（也可来自 Git 仓库 / 本地目录），通过 `package.json` 的 `dsh` 字段声明能力。本插件按此约定分发：

| 渠道 | 安装命令 | 状态 |
|---|---|---|
| npm registry | `dsh plugin --profile web add dsh-input-rewriter` | ✅ 已发布 |
| GitHub 仓库 | `dsh plugin --profile web add github:feiertu/dsh-input-rewriter` | ✅ 可用 |
| Git URL | `dsh plugin --profile web add git+https://github.com/feiertu/dsh-input-rewriter.git` | ✅ 可用 |
| 本地目录 | `dsh plugin --profile web add .` | ✅ 开发调试 |
| 插件市场 | 向 `awesome-dsh-plugin/awesome-dsh-plugin` 提交 PR 收录 | ⏳ 可选 |

已挂 GitHub topic：`dsh-plugin`（https://github.com/topics/dsh-plugin）。

## 配置

插件可选 `Config`：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `provider` | string | — | 改写模型 provider（组合默认值） |
| `model` | string | — | 改写模型 id（组合默认值） |
| `maxOutputTokens` | number | 2048 | 单次改写最大输出 token |
| `timeoutMs` | number | 60000 | 单次改写超时 |

改写模型优先级：设置里的「改写模型」下拉 > 插件 `Config` 的 `provider`/`model` 默认值。

## 依赖与服务

- **宿主面** `inject`: `llm`、`connection`
- **浏览器面** `inject`: `slots`、`connection`
- **声明服务**：`ctx.rewrite`（`RewriteService`），方法 `rewrite` / `listModels` / `currentSelection` / `saveSelection`

## 安全

插件只保存 `{ provider, model }` 选择值；API key / baseURL 由 dsh 现有 **Settings → Models 页**管理（密钥存环境变量或 `~/.dsh/.credentials.yaml`），插件不接触任何凭据明文。

## 模型适配

插件本身**与 provider 无关**：改写模型下拉列出 `ctx.llm` 已注册的全部 provider 与模型，自动支持任意已安装适配器。在 Settings → Models 里配置 `apiKeyEnv: MINIMAX_API_KEY`（密钥存环境变量）并选择对应模型即可在改写下拉里出现。

## 目录结构

```
src/                  # 宿主面（Node）
  index.ts            # 入口 apply()：加载 playbook → new RewriteService(ctx) 提供 ctx.rewrite → 注册 skill/RPC
  core.ts             # 框架无关改写核心：LlmLike + createRewriter（零 dsh 依赖，./core 子入口）
  rpc.ts              # /input-rewriter RPC 通道（rewrite/models/getModel/setModel）
  rewrite/
    engine.ts         # 场景 taxonomy + 多场景识别 + 附件分段 + 系统 prompt 组装（纯函数）
    llm.ts            # dshLlmLike：ctx.llm.stream 封装（流式组装 + finish 校验 + 文本提取）
    service.ts        # RewriteService → ctx.rewrite（委托 createRewriter / 模型枚举 / 选择持久化）
  settings.ts         # 改写模型 settings namespace（input-rewriter）
  skills.ts           # playbook → dsh 原生 skill
  playbooks.ts        # 读 skills/*.md（fail-loud）
test/                 # vitest 单测（engine 纯函数 + core 全链路）
client/               # 浏览器面（沙箱）
  index.tsx           # 改写预览条 + 改写模型设置段（两个 slot）
skills/               # 提示词库 playbook（7 场景各一份）
```
