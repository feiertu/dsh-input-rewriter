import { n as SCENES, t as createRewriter } from "./core-DU5NIpXT.js";
import z from "@deepseek-ai/schemastery";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Service } from "@deepseek-ai/cordis";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/playbooks.ts
/**
* 加载 skills/*.md 的 playbook 内容。
*
* 路径相对包根（`../skills/`）：源码态 `src/playbooks.ts` 与产物态 `lib/index.js`
* 都位于包内一层，`import.meta.url` 相对解析到同一 `skills/` 目录。
*/
const SKILLS_DIR = new URL("../skills/", import.meta.url);
/** 读入全部场景 playbook（Markdown 原文），失败即抛，保证 misconfiguration fail-loud。 */
async function loadPlaybooks() {
	const result = [];
	for (const scene of SCENES) {
		const url = new URL(scene.file, SKILLS_DIR);
		const content = await readFile(fileURLToPath(url), "utf8");
		if (content.trim().length === 0) throw new Error(`playbook ${scene.file} 为空`);
		result.push({
			scene,
			content
		});
	}
	return result;
}
//#endregion
//#region src/skills.ts
/** 把 playbook 注册为运行时 skill（name 形如 `input-rewrite-<scene>`）。 */
function registerPlaybookSkills(ctx, playbooks) {
	const skills = ctx.get("skills");
	if (skills === void 0) return;
	for (const { scene, content } of playbooks) skills.register({
		name: `input-rewrite-${scene.id}`,
		description: scene.description,
		source: "runtime",
		content
	});
}
//#endregion
//#region src/settings.ts
/**
* 改写模型设置：`input-rewriter` 命名空间，持久化用户选中的 `{ provider, model }`。
* 作为 `base` 层叠加在插件 Config 的 `provider`/`model` 之上，未配置时两者皆缺省。
*/
/** 改写模型设置命名空间。 */
const REWRITE_MODEL_SETTINGS_NAMESPACE = settingsNamespace("input-rewriter");
/** 设置段 schema（字段可选，允许「未选择」状态）。 */
const REWRITE_MODEL_SETTINGS_SCHEMA = z.object({
	provider: z.string(),
	model: z.string()
});
/** 是否已构成可用选择（provider 与 model 均非空）。 */
function isModelSelectionConfigured(selection) {
	return typeof selection.provider === "string" && selection.provider.length > 0 && typeof selection.model === "string" && selection.model.length > 0;
}
//#endregion
//#region src/rewrite/llm.ts
/** 从组装后的 ContentBlock 里提取纯文本（过滤图片/工具调用等非文本块）。 */
function extractText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
}
/** 把终态 finish reason 映射为失败错误（stop/tool-calls 视为成功）。 */
function finishError(finish) {
	switch (finish.kind) {
		case "error":
		case "aborted": return new Error(finish.failure.message);
		case "max-tokens": return /* @__PURE__ */ new Error("改写结果被 token 上限截断");
		default: return;
	}
}
/** 把 `ctx.llm.stream` 包装成 `LlmLike`；provider/model 经 `getSelection` 在调用时解析。 */
function dshLlmLike(ctx, getSelection) {
	return { async complete({ system, user, maxTokens, signal }) {
		const selection = getSelection();
		if (!isModelSelectionConfigured(selection)) throw new Error("改写模型未配置");
		const assembler = new BlockAssembler();
		for await (const chunk of ctx.llm.stream({
			provider: selection.provider,
			model: selection.model,
			messages: [createUserMessage({
				content: [{
					type: "text",
					text: user
				}],
				source: {
					kind: "plugin",
					plugin: "dsh-input-rewriter"
				}
			})],
			system,
			maxTokens,
			signal
		})) assembler.push(chunk);
		const err = finishError(assembler.finish);
		if (err !== void 0) throw err;
		return extractText(assembler.blocks());
	} };
}
//#endregion
//#region src/rewrite/service.ts
/**
* 改写服务：暴露 `ctx.rewrite`，聚合模型选择持久化与框架无关改写核心。
* 模型选择经 `installSettingsSection` 可选叠加在 settings 服务之上，未挂载时回落
* 到插件 Config 的组合默认值；两者都缺省时改写返回 `no-model`。
*/
var RewriteService = class extends Service {
	rewriter;
	source;
	constructor(ctx, config) {
		super(ctx, "rewrite");
		const entry = {
			provider: config.provider,
			model: config.model
		};
		this.source = () => entry;
		installSettingsSection(ctx, REWRITE_MODEL_SETTINGS_NAMESPACE, REWRITE_MODEL_SETTINGS_SCHEMA, entry, {
			setSource: (current) => {
				this.source = current;
			},
			onChange: () => {}
		});
		this.rewriter = createRewriter({
			llm: dshLlmLike(ctx, () => this.source()),
			playbooks: config.playbooks,
			maxOutputTokens: config.maxOutputTokens,
			timeoutMs: config.timeoutMs
		});
	}
	/** 当前生效的模型选择（provider/model 均缺省表示未配置）。 */
	currentSelection() {
		return this.source();
	}
	/** 持久化模型选择到 settings 服务（未挂载时静默忽略）。 */
	async saveSelection(next) {
		await this.ctx.get("settings")?.replace(REWRITE_MODEL_SETTINGS_NAMESPACE, {
			provider: next.provider ?? "",
			model: next.model ?? ""
		});
	}
	/** 列出所有可用模型（跨全部 provider，单个 provider 失败不影响其余）。 */
	async listModels() {
		const result = [];
		for (const provider of this.ctx.llm.listProviders()) try {
			result.push(...await this.ctx.llm.listModels(provider.id));
		} catch {}
		return result;
	}
	/** 核心：检查模型选择后委托框架无关 rewriter 做单次改写。 */
	async rewrite(text, signal) {
		if (!isModelSelectionConfigured(this.source())) return {
			ok: false,
			code: "no-model",
			message: "尚未配置改写模型，请在设置中选择"
		};
		return this.rewriter.rewrite(text, signal);
	}
};
//#endregion
//#region src/rpc.ts
/** 宿主↔浏览器面的逻辑 RPC 通道。 */
const REWRITE_RPC_CHANNEL = "/input-rewriter";
function badRequest(message) {
	return {
		ok: false,
		error: {
			code: "bad-request",
			message,
			details: { issues: [] }
		}
	};
}
function internalError(error) {
	return {
		ok: false,
		error: {
			code: "internal",
			message: error instanceof Error ? error.message : String(error),
			details: {}
		}
	};
}
/** 注册 RPC 通道；返回的 disposer 绑定到当前 context，HMR 卸载时自动移除。 */
function registerRewriteRpc(ctx) {
	const dispose = ctx.connection.rpc.handle(REWRITE_RPC_CHANNEL, async (endpoint, payload, signal) => {
		try {
			switch (endpoint) {
				case "rewrite": {
					const text = payload?.text;
					if (typeof text !== "string" || text.trim().length === 0) return badRequest("rewrite: text must be a non-empty string");
					return {
						ok: true,
						value: await ctx.rewrite.rewrite(text, signal)
					};
				}
				case "models": return {
					ok: true,
					value: await ctx.rewrite.listModels()
				};
				case "getModel": {
					const selection = ctx.rewrite.currentSelection();
					return {
						ok: true,
						value: selection.provider !== void 0 && selection.model !== void 0 ? {
							provider: selection.provider,
							model: selection.model
						} : null
					};
				}
				case "setModel": {
					const next = payload;
					if (typeof next?.provider !== "string" || typeof next?.model !== "string" || next.provider.length === 0 || next.model.length === 0) return badRequest("setModel: provider and model must be non-empty strings");
					await ctx.rewrite.saveSelection({
						provider: next.provider,
						model: next.model
					});
					return {
						ok: true,
						value: {
							provider: next.provider,
							model: next.model
						}
					};
				}
				default: return badRequest(`unknown endpoint ${JSON.stringify(endpoint)}`);
			}
		} catch (error) {
			return internalError(error);
		}
	}, { authority: "loopback" });
	ctx.effect(() => dispose);
}
//#endregion
//#region src/index.ts
/** 插件运行时名（与包名一致，便于 bundle 注册统一键）。 */
const name = "dsh-input-rewriter";
/** 必需服务：llm 提供改写模型，connection 提供宿主↔浏览器 RPC。 */
const inject = ["llm", "connection"];
/** 插件配置 schema。 */
const Config = z.object({
	provider: z.string(),
	model: z.string(),
	maxOutputTokens: z.number().min(64).default(2048),
	timeoutMs: z.number().min(1e3).default(6e4)
});
/** 插件入口。 */
async function apply(ctx, config) {
	const playbooks = await loadPlaybooks();
	new RewriteService(ctx, {
		provider: config.provider,
		model: config.model,
		maxOutputTokens: config.maxOutputTokens ?? 2048,
		timeoutMs: config.timeoutMs ?? 6e4,
		playbooks
	});
	registerPlaybookSkills(ctx, playbooks);
	registerRewriteRpc(ctx);
}
//#endregion
export { Config, apply, inject, name };
