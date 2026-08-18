# dsh-input-rewriter

一个 DeepSeek Harness（dsh）插件：**帮你把问题问得更好，而且是全自动的。**

你正常打字就行。停下来约 2 秒，它就悄悄把你刚才的话改写成更容易得到好答案的样子，直接显示在输入框上方。你不用点任何按钮，也不用学什么「提问技巧」。

## 它能帮你做什么

- **全自动，零打扰**：停止输入约 2 秒就改写，不用点任何按钮。你接着改，它就接着更新，不会把过期的旧结果发出去。
- **你贴的代码、网址、长文本，一律原样保留**：它会自动认出问题里「不该乱动」的部分——代码、网址、一大段数据——只改写你真正「提问」的部分，绝不动你的原文，省得 AI 答非所问。
- **看得懂你在问什么**：它能判断你问的是生活、工作、学习、写代码、写作、安全还是别的，然后套用对应的套路，帮你补全目标、结构和要求。
- **一次问好几件事，一件都不漏**：多个问题会一个个帮你保留、编号、排好顺序，只补说明，绝不把你的意思改没。
- **不碰你的秘密**：它只记住你「选了哪个模型」，从来不接触你的密钥、密码。
- **顺手攒一份「学你说话」的数据（可选）**：在设置里打开开关后，每次发送都会把你的原文连同「以用户语气〈动词〉」一起存进一个本地文件，攒够了导出去微调一个模仿你口吻的模型。

## 怎么安装

先确认你电脑上已经装好了 `dsh`：打开终端，输入 `dsh --version`，能看到版本号就说明装好了。

然后，复制下面这一行，粘贴到终端里，回车：

```bash
dsh plugin --profile web add dsh-input-rewriter
```

看到命令最后出现 `Done`，就说明装好了。

> 如果上面这行报错装不上，就用这一行代替：
>
> ```bash
> dsh plugin --profile web add github:feiertu/dsh-input-rewriter
> ```

## 装完怎么用

1. 重启 `dsh web`。
2. 刷新浏览器页面。
3. 完事。以后你打字停下约 2 秒，输入框上方就会出现改写好的版本。

> 如果一直没反应，多半是还没选「改写模型」：去 dsh 的设置里选一个模型就行。模型的密钥由 dsh 自己管，这个插件不碰。

## 采集对话，微调一个「学你说话」的模型

这是可选的，默认关着。打开后，插件会在你每次发送时，把你发出去的那句话存成一条微调样本。

1. 去 dsh 的设置页，找到「输入重写」板块，勾选「采集对话用于微调」。
2. 之后正常聊天。每发一句，插件就会存一条样本，格式是这样：

   ```json
   {"instruction":"以用户语气沟通","input":"有人问你在干嘛","output":"关你屁事。"}
   ```

   - `output` 是你发的原文，原封不动；
   - `instruction` 是「以用户语气〈动词〉」，动词由模型根据你的话猜一个最贴切的；
   - `input` 是模型反推出的上下文（会引出这句话的问题或情境）。

3. 攒够了，回到设置页点「导出微调数据（.jsonl）」，浏览器会下载一个 `input-rewriter-finetune.jsonl` 文件。把它喂给 LLaMA-Factory、alpaca 之类的微调框架就行。

样本存在插件目录的 `data/finetune.jsonl` 里。注意：每存一条都要让模型多跑一次「反推上下文」的标注，会额外花一点 token。

## 项目代码结构

```
src/                    宿主面（Node 进程，完整 Cordis 插件）
├── index.ts            插件入口：加载 playbook → 注册 ctx.rewrite 服务 → 注册 RPC
├── core.ts             框架无关改写核心（LlmLike 抽象 + createRewriter），零 dsh 依赖
├── playbooks.ts        加载 skills/*.md 的 playbook 原文
├── skills.ts           把 playbook 注册为 dsh skill（name 形如 input-rewrite-<scene>）
├── settings.ts         设置命名空间与 schema（provider/model + 采集开关）
├── rpc.ts              宿主↔浏览器 RPC 通道 /input-rewriter
└── rewrite/
    ├── engine.ts       纯函数面：场景识别、系统 prompt 组装、附件分段与拼回
    ├── llm.ts          把 ctx.llm.stream 包装成框架无关的 LlmLike
    ├── service.ts      RewriteService：聚合模型选择、改写、采集、导出
    └── annotate.ts     采集纯函数：注释 prompt、语气动词清单、JSONL 序列化

client/                 浏览器面
└── index.tsx           输入框改写 dock + 设置板块（模型选择、采集开关、导出）

skills/                 7 份 playbook（Markdown，对应 7 个场景）
data/                   微调样本目录（finetune.jsonl，采集时自动写入）
test/                   单元测试（annotate / core / engine）
lib/                    编译产物（lib/index.js 宿主面、lib/client.js 浏览器面）
```

- **宿主面**：`src/`，跑在 Node 进程里，负责改写核心逻辑、模型调用、样本落盘。
- **浏览器面**：`client/index.tsx`，跑在 dsh 的 web 沙箱里，负责输入框 UI 和设置页。
- **核心与适配分离**：`core.ts` 完全不依赖 dsh，可独立复用；`rewrite/llm.ts` 只做 dsh → LlmLike 的适配。
- **采集独立于改写主链路**：`annotate.ts` 的纯函数不碰 I/O，任何失败静默丢弃，不影响改写与发送。
