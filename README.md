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
- **健壮**：全链路异常处理（超时 / 取消 / 空结果 / 未选模型 / 传输失败），playbook 加载 fail-loud，HMR 干净卸载。
- **其他**：支持通过源码增删改查skill逻辑


## 安装

```bash
dsh plugin --profile web add github:feiertu/dsh-input-rewriter
```

（等价写法：`dsh plugin --profile web add git+https://github.com/feiertu/dsh-input-rewriter.git`）

插件以 git 源方式安装；`lib/` 构建产物已随仓库提交，安装时无需构建。

## 构建

```bash
pnpm install
pnpm build   # tsdown → lib/index.js（宿主 ESM）+ lib/client.js（浏览器 CJS bundle）
```

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
  rpc.ts              # /input-rewriter RPC 通道（rewrite/models/getModel/setModel）
  rewrite/
    engine.ts         # 场景 taxonomy + 多场景识别 + 附件分段 + 系统 prompt 组装 + 文本提取
    llm.ts            # ctx.llm.stream 封装（流式组装 + 超时/取消）
    service.ts        # RewriteService → ctx.rewrite（改写 / 模型枚举 / 选择持久化）
  settings.ts         # 改写模型 settings namespace（input-rewriter）
  skills.ts           # playbook → dsh 原生 skill
  playbooks.ts        # 读 skills/*.md（fail-loud）
client/               # 浏览器面（沙箱）
  index.tsx           # 改写预览条 + 改写模型设置段（两个 slot）
skills/               # 提示词库 playbook（7 场景各一份）
```
