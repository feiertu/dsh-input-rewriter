import { n as SCENES, t as createRewriter } from "./core-wNbUohKh.js";
import z from "@deepseek-ai/schemastery";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
/** 自动改写防抖时间的默认值（毫秒）。 */
const DEFAULT_DEBOUNCE_MS = 2e3;
/** 设置段 schema（provider/model 允许「未选择」状态；collectEnabled 缺省关闭；debounceMs 范围 200–10000ms）。 */
const REWRITE_MODEL_SETTINGS_SCHEMA = z.object({
	provider: z.string(),
	model: z.string(),
	collectEnabled: z.boolean().default(false),
	debounceMs: z.number().min(200).max(1e4).step(100).default(DEFAULT_DEBOUNCE_MS)
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
//#region src/rewrite/annotate.ts
/**
* 微调样本采集的纯函数面：注释 prompt 组装、语气动词清单、注释结果解析、
* JSONL 行序列化。不碰 I/O，便于单测。采集独立于改写主链路，任何失败静默丢弃。
*/
/** 交流语气动词清单（instruction 固定为「以用户语气<动词>」）。 */
const TONE_VERBS = [
	"沟通",
	"聊天",
	"互动",
	"探讨",
	"商榷",
	"切磋",
	"交际",
	"汇报",
	"报告",
	"述职",
	"总结",
	"通报",
	"叮嘱",
	"交代",
	"告诫"
];
/** 注释模型的系统 prompt：给定 output（用户原文），反推语气动词与上下文 input。 */
const ANNOTATION_SYSTEM_PROMPT = [
	"你是一个「用户口吻」微调数据标注助手。",
	"给定一条用户原始消息（output），你需要：",
	"1. 从下面的语气动词清单里选一个最贴切的，填入 verb。",
	`语气动词清单：${TONE_VERBS.join("、")}`,
	"2. 反推一个合理的上下文 input：即会引出这条 output 的问题或情境，用自然中文描述。",
	"",
	"只输出一个 JSON 对象，形如 {\"verb\":\"沟通\",\"input\":\"…\"}。不要任何解释、不要 Markdown 代码块。"
].join("\n");
/** 注释模型的单次调用超时（毫秒）。 */
const ANNOTATION_TIMEOUT_MS = 3e4;
/** 从注释模型返回的原文里解析出 { verb, input }；无法解析时返回 undefined。 */
function parseAnnotation(raw) {
	const text = raw.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
	const body = fenced !== null ? fenced[1] : text;
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed.verb === "string" && typeof parsed.input === "string") {
			const verb = parsed.verb.trim();
			const input = parsed.input.trim();
			if (verb.length > 0 && input.length > 0) return {
				verb,
				input
			};
		}
		return;
	} catch {
		return;
	}
}
/** 把 verb 规整到清单内（不在清单时回落「沟通」，保持 taxonomy 稳定）。 */
function normalizeVerb(verb) {
	return TONE_VERBS.includes(verb) ? verb : "沟通";
}
/** 组装一条微调样本（instruction 固定为「以用户语气<动词>」，output 为用户原文）。 */
function toTrainingSample(output, verb, input) {
	return {
		instruction: `以用户语气${normalizeVerb(verb)}`,
		input,
		output
	};
}
/** 序列化为一行 JSONL（末尾带换行，可多次 appendFile 拼接）。 */
function serializeTrainingLine(sample) {
	return JSON.stringify(sample) + "\n";
}
//#endregion
//#region src/rewrite/service.ts
/**
* 改写服务：暴露 `ctx.rewrite`，聚合模型选择持久化与框架无关改写核心。
* 模型选择经 `installSettingsSection` 可选叠加在 settings 服务之上，未挂载时回落
* 到插件 Config 的组合默认值；两者都缺省时改写返回 `no-model`。
*/
/**
* 采集样本写入的项目内 `data/` 目录：相对包根解析。产物态 `lib/index.js` 位于包内一层，
* `import.meta.url` 的 `../data/` 即包根 `data/`；本模块经 tsdown 打包进 `lib/index.js`，
* 运行时以产物态为准（与 `skills/` 目录的解析方式一致）。
*/
const COLLECT_FILE_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const COLLECT_FILE = path.join(COLLECT_FILE_DIR, "finetune.jsonl");
var RewriteService = class extends Service {
	rewriter;
	llm;
	source;
	constructor(ctx, config) {
		super(ctx, "rewrite");
		const entry = {
			provider: config.provider,
			model: config.model,
			collectEnabled: false,
			debounceMs: DEFAULT_DEBOUNCE_MS
		};
		this.source = () => entry;
		installSettingsSection(ctx, REWRITE_MODEL_SETTINGS_NAMESPACE, REWRITE_MODEL_SETTINGS_SCHEMA, entry, {
			setSource: (current) => {
				this.source = current;
			},
			onChange: () => {}
		});
		const llm = dshLlmLike(ctx, () => this.source());
		this.llm = llm;
		this.rewriter = createRewriter({
			llm,
			playbooks: config.playbooks,
			maxOutputTokens: config.maxOutputTokens,
			timeoutMs: config.timeoutMs
		});
	}
	/** 当前生效的模型选择（provider/model 均缺省表示未配置）。 */
	currentSelection() {
		return this.source();
	}
	/** 持久化模型选择到 settings 服务（未挂载时静默忽略；合并写，保留采集开关）。 */
	async saveSelection(next) {
		await this.ctx.get("settings")?.update(REWRITE_MODEL_SETTINGS_NAMESPACE, {
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
	/** 是否开启微调样本采集。 */
	isCollectionEnabled() {
		return this.source().collectEnabled === true;
	}
	/** 持久化采集开关（未挂载 settings 时静默忽略）。 */
	async saveCollection(enabled) {
		await this.ctx.get("settings")?.update(REWRITE_MODEL_SETTINGS_NAMESPACE, { collectEnabled: enabled });
	}
	/** 当前生效的自动改写防抖时间（毫秒）；未配置时回落默认值。 */
	currentDebounceMs() {
		const value = this.source().debounceMs;
		return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_DEBOUNCE_MS;
	}
	/** 持久化自动改写防抖时间；夹取到 [200, 10000] 并取整到 100 的倍数以匹配 schema。 */
	async saveDebounce(ms) {
		const clamped = Math.min(1e4, Math.max(200, Math.round(ms / 100) * 100));
		await this.ctx.get("settings")?.update(REWRITE_MODEL_SETTINGS_NAMESPACE, { debounceMs: clamped });
	}
	/**
	* 采集一条微调样本：注释模型反推 { verb, input }，组装成「以用户语气<verb>」，
	* 追加写入本地 JSONL。开关关闭或注释失败时返回 false（静默丢弃，不影响主链路）。
	*/
	async collect(output) {
		if (!this.isCollectionEnabled()) return false;
		try {
			const parsed = parseAnnotation(await this.annotate(output));
			if (parsed === void 0) return false;
			const line = serializeTrainingLine(toTrainingSample(output, parsed.verb, parsed.input));
			await mkdir(COLLECT_FILE_DIR, { recursive: true });
			await appendFile(COLLECT_FILE, line, "utf8");
			return true;
		} catch {
			return false;
		}
	}
	/** 导出累积的 JSONL 内容；文件尚不存在时返回空串。 */
	async exportCollected() {
		let content = "";
		try {
			content = await readFile(COLLECT_FILE, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		return {
			content,
			path: COLLECT_FILE
		};
	}
	/** 单次注释调用：复用改写模型，反推语气动词与上下文 input。 */
	async annotate(output) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("采集标注超时")), ANNOTATION_TIMEOUT_MS);
		try {
			return await this.llm.complete({
				system: ANNOTATION_SYSTEM_PROMPT,
				user: output,
				maxTokens: 256,
				signal: controller.signal
			});
		} finally {
			clearTimeout(timer);
		}
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
				case "collect": {
					const output = payload?.output;
					if (typeof output !== "string" || output.trim().length === 0) return badRequest("collect: output must be a non-empty string");
					return {
						ok: true,
						value: { collected: await ctx.rewrite.collect(output) }
					};
				}
				case "export": return {
					ok: true,
					value: await ctx.rewrite.exportCollected()
				};
				case "getCollect": return {
					ok: true,
					value: ctx.rewrite.isCollectionEnabled()
				};
				case "setCollect": {
					const enabled = payload?.enabled;
					if (typeof enabled !== "boolean") return badRequest("setCollect: enabled must be a boolean");
					await ctx.rewrite.saveCollection(enabled);
					return {
						ok: true,
						value: enabled
					};
				}
				case "getDebounce": return {
					ok: true,
					value: ctx.rewrite.currentDebounceMs()
				};
				case "setDebounce": {
					const ms = payload?.ms;
					if (typeof ms !== "number" || !Number.isFinite(ms)) return badRequest("setDebounce: ms must be a finite number");
					await ctx.rewrite.saveDebounce(ms);
					return {
						ok: true,
						value: ctx.rewrite.currentDebounceMs()
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
