import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
/** 插件运行时名（与包名一致，便于 bundle 注册统一键）。 */
declare const name = "dsh-input-rewriter";
/** 必需服务：llm 提供改写模型，connection 提供宿主↔浏览器 RPC。 */
declare const inject: string[];
/** 插件配置：provider/model 为可选的组合默认值，缺省时以设置里的选择为准。 */
interface Config {
  provider?: string;
  model?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}
/** 插件配置 schema。 */
declare const Config: z<Config>;
/** 插件入口。 */
declare function apply(ctx: Context, config: Config): Promise<void>;
//#endregion
export { Config, apply, inject, name };