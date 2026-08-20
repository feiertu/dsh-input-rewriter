/**
 * 宿主面 RPC：在 `connection.rpc` 上注册 `/input-rewriter` 通道，
 * 浏览器面经 `connection.rpc.call` 访问 rewrite/models/getModel/setModel 四个端点。
 * 传输层错误走 `bad-request`/`internal`，业务结果（含改写失败）作为 value 返回。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
// 激活宿主面 `Context.connection: HostConnectionHandle` 类型增强（rpc.handle）。
import type {} from '@deepseek-ai/dsh-client-connection'

/** 宿主↔浏览器面的逻辑 RPC 通道。 */
export const REWRITE_RPC_CHANNEL = '/input-rewriter'

function badRequest(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function internalError(error: unknown): RpcResult<unknown> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** 注册 RPC 通道；返回的 disposer 绑定到当前 context，HMR 卸载时自动移除。 */
export function registerRewriteRpc(ctx: Context): void {
  const dispose = ctx.connection.rpc.handle(
    REWRITE_RPC_CHANNEL,
    async (endpoint, payload, signal): Promise<RpcResult<unknown>> => {
      try {
        switch (endpoint) {
          case 'rewrite': {
            const text = (payload as { text?: unknown } | null)?.text
            if (typeof text !== 'string' || text.trim().length === 0) {
              return badRequest('rewrite: text must be a non-empty string')
            }
            const result = await ctx.rewrite.rewrite(text, signal)
            return { ok: true, value: result }
          }
          case 'models': {
            const models = await ctx.rewrite.listModels()
            return { ok: true, value: models }
          }
          case 'getModel': {
            const selection = ctx.rewrite.currentSelection()
            const value = selection.provider !== undefined && selection.model !== undefined
              ? { provider: selection.provider, model: selection.model }
              : null
            return { ok: true, value }
          }
          case 'setModel': {
            const next = payload as { provider?: unknown; model?: unknown } | null
            if (typeof next?.provider !== 'string' || typeof next?.model !== 'string'
              || next.provider.length === 0 || next.model.length === 0) {
              return badRequest('setModel: provider and model must be non-empty strings')
            }
            await ctx.rewrite.saveSelection({ provider: next.provider, model: next.model })
            return { ok: true, value: { provider: next.provider, model: next.model } }
          }
          case 'collect': {
            const output = (payload as { output?: unknown } | null)?.output
            if (typeof output !== 'string' || output.trim().length === 0) {
              return badRequest('collect: output must be a non-empty string')
            }
            const collected = await ctx.rewrite.collect(output)
            return { ok: true, value: { collected } }
          }
          case 'export': {
            const exported = await ctx.rewrite.exportCollected()
            return { ok: true, value: exported }
          }
          case 'getCollect': {
            return { ok: true, value: ctx.rewrite.isCollectionEnabled() }
          }
          case 'setCollect': {
            const enabled = (payload as { enabled?: unknown } | null)?.enabled
            if (typeof enabled !== 'boolean') {
              return badRequest('setCollect: enabled must be a boolean')
            }
            await ctx.rewrite.saveCollection(enabled)
            return { ok: true, value: enabled }
          }
          case 'getDebounce': {
            return { ok: true, value: ctx.rewrite.currentDebounceMs() }
          }
          case 'setDebounce': {
            const ms = (payload as { ms?: unknown } | null)?.ms
            if (typeof ms !== 'number' || !Number.isFinite(ms)) {
              return badRequest('setDebounce: ms must be a finite number')
            }
            await ctx.rewrite.saveDebounce(ms)
            return { ok: true, value: ctx.rewrite.currentDebounceMs() }
          }
          default:
            return badRequest(`unknown endpoint ${JSON.stringify(endpoint)}`)
        }
      } catch (error) {
        return internalError(error)
      }
    },
    { authority: 'loopback' },
  )
  ctx.effect(() => dispose)
}
