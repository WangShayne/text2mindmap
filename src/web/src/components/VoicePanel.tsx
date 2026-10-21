import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { appendPiece, fmtClock, useTranscriber, type AsrPublic } from '../audio/useTranscriber'
import { AsrOffHint, LangSelect, LiveCaptionsView, VoiceNotice } from './VoiceInput'
import { Placement, type GenRequest } from './GenerateDialog'
import type { Selection } from '../mindmap/adapter'

export type VoiceSource = { kind: 'mic' } | { kind: 'file'; file: File }

/**
 * Lightweight floating panel for the Record and Upload-audio entries: recording starts as soon as
 * it opens (one click from the toolbar), shows a timer and the live text, and after Stop the text is
 * editable and goes straight to generation.
 */
export function VoicePanel({ source, asr, selection, maxChars, isAdmin, onOpenSettings, onStart, onClose }: {
  source: VoiceSource
  asr: AsrPublic
  selection: Selection | null
  maxChars: number
  isAdmin?: boolean
  onOpenSettings?: (section: 'asr') => void
  onStart: (r: GenRequest) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [place, setPlace] = useState<'replace' | 'append'>('replace')
  const onAppend = useCallback((piece: string, newBlock: boolean) => setText((prev) => appendPiece(prev, piece, newBlock)), [])
  const v = useTranscriber(asr, onAppend)
  const { state, mic } = v
  const off = !asr.configured
  const isMic = source.kind === 'mic'
  const micBlocked = isMic && mic !== 'ok'

  // Start immediately: this panel only opens from an explicit click on Record / Upload.
  useEffect(() => {
    if (off) return
    if (source.kind === 'file') void v.transcribeFile(source.file)
    else if (mic === 'ok') void v.startRec()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const keepDraft = () => { if (text.trim()) sessionStorage.setItem('t2m.lastInput', text) }
  const close = () => { v.cancel(); keepDraft(); onClose() }
  const generate = () => {
    sessionStorage.setItem('t2m.lastInput', text)
    onStart({ mode: 'full', text, ...(place === 'append' && selection ? { target: selection } : {}) })
  }
  const openSettings = onOpenSettings && (() => { keepDraft(); onClose(); onOpenSettings('asr') })

  const idle = state.kind === 'idle'
  const title = isMic ? t('voicePanelRecord') : idle ? `📁 ${source.file.name}` : t('voicePanelFile', { name: source.file.name })

  return (
    <div className="voice-panel" role="dialog" aria-label={title} data-testid="voice-panel">
      <div className="vp-head">
        {state.kind === 'recording' && <span className="rec-dot" />}
        <strong className="ellipsis grow" title={title}>{isMic ? (state.kind === 'recording' ? t('voicePanelRecord') : t('asrRecord')) : title}</strong>
        {!off && <LangSelect value={v.lang} onChange={v.setLang} />}
        <button className="icon-btn" title={t('close')} aria-label={t('close')} data-testid="vp-close" onClick={close}>✕</button>
      </div>

      {off ? (
        <div className="vp-off"><AsrOffHint isAdmin={isAdmin} onOpenSettings={openSettings} /></div>
      ) : micBlocked && idle && !text ? (
        <div className="vp-off muted small" data-testid="vp-mic-blocked">{mic === 'insecure' ? t('asrNeedHttps') : t('asrNoMicApi')}</div>
      ) : (
        <>
          <div className="vp-status">
            {state.kind === 'recording' ? (
              <>
                <span className="rec-time" data-testid="vp-timer">{fmtClock((v.now - state.since) / 1000)}</span>
                <span className="level"><span style={{ width: `${Math.round(v.level * 100)}%` }} /></span>
                <span className="muted small grow">{state.pending ? t('asrPending', { n: state.pending }) : t('asrListening')}</span>
                <button className="btn danger" data-testid="rec-stop" onClick={v.stopRec}>■ {t('asrStop')}</button>
              </>
            ) : state.kind === 'finishing' ? (
              <><span className="spinner sm" /><span className="muted small">{t('asrFinishing', { n: state.pending })}</span></>
            ) : state.kind === 'decoding' ? (
              <><span className="spinner sm" /><span className="muted small grow">{t('asrDecoding', { name: state.name })}</span><button className="btn small" onClick={v.cancel}>{t('cancel')}</button></>
            ) : state.kind === 'file' ? (
              <>
                <span className="spinner sm" />
                <span className="muted small">{t('asrProgress', { i: Math.min(state.done + 1, state.total), n: state.total })}</span>
                <span className="progress grow"><span style={{ width: `${Math.round((state.done / state.total) * 100)}%` }} /></span>
                <button className="btn small" onClick={v.cancel}>{t('cancel')}</button>
              </>
            ) : (
              <span className="muted small grow">{v.error ? '' : text.trim() ? t('voiceDone') : v.info}</span>
            )}
          </div>
          <textarea className="vp-text" data-testid="vp-text" value={text} readOnly={!idle} rows={7}
            placeholder={isMic ? t('voiceLivePlaceholder') : t('voiceFilePlaceholder')}
            ref={(el) => { if (el && !idle) el.scrollTop = el.scrollHeight }}
            onChange={(e) => setText(e.target.value)} />
          {(state.kind === 'recording' || state.kind === 'finishing') && <LiveCaptionsView captions={v.captions} live={v.live} />}
          {v.error && <div className="error small" data-testid="asr-error">{v.error}</div>}
          <VoiceNotice text={v.notice} onDismiss={v.dismissNotice} />
          {idle && (
            <div className="vp-foot">
              <Placement selection={selection} value={place} onChange={setPlace} />
              <div className="row gap">
                {isMic && mic === 'ok' && <button className="btn" data-testid="rec-more" onClick={v.startRec}>🎙 {text.trim() ? t('recordMore') : t('asrRecord')}</button>}
                <span className="spacer" />
                <button className="btn primary" data-testid="vp-generate" disabled={!text.trim() || text.length > maxChars} onClick={generate}>✨ {t('generateMap')}</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
