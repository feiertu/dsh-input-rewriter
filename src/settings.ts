/**
 * 改写模型设置：`input-rewriter` 命名空间，持久化用户选中的 `{ provider, model }`。
 * 作为 `base` 层叠加在插件 Config 的 `provider`/`model` 之上，未配置时两者皆缺省。
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** 改写模型设置命名空间。 */
export const REWRITE_MODEL_SETTINGS_NAMESPACE = settingsNamespace('input-rewriter')

/** 设置段内容；provider/model 缺省表示尚未选择改写模型。 */
export interface RewriteModelSettings {
  provider?: string
  model?: string
}

/** 设置段 schema（字段可选，允许「未选择」状态）。 */
export const REWRITE_MODEL_SETTINGS_SCHEMA: z<RewriteModelSettings> = z.object({
  provider: z.string(),
  model: z.string(),
})

/** 是否已构成可用选择（provider 与 model 均非空）。 */
export function isModelSelectionConfigured(
  selection: RewriteModelSettings,
): selection is { provider: string; model: string } {
  return typeof selection.provider === 'string' && selection.provider.length > 0
    && typeof selection.model === 'string' && selection.model.length > 0
}
