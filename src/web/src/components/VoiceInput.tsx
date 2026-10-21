import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { ASR_LANGS, canRecord, fmtClock, useTranscriber, type AsrPublic } from '../audio/useTranscriber'

export type { AsrPublic } from '../audio/useTranscriber'

export const AUDIO_ACCEPT = 'audio/*,video/webm,video/mp4,.mp3,.m4a,.wav,.webm,.ogg,.oga,.opus,.flac,.aac,.mp4'

/** The "configure speech recognition first" hint, with a direct Settings link for admins. */
export function AsrOffHint({ isAdmin, onOpenSettings }: { isAdmin?: boolean; onOpenSettings?: () => void }) {
  const { t } = useI18n()
  return (
    <span className="small grow voice-hint muted" data-testid="asr-off-hint">
      {isAdmin && onOpenSettings
        ? <>{t('asrOffAdmin')} <button type="button" className="link" data-testid="asr-open-settings" onClick={onOpenSettings}>{t('asrOpenSettings')}</button></>
        : t('asrOffUser')}
    </span>
  )
}

/** Live captions while recording: finals not yet replaced by the segmented text (grey) + the current partial. */
export function LiveCaptionsView({ captions, live }: { captions: { done: string; partial: string }; live: boolean }) {
  const { t } = useI18n()
  if (!live && !captions.done && !captions.partial) return null
  return (
    <div className="live-captions" data-testid="live-captions" aria-live="polite" title={t('rtCaptionsHint')}>
      <span className="live-badge">{t('rtLive')}</span>
      {captions.done && <span className="cap-done">{captions.done}</span>}
      {captions.partial && <span className="cap-partial">{captions.partial}</span>}
      {!captions.done && !captions.partial && <span className="muted">{t('rtWaiting')}</span>}
    </div>
  )
}

/** Light, non-blocking notice (e.g. live captions fell back to segmented recognition). */
export function VoiceNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  if (!text) return null
  return <div className="toast voice-toast" role="status" data-testid="rt-notice" onClick={onDismiss}>{text}</div>
}

export function LangSelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const { t } = useI18n()
  return (
    <span className="tip-wrap" title={disabled ? t('asrConfigureFirst') : t('asrLanguage')}>
      <select className="lang-select" value={value} disabled={disabled} title={disabled ? t('asrConfigureFirst') : t('asrLanguage')} aria-label={t('asrLanguage')} onChange={(e) => onChange(e.target.value)}>
        {ASR_LANGS.map((l) => <option key={l} value={l}>{t(`asrLang_${l}` as never)}</option>)}
      </select>
    </span>
  )
}

/**
 * Voice input bar inside the text dialog: record more or add an audio file to the text below.
 * The main entries (toolbar / empty state) use VoicePanel instead.
 */
export function VoiceInput({ asr, onAppend, onBusy, isAdmin = false, onOpenSettings }: {
  asr: AsrPublic
  onAppend: (text: string, newBlock: boolean) => void
  onBusy?: (busy: boolean) => void
  isAdmin?: boolean
  /** Opens Settings scrolled to the speech recognition section (admins only). */
  onOpenSettings?: () => void
}) {
  const { t } = useI18n()
  const v = useTranscriber(asr, onAppend)
  const { state, mic } = v
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => { onBusy?.(v.busy) }, [v.busy, onBusy])

  // Recording also works with live captions alone; uploading needs the segment model.
  const off = !canRecord(asr)
  const noUpload = !asr.configured
  const recTitle = off ? t('asrConfigureFirst') : mic === 'insecure' ? t('asrNeedHttps') : mic === 'unsupported' ? t('asrNoMicApi') : t('asrRecordHint')

  return (
    <div className="voice">
      <div className={`voice-bar${off ? ' off' : ''}`}>
        {state.kind === 'recording' ? (
          <>
            <button className="btn danger" data-testid="rec-stop" onClick={v.stopRec}>■ {t('asrStop')}</button>
            <span className="rec-dot" />
            <span className="rec-time">{fmtClock((v.now - state.since) / 1000)}</span>
            <span className="level"><span style={{ width: `${Math.round(v.level * 100)}%` }} /></span>
            <span className="muted small">{state.pending ? t('asrPending', { n: state.pending }) : t('asrListening')}</span>
            {v.live && <span className="live-badge" data-testid="rt-live">{t('rtLive')}</span>}
          </>
        ) : state.kind === 'finishing' ? (
          <><span className="spinner sm" /><span className="muted small">{t('asrFinishing', { n: state.pending })}</span></>
        ) : state.kind === 'decoding' ? (
          <><span className="spinner sm" /><span className="muted small">{t('asrDecoding', { name: state.name })}</span><button className="btn small" onClick={v.cancel}>{t('cancel')}</button></>
        ) : state.kind === 'file' ? (
          <>
            <span className="spinner sm" />
            <span className="muted small">{t('asrProgress', { i: Math.min(state.done + 1, state.total), n: state.total })}</span>
            <span className="progress"><span style={{ width: `${Math.round((state.done / state.total) * 100)}%` }} /></span>
            <button className="btn small" onClick={v.cancel}>{t('cancel')}</button>
          </>
        ) : (
          <>
            {/* Disabled controls get no mouse events in some browsers, so the tooltip sits on a wrapper. */}
            <span className="tip-wrap" title={recTitle}>
              <button className="btn" data-testid="rec-start" disabled={off || mic !== 'ok'} title={recTitle} aria-label={`${t('asrRecord')}: ${recTitle}`} onClick={v.startRec}>🎙 {t('asrRecord')}</button>
            </span>
            <span className="tip-wrap" title={noUpload ? t('asrConfigureFirst') : t('asrUploadHint')}>
              <button className="btn" data-testid="audio-upload" disabled={noUpload} title={noUpload ? t('asrConfigureFirst') : t('asrUploadHint')} onClick={() => fileRef.current?.click()}>⇪ {t('asrUpload')}</button>
            </span>
            <LangSelect value={v.lang} onChange={v.setLang} disabled={off} />
            {off
              ? <AsrOffHint isAdmin={isAdmin} onOpenSettings={onOpenSettings} />
              : <span className="muted small grow voice-hint">{mic === 'insecure' ? t('asrNeedHttps') : t('asrHint')}</span>}
          </>
        )}
        <input ref={fileRef} type="file" hidden accept={AUDIO_ACCEPT} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void v.transcribeFile(f) }} />
      </div>
      {(state.kind === 'recording' || state.kind === 'finishing') && <LiveCaptionsView captions={v.captions} live={v.live} />}
      {v.error && <div className="error small" data-testid="asr-error">{v.error}</div>}
      {!v.error && v.info && <div className="hint">{v.info}</div>}
      <VoiceNotice text={v.notice} onDismiss={v.dismissNotice} />
    </div>
  )
}
