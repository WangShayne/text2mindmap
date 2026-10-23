import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { fmtClock } from '../audio/useTranscriber'
import type { LiveSlice } from '../transcript/useLiveMap'

export type PanelTone = 'info' | 'ok' | 'err'

/**
 * Transcript slices beside the map (docs/v0.5-ui-states.md §1–§3). Clicking a committed slice
 * focuses its map node; `active` slices are the ones linked to the node selected on the map.
 */
export function TranscriptPanel({ slices, active, focusKey, status, tone = 'info', progress, hint, busy, onSliceClick, onRetry, onUpdateNow, onClose }: {
  slices: LiveSlice[]
  active: string[]
  /** Changes on every new focus so the same slices flash again. */
  focusKey: number
  status: string
  tone?: PanelTone
  /** Optional determinate progress, 0–1. */
  progress?: number
  hint: string
  busy: boolean
  onSliceClick: (s: LiveSlice) => void
  onRetry: (id: string) => void
  onUpdateNow?: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const list = useRef<HTMLDivElement>(null)
  const activeSet = new Set(active)

  // Scroll the first linked slice to the middle when the map selection changes.
  useEffect(() => {
    if (!active.length) return
    list.current?.querySelector<HTMLElement>(`[data-slice="${active[0]}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Follow new slices while the user is at the bottom.
  const atBottom = useRef(true)
  useEffect(() => { const el = list.current; if (el && atBottom.current) el.scrollTop = el.scrollHeight }, [slices.length])

  return (
    <section className="pane transcript-pane" data-testid="transcript-panel" aria-label={t('transcript')}>
      <div className="pane-head row">
        <span>{t('transcript')}</span>
        <span className="muted small">{slices.length}</span>
        <div className="spacer" />
        {onUpdateNow && <button className="icon-btn" title={t('trUpdateNow')} aria-label={t('trUpdateNow')} data-testid="tr-update-now" onClick={onUpdateNow}>⟳</button>}
        <button className="icon-btn" title={t('trClose')} aria-label={t('trClose')} onClick={onClose}>✕</button>
      </div>
      <div className={`tr-status ${tone}`} data-testid="tr-status">
        {busy && <span className="spinner sm" />}
        <span className="grow">{status}</span>
      </div>
      {progress !== undefined && <span className="progress tr-progress"><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>}
      {hint && <div className="tr-hint small" data-testid="tr-hint">{hint}</div>}
      <div className="tr-list" ref={list} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
        {!slices.length && <div className="muted small tr-empty">{t('trNoSlices')}</div>}
        {slices.map((s) => {
          const state = s.client ?? (s.status === 'failed' ? 'failed' : 'done')
          const isActive = state === 'done' && activeSet.has(s.id)
          const clickable = state === 'done'
          return (
            // A new key restarts the focus animation when the same slice is focused again.
            <div key={isActive ? `${s.id}-${focusKey}` : s.id} data-slice={s.id} data-state={isActive ? 'active' : state}
              className={`tr-slice ${state}${isActive ? ' active' : ''}`}
              role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => onSliceClick(s) : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onSliceClick(s) } : undefined}>
              <div className="tr-meta">
                <span className="tr-time">{fmtClock(s.start)}</span>
                <span className="tr-id">#{s.id}</span>
                <span className="spacer" />
                {state === 'pending' && <span className="tr-tag">⏳ {t('trPending')}</span>}
                {state === 'transcribing' && <span className="tr-tag">⚡ {t('trTranscribing')}</span>}
                {state === 'retrying' && <span className="tr-tag"><span className="spinner sm" /> {t('trRetrying')}</span>}
                {state === 'failed' && <button className="btn small danger-soft" data-testid={`tr-retry-${s.id}`} onClick={(e) => { e.stopPropagation(); onRetry(s.id) }}>⚠️ {t('trRetry')}</button>}
                {isActive && <span className="tr-tag">🎯</span>}
              </div>
              <div className="tr-text">{state === 'failed' ? t('trFailed') : s.text || (state === 'done' ? '…' : '')}</div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
