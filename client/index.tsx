/**
 * 输入重写插件（浏览器面，compiled bundle）。
 *
 * 经 `window.__ModuleLoader__.load` 注入，作为普通 Cordis 插件运行。注册两个 slot：
 * - `conversation.input.dock`：改写预览条 —— 监听草稿，停止输入约 2s 后自动调
 *   `/input-rewriter` 的 `rewrite` 端点，展示改写结果，可「发送改写」（右侧）或点
 *   「×」取消；输入框 Enter 始终发原文。
 * - `settings.section`：改写模型选择 —— 经 `models`/`getModel`/`setModel` 端点
 *   选择用于改写的 provider/model（持久化到宿主 settings）。
 *
 * 所有 RPC 走 `connection.rpc.call`；transport 错误与业务失败分别处理并展示。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// 激活 SlotMap 增强：'conversation.input.dock' / 'settings.section' 键与
// 会话标准道具（useInput/inputActions）、设置段 owner 道具（close）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

/** 插件运行时名（与包名一致）。 */
export const name = 'dsh-input-rewriter'

/** 必需服务：slots 注册 UI，connection 提供宿主↔浏览器 RPC。 */
export const inject = ['slots', 'connection']

/** 宿主↔浏览器逻辑 RPC 通道（与宿主面 src/rpc.ts 一致）。 */
const RPC_CHANNEL = '/input-rewriter'

/** 自动改写的防抖窗口（草稿停止变化多久后触发）。 */
const DEBOUNCE_MS = 2000

/** 改写结果线类型（与宿主面 RewriteResult 对齐）。 */
type RewriteOutcome =
  | { ok: true; rewritten: string }
  | { ok: false; message: string }

interface ModelInfo {
  provider: string
  id: string
  name: string
}

interface ModelSelection {
  provider: string
  model: string
}

/** 从 context 解析浏览器面 connection 服务（无 Context 属性增强，走显式 cast）。 */
function connection(ctx: Context): ConnectionHandle {
  return ctx.get('connection') as unknown as ConnectionHandle
}

/** 把 RPC 的 unknown value 收敛为可展示的改写结果。 */
function parseRewriteOutcome(value: unknown): RewriteOutcome {
  if (typeof value === 'object' && value !== null) {
    const v = value as { ok?: unknown; rewritten?: unknown; message?: unknown }
    if (v.ok === true && typeof v.rewritten === 'string') {
      return { ok: true, rewritten: v.rewritten }
    }
    if (typeof v.message === 'string') return { ok: false, message: v.message }
  }
  return { ok: false, message: '改写结果解析失败' }
}

function isModelInfo(value: unknown): value is ModelInfo {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { provider?: unknown; id?: unknown; name?: unknown }
  return typeof v.provider === 'string' && typeof v.id === 'string' && typeof v.name === 'string'
}

function isModelSelection(value: unknown): value is ModelSelection {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { provider?: unknown; model?: unknown }
  return typeof v.provider === 'string' && typeof v.model === 'string'
}

/** 模型选项值用 JSON 编码，规避 HTML option 值里空字符等分隔符歧义。 */
function encodeModel(provider: string, model: string): string {
  return JSON.stringify({ provider, model })
}

