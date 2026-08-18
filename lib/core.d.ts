//#region src/rewrite/engine.d.ts
/**
 * 改写引擎的纯函数面：场景 taxonomy、多场景识别启发式、系统 prompt 组装、
 * 文本提取与 finish 校验。不碰 I/O，便于单测与复用。
 */
/** 场景 id，与 skills/*.md 的 playbook 一一对应。 */
type SceneId = 'daily-life' | 'work' | 'academic' | 'coding' | 'creative' | 'security-audit' | 'general';
interface SceneMeta {
  id: SceneId;
  /** 展示名。 */
  name: string;
  /** 注册为 dsh skill 时的 when-to-use 描述。 */
  description: string;
  /** 多场景识别启发式用的关键词（代码侧预筛数据源）。 */
  keywords: string[];
  /** skills/ 目录下的 playbook 文件名。 */
  file: string;
}
declare const SCENES: readonly SceneMeta[];
//#endregion
//#region src/core.d.ts
/** 调用方提供的单次文本生成能力（框架无关；具体 SDK 由调用方适配）。 */
interface LlmLike {
  complete(input: {
    system: string;
    user: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}
/** 改写结果：成功返回改写文本与命中场景，失败返回机器可读 code + 展示用 message。 */
type CoreRewriteResult = {
  ok: true;
  rewritten: string;
  scenes: SceneId[];
} | {
  ok: false;
  code: 'llm-failed' | 'empty-result' | 'timeout';
  message: string;
};
/** 一份 playbook：场景元数据 + 改写指令原文。 */
interface Playbook {
  scene: SceneMeta;
  content: string;
}
interface CreateRewriterOptions {
  llm: LlmLike;
  playbooks: readonly Playbook[];
  /** 单次改写最大输出 token，默认 2048。 */
  maxOutputTokens?: number;
  /** 单次改写超时（毫秒），默认 60000。 */
  timeoutMs?: number;
}
interface Rewriter {
  rewrite(text: string, signal?: AbortSignal): Promise<CoreRewriteResult>;
}
/** 组装框架无关的改写器：全链路（场景识别→附件分段→拼 playbook→调 LLM→拼回）。 */
declare function createRewriter(options: CreateRewriterOptions): Rewriter;
//#endregion
export { CoreRewriteResult, CreateRewriterOptions, LlmLike, Playbook, Rewriter, SCENES, type SceneId, type SceneMeta, createRewriter };