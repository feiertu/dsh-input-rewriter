window.__ModuleLoader__.load({
	id: "dsh-input-rewriter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region client/index.tsx
		/** 插件运行时名（与包名一致）。 */
		const name = "dsh-input-rewriter";
		/** 必需服务：slots 注册 UI，connection 提供宿主↔浏览器 RPC。 */
		const inject = ["slots", "connection"];
		/** 宿主↔浏览器逻辑 RPC 通道（与宿主面 src/rpc.ts 一致）。 */
		const RPC_CHANNEL = "/input-rewriter";
		/** 模块级防抖时间存储：预览条与设置段共享，改动即时生效。 */
		let storedDebounceMs = 2e3;
		const debounceListeners = /* @__PURE__ */ new Set();
		/** 更新共享防抖时间并通知订阅者（设置段写入后调用）。 */
		function setStoredDebounceMs(ms) {
			if (!Number.isFinite(ms)) return;
			storedDebounceMs = ms;
			debounceListeners.forEach((listener) => listener(ms));
		}
		/** 从 context 解析浏览器面 connection 服务（无 Context 属性增强，走显式 cast）。 */
		function connection(ctx) {
			return ctx.get("connection");
		}
		/** 把 RPC 的 unknown value 收敛为可展示的改写结果。 */
		function parseRewriteOutcome(value) {
			if (typeof value === "object" && value !== null) {
				const v = value;
				if (v.ok === true && typeof v.rewritten === "string") return {
					ok: true,
					rewritten: v.rewritten
				};
				if (typeof v.message === "string") return {
					ok: false,
					message: v.message
				};
			}
			return {
				ok: false,
				message: "改写结果解析失败"
			};
		}
		function isModelInfo(value) {
			if (typeof value !== "object" || value === null) return false;
			const v = value;
			return typeof v.provider === "string" && typeof v.id === "string" && typeof v.name === "string";
		}
		function isModelSelection(value) {
			if (typeof value !== "object" || value === null) return false;
			const v = value;
			return typeof v.provider === "string" && typeof v.model === "string";
		}
		/** 模型选项值用 JSON 编码，规避 HTML option 值里空字符等分隔符歧义。 */
		function encodeModel(provider, model) {
			return JSON.stringify({
				provider,
				model
			});
		}
		function decodeModel(value) {
			try {
				const v = JSON.parse(value);
				if (typeof v.provider === "string" && typeof v.model === "string") return {
					provider: v.provider,
					model: v.model
				};
				return null;
			} catch {
				return null;
			}
		}
		/** 从用户消息的 ContentBlock 里抽取纯文本（过滤图片/工具调用等非文本块）。 */
		function extractUserText(blocks) {
			return blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
		}
		/** 触发浏览器下载一段文本为 .jsonl 文件。 */
		function downloadJsonl(content) {
			const blob = new Blob([content], { type: "application/x-ndjson" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "input-rewriter-finetune.jsonl";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
		}
		/** 创建关闭了 ctx 的改写预览条组件。 */
		function createDock(ctx) {
			return function InputRewriterDock({ input, inputActions, session }) {
				const [busy, setBusy] = (0, react.useState)(false);
				const [preview, setPreview] = (0, react.useState)(null);
				const [error, setError] = (0, react.useState)(null);
				const [debounceMs, setDebounceMs] = (0, react.useState)(storedDebounceMs);
				(0, react.useRef)(null);
				const controllerRef = (0, react.useRef)(null);
				const dismissedRef = (0, react.useRef)(null);
				const initializedRef = (0, react.useRef)(false);
				const lastSentSeqRef = (0, react.useRef)(null);
				const sentViaRewriteRef = (0, react.useRef)(false);
				const sentViaRewriteTimerRef = (0, react.useRef)(null);
				const draft = input.draft;
				const effective = preview !== null && preview.original !== draft ? null : preview;
				const runRewrite = (0, react.useCallback)(async (text) => {
					controllerRef.current?.abort();
					const controller = new AbortController();
					controllerRef.current = controller;
					setBusy(true);
					setError(null);
					try {
						const outcome = await connection(ctx).rpc.call(RPC_CHANNEL, "rewrite", { text }, controller.signal);
						if (controller.signal.aborted) return;
						if (!outcome.ok) {
							setError(outcome.error.message);
							return;
						}
						const parsed = parseRewriteOutcome(outcome.value);
						if (parsed.ok) setPreview({
							original: text,
							rewritten: parsed.rewritten
						});
						else setError(parsed.message);
					} catch (err) {
						if (controller.signal.aborted) return;
						setError(err instanceof Error ? err.message : String(err));
					} finally {
						if (!controller.signal.aborted) setBusy(false);
					}
				}, [ctx]);
				const collect = (0, react.useCallback)((output) => {
					if (output.trim().length === 0) return;
					connection(ctx).rpc.call(RPC_CHANNEL, "collect", { output }).catch(() => {});
				}, [ctx]);
				(0, react.useEffect)(() => {
					let cancelled = false;
					connection(ctx).rpc.call(RPC_CHANNEL, "getDebounce", null).then((outcome) => {
						if (cancelled || !outcome.ok || typeof outcome.value !== "number") return;
						setStoredDebounceMs(outcome.value);
					}).catch(() => {});
					const listener = (ms) => setDebounceMs(ms);
					debounceListeners.add(listener);
					return () => {
						cancelled = true;
						debounceListeners.delete(listener);
					};
				}, [ctx]);
				(0, react.useEffect)(() => {
					const text = draft.trim();
					if (text.length === 0) {
						controllerRef.current?.abort();
						setBusy(false);
						return;
					}
					if (dismissedRef.current === draft) return;
					if (preview !== null && preview.original === draft) return;
					controllerRef.current?.abort();
					setBusy(false);
					const timer = setTimeout(() => {
						runRewrite(text);
					}, debounceMs);
					return () => {
						clearTimeout(timer);
					};
				}, [
					draft,
					preview,
					runRewrite,
					debounceMs
				]);
				(0, react.useEffect)(() => {
					const userNodes = session.nodes.filter((node) => node.kind === "user" || node.kind === "steering");
					const lastSeq = userNodes.length === 0 ? null : userNodes[userNodes.length - 1].seq;
					if (!initializedRef.current) {
						initializedRef.current = true;
						lastSentSeqRef.current = lastSeq;
						return;
					}
					if (lastSeq === null || lastSeq === lastSentSeqRef.current) return;
					lastSentSeqRef.current = lastSeq;
					if (sentViaRewriteRef.current) {
						sentViaRewriteRef.current = false;
						if (sentViaRewriteTimerRef.current !== null) {
							clearTimeout(sentViaRewriteTimerRef.current);
							sentViaRewriteTimerRef.current = null;
						}
						return;
					}
					collect(extractUserText(userNodes[userNodes.length - 1].content));
				}, [session.nodes, collect]);
				const sendRewritten = () => {
					if (effective === null) return;
					sentViaRewriteRef.current = true;
					if (sentViaRewriteTimerRef.current !== null) clearTimeout(sentViaRewriteTimerRef.current);
					sentViaRewriteTimerRef.current = setTimeout(() => {
						sentViaRewriteRef.current = false;
					}, 5e3);
					collect(effective.original);
					inputActions.setDraft(effective.rewritten);
					inputActions.submit();
				};
				const dismiss = () => {
					dismissedRef.current = draft;
					setPreview(null);
					setError(null);
				};
				if (draft.trim().length === 0) return null;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: dockBarStyle,
					children: busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: mutedStyle,
						children: "改写中…"
					}) : effective !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: previewRowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: previewTextStyle,
							title: effective.rewritten,
							children: effective.rewritten
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: actionGroupStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: sendRewritten,
								style: primaryBtnStyle,
								children: "发送改写"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-label": "取消",
								onClick: dismiss,
								style: ghostBtnStyle,
								children: "×"
							})]
						})]
					}) : error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: errorStyle,
						children: error
					}) : null
				});
			};
		}
		/** 创建关闭了 ctx 的模型选择组件。 */
		function createModelSection(ctx) {
			return function RewriteModelSection(_props) {
				const [models, setModels] = (0, react.useState)([]);
				const [selection, setSelection] = (0, react.useState)("");
				const [busy, setBusy] = (0, react.useState)(true);
				const [error, setError] = (0, react.useState)(null);
				const [collectEnabled, setCollectEnabled] = (0, react.useState)(false);
				const [exportBusy, setExportBusy] = (0, react.useState)(false);
				const [collectPath, setCollectPath] = (0, react.useState)(null);
				const [debounceInput, setDebounceInput] = (0, react.useState)(String(storedDebounceMs));
				(0, react.useEffect)(() => {
					let cancelled = false;
					(async () => {
						try {
							const conn = connection(ctx);
							const modelsOutcome = await conn.rpc.call(RPC_CHANNEL, "models", null);
							if (cancelled) return;
							if (!modelsOutcome.ok) {
								setError(modelsOutcome.error.message);
								return;
							}
							const list = Array.isArray(modelsOutcome.value) ? modelsOutcome.value.filter(isModelInfo).map((m) => ({
								provider: m.provider,
								id: m.id,
								name: m.name
							})) : [];
							setModels(list);
							const currentOutcome = await conn.rpc.call(RPC_CHANNEL, "getModel", null);
							if (cancelled) return;
							if (currentOutcome.ok && isModelSelection(currentOutcome.value)) setSelection(encodeModel(currentOutcome.value.provider, currentOutcome.value.model));
							const collectOutcome = await conn.rpc.call(RPC_CHANNEL, "getCollect", null);
							if (cancelled) return;
							if (collectOutcome.ok && typeof collectOutcome.value === "boolean") setCollectEnabled(collectOutcome.value);
							const debounceOutcome = await conn.rpc.call(RPC_CHANNEL, "getDebounce", null);
							if (cancelled) return;
							if (debounceOutcome.ok && typeof debounceOutcome.value === "number") {
								setDebounceInput(String(debounceOutcome.value));
								setStoredDebounceMs(debounceOutcome.value);
							}
						} catch (err) {
							if (!cancelled) setError(err instanceof Error ? err.message : String(err));
						} finally {
							if (!cancelled) setBusy(false);
						}
					})();
					return () => {
						cancelled = true;
					};
				}, [ctx]);
				const onChange = async (next) => {
					if (next.length === 0) return;
					const parsed = decodeModel(next);
					if (parsed === null) return;
					setBusy(true);
					setError(null);
					try {
						const outcome = await connection(ctx).rpc.call(RPC_CHANNEL, "setModel", {
							provider: parsed.provider,
							model: parsed.model
						});
						if (!outcome.ok) {
							setError(outcome.error.message);
							return;
						}
						setSelection(next);
					} catch (err) {
						setError(err instanceof Error ? err.message : String(err));
					} finally {
						setBusy(false);
					}
				};
				const onToggleCollect = async (next) => {
					setCollectEnabled(next);
					try {
						const outcome = await connection(ctx).rpc.call(RPC_CHANNEL, "setCollect", { enabled: next });
						if (!outcome.ok) {
							setCollectEnabled(!next);
							setError(outcome.error.message);
						}
					} catch (err) {
						setCollectEnabled(!next);
						setError(err instanceof Error ? err.message : String(err));
					}
				};
				const commitDebounce = async () => {
					const parsed = Number(debounceInput);
					if (!Number.isFinite(parsed)) {
						setDebounceInput(String(storedDebounceMs));
						return;
					}
					const clamped = Math.min(1e4, Math.max(200, Math.round(parsed / 100) * 100));
					setDebounceInput(String(clamped));
					try {
						const outcome = await connection(ctx).rpc.call(RPC_CHANNEL, "setDebounce", { ms: clamped });
						if (!outcome.ok) {
							setError(outcome.error.message);
							return;
						}
						setStoredDebounceMs(clamped);
					} catch (err) {
						setError(err instanceof Error ? err.message : String(err));
					}
				};
				const onExport = async () => {
					setExportBusy(true);
					setError(null);
					try {
						const outcome = await connection(ctx).rpc.call(RPC_CHANNEL, "export", null);
						if (!outcome.ok) {
							setError(outcome.error.message);
							return;
						}
						const value = outcome.value;
						if (typeof value?.content !== "string") {
							setError("导出内容解析失败");
							return;
						}
						if (typeof value.path === "string") setCollectPath(value.path);
						downloadJsonl(value.content);
					} catch (err) {
						setError(err instanceof Error ? err.message : String(err));
					} finally {
						setExportBusy(false);
					}
				};
				const selectionModel = decodeModel(selection);
				const selectionInList = selectionModel !== null && models.some((m) => m.provider === selectionModel.provider && m.id === selectionModel.model);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: sectionStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							htmlFor: "input-rewriter-model",
							style: sectionLabelStyle,
							children: "改写模型"
						}),
						busy && models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: mutedStyle,
							children: "加载模型列表…"
						}) : models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: mutedStyle,
							children: "未检测到可用模型，请先在「设置 → Models」添加 provider 后再选择。"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							id: "input-rewriter-model",
							value: selection,
							disabled: busy,
							onChange: (event) => {
								onChange(event.currentTarget.value);
							},
							style: selectStyle,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "未选择（改写前请先选择模型）"
								}),
								selectionModel !== null && !selectionInList && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: selection,
									children: [
										selectionModel.provider,
										" / ",
										selectionModel.model
									]
								}),
								models.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: encodeModel(m.provider, m.id),
									children: [
										m.name,
										"（",
										m.provider,
										"）"
									]
								}, `${m.provider}::${m.id}`))
							]
						}),
						error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: errorStyle,
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: mutedStyle,
							children: "选中的模型仅用于「输入改写」，不会改变对话主模型。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							htmlFor: "input-rewriter-debounce",
							style: sectionLabelStyle,
							children: "自动改写等待时间（毫秒）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "input-rewriter-debounce",
							type: "number",
							min: 200,
							max: 1e4,
							step: 100,
							value: debounceInput,
							onChange: (event) => setDebounceInput(event.currentTarget.value),
							onBlur: () => {
								commitDebounce();
							},
							onKeyDown: (event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							},
							style: numberInputStyle
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: mutedStyle,
							children: "停止输入多久后自动触发改写，范围 200–10000ms，步进 100。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: checkboxRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: collectEnabled,
								onChange: (event) => {
									onToggleCollect(event.currentTarget.checked);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "采集对话用于微调（模仿用户口吻）" })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: mutedStyle,
							children: "开启后，每次发送都会把「原文 → 以用户语气〈动词〉」样本追加写入本机文件，供导出微调。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => {
								onExport();
							},
							disabled: exportBusy,
							style: secondaryBtnStyle,
							children: exportBusy ? "导出中…" : "导出微调数据（.jsonl）"
						}) }),
						collectPath !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: mutedStyle,
							children: ["本机文件：", collectPath]
						})
					]
				});
			};
		}
		/** 注册改写预览条与模型设置段；slot 声明由其它插件持有，经 inject 延迟到声明就绪。 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "input-rewriter",
				order: 10
			}, createDock(ctx)));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "input-rewriter",
				order: 100,
				label: "输入改写"
			}, createModelSection(ctx)));
		}
		/** 改写预览条：与输入卡片同款胶囊（radius 22px）+ 设计 token，负外边距让下半部与输入框顶部重叠。 */
		const dockBarStyle = {
			boxSizing: "border-box",
			width: "100%",
			maxWidth: "var(--dsh-composer-card-max-width)",
			margin: "0 auto -14px",
			border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
			background: "var(--dsw-specific-input-major)",
			boxShadow: "var(--dsw-shadow-lv2)",
			borderRadius: 22,
			padding: "10px 14px",
			fontSize: 14,
			lineHeight: "20px",
			position: "relative",
			zIndex: 8
		};
		const previewRowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			width: "100%",
			minWidth: 0
		};
		const previewTextStyle = {
			flex: 1,
			minWidth: 0,
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis",
			color: "var(--dsw-alias-label-primary)"
		};
		const actionGroupStyle = {
			display: "flex",
			gap: 4,
			flexShrink: 0
		};
		const primaryBtnStyle = {
			padding: "4px 12px",
			borderRadius: 999,
			border: "none",
			background: "var(--dsw-alias-state-business-primary)",
			color: "#fff",
			cursor: "pointer",
			fontSize: 13,
			lineHeight: "18px",
			whiteSpace: "nowrap"
		};
		const ghostBtnStyle = {
			padding: "4px 8px",
			borderRadius: 999,
			border: "none",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			fontSize: 14,
			lineHeight: "18px"
		};
		const mutedStyle = { color: "var(--dsw-alias-label-secondary)" };
		const errorStyle = {
			color: "var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warn-secondary))",
			fontSize: 12
		};
		const sectionStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 8,
			padding: 8
		};
		const sectionLabelStyle = {
			fontSize: 13,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const selectStyle = {
			maxWidth: 360,
			padding: "7px 10px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-specific-input-major)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13
		};
		const numberInputStyle = {
			width: 160,
			padding: "7px 10px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-specific-input-major)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13
		};
		const checkboxRowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			fontSize: 13,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-primary)",
			cursor: "pointer"
		};
		const secondaryBtnStyle = {
			padding: "6px 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-specific-input-major)",
			color: "var(--dsw-alias-label-primary)",
			cursor: "pointer",
			fontSize: 13,
			lineHeight: "18px"
		};
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map