function decodeModel(value: string): ModelSelection | null {
  try {
    const v = JSON.parse(value) as { provider?: unknown; model?: unknown }
    if (typeof v.provider === 'string' && typeof v.model === 'string') {
      return { provider: v.provider, model: v.model }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 改写预览条（conversation.input.dock）
// ---------------------------------------------------------------------------

type DockProps = PropsRuntime<'conversation.input.dock'>

/** 创建关闭了 ctx 的改写预览条组件。 */
function createDock(ctx: Context) {
  return function InputRewriterDock({ input, inputActions }: DockProps) {
    const [busy, setBusy] = useState(false)
    const [preview, setPreview] = useState<{ original: string; rewritten: string } | null>(null)
    const [error, setError] = useState<string | null>(null)

    // 防抖计时器、在途请求控制器、用户「×」取消的草稿快照。
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const controllerRef = useRef<AbortController | null>(null)
    const dismissedRef = useRef<string | null>(null)

    const draft = input.draft
    // 草稿在改写后又被编辑过：预览失效，隐藏（不再展示过期的改写结果）。
    const stale = preview !== null && preview.original !== draft
    const effective = stale ? null : preview

    const runRewrite = useCallback(async (text: string): Promise<void> => {
      // 取消上一在途请求，保证只有最新一次改写能落地。
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      setBusy(true)
      setError(null)
      try {
        const outcome = await connection(ctx).rpc.call(RPC_CHANNEL, 'rewrite', { text }, controller.signal)
        if (controller.signal.aborted) return
        if (!outcome.ok) {
          setError(outcome.error.message)
          return
        }
        const parsed = parseRewriteOutcome(outcome.value)
        if (parsed.ok) setPreview({ original: text, rewritten: parsed.rewritten })
        else setError(parsed.message)
      } catch (err) {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    }, [ctx])

    // 草稿停止变化 DEBOUNCE_MS 后自动触发改写；变化期间取消在途请求、复位 busy。
    useEffect(() => {
      const text = draft.trim()
      if (text.length === 0) {
        controllerRef.current?.abort()
        setBusy(false)
        return
      }
      // 用户已在此草稿上点「×」：不再自动改写，直到草稿再次变化。
      if (dismissedRef.current === draft) return
      // 已有针对该草稿的有效预览：不重复请求。
      if (preview !== null && preview.original === draft) return
      controllerRef.current?.abort()
      setBusy(false)
      const timer = setTimeout(() => { void runRewrite(text) }, DEBOUNCE_MS)
      return () => { clearTimeout(timer) }
    }, [draft, preview, runRewrite])

    const sendRewritten = (): void => {
      if (effective === null) return
      inputActions.setDraft(effective.rewritten)
      inputActions.submit()
    }

    const dismiss = (): void => {
      dismissedRef.current = draft
      setPreview(null)
      setError(null)
    }

    // 草稿为空：整条不渲染。
    if (draft.trim().length === 0) return null

    return (
      <div style={dockBarStyle}>
        {busy
          ? <span style={mutedStyle}>改写中…</span>
          : effective !== null
            ? (
              <div style={previewRowStyle}>
                <span style={previewTextStyle} title={effective.rewritten}>{effective.rewritten}</span>
                <div style={actionGroupStyle}>
                  <button type="button" onClick={sendRewritten} style={primaryBtnStyle}>发送改写</button>
                  <button type="button" aria-label="取消" onClick={dismiss} style={ghostBtnStyle}>×</button>
                </div>
              </div>
            )
            : error !== null
              ? <span style={errorStyle}>{error}</span>
              : null}
      </div>
    )
  }
}

// ---------------------------------------------------------------------------
// 改写模型设置段（settings.section）
// ---------------------------------------------------------------------------

type SectionProps = PropsRuntime<'settings.section'>

/** 创建关闭了 ctx 的模型选择组件。 */
function createModelSection(ctx: Context) {
  return function RewriteModelSection(_props: SectionProps) {
    const [models, setModels] = useState<ModelInfo[]>([])
    const [selection, setSelection] = useState<string>('')
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
      let cancelled = false
      void (async () => {
        try {
          const conn = connection(ctx)
          const modelsOutcome = await conn.rpc.call(RPC_CHANNEL, 'models', null)
          if (cancelled) return
          if (!modelsOutcome.ok) {
            setError(modelsOutcome.error.message)
            return
          }
          const list = Array.isArray(modelsOutcome.value)
            ? modelsOutcome.value.filter(isModelInfo).map((m) => ({ provider: m.provider, id: m.id, name: m.name }))
            : []
          setModels(list)

          const currentOutcome = await conn.rpc.call(RPC_CHANNEL, 'getModel', null)
          if (cancelled) return
          if (currentOutcome.ok && isModelSelection(currentOutcome.value)) {
            setSelection(encodeModel(currentOutcome.value.provider, currentOutcome.value.model))
          }
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        } finally {
          if (!cancelled) setBusy(false)
        }
      })()
      return () => { cancelled = true }
    }, [ctx])

    const onChange = async (next: string): Promise<void> => {
      if (next.length === 0) return
      const parsed = decodeModel(next)
      if (parsed === null) return
      setBusy(true)
      setError(null)
      try {
        const outcome = await connection(ctx).rpc.call(RPC_CHANNEL, 'setModel', { provider: parsed.provider, model: parsed.model })
        if (!outcome.ok) {
          setError(outcome.error.message)
          return
        }
        setSelection(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }

    // 当前选择可能已不在模型目录里（provider 被移除等）：仍作为占位项展示，避免看似未选择。
    const selectionModel = decodeModel(selection)
    const selectionInList = selectionModel !== null
      && models.some((m) => m.provider === selectionModel.provider && m.id === selectionModel.model)

    return (
      <div style={sectionStyle}>
        <label htmlFor="input-rewriter-model" style={sectionLabelStyle}>改写模型</label>
        {busy && models.length === 0
          ? <span style={mutedStyle}>加载模型列表…</span>
          : models.length === 0
            ? <span style={mutedStyle}>未检测到可用模型，请先在「设置 → Models」添加 provider 后再选择。</span>
            : (
              <select
                id="input-rewriter-model"
                value={selection}
                disabled={busy}
                onChange={(event) => { void onChange(event.currentTarget.value) }}
                style={selectStyle}
              >
                <option value="">未选择（改写前请先选择模型）</option>
                {selectionModel !== null && !selectionInList && (
                  <option value={selection}>{selectionModel.provider} / {selectionModel.model}</option>
                )}
                {models.map((m) => (
                  <option key={`${m.provider}::${m.id}`} value={encodeModel(m.provider, m.id)}>
                    {m.name}（{m.provider}）
                  </option>
                ))}
              </select>
            )}
        {error !== null && <div style={errorStyle}>{error}</div>}
        <p style={mutedStyle}>选中的模型仅用于「输入改写」，不会改变对话主模型。</p>
      </div>
    )
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/** 注册改写预览条与模型设置段；slot 声明由其它插件持有，经 inject 延迟到声明就绪。 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'input-rewriter',
    order: 10,
  }, createDock(ctx)))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'input-rewriter',
    order: 100,
    label: '输入改写',
  }, createModelSection(ctx)))
}

// ---------------------------------------------------------------------------
// 内联样式（对齐 dsh 输入卡片的胶囊形态与设计 token，避免额外依赖）
// ---------------------------------------------------------------------------

/** 改写预览条：与输入卡片同款胶囊（radius 22px）+ 设计 token，负外边距让下半部与输入框顶部重叠。 */
const dockBarStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: 'var(--dsh-composer-card-max-width)',
  margin: '0 auto -14px',
  border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)',
  background: 'var(--dsw-specific-input-major)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  borderRadius: 22,
  padding: '10px 14px',
  fontSize: 14,
  lineHeight: '20px',
  position: 'relative',
  zIndex: 8,
}

const previewRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minWidth: 0,
}

const previewTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--dsw-alias-label-primary)',
}

const actionGroupStyle: CSSProperties = { display: 'flex', gap: 4, flexShrink: 0 }

const primaryBtnStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: 999,
  border: 'none',
  background: 'var(--dsw-alias-state-business-primary)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
}

const ghostBtnStyle: CSSProperties = {
  padding: '4px 8px',
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: '18px',
}

const mutedStyle: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warn-secondary))', fontSize: 12 }

const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }

const sectionLabelStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }

const selectStyle: CSSProperties = {
  maxWidth: 360,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-specific-input-major)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
}
